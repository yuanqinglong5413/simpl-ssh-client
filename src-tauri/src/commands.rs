//! 暴露给前端的 Tauri 命令。

use std::{
    env, fs,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use russh::ChannelMsg;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

use crate::session::forward::{ForwardKind, PortForwardManager};
use crate::session::git_ops;
use crate::session::git_ops::{
    exec_git, parse_branches, parse_diff, parse_log, parse_status, parse_worktrees,
};
use crate::session::groups::GroupStore;
use crate::session::profile::{ProfileInput, ProfileStore};
use crate::session::pty::TerminalPipes;
use crate::session::sftp::{list_dir, FileEntry, SftpManager};
use crate::session::transfer::{TransferKind, TransferQueue};
use crate::session::{
    connect_and_exec, AppDatabase, AuthMethod, HostKeyVerifier, InstalledLspPlugin,
    LocalPtyRegistry, LspManager, LspPluginManager, LspPluginManifest, LspRequest, LspState,
    MonitorSnapshot, MonitorStore, Project, ProjectBatchJob, ProjectBatchManager,
    ProjectIndexManager, ProjectInput, ProjectSearchManager, ProjectStore, ProjectWatchManager,
    SessionInfo, SessionManager, SshAuth, SshConnectParams, TaskRunner, TerminalBridge,
    WorkspaceStore,
};

#[tauri::command]
pub fn storage_status(
    database: tauri::State<'_, Arc<AppDatabase>>,
) -> Result<crate::session::storage::StorageStatus, String> {
    database.status()
}

#[tauri::command]
pub fn storage_backup(database: tauri::State<'_, Arc<AppDatabase>>) -> Result<String, String> {
    database.backup()
}

#[tauri::command]
pub fn storage_retry_secret_cleanup(
    profiles: tauri::State<'_, ProfileStore>,
) -> Result<usize, String> {
    profiles.retry_secret_cleanup()
}

#[derive(Serialize)]
pub struct ProjectSearchMatch {
    pub path: String,
    pub line: u32,
    pub preview: String,
}

/// 将相对路径限制在已验证的项目根目录内。不存在的写入目标也会验证其最近存在父目录。
fn resolve_project_path(root: &str, relative_path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("无法访问项目根目录：{e}"))?;
    if !root.is_dir() {
        return Err("项目根目录不是文件夹".to_string());
    }
    let requested = Path::new(relative_path);
    if requested.is_absolute()
        || requested.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("文件路径必须位于项目根目录内".to_string());
    }
    // 项目工作台不跟随符号链接：即便链接最终仍位于根目录中，也可能在
    // 移动/删除期间变更目标，无法保证操作对象稳定。
    let mut inspected = root.clone();
    for part in requested.components() {
        if let Component::Normal(name) = part {
            inspected.push(name);
            if inspected.exists()
                && fs::symlink_metadata(&inspected)
                    .map_err(|e| e.to_string())?
                    .file_type()
                    .is_symlink()
            {
                return Err("项目工作台不支持操作符号链接".to_string());
            }
        }
    }
    let candidate = root.join(requested);
    let verified = if candidate.exists() {
        fs::canonicalize(&candidate).map_err(|e| e.to_string())?
    } else {
        let parent = candidate
            .parent()
            .ok_or_else(|| "无效文件路径".to_string())?;
        let verified_parent =
            fs::canonicalize(parent).map_err(|e| format!("目标目录不存在或不可访问：{e}"))?;
        verified_parent.join(
            candidate
                .file_name()
                .ok_or_else(|| "无效文件路径".to_string())?,
        )
    };
    if !verified.starts_with(&root) {
        return Err("拒绝访问项目根目录外的文件".to_string());
    }
    Ok(verified)
}

fn project_root(root: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("无法访问项目根目录：{e}"))?;
    if root.is_dir() {
        Ok(root)
    } else {
        Err("项目根目录不是文件夹".to_string())
    }
}

fn non_root_project_path(root: &str, relative_path: &str) -> Result<PathBuf, String> {
    if relative_path.trim().is_empty() || relative_path == "." {
        return Err("不能操作项目根目录".to_string());
    }
    resolve_project_path(root, relative_path)
}

#[derive(Serialize)]
pub struct ProjectDeletePreview {
    pub files: u64,
    pub directories: u64,
    pub paths: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ProjectPathChange {
    pub from: String,
    pub to: String,
}

#[derive(Serialize, Clone)]
pub struct ProjectOperationFailure {
    pub path: String,
    pub error: String,
}

#[derive(Serialize, Clone)]
pub struct ProjectBatchResult {
    pub completed: Vec<ProjectPathChange>,
    pub failed: Vec<ProjectOperationFailure>,
}

fn count_delete_target(path: &Path, result: &mut ProjectDeletePreview) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("项目工作台不支持操作符号链接".to_string());
    }
    if metadata.is_dir() {
        result.directories += 1;
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            count_delete_target(&entry.map_err(|e| e.to_string())?.path(), result)?;
        }
    } else {
        result.files += 1;
    }
    Ok(())
}

