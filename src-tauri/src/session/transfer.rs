//! SFTP 传输队列：串行 worker + 可取消。
//!
//! 目的：把"选文件"和"执行传输"解耦——选完立即入队返回，UI 不阻塞；
//! 多个任务排队串行执行（避免单 SSH 连接上 SFTP 并发争用）；
//! 进行中的任务可取消（`AtomicBool`，传输循环每片前检查）。
//!
//! 进度通过 `transfer://progress`（带 task_id）推送；状态变更通过 `transfer://state`
//! 推送快照。队列只存内存，进程退出即消失。

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

use crate::session::{SessionManager, SftpManager};

#[derive(Clone, Copy)]
pub enum TransferKind {
    Upload,
    UploadDir,
    Download,
}

impl TransferKind {
    pub fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "upload" => Ok(Self::Upload),
            "uploadDir" => Ok(Self::UploadDir),
            "download" => Ok(Self::Download),
            _ => Err(format!("unknown transfer kind: {s}")),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::UploadDir => "uploadDir",
            Self::Download => "download",
        }
    }
}

/// 同名文件覆盖策略。
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum OverwriteMode {
    #[default]
    Overwrite,
    /// 远端已存在则跳过。
    Skip,
    /// 仅当源比目标新才覆盖。
    IfNewer,
    /// 远端已存在则自动改名（`name (N).ext`）。
    Rename,
}

impl OverwriteMode {
    pub fn from_str(s: &str) -> Result<Self, String> {
        Ok(match s {
            "overwrite" => Self::Overwrite,
            "skip" => Self::Skip,
            "ifNewer" => Self::IfNewer,
            "rename" => Self::Rename,
            _ => return Err(format!("unknown overwrite mode: {s}")),
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Overwrite => "overwrite",
            Self::Skip => "skip",
            Self::IfNewer => "ifNewer",
            Self::Rename => "rename",
        }
    }
}

#[derive(Clone)]
pub enum TransferStatus {
    Queued,
    Running,
    Paused,
    Done,
    Failed(String),
    Cancelled,
}

impl TransferStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Done => "done",
            Self::Failed(_) => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// 一个传输任务。多字段用原子/标准锁，供 worker 写、`list()` 读。
pub struct TransferTask {
    pub id: String,
    pub session_id: String,
    pub kind: TransferKind,
    pub local_path: PathBuf,
    pub remote_path: String,
    pub name: String,
    total: AtomicU64,
    transferred: AtomicU64,
    status: StdMutex<TransferStatus>,
    cancel: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
    retry_count: AtomicU32,
    max_retries: u32,
    overwrite: StdMutex<OverwriteMode>,
}

#[derive(Serialize, Clone)]
pub struct TransferTaskSnap {
    pub id: String,
    pub session_id: String,
    pub kind: String,
    pub name: String,
    pub total: u64,
    pub transferred: u64,
    pub status: String,
    pub error: Option<String>,
    pub overwrite: String,
    pub retry_count: u32,
    pub max_retries: u32,
}

impl TransferTask {
    fn snapshot(&self) -> TransferTaskSnap {
        let status = self.status.lock().unwrap();
        let (st, err) = match &*status {
            TransferStatus::Failed(msg) => ("failed".to_string(), Some(msg.clone())),
            other => (other.as_str().to_string(), None),
        };
        TransferTaskSnap {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            kind: self.kind.as_str().to_string(),
            name: self.name.clone(),
            total: self.total.load(Ordering::Relaxed),
            transferred: self.transferred.load(Ordering::Relaxed),
            status: st,
            error: err,
            overwrite: self.overwrite.lock().unwrap().as_str().to_string(),
            retry_count: self.retry_count.load(Ordering::Relaxed),
            max_retries: self.max_retries,
        }
    }

