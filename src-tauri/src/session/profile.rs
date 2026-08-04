//! 保存的连接配置。
//!
//! 元数据（名称/主机/端口/用户/认证方式/私钥路径）存本地 SQLite；
//! 密码与私钥 passphrase 存 OS 钥匙串（keyring），**不落明文**。
//!
//! 钥匙串里的密码读出后会进入一个**内存加密缓存**（见 [`super::secrets`]），
//! 24h 内重复连接同一配置直接命中缓存，不再访问钥匙串——避免 macOS 上
//! 每次读取都弹系统授权框。缓存随进程退出而清空。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::auth::{SshAuth, SshConnectParams};
use super::secrets::PasswordCache;
use super::storage::AppDatabase;

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
    pub encoding: Option<String>,
    pub keepalive_interval: Option<u64>,
    pub startup_command: Option<String>,
    /// 用户标注的运行环境，只用于界面风险提示，不参与 SSH 协议。
    pub environment: Option<String>,
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
    /// 同一分组内的稳定顺序；旧配置由加载阶段按数组顺序补齐。
    #[serde(default)]
    pub position: i32,
    /// 跳板机：引用另一个已保存连接的 id（单跳 ProxyJump）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_profile_id: Option<String>,
    /// 远程终端编码（如 "gbk"/"gb2312"）；None/utf-8 表示直通。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
    /// SSH keepalive 心跳间隔（秒）；None 表示用全局默认。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keepalive_interval: Option<u64>,
    /// 连接就绪后注入的启动命令（等价用户敲入）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_command: Option<String>,
    /// 生产 / 预发 / 测试 / 本地；旧配置缺省为未标记。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
}

/// 连接配置存储。作为 Tauri State 注入。
pub struct ProfileStore {
    profiles: Mutex<Vec<ConnectionProfile>>,
    database: Arc<AppDatabase>,
    cache: PasswordCache,
}

