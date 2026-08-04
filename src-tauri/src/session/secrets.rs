//! 应用加密凭据仓库。
//!
//! 密文保存在 SQLite，AES-256-GCM 密钥由机器标识与随机安装盐通过 HKDF-SHA256
//! 派生。AAD 绑定 profile、凭据类型和 schema，防止数据库记录互换。

use std::sync::Arc;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use sha2_10::Sha256;

use super::storage::AppDatabase;

const VAULT_SCHEMA: u8 = 1;
const KEY_CONTEXT: &[u8] = b"simpl-ssh/credential-vault/aes-256-gcm/v1";

pub struct CredentialVault {
    database: Arc<AppDatabase>,
    key: Option<[u8; 32]>,
    initialization_error: Option<String>,
}

impl CredentialVault {
    pub fn new(database: Arc<AppDatabase>) -> Self {
        let salt = match database.credential_install_salt() {
            Ok(salt) => salt,
            Err(error) => {
                return Self {
                    database,
                    key: None,
                    initialization_error: Some(format!("无法初始化凭据仓库安装盐：{error}")),
                }
            }
        };
        let machine = match machine_uid::get() {
            Ok(machine) => machine,
            Err(error) => {
                return Self {
                    database,
                    key: None,
                    initialization_error: Some(format!("无法读取本机标识：{error}")),
                }
            }
        };
        let hkdf = Hkdf::<Sha256>::new(Some(&salt), machine.as_bytes());
        let mut key = [0u8; 32];
        // 32-byte SHA-256 HKDF output cannot fail for this fixed context and length.
        hkdf.expand(KEY_CONTEXT, &mut key)
            .expect("fixed HKDF output length is valid");
        Self {
            database,
            key: Some(key),
            initialization_error: None,
        }
    }

    pub fn put(&self, profile_id: &str, kind: &str, secret: &str) -> Result<(), String> {
        validate_kind(kind)?;
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(self.key()?));
        let ciphertext = cipher
            .encrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: secret.as_bytes(),
                    aad: &aad(profile_id, kind),
                },
            )
            .map_err(|_| "无法加密凭据".to_string())?;
        self.database
            .credential_write(profile_id, kind, &nonce, &ciphertext)?;
        // 写入后立即读回验证；只有通过验证的记录才视为迁移成功。
        if self.get(profile_id, kind)?.as_deref() != Some(secret) {
            let _ = self.database.credential_delete(profile_id, kind);
            return Err("凭据仓库写入校验失败".into());
        }
        Ok(())
    }

    pub fn get(&self, profile_id: &str, kind: &str) -> Result<Option<String>, String> {
        validate_kind(kind)?;
        let Some(record) = self.database.credential_read(profile_id, kind)? else {
            return Ok(None);
        };
        if record.schema_version != i64::from(VAULT_SCHEMA) || record.nonce.len() != 12 {
            return Err("凭据仓库记录版本或 nonce 无效".into());
        }
        let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(self.key()?));
        let nonce: [u8; 12] = record
            .nonce
            .try_into()
            .map_err(|_| "凭据仓库 nonce 长度无效".to_string())?;
        let plaintext = cipher
            .decrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: &record.ciphertext,
                    aad: &aad(profile_id, kind),
                },
            )
            .map_err(|_| "凭据无法解密；本机标识可能已变化，请重新填写凭据".to_string())?;
        String::from_utf8(plaintext)
            .map(Some)
            .map_err(|_| "凭据内容编码无效".to_string())
    }

    pub fn delete(&self, profile_id: &str, kind: &str) -> Result<(), String> {
        validate_kind(kind)?;
        self.database.credential_delete(profile_id, kind)
    }

    fn key(&self) -> Result<[u8; 32], String> {
        self.key.ok_or_else(|| {
            self.initialization_error
                .clone()
                .unwrap_or_else(|| "凭据仓库尚未初始化".into())
        })
    }
}

fn validate_kind(kind: &str) -> Result<(), String> {
    if matches!(kind, "password" | "passphrase") {
        Ok(())
    } else {
        Err("未知凭据类型".into())
    }
}

fn aad(profile_id: &str, kind: &str) -> Vec<u8> {
    format!("simpl-ssh:vault:{VAULT_SCHEMA}:{profile_id}:{kind}").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_roundtrip_and_aad_binding() {
        let database = Arc::new(AppDatabase::memory());
        database
            .save(
                "profiles",
                &serde_json::json!([
                    { "id": "a", "name": "A", "host": "localhost", "port": 22, "user": "u", "auth_method": "password", "position": 0 },
                    { "id": "b", "name": "B", "host": "localhost", "port": 22, "user": "u", "auth_method": "password", "position": 1 }
                ]),
            )
            .unwrap();
        let vault = CredentialVault::new(database.clone());
        vault.put("a", "password", "你好-secret").unwrap();
        assert_eq!(
            vault.get("a", "password").unwrap().as_deref(),
            Some("你好-secret")
        );
        assert!(vault.get("a", "passphrase").unwrap().is_none());
        let record = database.credential_read("a", "password").unwrap().unwrap();
        database
            .credential_write("b", "password", &record.nonce, &record.ciphertext)
            .unwrap();
        assert!(
            vault.get("b", "password").is_err(),
            "AAD 必须阻止 profile 间互换密文"
        );
        database.save("profiles", &serde_json::json!([])).unwrap();
        assert!(
            database.credential_read("a", "password").unwrap().is_none(),
            "删除 profile 必须级联删除密文"
        );
    }
}
