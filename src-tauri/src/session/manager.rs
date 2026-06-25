//! 会话池：管理多个持久 SSH 连接，供终端 / SFTP 共享复用。
//!
//! 核心思想：一个连接 = 一个 `SessionEntry`，持有认证后的 russh `Handle`。
//! 终端、SFTP 各自在这个 Handle 上开 channel，互不影响、共享同一条 TCP/SSH 连接。

use std::collections::HashMap;
use std::sync::Arc;

use russh::client;
use russh::Disconnect;
use serde::Serialize;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::ssh::SshConnectParams;
use super::ClientHandler;

/// 一个持久 SSH 会话。
pub struct SessionEntry {
    /// 可在不锁 Handle 的情况下读取的元数据。
    pub info: SessionInfo,
    /// 认证后的连接句柄。`channel_open_session`/`data`/`disconnect` 都是 `&self`，
    /// 但包一层 Mutex 便于将来需要 `&mut` 的操作，并序列化对同一连接的并发访问。
    pub handle: Mutex<client::Handle<ClientHandler>>,
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
    pub async fn connect(&self, p: &SshConnectParams) -> anyhow::Result<SessionInfo> {
        let config = Arc::new(client::Config::default());
        let mut handle = client::connect(config, (p.host.as_str(), p.port), ClientHandler).await?;

        let authed = handle
            .authenticate_password(p.user.as_str(), p.password.as_str())
            .await?;
        if !authed.success() {
            let _ = handle
                .disconnect(Disconnect::ByApplication, "auth failed", "en")
                .await;
            anyhow::bail!("authentication failed for '{}': {:?}", p.user, authed);
        }

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
            handle: Mutex::new(handle),
        });
        self.sessions.lock().await.insert(id, entry);
        Ok(info)
    }

    /// 取一个会话的共享句柄（Arc），调用方自行开 channel。
    #[allow(dead_code)] // 交互式终端会用它开 PTY channel
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
        let handle = entry.handle.lock().await;
        handle
            .disconnect(Disconnect::ByApplication, "bye", "en")
            .await?;
        Ok(())
    }
}
