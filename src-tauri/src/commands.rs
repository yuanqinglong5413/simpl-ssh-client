//! 暴露给前端的 Tauri 命令。

use std::sync::Arc;

use russh::ChannelMsg;
use serde::Serialize;
use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::session::forward::{ForwardKind, PortForwardManager};
use crate::session::groups::GroupStore;
use crate::session::profile::{ProfileInput, ProfileStore};
use crate::session::pty::TerminalPipes;
use crate::session::sftp::{list_dir, FileEntry, SftpManager};
use crate::session::transfer::{TransferKind, TransferQueue};
use crate::session::{
    connect_and_exec, AuthMethod, HostKeyVerifier, MonitorSnapshot, MonitorStore, SessionInfo,
    SessionManager, SshAuth, SshConnectParams, TerminalBridge,
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
    let params = SshConnectParams::with_password(host, port, user, password);
    connect_and_exec(&params, &command)
        .await
        .map_err(|e| e.to_string())
}

/// 建立持久会话（连接 + 认证），返回会话信息。终端 / SFTP 复用此会话。
/// `connect_id` 用于关联 `ssh://progress` 阶段事件，前端据此展示连接进度。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_connect(
    state: tauri::State<'_, SessionManager>,
    profiles: tauri::State<'_, ProfileStore>,
    verifier: tauri::State<'_, HostKeyVerifier>,
    app: AppHandle,
    connect_id: String,
    host: String,
    port: u16,
    user: String,
    auth_method: String,
    password: Option<String>,
    private_key_path: Option<String>,
    passphrase: Option<String>,
    jump_profile_id: Option<String>,
) -> Result<SessionInfo, String> {
    let auth = build_auth(&auth_method, password, private_key_path, passphrase)?;
    let jump = resolve_jump_profile(&profiles, jump_profile_id.as_deref(), None).await?;
    let params = SshConnectParams {
        host,
        port,
        user,
        auth,
        jump,
    };
    state
        .connect(&params, &app, &connect_id, verifier.inner())
        .await
        .map_err(|e| e.to_string())
}

/// 列出当前所有持久会话。
#[tauri::command]
pub async fn ssh_list_sessions(
    state: tauri::State<'_, SessionManager>,
) -> Result<Vec<SessionInfo>, String> {
    Ok(state.list().await)
}

