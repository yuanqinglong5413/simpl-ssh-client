//! SSH 连接与会话管理。
//!
//! - `ssh`      一次性 exec（连接 -> 执行 -> 断开），早期 demo 用。
//! - `manager`  会话池，管理持久连接，供终端 / SFTP 共享复用（核心）。
//! - `pty`      PTY channel + 本地 WebSocket 终端传输。

pub mod manager;
pub mod profile;
pub mod pty;
pub mod secrets;
pub mod sftp;
pub mod ssh;
pub mod transfer;

pub use manager::{SessionInfo, SessionManager};
pub use profile::ProfileStore;
pub use pty::TerminalBridge;
pub use sftp::SftpManager;
pub use ssh::{connect_and_exec, SshConnectParams};
pub use transfer::TransferQueue;

use russh::client;
use russh::keys::ssh_key::PublicKey;

/// 共享的 russh 客户端 handler。终端、SFTP、一次性 exec 都复用它。
///
/// ⚠️ 安全提示：`check_server_key` 当前一律返回 `Ok(true)`，即**接受任意主机公钥**，
/// 仅用于本地 demo。正式实现必须在 `~/.ssh/known_hosts` 中校验，否则存在中间人攻击（MITM）风险。
pub(crate) struct ClientHandler;

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        // TODO: 校验 known_hosts；未知主机时回调前端让用户确认。
        Ok(true)
    }
}