    fn set_status(&self, s: TransferStatus) {
        *self.status.lock().unwrap() = s;
    }
}

/// 传输队列（Tauri State）。内部字段都是 Arc，worker 持其 clone 运行。
#[derive(Default)]
pub struct TransferQueue {
    tasks: Arc<Mutex<VecDeque<Arc<TransferTask>>>>,
    notify: Arc<Notify>,
}

impl TransferQueue {
    /// 入队一个任务，返回其 id。
    #[allow(clippy::too_many_arguments)]
    pub async fn enqueue(
        &self,
        session_id: String,
        kind: TransferKind,
        local_path: PathBuf,
        remote_path: String,
        name: String,
        overwrite: OverwriteMode,
        max_retries: u32,
    ) -> String {
        let task = Arc::new(TransferTask {
            id: Uuid::new_v4().to_string(),
            session_id,
            kind,
            local_path,
            remote_path,
            name,
            total: AtomicU64::new(0),
            transferred: AtomicU64::new(0),
            status: StdMutex::new(TransferStatus::Queued),
            cancel: Arc::new(AtomicBool::new(false)),
            pause: Arc::new(AtomicBool::new(false)),
            retry_count: AtomicU32::new(0),
            max_retries,
            overwrite: StdMutex::new(overwrite),
        });
        let id = task.id.clone();
        self.tasks.lock().await.push_back(task);
        self.notify.notify_one();
        id
    }

    /// 取消一个任务：设标志；仍在排队/已暂停的直接标 Cancelled，运行中的在下次读片前中断。
    pub async fn cancel(&self, id: &str) {
        let tasks = self.tasks.lock().await;
        if let Some(t) = tasks.iter().find(|t| t.id == id) {
            t.cancel.store(true, Ordering::Relaxed);
            let mut s = t.status.lock().unwrap();
            if matches!(*s, TransferStatus::Queued | TransferStatus::Paused) {
                *s = TransferStatus::Cancelled;
            }
        }
    }

    /// 暂停一个任务：Queued 直接标 Paused；Running 设 pause 标志，worker 在下次读片前停下。
    pub async fn pause(&self, id: &str) {
        let tasks = self.tasks.lock().await;
        if let Some(t) = tasks.iter().find(|t| t.id == id) {
            t.pause.store(true, Ordering::Relaxed);
            let mut s = t.status.lock().unwrap();
            if matches!(*s, TransferStatus::Queued) {
                *s = TransferStatus::Paused;
            }
        }
    }

    /// 继续一个暂停的任务：清 pause 标志，Paused→Queued 并唤醒 worker。
    pub async fn resume(&self, id: &str) {
        let need_notify = {
            let tasks = self.tasks.lock().await;
            let Some(t) = tasks.iter().find(|t| t.id == id) else {
                return;
            };
            t.pause.store(false, Ordering::Relaxed);
            let mut s = t.status.lock().unwrap();
            if matches!(*s, TransferStatus::Paused) {
                *s = TransferStatus::Queued;
                true
            } else {
                false
            }
        };
        if need_notify {
            self.notify.notify_one();
        }
    }

    /// 重试一个已结束（Failed/Cancelled/Done/Paused）的任务：复位并重新入队。
    /// 批 1 为从头重传（断点续传见后续）。
    pub async fn retry(&self, id: &str) {
        let need_notify = {
            let tasks = self.tasks.lock().await;
            let Some(t) = tasks.iter().find(|t| t.id == id) else {
                return;
            };
            let mut s = t.status.lock().unwrap();
            let retryable = matches!(
                *s,
                TransferStatus::Failed(_) | TransferStatus::Cancelled | TransferStatus::Done | TransferStatus::Paused
            );
            if retryable {
                t.cancel.store(false, Ordering::Relaxed);
                t.pause.store(false, Ordering::Relaxed);
                t.transferred.store(0, Ordering::Relaxed);
                t.retry_count.fetch_add(1, Ordering::Relaxed);
                *s = TransferStatus::Queued;
                true
            } else {
                false
            }
        };
        if need_notify {
            self.notify.notify_one();
        }
    }

    /// 清除所有已结束的任务（Done/Cancelled/Failed）。
    pub async fn clear_done(&self) -> usize {
        let mut guard = self.tasks.lock().await;
        let before = guard.len();
        guard.retain(|t| {
            !matches!(
                *t.status.lock().unwrap(),
                TransferStatus::Done | TransferStatus::Cancelled | TransferStatus::Failed(_)
            )
        });
        before - guard.len()
    }

