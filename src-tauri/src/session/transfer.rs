//! SFTP 传输队列：串行 worker + 可取消。
//!
//! 目的：把"选文件"和"执行传输"解耦——选完立即入队返回，UI 不阻塞；
//! 多个任务排队串行执行（避免单 SSH 连接上 SFTP 并发争用）；
//! 进行中的任务可取消（`AtomicBool`，传输循环每片前检查）。
//!
//! 进度通过 `transfer://progress`（带 task_id）推送；状态变更通过 `transfer://state`
//! 推送快照。队列只存内存，进程退出即消失。

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

use crate::session::{SessionManager, SftpManager};

#[derive(Clone, Copy)]
pub enum TransferKind {
    Upload,
    UploadDir,
    Download,
}

impl TransferKind {
    pub fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "upload" => Ok(Self::Upload),
            "uploadDir" => Ok(Self::UploadDir),
            "download" => Ok(Self::Download),
            _ => Err(format!("unknown transfer kind: {s}")),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::UploadDir => "uploadDir",
            Self::Download => "download",
        }
    }
}

#[derive(Clone)]
pub enum TransferStatus {
    Queued,
    Running,
    Done,
    Failed(String),
    Cancelled,
}

impl TransferStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed(_) => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// 一个传输任务。多字段用原子/标准锁，供 worker 写、`list()` 读。
pub struct TransferTask {
    pub id: String,
    pub session_id: String,
    pub kind: TransferKind,
    pub local_path: PathBuf,
    pub remote_path: String,
    pub name: String,
    total: AtomicU64,
    transferred: AtomicU64,
    status: StdMutex<TransferStatus>,
    cancel: Arc<AtomicBool>,
}

#[derive(Serialize, Clone)]
pub struct TransferTaskSnap {
    pub id: String,
    pub session_id: String,
    pub kind: String,
    pub name: String,
    pub total: u64,
    pub transferred: u64,
    pub status: String,
    pub error: Option<String>,
}

impl TransferTask {
    fn snapshot(&self) -> TransferTaskSnap {
        let status = self.status.lock().unwrap();
        let (st, err) = match &*status {
            TransferStatus::Failed(msg) => ("failed".to_string(), Some(msg.clone())),
            other => (other.as_str().to_string(), None),
        };
        TransferTaskSnap {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            kind: self.kind.as_str().to_string(),
            name: self.name.clone(),
            total: self.total.load(Ordering::Relaxed),
            transferred: self.transferred.load(Ordering::Relaxed),
            status: st,
            error: err,
        }
    }

    fn set_status(&self, s: TransferStatus) {
        *self.status.lock().unwrap() = s;
    }
}

/// 传输队列（Tauri State）。内部字段都是 Arc，worker 持其 clone 运行。
#[derive(Default)]
pub struct TransferQueue {
    tasks: Arc<Mutex<VecDeque<Arc<TransferTask>>>>,
    notify: Arc<Notify>,
}

impl TransferQueue {
    /// 入队一个任务，返回其 id。
    pub async fn enqueue(
        &self,
        session_id: String,
        kind: TransferKind,
        local_path: PathBuf,
        remote_path: String,
        name: String,
    ) -> String {
        let task = Arc::new(TransferTask {
            id: Uuid::new_v4().to_string(),
            session_id,
            kind,
            local_path,
            remote_path,
            name,
            total: AtomicU64::new(0),
            transferred: AtomicU64::new(0),
            status: StdMutex::new(TransferStatus::Queued),
            cancel: Arc::new(AtomicBool::new(false)),
        });
        let id = task.id.clone();
        self.tasks.lock().await.push_back(task);
        self.notify.notify_one();
        id
    }

    /// 取消一个任务：设标志；仍在排队的直接标 Cancelled，运行中的在下次读片前中断。
    pub async fn cancel(&self, id: &str) {
        let tasks = self.tasks.lock().await;
        if let Some(t) = tasks.iter().find(|t| t.id == id) {
            t.cancel.store(true, Ordering::Relaxed);
            let mut s = t.status.lock().unwrap();
            if matches!(*s, TransferStatus::Queued) {
                *s = TransferStatus::Cancelled;
            }
        }
    }

    /// 所有任务的快照（供前端轮询）。
    pub async fn list(&self) -> Vec<TransferTaskSnap> {
        self.tasks
            .lock()
            .await
            .iter()
            .map(|t| t.snapshot())
            .collect()
    }

    /// 启动串行 worker（lib.rs setup 调一次）。
    pub fn start_worker(&self, app: AppHandle) {
        let tasks = self.tasks.clone();
        let notify = self.notify.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                notify.notified().await;
                loop {
                    // 取第一个排队中的任务并标 Running
                    let task = {
                        let guard = tasks.lock().await;
                        guard
                            .iter()
                            .find(|t| matches!(*t.status.lock().unwrap(), TransferStatus::Queued))
                            .cloned()
                    };
                    let Some(task) = task else { break };
                    task.set_status(TransferStatus::Running);
                    let _ = app.emit("transfer://state", task.snapshot());
                    execute(&app, &task).await;
                    let _ = app.emit("transfer://state", task.snapshot());
                }
            }
        });
    }
}