impl ProfileStore {
    /// 从 SQLite 加载（首次启动会兼容导入旧 JSON）。
    pub fn new(database: Arc<AppDatabase>) -> Self {
        let mut profiles: Vec<ConnectionProfile> =
            database.load("profiles").ok().flatten().unwrap_or_default();
        normalize_positions(&mut profiles);
        Self {
            profiles: Mutex::new(profiles),
            database,
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

    /// 保存一个新配置：凭据进钥匙串，元数据进 SQLite 事务。
    pub async fn save(&self, input: ProfileInput) -> Result<ConnectionProfile, String> {
        let id = Uuid::new_v4().to_string();
        self.store_credentials(
            &id,
            input.auth_method.clone(),
            input.password,
            input.private_key_path.clone(),
            input.passphrase,
        )?;

        let mut guard = self.profiles.lock().await;
        let position = next_position(&guard, input.group_id.as_deref());
        let profile = ConnectionProfile {
            id,
            name: input.name,
            host: input.host,
            port: input.port,
            user: input.user,
            auth_method: input.auth_method,
            private_key_path: input.private_key_path,
            group_id: input.group_id,
            position,
            jump_profile_id: input.jump_profile_id,
            encoding: input.encoding,
            keepalive_interval: input.keepalive_interval,
            startup_command: input.startup_command,
            environment: input.environment,
        };
        let mut next = guard.clone();
        next.push(profile.clone());
        self.persist(&next)?;
        *guard = next;
        Ok(profile)
    }

    /// 批量导入配置（配置导入用）；凭据（密码/passphrase）不在此处设置，
    /// 导入的私钥认证 profile 需用户后续补充 passphrase。
    pub async fn import_many(&self, inputs: Vec<ProfileInput>) -> Result<usize, String> {
        let mut guard = self.profiles.lock().await;
        let ids = inputs
            .iter()
            .map(|input| (input.name.clone(), Uuid::new_v4().to_string()))
            .collect::<std::collections::HashMap<_, _>>();
        let mut count = 0;
        for input in inputs {
            let id = ids
                .get(&input.name)
                .cloned()
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let jump_profile_id =
                input
                    .jump_profile_id
                    .and_then(|value| match value.strip_prefix("ssh-config:") {
                        Some(alias) => ids.get(alias).cloned(),
                        None => Some(value),
                    });
            let position = next_position(&guard, input.group_id.as_deref());
            guard.push(ConnectionProfile {
                id,
                name: input.name,
                host: input.host,
                port: input.port,
                user: input.user,
                auth_method: input.auth_method,
                private_key_path: input.private_key_path,
                group_id: input.group_id,
                position,
                jump_profile_id,
                encoding: input.encoding,
                keepalive_interval: input.keepalive_interval,
                startup_command: input.startup_command,
                environment: input.environment,
            });
            count += 1;
        }
        if count > 0 {
            self.persist(&guard)?;
        }
        Ok(count)
    }

    /// 更新已有配置；密码 / passphrase 传空则保留钥匙串中的旧值。
    pub async fn update(&self, id: &str, input: ProfileInput) -> Result<ConnectionProfile, String> {
        let mut guard = self.profiles.lock().await;
        let idx = guard
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| format!("profile not found: {id}"))?;

        let prev_method = guard[idx].auth_method.clone();
        if prev_method != input.auth_method {
            let _ = self.clear_credentials(id, &prev_method);
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

        if input.jump_profile_id.as_deref() == Some(id) {
            return Err("跳板机不能指向自身".to_string());
        }

        let old_group = guard[idx].group_id.clone();
        let position = if old_group == input.group_id {
            guard[idx].position
        } else {
            next_position(&guard, input.group_id.as_deref())
        };
        let mut next = guard.clone();
        next[idx] = ConnectionProfile {
            id: id.to_string(),
            name: input.name,
            host: input.host,
            port: input.port,
            user: input.user,
            auth_method: input.auth_method,
            private_key_path: input.private_key_path,
            group_id: input.group_id,
            position,
            jump_profile_id: input.jump_profile_id,
            encoding: input.encoding,
            keepalive_interval: input.keepalive_interval,
            startup_command: input.startup_command,
            environment: input.environment,
        };
        normalize_positions(&mut next);
        let updated = next[idx].clone();
        self.persist(&next)?;
        *guard = next;
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
            let kind = if method == AuthMethod::Password {
                "password"
            } else {
                "passphrase"
            };
            self.database.enqueue_secret_cleanup(id, kind)?;
            if self.clear_credentials(id, &method).is_ok() {
                self.database.complete_secret_cleanup(id, kind)?;
            }
        }
        self.cache.remove(id).await;
        self.cache.remove(&passphrase_key(id)).await;
        Ok(())
    }

    pub async fn count_in_groups(&self, group_ids: &[String]) -> usize {
        self.profiles
            .lock()
            .await
            .iter()
            .filter(|profile| {
                profile
                    .group_id
                    .as_ref()
                    .is_some_and(|id| group_ids.contains(id))
            })
            .count()
    }

    pub async fn delete_in_groups(&self, group_ids: &[String]) -> Result<usize, String> {
        let removed = {
            let mut guard = self.profiles.lock().await;
            let removed = guard
                .iter()
                .filter(|profile| {
                    profile
                        .group_id
                        .as_ref()
                        .is_some_and(|id| group_ids.contains(id))
                })
                .map(|profile| (profile.id.clone(), profile.auth_method.clone()))
                .collect::<Vec<_>>();
            guard.retain(|profile| {
                !profile
                    .group_id
                    .as_ref()
                    .is_some_and(|id| group_ids.contains(id))
            });
            if !removed.is_empty() {
                self.persist(&guard)?;
            }
            removed
        };
        for (id, method) in &removed {
            let kind = if *method == AuthMethod::Password {
                "password"
            } else {
                "passphrase"
            };
            self.database.enqueue_secret_cleanup(id, kind)?;
            if self.clear_credentials(id, method).is_ok() {
                self.database.complete_secret_cleanup(id, kind)?;
            }
            self.cache.remove(id).await;
            self.cache.remove(&passphrase_key(id)).await;
        }
        Ok(removed.len())
    }

    /// 重试之前因钥匙串锁定或系统错误而未完成的凭据清理。
    /// 应用记录已经删除，因此失败只保留在持久化队列中，不会把连接记录“复活”。
    pub fn retry_secret_cleanup(&self) -> Result<usize, String> {
        let pending = self.database.pending_secret_cleanup()?;
        let mut remaining = 0;
        for item in pending {
            let method = match item.credential_kind.as_str() {
                "password" => AuthMethod::Password,
                "passphrase" => AuthMethod::PrivateKey,
                other => {
                    self.database.fail_secret_cleanup(
                        &item.profile_id,
                        &item.credential_kind,
                        &format!("未知凭据类型：{other}"),
                    )?;
                    remaining += 1;
                    continue;
                }
            };
            match self.clear_credentials(&item.profile_id, &method) {
                Ok(()) => self
                    .database
                    .complete_secret_cleanup(&item.profile_id, &item.credential_kind)?,
                Err(error) => {
                    self.database.fail_secret_cleanup(
                        &item.profile_id,
                        &item.credential_kind,
                        &error,
                    )?;
                    remaining += 1;
                }
            }
        }
        Ok(remaining)
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

    pub async fn move_to_group(&self, id: &str, group_id: Option<String>) -> Result<(), String> {
        self.move_to_position(id, group_id, i32::MAX)
            .await
            .map(|_| ())
    }

    pub async fn move_to_position(
        &self,
        id: &str,
        group_id: Option<String>,
        position: i32,
    ) -> Result<ConnectionProfile, String> {
        let mut guard = self.profiles.lock().await;
        let index = guard
            .iter()
            .position(|item| item.id == id)
            .ok_or("连接配置不存在")?;
        let mut next = guard.clone();
        next[index].group_id = group_id.clone();
        let mut siblings = next
            .iter()
            .enumerate()
            .filter(|(candidate, item)| *candidate != index && item.group_id == group_id)
            .map(|(candidate, item)| (candidate, item.position))
            .collect::<Vec<_>>();
        siblings.sort_by_key(|(_, order)| *order);
        let insert_at = usize::try_from(position.max(0))
            .unwrap_or(usize::MAX)
            .min(siblings.len());
        siblings.insert(insert_at, (index, 0));
        for (order, (candidate, _)) in siblings.into_iter().enumerate() {
            next[candidate].position = order as i32;
        }
        normalize_positions(&mut next);
        let result = next[index].clone();
        self.persist(&next)?;
        *guard = next;
        Ok(result)
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

    /// 将 profile 转为 SSH 连接参数（从钥匙串读凭据，解析跳板机）。
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
            encoding: profile.encoding.clone(),
            keepalive_interval: profile.keepalive_interval,
            startup_command: profile.startup_command.clone(),
        })
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
            encoding: None,
            keepalive_interval: None,
            startup_command: None,
        })))
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
                let pw = password
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "密码认证需要填写密码".to_string())?;
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

    fn clear_credentials(&self, id: &str, auth_method: &AuthMethod) -> Result<(), String> {
        let result = match auth_method {
            AuthMethod::Password => {
                let entry = keyring::Entry::new(SERVICE, id).map_err(|error| error.to_string())?;
                entry.delete_credential()
            }
            AuthMethod::PrivateKey => {
                let entry = keyring::Entry::new(SERVICE, &passphrase_key(id))
                    .map_err(|error| error.to_string())?;
                entry.delete_credential()
            }
        };
        match result {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    fn persist(&self, profiles: &[ConnectionProfile]) -> Result<(), String> {
        self.database.save("profiles", profiles)
    }
}

fn next_position(profiles: &[ConnectionProfile], group_id: Option<&str>) -> i32 {
    profiles
        .iter()
        .filter(|item| item.group_id.as_deref() == group_id)
        .map(|item| item.position)
        .max()
        .unwrap_or(-1)
        .saturating_add(1)
}

fn normalize_positions(profiles: &mut [ConnectionProfile]) {
    let groups = profiles
        .iter()
        .map(|item| item.group_id.clone())
        .collect::<std::collections::HashSet<_>>();
    for group_id in groups {
        let mut siblings = profiles
            .iter()
            .enumerate()
            .filter(|(_, item)| item.group_id == group_id)
            .map(|(index, item)| (index, item.position))
            .collect::<Vec<_>>();
        siblings.sort_by_key(|(index, position)| (*position, *index));
        for (position, (index, _)) in siblings.into_iter().enumerate() {
            profiles[index].position = position as i32;
        }
    }
}

impl Default for ProfileStore {
    fn default() -> Self {
        Self::new(Arc::new(AppDatabase::default()))
    }
}

fn passphrase_key(id: &str) -> String {
    format!("{id}:passphrase")
}
