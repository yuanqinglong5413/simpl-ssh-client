//! 项目批量文件操作的运行期任务状态。
//!
//! 实际文件操作仍由 commands 模块执行；本模块只负责任务生命周期、取消信号、
//! 进度事件和最近 20 条运行记录。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct ProjectBatchFailure {
    pub path: String,
    pub error: String,
}

#[derive(Clone, Serialize)]
pub struct ProjectBatchChange {
    pub from: String,
    pub to: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct ProjectBatchJob {
    pub id: String,
    pub operation: String,
    pub root: String,
    pub total: u64,
    pub completed: u64,
    pub failed: u64,
    pub skipped: u64,
    pub current_path: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub failures: Vec<ProjectBatchFailure>,
    pub paths: Vec<String>,
    pub destination: Option<String>,
    pub changes: Vec<ProjectBatchChange>,
}

struct JobRecord {
    snapshot: Mutex<ProjectBatchJob>,
    cancel: Arc<AtomicBool>,
}

pub struct ProjectBatchHandle {
    pub id: String,
}

#[derive(Clone, Default)]
pub struct ProjectBatchManager {
    jobs: Arc<Mutex<HashMap<String, Arc<JobRecord>>>>,
    order: Arc<Mutex<VecDeque<String>>>,
}

impl ProjectBatchManager {
    pub fn start(
        &self,
        app: &AppHandle,
        operation: String,
        root: String,
        total: u64,
        paths: Vec<String>,
        destination: Option<String>,
    ) -> ProjectBatchHandle {
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        let record = Arc::new(JobRecord {
            snapshot: Mutex::new(ProjectBatchJob {
                id: id.clone(),
                operation,
                root,
                total,
                completed: 0,
                failed: 0,
                skipped: 0,
                current_path: None,
                status: "queued".into(),
                error: None,
                failures: Vec::new(),
                paths,
                destination,
                changes: Vec::new(),
            }),
            cancel: cancel.clone(),
        });
        self.jobs.lock().unwrap().insert(id.clone(), record);
        self.order.lock().unwrap().push_back(id.clone());
        self.emit_state(app, &id);
        ProjectBatchHandle { id }
    }

    pub fn cancel(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let record = self
            .jobs
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "批量任务不存在".to_string())?;
        record.cancel.store(true, Ordering::Relaxed);
        let mut snapshot = record.snapshot.lock().unwrap();
        if matches!(snapshot.status.as_str(), "queued" | "running") {
            snapshot.status = "cancelling".into();
        }
        drop(snapshot);
        self.emit_state(app, id);
        Ok(())
    }

    pub fn is_cancelled(&self, id: &str) -> bool {
        self.jobs
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|record| record.cancel.load(Ordering::Relaxed))
    }

    pub fn update<F>(&self, app: &AppHandle, id: &str, update: F)
    where
        F: FnOnce(&mut ProjectBatchJob),
    {
        if let Some(record) = self.jobs.lock().unwrap().get(id).cloned() {
            update(&mut record.snapshot.lock().unwrap());
            self.emit_progress(app, id);
            self.emit_state(app, id);
        }
    }

    pub fn finish(&self, app: &AppHandle, id: &str, status: &str, error: Option<String>) {
        self.update(app, id, |snapshot| {
            snapshot.status = status.to_string();
            snapshot.current_path = None;
            snapshot.error = error;
        });
        self.prune_completed();
    }

    pub fn list(&self, root: Option<&str>) -> Vec<ProjectBatchJob> {
        let jobs = self.jobs.lock().unwrap();
        let order = self.order.lock().unwrap();
        order
            .iter()
            .filter_map(|id| jobs.get(id))
            .filter_map(|record| {
                let snapshot = record.snapshot.lock().unwrap().clone();
                if root.is_none_or(|value| value == snapshot.root) {
                    Some(snapshot)
                } else {
                    None
                }
            })
            .collect()
    }

    fn emit_state(&self, app: &AppHandle, id: &str) {
        if let Some(record) = self.jobs.lock().unwrap().get(id).cloned() {
            let snapshot = record.snapshot.lock().unwrap().clone();
            let _ = app.emit("project-batch://state", snapshot);
        }
    }

    fn emit_progress(&self, app: &AppHandle, id: &str) {
        if let Some(record) = self.jobs.lock().unwrap().get(id).cloned() {
            let snapshot = record.snapshot.lock().unwrap().clone();
            let _ = app.emit("project-batch://progress", snapshot);
        }
    }

    fn prune_completed(&self) {
        let mut jobs = self.jobs.lock().unwrap();
        let mut order = self.order.lock().unwrap();
        while order.len() > 20 {
            let candidate = order.iter().position(|id| {
                jobs.get(id).is_some_and(|record| {
                    let snapshot = record.snapshot.lock().unwrap();
                    !matches!(
                        snapshot.status.as_str(),
                        "queued" | "running" | "cancelling"
                    )
                })
            });
            let Some(index) = candidate else { break };
            if let Some(id) = order.remove(index) {
                jobs.remove(&id);
            }
        }
    }
}
