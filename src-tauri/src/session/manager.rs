//! 会话池：管理多个持久 SSH 连接，供终端 / SFTP / 端口转发共享复用。
//!
//! 核心思想：一个连接 = 一个 `SessionEntry`，持有认证后的 russh `Handle` 和该连接的
//! `-R` 转发注册表。终端、SFTP、端口转发各自在这个 Handle 上开 channel，互不影响。
//! 经跳板机连接时额外持有 `jump_handle`，保证 direct-tcpip 隧道存活。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh::Disconnect;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::auth::SshConnectParams;
use super::forward::ForwardRegistry;
use super::{ClientHandler, HostKeyVerifier};

/// TCP 建连（含 DNS 解析）超时。不通时快速失败，而不是任由系统 SYN 重传挂死。
const TCP_TTL: Duration = Duration::from_secs(12);
/// SSH 协议握手（版本协商 + 密钥交换）超时。
const HANDSHAKE_TTL: Duration = Duration::from_secs(15);
/// 密码认证超时。
const AUTH_TTL: Duration = Duration::from_secs(12);

/// 推给前端的连接进度。`stage` ∈ resolve | handshake | auth | jump | ready。
#[derive(Clone, Serialize)]
pub struct ConnectProgress {
    pub connect_id: String,
    pub stage: String,
    pub message: String,
}

fn emit_progress(app: &AppHandle, id: &str, stage: &str, message: impl Into<String>) {
    let _ = app.emit(
        "ssh://progress",
        ConnectProgress {
            connect_id: id.to_string(),
            stage: stage.to_string(),
            message: message.into(),
        },
    );
}

/// 一个持久 SSH 会话。
pub struct SessionEntry {
    /// 可在不锁 Handle 的情况下读取的元数据。
    pub info: SessionInfo,
    /// 认证后的连接句柄（`Arc`：Handle 不 Clone 但方法都是 `&self`，多方共享一份 clone）。
    pub handle: Arc<client::Handle<ClientHandler>>,
    /// 该连接的 `-R` 远程转发注册表（与 ClientHandler 共享同一 Arc）。
    pub forward_registry: ForwardRegistry,
    /// 跳板机句柄：ProxyJump 时持有，断开目标会话前不可释放。
    jump_handle: Option<Arc<client::Handle<ClientHandler>>>,
    /// X11 转发 DISPLAY（与 ClientHandler 共享）。
    pub x11_display: Arc<Mutex<Option<String>>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub created_at: String,
    /// 经跳板机连接时展示跳板主机（host:port）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_via: Option<String>,
}

/// 全局会话管理器，作为 Tauri State 注入。
#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<SessionEntry>>>,
}

impl SessionManager {
    /// 建连 + 认证，成功后登记一个新会话，返回其信息。
    /// 全程向 `connect_id` 关联的 `ssh://progress` 事件推送阶段进度。
    pub async fn connect(
        &self,
        p: &SshConnectParams,
        app: &AppHandle,
        connect_id: &str,
        verifier: &HostKeyVerifier,
    ) -> anyhow::Result<SessionInfo> {
        let jump_via = p.jump.as_ref().map(|j| format!("{}:{}", j.host, j.port));

        let x11_display: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let (handle, forward_registry, jump_handle) = if let Some(jump) = &p.jump {
            self.connect_via_jump(
                p,
                jump.as_ref(),
                app,
                connect_id,
                verifier,
                x11_display.clone(),
            )
            .await?
        } else {
            let socket = tcp_connect(&p.host, p.port, app, connect_id).await?;
            let forward_registry: ForwardRegistry = Arc::new(Mutex::new(HashMap::new()));
            let handle = ssh_over_stream(
                socket,
                &p.host,
                p.port,
                &p.user,
                &p.auth,
                app,
                connect_id,
                verifier,
                forward_registry.clone(),
                x11_display.clone(),
            )
            .await?;
            (Arc::new(handle), forward_registry, None)
        };

        emit_progress(app, connect_id, "ready", "已连接");

        let id = Uuid::new_v4().to_string();
        let info = SessionInfo {
            id: id.clone(),
            host: p.host.clone(),
            port: p.port,
            user: p.user.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
            jump_via,
        };
        let entry = Arc::new(SessionEntry {
            info: info.clone(),
            handle,
            forward_registry,
            jump_handle,
            x11_display,
        });
        self.sessions.lock().await.insert(id, entry);
        Ok(info)
    }

