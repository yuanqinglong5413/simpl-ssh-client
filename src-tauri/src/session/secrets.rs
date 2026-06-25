//! 内存密码缓存（加密）。
//!
//! 目的：避免反复访问 OS 钥匙串——macOS 上每次读取都可能弹一次系统授权框，
//! 同一连接连点两次就弹两次，体验很差。
//!
//! - 钥匙串里的密码读出后，加密存进本缓存；24h 内重复连接同一配置直接命中缓存，
//!   不再碰钥匙串。
//! - 缓存只存在于进程内存，应用关闭即随进程消失（满足"关闭就清空"）。
//! - 加密 key 由「机器唯一 ID + 应用专属盐」派生（机器绑定，永久不变）；
//!   万一某环境取不到机器 ID，退化为进程随机 key（关闭即失效，安全等价）。
//! - 即使进程内存被 dump 或 swap 到磁盘，缓存的也是密文，不直接暴露明文密码。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

/// 应用专属盐：让派生出的 key 与本机其它应用区分（即使它们也用了同一机器 ID）。
const KEY_SALT: &[u8] = b"simpl-ssh/v1/credential-cache";

/// 缓存条目存活时长：24 小时。
const TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// 一条缓存：nonce + 密文 + 写入时刻。
#[derive(Clone)]
struct Cached {
    nonce: [u8; 12],
    ciphertext: Vec<u8>,
    at: Instant,
}

/// 进程级密码缓存（加密）。构造时算一次 key，之后固定。
pub struct PasswordCache {
    key: [u8; 32],
    store: Mutex<HashMap<String, Cached>>,
}

impl PasswordCache {
    pub fn new() -> Self {
        Self {
            key: derive_key(),
            store: Mutex::new(HashMap::new()),
        }
    }

    /// 命中且未过期 → 返回解密后的明文；否则 None（调用方回落钥匙串）。
    pub async fn get(&self, key: &str) -> Option<String> {
        let entry = self.store.lock().await.get(key).cloned()?;
        if entry.at.elapsed() > TTL {
            return None;
        }
        let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(self.key));
        cipher
            .decrypt(&Nonce::from(entry.nonce), entry.ciphertext.as_ref())
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
    }

    /// 加密一条明文密码并入缓存。
    pub async fn put(&self, key: &str, password: &str) {
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(self.key));
        let ciphertext = match cipher.encrypt(&Nonce::from(nonce), password.as_bytes()) {
            Ok(c) => c,
            Err(_) => return,
        };
        self.store.lock().await.insert(
            key.to_string(),
            Cached {
                nonce,
                ciphertext,
                at: Instant::now(),
            },
        );
    }

    /// 删除一条（配置被删时清理，避免残留密文）。
    pub async fn remove(&self, key: &str) {
        self.store.lock().await.remove(key);
    }
}

impl Default for PasswordCache {
    fn default() -> Self {
        Self::new()
    }
}

/// 机器绑定派生 key：机器 ID（取不到则进程随机）+ 应用盐 → SHA-256 → 32 字节。
fn derive_key() -> [u8; 32] {
    let mut h = Sha256::new();
    match machine_uid::get() {
        Ok(id) => h.update(id.as_bytes()),
        Err(_) => {
            // 取不到机器 ID：用随机 key（进程级，关闭即失效，与"清空"语义一致）
            let mut rand_key = [0u8; 32];
            OsRng.fill_bytes(&mut rand_key);
            h.update(rand_key);
        }
    }
    h.update(KEY_SALT);
    h.finalize().into()
}