fn copy_recursively(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("项目工作台不支持复制符号链接".to_string());
    }
    if metadata.is_dir() {
        fs::create_dir(target).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_recursively(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else {
        fs::copy(source, target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn project_entry(_path: &Path, entry: &fs::DirEntry) -> Result<FileEntry, String> {
    let metadata = entry.metadata().map_err(|e| e.to_string())?;
    Ok(FileEntry {
        name: entry.file_name().to_string_lossy().to_string(),
        is_dir: metadata.is_dir(),
        is_symlink: entry.file_type().map_err(|e| e.to_string())?.is_symlink(),
        size: if metadata.is_file() {
            metadata.len()
        } else {
            0
        },
        modified: metadata.modified().ok().map(|time| {
            chrono::DateTime::<chrono::Local>::from(time)
                .format("%Y-%m-%d %H:%M")
                .to_string()
        }),
    })
}

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
    encoding: Option<String>,
    keepalive_interval: Option<u64>,
    startup_command: Option<String>,
) -> Result<SessionInfo, String> {
    let auth = build_auth(&auth_method, password, private_key_path, passphrase)?;
    let jump = resolve_jump_profile(&profiles, jump_profile_id.as_deref(), None).await?;
    let params = SshConnectParams {
        host,
        port,
        user,
        auth,
        jump,
        encoding,
        keepalive_interval,
        startup_command,
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
        // 远端 sshd 可以拒绝 SetEnv；这不应阻断正常 PTY 连接。
        let _ = channel.set_env(false, "COLORTERM", "truecolor").await;
        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| e.to_string())?;
        channel
            .request_shell(true)
            .await
            .map_err(|e| e.to_string())?;
        // 启动命令：shell 就绪后注入（等价用户敲入）。
        if let Some(cmd) = entry.startup_command.as_ref().filter(|s| !s.is_empty()) {
            let line = format!("{cmd}\n");
            let _ = channel.data_bytes(line.into_bytes()).await;
        }
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

    let encoding = entry.encoding.clone();
    tokio::spawn(async move {
        // 终端编解码器：按 profile.encoding 在 UTF-8 ↔ GBK 等之间转换（None 直通）。
        let mut codec = crate::session::encoding::TerminalCodec::new(encoding.as_deref());
        let mut decode_buf = String::with_capacity(8192);
        loop {
            tokio::select! {
                bytes = input_rx.recv() => match bytes {
                    Some(bytes) => {
                        let payload = codec.encode_input(&bytes);
                        if channel.data_bytes(payload).await.is_err() { break; }
                    }
                    None => break,
                },
                size = resize_rx.recv() => match size {
                    Some((cols, rows)) => {
                        if channel.window_change(cols, rows, 0, 0).await.is_err() { break; }
                    }
                    None => break,
                },
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        let decoded = codec.decode_output(data.as_ref(), &mut decode_buf, false);
                        if output_tx.send(decoded).await.is_err() { break; }
                    }
                    Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        let decoded = codec.decode_output(data.as_ref(), &mut decode_buf, false);
                        if output_tx.send(decoded).await.is_err() { break; }
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

/// 修改远程文件/目录权限（chmod，如 "755"）。经 exec channel 执行。
#[tauri::command]
pub async fn sftp_chmod(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    path: String,
    mode: String,
) -> Result<(), String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let cmd = format!(
        "chmod {} {}",
        mode,
        crate::session::git_ops::shellescape(&path)
    );
    crate::session::git_ops::exec_on_session(&entry.handle, &cmd)
        .await
        .map(|_| ())
}

/// 远程复制（cp -r）。
#[tauri::command]
pub async fn sftp_copy(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    src: String,
    dst: String,
) -> Result<(), String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let cmd = format!(
        "cp -r {} {}",
        crate::session::git_ops::shellescape(&src),
        crate::session::git_ops::shellescape(&dst)
    );
    crate::session::git_ops::exec_on_session(&entry.handle, &cmd)
        .await
        .map(|_| ())
}

/// 远程打包（tar -czf，gzip）。
#[tauri::command]
pub async fn sftp_tar(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    src: String,
    dst: String,
) -> Result<(), String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let (parent, base) = src.rsplit_once('/').unwrap_or((".", src.as_str()));
    let cmd = format!(
        "tar -czf {} -C {} {}",
        crate::session::git_ops::shellescape(&dst),
        crate::session::git_ops::shellescape(parent),
        crate::session::git_ops::shellescape(base)
    );
    crate::session::git_ops::exec_on_session(&entry.handle, &cmd)
        .await
        .map(|_| ())
}

/// 远程解包（tar -xzf）。
#[tauri::command]
pub async fn sftp_untar(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    src: String,
    dir: String,
) -> Result<(), String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let cmd = format!(
        "tar -xzf {} -C {}",
        crate::session::git_ops::shellescape(&src),
        crate::session::git_ops::shellescape(&dir)
    );
    crate::session::git_ops::exec_on_session(&entry.handle, &cmd)
        .await
        .map(|_| ())
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

// ----------------------------  远程文件读写  -------------------------------

/// 远程文件内容（sftp_read_file 返回）。
#[derive(Serialize)]
pub struct RemoteFileContent {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub modified: Option<String>,
    pub encoding: String,
    /// 本地项目文件的乐观并发版本；远程 SFTP 读取不提供此值。
    pub revision: Option<String>,
}

/// 通过 SFTP 读取远程文件全部内容（仅支持文本文件，5MB 上限）。
#[tauri::command]
pub async fn sftp_read_file(
    sftp_mgr: tauri::State<'_, SftpManager>,
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    path: String,
) -> Result<RemoteFileContent, String> {
    use tokio::io::AsyncReadExt;

    const MAX_SIZE: u64 = 5 * 1024 * 1024; // 5MB

    let sftp = sftp_mgr.get(sessions.inner(), &session_id).await?;

    // 获取文件元数据
    let metadata = sftp.metadata(&path).await.map_err(|e| e.to_string())?;
    let size = metadata.len();
    if size > MAX_SIZE {
        return Err(format!(
            "文件过大 ({:.1} MB)，超过 5MB 限制，请下载后编辑",
            size as f64 / 1024.0 / 1024.0
        ));
    }

    let modified = metadata.modified().ok().map(|t| {
        chrono::DateTime::<chrono::Local>::from(t)
            .format("%Y-%m-%d %H:%M")
            .to_string()
    });

    // 读取文件内容
    let mut file = sftp.open(&path).await.map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(size as usize);
    file.read_to_end(&mut buf)
        .await
        .map_err(|e| e.to_string())?;
    drop(file);

    // 检查是否为二进制文件
    if buf.contains(&0) {
        return Err("不支持编辑二进制文件".to_string());
    }

    let content = String::from_utf8(buf).map_err(|_| "文件不是有效的 UTF-8 文本".to_string())?;

    Ok(RemoteFileContent {
        path,
        content,
        size,
        modified,
        encoding: "utf-8".to_string(),
        revision: None,
    })
}

/// 通过 SFTP 写入远程文件（覆盖写）。
#[tauri::command]
pub async fn sftp_write_file(
    sftp_mgr: tauri::State<'_, SftpManager>,
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let sftp = sftp_mgr.get(sessions.inner(), &session_id).await?;

    let mut file = sftp.create(&path).await.map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    Ok(())
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
    overwrite: Option<String>,
    max_retries: Option<u32>,
) -> Result<String, String> {
    let kind = TransferKind::from_str(&kind)?;
    let overwrite = overwrite
        .as_deref()
        .map(crate::session::transfer::OverwriteMode::from_str)
        .transpose()?
        .unwrap_or_default();
    let max_retries = max_retries.unwrap_or(3);
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
        .enqueue(
            session_id,
            kind,
            local_path,
            remote_path,
            name,
            overwrite,
            max_retries,
        )
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

/// 暂停一个传输任务。
#[tauri::command]
pub async fn transfer_pause(
    queue: tauri::State<'_, TransferQueue>,
    id: String,
) -> Result<(), String> {
    queue.pause(&id).await;
    Ok(())
}

/// 继续一个暂停的传输任务。
#[tauri::command]
pub async fn transfer_resume(
    queue: tauri::State<'_, TransferQueue>,
    id: String,
) -> Result<(), String> {
    queue.resume(&id).await;
    Ok(())
}

/// 重试一个已结束的传输任务（从头重传；断点续传见后续）。
#[tauri::command]
pub async fn transfer_retry(
    queue: tauri::State<'_, TransferQueue>,
    id: String,
) -> Result<(), String> {
    queue.retry(&id).await;
    Ok(())
}

/// 清除所有已结束的传输任务。
#[tauri::command]
pub async fn transfer_clear_done(queue: tauri::State<'_, TransferQueue>) -> Result<usize, String> {
    Ok(queue.clear_done().await)
}

/// 设置传输并发数（1..=8），返回实际生效值。
#[tauri::command]
pub async fn transfer_set_concurrency(
    app: AppHandle,
    queue: tauri::State<'_, TransferQueue>,
    n: usize,
) -> Result<usize, String> {
    Ok(queue.set_concurrency(&app, n))
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

/// 目录同步预览：扫描两侧目录树并返回将上传/下载的数量，不创建传输任务。
#[tauri::command]
pub async fn sync_preview(
    sessions: tauri::State<'_, SessionManager>,
    sftp_mgr: tauri::State<'_, SftpManager>,
    session_id: String,
    local_dir: String,
    remote_dir: String,
    mode: String,
) -> Result<crate::session::sync::SyncPreview, String> {
    use crate::session::sync::{preview_directory_sync, SyncMode};
    let mode = SyncMode::from_str(&mode)?;
    let sftp = sftp_mgr.get(sessions.inner(), &session_id).await?;
    preview_directory_sync(&sftp, std::path::Path::new(&local_dir), &remote_dir, mode).await
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

#[tauri::command]
pub async fn credential_migration_status(
    state: tauri::State<'_, ProfileStore>,
) -> Result<crate::session::profile::CredentialMigrationStatus, String> {
    state.credential_migration_status().await
}

#[tauri::command]
pub async fn credential_migration_run(
    state: tauri::State<'_, ProfileStore>,
) -> Result<crate::session::profile::CredentialMigrationReport, String> {
    state.migrate_keychain_credentials().await
}

/// 保存一个连接配置（凭据进应用 SQLite 加密仓库）。返回新建的配置。
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
    encoding: Option<String>,
    keepalive_interval: Option<u64>,
    startup_command: Option<String>,
    environment: Option<String>,
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
            encoding,
            keepalive_interval,
            startup_command,
            environment,
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
    encoding: Option<String>,
    keepalive_interval: Option<u64>,
    startup_command: Option<String>,
    environment: Option<String>,
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
                encoding,
                keepalive_interval,
                startup_command,
                environment,
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

/// 删除一个保存的连接配置（SQLite 外键同时清理加密凭据）。
#[tauri::command]
pub async fn profile_delete(
    state: tauri::State<'_, ProfileStore>,
    projects: tauri::State<'_, ProjectStore>,
    id: String,
) -> Result<(), String> {
    state.clear_jump_refs(&id).await?;
    state.delete(&id).await?;
    projects.remove_profile_refs(&id).await?;
    Ok(())
}

/// 从 ~/.ssh/config 导入连接配置，返回导入条数。
#[tauri::command]
pub async fn profiles_import_ssh_config(
    state: tauri::State<'_, ProfileStore>,
) -> Result<usize, String> {
    let path = dirs::home_dir()
        .map(|h| h.join(".ssh").join("config"))
        .ok_or_else(|| "无法定位 ~/.ssh/config".to_string())?;
    let content = tokio::task::spawn_blocking(move || {
        crate::session::import::read_ssh_config_with_includes(&path)
    })
    .await
    .map_err(|error| format!("SSH Config 导入任务失败：{error}"))??;
    let inputs = crate::session::import::parse_ssh_config(&content);
    state.import_many(inputs).await
}

/// 用保存的配置直接连接（从应用加密仓库取密码）。
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
    Ok(state.list_kind("connection").await)
}

#[tauri::command]
pub async fn resource_group_list(
    state: tauri::State<'_, GroupStore>,
    kind: String,
) -> Result<Vec<crate::session::groups::ProfileGroup>, String> {
    Ok(state.list_kind(&kind).await)
}

#[tauri::command]
pub async fn resource_group_create(
    state: tauri::State<'_, GroupStore>,
    kind: String,
    parent_id: Option<String>,
    name: String,
) -> Result<crate::session::groups::ProfileGroup, String> {
    state.create_in(&kind, parent_id, name).await
}

#[tauri::command]
pub async fn resource_group_move(
    state: tauri::State<'_, GroupStore>,
    id: String,
    parent_id: Option<String>,
    position: i32,
) -> Result<crate::session::groups::ProfileGroup, String> {
    state.move_group(&id, parent_id, position).await
}

#[tauri::command]
pub async fn resource_item_move(
    profiles: tauri::State<'_, ProfileStore>,
    projects: tauri::State<'_, ProjectStore>,
    kind: String,
    id: String,
    group_id: Option<String>,
) -> Result<(), String> {
    match kind.as_str() {
        "connection" => profiles.move_to_group(&id, group_id).await,
        "project" => projects.move_to_group(&id, group_id).await,
        _ => Err("未知资源类型".into()),
    }
}

#[derive(Serialize)]
pub struct ResourceTreeMoveResult {
    pub kind: String,
    pub node_type: String,
    pub id: String,
    pub parent_id: Option<String>,
    pub position: i32,
}

/// 原子移动资源树节点。先完成目标类型与循环校验，持久化成功后才替换内存状态。
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri 将三个 State 与五个公开命令字段分别注入。
pub async fn resource_tree_move(
    groups: tauri::State<'_, GroupStore>,
    profiles: tauri::State<'_, ProfileStore>,
    projects: tauri::State<'_, ProjectStore>,
    kind: String,
    node_type: String,
    id: String,
    parent_id: Option<String>,
    position: i32,
) -> Result<ResourceTreeMoveResult, String> {
    if !matches!(kind.as_str(), "connection" | "project") {
        return Err("未知资源树类型".into());
    }
    if let Some(parent) = parent_id.as_deref() {
        let target = groups.find(parent).await.ok_or("目标分组不存在")?;
        if target.kind != kind {
            return Err("不能跨资源树移动资源".into());
        }
    }
    let (resolved_parent, resolved_position) = match node_type.as_str() {
        "group" => {
            let moved = groups.move_group(&id, parent_id, position).await?;
            (moved.parent_id, moved.order)
        }
        "item" => match kind.as_str() {
            "connection" => {
                let moved = profiles.move_to_position(&id, parent_id, position).await?;
                (moved.group_id, moved.position)
            }
            "project" => {
                let moved = projects.move_to_position(&id, parent_id, position).await?;
                (moved.group_id, moved.position)
            }
            _ => unreachable!(),
        },
        _ => return Err("未知资源节点类型".into()),
    };
    Ok(ResourceTreeMoveResult {
        kind,
        node_type,
        id,
        parent_id: resolved_parent,
        position: resolved_position,
    })
}

#[derive(Serialize)]
pub struct ResourceGroupDeletePreview {
    pub group_count: usize,
    pub connection_count: usize,
    pub project_count: usize,
    pub deletes_physical_files: bool,
}

async fn resource_delete_preview(
    groups: &GroupStore,
    profiles: &ProfileStore,
    projects: &ProjectStore,
    id: &str,
) -> Result<(ResourceGroupDeletePreview, Vec<String>, String), String> {
    let group = groups.find(id).await.ok_or("分组不存在")?;
    let ids = groups.descendants(id).await?;
    let connection_count = if group.kind == "connection" {
        profiles.count_in_groups(&ids).await
    } else {
        0
    };
    let project_count = if group.kind == "project" {
        projects.count_in_groups(&ids).await
    } else {
        0
    };
    Ok((
        ResourceGroupDeletePreview {
            group_count: ids.len(),
            connection_count,
            project_count,
            deletes_physical_files: false,
        },
        ids,
        group.kind,
    ))
}

#[tauri::command]
pub async fn resource_group_delete_preview(
    groups: tauri::State<'_, GroupStore>,
    profiles: tauri::State<'_, ProfileStore>,
    projects: tauri::State<'_, ProjectStore>,
    id: String,
) -> Result<ResourceGroupDeletePreview, String> {
    resource_delete_preview(groups.inner(), profiles.inner(), projects.inner(), &id)
        .await
        .map(|value| value.0)
}

#[tauri::command]
pub async fn resource_group_delete(
    groups: tauri::State<'_, GroupStore>,
    profiles: tauri::State<'_, ProfileStore>,
    projects: tauri::State<'_, ProjectStore>,
    id: String,
    confirmed: bool,
) -> Result<ResourceGroupDeletePreview, String> {
    if !confirmed {
        return Err("递归删除需要明确确认".into());
    }
    let (preview, ids, kind) =
        resource_delete_preview(groups.inner(), profiles.inner(), projects.inner(), &id).await?;
    if kind == "connection" {
        profiles.delete_in_groups(&ids).await?;
    } else {
        projects.delete_in_groups(&ids).await?;
    }
    groups.delete_tree(&ids).await?;
    Ok(preview)
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

// ==============================  命令片段  =================================

/// 列出全部常用命令片段。
#[tauri::command]
pub async fn snippet_list(
    state: tauri::State<'_, crate::session::SnippetStore>,
) -> Result<Vec<crate::session::snippets::Snippet>, String> {
    Ok(state.list().await)
}

/// 新建命令片段。
#[tauri::command]
pub async fn snippet_create(
    state: tauri::State<'_, crate::session::SnippetStore>,
    input: crate::session::snippets::SnippetInput,
) -> Result<crate::session::snippets::Snippet, String> {
    state.create(input).await
}

/// 更新命令片段。
#[tauri::command]
pub async fn snippet_update(
    state: tauri::State<'_, crate::session::SnippetStore>,
    id: String,
    input: crate::session::snippets::SnippetInput,
) -> Result<crate::session::snippets::Snippet, String> {
    state.update(&id, input).await
}

/// 删除命令片段。
#[tauri::command]
pub async fn snippet_delete(
    state: tauri::State<'_, crate::session::SnippetStore>,
    id: String,
) -> Result<(), String> {
    state.delete(&id).await
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
        encoding: None,
        keepalive_interval: None,
        startup_command: None,
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

/// 列出 ~/.ssh/known_hosts 全部条目（已知主机管理面板用）。
#[tauri::command]
pub async fn hostkey_list() -> Result<Vec<crate::session::known_hosts::KnownHostEntry>, String> {
    tokio::task::spawn_blocking(crate::session::known_hosts::list_all)
        .await
        .map_err(|e| e.to_string())?
}

// ==============================  工作区持久化  ================================

/// 保存当前工作区快照（前端在 tabs 变更时 debounce 调用）。
#[tauri::command]
pub async fn workspace_save(
    ws: tauri::State<'_, WorkspaceStore>,
    snapshot: String,
) -> Result<(), String> {
    ws.save(&snapshot).await
}

/// 加载上次的工作区快照（启动时调用）。返回 JSON 字符串。
#[tauri::command]
pub async fn workspace_load(
    ws: tauri::State<'_, WorkspaceStore>,
) -> Result<Option<String>, String> {
    ws.load().await
}

/// 清空工作区快照（用户手动 "不恢复" 时调用）。
#[tauri::command]
pub async fn workspace_clear(ws: tauri::State<'_, WorkspaceStore>) -> Result<(), String> {
    ws.clear().await
}

// ==============================  Git 操作  =================================

/// 获取 git status。
#[tauri::command]
pub async fn git_status(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    repo_path: String,
) -> Result<git_ops::GitStatusResult, String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let output = exec_git(&entry.handle, &repo_path, "status --porcelain=v2 --branch").await?;
    Ok(parse_status(&output))
}

/// git add（暂存指定路径；无路径则 add -A 全部暂存）。
#[tauri::command]
pub async fn git_add(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    repo_path: String,
    path: Option<String>,
) -> Result<(), String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let arg = match path {
        Some(p) => format!("add -- {}", git_ops::shellescape(&p)),
        None => "add -A".to_string(),
    };
    exec_git(&entry.handle, &repo_path, &arg).await.map(|_| ())
}

/// git reset HEAD（取消暂存）。
#[tauri::command]
pub async fn git_unstage(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    repo_path: String,
    path: Option<String>,
) -> Result<(), String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let arg = match path {
        Some(p) => format!("reset HEAD -- {}", git_ops::shellescape(&p)),
        None => "reset HEAD".to_string(),
    };
    exec_git(&entry.handle, &repo_path, &arg).await.map(|_| ())
}

/// git commit -m。
#[tauri::command]
pub async fn git_commit(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    repo_path: String,
    message: String,
) -> Result<(), String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    exec_git(
        &entry.handle,
        &repo_path,
        &format!("commit -m {}", git_ops::shellescape(&message)),
    )
    .await
    .map(|_| ())
}

/// git push。
#[tauri::command]
pub async fn git_push(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    repo_path: String,
) -> Result<(), String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    exec_git(&entry.handle, &repo_path, "push")
        .await
        .map(|_| ())
}

/// git pull --ff-only。
#[tauri::command]
pub async fn git_pull(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    repo_path: String,
) -> Result<(), String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    exec_git(&entry.handle, &repo_path, "pull --ff-only")
        .await
        .map(|_| ())
}

/// 获取 git log。
#[tauri::command]
pub async fn git_log(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    repo_path: String,
    count: Option<u32>,
) -> Result<Vec<git_ops::GitLogEntry>, String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let n = count.unwrap_or(30);
    let output = exec_git(
        &entry.handle,
        &repo_path,
        &format!("log --format=\"%H|%h|%an|%aI|%s\" -n {n}"),
    )
    .await?;
    Ok(parse_log(&output))
}

/// 获取 git diff。
#[tauri::command]
pub async fn git_diff(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    repo_path: String,
    file_path: Option<String>,
    staged: Option<bool>,
) -> Result<Vec<git_ops::GitDiffResult>, String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let mut args = String::from("diff");
    if staged.unwrap_or(false) {
        args.push_str(" --staged");
    }
    if let Some(fp) = file_path {
        args.push_str(" -- ");
        args.push_str(&fp);
    }
    let output = exec_git(&entry.handle, &repo_path, &args).await?;
    Ok(parse_diff(&output))
}

