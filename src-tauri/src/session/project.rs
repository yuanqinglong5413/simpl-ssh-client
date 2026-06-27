//! 本地项目存储：JSON 文件持久化（参考 ProfileStore 模式）。
//!
//! 项目 = 本地路径 + 名称 + 可选分组 + 关联的 SSH 连接配置。
//! 路径：`config_dir/simpl-ssh/projects.json`

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// 一个本地项目。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    /// 本地工作目录绝对路径
    pub local_path: String,
    pub group_id: Option<String>,
    pub created_at: String,
    /// 关联的 SSH 连接配置 ID 列表
    #[serde(default)]
    pub linked_profiles: Vec<String>,
}

/// 创建/更新项目的输入。
#[derive(Debug, Deserialize)]
pub struct ProjectInput {
    pub name: String,
    pub local_path: String,
    pub group_id: Option<String>,
    #[serde(default)]
    pub linked_profiles: Vec<String>,
}

/// 项目存储。作为 Tauri State 注入。
pub struct ProjectStore {
    projects: Mutex<Vec<Project>>,
    path: PathBuf,
}

impl Default for ProjectStore {
    fn default() -> Self {
        Self::new()
    }
}

impl ProjectStore {
    /// 从磁盘加载（文件不存在则空）。
    pub fn new() -> Self {
        let path = project_path();
        let projects = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            projects: Mutex::new(projects),
            path,
        }
    }

    pub async fn list(&self) -> Vec<Project> {
        self.projects.lock().await.clone()
    }

    #[allow(dead_code)]
    pub async fn find(&self, id: &str) -> Option<Project> {
        self.projects
            .lock()
            .await
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    pub async fn create(&self, input: ProjectInput) -> Result<Project, String> {
        let project = Project {
            id: uuid::Uuid::new_v4().to_string(),
            name: input.name,
            local_path: input.local_path,
            group_id: input.group_id,
            created_at: chrono::Local::now().to_rfc3339(),
            linked_profiles: input.linked_profiles,
        };

        let mut guard = self.projects.lock().await;
        guard.push(project.clone());
        self.persist(&guard)?;
        Ok(project)
    }

    pub async fn update(&self, id: &str, input: ProjectInput) -> Result<Project, String> {
        let mut guard = self.projects.lock().await;
        let idx = guard
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| format!("project not found: {id}"))?;

        let project = &mut guard[idx];
        project.name = input.name;
        project.local_path = input.local_path;
        project.group_id = input.group_id;
        project.linked_profiles = input.linked_profiles;

        let result = project.clone();
        self.persist(&guard)?;
        Ok(result)
    }

    pub async fn delete(&self, id: &str) -> Result<(), String> {
        let mut guard = self.projects.lock().await;
        guard.retain(|p| p.id != id);
        self.persist(&guard)?;
        Ok(())
    }

    /// 删除分组时，清除所有项目对该分组的引用。
    #[allow(dead_code)]
    pub async fn clear_group_refs(&self, group_id: &str) -> Result<(), String> {
        let mut guard = self.projects.lock().await;
        let mut changed = false;
        for p in guard.iter_mut() {
            if p.group_id.as_deref() == Some(group_id) {
                p.group_id = None;
                changed = true;
            }
        }
        if changed {
            self.persist(&guard)?;
        }
        Ok(())
    }

    fn persist(&self, projects: &[Project]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(projects).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, json).map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn project_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("simpl-ssh").join("projects.json")
}
