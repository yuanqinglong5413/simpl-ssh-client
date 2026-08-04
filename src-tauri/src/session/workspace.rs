//! 工作区持久化：保存/加载前端工作区快照（Tab 列表 + 分屏布局）。
//!
//! 前端在 Tab 变更时 debounce 调用 `workspace_save`，启动时调用 `workspace_load`
//! 恢复上次的工作区状态。快照存入 SQLite，并由数据库事务保证原子更新。

use std::sync::Arc;

use tokio::sync::Mutex;

use super::storage::AppDatabase;

/// 工作区快照存储（SQLite 中透传前端序列化后的字符串）。
pub struct WorkspaceStore {
    database: Arc<AppDatabase>,
    /// 简单的内存缓存，避免频繁读文件。
    cache: Mutex<Option<String>>,
    /// 串行化保存，避免多个 debounce 写入共享临时文件互相覆盖。
    save_lock: Mutex<()>,
}

impl WorkspaceStore {
    pub fn new(database: Arc<AppDatabase>) -> Self {
        Self {
            database,
            cache: Mutex::new(None),
            save_lock: Mutex::new(()),
        }
    }

    /// 保存工作区快照（覆盖写）。
    pub async fn save(&self, snapshot: &str) -> Result<(), String> {
        let _guard = self.save_lock.lock().await;
        self.database.save("workspace", snapshot)?;
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

        match self.database.load::<String>("workspace") {
            Ok(Some(content)) => {
                *self.cache.lock().await = Some(content.clone());
                Ok(Some(content))
            }
            Ok(None) => Ok(None),
            Err(error) => Err(format!("读取工作区快照失败：{error}")),
        }
    }

    /// 清空工作区快照。
    pub async fn clear(&self) -> Result<(), String> {
        *self.cache.lock().await = None;
        self.database.delete("workspace")
    }
}

impl Default for WorkspaceStore {
    fn default() -> Self {
        Self::new(Arc::new(AppDatabase::default()))
    }
}
