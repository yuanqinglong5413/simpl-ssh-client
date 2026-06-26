//! SSH 连接与会话管理。
//!
//! - `ssh`      一次性 exec（连接 -> 执行 -> 断开），早期 demo 用。
//! - `manager`  会话池，管理持久连接，供终端 / SFTP / 端口转发共享复用（核心）。
//! - `pty`      PTY channel + 本地 WebSocket 终端传输。
//! - `forward`  端口转发（-L/-R/-D）。
//! - `socks`    SOCKS5 握手（-D 用）。

pub mod auth;
pub mod forward;
pub mod known_hosts;
pub mod manager;
pub mod profile;
pub mod pty;
pub mod secrets;
pub mod sftp;
pub mod socks;
pub mod ssh;
pub mod transfer;

pub use auth::{SshAuth, SshConnectParams};
pub use forward::{ForwardRegistry, PortForwardManager};
pub use known_hosts::{HostKeyCheck, HostKeyEvent, HostKeyVerifier};
pub use manager::{SessionInfo, SessionManager};
pub use profile::AuthMethod;
pub use profile::ProfileStore;
pub use pty::TerminalBridge;
pub use sftp::SftpManager;
pub use ssh::connect_and_exec;
pub use transfer::TransferQueue;

use std::collections::HashMap;
use std::sync::Arc;

use russh::client;
use russh::keys::ssh_key::PublicKey;
use russh::ChannelMsg;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

/// 共享的 russh 客户端 handler。终端、SFTP、一次性 exec、端口转发都复用它。
///
/// `check_server_key` 在 `~/.ssh/known_hosts` 中校验服务器公钥（复用 russh 的 OpenSSH 兼容实现）：
/// - 已记录且匹配 → 放行；
/// - 未知（首次连接）或已变更（疑似 MITM）→ 把公钥暂存进 [`HostKeyVerifier`] 并推 `ssh://hostkey`
///   事件让前端确认，同时返回 `Ok(false)` 让握手中止（russh 返回 `UnknownKey`）。
///   用户在前端确认后调 `hostkey_trust` 落盘，再重连即命中。详见 [`known_hosts`]。
pub(crate) struct ClientHandler {
    /// `-R` 远程转发注册表：服务器在远端端口收到连接时，回调据此把进来的 channel 桥到本地目标。
    pub(crate) forward_registry: ForwardRegistry,
    /// known_hosts 校验用的主机 / 端口。
    host: String,
    port: u16,
    /// `None` = 非交互（一次性 exec demo）：未知主机静默 TOFU、公钥变更则拒绝。
    /// `Some` = 交互式（持久会话）：未知 / 变更都暂存公钥并推前端确认。
    verify: Option<VerifyCtx>,
}

/// 交互式校验上下文（持久会话用）。
pub(crate) struct VerifyCtx {
    app: AppHandle,
    connect_id: String,
    verifier: HostKeyVerifier,
}

impl ClientHandler {
    /// 一次性 exec demo 用：非交互，无前端确认通道（未知静默 TOFU、变更拒绝）。
    pub(crate) fn for_exec(host: String, port: u16) -> Self {
        Self {
            forward_registry: Arc::new(Mutex::new(HashMap::new())),
            host,
            port,
            verify: None,
        }
    }

    /// 持久会话用：交互式校验，未知 / 变更推前端确认。
    pub(crate) fn for_session(
        host: String,
        port: u16,
        app: AppHandle,
        connect_id: String,
        verifier: HostKeyVerifier,
        forward_registry: ForwardRegistry,
    ) -> Self {
        Self {
            forward_registry,
            host,
            port,
            verify: Some(VerifyCtx {
                app,
                connect_id,
                verifier,
            }),
        }
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let algorithm = key.algorithm().to_string();
        let fingerprint = known_hosts::fingerprint(key);
        match known_hosts::check(&self.host, self.port, key) {
            HostKeyCheck::Trusted => Ok(true),
            kind => match &self.verify {
                // 非交互（demo）：未知 → 静默 TOFU 落盘；变更 → 拒绝。
                None => {
                    if matches!(kind, HostKeyCheck::Unknown) {
                        let host = self.host.clone();
                        let port = self.port;
                        let key = key.clone();
                        let _ = tokio::task::spawn_blocking(move || {
                            russh::keys::known_hosts::learn_known_hosts(&host, port, &key)
                        })
                        .await;
                        Ok(true)
                    } else {
                        Ok(false)
                    }
                }
                // 交互式：暂存公钥 + 推事件，握手中止，等前端确认后重连。
                Some(vx) => {
                    vx.verifier
                        .stage(self.host.clone(), self.port, key.clone())
                        .await;
                    let _ = vx.app.emit(
                        "ssh://hostkey",
                        HostKeyEvent {
                            connect_id: vx.connect_id.clone(),
                            kind: kind.as_str().to_string(),
                            host: self.host.clone(),
                            port: self.port,
                            algorithm,
                            fingerprint,
                            line: None,
                        },
                    );
                    Ok(false)
                }
            },
        }
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
