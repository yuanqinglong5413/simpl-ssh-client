//! 可取消的项目全文搜索任务。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct ProjectSearchProgress {
    pub job_id: String,
    pub phase: String,
    pub scanned: u64,
    pub matched: u64,
    pub done: bool,
    pub cancelled: bool,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct ProjectSearchMatch {
    pub path: String,
    pub line: u32,
    pub preview: String,
}

#[derive(Clone, Serialize)]
pub struct ProjectSearchResult {
    pub job_id: String,
    pub matches: Vec<ProjectSearchMatch>,
}

#[derive(Default, Clone)]
pub struct ProjectSearchManager {
    jobs: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
}

impl ProjectSearchManager {
    pub fn start(
        &self,
        app: AppHandle,
        root: PathBuf,
        query: String,
        limit: usize,
        exclude: Vec<String>,
    ) -> String {
        let job_id = uuid::Uuid::new_v4().to_string();
        let cancelled = Arc::new(AtomicBool::new(false));
        self.jobs
            .lock()
            .unwrap()
            .insert(job_id.clone(), cancelled.clone());
        let jobs = self.jobs.clone();
        let worker_id = job_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = scan(&app, &worker_id, &root, &query, limit, &exclude, &cancelled) {
                let _ = app.emit(
                    "project://search-progress",
                    ProjectSearchProgress {
                        job_id: worker_id.clone(),
                        phase: "error".into(),
                        scanned: 0,
                        matched: 0,
                        done: true,
                        cancelled: false,
                        error: Some(error),
                    },
                );
            }
            jobs.lock().unwrap().remove(&worker_id);
        });
        job_id
    }

    pub fn cancel(&self, job_id: &str) {
        if let Some(cancelled) = self.jobs.lock().unwrap().get(job_id) {
            cancelled.store(true, Ordering::Relaxed);
        }
    }

    pub fn cancel_all(&self) {
        for cancelled in self.jobs.lock().unwrap().values() {
            cancelled.store(true, Ordering::Release);
        }
    }
}

fn scan(
    app: &AppHandle,
    job_id: &str,
    root: &std::path::Path,
    query: &str,
    limit: usize,
    exclude: &[String],
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(());
    }
    let max = limit.clamp(1, 1000);
    let mut overrides = ignore::overrides::OverrideBuilder::new(root);
    for pattern in exclude {
        let _ = overrides.add(pattern);
    }
    let rules = overrides.build().map_err(|error| error.to_string())?;
    let mut matches = Vec::new();
    let mut scanned = 0_u64;
    let mut matched = 0_u64;
    let _ = app.emit(
        "project://search-progress",
        ProjectSearchProgress {
            job_id: job_id.into(),
            phase: "scanning".into(),
            scanned,
            matched,
            done: false,
            cancelled: false,
            error: None,
        },
    );
    for result in ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .overrides(rules)
        .build()
    {
        if cancelled.load(Ordering::Relaxed) {
            let _ = app.emit(
                "project://search-progress",
                ProjectSearchProgress {
                    job_id: job_id.into(),
                    phase: "cancelled".into(),
                    scanned,
                    matched,
                    done: true,
                    cancelled: true,
                    error: None,
                },
            );
            return Ok(());
        }
        let item = result.map_err(|error| error.to_string())?;
        scanned += 1;
        if !item.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let Ok(metadata) = item.metadata() else {
            continue;
        };
        if metadata.len() > 1024 * 1024 {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(item.path()) else {
            continue;
        };
        for (index, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                matched += 1;
                matches.push(ProjectSearchMatch {
                    path: item
                        .path()
                        .strip_prefix(root)
                        .unwrap_or(item.path())
                        .to_string_lossy()
                        .replace('\\', "/"),
                    line: (index + 1) as u32,
                    preview: line.trim().chars().take(240).collect(),
                });
                if matches.len() >= max {
                    break;
                }
            }
        }
        if scanned.is_multiple_of(20) {
            let _ = app.emit(
                "project://search-progress",
                ProjectSearchProgress {
                    job_id: job_id.into(),
                    phase: "scanning".into(),
                    scanned,
                    matched,
                    done: false,
                    cancelled: false,
                    error: None,
                },
            );
        }
        if matches.len() >= max {
            break;
        }
    }
    let _ = app.emit(
        "project://search-result",
        ProjectSearchResult {
            job_id: job_id.into(),
            matches,
        },
    );
    let _ = app.emit(
        "project://search-progress",
        ProjectSearchProgress {
            job_id: job_id.into(),
            phase: "done".into(),
            scanned,
            matched,
            done: true,
            cancelled: false,
            error: None,
        },
    );
    Ok(())
}
