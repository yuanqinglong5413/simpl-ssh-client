//! 本地 LSP 进程与 JSON-RPC 桥接。
//!
//! 语言服务只接受可执行文件和参数，不经过 shell；项目关闭或服务禁用时由
//! `lsp_stop` 回收进程。前端负责文档同步和能力请求，后端只处理可靠的帧传输。

use std::{collections::HashMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
    time::timeout,
};

const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspState {
    pub server_id: String,
    pub root: String,
    pub status: String,
    pub error: Option<String>,
}

// 传输 seam：本地实现直接持有子进程的 stdin。未来「LSP over SSH」只需把写入侧
// （notify/request 的 stdin.write_all）替换为 SSH channel 流，读取侧 read_stdout/
// read_stderr 已泛型于 AsyncRead，帧解析（frame_message/take_frame）与按 id 匹配请求、
// publishDiagnostics → lsp://diagnostics 转发的逻辑均与传输无关，可整段复用。
struct ServerHandle {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    kill_tx: Option<oneshot::Sender<()>>,
    next_id: u64,
    root: String,
    state: Arc<Mutex<LspState>>,
}

#[derive(Default)]
pub struct LspManager {
    servers: Mutex<HashMap<String, ServerHandle>>,
}

#[derive(Debug, Deserialize)]
pub struct LspRequest {
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

impl LspManager {
    pub async fn start(
        &self,
        app: AppHandle,
        server_id: String,
        root: String,
        command: String,
        args: Vec<String>,
    ) -> Result<LspState, String> {
        if command.trim().is_empty() {
            let message = "语言服务命令不能为空".to_string();
            emit_state(
                &app,
                &LspState {
                    server_id,
                    root,
                    status: "crashed".into(),
                    error: Some(message.clone()),
                },
            );
            return Err(message);
        }
        self.stop(&server_id).await;
        emit_state(
            &app,
            &LspState {
                server_id: server_id.clone(),
                root: root.clone(),
                status: "starting".into(),
                error: None,
            },
        );

        let mut process = Command::new(&command);
        process
            .args(&args)
            .current_dir(&root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        sanitize_environment(&mut process);
        #[cfg(unix)]
        process.process_group(0);
        let mut child = match process.spawn() {
            Ok(child) => child,
            Err(error) => {
                let message = format!("无法启动语言服务：{error}");
                emit_state(
                    &app,
                    &LspState {
                        server_id,
                        root,
                        status: "crashed".into(),
                        error: Some(message.clone()),
                    },
                );
                return Err(message);
            }
        };
        let stdin = match child.stdin.take() {
            Some(stdin) => Arc::new(Mutex::new(stdin)),
            None => {
                let message = "无法启动语言服务：stdin 不可用".to_string();
                let _ = child.kill().await;
                emit_state(
                    &app,
                    &LspState {
                        server_id,
                        root,
                        status: "crashed".into(),
                        error: Some(message.clone()),
                    },
                );
                return Err(message);
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let message = "无法启动语言服务：stdout 不可用".to_string();
                let _ = child.kill().await;
                emit_state(
                    &app,
                    &LspState {
                        server_id,
                        root,
                        status: "crashed".into(),
                        error: Some(message.clone()),
                    },
                );
                return Err(message);
            }
        };
        let stderr = child.stderr.take();
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (kill_tx, kill_rx) = oneshot::channel();
        let key = server_id.clone();
        let app_for_reader = app.clone();
        let pending_for_reader = pending.clone();
        tokio::spawn(read_stdout(
            stdout,
            key.clone(),
            pending_for_reader,
            app_for_reader,
        ));
        if let Some(stderr) = stderr {
            let app_for_log = app.clone();
            let key_for_log = key.clone();
            tokio::spawn(read_stderr(stderr, key_for_log, app_for_log));
        }
        let state = Arc::new(Mutex::new(LspState {
            server_id: server_id.clone(),
            root: root.clone(),
            status: "ready".into(),
            error: None,
        }));
        let state_for_wait = state.clone();
        let app_for_wait = app.clone();
        let root_for_wait = root.clone();
        let key_for_wait = key.clone();
        tokio::spawn(async move {
            wait_child(
                child,
                kill_rx,
                app_for_wait,
                key_for_wait,
                root_for_wait,
                state_for_wait,
            )
            .await;
        });

        let snapshot = LspState {
            server_id: server_id.clone(),
            root: root.clone(),
            status: "ready".into(),
            error: None,
        };
        self.servers.lock().await.insert(
            server_id,
            ServerHandle {
                stdin,
                pending,
                kill_tx: Some(kill_tx),
                next_id: 1,
                root,
                state,
            },
        );
        emit_state(&app, &snapshot);
        Ok(snapshot)
    }

    pub async fn stop(&self, server_id: &str) {
        if let Some(mut handle) = self.servers.lock().await.remove(server_id) {
            if let Some(kill) = handle.kill_tx.take() {
                let _ = kill.send(());
            }
            handle.pending.lock().await.clear();
        }
    }

    /// 真实退出时停止全部语言服务。先取出键列表，避免持有映射锁等待子进程。
    pub async fn stop_all(&self) {
        let ids = self
            .servers
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            self.stop(&id).await;
        }
    }

