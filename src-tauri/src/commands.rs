//! 暴露给前端的 Tauri 命令。

use std::path::Path;
use std::sync::Arc;

use russh::ChannelMsg;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::session::pty::TerminalPipes;
use crate::session::sftp::{list_dir, FileEntry, SftpManager};
use crate::session::{
    connect_and_exec, SessionInfo, SessionManager, SshConnectParams, TerminalBridge,
};

// ==============================  SSH 会话  =================================

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

/// 断开并移除一个会话（同时清理其 SFTP 缓存）。
#[tauri::command]
pub async fn ssh_disconnect(
    state: tauri::State<'_, SessionManager>,
    sftp: tauri::State<'_, SftpManager>,
    id: String,
) -> Result<(), String> {
    sftp.close(&id).await;
    state.disconnect(&id).await.map_err(|e| e.to_string())
}

// ==============================  终端 (PTY)  ===============================

#[derive(Serialize)]
pub struct TerminalHandle {
    pub port: u16,
    pub token: String,
}

/// 在指定会话上开一个交互式 PTY 终端，返回本地 WS 端口和一次性 token。
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
        channel
    };

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
                Some(bytes) = input_rx.recv() => {
                    if channel.data_bytes(bytes).await.is_err() { break; }
                }
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

// ===============================  SFTP  ====================================

#[derive(Clone, Serialize)]
struct TransferProgress {
    name: String,
    transferred: u64,
    total: u64,
}

/// 列目录。path 为空时用家目录。返回 (规范化绝对路径, 条目列表)。
#[tauri::command]
pub async fn sftp_list(
    sftp_mgr: tauri::State<'_, SftpManager>,
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    path: Option<String>,
) -> Result<(String, Vec<FileEntry>), String> {
    let sftp = sftp_mgr.get(sessions.inner(), &session_id).await?;
    list_dir(&sftp, path.as_deref()).await
}

/// 新建目录。
#[tauri::command]
pub async fn sftp_mkdir(
    sftp_mgr: tauri::State<'_, SftpManager>,
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let sftp = sftp_mgr.get(sessions.inner(), &session_id).await?;
    sftp.create_dir(&path).await.map_err(|e| e.to_string())
}

/// 重命名 / 移动。
#[tauri::command]
pub async fn sftp_rename(
    sftp_mgr: tauri::State<'_, SftpManager>,
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let sftp = sftp_mgr.get(sessions.inner(), &session_id).await?;
    sftp.rename(&from, &to).await.map_err(|e| e.to_string())
}

/// 删除文件或目录。
#[tauri::command]
pub async fn sftp_remove(
    sftp_mgr: tauri::State<'_, SftpManager>,
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let sftp = sftp_mgr.get(sessions.inner(), &session_id).await?;
    let res = if is_dir {
        sftp.remove_dir(&path).await
    } else {
        sftp.remove_file(&path).await
    };
    res.map_err(|e| e.to_string())
}

/// 上传：弹本地文件选择框（可多选），逐个上传到 remote_dir。
#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    sftp_mgr: tauri::State<'_, SftpManager>,
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    remote_dir: String,
) -> Result<(), String> {
    let sftp = sftp_mgr.get(sessions.inner(), &session_id).await?;
    let files = rfd::AsyncFileDialog::new()
        .set_title("选择要上传的文件（可多选）")
        .pick_files()
        .await
        .ok_or_else(|| "未选择文件".to_string())?;
    for f in files {
        let local = f.path().to_path_buf();
        let name = f.file_name();
        let remote = join_remote(&remote_dir, &name);
        upload_recursive(&sftp, &local, &remote, &app).await?;
    }
    Ok(())
}

/// 上传整个文件夹：弹文件夹选择框，递归上传到 remote_dir/<文件夹名>。
#[tauri::command]
pub async fn sftp_upload_dir(
    app: AppHandle,
    sftp_mgr: tauri::State<'_, SftpManager>,
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    remote_dir: String,
) -> Result<(), String> {
    let sftp = sftp_mgr.get(sessions.inner(), &session_id).await?;
    let folder = rfd::AsyncFileDialog::new()
        .set_title("选择要上传的文件夹")
        .pick_folder()
        .await
        .ok_or_else(|| "未选择文件夹".to_string())?;
    let local = folder.path().to_path_buf();
    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "folder".to_string());
    let remote = join_remote(&remote_dir, &name);
    upload_recursive(&sftp, &local, &remote, &app).await?;
    Ok(())
}