/// 执行单个任务（取 sftp、算 total、调递归、设最终状态）。
async fn execute(app: &AppHandle, task: &TransferTask) {
    let sftp = {
        let sftp_mgr = app.state::<SftpManager>();
        let sessions = app.state::<SessionManager>();
        match sftp_mgr.get(sessions.inner(), &task.session_id).await {
            Ok(s) => s,
            Err(e) => {
                task.set_status(TransferStatus::Failed(e));
                return;
            }
        }
    };

    // 总大小：单文件可精确，目录用 0（前端显示 indeterminate）
    let total: u64 = match task.kind {
        TransferKind::Upload => tokio::fs::metadata(&task.local_path)
            .await
            .ok()
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .unwrap_or(0),
        TransferKind::UploadDir => 0,
        TransferKind::Download => sftp
            .metadata(&task.remote_path)
            .await
            .ok()
            .filter(|m| !m.is_dir())
            .map(|m| m.len())
            .unwrap_or(0),
    };
    task.total.store(total, Ordering::Relaxed);

    let res = match task.kind {
        TransferKind::Upload | TransferKind::UploadDir => {
            upload_recursive(
                &sftp,
                &task.local_path,
                &task.remote_path,
                app,
                &task.id,
                &task.cancel,
                &task.transferred,
                total,
            )
            .await
        }
        TransferKind::Download => {
            download_recursive(
                &sftp,
                &task.remote_path,
                &task.local_path,
                app,
                &task.id,
                &task.cancel,
                &task.transferred,
                total,
            )
            .await
        }
    };

    match res {
        Ok(()) => task.set_status(TransferStatus::Done),
        Err(e) if e == "cancelled" => {
            task.set_status(TransferStatus::Cancelled);
            // 单文件半成品 best-effort 清理
            match task.kind {
                TransferKind::Upload => {
                    let _ = sftp.remove_file(&task.remote_path).await;
                }
                TransferKind::Download => {
                    let _ = tokio::fs::remove_file(&task.local_path).await;
                }
                _ => {}
            }
        }
        Err(e) => task.set_status(TransferStatus::Failed(e)),
    }
}

#[derive(Serialize, Clone)]
pub struct TransferProgress {
    pub task_id: String,
    pub name: String,
    pub transferred: u64,
    pub total: u64,
}

// ============================  递归传输（可取消）============================

#[allow(clippy::too_many_arguments)]
async fn upload_recursive(
    sftp: &SftpSession,
    local: &Path,
    remote: &str,
    app: &AppHandle,
    task_id: &str,
    cancel: &AtomicBool,
    transferred: &AtomicU64,
    total: u64,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    if local.is_dir() {
        let _ = sftp.create_dir(remote).await;
        let mut rd = tokio::fs::read_dir(local)
            .await
            .map_err(|e| e.to_string())?;
        while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let rpath = join_remote(remote, &name);
            Box::pin(upload_recursive(
                sftp,
                &entry.path(),
                &rpath,
                app,
                task_id,
                cancel,
                transferred,
                total,
            ))
            .await?;
        }
        return Ok(());
    }

    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let mut local_f = tokio::fs::File::open(local)
        .await
        .map_err(|e| e.to_string())?;
    let mut remote_f = sftp
        .open_with_flags(
            remote,
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| e.to_string())?;
    stream_with_progress(
        app,
        task_id,
        cancel,
        transferred,
        total,
        &name,
        &mut local_f,
        &mut remote_f,
    )
    .await?;
    remote_f.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn download_recursive(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    app: &AppHandle,
    task_id: &str,
    cancel: &AtomicBool,
    transferred: &AtomicU64,
    total: u64,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    let meta = sftp.metadata(remote).await.map_err(|e| e.to_string())?;
    if meta.is_dir() {
        tokio::fs::create_dir_all(local)
            .await
            .map_err(|e| e.to_string())?;
        let read = sftp.read_dir(remote).await.map_err(|e| e.to_string())?;
        for entry in read {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            if entry.metadata().is_symlink() {
                continue;
            }
            let rpath = join_remote(remote, &name);
            let lpath = local.join(&name);
            Box::pin(download_recursive(
                sftp,
                &rpath,
                &lpath,
                app,
                task_id,
                cancel,
                transferred,
                total,
            ))
            .await?;
        }
        return Ok(());
    }

    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let mut remote_f = sftp.open(remote).await.map_err(|e| e.to_string())?;
    let mut local_f = tokio::fs::File::create(local)
        .await
        .map_err(|e| e.to_string())?;
    stream_with_progress(
        app,
        task_id,
        cancel,
        transferred,
        total,
        &name,
        &mut remote_f,
        &mut local_f,
    )
    .await?;
    local_f.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// 拼接远程路径，避免重复斜杠。
fn join_remote(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        format!("/{name}")
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// 通用流式拷贝 + 进度事件（每 64KB 一片），循环前检查取消标志。
#[allow(clippy::too_many_arguments)]
async fn stream_with_progress(
    app: &AppHandle,
    task_id: &str,
    cancel: &AtomicBool,
    transferred: &AtomicU64,
    total: u64,
    name: &str,
    src: &mut (impl AsyncRead + Unpin),
    dst: &mut (impl AsyncWrite + Unpin),
) -> Result<(), String> {
    let mut buf = vec![0u8; 65536];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        transferred.fetch_add(n as u64, Ordering::Relaxed);
        let done = transferred.load(Ordering::Relaxed);
        let _ = app.emit(
            "transfer://progress",
            TransferProgress {
                task_id: task_id.to_string(),
                name: name.to_string(),
                transferred: done,
                total,
            },
        );
    }
    Ok(())
}