/// 断开并移除一个会话（同时停止其端口转发、清理 SFTP 缓存）。
#[tauri::command]
pub async fn ssh_disconnect(
    state: tauri::State<'_, SessionManager>,
    sftp: tauri::State<'_, SftpManager>,
    forwards: tauri::State<'_, PortForwardManager>,
    monitor: tauri::State<'_, MonitorStore>,
    id: String,
) -> Result<(), String> {
    forwards.close_session(&id).await;
    sftp.close(&id).await;
    monitor.clear_session(&id).await;
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
    enable_x11: Option<bool>,
) -> Result<TerminalHandle, String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let bridge = bridge.inner().clone();

    let mut channel = {
        let channel = entry
            .handle
            .channel_open_session()
            .await
            .map_err(|e| e.to_string())?;
        if enable_x11.unwrap_or(false) {
            let display = crate::session::x11::local_display()
                .ok_or_else(|| "本机未检测到 DISPLAY 环境变量，无法启用 X11 转发".to_string())?;
            *entry.x11_display.lock().await = Some(display);
            let cookie = crate::session::x11::random_x11_cookie();
            channel
                .request_x11(true, false, "MIT-MAGIC-COOKIE-1", cookie, 0)
                .await
                .map_err(|e| format!("X11 转发请求失败：{e}"))?;
        }
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
    let (resize_tx, mut resize_rx) = mpsc::channel::<(u32, u32)>(8);
    let token = bridge
        .register(TerminalPipes {
            input_tx,
            output_rx,
            resize_tx,
        })
        .await;
    let port = bridge.port;

    tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(bytes) = input_rx.recv() => {
                    if channel.data_bytes(bytes).await.is_err() { break; }
                }
                Some((cols, rows)) = resize_rx.recv() => {
                    if channel.window_change(cols, rows, 0, 0).await.is_err() { break; }
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

// ----------------------------  选框（不传输）-------------------------------

/// 弹本地文件选择框（可多选），返回所选文件的绝对路径列表。不执行传输。
#[tauri::command]
pub async fn sftp_select_local_files() -> Result<Vec<String>, String> {
    let files = rfd::AsyncFileDialog::new()
        .set_title("选择要上传的文件（可多选）")
        .pick_files()
        .await
        .ok_or_else(|| "未选择文件".to_string())?;
    Ok(files
        .into_iter()
        .map(|f| f.path().to_string_lossy().into_owned())
        .collect())
}

/// 弹文件夹选择框，返回所选文件夹的绝对路径。不执行传输。
#[tauri::command]
pub async fn sftp_select_folder(title: String) -> Result<Option<String>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_title(title)
        .pick_folder()
        .await;
    Ok(picked.map(|p| p.path().to_string_lossy().into_owned()))
}

// ------------------------------  传输队列  ---------------------------------

/// 入队一个传输任务，返回 task id。前端选好本地路径后调用。
#[tauri::command]
pub async fn transfer_enqueue(
    queue: tauri::State<'_, TransferQueue>,
    session_id: String,
    kind: String,
    local_path: String,
    remote_path: String,
) -> Result<String, String> {
    let kind = TransferKind::from_str(&kind)?;
    let local_path = std::path::PathBuf::from(local_path);
    let name = local_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .or_else(|| {
            remote_path
                .rsplit('/')
                .find(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "transfer".to_string());
    Ok(queue
        .enqueue(session_id, kind, local_path, remote_path, name)
        .await)
}

/// 取消一个传输任务。
#[tauri::command]
pub async fn transfer_cancel(
    queue: tauri::State<'_, TransferQueue>,
    id: String,
) -> Result<(), String> {
    queue.cancel(&id).await;
    Ok(())
}

/// 列出所有传输任务快照。
#[tauri::command]
pub async fn transfer_list(
    queue: tauri::State<'_, TransferQueue>,
) -> Result<Vec<crate::session::transfer::TransferTaskSnap>, String> {
    Ok(queue.list().await)
}

/// 目录同步：比对本地与远程目录，将差异文件入传输队列。
#[tauri::command]
pub async fn sync_directory(
    sessions: tauri::State<'_, SessionManager>,
    sftp_mgr: tauri::State<'_, SftpManager>,
    queue: tauri::State<'_, TransferQueue>,
    session_id: String,
    local_dir: String,
    remote_dir: String,
    mode: String,
) -> Result<crate::session::sync::SyncPlanResult, String> {
    use crate::session::sync::{run_directory_sync, SyncMode};
    let mode = SyncMode::from_str(&mode)?;
    let sftp = sftp_mgr.get(sessions.inner(), &session_id).await?;
    run_directory_sync(
        &sftp,
        queue.inner(),
        &session_id,
        std::path::Path::new(&local_dir),
        &remote_dir,
        mode,
    )
    .await
}

// ==============================  端口转发  =================================

/// 新建一条端口转发（-L/-R/-D）。返回新建条目（含实际绑定端口）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn forward_add(
    forwards: tauri::State<'_, PortForwardManager>,
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    kind: String,
    local_addr: String,
    local_port: u16,
    remote_host: Option<String>,
    remote_port: Option<u16>,
) -> Result<crate::session::forward::ForwardEntrySnap, String> {
    let kind = match kind.as_str() {
        "local" => ForwardKind::Local,
        "remote" => ForwardKind::Remote,
        "dynamic" => ForwardKind::Dynamic,
        _ => return Err(format!("unknown forward kind: {kind}")),
    };
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let handle = entry.handle.clone();
    let registry = entry.forward_registry.clone();
    forwards
        .add(
            handle,
            registry,
            session_id,
            kind,
            local_addr,
            local_port,
            remote_host,
            remote_port,
        )
        .await
}

/// 列出所有端口转发。
#[tauri::command]
pub async fn forward_list(
    forwards: tauri::State<'_, PortForwardManager>,
) -> Result<Vec<crate::session::forward::ForwardEntrySnap>, String> {
    Ok(forwards.list().await)
}

/// 停止并移除一条端口转发（-R 额外通知服务器取消远端绑定）。
#[tauri::command]
pub async fn forward_remove(
    forwards: tauri::State<'_, PortForwardManager>,
    sessions: tauri::State<'_, SessionManager>,
    id: String,
) -> Result<(), String> {
    let snap = forwards
        .get_snap(&id)
        .await
        .ok_or_else(|| format!("forward not found: {id}"))?;
    if matches!(snap.kind, ForwardKind::Remote) {
        if let Some(entry) = sessions.get(&snap.session_id).await {
            let bind_host = snap
                .remote_host
                .clone()
                .unwrap_or_else(|| "127.0.0.1".to_string());
            {
                let _ = entry
                    .handle
                    .cancel_tcpip_forward(bind_host.clone(), snap.bound_port as u32)
                    .await;
            }
            entry
                .forward_registry
                .lock()
                .await
                .remove(&(bind_host, snap.bound_port as u32));
        }
    }
    forwards.remove(&id).await;
    Ok(())
}

// ==============================  连接配置  =================================

/// 列出所有保存的连接配置。
#[tauri::command]
pub async fn profile_list(
    state: tauri::State<'_, ProfileStore>,
) -> Result<Vec<crate::session::profile::ConnectionProfile>, String> {
    Ok(state.list().await)
}

/// 保存一个连接配置（凭据进 OS 钥匙串，元数据进本地 JSON）。返回新建的配置。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn profile_save(
    state: tauri::State<'_, ProfileStore>,
    name: String,
    host: String,
    port: u16,
    user: String,
    auth_method: String,
    password: Option<String>,
    private_key_path: Option<String>,
    passphrase: Option<String>,
    group_id: Option<String>,
    jump_profile_id: Option<String>,
) -> Result<crate::session::profile::ConnectionProfile, String> {
    let method = parse_auth_method(&auth_method)?;
    state
        .save(ProfileInput {
            name,
            host,
            port,
            user,
            auth_method: method,
            password,
            private_key_path,
            passphrase,
            group_id,
            jump_profile_id,
        })
        .await
}

/// 更新一个已保存的连接配置；密码 / passphrase 留空则保留原值。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn profile_update(
    state: tauri::State<'_, ProfileStore>,
    id: String,
    name: String,
    host: String,
    port: u16,
    user: String,
    auth_method: String,
    password: Option<String>,
    private_key_path: Option<String>,
    passphrase: Option<String>,
    group_id: Option<String>,
    jump_profile_id: Option<String>,
) -> Result<crate::session::profile::ConnectionProfile, String> {
    let method = parse_auth_method(&auth_method)?;
    state
        .update(
            &id,
            ProfileInput {
                name,
                host,
                port,
                user,
                auth_method: method,
                password,
                private_key_path,
                passphrase,
                group_id,
                jump_profile_id,
            },
        )
        .await
}

