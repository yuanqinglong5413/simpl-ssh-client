//! 保存的连接配置。
//!
//! 元数据（名称/主机/端口/用户/认证方式/私钥路径）存本地 JSON；
//! 密码与私钥 passphrase 存 OS 钥匙串（keyring），**不落明文**。
//!
//! 钥匙串里的密码读出后会进入**加密缓存**（见 [`super::secrets`]）：
//! 内存 + 本机绑定磁盘密文，24h 内重复连接 / 重启应用直接命中，
//! 不再访问钥匙串——避免 macOS 上每次读取都弹系统授权框。

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
    pub group_id: Option<String>,
    pub jump_profile_id: Option<String>,
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
    /// 所属分组 id；None 表示未分组。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    /// 跳板机：引用另一个已保存连接的 id（单跳 ProxyJump）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_profile_id: Option<String>,
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
        )
        .await?;

        let profile = ConnectionProfile {
            id,
            name: input.name,
            host: input.host,
            port: input.port,
            user: input.user,
            auth_method: input.auth_method,
            private_key_path: input.private_key_path,
            group_id: input.group_id,
            jump_profile_id: input.jump_profile_id,
        };
        let mut guard = self.profiles.lock().await;
        guard.push(profile.clone());
        self.persist(&guard)?;
        Ok(profile)
    }

    /// 更新已有配置；密码 / passphrase 传空则保留钥匙串中的旧值。
    pub async fn update(&self, id: &str, input: ProfileInput) -> Result<ConnectionProfile, String> {
        // 先读出旧认证方式（短持锁），再在锁外写钥匙串，避免 await 钥匙串弹窗时死锁。
        let prev_method = {
            let guard = self.profiles.lock().await;
            guard
                .iter()
                .find(|p| p.id == id)
                .map(|p| p.auth_method.clone())
                .ok_or_else(|| format!("profile not found: {id}"))?
        };

        if input.auth_method == AuthMethod::PrivateKey
            && input.private_key_path.as_ref().is_none_or(|s| s.is_empty())
        {
            return Err("私钥认证需要指定私钥路径".to_string());
        }
        if input.jump_profile_id.as_deref() == Some(id) {
            return Err("跳板机不能指向自身".to_string());
        }

        if prev_method != input.auth_method {
            self.clear_credentials(id, &prev_method);
            match &input.auth_method {
                AuthMethod::Password => {
                    let pw = input
                        .password
                        .as_ref()
                        .filter(|s| !s.is_empty())
                        .ok_or_else(|| "切换为密码认证需填写密码".to_string())?;
                    self.set_password_cached(id, pw).await?;
                }
                AuthMethod::PrivateKey => {
                    if let Some(pp) = input.passphrase.as_ref().filter(|s| !s.is_empty()) {
                        self.set_passphrase_cached(id, pp).await?;
                    }
                }
            }
        } else {
            match input.auth_method {
                AuthMethod::Password => {
                    if let Some(pw) = input.password.as_ref().filter(|s| !s.is_empty()) {
                        self.set_password_cached(id, pw).await?;
                    }
                }
                AuthMethod::PrivateKey => {
                    if let Some(pp) = input.passphrase.as_ref().filter(|s| !s.is_empty()) {
                        self.set_passphrase_cached(id, pp).await?;
                    }
                }
            }
        }

        let mut guard = self.profiles.lock().await;
        let idx = guard
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| format!("profile not found: {id}"))?;
        guard[idx] = ConnectionProfile {
            id: id.to_string(),
            name: input.name,
            host: input.host,
            port: input.port,
            user: input.user,
            auth_method: input.auth_method,
            private_key_path: input.private_key_path,
            group_id: input.group_id,
            jump_profile_id: input.jump_profile_id,
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

    /// 删除分组时，清除所有 profile 对该分组的引用。
    pub async fn clear_group_refs(&self, group_id: &str) -> Result<(), String> {
        let mut guard = self.profiles.lock().await;
        let mut changed = false;
        for p in guard.iter_mut() {
            if p.group_id.as_deref() == Some(group_id) {
                p.group_id = None;
                changed = true;
            }
        }
        if changed {
            self.persist(&guard)?;
        }
        Ok(())
    }

    /// 删除跳板 profile 时，清除其他配置对它的引用。
    pub async fn clear_jump_refs(&self, jump_id: &str) -> Result<(), String> {
        let mut guard = self.profiles.lock().await;
        let mut changed = false;
        for p in guard.iter_mut() {
            if p.jump_profile_id.as_deref() == Some(jump_id) {
                p.jump_profile_id = None;
                changed = true;
            }
        }
        if changed {
            self.persist(&guard)?;
        }
        Ok(())
    }

    /// 将 profile 转为 SSH 连接参数（从缓存/钥匙串读凭据，解析跳板机）。
    pub async fn to_connect_params(
        &self,
        profile: &ConnectionProfile,
    ) -> Result<SshConnectParams, String> {
        let auth = self.resolve_auth(profile).await?;
        let jump = self.resolve_jump(profile).await?;
        Ok(SshConnectParams {
            host: profile.host.clone(),
            port: profile.port,
            user: profile.user.clone(),
            auth,
            jump,
        })
    }

    /// 启动恢复前预热凭据：按 profile id 列表一次性读入缓存。
    ///
    /// 业务逻辑：工作区恢复会串行 `profile_connect` 多个 Tab；若每个连接各自
    /// 触发钥匙串读取，macOS 会连续弹授权框。这里先收集目标 + 跳板机所需的
    /// 全部凭据键，再逐个读入加密缓存——系统侧通常只需解锁一次。
    pub async fn warm_credentials(&self, profile_ids: &[String]) -> Result<(), String> {
        let mut seen = std::collections::HashSet::new();
        for id in profile_ids {
            if !seen.insert(id.clone()) {
                continue;
            }
            let Some(profile) = self.find(id).await else {
                continue;
            };
            // 目标凭据
            let _ = self.warm_one(&profile).await;
            // 跳板机凭据（若有）
            if let Some(jump_id) = profile.jump_profile_id.as_ref() {
                if !jump_id.is_empty() && seen.insert(jump_id.clone()) {
                    if let Some(jump) = self.find(jump_id).await {
                        let _ = self.warm_one(&jump).await;
                    }
                }
            }
        }
        Ok(())
    }

    /// 预热单个 profile 的密码或 passphrase（忽略缺失，不阻断恢复流程）。
    async fn warm_one(&self, profile: &ConnectionProfile) -> Result<(), String> {
        match profile.auth_method {
            AuthMethod::Password => {
                let _ = self.get_password(&profile.id).await?;
            }
            AuthMethod::PrivateKey => {
                let _ = self.get_passphrase(&profile.id).await?;
            }
        }
        Ok(())
    }

    async fn resolve_auth(&self, profile: &ConnectionProfile) -> Result<SshAuth, String> {
        match profile.auth_method {
            AuthMethod::Password => {
                let pw = self.get_password(&profile.id).await?;
                Ok(SshAuth::Password(pw))
            }
            AuthMethod::PrivateKey => {
                let path = profile
                    .private_key_path
                    .clone()
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| "未配置私钥路径".to_string())?;
                let passphrase = self.get_passphrase(&profile.id).await.ok();
                Ok(SshAuth::PrivateKey { path, passphrase })
            }
        }
    }

    /// 解析跳板机 profile（仅单跳，禁止自引用与嵌套跳板）。
    async fn resolve_jump(
        &self,
        profile: &ConnectionProfile,
    ) -> Result<Option<Box<SshConnectParams>>, String> {
        let jump_id = match profile.jump_profile_id.as_deref() {
            Some(id) if !id.is_empty() => id,
            _ => return Ok(None),
        };
        if jump_id == profile.id {
            return Err("跳板机不能指向自身".to_string());
        }
        let jump_profile = self
            .find(jump_id)
            .await
            .ok_or_else(|| format!("跳板机配置不存在: {jump_id}"))?;
        if jump_profile.jump_profile_id.is_some() {
            return Err("跳板机不支持嵌套，请选择单跳跳板".to_string());
        }
        let auth = self.resolve_auth(&jump_profile).await?;
        Ok(Some(Box::new(SshConnectParams {
            host: jump_profile.host.clone(),
            port: jump_profile.port,
            user: jump_profile.user.clone(),
            auth,
            jump: None,
        })))
    }

    /// 读取某配置的密码（加密缓存 → 钥匙串）。
    pub async fn get_password(&self, id: &str) -> Result<String, String> {
        if let Some(pw) = self.cache.get(id).await {
            return Ok(pw);
        }
        // 钥匙串访问放到 blocking 线程，避免卡住 async runtime；
        // macOS 弹授权框时也不会阻塞其它任务。
        let id_owned = id.to_string();
        let pw = tokio::task::spawn_blocking(move || {
            let entry = keyring::Entry::new(SERVICE, &id_owned).map_err(|e| e.to_string())?;
            entry.get_password().map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        self.cache.put(id, &pw).await;
        Ok(pw)
    }

    /// 读取私钥 passphrase（可选；无则 Ok 空串）。
    pub async fn get_passphrase(&self, id: &str) -> Result<String, String> {
        let key = passphrase_key(id);
        if let Some(pw) = self.cache.get(&key).await {
            return Ok(pw);
        }
        let key_owned = key.clone();
        let pw: Option<String> = tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
            let entry = keyring::Entry::new(SERVICE, &key_owned).map_err(|e| e.to_string())?;
            match entry.get_password() {
                Ok(pw) => Ok(Some(pw)),
                Err(_) => Ok(None),
            }
        })
        .await
        .map_err(|e| e.to_string())??;
        match pw {
            Some(pw) => {
                self.cache.put(&key, &pw).await;
                Ok(pw)
            }
            None => Ok(String::new()),
        }
    }

    /// 写入密码到钥匙串并更新加密缓存。
    async fn set_password_cached(&self, id: &str, password: &str) -> Result<(), String> {
        let id_owned = id.to_string();
        let pw_owned = password.to_string();
        tokio::task::spawn_blocking(move || {
            let entry = keyring::Entry::new(SERVICE, &id_owned).map_err(|e| e.to_string())?;
            entry.set_password(&pw_owned).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        self.cache.put(id, password).await;
        Ok(())
    }

    /// 写入 passphrase 到钥匙串并更新加密缓存。
    async fn set_passphrase_cached(&self, id: &str, passphrase: &str) -> Result<(), String> {
        let key = passphrase_key(id);
        let key_owned = key.clone();
        let pp_owned = passphrase.to_string();
        tokio::task::spawn_blocking(move || {
            let entry = keyring::Entry::new(SERVICE, &key_owned).map_err(|e| e.to_string())?;
            entry.set_password(&pp_owned).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        self.cache.put(&key, passphrase).await;
        Ok(())
    }

    /// 按认证方式写入凭据（钥匙串 + 加密缓存）。
    async fn store_credentials(
        &self,
        id: &str,
        auth_method: AuthMethod,
        password: Option<String>,
        private_key_path: Option<String>,
        passphrase: Option<String>,
    ) -> Result<(), String> {
        match auth_method {
            AuthMethod::Password => {
                let pw = password
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "密码认证需要填写密码".to_string())?;
                self.set_password_cached(id, &pw).await?;
            }
            AuthMethod::PrivateKey => {
                if private_key_path.as_ref().is_none_or(|s| s.is_empty()) {
                    return Err("私钥认证需要选择私钥文件".to_string());
                }
                if let Some(pp) = passphrase.filter(|s| !s.is_empty()) {
                    self.set_passphrase_cached(id, &pp).await?;
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