    pub async fn stop_matching(&self, marker: &str) {
        let ids = self
            .servers
            .lock()
            .await
            .keys()
            .filter(|id| id.contains(marker))
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            self.stop(&id).await;
        }
    }

    pub async fn status(&self, server_id: &str) -> Option<LspState> {
        self.servers.lock().await.get(server_id).map(|server| {
            server
                .state
                .try_lock()
                .map(|state| state.clone())
                .unwrap_or_else(|_| LspState {
                    server_id: server_id.to_string(),
                    root: server.root.clone(),
                    status: "starting".into(),
                    error: None,
                })
        })
    }

    pub async fn notify(
        &self,
        server_id: &str,
        method: String,
        params: Value,
    ) -> Result<(), String> {
        let stdin = self
            .servers
            .lock()
            .await
            .get(server_id)
            .ok_or_else(|| "语言服务未启动".to_string())?
            .stdin
            .clone();
        let payload =
            frame_message(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))?;
        let result = stdin
            .lock()
            .await
            .write_all(&payload)
            .await
            .map_err(|error| format!("发送 LSP 通知失败：{error}"));
        result
    }

    pub async fn request(&self, server_id: &str, request: LspRequest) -> Result<Value, String> {
        let (id, receiver, payload, stdin) = {
            let mut servers = self.servers.lock().await;
            let server = servers
                .get_mut(server_id)
                .ok_or_else(|| "语言服务未启动".to_string())?;
            let id = server.next_id;
            server.next_id = server.next_id.saturating_add(1);
            let (sender, receiver) = oneshot::channel();
            server.pending.lock().await.insert(id, sender);
            let payload = frame_message(
                &json!({ "jsonrpc": "2.0", "id": id, "method": request.method, "params": request.params }),
            )?;
            (id, receiver, payload, server.stdin.clone())
        };
        if let Err(error) = stdin.lock().await.write_all(&payload).await {
            self.remove_pending(server_id, id).await;
            return Err(format!("发送 LSP 请求失败：{error}"));
        }
        timeout(Duration::from_secs(30), receiver)
            .await
            .map_err(|_| "LSP 请求超时".to_string())?
            .map_err(|_| "LSP 进程已退出".to_string())
    }

    async fn remove_pending(&self, server_id: &str, id: u64) {
        if let Some(server) = self.servers.lock().await.get(server_id) {
            server.pending.lock().await.remove(&id);
        }
    }
}

fn emit_state(app: &AppHandle, state: &LspState) {
    let _ = app.emit("lsp://state", state);
}

fn frame_message(value: &Value) -> Result<Vec<u8>, String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if body.len() > MAX_MESSAGE_BYTES {
        return Err("LSP 请求过大".into());
    }
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend_from_slice(&body);
    Ok(frame)
}

