//! 主机公钥校验（known_hosts）。
//!
//! 直接复用用户真实的 `~/.ssh/known_hosts`（与 `ssh` / `mosh` / `tabby` 一致），
//! 底层用 russh 自带的、OpenSSH 兼容的实现：`russh::keys::known_hosts`。
//!
//! 校验三态（[`HostKeyCheck`]）：
//! - [`HostKeyCheck::Trusted`]：已记录且匹配 → 直接放行。
//! - [`HostKeyCheck::Unknown`]：主机未知（首次连接）→ TOFU，需用户在前端确认后落盘。
//! - [`HostKeyCheck::Changed`]：已记录但公钥变更（或记录解析失败）→ 疑似 MITM，
//!   需用户显式确认后替换。
//!
//! 流程是 **probe-and-confirm**：`check_server_key` 探测到非 Trusted 时把公钥暂存进
//! [`HostKeyVerifier`]（**只存内存**），并让握手失败（返回 `Ok(false)` → `UnknownKey`）。
//! 前端弹窗让用户核对指纹；用户确认后调 [`HostKeyVerifier::trust`] 落盘，前端重连即命中。
//! 这样不把「见过的 key」无条件当成可信，也不会在 handler 里 `await` 用户决策。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use russh::keys::{self, PublicKey};
use serde::Serialize;
use tokio::sync::Mutex;

/// 校验三态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyCheck {
    /// 已记录且匹配 → 放行。
    Trusted,
    /// 主机未知（首次连接）→ TOFU。
    Unknown,
    /// 已记录但公钥变更（或记录无法解析）→ 疑似 MITM。
    Changed,
}

impl HostKeyCheck {
    /// 事件用的字符串：trusted | unknown | changed。
    pub fn as_str(&self) -> &'static str {
        match self {
            HostKeyCheck::Trusted => "trusted",
            HostKeyCheck::Unknown => "unknown",
            HostKeyCheck::Changed => "changed",
        }
    }
}

/// 推给前端的主机公钥事件（`ssh://hostkey`）。
#[derive(Clone, Serialize)]
pub struct HostKeyEvent {
    pub connect_id: String,
    /// unknown | changed
    pub kind: String,
    pub host: String,
    pub port: u16,
    /// 如 `ssh-ed25519` / `rsa-sha2-512`。
    pub algorithm: String,
    /// `SHA256:...`。
    pub fingerprint: String,
    /// changed 时为 known_hosts 中冲突的行号（预留，便于后续管理面板）。
    pub line: Option<usize>,
}

/// 校验 `host:port` 的服务器公钥。
///
/// 用 [`russh::keys::known_hosts::known_host_keys`] 拿该主机的全部已记录公钥，
/// 再自行比较：任意一条完全相等 → Trusted；存在同算法但不同 key → Changed；否则 Unknown。
/// 解析失败时保守按 Changed 处理（不静默信任）。
pub fn check(host: &str, port: u16, key: &PublicKey) -> HostKeyCheck {
    let entries = match keys::known_hosts::known_host_keys(host, port) {
        Ok(e) => e,
        // 记录无法解析：保守按「需用户确认」处理，绝不静默放行。
        Err(_) => return HostKeyCheck::Changed,
    };
    if entries.iter().any(|(_, k)| k == key) {
        HostKeyCheck::Trusted
    } else if entries
        .iter()
        .any(|(_, k)| k.algorithm() == key.algorithm())
    {
        HostKeyCheck::Changed
    } else {
        HostKeyCheck::Unknown
    }
}

/// 计算 OpenSSH 风格指纹（`SHA256:base64`）。
pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(russh::keys::HashAlg::Sha256).to_string()
}

/// 缓存「探测到但尚未被用户信任」的公钥。作为 Tauri State 注入，进程内存、不持久化。
#[derive(Clone, Default)]
pub struct HostKeyVerifier {
    pending: Arc<Mutex<HashMap<(String, u16), PublicKey>>>,
}