/// 获取分支列表。
#[tauri::command]
pub async fn git_branches(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    repo_path: String,
) -> Result<Vec<git_ops::GitBranch>, String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let output = exec_git(
        &entry.handle,
        &repo_path,
        "branch -a --format=\"%(refname:short)|%(HEAD)\"",
    )
    .await?;
    Ok(parse_branches(&output))
}

/// 切换分支。
#[tauri::command]
pub async fn git_checkout(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    repo_path: String,
    branch: String,
) -> Result<(), String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    exec_git(&entry.handle, &repo_path, &format!("checkout {}", branch)).await?;
    Ok(())
}

/// 列出 worktree。
#[tauri::command]
pub async fn git_worktree_list(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    repo_path: String,
) -> Result<Vec<git_ops::GitWorktree>, String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let output = exec_git(&entry.handle, &repo_path, "worktree list --porcelain").await?;
    Ok(parse_worktrees(&output))
}

/// 添加 worktree。
#[tauri::command]
pub async fn git_worktree_add(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    repo_path: String,
    path: String,
    branch: String,
) -> Result<(), String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    exec_git(
        &entry.handle,
        &repo_path,
        &format!("worktree add {} -b {}", path, branch),
    )
    .await?;
    Ok(())
}

/// 删除 worktree。
#[tauri::command]
pub async fn git_worktree_remove(
    sessions: tauri::State<'_, SessionManager>,
    session_id: String,
    repo_path: String,
    path: String,
) -> Result<(), String> {
    let entry = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    exec_git(
        &entry.handle,
        &repo_path,
        &format!("worktree remove {}", path),
    )
    .await?;
    Ok(())
}