    /// 所有任务的快照（供前端轮询）。
    pub async fn list(&self) -> Vec<TransferTaskSnap> {
        self.tasks
            .lock()
            .await
            .iter()
            .map(|t| t.snapshot())
            .collect()
    }

    /// 启动 worker（lib.rs setup 调一次）。单 worker 串行。
    pub fn start_worker(&self, app: AppHandle) {
        let tasks = self.tasks.clone();
        let notify = self.notify.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                notify.notified().await;
                loop {
                    // 原子领取：find(Queued) + set(Running) 在同一锁闭包，杜绝多 worker 重复领取
                    let task = {
                        let guard = tasks.lock().await;
                        let mut found = None;
                        for t in guard.iter() {
                            let mut s = t.status.lock().unwrap();
                            if matches!(*s, TransferStatus::Queued) {
                                *s = TransferStatus::Running;
                                found = Some(t.clone());
                                break;
                            }
                        }
                        found
                    };
                    let Some(task) = task else { break };
                    let _ = app.emit("transfer://state", task.snapshot());
                    execute(&app, &task).await;
                    let _ = app.emit("transfer://state", task.snapshot());
                }
            }
        });
    }
}

/// 执行单个任务（取 sftp、算 total、调递归、设最终状态）。
async fn execute(app: &AppHandle, task: &TransferTask) {
    let sftp = {
        let sftp_mgr = app.state::<SftpManager>();
        let sessions = app.state::<SessionManager>();
        match sftp_mgr.get(sessions.inner(), &task.session_id).await {
            Ok(s) => s,
            Err(e) => {
                task.set_status(TransferStatus::Failed(e));
                return;
            }
        }
    };
    let overwrite = *task.overwrite.lock().unwrap();

    // 总大小：单文件可精确，目录用 0（前端显示 indeterminate）
    let total: u64 = match task.kind {
        TransferKind::Upload => tokio::fs::metadata(&task.local_path)
            .await
            .ok()
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .unwrap_or(0),
        TransferKind::UploadDir => 0,
        TransferKind::Download => sftp
            .metadata(&task.remote_path)
            .await
            .ok()
            .filter(|m| !m.is_dir())
            .map(|m| m.len())
            .unwrap_or(0),
    };
    task.total.store(total, Ordering::Relaxed);

    let res = match task.kind {
        TransferKind::Upload | TransferKind::UploadDir => {
            upload_recursive(
                &sftp, &task.local_path, &task.remote_path, app, &task.id,
                &task.cancel, &task.pause, &task.transferred, total, overwrite,
            ).await
        }
        TransferKind::Download => {
            download_recursive(
                &sftp, &task.remote_path, &task.local_path, app, &task.id,
                &task.cancel, &task.pause, &task.transferred, total, overwrite,
            ).await
        }
    };

    match res {
        Ok(()) => task.set_status(TransferStatus::Done),
        Err(e) if e == "cancelled" => {
            task.set_status(TransferStatus::Cancelled);
            cleanup_partial(&sftp, task).await;
        }
        Err(e) if e == "paused" => {
            // 保留半成品；批 1 resume 会从头重传（断点续传见后续）
            task.set_status(TransferStatus::Paused);
        }
        Err(e) => task.set_status(TransferStatus::Failed(e)),
    }
}

/// 清理单文件半成品（仅 cancel 用；paused/failed 保留以便后续续传）。
async fn cleanup_partial(sftp: &SftpSession, task: &TransferTask) {
    match task.kind {
        TransferKind::Upload => {
            let _ = sftp.remove_file(&task.remote_path).await;
        }
        TransferKind::Download => {
            let _ = tokio::fs::remove_file(&task.local_path).await;
        }
        _ => {}
    }
}

#[derive(Serialize, Clone)]
pub struct TransferProgress {
    pub task_id: String,
    pub name: String,
    pub transferred: u64,
    pub total: u64,
}

// ============================  递归传输（可取消）============================

