//! 暴露给前端的 Tauri 命令。
//!
//! 前端通过 `invoke("ssh_connect", { ... })` 调用这里标了 `#[tauri::command]` 的函数。

use std::sync::Arc;

use russh::ChannelMsg;
use serde::Serialize;
use tokio::sync::mpsc;

use crate::session::pty::TerminalPipes;
use crate::session::{
    connect_and_exec, SessionInfo, SessionManager, SshConnectParams, TerminalBridge,
};

/// 一次性：连接并执行一条命令，返回 stdout+stderr。（早期 demo）
#[tauri::command]
pub async fn ssh_exec(
    host: String,
    port: u16,
    user: String,
    password: String,
    command: String,
) -> Result<String, String> {
    let params = SshConnectParams {
        host,
        port,
        user,
        password,
    };
    connect_and_exec(&params, &command)
        .await
        .map_err(|e| e.to_string())
}

/// 建立持久会话（连接 + 密码认证），返回会话信息。终端 / SFTP 复用此会话。
#[tauri::command]
pub async fn ssh_connect(
    state: tauri::State<'_, SessionManager>,
    host: String,
    port: u16,
    user: String,
    password: String,
) -> Result<SessionInfo, String> {
    let params = SshConnectParams {
        host,
        port,
        user,
        password,
    };
    state.connect(&params).await.map_err(|e| e.to_string())
}

/// 列出当前所有持久会话。
#[tauri::command]
pub async fn ssh_list_sessions(
    state: tauri::State<'_, SessionManager>,
) -> Result<Vec<SessionInfo>, String> {
    Ok(state.list().await)
}

/// 断开并移除一个会话。
#[tauri::command]
pub async fn ssh_disconnect(
    state: tauri::State<'_, SessionManager>,
    id: String,
) -> Result<(), String> {
    state.disconnect(&id).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct TerminalHandle {
    pub port: u16,
    pub token: String,
}

/// 在指定会话上开一个交互式 PTY 终端，返回本地 WS 端口和一次性 token。
///
/// 前端拿到后连 `ws://127.0.0.1:{port}`，首条消息发 `{token}`，随后双向传输终端数据。
///
/// 注意：channel 的具体类型 `Channel<Msg>` 的 `Msg` 未导出、无法命名，因此必须在这里
/// （类型推断）直接 move 进桥接 task，不能跨函数按类型传递。
#[tauri::command]
pub async fn terminal_open(
    sessions: tauri::State<'_, SessionManager>,
    bridge: tauri::State<'_, Arc<TerminalBridge>>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<TerminalHandle, String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let bridge = bridge.inner().clone();

    // 在该会话的连接上开 PTY channel（尺寸用前端 xterm 实际测得的行列数）。
    let mut channel = {
        let handle = entry.handle.lock().await;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| e.to_string())?;
        channel
            .request_pty(false, "xterm", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| e.to_string())?;
        channel
            .request_shell(true)
            .await
            .map_err(|e| e.to_string())?;
        channel // handle 锁随块结束释放
    };

    // 用 mpsc 管道把 channel 与 WS 解耦（channel 交给下面的 task 独占）。
    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(64);
    let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(64);
    let token = bridge
        .register(TerminalPipes {
            input_tx,
            output_rx,
        })
        .await;
    let port = bridge.port;

    tokio::spawn(async move {
        loop {
            tokio::select! {
                // 前端按键 → channel
                Some(bytes) = input_rx.recv() => {
                    if channel.data_bytes(bytes).await.is_err() { break; }
                }
                // channel 输出 → 前端
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        if output_tx.send(data.as_ref().to_vec()).await.is_err() { break; }
                    }
                    Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        if output_tx.send(data.as_ref().to_vec()).await.is_err() { break; }
                    }
                    Some(ChannelMsg::Eof) | None => break,
                    Some(ChannelMsg::ExitStatus { .. }) => break,
                    _ => {}
                }
            }
        }
        tracing::info!("terminal bridge task ended");
    });

    Ok(TerminalHandle { port, token })
}