/// 弹本地私钥文件选择框，返回绝对路径。
#[tauri::command]
pub async fn profile_select_private_key() -> Result<Option<String>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_title("选择 SSH 私钥文件")
        .add_filter("SSH 私钥", &["pem", "key", ""])
        .pick_file()
        .await;
    Ok(picked.map(|f| f.path().to_string_lossy().into_owned()))
}

/// 删除一个保存的连接配置（同时清理钥匙串）。
#[tauri::command]
pub async fn profile_delete(
    state: tauri::State<'_, ProfileStore>,
    id: String,
) -> Result<(), String> {
    state.clear_jump_refs(&id).await?;
    state.delete(&id).await
}

/// 用保存的配置直接连接（从钥匙串取密码）。
#[tauri::command]
pub async fn profile_connect(
    state: tauri::State<'_, ProfileStore>,
    sessions: tauri::State<'_, SessionManager>,
    verifier: tauri::State<'_, HostKeyVerifier>,
    app: AppHandle,
    connect_id: String,
    id: String,
) -> Result<SessionInfo, String> {
    let p = state
        .find(&id)
        .await
        .ok_or_else(|| format!("profile not found: {id}"))?;
    let params = state.to_connect_params(&p).await?;
    sessions
        .connect(&params, &app, &connect_id, verifier.inner())
        .await
        .map_err(|e| e.to_string())
}

// ==============================  连接分组  =================================

/// 列出所有连接分组。
#[tauri::command]
pub async fn group_list(
    state: tauri::State<'_, GroupStore>,
) -> Result<Vec<crate::session::groups::ProfileGroup>, String> {
    Ok(state.list().await)
}

/// 新建连接分组。
#[tauri::command]
pub async fn group_create(
    state: tauri::State<'_, GroupStore>,
    name: String,
) -> Result<crate::session::groups::ProfileGroup, String> {
    state.create(name).await
}

/// 重命名连接分组。
#[tauri::command]
pub async fn group_rename(
    state: tauri::State<'_, GroupStore>,
    id: String,
    name: String,
) -> Result<crate::session::groups::ProfileGroup, String> {
    state.rename(&id, name).await
}