fn take_frame(buffer: &mut Vec<u8>) -> Result<Option<Value>, String> {
    let Some(header_end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") else {
        return Ok(None);
    };
    let headers =
        std::str::from_utf8(&buffer[..header_end]).map_err(|_| "LSP header 不是 UTF-8")?;
    let length = headers
        .lines()
        .find_map(|line| {
            line.strip_prefix("Content-Length:")
                .and_then(|value| value.trim().parse::<usize>().ok())
        })
        .ok_or("LSP 缺少 Content-Length")?;
    if length > MAX_MESSAGE_BYTES {
        return Err("LSP 响应过大".into());
    }
    let body_start = header_end + 4;
    if buffer.len() < body_start + length {
        return Ok(None);
    }
    let body = buffer[body_start..body_start + length].to_vec();
    buffer.drain(..body_start + length);
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| format!("LSP JSON 无效：{error}"))
}

async fn read_stdout<R: AsyncRead + Unpin>(
    mut stdout: R,
    server_id: String,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    app: AppHandle,
) {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let read = match stdout.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(size) => size,
        };
        buffer.extend_from_slice(&chunk[..read]);
        loop {
            match take_frame(&mut buffer) {
                Ok(Some(value)) => {
                    if let Some(id) = value.get("id").and_then(Value::as_u64) {
                        if let Some(sender) = pending.lock().await.remove(&id) {
                            let _ = sender.send(value);
                        }
                    } else if value.get("method").and_then(Value::as_str)
                        == Some("textDocument/publishDiagnostics")
                    {
                        let _ = app.emit("lsp://diagnostics", json!({ "serverId": server_id, "params": value.get("params").cloned().unwrap_or(Value::Null) }));
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = app.emit(
                        "lsp://log",
                        json!({ "serverId": server_id, "level": "error", "message": error }),
                    );
                    buffer.clear();
                    break;
                }
            }
        }
    }
}

async fn read_stderr<R: AsyncRead + Unpin>(mut stderr: R, server_id: String, app: AppHandle) {
    let mut buffer = [0_u8; 4096];
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(size) => {
                let message = String::from_utf8_lossy(&buffer[..size]).to_string();
                let _ = app.emit(
                    "lsp://log",
                    json!({ "serverId": server_id, "level": "info", "message": message }),
                );
            }
        }
    }
}

async fn wait_child(
    mut child: Child,
    mut kill_rx: oneshot::Receiver<()>,
    app: AppHandle,
    server_id: String,
    root: String,
    state: Arc<Mutex<LspState>>,
) {
    let result = tokio::select! { status = child.wait() => status.map(|status| status.code()), _ = &mut kill_rx => { terminate_child_tree(&mut child).await; Ok(None) } };
    let (status, error) = match result {
        Ok(Some(0)) => ("exited", None),
        Ok(code) => ("crashed", Some(format!("语言服务退出，退出码：{code:?}"))),
        Err(error) => ("crashed", Some(error.to_string())),
    };
    let next = LspState {
        server_id,
        root,
        status: status.into(),
        error,
    };
    *state.lock().await = next.clone();
    emit_state(&app, &next);
}

fn sanitize_environment(command: &mut Command) {
    for (key, _) in std::env::vars_os() {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if upper.contains("TOKEN")
            || upper.contains("PASSWORD")
            || upper.contains("PASSWD")
            || upper.contains("SECRET")
            || upper.contains("API_KEY")
            || upper.contains("PRIVATE_KEY")
            || upper == "SSH_AUTH_SOCK"
        {
            command.env_remove(key);
        }
    }
}

async fn terminate_child_tree(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: the process is created in its own group above; a negative PID targets only it.
        unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
    }
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .await;
    }
    #[cfg(not(any(unix, windows)))]
    let _ = child.kill().await;
    let _ = child.wait().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_split_and_pipelined_frames() {
        let first = frame_message(&json!({ "id": 1, "result": true })).unwrap();
        let second = frame_message(&json!({ "id": 2, "result": false })).unwrap();
        let mut buffer = first[..first.len() - 2].to_vec();
        assert!(take_frame(&mut buffer).unwrap().is_none());
        buffer.extend_from_slice(&first[first.len() - 2..]);
        buffer.extend_from_slice(&second);
        assert_eq!(take_frame(&mut buffer).unwrap().unwrap()["id"], 1);
        assert_eq!(take_frame(&mut buffer).unwrap().unwrap()["id"], 2);
    }
}
