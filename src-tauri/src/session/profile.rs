//! 保存的连接配置。
//!
//! 元数据（名称/主机/端口/用户/认证方式/私钥路径）存本地 JSON；
//! 密码与私钥 passphrase 存 OS 钥匙串（keyring），**不落明文**。
//!
//! 钥匙串里的密码读出后会进入一个**内存加密缓存**（见 [`super::secrets`]），
//! 24h 内重复连接同一配置直接命中缓存，不再访问钥匙串——避免 macOS 上
//! 每次读取都弹系统授权框。缓存随进程退出而清空。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::auth::{SshAuth, SshConnectParams};
use super::secrets::PasswordCache;

const SERVICE: &str = "simpl-ssh";

/// 认证方式（与前端 JSON 字段 snake_case 对齐）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    #[default]
    #[serde(rename = "password")]
    Password,
    #[serde(rename = "private_key")]
    PrivateKey,
}

/// 保存 / 更新连接配置时的输入（封装多字段，避免函数参数过多）。
#[derive(Debug, Clone)]
pub struct ProfileInput {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_method: AuthMethod,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
}

/// 一个保存的连接配置（不含密码 / passphrase）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth_method: AuthMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key_path: Option<String>,
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

    /// 保存一个新配置：凭据进钥匙串，元数据进 JSON。
    pub async fn save(&self, input: ProfileInput) -> Result<ConnectionProfile, String> {
        let id = Uuid::new_v4().to_string();
        self.store_credentials(
            &id,
            input.auth_method.clone(),
            input.password,
            input.private_key_path.clone(),
            input.passphrase,
        )?;

        let profile = ConnectionProfile {
            id,
            name: input.name,
            host: input.host,
            port: input.port,
            user: input.user,
            auth_method: input.auth_method,
            private_key_path: input.private_key_path,
        };
        let mut guard = self.profiles.lock().await;
        guard.push(profile.clone());
        self.persist(&guard)?;
        Ok(profile)
    }

    /// 更新已有配置；密码 / passphrase 传空则保留钥匙串中的旧值。
    pub async fn update(
        &self,
        id: &str,
        input: ProfileInput,
    ) -> Result<ConnectionProfile, String> {
        let mut guard = self.profiles.lock().await;
        let idx = guard
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| format!("profile not found: {id}"))?;

        let prev_method = guard[idx].auth_method.clone();
        if prev_method != input.auth_method {
            self.clear_credentials(id, &prev_method);
            match &input.auth_method {
                AuthMethod::Password => {
                    let pw = input
                        .password
                        .filter(|s| !s.is_empty())
                        .ok_or_else(|| "切换为密码认证需填写密码".to_string())?;
                    self.set_password(id, &pw)?;
                }
                AuthMethod::PrivateKey => {
                    if input.private_key_path.as_ref().is_none_or(|s| s.is_empty()) {
                        return Err("切换为私钥认证需选择私钥文件".to_string());
                    }
                    if let Some(pp) = input.passphrase.filter(|s| !s.is_empty()) {
                        self.set_passphrase(id, &pp)?;
                    }
                }
            }
        } else {
            match input.auth_method {
                AuthMethod::Password => {
                    if let Some(pw) = input.password.filter(|s| !s.is_empty()) {
                        self.set_password(id, &pw)?;
                        self.cache.remove(id).await;
                    }
                }
                AuthMethod::PrivateKey => {
                    if let Some(pp) = input.passphrase.filter(|s| !s.is_empty()) {
                        self.set_passphrase(id, &pp)?;
                        self.cache.remove(&passphrase_key(id)).await;
                    }
                }
            }
        }

        if input.auth_method == AuthMethod::PrivateKey
            && input.private_key_path.as_ref().is_none_or(|s| s.is_empty())
        {
            return Err("私钥认证需要指定私钥路径".to_string());
        }

        guard[idx] = ConnectionProfile {
            id: id.to_string(),
            name: input.name,
            host: input.host,
            port: input.port,
            user: input.user,
            auth_method: input.auth_method,
            private_key_path: input.private_key_path,
        };
        let updated = guard[idx].clone();
        self.persist(&guard)?;
        Ok(updated)
    }

    /// 删除一个配置：从 JSON 移除并清理钥匙串条目。
    pub async fn delete(&self, id: &str) -> Result<(), String> {
        let auth_method = {
            let mut guard = self.profiles.lock().await;
            let auth = guard
                .iter()
                .find(|p| p.id == id)
                .map(|p| p.auth_method.clone());
            guard.retain(|p| p.id != id);
            self.persist(&guard)?;
            auth
        };
        if let Some(method) = auth_method {
            self.clear_credentials(id, &method);
        }
        self.cache.remove(id).await;
        self.cache.remove(&passphrase_key(id)).await;
        Ok(())
    }

    /// 将 profile 转为 SSH 连接参数（从钥匙串读凭据）。
    pub async fn to_connect_params(&self, profile: &ConnectionProfile) -> Result<SshConnectParams, String> {
        let auth = match profile.auth_method {
            AuthMethod::Password => {
                let pw = self.get_password(&profile.id).await?;
                SshAuth::Password(pw)
            }
            AuthMethod::PrivateKey => {
                let path = profile
                    .private_key_path
                    .clone()
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| "未配置私钥路径".to_string())?;
                let passphrase = self.get_passphrase(&profile.id).await.ok();
                SshAuth::PrivateKey { path, passphrase }
            }
        };
        Ok(SshConnectParams {
            host: profile.host.clone(),
            port: profile.port,
            user: profile.user.clone(),
            auth,
        })
    }

    /// 读取某配置的密码（内存缓存 → 钥匙串）。
    pub async fn get_password(&self, id: &str) -> Result<String, String> {
        if let Some(pw) = self.cache.get(id).await {
            return Ok(pw);
        }
        let entry = keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())?;
        let pw = entry.get_password().map_err(|e| e.to_string())?;
        self.cache.put(id, &pw).await;
        Ok(pw)
    }

    /// 读取私钥 passphrase（可选；无则 Ok 空串）。
    pub async fn get_passphrase(&self, id: &str) -> Result<String, String> {
        let key = passphrase_key(id);
        if let Some(pw) = self.cache.get(&key).await {
            return Ok(pw);
        }
        let entry = keyring::Entry::new(SERVICE, &key).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(pw) => {
                self.cache.put(&key, &pw).await;
                Ok(pw)
            }
            Err(_) => Ok(String::new()),
        }
    }

    fn set_password(&self, id: &str, password: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())?;
        entry.set_password(password).map_err(|e| e.to_string())
    }

    fn set_passphrase(&self, id: &str, passphrase: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, &passphrase_key(id)).map_err(|e| e.to_string())?;
        entry.set_password(passphrase).map_err(|e| e.to_string())
    }

    fn store_credentials(
        &self,
        id: &str,
        auth_method: AuthMethod,
        password: Option<String>,
        private_key_path: Option<String>,
        passphrase: Option<String>,
    ) -> Result<(), String> {
        match auth_method {
            AuthMethod::Password => {
                let pw = password.filter(|s| !s.is_empty()).ok_or_else(|| {
                    "密码认证需要填写密码".to_string()
                })?;
                self.set_password(id, &pw)?;
            }
            AuthMethod::PrivateKey => {
                if private_key_path.as_ref().is_none_or(|s| s.is_empty()) {
                    return Err("私钥认证需要选择私钥文件".to_string());
                }
                if let Some(pp) = passphrase.filter(|s| !s.is_empty()) {
                    self.set_passphrase(id, &pp)?;
                }
            }
        }
        Ok(())
    }

    fn clear_credentials(&self, id: &str, auth_method: &AuthMethod) {
        match auth_method {
            AuthMethod::Password => {
                if let Ok(entry) = keyring::Entry::new(SERVICE, id) {
                    let _ = entry.delete_credential();
                }
            }
            AuthMethod::PrivateKey => {
                if let Ok(entry) = keyring::Entry::new(SERVICE, &passphrase_key(id)) {
                    let _ = entry.delete_credential();
                }
            }
        }
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

fn passphrase_key(id: &str) -> String {
    format!("{id}:passphrase")
}
