//! 本地项目存储：SQLite 事务持久化（参考 ProfileStore 模式）。
//!
//! 项目 = 本地路径 + 名称 + 可选分组 + 关联的 SSH 连接配置。
//! 旧 `projects.json` 仅作为首次迁移来源和只读备份保留。

use std::{collections::HashSet, sync::Arc};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::storage::AppDatabase;

/// 项目与远程环境的关联。`remote_path` 为空时使用 SSH 登录后的默认目录。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectRemoteWorkspace {
    pub profile_id: String,
    #[serde(default)]
    pub remote_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectAgentBinding {
    pub preset_id: String,
    #[serde(default)]
    pub command_override: Option<String>,
}

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
    /// 关联配置对应的远程根目录。兼容旧项目：缺失时从 linked_profiles 推导。
    #[serde(default)]
    pub remote_workspaces: Vec<ProjectRemoteWorkspace>,
    #[serde(default)]
    pub agent_bindings: Vec<ProjectAgentBinding>,
}

/// 创建/更新项目的输入。
#[derive(Debug, Deserialize)]
pub struct ProjectInput {
    pub name: String,
    pub local_path: String,
    pub group_id: Option<String>,
    #[serde(default)]
    pub linked_profiles: Vec<String>,
    #[serde(default)]
    pub remote_workspaces: Vec<ProjectRemoteWorkspace>,
    #[serde(default)]
    pub agent_bindings: Vec<ProjectAgentBinding>,
}

/// 项目存储。作为 Tauri State 注入。
pub struct ProjectStore {
    projects: Mutex<Vec<Project>>,
    database: Arc<AppDatabase>,
}

impl Default for ProjectStore {
    fn default() -> Self {
        Self::new(Arc::new(AppDatabase::default()))
    }
}

