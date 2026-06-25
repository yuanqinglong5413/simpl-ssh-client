//! simpl-ssh-client 后端入口。
//!
//! 架构分层：
//! - `commands`   暴露给前端的 Tauri 命令（薄封装）
//! - `session`    SSH 连接 / 会话管理（russh）+ PTY/WS 终端传输
//! - `sftp`       文件传输（russh-sftp，复用 session 连接）— 待实现
//! - `profile`    连接配置 + 凭据加密存储 — 待实现

mod commands;
mod session;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(session::SessionManager::default())
        .setup(|app| {
            // 启动本地 WebSocket 服务（终端 PTY 流式传输），端口随机。
            let bridge = tauri::async_runtime::block_on(session::TerminalBridge::start())?;
            app.manage(bridge);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ssh_exec,
            commands::ssh_connect,
            commands::ssh_list_sessions,
            commands::ssh_disconnect,
            commands::terminal_open,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
