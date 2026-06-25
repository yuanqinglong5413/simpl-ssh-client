//! 保存的连接配置。
//!
//! 元数据（名称/主机/端口/用户）存本地 JSON（app config dir）；
//! 密码存 OS 钥匙串（keyring），**不落明文**。
//!
//! 钥匙串里的密码读出后会进入一个**内存加密缓存**（见 [`super::secrets`]），
//! 24h 内重复连接同一配置直接命中缓存，不再访问钥匙串——避免 macOS 上
//! 每次读取都弹系统授权框。缓存随进程退出而清空。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::secrets::PasswordCache;

const SERVICE: &str = "simpl-ssh";

/// 一个保存的连接配置（不含密码）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
}

/// 连接配置存储。作为 Tauri State 注入。
pub struct ProfileStore {
    profiles: Mutex<Vec<ConnectionProfile>>,
    path: PathBuf,
    cache: PasswordCache,
}

impl ProfileStore {
    /// 从磁盘加载（文件不存在则空）。
    pub fn new() -> Self {
        let path = profile_path();
        let profiles = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            profiles: Mutex::new(profiles),
            path,
            cache: PasswordCache::new(),
        }
    }

    pub async fn list(&self) -> Vec<ConnectionProfile> {
        self.profiles.lock().await.clone()
    }

    pub async fn find(&self, id: &str) -> Option<ConnectionProfile> {
        self.profiles
            .lock()
            .await
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    /// 保存一个配置：密码进钥匙串，元数据进 JSON。返回新建的配置。
    pub async fn save(
        &self,
        name: String,
        host: String,
        port: u16,
        user: String,
        password: String,
    ) -> Result<ConnectionProfile, String> {
        let id = Uuid::new_v4().to_string();
        let entry = keyring::Entry::new(SERVICE, &id).map_err(|e| e.to_string())?;
        entry.set_password(&password).map_err(|e| e.to_string())?;

        let profile = ConnectionProfile {
            id,
            name,
            host,
            port,
            user,
        };
        let mut guard = self.profiles.lock().await;
        guard.push(profile.clone());
        self.persist(&guard)?;
        Ok(profile)
    }

    /// 删除一个配置：从 JSON 移除并清理钥匙串条目（钥匙串不存在则忽略）。
    pub async fn delete(&self, id: &str) -> Result<(), String> {
        {
            let mut guard = self.profiles.lock().await;
            guard.retain(|p| p.id != id);
            self.persist(&guard)?;
        }
        if let Ok(entry) = keyring::Entry::new(SERVICE, id) {
            let _ = entry.delete_credential();
        }
        self.cache.remove(id).await;
        Ok(())
    }

    /// 读取某配置的密码：先查内存加密缓存（24h 内命中则不碰钥匙串），
    /// 未命中再从钥匙串读并回填缓存。
    pub async fn get_password(&self, id: &str) -> Result<String, String> {
        if let Some(pw) = self.cache.get(id).await {
            return Ok(pw);
        }
        let entry = keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())?;
        let pw = entry.get_password().map_err(|e| e.to_string())?;
        self.cache.put(id, &pw).await;
        Ok(pw)
    }

    fn persist(&self, profiles: &[ConnectionProfile]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let s = serde_json::to_string_pretty(profiles).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, s).map_err(|e| e.to_string())?;
        Ok(())
    }
}

impl Default for ProfileStore {
    fn default() -> Self {
        Self::new()
    }
}

fn profile_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("simpl-ssh").join("profiles.json")
}
