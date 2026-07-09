//! 凭据缓存（内存 + 磁盘，AES-256-GCM 加密）。
//!
//! 目的：避免反复访问 OS 钥匙串——macOS 上每次读取都可能弹一次系统授权框，
//! 启动恢复多个 Tab / 跳板机时会连续弹多次，体验很差。
//!
//! - 钥匙串密码读出后，加密写入本缓存；24h 内重复连接直接命中，不再碰钥匙串。
//! - 缓存同时落盘到配置目录（密文），进程重启后仍可命中，避免「每次打开都要输电脑密码」。
//! - 加密 key 由「机器唯一 ID + 应用专属盐」派生（机器绑定）；
//!   取不到机器 ID 时退化为进程随机 key（仅内存，关闭即失效）。
//! - 即使磁盘文件被拷走，没有本机派生 key 也无法解密。

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

/// 应用专属盐：让派生出的 key 与本机其它应用区分。
const KEY_SALT: &[u8] = b"simpl-ssh/v1/credential-cache";

/// 磁盘缓存文件魔数 / 版本，便于以后迁移。
const CACHE_VERSION: u32 = 1;

/// 缓存条目存活时长：24 小时（墙钟时间，跨进程重启仍有效）。
const TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// 一条缓存：nonce + 密文 + 写入时刻（unix 秒）。
#[derive(Clone, Serialize, Deserialize)]
struct Cached {
    nonce: [u8; 12],
    ciphertext: Vec<u8>,
    at_epoch_secs: u64,
}

#[derive(Serialize, Deserialize)]
struct DiskCacheFile {
    version: u32,
    entries: HashMap<String, Cached>,
}

/// 进程级密码缓存（加密 + 可选落盘）。
pub struct PasswordCache {
    key: [u8; 32],
    /// 机器 ID 可用时才落盘；随机 key 模式不写磁盘，避免重启后无法解密的垃圾文件。
    persist: bool,
    path: PathBuf,
    store: Mutex<HashMap<String, Cached>>,
}

impl PasswordCache {
    pub fn new() -> Self {
        let (key, persist) = derive_key();
        let path = cache_path();
        let store = if persist {
            load_disk(&path, &key)
        } else {
            HashMap::new()
        };
        Self {
            key,
            persist,
            path,
            store: Mutex::new(store),
        }
    }

    /// 命中且未过期 → 返回解密后的明文；否则 None（调用方回落钥匙串）。
    pub async fn get(&self, key: &str) -> Option<String> {
        let mut guard = self.store.lock().await;
        let entry = guard.get(key)?.clone();
        if is_expired(&entry) {
            guard.remove(key);
            drop(guard);
            self.persist_unlocked().await;
            return None;
        }
        let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(self.key));
        cipher
            .decrypt(&Nonce::from(entry.nonce), entry.ciphertext.as_ref())
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
    }

    /// 加密一条明文密码并入缓存，并异步落盘。
    pub async fn put(&self, key: &str, password: &str) {
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(self.key));
        let ciphertext = match cipher.encrypt(&Nonce::from(nonce), password.as_bytes()) {
            Ok(c) => c,
            Err(_) => return,
        };
        {
            let mut guard = self.store.lock().await;
            guard.insert(
                key.to_string(),
                Cached {
                    nonce,
                    ciphertext,
                    at_epoch_secs: now_epoch_secs(),
                },
            );
        }
        self.persist_unlocked().await;
    }

    /// 删除一条（配置被删时清理，避免残留密文）。
    pub async fn remove(&self, key: &str) {
        {
            let mut guard = self.store.lock().await;
            guard.remove(key);
        }
        self.persist_unlocked().await;
    }

    /// 将当前内存表写入磁盘（已持有或不需要锁外一致性时调用）。
    async fn persist_unlocked(&self) {
        if !self.persist {
            return;
        }
        let snapshot = {
            let guard = self.store.lock().await;
            // 落盘前剔除过期项
            let mut entries = HashMap::new();
            for (k, v) in guard.iter() {
                if !is_expired(v) {
                    entries.insert(k.clone(), v.clone());
                }
            }
            DiskCacheFile {
                version: CACHE_VERSION,
                entries,
            }
        };
        let path = self.path.clone();
        let _ = tokio::task::spawn_blocking(move || write_disk(&path, &snapshot)).await;
    }
}

impl Default for PasswordCache {
    fn default() -> Self {
        Self::new()
    }
}

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn is_expired(entry: &Cached) -> bool {
    let now = now_epoch_secs();
    now.saturating_sub(entry.at_epoch_secs) > TTL.as_secs()
}

/// 机器绑定派生 key：机器 ID（取不到则进程随机）+ 应用盐 → SHA-256 → 32 字节。
/// 返回 (key, 是否可持久化)。
fn derive_key() -> ([u8; 32], bool) {
    let mut h = Sha256::new();
    match machine_uid::get() {
        Ok(id) => {
            h.update(id.as_bytes());
            h.update(KEY_SALT);
            (h.finalize().into(), true)
        }
        Err(_) => {
            // 取不到机器 ID：用随机 key（进程级，关闭即失效，与"清空"语义一致）
            let mut rand_key = [0u8; 32];
            OsRng.fill_bytes(&mut rand_key);
            h.update(rand_key);
            h.update(KEY_SALT);
            (h.finalize().into(), false)
        }
    }
}

fn cache_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("simpl-ssh").join("credential-cache.json")
}

fn load_disk(path: &PathBuf, key: &[u8; 32]) -> HashMap<String, Cached> {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return HashMap::new(),
    };
    let file: DiskCacheFile = match serde_json::from_str(&raw) {
        Ok(f) => f,
        Err(_) => return HashMap::new(),
    };
    if file.version != CACHE_VERSION {
        return HashMap::new();
    }
    // 校验能否解密至少一条；全部过期则清空
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
    let mut out = HashMap::new();
    for (k, v) in file.entries {
        if is_expired(&v) {
            continue;
        }
        // 密钥不匹配时 decrypt 失败，跳过该条
        if cipher
            .decrypt(&Nonce::from(v.nonce), v.ciphertext.as_ref())
            .is_ok()
        {
            out.insert(k, v);
        }
    }
    out
}

fn write_disk(path: &PathBuf, file: &DiskCacheFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string(file).map_err(|e| e.to_string())?;
    // 先写临时文件再 rename，避免半截写入
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, s).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}
