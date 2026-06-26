//! 连接分组：侧栏树形展示用，与 profiles.json 分开持久化。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

/// 一个连接分组（扁平结构，不含嵌套）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileGroup {
    pub id: String,
    pub name: String,
    /// 排序权重，越小越靠前。
    pub order: i32,
}

/// 分组存储。
pub struct GroupStore {
    groups: Mutex<Vec<ProfileGroup>>,
    path: PathBuf,
}

impl GroupStore {
    pub fn new() -> Self {
        let path = groups_path();
        let groups = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            groups: Mutex::new(groups),
            path,
        }
    }

    pub async fn list(&self) -> Vec<ProfileGroup> {
        let mut g = self.groups.lock().await.clone();
        g.sort_by_key(|x| x.order);
        g
    }

    /// 新建分组，返回创建结果。
    pub async fn create(&self, name: String) -> Result<ProfileGroup, String> {
        let mut guard = self.groups.lock().await;
        let order = guard.iter().map(|g| g.order).max().unwrap_or(-1) + 1;
        let group = ProfileGroup {
            id: Uuid::new_v4().to_string(),
            name,
            order,
        };
        guard.push(group.clone());
        self.persist(&guard)?;
        Ok(group)
    }

    /// 重命名分组。
    pub async fn rename(&self, id: &str, name: String) -> Result<ProfileGroup, String> {
        let mut guard = self.groups.lock().await;
        let g = guard
            .iter_mut()
            .find(|g| g.id == id)
            .ok_or_else(|| format!("group not found: {id}"))?;
        g.name = name;
        let out = g.clone();
        self.persist(&guard)?;
        Ok(out)
    }

    /// 删除分组（调用方负责将组内 profile 移出）。
    pub async fn delete(&self, id: &str) -> Result<(), String> {
        let mut guard = self.groups.lock().await;
        let before = guard.len();
        guard.retain(|g| g.id != id);
        if guard.len() == before {
            return Err(format!("group not found: {id}"));
        }
        self.persist(&guard)?;
        Ok(())
    }

    fn persist(&self, groups: &[ProfileGroup]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let s = serde_json::to_string_pretty(groups).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, s).map_err(|e| e.to_string())?;
        Ok(())
    }
}

impl Default for GroupStore {
    fn default() -> Self {
        Self::new()
    }
}

fn groups_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("simpl-ssh").join("groups.json")
}
