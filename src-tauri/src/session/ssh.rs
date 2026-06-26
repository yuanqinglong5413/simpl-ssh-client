//! 一次性 exec demo：连接 -> 认证 -> 执行单条命令 -> 断开。
//!
//! 早期的"打通链路"验收点。需要持久会话（终端/SFTP 复用连接）请用 `super::manager`。

use std::sync::Arc;

use russh::client;
use russh::{ChannelMsg, Disconnect};

pub use super::auth::{authenticate, SshAuth, SshConnectParams};
use super::ClientHandler;

/// 连接到 `params` 指定的主机，认证后执行 `command`，返回合并后的 stdout+stderr。
pub async fn connect_and_exec(params: &SshConnectParams, command: &str) -> anyhow::Result<String> {
    let SshAuth::Password(ref password) = params.auth else {
        anyhow::bail!("connect_and_exec 仅支持密码认证");
    };
    let demo_params = SshConnectParams::with_password(
        params.host.clone(),
        params.port,
        params.user.clone(),
        password.clone(),
    );

    let config = Arc::new(client::Config::default());

    let mut handle = client::connect(
        config,
        (demo_params.host.as_str(), demo_params.port),
        ClientHandler::for_exec(demo_params.host.clone(), demo_params.port),
    )
    .await?;

    authenticate(
        &mut handle,
        demo_params.user.as_str(),
        &demo_params.auth,
        std::time::Duration::from_secs(12),
    )
    .await?;

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
