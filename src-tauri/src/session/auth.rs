//! SSH 认证参数与认证逻辑（密码 / 私钥）。

use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::Disconnect;

/// 认证方式：密码或本地私钥文件。
#[derive(Debug, Clone)]
pub enum SshAuth {
    Password(String),
    PrivateKey {
        path: String,
        passphrase: Option<String>,
    },
}

/// 一次 SSH 连接所需参数。
#[derive(Debug, Clone)]
pub struct SshConnectParams {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    /// 跳板机连接参数（单跳 ProxyJump）；建立目标连接前需先连跳板并开 direct-tcpip。
    pub jump: Option<Box<SshConnectParams>>,
}

impl SshConnectParams {
    /// 兼容旧接口：纯密码连接。
    pub fn with_password(host: String, port: u16, user: String, password: String) -> Self {
        Self {
            host,
            port,
            user,
            auth: SshAuth::Password(password),
            jump: None,
        }
    }
}

/// 在已握手的连接上完成身份认证（带超时）。
pub async fn authenticate(
    handle: &mut client::Handle<super::ClientHandler>,
    user: &str,
    auth: &SshAuth,
    ttl: Duration,
) -> anyhow::Result<()> {
    let authed = match auth {
        SshAuth::Password(pw) => {
            tokio::time::timeout(ttl, handle.authenticate_password(user, pw.as_str()))
                .await
                .map_err(|_| anyhow::anyhow!("认证超时（{} 秒）", ttl.as_secs()))?
                .map_err(|e| anyhow::anyhow!("认证出错：{e}"))?
        }
        SshAuth::PrivateKey { path, passphrase } => {
            let key = load_secret_key(path, passphrase.as_deref())
                .map_err(|e| anyhow::anyhow!("无法读取私钥 {path}：{e}"))?;
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|e| anyhow::anyhow!("协商 RSA 哈希算法失败：{e}"))?
                .flatten();
            let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg);
            tokio::time::timeout(ttl, handle.authenticate_publickey(user, key_with_alg))
                .await
                .map_err(|_| anyhow::anyhow!("认证超时（{} 秒）", ttl.as_secs()))?
                .map_err(|e| anyhow::anyhow!("认证出错：{e}"))?
        }
    };

    if !authed.success() {
        let _ = handle
            .disconnect(Disconnect::ByApplication, "auth failed", "en")
            .await;
        anyhow::bail!("认证失败：请检查用户名、密码或私钥");
    }
    Ok(())
}
