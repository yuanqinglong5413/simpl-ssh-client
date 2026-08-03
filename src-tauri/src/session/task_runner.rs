//! 本地工作区任务运行器。
//!
//! 任务只由前端显式触发；运行记录和子进程只保存在内存中，应用重启后不会恢复。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::io::BufReader;
use tokio::process::Command;
use tokio::sync::oneshot;

const MAX_OUTPUT_BYTES: usize = 200 * 1024;

#[derive(Clone, Serialize)]
pub struct ProjectTaskSnapshot {
    pub id: String,
    pub task_id: String,
    pub label: String,
    pub command: String,
    pub cwd: String,
    pub status: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub exit_code: Option<i32>,
    pub output: String,
    pub output_truncated: bool,
}

struct TaskRecord {
    snapshot: Mutex<ProjectTaskSnapshot>,
    cancel: Mutex<Option<oneshot::Sender<()>>>,
    cancel_requested: AtomicBool,
}

#[derive(Default)]
pub struct TaskRunner {
    tasks: Arc<Mutex<HashMap<String, Arc<TaskRecord>>>>,
}

impl TaskRunner {
    pub fn list(&self, root: &str) -> Vec<ProjectTaskSnapshot> {
        self.tasks
            .lock()
            .unwrap()
            .values()
            .filter_map(|task| {
                let snapshot = task.snapshot.lock().unwrap().clone();
                (snapshot.cwd == root).then_some(snapshot)
            })
            .collect()
    }

    pub fn start(
        &self,
        app: AppHandle,
        root: PathBuf,
        task_id: String,
        label: String,
        command: String,
    ) -> Result<ProjectTaskSnapshot, String> {
        if command.trim().is_empty() {
            return Err("任务命令不能为空".to_string());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let cwd = root.to_string_lossy().into_owned();
        let snapshot = ProjectTaskSnapshot {
            id: id.clone(),
            task_id,
            label,
            command: command.trim().to_string(),
            cwd: cwd.clone(),
            status: "queued".to_string(),
            started_at: chrono::Local::now().to_rfc3339(),
            ended_at: None,
            exit_code: None,
            output: String::new(),
            output_truncated: false,
        };
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let record = Arc::new(TaskRecord {
            snapshot: Mutex::new(snapshot.clone()),
            cancel: Mutex::new(Some(cancel_tx)),
            cancel_requested: AtomicBool::new(false),
        });
        self.tasks
            .lock()
            .unwrap()
            .insert(id.clone(), record.clone());
        emit_state(&app, &record);
        tauri::async_runtime::spawn(run_task(app, record, root, cancel_rx, self.tasks.clone()));
        Ok(snapshot)
    }

    pub fn cancel(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let task = self
            .tasks
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "任务不存在".to_string())?;
        let sender = task.cancel.lock().unwrap().take();
        task.cancel_requested.store(true, Ordering::Release);
        if let Some(sender) = sender {
            let _ = sender.send(());
        } else {
            return Err("任务已经结束".to_string());
        }
        {
            let mut snapshot = task.snapshot.lock().unwrap();
            if snapshot.status == "queued" || snapshot.status == "running" {
                snapshot.status = "cancelling".to_string();
            }
        }
        emit_state(app, &task);
        Ok(())
    }
}

async fn run_task(
    app: AppHandle,
    record: Arc<TaskRecord>,
    cwd: PathBuf,
    mut cancel_rx: oneshot::Receiver<()>,
    tasks: Arc<Mutex<HashMap<String, Arc<TaskRecord>>>>,
) {
    let command_text = record.snapshot.lock().unwrap().command.clone();
    let mut command = if cfg!(windows) {
        let mut value = Command::new("cmd");
        value.args(["/C", &format!("{command_text} 2>&1")]);
        value
    } else {
        let mut value = Command::new("sh");
        // Replace the shell with the requested command. This makes cancellation
        // terminate the actual task instead of leaving a shell-owned child
        // process running in the background.
        // Merge stderr into stdout on Unix so the task panel receives one
        // deterministic stream instead of two independently scheduled readers.
        value.args(["-lc", &format!("exec {command_text} 2>&1")]);
        value
    };
    command
        .current_dir(&cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            finish(
                &app,
                &record,
                "failed",
                None,
                Some(format!("无法启动任务：{error}")),
            );
            let id = record.snapshot.lock().unwrap().id.clone();
            tasks.lock().unwrap().remove(&id);
            return;
        }
    };
    {
        let mut snapshot = record.snapshot.lock().unwrap();
        snapshot.status = "running".to_string();
    }
    emit_state(&app, &record);
    let stdout_task = child.stdout.take().map(|stdout| {
        tauri::async_runtime::spawn(read_output(app.clone(), record.clone(), stdout))
    });
    let stderr_task = child.stderr.take().map(|stderr| {
        tauri::async_runtime::spawn(read_output(app.clone(), record.clone(), stderr))
    });
    let result = tokio::select! {
        status = child.wait() => match status { Ok(status) => (status.success(), status.code(), false), Err(_) => (false, None, false) },
        _ = &mut cancel_rx => {
            #[cfg(unix)]
            if let Some(pid) = child.id() {
                // The child is a dedicated process-group leader, so canceling
                // the group also stops compilers/test runners spawned by it.
                unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL); }
            }
            #[cfg(windows)]
            if let Some(pid) = child.id() {
                // `cmd /C` can leave grandchildren alive; terminate the whole
                // Windows process tree before awaiting the wrapper process.
                let _ = Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &pid.to_string()])
                    .output()
                    .await;
            }
            let _ = child.kill().await;
            let status = child.wait().await.ok();
            (false, status.and_then(|value| value.code()), true)
        },
    };
    let status = if result.2 || record.cancel_requested.load(Ordering::Acquire) {
        "cancelled"
    } else if result.0 {
        "succeeded"
    } else {
        "failed"
    };
    if let Some(task) = stdout_task {
        let _ = task.await;
    }
    if let Some(task) = stderr_task {
        let _ = task.await;
    }
    finish(&app, &record, status, result.1, None);
    let id = record.snapshot.lock().unwrap().id.clone();
    tasks.lock().unwrap().remove(&id);
}