impl ProjectStore {
    /// 从 SQLite 加载（没有项目则为空）。
    pub fn new(database: Arc<AppDatabase>) -> Self {
        let projects = database.load("projects").ok().flatten().unwrap_or_default();
        Self {
            projects: Mutex::new(projects),
            database,
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
        let (linked_profiles, remote_workspaces) =
            normalize_workspaces(input.linked_profiles, input.remote_workspaces);
        let project = Project {
            id: uuid::Uuid::new_v4().to_string(),
            name: input.name,
            local_path: input.local_path,
            group_id: input.group_id,
            created_at: chrono::Local::now().to_rfc3339(),
            linked_profiles,
            remote_workspaces,
            agent_bindings: normalize_agent_bindings(input.agent_bindings),
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
        let (linked_profiles, remote_workspaces) =
            normalize_workspaces(input.linked_profiles, input.remote_workspaces);
        project.linked_profiles = linked_profiles;
        project.remote_workspaces = remote_workspaces;
        project.agent_bindings = normalize_agent_bindings(input.agent_bindings);

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

    pub async fn count_in_groups(&self, group_ids: &[String]) -> usize {
        self.projects
            .lock()
            .await
            .iter()
            .filter(|project| {
                project
                    .group_id
                    .as_ref()
                    .is_some_and(|id| group_ids.contains(id))
            })
            .count()
    }

    /// 只删除 Simpl SSH 项目记录；绝不触碰 `local_path` 指向的物理目录。
    pub async fn delete_in_groups(&self, group_ids: &[String]) -> Result<usize, String> {
        let mut guard = self.projects.lock().await;
        let before = guard.len();
        guard.retain(|project| {
            !project
                .group_id
                .as_ref()
                .is_some_and(|id| group_ids.contains(id))
        });
        let removed = before - guard.len();
        if removed > 0 {
            self.persist(&guard)?;
        }
        Ok(removed)
    }

    pub async fn remap_group_ids(
        &self,
        mapping: &std::collections::HashMap<String, String>,
    ) -> Result<(), String> {
        let mut guard = self.projects.lock().await;
        let mut changed = false;
        for project in guard.iter_mut() {
            if let Some(next) = project
                .group_id
                .as_ref()
                .and_then(|id| mapping.get(id))
                .cloned()
            {
                project.group_id = Some(next);
                changed = true;
            }
        }
        if changed {
            self.persist(&guard)?;
        }
        Ok(())
    }

    /// 删除不存在的 Agent 预设引用。预设存储在前端设置中，因而由调用方传入有效 ID。
    pub async fn prune_agent_bindings(&self, preset_ids: Vec<String>) -> Result<usize, String> {
        let allowed: HashSet<String> = preset_ids
            .into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect();
        let mut guard = self.projects.lock().await;
        let mut removed = 0;
        for project in guard.iter_mut() {
            removed += retain_known_agent_bindings(&mut project.agent_bindings, &allowed);
        }
        if removed > 0 {
            self.persist(&guard)?;
        }
        Ok(removed)
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

    pub async fn move_to_group(&self, id: &str, group_id: Option<String>) -> Result<(), String> {
        let mut guard = self.projects.lock().await;
        let project = guard
            .iter_mut()
            .find(|project| project.id == id)
            .ok_or("项目不存在")?;
        project.group_id = group_id;
        self.persist(&guard)
    }

    pub async fn remove_profile_refs(&self, profile_id: &str) -> Result<usize, String> {
        let mut guard = self.projects.lock().await;
        let mut removed = 0;
        for project in guard.iter_mut() {
            let before_links = project.linked_profiles.len();
            let before_workspaces = project.remote_workspaces.len();
            project.linked_profiles.retain(|id| id != profile_id);
            project
                .remote_workspaces
                .retain(|item| item.profile_id != profile_id);
            removed += before_links - project.linked_profiles.len();
            removed += before_workspaces - project.remote_workspaces.len();
        }
        if removed > 0 {
            self.persist(&guard)?;
        }
        Ok(removed)
    }

    fn persist(&self, projects: &[Project]) -> Result<(), String> {
        self.database.save("projects", projects)
    }
}

fn retain_known_agent_bindings(
    bindings: &mut Vec<ProjectAgentBinding>,
    allowed: &HashSet<String>,
) -> usize {
    let before = bindings.len();
    bindings.retain(|binding| allowed.contains(&binding.preset_id));
    before - bindings.len()
}

fn normalize_agent_bindings(bindings: Vec<ProjectAgentBinding>) -> Vec<ProjectAgentBinding> {
    let mut result = Vec::new();
    for binding in bindings {
        let preset_id = binding.preset_id.trim().to_string();
        if preset_id.is_empty()
            || result
                .iter()
                .any(|item: &ProjectAgentBinding| item.preset_id == preset_id)
        {
            continue;
        }
        let command_override = binding.command_override.and_then(|value| {
            let trimmed = value.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });
        result.push(ProjectAgentBinding {
            preset_id,
            command_override,
        });
    }
    result
}

/// 以 remote_workspaces 为准，保留 linked_profiles 以兼容已写入的旧配置和旧客户端。
fn normalize_workspaces(
    linked_profiles: Vec<String>,
    remote_workspaces: Vec<ProjectRemoteWorkspace>,
) -> (Vec<String>, Vec<ProjectRemoteWorkspace>) {
    let mut workspaces: Vec<ProjectRemoteWorkspace> = Vec::new();
    for item in remote_workspaces {
        let profile_id = item.profile_id.trim().to_string();
        if !profile_id.is_empty() && !workspaces.iter().any(|w| w.profile_id == profile_id) {
            workspaces.push(ProjectRemoteWorkspace {
                profile_id,
                remote_path: item.remote_path.trim().to_string(),
            });
        }
    }
    for profile_id in linked_profiles {
        let profile_id = profile_id.trim().to_string();
        if !profile_id.is_empty() && !workspaces.iter().any(|w| w.profile_id == profile_id) {
            workspaces.push(ProjectRemoteWorkspace {
                profile_id,
                remote_path: String::new(),
            });
        }
    }
    let linked_profiles = workspaces.iter().map(|w| w.profile_id.clone()).collect();
    (linked_profiles, workspaces)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{
        normalize_agent_bindings, normalize_workspaces, retain_known_agent_bindings,
        ProjectAgentBinding, ProjectRemoteWorkspace,
    };

    #[test]
    fn missing_agent_bindings_are_compatible_and_bindings_are_normalized() {
        let parsed: ProjectAgentBinding =
            serde_json::from_str(r#"{"preset_id":"claude-code"}"#).unwrap();
        assert_eq!(parsed.command_override, None);
        assert_eq!(
            normalize_agent_bindings(vec![
                ProjectAgentBinding {
                    preset_id: " claude-code ".into(),
                    command_override: Some(" claude --resume ".into())
                },
                ProjectAgentBinding {
                    preset_id: "claude-code".into(),
                    command_override: None
                },
                ProjectAgentBinding {
                    preset_id: " ".into(),
                    command_override: None
                },
            ]),
            vec![ProjectAgentBinding {
                preset_id: "claude-code".into(),
                command_override: Some("claude --resume".into())
            }]
        );
    }

    #[test]
    fn pruning_removes_legacy_or_deleted_agent_references() {
        let allowed = HashSet::from(["custom-agent".to_string()]);
        let mut bindings = vec![
            ProjectAgentBinding {
                preset_id: "claude-code".into(),
                command_override: None,
            },
            ProjectAgentBinding {
                preset_id: "custom-agent".into(),
                command_override: Some("tool --go".into()),
            },
        ];
        assert_eq!(retain_known_agent_bindings(&mut bindings, &allowed), 1);
        assert_eq!(
            bindings,
            vec![ProjectAgentBinding {
                preset_id: "custom-agent".into(),
                command_override: Some("tool --go".into())
            }]
        );
    }

    #[test]
    fn legacy_links_become_remote_workspaces() {
        let (links, workspaces) = normalize_workspaces(vec!["dev".into(), "prod".into()], vec![]);
        assert_eq!(links, vec!["dev", "prod"]);
        assert_eq!(
            workspaces,
            vec![
                ProjectRemoteWorkspace {
                    profile_id: "dev".into(),
                    remote_path: String::new()
                },
                ProjectRemoteWorkspace {
                    profile_id: "prod".into(),
                    remote_path: String::new()
                },
            ]
        );
    }

    #[test]
    fn explicit_workspace_path_wins_and_is_unique() {
        let (links, workspaces) = normalize_workspaces(
            vec!["dev".into(), "prod".into()],
            vec![
                ProjectRemoteWorkspace {
                    profile_id: "dev".into(),
                    remote_path: " /srv/app ".into(),
                },
                ProjectRemoteWorkspace {
                    profile_id: "dev".into(),
                    remote_path: "/ignored".into(),
                },
            ],
        );
        assert_eq!(links, vec!["dev", "prod"]);
        assert_eq!(workspaces[0].remote_path, "/srv/app");
        assert_eq!(workspaces.len(), 2);
    }
}
