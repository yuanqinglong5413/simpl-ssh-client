//! 后台项目文件索引。索引工作不占用 Tokio 主线程，并可被新查询取消。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct ProjectIndexProgress {
    pub job_id: String,
    pub phase: String,
    pub scanned: u64,
    pub matched: u64,
    pub done: bool,
    pub cancelled: bool,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct ProjectIndexResult {
    pub job_id: String,
    pub paths: Vec<String>,
}

#[derive(Default)]
pub struct ProjectIndexManager {
    jobs: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
}

impl ProjectIndexManager {
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
        let job_id_for_worker = job_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result = scan(
                &app,
                &job_id_for_worker,
                &root,
                &query,
                limit,
                &exclude,
                &cancelled,
            );
            if let Err(error) = result {
                let _ = app.emit(
                    "project://index-progress",
                    ProjectIndexProgress {
                        job_id: job_id_for_worker.clone(),
                        phase: "error".to_string(),
                        scanned: 0,
                        matched: 0,
                        done: true,
                        cancelled: false,
                        error: Some(error),
                    },
                );
            }
            jobs.lock().unwrap().remove(&job_id_for_worker);
        });
        job_id
    }

    pub fn cancel(&self, job_id: &str) -> Result<(), String> {
        let jobs = self.jobs.lock().unwrap();
        let Some(cancelled) = jobs.get(job_id) else {
            return Ok(());
        };
        cancelled.store(true, Ordering::Relaxed);
        Ok(())
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
    let max = limit.clamp(1, 3000);
    let mut overrides = ignore::overrides::OverrideBuilder::new(root);
    for pattern in exclude {
        let _ = overrides.add(pattern);
    }
    let override_rules = overrides.build().map_err(|error| error.to_string())?;
    let mut paths = Vec::new();
    let mut scanned = 0_u64;
    let mut matched = 0_u64;
    let _ = app.emit(
        "project://index-progress",
        ProjectIndexProgress {
            job_id: job_id.to_string(),
            phase: "scanning".to_string(),
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
        .overrides(override_rules)
        .build()
    {
        if cancelled.load(Ordering::Relaxed) {
            let _ = app.emit(
                "project://index-progress",
                ProjectIndexProgress {
                    job_id: job_id.to_string(),
                    phase: "cancelled".to_string(),
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
        let relative = item
            .path()
            .strip_prefix(root)
            .unwrap_or(item.path())
            .to_string_lossy()
            .replace('\\', "/");
        if needle.is_empty() || relative.to_lowercase().contains(&needle) {
            matched += 1;
            paths.push(relative);
            if paths.len() >= max {
                break;
            }
        }
        if scanned.is_multiple_of(100) {
            let _ = app.emit(
                "project://index-progress",
                ProjectIndexProgress {
                    job_id: job_id.to_string(),
                    phase: "scanning".to_string(),
                    scanned,
                    matched,
                    done: false,
                    cancelled: false,
                    error: None,
                },
            );
        }
    }
    paths.sort_by_key(|path| path.to_lowercase());
    let _ = app.emit(
        "project://index-result",
        ProjectIndexResult {
            job_id: job_id.to_string(),
            paths,
        },
    );
    let _ = app.emit(
        "project://index-progress",
        ProjectIndexProgress {
            job_id: job_id.to_string(),
            phase: "done".to_string(),
            scanned,
            matched,
            done: true,
            cancelled: false,
            error: None,
        },
    );
    Ok(())
}
