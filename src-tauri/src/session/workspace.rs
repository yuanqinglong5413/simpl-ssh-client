//! 工作区持久化：保存/加载前端工作区快照（Tab 列表 + 分屏布局）。
//!
//! 前端在 Tab 变更时 debounce 调用 `workspace_save`，启动时调用 `workspace_load`
//! 恢复上次的工作区状态。存储位置与 `profiles.json` 同目录。

use std::path::PathBuf;

use tokio::sync::Mutex;

/// 工作区快照存储（JSON 文件，透传前端序列化后的字符串）。
pub struct WorkspaceStore {
    path: PathBuf,
    /// 简单的内存缓存，避免频繁读文件。
    cache: Mutex<Option<String>>,
}

impl WorkspaceStore {
    pub fn new() -> Self {
        Self {
            path: workspace_path(),
            cache: Mutex::new(None),
        }
    }

    /// 保存工作区快照（覆盖写）。
    pub async fn save(&self, snapshot: &str) -> Result<(), String> {
        // 确保目录存在
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&self.path, snapshot).map_err(|e| e.to_string())?;
        *self.cache.lock().await = Some(snapshot.to_string());
        Ok(())
    }

    /// 加载上次的工作区快照。首次调用时从文件读取。
    pub async fn load(&self) -> Result<Option<String>, String> {
        // 先查缓存
        {
            let cache = self.cache.lock().await;
            if cache.is_some() {
                return Ok(cache.clone());
            }
        }

        if !self.path.exists() {
            return Ok(None);
        }

        match std::fs::read_to_string(&self.path) {
            Ok(content) => {
                *self.cache.lock().await = Some(content.clone());
                Ok(Some(content))
            }
            Err(e) => {
                tracing::warn!("读取 workspace.json 失败: {e}");
                Ok(None)
            }
        }
    }

    /// 清空工作区快照。
    pub async fn clear(&self) -> Result<(), String> {
        *self.cache.lock().await = None;
        if self.path.exists() {
            std::fs::remove_file(&self.path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

impl Default for WorkspaceStore {
    fn default() -> Self {
        Self::new()
    }
}

fn workspace_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("simpl-ssh").join("workspace.json")
}
