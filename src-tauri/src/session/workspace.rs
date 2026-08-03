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
    /// 串行化保存，避免多个 debounce 写入共享临时文件互相覆盖。
    save_lock: Mutex<()>,
}

impl WorkspaceStore {
    pub fn new() -> Self {
        Self {
            path: workspace_path(),
            cache: Mutex::new(None),
            save_lock: Mutex::new(()),
        }
    }

    /// 保存工作区快照（覆盖写）。
    pub async fn save(&self, snapshot: &str) -> Result<(), String> {
        let _guard = self.save_lock.lock().await;
        // 确保目录存在
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // 先写同目录临时文件并原子替换，避免应用退出/断电时留下半截 JSON。
        let temp_path = self
            .path
            .with_extension(format!("json.tmp-{}", uuid::Uuid::new_v4()));
        {
            use std::io::Write;
            let mut file = std::fs::File::create(&temp_path).map_err(|e| e.to_string())?;
            file.write_all(snapshot.as_bytes())
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
        }
        if std::fs::rename(&temp_path, &self.path).is_err() {
            // Windows cannot replace an existing file with rename. Remove the
            // destination only after the new snapshot is fully synced.
            #[cfg(windows)]
            {
                std::fs::remove_file(&self.path)
                    .map_err(|remove_error| remove_error.to_string())?;
                std::fs::rename(&temp_path, &self.path)
                    .map_err(|rename_error| rename_error.to_string())?;
            }
            #[cfg(not(windows))]
            {
                let _ = std::fs::remove_file(&temp_path);
                return Err("原子替换工作区快照失败".to_string());
            }
        }
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
            if let Some(parent) = self.path.parent() {
                let name = self
                    .path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_string();
                let mut candidates: Vec<_> = std::fs::read_dir(parent)
                    .ok()
                    .into_iter()
                    .flat_map(|entries| entries.flatten())
                    .filter(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with(&format!("{name}.tmp-"))
                    })
                    .collect();
                candidates
                    .sort_by_key(|entry| entry.metadata().and_then(|meta| meta.modified()).ok());
                if let Some(temp_path) = candidates.last().map(|entry| entry.path()) {
                    let _ = std::fs::rename(temp_path, &self.path);
                }
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
                Err(format!("读取工作区快照失败：{e}"))
            }
        }
    }

    /// 清空工作区快照。
    pub async fn clear(&self) -> Result<(), String> {
        *self.cache.lock().await = None;
        if self.path.exists() {
            std::fs::remove_file(&self.path).map_err(|e| e.to_string())?;
        }
        if let Some(parent) = self.path.parent() {
            if let Some(name) = self.path.file_name().and_then(|value| value.to_str()) {
                if let Ok(entries) = std::fs::read_dir(parent) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .is_some_and(|value| value.starts_with(&format!("{name}.tmp-")))
                        {
                            let _ = std::fs::remove_file(path);
                        }
                    }
                }
            }
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
