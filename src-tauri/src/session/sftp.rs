//! SFTP：在会话已建立的 SSH 连接上开 SFTP subsystem channel（russh-sftp），
//! 复用同一条连接、不重新认证。每个 SSH 会话缓存一个 `SftpSession`，
//! 后续 list / 传输 / 增删改都在它上面进行。

use std::collections::HashMap;
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::sync::Mutex;

use super::manager::SessionManager;

/// 目录条目，序列化传给前端展示。
#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: Option<String>,
}

/// 缓存每个 SSH 会话的 SftpSession。作为 Tauri State 注入。
#[derive(Default)]
pub struct SftpManager {
    sessions: Mutex<HashMap<String, Arc<SftpSession>>>,
}

impl SftpManager {
    /// 取（或首次创建并缓存）某会话的 SftpSession。
    pub async fn get(
        &self,
        sessions: &SessionManager,
        session_id: &str,
    ) -> Result<Arc<SftpSession>, String> {
        // 快速路径：命中缓存
        {
            if let Some(s) = self.sessions.lock().await.get(session_id) {
                return Ok(s.clone());
            }
        }
        // 未命中：在会话连接上开 SFTP channel（复用同一条 SSH 连接）
        let entry = sessions
            .get(session_id)
            .await
            .ok_or_else(|| format!("session not found: {session_id}"))?;
        let channel = {
            let handle = entry.handle.lock().await;
            let channel = handle
                .channel_open_session()
                .await
                .map_err(|e| e.to_string())?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(|e| e.to_string())?;
            channel
        };
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| e.to_string())?;
        let sftp = Arc::new(sftp);
        self.sessions
            .lock()
            .await
            .insert(session_id.to_string(), sftp.clone());
        Ok(sftp)
    }

    /// 会话断开时清理缓存的 SftpSession。
    pub async fn close(&self, session_id: &str) {
        self.sessions.lock().await.remove(session_id);
    }
}

/// 把 `SystemTime` 格式化成本地可读字符串。
fn fmt_modified(t: std::io::Result<std::time::SystemTime>) -> Option<String> {
    t.ok().map(|st| {
        chrono::DateTime::<chrono::Local>::from(st)
            .format("%Y-%m-%d %H:%M")
            .to_string()
    })
}

/// 列目录。`path` 为 None 或空时用家目录。返回 (规范化的绝对路径, 条目列表)。
pub async fn list_dir(
    sftp: &SftpSession,
    path: Option<&str>,
) -> Result<(String, Vec<FileEntry>), String> {
    let resolved = match path {
        Some(p) if !p.is_empty() => sftp.canonicalize(p).await.map_err(|e| e.to_string())?,
        _ => sftp.canonicalize(".").await.map_err(|e| e.to_string())?,
    };
    let resolved = resolved.trim_end_matches('/').to_string();

    let read = sftp
        .read_dir(if resolved.is_empty() { "/" } else { &resolved })
        .await
        .map_err(|e| e.to_string())?;

    let mut entries: Vec<FileEntry> = read
        .into_iter()
        .filter_map(|e| {
            let name = e.file_name();
            if name == "." || name == ".." {
                return None;
            }
            let m = e.metadata();
            Some(FileEntry {
                name,
                is_dir: m.is_dir(),
                is_symlink: m.is_symlink(),
                size: m.len(),
                modified: fmt_modified(m.modified()),
            })
        })
        .collect();

    // 目录在前，同类按名字排
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok((resolved, entries))
}