// ==============================  本地终端  =================================

/// 在本地打开一个 PTY 终端，返回 WS 端口 + token。
#[tauri::command]
pub async fn local_terminal_open(
    bridge: tauri::State<'_, Arc<TerminalBridge>>,
    registry: tauri::State<'_, Arc<LocalPtyRegistry>>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalHandle, String> {
    crate::session::local_pty::open_local_terminal(
        bridge.inner(),
        registry.inner(),
        cwd,
        cols,
        rows,
    )
    .await
}

/// 检查本地 PATH 中是否存在某个 Agent 可执行文件；不执行命令本身。
#[tauri::command]
pub async fn local_command_available(executable: String) -> Result<bool, String> {
    let executable = executable.trim();
    if executable.is_empty() || executable.contains(['/', '\\']) {
        return Ok(false);
    }
    let suffixes: Vec<String> = if cfg!(windows) {
        env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|v| v.to_ascii_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };
    Ok(env::var_os("PATH")
        .into_iter()
        .flat_map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .any(|dir| {
            suffixes.iter().any(|suffix| {
                let candidate: PathBuf = dir.join(format!("{executable}{suffix}"));
                is_executable_file(&candidate)
            })
        }))
}

// ==============================  本地 LSP  =================================

#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    manager: tauri::State<'_, LspManager>,
    server_id: String,
    root: String,
    command: String,
    args: Vec<String>,
) -> Result<LspState, String> {
    manager.start(app, server_id, root, command, args).await
}

#[tauri::command]
pub async fn lsp_stop(
    manager: tauri::State<'_, LspManager>,
    server_id: String,
) -> Result<(), String> {
    manager.stop(&server_id).await;
    Ok(())
}

#[tauri::command]
pub async fn lsp_request(
    manager: tauri::State<'_, LspManager>,
    server_id: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    manager
        .request(&server_id, LspRequest { method, params })
        .await
}

#[tauri::command]
pub async fn lsp_notify(
    manager: tauri::State<'_, LspManager>,
    server_id: String,
    method: String,
    params: Value,
) -> Result<(), String> {
    manager.notify(&server_id, method, params).await
}

#[tauri::command]
pub async fn lsp_restart(
    app: AppHandle,
    manager: tauri::State<'_, LspManager>,
    server_id: String,
    root: String,
    command: String,
    args: Vec<String>,
) -> Result<LspState, String> {
    manager.start(app, server_id, root, command, args).await
}

#[tauri::command]
pub async fn lsp_status(
    manager: tauri::State<'_, LspManager>,
    server_id: String,
) -> Result<Option<LspState>, String> {
    Ok(manager.status(&server_id).await)
}

#[tauri::command]
pub async fn lsp_catalog_list(
    app: AppHandle,
    plugins: tauri::State<'_, LspPluginManager>,
) -> Result<Vec<LspPluginManifest>, String> {
    plugins.catalog(&app).await
}

#[tauri::command]
pub async fn lsp_plugin_status(
    app: AppHandle,
    plugins: tauri::State<'_, LspPluginManager>,
) -> Result<Vec<InstalledLspPlugin>, String> {
    plugins.status(&app).await
}

#[tauri::command]
pub async fn lsp_plugin_refresh_catalog(
    app: AppHandle,
    plugins: tauri::State<'_, LspPluginManager>,
) -> Result<Vec<LspPluginManifest>, String> {
    plugins.refresh_catalog(&app).await
}

#[tauri::command]
pub async fn lsp_plugin_check(
    app: AppHandle,
    plugins: tauri::State<'_, LspPluginManager>,
) -> Result<Vec<crate::session::LspPluginAvailability>, String> {
    plugins.check(&app).await
}

#[tauri::command]
pub async fn lsp_plugin_install(
    app: AppHandle,
    plugins: tauri::State<'_, LspPluginManager>,
    plugin_id: String,
    version: String,
) -> Result<InstalledLspPlugin, String> {
    plugins.install(&app, &plugin_id, &version).await
}

#[tauri::command]
pub async fn lsp_plugin_cancel_install(
    plugins: tauri::State<'_, LspPluginManager>,
    plugin_id: String,
    version: String,
) -> Result<bool, String> {
    Ok(plugins.cancel_install(&plugin_id, &version).await)
}

#[tauri::command]
pub async fn lsp_plugin_uninstall(
    app: AppHandle,
    plugins: tauri::State<'_, LspPluginManager>,
    manager: tauri::State<'_, LspManager>,
    plugin_id: String,
    version: String,
) -> Result<(), String> {
    manager.stop_matching(&plugin_id).await;
    plugins.uninstall(&app, &plugin_id, &version).await
}

