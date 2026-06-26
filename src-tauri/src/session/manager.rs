//! 会话池：管理多个持久 SSH 连接，供终端 / SFTP / 端口转发共享复用。
//!
//! 核心思想：一个连接 = 一个 `SessionEntry`，持有认证后的 russh `Handle` 和该连接的
//! `-R` 转发注册表。终端、SFTP、端口转发各自在这个 Handle 上开 channel，互不影响。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh::Disconnect;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::forward::ForwardRegistry;
use super::ssh::SshConnectParams;
use super::ClientHandler;

/// TCP 建连（含 DNS 解析）超时。不通时快速失败，而不是任由系统 SYN 重传挂死。
const TCP_TTL: Duration = Duration::from_secs(12);
/// SSH 协议握手（版本协商 + 密钥交换）超时。
const HANDSHAKE_TTL: Duration = Duration::from_secs(15);
/// 密码认证超时。
const AUTH_TTL: Duration = Duration::from_secs(12);

/// 推给前端的连接进度。`stage` ∈ resolve | handshake | auth | ready。
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
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub created_at: String,
}

/// 全局会话管理器，作为 Tauri State 注入。
#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<SessionEntry>>>,
}

impl SessionManager {
    /// 建连 + 密码认证，成功后登记一个新会话，返回其信息。
    /// 全程向 `connect_id` 关联的 `ssh://progress` 事件推送阶段进度。
    pub async fn connect(
        &self,
        p: &SshConnectParams,
        app: &AppHandle,
        connect_id: &str,
    ) -> anyhow::Result<SessionInfo> {
        // 1) 解析 + TCP 建连（带超时：不通就快速失败，不挂死）
        emit_progress(app, connect_id, "resolve", format!("解析主机 {}", p.host));
        let socket = match tokio::time::timeout(
            TCP_TTL,
            TcpStream::connect((p.host.as_str(), p.port)),
        )
        .await
        {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => anyhow::bail!("无法连接到 {}:{} — {e}", p.host, p.port),
            Err(_) => {
                anyhow::bail!(
                    "连接超时：{}:{} 在 {} 秒内未响应",
                    p.host,
                    p.port,
                    TCP_TTL.as_secs()
                )
            }
        };
        // 关闭 Nagle，交互式终端低延迟更重要
        let _ = socket.set_nodelay(true);

        // 2) SSH 握手（版本协商 + 密钥交换）
        emit_progress(app, connect_id, "handshake", "协商加密通道");
        let config = Arc::new(client::Config::default());
        let forward_registry: ForwardRegistry = Arc::new(Mutex::new(HashMap::new()));
        let handler = ClientHandler {
            forward_registry: forward_registry.clone(),
        };
        let mut handle = tokio::time::timeout(
            HANDSHAKE_TTL,
            client::connect_stream(config, socket, handler),
        )
        .await
        .map_err(|_| anyhow::anyhow!("SSH 握手超时（{} 秒）", HANDSHAKE_TTL.as_secs()))?
        .map_err(|e| anyhow::anyhow!("SSH 握手失败：{e}"))?;

        // 3) 密码认证
        emit_progress(app, connect_id, "auth", format!("认证用户 {}", p.user));
        let authed = match tokio::time::timeout(
            AUTH_TTL,
            handle.authenticate_password(p.user.as_str(), p.password.as_str()),
        )
        .await
        {
            Ok(Ok(a)) => a,
            Ok(Err(e)) => anyhow::bail!("认证出错：{e}"),
            Err(_) => anyhow::bail!("认证超时（{} 秒）", AUTH_TTL.as_secs()),
        };
        if !authed.success() {
            let _ = handle
                .disconnect(Disconnect::ByApplication, "auth failed", "en")
                .await;
            anyhow::bail!("认证失败：用户名或密码错误");
        }

        emit_progress(app, connect_id, "ready", "已连接");

        let id = Uuid::new_v4().to_string();
        let info = SessionInfo {
            id: id.clone(),
            host: p.host.clone(),
            port: p.port,
            user: p.user.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let entry = Arc::new(SessionEntry {
            info: info.clone(),
            handle: Arc::new(handle),
            forward_registry,
        });
        self.sessions.lock().await.insert(id, entry);
        Ok(info)
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
        Ok(())
    }
}