    /// 经跳板机 ProxyJump：先连跳板 → direct-tcpip 隧道 → 在隧道上 SSH 到目标。
    async fn connect_via_jump(
        &self,
        target: &SshConnectParams,
        jump: &SshConnectParams,
        app: &AppHandle,
        connect_id: &str,
        verifier: &HostKeyVerifier,
        x11_display: Arc<Mutex<Option<String>>>,
    ) -> anyhow::Result<(
        Arc<client::Handle<ClientHandler>>,
        ForwardRegistry,
        Option<Arc<client::Handle<ClientHandler>>>,
    )> {
        emit_progress(
            app,
            connect_id,
            "jump",
            format!("连接跳板 {}:{}", jump.host, jump.port),
        );
        let jump_socket = tcp_connect(&jump.host, jump.port, app, connect_id).await?;
        let jump_registry: ForwardRegistry = Arc::new(Mutex::new(HashMap::new()));
        let jump_handle = ssh_over_stream(
            jump_socket,
            &jump.host,
            jump.port,
            &jump.user,
            &jump.auth,
            app,
            connect_id,
            verifier,
            jump_registry,
            x11_display.clone(),
        )
        .await?;
        let jump_arc = Arc::new(jump_handle);

        emit_progress(
            app,
            connect_id,
            "resolve",
            format!("经跳板连接目标 {}:{}", target.host, target.port),
        );
        let channel = jump_arc
            .channel_open_direct_tcpip(
                target.host.clone(),
                target.port as u32,
                "127.0.0.1".to_string(),
                0,
            )
            .await
            .map_err(|e| anyhow::anyhow!("跳板隧道失败：{e}"))?;
        let stream = channel.into_stream();

        let forward_registry: ForwardRegistry = Arc::new(Mutex::new(HashMap::new()));
        let target_handle = ssh_over_stream(
            stream,
            &target.host,
            target.port,
            &target.user,
            &target.auth,
            app,
            connect_id,
            verifier,
            forward_registry.clone(),
            x11_display,
        )
        .await?;

        Ok((Arc::new(target_handle), forward_registry, Some(jump_arc)))
    }

    /// 取一个会话的共享句柄（Arc），调用方自行开 channel。
    pub async fn get(&self, id: &str) -> Option<Arc<SessionEntry>> {
        self.sessions.lock().await.get(id).cloned()
    }

    /// 列出所有会话的元数据。
    pub async fn list(&self) -> Vec<SessionInfo> {
        self.sessions
            .lock()
            .await
            .values()
            .map(|e| e.info.clone())
            .collect()
    }

    /// 断开并移除一个会话。
    pub async fn disconnect(&self, id: &str) -> anyhow::Result<()> {
        let entry = self
            .sessions
            .lock()
            .await
            .remove(id)
            .ok_or_else(|| anyhow::anyhow!("session not found: {id}"))?;
        entry
            .handle
            .disconnect(Disconnect::ByApplication, "bye", "en")
            .await?;
        if let Some(jump) = entry.jump_handle.clone() {
            let _ = jump
                .disconnect(Disconnect::ByApplication, "bye", "en")
                .await;
        }
        Ok(())
    }
}

/// TCP 建连（带超时与进度推送）。
async fn tcp_connect(
    host: &str,
    port: u16,
    app: &AppHandle,
    connect_id: &str,
) -> anyhow::Result<TcpStream> {
    emit_progress(app, connect_id, "resolve", format!("解析主机 {host}"));
    let socket = match tokio::time::timeout(TCP_TTL, TcpStream::connect((host, port))).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => anyhow::bail!("无法连接到 {host}:{port} — {e}"),
        Err(_) => anyhow::bail!(
            "连接超时：{host}:{port} 在 {} 秒内未响应",
            TCP_TTL.as_secs()
        ),
    };
    let _ = socket.set_nodelay(true);
    Ok(socket)
}

/// 在任意双向流上完成 SSH 握手 + 认证（直连 TCP 或跳板隧道）。
#[allow(clippy::too_many_arguments)]
async fn ssh_over_stream(
    stream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
    host: &str,
    port: u16,
    user: &str,
    auth: &super::auth::SshAuth,
    app: &AppHandle,
    connect_id: &str,
    verifier: &HostKeyVerifier,
    forward_registry: ForwardRegistry,
    x11_display: Arc<Mutex<Option<String>>>,
) -> anyhow::Result<client::Handle<ClientHandler>> {
    emit_progress(app, connect_id, "handshake", "协商加密通道");
    let config = Arc::new(client::Config::default());
    let handler = ClientHandler::for_session(
        host.to_string(),
        port,
        app.clone(),
        connect_id.to_string(),
        verifier.clone(),
        forward_registry,
        x11_display,
    );
    let mut handle = tokio::time::timeout(
        HANDSHAKE_TTL,
        client::connect_stream(config, stream, handler),
    )
    .await
    .map_err(|_| anyhow::anyhow!("SSH 握手超时（{} 秒）", HANDSHAKE_TTL.as_secs()))?
    .map_err(|e| match e {
        russh::Error::UnknownKey => {
            anyhow::anyhow!("主机公钥未通过校验（未知或已变更），请在前端确认")
        }
        other => anyhow::anyhow!("SSH 握手失败：{other}"),
    })?;

    emit_progress(app, connect_id, "auth", format!("认证用户 {user}"));
    super::auth::authenticate(&mut handle, user, auth, AUTH_TTL).await?;
    Ok(handle)
}