#[tauri::command]
pub async fn lsp_plugin_rollback(
    app: AppHandle,
    plugins: tauri::State<'_, LspPluginManager>,
    manager: tauri::State<'_, LspManager>,
    plugin_id: String,
    version: String,
) -> Result<(), String> {
    manager.stop_matching(&plugin_id).await;
    plugins.rollback(&app, &plugin_id, &version).await
}

#[tauri::command]
pub async fn lsp_plugin_enable(
    app: AppHandle,
    plugins: tauri::State<'_, LspPluginManager>,
    plugin_id: String,
    version: String,
    priority: Option<i32>,
) -> Result<Vec<InstalledLspPlugin>, String> {
    plugins
        .enable(&app, &plugin_id, &version, true, priority.unwrap_or(0))
        .await
}

#[tauri::command]
pub async fn lsp_plugin_disable(
    app: AppHandle,
    plugins: tauri::State<'_, LspPluginManager>,
    plugin_id: String,
    version: String,
) -> Result<Vec<InstalledLspPlugin>, String> {
    plugins.enable(&app, &plugin_id, &version, false, 0).await
}

#[tauri::command]
pub async fn lsp_plugin_resolve(
    app: AppHandle,
    plugins: tauri::State<'_, LspPluginManager>,
    plugin_id: String,
    version: String,
) -> Result<(String, Vec<String>), String> {
    plugins.resolve(&app, &plugin_id, &version).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn lsp_start_plugin(
    app: AppHandle,
    plugins: tauri::State<'_, LspPluginManager>,
    manager: tauri::State<'_, LspManager>,
    project_id: String,
    plugin_id: String,
    version: String,
    root: String,
    args: Option<Vec<String>>,
) -> Result<LspState, String> {
    let (command, default_args) = plugins.resolve(&app, &plugin_id, &version).await?;
    let mut args = args.unwrap_or(default_args);
    if plugin_id == "jdtls" && !args.iter().any(|arg| arg == "-data") {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        let project_key = Sha256::digest(project_id.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let workspace = app_data.join("lsp/workspaces").join(project_key);
        tokio::fs::create_dir_all(&workspace)
            .await
            .map_err(|error| format!("无法创建 JDTLS 工作区：{error}"))?;
        args.extend(["-data".into(), workspace.to_string_lossy().into_owned()]);
    }
    manager
        .start(
            app,
            format!("{project_id}:{plugin_id}"),
            root,
            command.clone(),
            args,
        )
        .await
        .map_err(|error| {
            let missing_executable = error.contains("No such file")
                || error.contains("cannot find")
                || error.contains("系统找不到");
            if missing_executable {
                format!(
                    "无法启动 {plugin_id}：找不到可执行文件 `{command}`。请先安装对应语言服务并确保它在 PATH 中，或在设置中添加自定义服务。"
                )
            } else {
                error
            }
        })
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

// ==============================  项目管理  =================================

#[tauri::command]
pub async fn project_list(store: tauri::State<'_, ProjectStore>) -> Result<Vec<Project>, String> {
    Ok(store.list().await)
}

#[tauri::command]
pub async fn project_create(
    store: tauri::State<'_, ProjectStore>,
    input: ProjectInput,
) -> Result<Project, String> {
    store.create(input).await
}

#[tauri::command]
pub async fn project_update(
    store: tauri::State<'_, ProjectStore>,
    id: String,
    input: ProjectInput,
) -> Result<Project, String> {
    store.update(&id, input).await
}

#[tauri::command]
pub async fn project_delete(
    store: tauri::State<'_, ProjectStore>,
    id: String,
) -> Result<(), String> {
    store.delete(&id).await
}

#[tauri::command]
pub async fn project_prune_agent_bindings(
    store: tauri::State<'_, ProjectStore>,
    preset_ids: Vec<String>,
) -> Result<usize, String> {
    store.prune_agent_bindings(preset_ids).await
}

// ==============================  本地文件  =================================

/// 本地家目录绝对路径（SFTP 双面板本地侧初始目录用）。
#[tauri::command]
pub async fn local_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|h| h.to_string_lossy().into_owned())
        .ok_or_else(|| "无法定位家目录".to_string())
}

/// 判断系统拖入路径的类型。拖放上传需要在入队前区分文件与目录，
/// 避免把目录错误地交给单文件传输任务。
#[tauri::command]
pub async fn local_path_is_dir(path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("为安全起见，不支持通过拖放上传符号链接".to_string());
        }
        Ok(metadata.is_dir())
    })
    .await
    .map_err(|error| format!("本地路径检查任务意外终止：{error}"))?
}

/// 列出本地目录内容。
#[tauri::command]
pub async fn local_list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    for entry in read_dir.flatten() {
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            is_symlink: metadata.file_type().is_symlink(),
            size: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
            modified: metadata.modified().ok().map(|t| {
                chrono::DateTime::<chrono::Local>::from(t)
                    .format("%Y-%m-%d %H:%M")
                    .to_string()
            }),
        });
    }
    // 目录在前，然后按名称排序
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// 读取本地文本文件。
#[tauri::command]
pub async fn local_read_file(path: String) -> Result<RemoteFileContent, String> {
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > 5 * 1024 * 1024 {
        return Err("文件超过 5MB 上限".to_string());
    }

    let buf = std::fs::read(&path).map_err(|e| e.to_string())?;

    // 检查是否为二进制
    if buf.iter().take(1024).any(|&b| b == 0) {
        return Err("不支持编辑二进制文件".to_string());
    }

    let content = String::from_utf8(buf).map_err(|_| "文件不是有效的 UTF-8 文本".to_string())?;

    let modified = metadata.modified().ok().map(|t| {
        chrono::DateTime::<chrono::Local>::from(t)
            .format("%Y-%m-%d %H:%M")
            .to_string()
    });

    Ok(RemoteFileContent {
        path,
        content,
        size: metadata.len(),
        modified,
        encoding: "utf-8".to_string(),
        revision: None,
    })
}

/// 写入本地文本文件。
#[tauri::command]
pub async fn local_write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

// =========================== 项目受控文件系统 ============================

/// 列出项目内一个目录；使用 ignore crate 自动遵循 .gitignore，且不允许越过项目根目录。
#[tauri::command]
pub async fn project_list_dir(
    root: String,
    relative_path: String,
    exclude: Option<Vec<String>>,
) -> Result<Vec<FileEntry>, String> {
    tokio::task::spawn_blocking(move || list_project_directory(&root, &relative_path, exclude))
        .await
        .map_err(|error| format!("项目目录读取任务意外终止：{error}"))?
}

fn list_project_directory(
    root: &str,
    relative_path: &str,
    exclude: Option<Vec<String>>,
) -> Result<Vec<FileEntry>, String> {
    let directory = resolve_project_path(root, relative_path)?;
    if !directory.is_dir() {
        return Err("目标不是目录".to_string());
    }
    let root_path = project_root(root)?;
    // 文件树只读取当前层，不能为展示一个目录而启动递归 Walker。除了会造成
    // 大仓库首屏卡顿外，某些全局 gitignore / 文件系统挂载点会让 Walker 长时间
    // 不返回，最终表现为项目工作台一直是空白加载态。
    let mut ignore_builder = ignore::gitignore::GitignoreBuilder::new(&root_path);
    let gitignore = root_path.join(".gitignore");
    if gitignore.is_file() {
        ignore_builder.add(gitignore);
    }
    for pattern in exclude.unwrap_or_default() {
        let pattern = pattern.trim();
        if !pattern.is_empty() {
            ignore_builder
                .add_line(None, pattern)
                .map_err(|e| e.to_string())?;
        }
    }
    let ignored = ignore_builder.build().map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for result in fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let entry = result.map_err(|e| e.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if ignored
            .matched_path_or_any_parents(&path, file_type.is_dir())
            .is_ignore()
        {
            continue;
        }
        entries.push(project_entry(&path, &entry)?);
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub async fn project_read_file(
    root: String,
    relative_path: String,
) -> Result<RemoteFileContent, String> {
    tokio::task::spawn_blocking(move || project_read_file_sync(&root, &relative_path))
        .await
        .map_err(|error| format!("项目文件读取任务意外终止：{error}"))?
}

fn project_read_file_sync(root: &str, relative_path: &str) -> Result<RemoteFileContent, String> {
    let path = resolve_project_path(root, relative_path)?;
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("目标不是文件".to_string());
    }
    if metadata.len() > 5 * 1024 * 1024 {
        return Err("文件超过 5MB 编辑上限".to_string());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.iter().take(1024).any(|byte| *byte == 0) {
        return Err("不支持编辑二进制文件".to_string());
    }
    let content = String::from_utf8(bytes).map_err(|_| "文件不是 UTF-8 文本".to_string())?;
    Ok(RemoteFileContent {
        path: relative_path.to_string(),
        content,
        size: metadata.len(),
        modified: metadata.modified().ok().map(|time| {
            chrono::DateTime::<chrono::Local>::from(time)
                .format("%Y-%m-%d %H:%M")
                .to_string()
        }),
        encoding: "utf-8".to_string(),
        revision: Some(file_revision(&path)?),
    })
}

#[tauri::command]
pub async fn project_write_file(
    root: String,
    relative_path: String,
    content: String,
    expected_revision: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        project_write_file_sync(&root, &relative_path, &content, expected_revision)
    })
    .await
    .map_err(|error| format!("项目文件写入任务意外终止：{error}"))?
}