/// 下载：把 remote_path（文件或目录）下载到本地（弹保存位置选择框）。
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    sftp_mgr: tauri::State<'_, SftpManager>,
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    remote_path: String,
) -> Result<(), String> {
    let sftp = sftp_mgr.get(sessions.inner(), &session_id).await?;
    let dest = rfd::AsyncFileDialog::new()
        .set_title("选择保存位置（下载到该文件夹下）")
        .pick_folder()
        .await
        .ok_or_else(|| "未选择保存位置".to_string())?;
    let name = remote_path
        .rsplit('/')
        .find(|s| !s.is_empty())
        .unwrap_or("download")
        .to_string();
    let local = dest.path().join(&name);
    download_recursive(&sftp, &remote_path, &local, &app).await?;
    Ok(())
}

// --------------------------- 递归 / 流式辅助 -------------------------------

use russh_sftp::client::SftpSession;

/// 递归上传：本地是目录则建远程目录并下钻；是文件则流式上传。
async fn upload_recursive(
    sftp: &SftpSession,
    local: &Path,
    remote: &str,
    app: &AppHandle,
) -> Result<(), String> {
    if local.is_dir() {
        // 远程目录已存在则忽略错误继续下钻
        let _ = sftp.create_dir(remote).await;
        let mut rd = tokio::fs::read_dir(local)
            .await
            .map_err(|e| e.to_string())?;
        while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
            let name = entry.file_name().to_string_lossy().to_string();
            let rpath = join_remote(remote, &name);
            Box::pin(upload_recursive(sftp, &entry.path(), &rpath, app)).await?;
        }
        return Ok(());
    }

    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let total = std::fs::metadata(local).map_err(|e| e.to_string())?.len();
    let mut local_f = tokio::fs::File::open(local)
        .await
        .map_err(|e| e.to_string())?;
    let mut remote_f = sftp
        .open_with_flags(
            remote,
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| e.to_string())?;
    stream_with_progress(app, &name, total, &mut local_f, &mut remote_f).await?;
    remote_f.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// 递归下载：远程是目录则建本地目录并下钻；是文件则流式下载。跳过符号链接避免环。
async fn download_recursive(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    app: &AppHandle,
) -> Result<(), String> {
    let meta = sftp.metadata(remote).await.map_err(|e| e.to_string())?;
    if meta.is_dir() {
        tokio::fs::create_dir_all(local)
            .await
            .map_err(|e| e.to_string())?;
        let read = sftp.read_dir(remote).await.map_err(|e| e.to_string())?;
        for entry in read {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            if entry.metadata().is_symlink() {
                continue;
            }
            let rpath = join_remote(remote, &name);
            let lpath = local.join(&name);
            Box::pin(download_recursive(sftp, &rpath, &lpath, app)).await?;
        }
        return Ok(());
    }

    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let total = meta.len();
    let mut remote_f = sftp.open(remote).await.map_err(|e| e.to_string())?;
    let mut local_f = tokio::fs::File::create(local)
        .await
        .map_err(|e| e.to_string())?;
    stream_with_progress(app, &name, total, &mut remote_f, &mut local_f).await?;
    local_f.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// 拼接远程路径，避免重复斜杠。
fn join_remote(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        format!("/{name}")
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// 通用流式拷贝 + 进度事件推送（每 64KB 一片）。
async fn stream_with_progress(
    app: &AppHandle,
    name: &str,
    total: u64,
    src: &mut (impl AsyncRead + Unpin),
    dst: &mut (impl AsyncWrite + Unpin),
) -> Result<(), String> {
    let mut buf = vec![0u8; 65536];
    let mut transferred: u64 = 0;
    loop {
        let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        transferred += n as u64;
        let _ = app.emit(
            "sftp://transfer",
            TransferProgress {
                name: name.to_string(),
                transferred,
                total,
            },
        );
    }
    Ok(())
}
