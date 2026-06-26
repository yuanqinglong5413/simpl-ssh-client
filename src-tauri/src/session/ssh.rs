//! 一次性 exec demo：连接 -> 密码认证 -> 执行单条命令 -> 断开。
//!
//! 早期的"打通链路"验收点。需要持久会话（终端/SFTP 复用连接）请用 `super::manager`。

use std::sync::Arc;

use russh::client;
use russh::{ChannelMsg, Disconnect};

use super::ClientHandler;

/// 一次 SSH 连接所需的最少参数。
pub struct SshConnectParams {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
}

/// 连接到 `params` 指定的主机，密码认证后执行 `command`，返回合并后的 stdout+stderr。
pub async fn connect_and_exec(params: &SshConnectParams, command: &str) -> anyhow::Result<String> {
    let config = Arc::new(client::Config::default());

    let mut handle = client::connect(
        config,
        (params.host.as_str(), params.port),
        ClientHandler::for_exec(params.host.clone(), params.port),
    )
    .await?;

    let authed = handle
        .authenticate_password(params.user.as_str(), params.password.as_str())
        .await?;
    if !authed.success() {
        let _ = handle
            .disconnect(Disconnect::ByApplication, "auth failed", "en")
            .await;
        anyhow::bail!("authentication failed for '{}': {:?}", params.user, authed);
    }

    let mut channel = handle.channel_open_session().await?;
    channel.exec(true, command).await?;

    let mut output: Vec<u8> = Vec::new();
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => output.extend_from_slice(data.as_ref()),
            ChannelMsg::ExtendedData { ref data, .. } => output.extend_from_slice(data.as_ref()),
            ChannelMsg::ExitStatus { exit_status } => {
                tracing::debug!(exit_status, "remote command exited");
                break;
            }
            _ => {}
        }
    }

    let _ = channel.close().await;
    let _ = handle
        .disconnect(Disconnect::ByApplication, "bye", "en")
        .await;

    Ok(String::from_utf8_lossy(&output).into_owned())
}