fn project_write_file_sync(
    root: &str,
    relative_path: &str,
    content: &str,
    expected_revision: Option<String>,
) -> Result<(), String> {
    if content.len() > 5 * 1024 * 1024 {
        return Err("文件内容超过 5MB 编辑上限".to_string());
    }
    // 工作区配置是唯一允许由 IDE 首次创建父目录的受控位置。
    if relative_path.starts_with(".simpl-ssh/") {
        let root_path = fs::canonicalize(root).map_err(|e| format!("无法访问项目根目录：{e}"))?;
        fs::create_dir_all(root_path.join(".simpl-ssh")).map_err(|e| e.to_string())?;
    }
    let path = resolve_project_path(root, relative_path)?;
    if let Some(expected) = expected_revision {
        let actual = file_revision(&path)?;
        if actual != expected {
            return Err("文件已被外部修改，请先比较或重新加载".to_string());
        }
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

fn file_revision(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|time| time.as_nanos())
        .unwrap_or_default();
    let digest = Sha256::digest(fs::read(path).map_err(|e| e.to_string())?);
    let hash = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("{}:{modified}:{hash}", metadata.len()))
}

#[tauri::command]
pub async fn project_search(
    root: String,
    query: String,
    limit: Option<usize>,
    exclude: Option<Vec<String>>,
) -> Result<Vec<ProjectSearchMatch>, String> {
    tokio::task::spawn_blocking(move || project_search_sync(&root, &query, limit, exclude))
        .await
        .map_err(|error| format!("项目搜索任务意外终止：{error}"))?
}

fn project_search_sync(
    root: &str,
    query: &str,
    limit: Option<usize>,
    exclude: Option<Vec<String>>,
) -> Result<Vec<ProjectSearchMatch>, String> {
    let root_path = fs::canonicalize(root).map_err(|e| format!("无法访问项目根目录：{e}"))?;
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let max = limit.unwrap_or(200).clamp(1, 500);
    let needle = query.to_lowercase();
    let mut overrides = ignore::overrides::OverrideBuilder::new(&root_path);
    for entry in exclude.unwrap_or_default() {
        let _ = overrides.add(&entry);
    }
    let override_rules = overrides.build().map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    for result in ignore::WalkBuilder::new(&root_path)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .overrides(override_rules)
        .build()
    {
        let item = result.map_err(|e| e.to_string())?;
        if !item.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let Ok(metadata) = item.metadata() else {
            continue;
        };
        if metadata.len() > 1024 * 1024 {
            continue;
        }
        let Ok(content) = fs::read_to_string(item.path()) else {
            continue;
        };
        for (index, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                results.push(ProjectSearchMatch {
                    path: item
                        .path()
                        .strip_prefix(&root_path)
                        .unwrap_or(item.path())
                        .to_string_lossy()
                        .replace('\\', "/"),
                    line: (index + 1) as u32,
                    preview: line.trim().chars().take(240).collect(),
                });
                if results.len() >= max {
                    return Ok(results);
                }
            }
        }
    }
    Ok(results)
}

/// 为快速打开提供轻量索引。按文件名过滤，不读取文件内容。
#[tauri::command]
pub async fn project_index_files(
    root: String,
    query: Option<String>,
    limit: Option<usize>,
    exclude: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || project_index_files_sync(&root, query, limit, exclude))
        .await
        .map_err(|error| format!("项目文件索引任务意外终止：{error}"))?
}

#[tauri::command]
pub async fn project_index_start(
    app: AppHandle,
    state: tauri::State<'_, ProjectIndexManager>,
    root: String,
    query: Option<String>,
    limit: Option<usize>,
    exclude: Option<Vec<String>>,
) -> Result<String, String> {
    let root = project_root(&root)?;
    Ok(state.start(
        app,
        root,
        query.unwrap_or_default(),
        limit.unwrap_or(1000),
        exclude.unwrap_or_default(),
    ))
}

#[tauri::command]
pub async fn project_index_cancel(
    state: tauri::State<'_, ProjectIndexManager>,
    job_id: String,
) -> Result<(), String> {
    state.cancel(&job_id)
}

#[tauri::command]
pub async fn project_search_start(
    app: AppHandle,
    state: tauri::State<'_, ProjectSearchManager>,
    root: String,
    query: String,
    limit: Option<usize>,
    exclude: Option<Vec<String>>,
) -> Result<String, String> {
    Ok(state.start(
        app,
        project_root(&root)?,
        query,
        limit.unwrap_or(200),
        exclude.unwrap_or_default(),
    ))
}

#[tauri::command]
pub async fn project_search_cancel(
    state: tauri::State<'_, ProjectSearchManager>,
    job_id: String,
) -> Result<(), String> {
    state.cancel(&job_id);
    Ok(())
}

fn project_index_files_sync(
    root: &str,
    query: Option<String>,
    limit: Option<usize>,
    exclude: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let root_path = project_root(root)?;
    let needle = query.unwrap_or_default().trim().to_lowercase();
    let max = limit.unwrap_or(1000).clamp(1, 3000);
    let mut overrides = ignore::overrides::OverrideBuilder::new(&root_path);
    for entry in exclude.unwrap_or_default() {
        let _ = overrides.add(&entry);
    }
    let override_rules = overrides.build().map_err(|e| e.to_string())?;
    let mut paths = Vec::new();
    for result in ignore::WalkBuilder::new(&root_path)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .overrides(override_rules)
        .build()
    {
        let item = result.map_err(|e| e.to_string())?;
        if !item.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let relative = item
            .path()
            .strip_prefix(&root_path)
            .unwrap_or(item.path())
            .to_string_lossy()
            .replace('\\', "/");
        if needle.is_empty() || relative.to_lowercase().contains(&needle) {
            paths.push(relative);
            if paths.len() >= max {
                break;
            }
        }
    }
    paths.sort_by_key(|path| path.to_lowercase());
    Ok(paths)
}

#[tauri::command]
pub async fn project_create_entry(
    root: String,
    parent_path: String,
    name: String,
    directory: bool,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("名称不能包含路径分隔符".to_string());
    }
    let parent = resolve_project_path(&root, &parent_path)?;
    if !parent.is_dir() {
        return Err("目标父目录不存在".to_string());
    }
    let target = parent.join(name);
    if target.exists() {
        return Err("同名文件或文件夹已存在".to_string());
    }
    if directory {
        fs::create_dir(&target).map_err(|e| e.to_string())?;
    } else {
        fs::File::create(&target).map_err(|e| e.to_string())?;
    }
    Ok(Path::new(&parent_path)
        .join(name)
        .to_string_lossy()
        .replace('\\', "/"))
}

#[tauri::command]
pub async fn project_rename(
    root: String,
    path: String,
    new_name: String,
) -> Result<ProjectPathChange, String> {
    let source = non_root_project_path(&root, &path)?;
    let name = new_name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("名称不能包含路径分隔符".to_string());
    }
    let target = source
        .parent()
        .ok_or_else(|| "无效文件路径".to_string())?
        .join(name);
    if target.exists() {
        return Err("同名文件或文件夹已存在".to_string());
    }
    fs::rename(&source, &target).map_err(|e| e.to_string())?;
    let next_path = Path::new(&path)
        .parent()
        .unwrap_or(Path::new(""))
        .join(name)
        .to_string_lossy()
        .replace('\\', "/");
    Ok(ProjectPathChange {
        from: path,
        to: next_path,
    })
}