/// 删除连接分组（组内连接移至未分组）。
#[tauri::command]
pub async fn group_delete(
    groups: tauri::State<'_, GroupStore>,
    profiles: tauri::State<'_, ProfileStore>,
    id: String,
) -> Result<(), String> {
    profiles.clear_group_refs(&id).await?;
    groups.delete(&id).await
}

// ==============================  系统监控  =================================

/// 采集指定会话的远程系统指标快照（Linux /proc）。
#[tauri::command]
pub async fn monitor_snapshot(
    sessions: tauri::State<'_, SessionManager>,
    monitor: tauri::State<'_, MonitorStore>,
    session_id: String,
) -> Result<MonitorSnapshot, String> {
    monitor.snapshot(sessions.inner(), &session_id).await
}

fn parse_auth_method(raw: &str) -> Result<AuthMethod, String> {
    match raw {
        "password" => Ok(AuthMethod::Password),
        "private_key" => Ok(AuthMethod::PrivateKey),
        _ => Err(format!("unknown auth_method: {raw}")),
    }
}

fn build_auth(
    auth_method: &str,
    password: Option<String>,
    private_key_path: Option<String>,
    passphrase: Option<String>,
) -> Result<SshAuth, String> {
    match auth_method {
        "password" => {
            let pw = password
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "密码认证需要填写密码".to_string())?;
            Ok(SshAuth::Password(pw))
        }
        "private_key" => {
            let path = private_key_path
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "私钥认证需要选择私钥文件".to_string())?;
            Ok(SshAuth::PrivateKey {
                path,
                passphrase: passphrase.filter(|s| !s.is_empty()),
            })
        }
        other => Err(format!("unknown auth_method: {other}")),
    }
}

/// 解析跳板机 profile id 为连接参数（新建连接弹窗用）。
async fn resolve_jump_profile(
    profiles: &ProfileStore,
    jump_profile_id: Option<&str>,
    self_id: Option<&str>,
) -> Result<Option<Box<SshConnectParams>>, String> {
    let jump_id = match jump_profile_id.filter(|s| !s.is_empty()) {
        Some(id) => id,
        None => return Ok(None),
    };
    if self_id == Some(jump_id) {
        return Err("跳板机不能指向自身".to_string());
    }
    let jump_profile = profiles
        .find(jump_id)
        .await
        .ok_or_else(|| format!("跳板机配置不存在: {jump_id}"))?;
    if jump_profile.jump_profile_id.is_some() {
        return Err("跳板机不支持嵌套，请选择单跳跳板".to_string());
    }
    let auth = match jump_profile.auth_method {
        AuthMethod::Password => {
            let pw = profiles.get_password(&jump_profile.id).await?;
            SshAuth::Password(pw)
        }
        AuthMethod::PrivateKey => {
            let path = jump_profile
                .private_key_path
                .clone()
                .filter(|p| !p.is_empty())
                .ok_or_else(|| "跳板机未配置私钥路径".to_string())?;
            let passphrase = profiles.get_passphrase(&jump_profile.id).await.ok();
            SshAuth::PrivateKey { path, passphrase }
        }
    };
    Ok(Some(Box::new(SshConnectParams {
        host: jump_profile.host,
        port: jump_profile.port,
        user: jump_profile.user,
        auth,
        jump: None,
    })))
}

// ============================  主机公钥校验  ================================

/// 信任一个待确认的主机公钥：剔除同算法的旧冲突记录后，以 OpenSSH 格式追加到
/// `~/.ssh/known_hosts`。前端在 `ssh://hostkey` 弹窗里点「信任」后调用，随后重连。
#[tauri::command]
pub async fn hostkey_trust(
    verifier: tauri::State<'_, HostKeyVerifier>,
    host: String,
    port: u16,
) -> Result<(), String> {
    verifier.trust(&host, port).await
}

/// 拒绝一个待确认的主机公钥：仅清进程内存里的暂存，不改动 `known_hosts`。
#[tauri::command]
pub async fn hostkey_reject(
    verifier: tauri::State<'_, HostKeyVerifier>,
    host: String,
    port: u16,
) -> Result<(), String> {
    verifier.reject(&host, port).await;
    Ok(())
}

/// 删除一个已知主机的全部 known_hosts 记录（供后续「已知主机」管理面板）。
#[tauri::command]
pub async fn hostkey_remove(
    verifier: tauri::State<'_, HostKeyVerifier>,
    host: String,
    port: u16,
) -> Result<(), String> {
    verifier.remove_host(&host, port).await
}
