//! 端口转发：本地 `-L` / 远程 `-R` / 动态 SOCKS5 `-D`。
//!
//! - `-L`：本地 `TcpListener`，每个连接在 SSH 上开 `direct-tcpip` 通道连到远端目标。
//! - `-D`：本地 `TcpListener`，每个连接先 SOCKS5 握手拿到目标，再 `direct-tcpip`。
//! - `-R`：请求服务器在远端 bind 端口（`tcpip_forward`）；服务器来连接时触发
//!   `ClientHandler::server_channel_open_forwarded_tcpip` 回调，回调查 `registry`
//!   拿本地目标并桥接（实现见 `mod.rs`，因为回调必须在 Handler impl 内）。
//!
//! `Handle` 不 `Clone`，但其方法都是 `&self`，所以用 `Arc<Handle>` 共享：每个 listener
//! 持一份 clone，每条连接再 clone 一份开 channel。桥接循环抽成 `bridge_loop!` 宏。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use russh::client::Handle;
use russh::ChannelMsg;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

use crate::session::socks::socks5_handshake;
use crate::session::ClientHandler;

/// 双向桥接一个 `TcpStream` 和一个 SSH `Channel`。以宏实现，靠局部类型推断。
macro_rules! bridge_loop {
    ($stream:expr, $channel:expr) => {{
        let mut stream = $stream;
        let mut channel = $channel;
        let mut buf = vec![0u8; 65536];
        let mut stream_closed = false;
        loop {
            tokio::select! {
                r = stream.read(&mut buf), if !stream_closed => match r {
                    Ok(0) => { stream_closed = true; let _ = channel.eof().await; }
                    Ok(n) => { if channel.data(&buf[..n]).await.is_err() { break; } }
                    Err(_) => break,
                },
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { ref data }) => { let _ = stream.write_all(data).await; }
                    Some(ChannelMsg::Eof) => break,
                    Some(ChannelMsg::WindowAdjusted { .. }) => {}
                    _ => {}
                }
            }
        }
    }};
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ForwardKind {
    Local,
    Remote,
    Dynamic,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub enum ForwardState {
    Starting,
    Active,
    Failed(String),
    Stopped,
}

/// `-R` 远端转发注册表：`(远端 bind_host, bind_port) → (本地目标 host, port)`。
/// 回调 `server_channel_open_forwarded_tcpip` 据此把进来的 channel 桥到本地目标。
pub type ForwardRegistry = Arc<Mutex<HashMap<(String, u32), (String, u16)>>>;

pub struct ForwardEntry {
    pub id: String,
    pub session_id: String,
    pub kind: ForwardKind,
    pub local_addr: String,
    pub local_port: u16,
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
    pub bound_port: u16,
    state: Mutex<ForwardState>,
    cancel: Arc<Notify>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardEntrySnap {
    pub id: String,
    pub session_id: String,
    pub kind: ForwardKind,
    pub local_addr: String,
    pub local_port: u16,
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
    pub bound_port: u16,
    pub state: ForwardState,
}

impl ForwardEntry {
    async fn snapshot(&self) -> ForwardEntrySnap {
        ForwardEntrySnap {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            kind: self.kind,
            local_addr: self.local_addr.clone(),
            local_port: self.local_port,
            remote_host: self.remote_host.clone(),
            remote_port: self.remote_port,
            bound_port: self.bound_port,
            state: self.state.lock().await.clone(),
        }
    }
}

/// 端口转发管理器（Tauri State）。
#[derive(Default)]
pub struct PortForwardManager {
    forwards: Mutex<HashMap<String, Arc<ForwardEntry>>>,
}

impl PortForwardManager {
    /// 新建一条转发。`handle` / `registry` 来自对应 session（commands 层取）。
    #[allow(clippy::too_many_arguments)]
    pub async fn add(
        &self,
        handle: Arc<Handle<ClientHandler>>,
        registry: ForwardRegistry,
        session_id: String,
        kind: ForwardKind,
        local_addr: String,
        local_port: u16,
        remote_host: Option<String>,
        remote_port: Option<u16>,
    ) -> Result<ForwardEntrySnap, String> {
        let id = Uuid::new_v4().to_string();
        let cancel = Arc::new(Notify::new());

        let (bound_port, state) = match kind {
            ForwardKind::Local => {
                let rh = remote_host.clone().ok_or("-L 需要 remote_host")?;
                let rp = remote_port.ok_or("-L 需要 remote_port")?;
                let listener = TcpListener::bind((local_addr.as_str(), local_port))
                    .await
                    .map_err(|e| e.to_string())?;
                let bp = listener.local_addr().map_err(|e| e.to_string())?.port();
                tauri::async_runtime::spawn(run_local(handle, listener, cancel.clone(), rh, rp));
                (bp, ForwardState::Active)
            }
            ForwardKind::Dynamic => {
                let listener = TcpListener::bind((local_addr.as_str(), local_port))
                    .await
                    .map_err(|e| e.to_string())?;
                let bp = listener.local_addr().map_err(|e| e.to_string())?.port();
                tauri::async_runtime::spawn(run_dynamic(handle, listener, cancel.clone()));
                (bp, ForwardState::Active)
            }
            ForwardKind::Remote => {
                let bind_host = remote_host
                    .clone()
                    .unwrap_or_else(|| "127.0.0.1".to_string());
                let bind_port = remote_port.ok_or("-R 需要 remote_port")?;
                let bound = handle
                    .tcpip_forward(bind_host.clone(), bind_port as u32)
                    .await
                    .map_err(|e| e.to_string())?;
                registry
                    .lock()
                    .await
                    .insert((bind_host, bound), (local_addr.clone(), local_port));
                (bound as u16, ForwardState::Active)
            }
        };

        let entry = Arc::new(ForwardEntry {
            id: id.clone(),
            session_id: session_id.clone(),
            kind,
            local_addr,
            local_port,
            remote_host,
            remote_port,
            bound_port,
            state: Mutex::new(state),
            cancel,
        });
        let snap = entry.snapshot().await;
        self.forwards.lock().await.insert(id, entry);
        Ok(snap)
    }

    pub async fn list(&self) -> Vec<ForwardEntrySnap> {
        let mut v: Vec<ForwardEntrySnap> = Vec::new();
        for e in self.forwards.lock().await.values() {
            v.push(e.snapshot().await);
        }
        v
    }

    /// 取一条快照（commands 层判断 kind 用）。
    pub async fn get_snap(&self, id: &str) -> Option<ForwardEntrySnap> {
        let entry = self.forwards.lock().await.get(id).cloned()?;
        Some(entry.snapshot().await)
    }

    /// 停止并移除一条转发（通知 listener 退出 + 从表移除）。`-R` 的远端 cancel 由调用方做。
    pub async fn remove(&self, id: &str) {
        if let Some(entry) = self.forwards.lock().await.remove(id) {
            entry.cancel.notify_waiters();
            *entry.state.lock().await = ForwardState::Stopped;
        }
    }

    /// 停止某 session 的所有转发（ssh_disconnect 时调用，best-effort）。
    pub async fn close_session(&self, session_id: &str) {
        let ids: Vec<String> = self
            .forwards
            .lock()
            .await
            .values()
            .filter(|e| e.session_id == session_id)
            .map(|e| e.id.clone())
            .collect();
        for id in ids {
            self.remove(&id).await;
        }
    }
}

/// `-L` 本地转发：accept 循环，每个连接开 direct-tcpip 并桥接。
async fn run_local(
    handle: Arc<Handle<ClientHandler>>,
    listener: TcpListener,
    cancel: Arc<Notify>,
    remote_host: String,
    remote_port: u16,
) {
    loop {
        let (stream, o_addr) = tokio::select! {
            r = listener.accept() => match r { Ok(x) => x, Err(_) => break },
            _ = cancel.notified() => break,
        };
        let h = handle.clone();
        let rh = remote_host.clone();
        tauri::async_runtime::spawn(async move {
            let ch = match h
                .channel_open_direct_tcpip(
                    rh,
                    remote_port as u32,
                    o_addr.ip().to_string(),
                    o_addr.port() as u32,
                )
                .await
            {
                Ok(c) => c,
                Err(_) => return,
            };
            bridge_loop!(stream, ch);
        });
    }
}

/// `-D` 动态转发：accept 循环，每个连接 SOCKS5 握手（带超时）后开 direct-tcpip。
async fn run_dynamic(
    handle: Arc<Handle<ClientHandler>>,
    listener: TcpListener,
    cancel: Arc<Notify>,
) {
    loop {
        let (mut stream, _addr) = tokio::select! {
            r = listener.accept() => match r { Ok(x) => x, Err(_) => break },
            _ = cancel.notified() => break,
        };
        let h = handle.clone();
        tauri::async_runtime::spawn(async move {
            let (host, port) =
                match tokio::time::timeout(Duration::from_secs(5), socks5_handshake(&mut stream))
                    .await
                {
                    Ok(Some(t)) => t,
                    _ => return,
                };
            let ch = match h
                .channel_open_direct_tcpip(host, port as u32, "127.0.0.1".to_string(), 0)
                .await
            {
                Ok(c) => c,
                Err(_) => return,
            };
            bridge_loop!(stream, ch);
        });
    }
}