async fn read_output<R: tokio::io::AsyncRead + Unpin>(
    app: AppHandle,
    record: Arc<TaskRecord>,
    reader: R,
) {
    let mut reader = BufReader::new(reader);
    let mut bytes = [0_u8; 8192];
    let mut pending = Vec::new();
    loop {
        let read = match reader.read(&mut bytes).await {
            Ok(0) => break,
            Ok(size) => size,
            Err(_) => break,
        };
        pending.extend_from_slice(&bytes[..read]);
        while !pending.is_empty() {
            match std::str::from_utf8(&pending) {
                Ok(text) => {
                    append_output(&record, text);
                    pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        let text = unsafe { std::str::from_utf8_unchecked(&pending[..valid]) };
                        append_output(&record, text);
                        pending.drain(..valid);
                        continue;
                    }
                    if error.error_len().is_some() {
                        append_output(&record, "�");
                        pending.drain(..1);
                    }
                    break;
                }
            }
        }
        emit_state(&app, &record);
    }
    if !pending.is_empty() {
        append_output(&record, &String::from_utf8_lossy(&pending));
        emit_state(&app, &record);
    }
}

fn append_output(record: &Arc<TaskRecord>, chunk: &str) {
    if chunk.is_empty() {
        return;
    }
    {
        let mut snapshot = record.snapshot.lock().unwrap();
        snapshot.output.push_str(chunk);
        if snapshot.output.len() > MAX_OUTPUT_BYTES {
            let trim = snapshot.output.len() - MAX_OUTPUT_BYTES;
            let mut boundary = trim;
            while boundary < snapshot.output.len() && !snapshot.output.is_char_boundary(boundary) {
                boundary += 1;
            }
            snapshot.output.drain(..boundary);
            snapshot.output_truncated = true;
        }
    }
}

fn finish(
    app: &AppHandle,
    record: &Arc<TaskRecord>,
    status: &str,
    exit_code: Option<i32>,
    error: Option<String>,
) {
    {
        let mut snapshot = record.snapshot.lock().unwrap();
        snapshot.status = status.to_string();
        snapshot.ended_at = Some(chrono::Local::now().to_rfc3339());
        snapshot.exit_code = exit_code;
        if let Some(error) = error {
            drop(snapshot);
            append_output(record, &format!("{error}\n"));
        }
    }
    record.cancel.lock().unwrap().take();
    emit_state(app, record);
}

fn emit_state(app: &AppHandle, record: &Arc<TaskRecord>) {
    let snapshot = record.snapshot.lock().unwrap().clone();
    let _ = app.emit("project-task://state", snapshot);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_trim_keeps_utf8_boundary_and_marks_truncation() {
        let record = Arc::new(TaskRecord {
            snapshot: Mutex::new(ProjectTaskSnapshot {
                id: "test".into(),
                task_id: "task".into(),
                label: "测试".into(),
                command: "printf".into(),
                cwd: "/tmp".into(),
                status: "running".into(),
                started_at: String::new(),
                ended_at: None,
                exit_code: None,
                output: String::new(),
                output_truncated: false,
            }),
            cancel: Mutex::new(None),
            cancel_requested: AtomicBool::new(false),
        });
        append_output(&record, &"界".repeat(MAX_OUTPUT_BYTES));
        let snapshot = record.snapshot.lock().unwrap();
        assert!(snapshot.output.len() <= MAX_OUTPUT_BYTES);
        assert!(snapshot.output.is_char_boundary(0));
        assert!(snapshot.output_truncated);
        assert!(snapshot.output.chars().all(|character| character == '界'));
    }
}
