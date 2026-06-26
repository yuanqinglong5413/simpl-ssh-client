//! SSH 连接与会话管理。
//!
//! - `ssh`      一次性 exec（连接 -> 执行 -> 断开），早期 demo 用。
//! - `manager`  会话池，管理持久连接，供终端 / SFTP / 端口转发共享复用（核心）。
//! - `pty`      PTY channel + 本地 WebSocket 终端传输。
//! - `forward`  端口转发（-L/-R/-D）。
//! - `socks`    SOCKS5 握手（-D 用）。

pub mod forward;
pub mod manager;
pub mod profile;
pub mod pty;
pub mod secrets;
pub mod sftp;
pub mod socks;
pub mod ssh;
pub mod transfer;

pub use forward::{ForwardRegistry, PortForwardManager};
pub use manager::{SessionInfo, SessionManager};
pub use profile::ProfileStore;
pub use pty::TerminalBridge;
pub use sftp::SftpManager;
pub use ssh::{connect_and_exec, SshConnectParams};
pub use transfer::TransferQueue;

use std::collections::HashMap;
use std::sync::Arc;

use russh::client;
use russh::keys::ssh_key::PublicKey;
use russh::ChannelMsg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

/// 共享的 russh 客户端 handler。终端、SFTP、一次性 exec、端口转发都复用它。
///
/// ⚠️ 安全提示：`check_server_key` 当前一律返回 `Ok(true)`，即**接受任意主机公钥**，
/// 仅用于本地 demo。正式实现必须在 `~/.ssh/known_hosts` 中校验，否则存在中间人攻击（MITM）风险。
pub(crate) struct ClientHandler {
    /// `-R` 远程转发注册表：服务器在远端端口收到连接时，回调据此把进来的 channel 桥到本地目标。
    pub(crate) forward_registry: ForwardRegistry,
}

impl ClientHandler {
    /// 空 registry（一次性连接 / 不用 -R 的场景）。
    pub(crate) fn new() -> Self {
        Self {
            forward_registry: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for ClientHandler {
    fn default() -> Self {
        Self::new()
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        // TODO: 校验 known_hosts；未知主机时回调前端让用户确认。
        Ok(true)
    }

    /// `-R` 远程转发：服务器在远端端口收到连接时回调。回调查 registry 拿本地目标，
    /// 把进来的 channel 桥到本地 TcpStream。channel 必须在这里 spawn 移交出去，
    /// 否则回调返回时 channel 被 drop、连接被服务器关闭。
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let target = self
            .forward_registry
            .lock()
            .await
            .get(&(connected_address.to_string(), connected_port))
            .cloned();
        if let Some((lhost, lport)) = target {
            tokio::spawn(async move {
                let mut stream = match TcpStream::connect((lhost.as_str(), lport)).await {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let mut channel = channel;
                let mut buf = vec![0u8; 65536];
                let mut stream_closed = false;
                loop {
                    tokio::select! {
                        r = stream.read(&mut buf), if !stream_closed => match r {
                            Ok(0) => { stream_closed = true; let _ = channel.eof().await; }
                            Ok(n) => { if channel.data(&buf[..n]).await.is_err() { break; } }
                            Err(_) => break,
                        },
                        msg = channel.wait() => match msg {
                            Some(ChannelMsg::Data { ref data }) => { let _ = stream.write_all(data).await; }
                            Some(ChannelMsg::Eof) => break,
                            Some(ChannelMsg::WindowAdjusted { .. }) => {}
                            _ => {}
                        }
                    }
                }
            });
        }
        Ok(())
    }
}