impl HostKeyVerifier {
    /// 暂存探测到的公钥（仅内存）。同一 host:port 覆盖。
    pub async fn stage(&self, host: String, port: u16, key: PublicKey) {
        self.pending.lock().await.insert((host, port), key);
    }

    /// 用户确认信任：取出暂存的公钥，先剔除与之同算法但不一致的旧记录（变更冲突项），
    /// 再以 OpenSSH 格式追加到 `~/.ssh/known_hosts`。文件 I/O 放进 `spawn_blocking`。
    pub async fn trust(&self, host: &str, port: u16) -> Result<(), String> {
        let key = self
            .pending
            .lock()
            .await
            .remove(&(host.to_string(), port))
            .ok_or_else(|| "没有待确认的主机公钥".to_string())?;
        let host_owned = host.to_string();
        tokio::task::spawn_blocking(move || {
            // 剔除与新公钥同算法但不一致的旧记录（真正的冲突项），保留其它算法的记录。
            remove_conflicting_sync(&host_owned, port, &key)?;
            keys::known_hosts::learn_known_hosts(&host_owned, port, &key).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(())
    }

    /// 用户拒绝：仅清缓存，不动 `known_hosts`。
    pub async fn reject(&self, host: &str, port: u16) {
        self.pending.lock().await.remove(&(host.to_string(), port));
    }

    /// 删除该 host:port 的全部记录（供 `hostkey_remove` 命令 / 后续管理面板）。
    pub async fn remove_host(&self, host: &str, port: u16) -> Result<(), String> {
        let host_owned = host.to_string();
        tokio::task::spawn_blocking(move || remove_all_sync(&host_owned, port))
            .await
            .map_err(|e| e.to_string())?
    }
}

/// 删除与新公钥同算法但不一致的旧记录（行号精确删除，覆盖明文与哈希主机名）。
fn remove_conflicting_sync(host: &str, port: u16, key: &PublicKey) -> Result<(), String> {
    let Some(path) = home_known_hosts_path() else {
        return Ok(());
    };
    if !path.exists() {
        return Ok(());
    }
    let drop_lines = matching_lines(host, port, &path)?
        .into_iter()
        .filter(|(_, k)| k.algorithm() == key.algorithm() && k != key)
        .map(|(l, _)| l)
        .collect::<HashSet<_>>();
    rewrite_without_lines(&path, &drop_lines)
}

/// 删除该 host:port 的全部记录。
fn remove_all_sync(host: &str, port: u16) -> Result<(), String> {
    let Some(path) = home_known_hosts_path() else {
        return Ok(());
    };
    if !path.exists() {
        return Ok(());
    }
    let drop_lines = matching_lines(host, port, &path)?
        .into_iter()
        .map(|(l, _)| l)
        .collect::<HashSet<_>>();
    rewrite_without_lines(&path, &drop_lines)
}

/// 该 host:port 在 `path` 中的全部匹配行（行号从 1 起）。
fn matching_lines(host: &str, port: u16, path: &Path) -> Result<Vec<(usize, PublicKey)>, String> {
    keys::known_hosts::known_host_keys_path(host, port, path).map_err(|e| e.to_string())
}

/// 按 1 起的行号重写文件，剔除 `drop_lines`，保留其余行（含注释/空行）。
fn rewrite_without_lines(path: &Path, drop_lines: &HashSet<usize>) -> Result<(), String> {
    if drop_lines.is_empty() {
        return Ok(());
    }
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let kept: Vec<&str> = content
        .lines()
        .enumerate()
        .filter(|(i, _)| !drop_lines.contains(&(i + 1)))
        .map(|(_, l)| l)
        .collect();
    // 保留尾换行；全部被删则写空文件。
    let out = if kept.is_empty() {
        String::new()
    } else {
        format!("{}\n", kept.join("\n"))
    };
    std::fs::write(path, out).map_err(|e| e.to_string())
}

fn home_known_hosts_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh").join("known_hosts"))
}
