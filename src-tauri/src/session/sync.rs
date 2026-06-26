//! 目录同步：比对本地与远程目录树，按较新时间戳生成传输计划并入队。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use russh_sftp::client::SftpSession;
use serde::Serialize;

use super::transfer::{TransferKind, TransferQueue};

/// 同步方向：镜像（双向较新覆盖）/ 仅上传 / 仅下载。
#[derive(Debug, Clone, Copy)]
pub enum SyncMode {
    Mirror,
    Upload,
    Download,
}

impl SyncMode {
    pub fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "mirror" => Ok(Self::Mirror),
            "upload" => Ok(Self::Upload),
            "download" => Ok(Self::Download),
            _ => Err(format!("unknown sync mode: {s}")),
        }
    }
}

#[derive(Debug, Clone)]
struct FileMeta {
    size: u64,
    modified: Option<SystemTime>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncPlanResult {
    pub upload_count: usize,
    pub download_count: usize,
    pub task_ids: Vec<String>,
}

/// 执行目录同步：扫描 → 比对 → 入传输队列。
pub async fn run_directory_sync(
    sftp: &SftpSession,
    queue: &TransferQueue,
    session_id: &str,
    local_dir: &Path,
    remote_dir: &str,
    mode: SyncMode,
) -> Result<SyncPlanResult, String> {
    let local = scan_local(local_dir).await?;
    let remote = scan_remote(sftp, remote_dir).await?;

    let mut uploads: Vec<(PathBuf, String)> = Vec::new();
    let mut downloads: Vec<(String, PathBuf)> = Vec::new();

    let all_keys: std::collections::HashSet<String> =
        local.keys().chain(remote.keys()).cloned().collect();

    for rel in all_keys {
        match (local.get(&rel), remote.get(&rel)) {
            (Some(_), None) => {
                if matches!(mode, SyncMode::Mirror | SyncMode::Upload) {
                    uploads.push((local_dir.join(&rel), join_remote(remote_dir, &rel)));
                }
            }
            (None, Some(_)) => {
                if matches!(mode, SyncMode::Mirror | SyncMode::Download) {
                    downloads.push((join_remote(remote_dir, &rel), local_dir.join(&rel)));
                }
            }
            (Some(l), Some(r)) => {
                let l_newer = is_newer(l.modified, r.modified);
                let r_newer = is_newer(r.modified, l.modified);
                match mode {
                    SyncMode::Upload if l_newer || l.size != r.size => {
                        uploads.push((local_dir.join(&rel), join_remote(remote_dir, &rel)));
                    }
                    SyncMode::Download if r_newer || l.size != r.size => {
                        downloads.push((join_remote(remote_dir, &rel), local_dir.join(&rel)));
                    }
                    SyncMode::Mirror => {
                        if l_newer && !r_newer {
                            uploads.push((local_dir.join(&rel), join_remote(remote_dir, &rel)));
                        } else if r_newer && !l_newer {
                            downloads.push((join_remote(remote_dir, &rel), local_dir.join(&rel)));
                        } else if l.size != r.size {
                            uploads.push((local_dir.join(&rel), join_remote(remote_dir, &rel)));
                        }
                    }
                    SyncMode::Upload | SyncMode::Download => {}
                }
            }
            (None, None) => {}
        }
    }

    let upload_count = uploads.len();
    let download_count = downloads.len();

    let mut task_ids = Vec::new();
    for (local_path, remote_path) in uploads {
        let name = format!(
            "同步↑ {}",
            local_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
        );
        let id = queue
            .enqueue(
                session_id.to_string(),
                TransferKind::Upload,
                local_path,
                remote_path,
                name,
            )
            .await;
        task_ids.push(id);
    }
    for (remote_path, local_path) in downloads {
        let name = format!(
            "同步↓ {}",
            remote_path
                .rsplit('/')
                .find(|s| !s.is_empty())
                .unwrap_or("file")
        );
        let id = queue
            .enqueue(
                session_id.to_string(),
                TransferKind::Download,
                local_path,
                remote_path,
                name,
            )
            .await;
        task_ids.push(id);
    }

    Ok(SyncPlanResult {
        upload_count,
        download_count,
        task_ids,
    })
}

async fn scan_local(root: &Path) -> Result<HashMap<String, FileMeta>, String> {
    let mut map = HashMap::new();
    scan_local_inner(root, root, &mut map).await?;
    Ok(map)
}

async fn scan_local_inner(
    root: &Path,
    dir: &Path,
    map: &mut HashMap<String, FileMeta>,
) -> Result<(), String> {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let mut rd = tokio::fs::read_dir(&current)
            .await
            .map_err(|e| e.to_string())?;
        while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
            let path = entry.path();
            let meta = entry.metadata().await.map_err(|e| e.to_string())?;
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                let rel = path
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                map.insert(
                    rel,
                    FileMeta {
                        size: meta.len(),
                        modified: meta.modified().ok(),
                    },
                );
            }
        }
    }
    Ok(())
}

async fn scan_remote(sftp: &SftpSession, dir: &str) -> Result<HashMap<String, FileMeta>, String> {
    let mut map = HashMap::new();
    scan_remote_inner(sftp, dir, dir, &mut map).await?;
    Ok(map)
}

async fn scan_remote_inner(
    sftp: &SftpSession,
    root: &str,
    dir: &str,
    map: &mut HashMap<String, FileMeta>,
) -> Result<(), String> {
    let mut stack = vec![dir.to_string()];
    while let Some(current) = stack.pop() {
        let entries = sftp.read_dir(&current).await.map_err(|e| e.to_string())?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            if entry.metadata().is_symlink() {
                continue;
            }
            let full = join_remote(&current, &name);
            if entry.metadata().is_dir() {
                stack.push(full);
            } else {
                let rel = remote_relative(root, &full);
                let modified = entry
                    .metadata()
                    .mtime
                    .map(|t| SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(t as u64));
                map.insert(
                    rel,
                    FileMeta {
                        size: entry.metadata().size.unwrap_or(0),
                        modified,
                    },
                );
            }
        }
    }
    Ok(())
}

fn remote_relative(root: &str, full: &str) -> String {
    let root = root.trim_end_matches('/');
    let full = full.trim_start_matches('/');
    if full == root.trim_start_matches('/') {
        return String::new();
    }
    if let Some(stripped) = full.strip_prefix(root.trim_start_matches('/')) {
        stripped.trim_start_matches('/').to_string()
    } else {
        full.to_string()
    }
}

fn join_remote(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "/" {
        format!("/{name}")
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn is_newer(a: Option<SystemTime>, b: Option<SystemTime>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => x > y,
        (Some(_), None) => true,
        _ => false,
    }
}