fn prepare_project_transfer(
    root: &str,
    paths: &[String],
    destination: &str,
) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    if paths.is_empty() {
        return Err("请选择至少一个文件或文件夹".to_string());
    }
    let destination = resolve_project_path(root, destination)?;
    if !destination.is_dir() {
        return Err("目标必须是项目内文件夹".to_string());
    }
    let mut transfers = Vec::new();
    for path in paths {
        let source = non_root_project_path(root, path)?;
        let name = source
            .file_name()
            .ok_or_else(|| "无效文件路径".to_string())?;
        let target = destination.join(name);
        if target.exists() {
            return Err(format!("目标已存在：{}", target.display()));
        }
        if destination.starts_with(&source) {
            return Err("不能将文件夹移动或复制到它自身中".to_string());
        }
        transfers.push((source, target));
    }
    Ok(transfers)
}

#[tauri::command]
pub async fn project_copy(
    root: String,
    paths: Vec<String>,
    destination: String,
) -> Result<ProjectBatchResult, String> {
    let root_path = project_root(&root)?;
    let transfers = prepare_project_transfer(&root, &paths, &destination)?;
    let mut result = ProjectBatchResult {
        completed: Vec::new(),
        failed: Vec::new(),
    };
    for (source, target) in transfers {
        let from = source
            .strip_prefix(&root_path)
            .unwrap_or(&source)
            .to_string_lossy()
            .replace('\\', "/");
        let to = target
            .strip_prefix(&root_path)
            .unwrap_or(&target)
            .to_string_lossy()
            .replace('\\', "/");
        match copy_recursively(&source, &target) {
            Ok(()) => result.completed.push(ProjectPathChange { from, to }),
            Err(error) => result
                .failed
                .push(ProjectOperationFailure { path: from, error }),
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn project_move(
    root: String,
    paths: Vec<String>,
    destination: String,
) -> Result<ProjectBatchResult, String> {
    let root_path = project_root(&root)?;
    let transfers = prepare_project_transfer(&root, &paths, &destination)?;
    let mut result = ProjectBatchResult {
        completed: Vec::new(),
        failed: Vec::new(),
    };
    for (source, target) in transfers {
        let from = source
            .strip_prefix(&root_path)
            .unwrap_or(&source)
            .to_string_lossy()
            .replace('\\', "/");
        let to = target
            .strip_prefix(&root_path)
            .unwrap_or(&target)
            .to_string_lossy()
            .replace('\\', "/");
        let operation = if fs::rename(&source, &target).is_err() {
            copy_recursively(&source, &target).and_then(|_| {
                if source.is_dir() {
                    fs::remove_dir_all(&source).map_err(|error| error.to_string())
                } else {
                    fs::remove_file(&source).map_err(|error| error.to_string())
                }
            })
        } else {
            Ok(())
        };
        match operation {
            Ok(()) => result.completed.push(ProjectPathChange { from, to }),
            Err(error) => result
                .failed
                .push(ProjectOperationFailure { path: from, error }),
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn project_batch_start(
    app: AppHandle,
    state: tauri::State<'_, ProjectBatchManager>,
    operation: String,
    root: String,
    paths: Vec<String>,
    destination: Option<String>,
    confirmed: bool,
) -> Result<String, String> {
    let operation = operation.trim().to_lowercase();
    if !matches!(operation.as_str(), "copy" | "move" | "delete") {
        return Err("不支持的项目批量操作".to_string());
    }
    if paths.is_empty() {
        return Err("请选择至少一个文件或文件夹".to_string());
    }
    if operation == "delete" && !confirmed {
        return Err("删除项目文件需要明确确认".to_string());
    }

    let manager = state.inner().clone();
    let app_for_worker = app.clone();
    if operation == "delete" {
        let preview = project_delete_preview(root.clone(), paths).await?;
        if preview.paths.is_empty() {
            return Err("请选择要删除的文件或文件夹".to_string());
        }
        let handle = manager.start(
            &app,
            operation,
            root.clone(),
            preview.paths.len() as u64,
            preview.paths.clone(),
            None,
        );
        let id = handle.id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            run_batch_delete(manager, app_for_worker, id, root, preview.paths)
        });
        return Ok(handle.id);
    }

    let destination = destination.ok_or_else(|| "复制或移动需要目标文件夹".to_string())?;
    let root_path = project_root(&root)?;
    let transfers = prepare_project_transfer(&root, &paths, &destination)?;
    let entries = transfers
        .into_iter()
        .map(|(source, target)| {
            let label = source
                .strip_prefix(&root_path)
                .unwrap_or(&source)
                .to_string_lossy()
                .replace('\\', "/");
            let target_label = target
                .strip_prefix(&root_path)
                .unwrap_or(&target)
                .to_string_lossy()
                .replace('\\', "/");
            (source, target, label, target_label)
        })
        .collect::<Vec<_>>();
    let handle = manager.start(
        &app,
        operation.clone(),
        root.clone(),
        entries.len() as u64,
        paths,
        Some(destination),
    );
    let id = handle.id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_batch_copy_move(manager, app_for_worker, id, operation, entries)
    });
    Ok(handle.id)
}

#[tauri::command]
pub async fn project_batch_cancel(
    app: AppHandle,
    state: tauri::State<'_, ProjectBatchManager>,
    id: String,
) -> Result<(), String> {
    state.cancel(&app, &id)
}

#[tauri::command]
pub async fn project_batch_list(
    state: tauri::State<'_, ProjectBatchManager>,
    root: Option<String>,
) -> Result<Vec<ProjectBatchJob>, String> {
    Ok(state.list(root.as_deref()))
}

fn run_batch_copy_move(
    manager: ProjectBatchManager,
    app: AppHandle,
    id: String,
    operation: String,
    entries: Vec<(PathBuf, PathBuf, String, String)>,
) {
    manager.update(&app, &id, |snapshot| snapshot.status = "running".into());
    for (index, (source, target, label, target_label)) in entries.iter().enumerate() {
        if manager.is_cancelled(&id) {
            let remaining = (entries.len() - index) as u64;
            manager.update(&app, &id, |snapshot| {
                snapshot.skipped += remaining;
            });
            manager.finish(&app, &id, "cancelled", None);
            return;
        }
        manager.update(&app, &id, |snapshot| {
            snapshot.current_path = Some(label.clone())
        });
        let result = if operation == "copy" {
            copy_recursively(source, target)
        } else if fs::rename(source, target).is_err() {
            copy_recursively(source, target).and_then(|_| {
                if source.is_dir() {
                    fs::remove_dir_all(source).map_err(|error| error.to_string())
                } else {
                    fs::remove_file(source).map_err(|error| error.to_string())
                }
            })
        } else {
            Ok(())
        };
        match result {
            Ok(()) => manager.update(&app, &id, |snapshot| {
                snapshot.completed += 1;
                if operation == "move" {
                    snapshot
                        .changes
                        .push(crate::session::project_batch::ProjectBatchChange {
                            from: label.clone(),
                            to: Some(target_label.clone()),
                        });
                }
            }),
            Err(error) => manager.update(&app, &id, |snapshot| {
                snapshot.failed += 1;
                snapshot
                    .failures
                    .push(crate::session::project_batch::ProjectBatchFailure {
                        path: label.clone(),
                        error,
                    });
            }),
        }
    }
    let final_job = manager.list(None).into_iter().find(|job| job.id == id);
    let status = final_job
        .map(|job| {
            if job.failed == 0 {
                "succeeded"
            } else if job.completed > 0 {
                "partial"
            } else {
                "failed"
            }
        })
        .unwrap_or("failed");
    manager.finish(&app, &id, status, None);
}

fn run_batch_delete(
    manager: ProjectBatchManager,
    app: AppHandle,
    id: String,
    root: String,
    paths: Vec<String>,
) {
    manager.update(&app, &id, |snapshot| snapshot.status = "running".into());
    for (index, path) in paths.iter().enumerate() {
        if manager.is_cancelled(&id) {
            manager.update(&app, &id, |snapshot| {
                snapshot.skipped += (paths.len() - index) as u64
            });
            manager.finish(&app, &id, "cancelled", None);
            return;
        }
        manager.update(&app, &id, |snapshot| {
            snapshot.current_path = Some(path.clone())
        });
        let result = non_root_project_path(&root, path).and_then(|absolute| {
            if absolute.is_dir() {
                fs::remove_dir_all(absolute).map_err(|error| error.to_string())
            } else {
                fs::remove_file(absolute).map_err(|error| error.to_string())
            }
        });
        match result {
            Ok(()) => manager.update(&app, &id, |snapshot| {
                snapshot.completed += 1;
                snapshot
                    .changes
                    .push(crate::session::project_batch::ProjectBatchChange {
                        from: path.clone(),
                        to: None,
                    });
            }),
            Err(error) => manager.update(&app, &id, |snapshot| {
                snapshot.failed += 1;
                snapshot
                    .failures
                    .push(crate::session::project_batch::ProjectBatchFailure {
                        path: path.clone(),
                        error,
                    });
            }),
        }
    }
    let final_job = manager.list(None).into_iter().find(|job| job.id == id);
    let status = final_job
        .map(|job| {
            if job.failed == 0 {
                "succeeded"
            } else if job.completed > 0 {
                "partial"
            } else {
                "failed"
            }
        })
        .unwrap_or("failed");
    manager.finish(&app, &id, status, None);
}

#[tauri::command]
pub async fn project_delete_preview(
    root: String,
    paths: Vec<String>,
) -> Result<ProjectDeletePreview, String> {
    let mut preview = ProjectDeletePreview {
        files: 0,
        directories: 0,
        paths: Vec::new(),
    };
    let mut paths = paths;
    paths.sort_by_key(|path| path.matches('/').count());
    for path in paths {
        if preview
            .paths
            .iter()
            .any(|parent| path == *parent || Path::new(&path).starts_with(parent))
        {
            continue;
        }
        let absolute = non_root_project_path(&root, &path)?;
        count_delete_target(&absolute, &mut preview)?;
        preview.paths.push(path);
    }
    Ok(preview)
}

#[tauri::command]
pub async fn project_delete_entries(
    root: String,
    paths: Vec<String>,
    confirmed: bool,
) -> Result<Vec<String>, String> {
    if !confirmed {
        return Err("删除项目文件需要明确确认".to_string());
    }
    // 完整预检，避免删除一部分后才发现另一路径无效。
    let preview = project_delete_preview(root.clone(), paths.clone()).await?;
    if preview.paths.is_empty() {
        return Err("请选择要删除的文件或文件夹".to_string());
    }
    let deleted = preview.paths.clone();
    for path in preview.paths {
        let absolute = non_root_project_path(&root, &path)?;
        if absolute.is_dir() {
            fs::remove_dir_all(absolute).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(absolute).map_err(|e| e.to_string())?;
        }
    }
    Ok(deleted)
}

#[tauri::command]
pub async fn project_watch_start(
    app: AppHandle,
    state: tauri::State<'_, ProjectWatchManager>,
    root: String,
    paths: Vec<String>,
    watch_id: Option<u64>,
) -> Result<(), String> {
    let root_path = project_root(&root)?;
    for path in &paths {
        let _ = non_root_project_path(&root, path)?;
    }
    state.start(app, root_path, root, paths, watch_id.unwrap_or_default());
    Ok(())
}

#[tauri::command]
pub async fn project_watch_stop(
    state: tauri::State<'_, ProjectWatchManager>,
    root: String,
    watch_id: Option<u64>,
) -> Result<(), String> {
    state.stop(&project_root(&root)?, watch_id);
    Ok(())
}

#[tauri::command]
pub async fn project_task_start(
    app: AppHandle,
    state: tauri::State<'_, TaskRunner>,
    root: String,
    task_id: String,
    label: String,
    command: String,
) -> Result<crate::session::task_runner::ProjectTaskSnapshot, String> {
    state.start(app, project_root(&root)?, task_id, label, command)
}

#[tauri::command]
pub async fn project_task_list(
    state: tauri::State<'_, TaskRunner>,
    root: String,
) -> Result<Vec<crate::session::task_runner::ProjectTaskSnapshot>, String> {
    Ok(state.list(&project_root(&root)?.to_string_lossy()))
}

#[tauri::command]
pub async fn project_task_cancel(
    app: AppHandle,
    state: tauri::State<'_, TaskRunner>,
    id: String,
) -> Result<(), String> {
    state.cancel(&app, &id)
}

// ==============================  本地 Git  ================================

/// 在本地路径执行 git 命令并返回输出。
async fn exec_local_git(repo_path: &str, git_args: &str) -> Result<String, String> {
    let output = tokio::process::Command::new("git")
        .args(["-C", repo_path])
        .args(git_args.split_whitespace())
        .output()
        .await
        .map_err(|e| format!("git exec failed: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn exec_local_git_args(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let output = tokio::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("git exec failed: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub async fn local_git_status(repo_path: String) -> Result<git_ops::GitStatusResult, String> {
    let output = exec_local_git(&repo_path, "status --porcelain=v2 --branch").await?;
    Ok(parse_status(&output))
}

#[tauri::command]
pub async fn local_git_log(
    repo_path: String,
    limit: Option<u32>,
) -> Result<Vec<git_ops::GitLogEntry>, String> {
    let n = limit.unwrap_or(50);
    let fmt = "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s";
    let output = exec_local_git(&repo_path, &format!("log -{n} {fmt} --date=short")).await?;
    Ok(parse_log(&output))
}

#[tauri::command]
pub async fn local_git_diff(
    repo_path: String,
    file: String,
) -> Result<git_ops::GitDiffResult, String> {
    let output = exec_local_git_args(&repo_path, &["diff", "--", &file]).await?;
    Ok(git_ops::GitDiffResult {
        path: file,
        diff: output,
    })
}

#[tauri::command]
pub async fn local_git_branches(repo_path: String) -> Result<Vec<git_ops::GitBranch>, String> {
    let output = exec_local_git(
        &repo_path,
        "branch --list --all --format=%(refname:short)%1f%(objectname:short)",
    )
    .await?;
    Ok(parse_branches(&output))
}

#[tauri::command]
pub async fn local_git_checkout(repo_path: String, branch: String) -> Result<(), String> {
    exec_local_git(&repo_path, &format!("checkout {branch}")).await?;
    Ok(())
}

#[tauri::command]
pub async fn local_git_add(repo_path: String, path: String) -> Result<(), String> {
    exec_local_git_args(&repo_path, &["add", "--", &path]).await?;
    Ok(())
}

#[tauri::command]
pub async fn local_git_unstage(repo_path: String, path: String) -> Result<(), String> {
    exec_local_git_args(&repo_path, &["restore", "--staged", "--", &path]).await?;
    Ok(())
}

#[tauri::command]
pub async fn local_git_commit(repo_path: String, message: String) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("提交信息不能为空".to_string());
    }
    exec_local_git_args(&repo_path, &["commit", "-m", message.trim()]).await?;
    Ok(())
}

#[tauri::command]
pub async fn local_git_push(repo_path: String) -> Result<(), String> {
    exec_local_git_args(&repo_path, &["push"]).await?;
    Ok(())
}

#[tauri::command]
pub async fn local_git_pull(repo_path: String) -> Result<(), String> {
    exec_local_git_args(&repo_path, &["pull", "--ff-only"]).await?;
    Ok(())
}

#[cfg(test)]
mod project_file_tests {
    use super::{
        count_delete_target, prepare_project_transfer, project_list_dir, resolve_project_path,
        ProjectDeletePreview,
    };

    #[test]
    fn project_file_access_cannot_escape_root() {
        let root =
            std::env::temp_dir().join(format!("simpl-ssh-project-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        assert!(resolve_project_path(root.to_str().unwrap(), "src/main.rs").is_ok());
        assert!(resolve_project_path(root.to_str().unwrap(), "../outside.txt").is_err());
        assert!(resolve_project_path(root.to_str().unwrap(), "/etc/passwd").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_transfer_rejects_existing_target_and_nested_destination() {
        let root =
            std::env::temp_dir().join(format!("simpl-ssh-project-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src/child")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        assert!(prepare_project_transfer(
            root.to_str().unwrap(),
            &["src".to_string()],
            "src/child"
        )
        .is_err());
        assert!(
            prepare_project_transfer(root.to_str().unwrap(), &["src/main.rs".to_string()], "")
                .is_ok()
        );
        std::fs::write(root.join("src/main.rs.copy"), "x").unwrap();
        let mut preview = ProjectDeletePreview {
            files: 0,
            directories: 0,
            paths: vec![],
        };
        count_delete_target(&root.join("src"), &mut preview).unwrap();
        assert_eq!((preview.files, preview.directories), (2, 2));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn project_list_dir_returns_for_registered_project_path() {
        let root = std::env::temp_dir().join(format!(
            "simpl-ssh-project-list-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("README.md"), "# test\n").unwrap();
        let entries = project_list_dir(root.to_string_lossy().to_string(), String::new(), None)
            .await
            .unwrap();
        assert_eq!(entries.len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }
}