#[allow(clippy::too_many_arguments)]
async fn upload_recursive(
    sftp: &SftpSession,
    local: &Path,
    remote: &str,
    app: &AppHandle,
    task_id: &str,
    cancel: &AtomicBool,
    pause: &AtomicBool,
    transferred: &AtomicU64,
    total: u64,
    overwrite: OverwriteMode,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    if pause.load(Ordering::Relaxed) {
        return Err("paused".into());
    }
    if local.is_dir() {
        let _ = sftp.create_dir(remote).await;
        let mut rd = tokio::fs::read_dir(local)
            .await
            .map_err(|e| e.to_string())?;
        while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            if pause.load(Ordering::Relaxed) {
                return Err("paused".into());
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let rpath = join_remote(remote, &name);
            Box::pin(upload_recursive(
                sftp, &entry.path(), &rpath, app, task_id, cancel, pause, transferred, total, overwrite,
            ))
            .await?;
        }
        return Ok(());
    }

    // 覆盖决策（叶子文件）；None 表示 Skip 跳过
    let Some(target) = resolve_upload_target(sftp, remote, local, overwrite).await? else {
        return Ok(());
    };
    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let mut local_f = tokio::fs::File::open(local)
        .await
        .map_err(|e| e.to_string())?;
    let mut remote_f = sftp
        .open_with_flags(&target, OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE)
        .await
        .map_err(|e| e.to_string())?;
    stream_with_progress(
        app, task_id, cancel, pause, transferred, total, &name, &mut local_f, &mut remote_f,
    )
    .await?;
    remote_f.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn download_recursive(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    app: &AppHandle,
    task_id: &str,
    cancel: &AtomicBool,
    pause: &AtomicBool,
    transferred: &AtomicU64,
    total: u64,
    overwrite: OverwriteMode,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    if pause.load(Ordering::Relaxed) {
        return Err("paused".into());
    }
    let meta = sftp.metadata(remote).await.map_err(|e| e.to_string())?;
    if meta.is_dir() {
        tokio::fs::create_dir_all(local)
            .await
            .map_err(|e| e.to_string())?;
        let read = sftp.read_dir(remote).await.map_err(|e| e.to_string())?;
        for entry in read {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            if pause.load(Ordering::Relaxed) {
                return Err("paused".into());
            }
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            if entry.metadata().is_symlink() {
                continue;
            }
            let rpath = join_remote(remote, &name);
            let lpath = local.join(&name);
            Box::pin(download_recursive(
                sftp, &rpath, &lpath, app, task_id, cancel, pause, transferred, total, overwrite,
            ))
            .await?;
        }
        return Ok(());
    }

    // 覆盖决策（本地叶子文件）；None 表示 Skip 跳过
    let Some(target) = resolve_download_target(local, remote, sftp, overwrite).await? else {
        return Ok(());
    };
    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let mut remote_f = sftp.open(remote).await.map_err(|e| e.to_string())?;
    let mut local_f = tokio::fs::File::create(&target)
        .await
        .map_err(|e| e.to_string())?;
    stream_with_progress(
        app, task_id, cancel, pause, transferred, total, &name, &mut remote_f, &mut local_f,
    )
    .await?;
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

/// 通用流式拷贝 + 进度事件。循环前检查 cancel/pause；进度 emit 时间节流（≥100ms）。
#[allow(clippy::too_many_arguments)]
async fn stream_with_progress(
    app: &AppHandle,
    task_id: &str,
    cancel: &AtomicBool,
    pause: &AtomicBool,
    transferred: &AtomicU64,
    total: u64,
    name: &str,
    src: &mut (impl AsyncRead + Unpin),
    dst: &mut (impl AsyncWrite + Unpin),
) -> Result<(), String> {
    let mut buf = vec![0u8; 65536];
    let mut last_emit = std::time::Instant::now();
    const MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        if pause.load(Ordering::Relaxed) {
            return Err("paused".into());
        }
        let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        transferred.fetch_add(n as u64, Ordering::Relaxed);
        let done = transferred.load(Ordering::Relaxed);
        if last_emit.elapsed() >= MIN_INTERVAL {
            emit_progress(app, task_id, name, done, total);
            last_emit = std::time::Instant::now();
        }
    }
    // 收尾强制 emit 一次，保证前端终态对齐
    emit_progress(app, task_id, name, transferred.load(Ordering::Relaxed), total);
    Ok(())
}

fn emit_progress(app: &AppHandle, task_id: &str, name: &str, transferred: u64, total: u64) {
    let _ = app.emit(
        "transfer://progress",
        TransferProgress {
            task_id: task_id.to_string(),
            name: name.to_string(),
            transferred,
            total,
        },
    );
}

/// 上传覆盖决策：返回最终远端目标路径；None 表示跳过。
/// Rename 暂按 Overwrite 处理（自动改名见后续）。
async fn resolve_upload_target(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    mode: OverwriteMode,
) -> Result<Option<String>, String> {
    if sftp.metadata(remote).await.is_err() {
        return Ok(Some(remote.to_string()));
    }
    Ok(match mode {
        OverwriteMode::Skip => None,
        OverwriteMode::Overwrite => Some(remote.to_string()),
        OverwriteMode::Rename => Some(pick_rename_target(sftp, remote).await?),
        OverwriteMode::IfNewer => {
            let local_mt = tokio::fs::metadata(local)
                .await
                .ok()
                .and_then(|m| m.modified().ok());
            let remote_mt = sftp
                .metadata(remote)
                .await
                .ok()
                .and_then(|m| m.modified().ok());
            match (local_mt, remote_mt) {
                (Some(l), Some(r)) if l > r => Some(remote.to_string()),
                _ => None,
            }
        }
    })
}

/// 下载覆盖决策：返回最终本地目标路径；None 表示跳过。
async fn resolve_download_target(
    local: &Path,
    remote: &str,
    sftp: &SftpSession,
    mode: OverwriteMode,
) -> Result<Option<String>, String> {
    if !local.exists() {
        return Ok(Some(local.to_string_lossy().into_owned()));
    }
    Ok(match mode {
        OverwriteMode::Skip => None,
        OverwriteMode::Overwrite => Some(local.to_string_lossy().into_owned()),
        OverwriteMode::Rename => Some(pick_rename_target_local(local).await?),
        OverwriteMode::IfNewer => {
            let local_mt = tokio::fs::metadata(local)
                .await
                .ok()
                .and_then(|m| m.modified().ok());
            let remote_mt = sftp
                .metadata(remote)
                .await
                .ok()
                .and_then(|m| m.modified().ok());
            match (local_mt, remote_mt) {
                (Some(l), Some(r)) if r > l => Some(local.to_string_lossy().into_owned()),
                _ => None,
            }
        }
    })
}

/// 拆路径为 (去扩展名的部分, 含点扩展名)；无扩展名或隐藏文件（.bashrc）则 ext 为空。
fn split_ext(path: &str) -> (String, String) {
    let base_start = path.rfind('/').map(|i| i + 1).unwrap_or(0);
    let base = &path[base_start..];
    match base.rsplit_once('.') {
        Some((_, e)) if !e.is_empty() && base.len() > e.len() + 1 => {
            (path[..path.len() - e.len() - 1].to_string(), format!(".{e}"))
        }
        _ => (path.to_string(), String::new()),
    }
}

/// 远端 Rename：找 `name (N).ext` 第一个不存在的候选。
async fn pick_rename_target(sftp: &SftpSession, remote: &str) -> Result<String, String> {
    let (stem, ext) = split_ext(remote);
    for i in 1..=9999u32 {
        let cand = format!("{stem} ({i}){ext}");
        if sftp.metadata(&cand).await.is_err() {
            return Ok(cand);
        }
    }
    Err("rename: 目标已存在太多副本".into())
}

/// 本地 Rename：找 `name (N).ext` 第一个不存在的候选。
async fn pick_rename_target_local(local: &Path) -> Result<String, String> {
    let s = local.to_string_lossy();
    let (stem, ext) = split_ext(&s);
    for i in 1..=9999u32 {
        let cand = format!("{stem} ({i}){ext}");
        if !tokio::fs::try_exists(std::path::Path::new(&cand))
            .await
            .unwrap_or(false)
        {
            return Ok(cand);
        }
    }
    Err("rename: 目标已存在太多副本".into())
}
