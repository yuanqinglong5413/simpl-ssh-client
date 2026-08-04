//! 项目文件监听：使用轻量轮询，只监听已打开项目中的文件。
//!
//! 不把整棵项目树常驻在后台扫描；前端每次工作台激活时只登记已打开的
//! 文本文件，关闭/隐藏工作台后立即取消登记。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, PartialEq, Eq)]
struct FileStamp {
    modified: Option<SystemTime>,
    size: u64,
    fingerprint: u64,
}

#[derive(Default)]
struct WatchRegistration {
    generation: u64,
    paths: HashSet<String>,
    stamps: HashMap<String, Option<FileStamp>>,
}

#[derive(Serialize, Clone)]
pub struct ProjectFileChanged {
    pub root: String,
    pub path: String,
    /// `changed` 或 `deleted`，由前端决定是否重新加载或显示冲突处理。
    pub kind: String,
}

/// 每个根目录最多一个轮询循环。轮询能跨 macOS/Windows/Linux 正常工作，
/// 并避免文件监听 crate 在网络盘、Git checkout 时的事件风暴差异。
#[derive(Default)]
pub struct ProjectWatchManager {
    watches: Arc<Mutex<HashMap<String, WatchRegistration>>>,
    running: Arc<Mutex<HashSet<String>>>,
}

impl ProjectWatchManager {
    pub fn start(
        &self,
        app: AppHandle,
        root: PathBuf,
        event_root: String,
        paths: Vec<String>,
        generation: u64,
    ) {
        let key = root.to_string_lossy().into_owned();
        {
            let mut watches = self.watches.lock().unwrap();
            let entry = watches.entry(key.clone()).or_default();
            entry.generation = generation;
            entry.paths = paths.into_iter().collect();
            entry.stamps.retain(|path, _| entry.paths.contains(path));
            for path in &entry.paths {
                entry
                    .stamps
                    .entry(path.clone())
                    .or_insert_with(|| stamp(&root, path));
            }
        }

        // 只有首次登记根目录时启动循环。
        let should_spawn = self.running.lock().unwrap().insert(key.clone());
        if should_spawn {
            let watches = self.watches.clone();
            let running = self.running.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(850)).await;
                    let changes = {
                        let mut registrations = watches.lock().unwrap();
                        let Some(registration) = registrations.get_mut(&key) else {
                            break;
                        };
                        if registration.paths.is_empty() {
                            registrations.remove(&key);
                            break;
                        }
                        let mut changes = Vec::new();
                        for path in registration.paths.clone() {
                            let next = stamp(&root, &path);
                            let previous = registration
                                .stamps
                                .insert(path.clone(), next.clone())
                                .flatten();
                            if let Some(previous) = previous {
                                if Some(previous) != next {
                                    changes.push(ProjectFileChanged {
                                        root: event_root.clone(),
                                        path,
                                        kind: if next.is_some() {
                                            "changed".to_string()
                                        } else {
                                            "deleted".to_string()
                                        },
                                    });
                                }
                            }
                        }
                        changes
                    };
                    for change in changes {
                        let _ = app.emit("project://file-changed", change);
                    }
                }
                running.lock().unwrap().remove(&key);
            });
        }
    }

    pub fn stop(&self, root: &std::path::Path, generation: Option<u64>) {
        let key = root.to_string_lossy().into_owned();
        let mut watches = self.watches.lock().unwrap();
        if generation.is_none()
            || watches
                .get(&key)
                .is_some_and(|registration| Some(registration.generation) == generation)
        {
            watches.remove(&key);
        }
    }

    pub fn stop_all(&self) {
        self.watches.lock().unwrap().clear();
    }
}

fn stamp(root: &std::path::Path, relative_path: &str) -> Option<FileStamp> {
    let path = root.join(relative_path);
    let metadata = fs::symlink_metadata(path).ok()?;
    // A file replaced by a symlink must not make the watcher follow it outside
    // the project root. Treat that transition as a deletion/change instead.
    if metadata.file_type().is_symlink() {
        return None;
    }
    Some(FileStamp {
        modified: metadata.modified().ok(),
        size: metadata.len(),
        fingerprint: fs::read(root.join(relative_path))
            .map(|bytes| {
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                bytes.hash(&mut hasher);
                hasher.finish()
            })
            .unwrap_or_default(),
    })
}
