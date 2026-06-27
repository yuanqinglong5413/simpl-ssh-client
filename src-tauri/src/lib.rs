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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(session::SessionManager::default())
        .manage(session::SftpManager::default())
        .manage(session::ProfileStore::default())
        .manage(session::GroupStore::default())
        .manage(session::TransferQueue::default())
        .manage(session::PortForwardManager::default())
        .manage(session::HostKeyVerifier::default())
        .manage(session::MonitorStore::default())
        .manage(session::WorkspaceStore::default())
        .manage(session::ProjectStore::default())
        .setup(|app| {
            // 启动本地 WebSocket 服务（终端 PTY 流式传输），端口随机。
            let bridge = tauri::async_runtime::block_on(session::TerminalBridge::start())?;
            app.manage(bridge);
            // 本地 PTY 注册表
            app.manage(std::sync::Arc::new(session::LocalPtyRegistry::default()));
            // 启动 SFTP 传输队列的串行 worker
            app.state::<session::TransferQueue>()
                .start_worker(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ssh_exec,
            commands::ssh_connect,
            commands::ssh_list_sessions,
            commands::ssh_disconnect,
            commands::terminal_open,
            commands::sftp_list,
            commands::sftp_mkdir,
            commands::sftp_rename,
            commands::sftp_remove,
            commands::sftp_read_file,
            commands::sftp_write_file,
            commands::sftp_select_local_files,
            commands::sftp_select_folder,
            commands::transfer_enqueue,
            commands::transfer_cancel,
            commands::transfer_list,
            commands::sync_directory,
            commands::forward_add,
            commands::forward_list,
            commands::forward_remove,
            commands::profile_list,
            commands::profile_save,
            commands::profile_update,
            commands::profile_delete,
            commands::profile_connect,
            commands::profile_select_private_key,
            commands::group_list,
            commands::group_create,
            commands::group_rename,
            commands::group_delete,
            commands::monitor_snapshot,
            commands::hostkey_trust,
            commands::hostkey_reject,
            commands::hostkey_remove,
            commands::workspace_save,
            commands::workspace_load,
            commands::workspace_clear,
            commands::git_status,
            commands::git_log,
            commands::git_diff,
            commands::git_branches,
            commands::git_checkout,
            commands::git_worktree_list,
            commands::git_worktree_add,
            commands::git_worktree_remove,
            // 本地终端
            commands::local_terminal_open,
            // 项目管理
            commands::project_list,
            commands::project_create,
            commands::project_update,
            commands::project_delete,
            // 本地文件
            commands::local_list_dir,
            commands::local_read_file,
            commands::local_write_file,
            // 本地 Git
            commands::local_git_status,
            commands::local_git_log,
            commands::local_git_diff,
            commands::local_git_branches,
            commands::local_git_checkout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
