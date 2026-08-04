//! 连接/项目分组：独立命名空间的任意层级资源树，使用 SQLite 持久化。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::project::ProjectStore;
use super::storage::AppDatabase;

/// 一个资源分组；`parent_id` 构成树，`kind` 隔离连接与项目命名空间。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileGroup {
    pub id: String,
    pub name: String,
    /// 排序权重，越小越靠前。
    pub order: i32,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default = "default_group_kind")]
    pub kind: String,
}

fn default_group_kind() -> String {
    "connection".into()
}

/// 分组存储。
pub struct GroupStore {
    groups: Mutex<Vec<ProfileGroup>>,
    database: Arc<AppDatabase>,
}

impl GroupStore {
    pub fn new(database: Arc<AppDatabase>) -> Self {
        let groups = database.load("groups").ok().flatten().unwrap_or_default();
        Self {
            groups: Mutex::new(groups),
            database,
        }
    }

    pub async fn list_kind(&self, kind: &str) -> Vec<ProfileGroup> {
        let mut groups = self
            .groups
            .lock()
            .await
            .iter()
            .filter(|group| group.kind == kind)
            .cloned()
            .collect::<Vec<_>>();
        groups.sort_by_key(|group| group.order);
        groups
    }

    /// 新建分组，返回创建结果。
    pub async fn create(&self, name: String) -> Result<ProfileGroup, String> {
        self.create_in("connection", None, name).await
    }

    pub async fn create_in(
        &self,
        kind: &str,
        parent_id: Option<String>,
        name: String,
    ) -> Result<ProfileGroup, String> {
        if !matches!(kind, "connection" | "project") {
            return Err("未知资源树类型".into());
        }
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("分组名称不能为空".into());
        }
        let mut guard = self.groups.lock().await;
        if let Some(parent) = parent_id.as_deref() {
            let parent_group = guard
                .iter()
                .find(|group| group.id == parent)
                .ok_or("父分组不存在")?;
            if parent_group.kind != kind {
                return Err("不能跨资源树创建子分组".into());
            }
        }
        if guard.iter().any(|group| {
            group.kind == kind
                && group.parent_id == parent_id
                && group.name.eq_ignore_ascii_case(&name)
        }) {
            return Err("同级已存在同名分组".into());
        }
        let order = guard
            .iter()
            .filter(|group| group.kind == kind && group.parent_id == parent_id)
            .map(|g| g.order)
            .max()
            .unwrap_or(-1)
            + 1;
        let group = ProfileGroup {
            id: Uuid::new_v4().to_string(),
            name,
            order,
            parent_id,
            kind: kind.into(),
        };
        guard.push(group.clone());
        self.persist(&guard)?;
        Ok(group)
    }

    /// 重命名分组。
    pub async fn rename(&self, id: &str, name: String) -> Result<ProfileGroup, String> {
        let mut guard = self.groups.lock().await;
        let index = guard
            .iter()
            .position(|group| group.id == id)
            .ok_or_else(|| format!("group not found: {id}"))?;
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("分组名称不能为空".into());
        }
        let kind = guard[index].kind.clone();
        let parent_id = guard[index].parent_id.clone();
        if guard.iter().enumerate().any(|(candidate, group)| {
            candidate != index
                && group.kind == kind
                && group.parent_id == parent_id
                && group.name.eq_ignore_ascii_case(&name)
        }) {
            return Err("同级已存在同名分组".into());
        }
        let g = &mut guard[index];
        g.name = name;
        let out = g.clone();
        self.persist(&guard)?;
        Ok(out)
    }

    pub async fn move_group(
        &self,
        id: &str,
        parent_id: Option<String>,
        position: i32,
    ) -> Result<ProfileGroup, String> {
        let mut guard = self.groups.lock().await;
        let mut next = guard.clone();
        let index = next
            .iter()
            .position(|group| group.id == id)
            .ok_or("分组不存在")?;
        let kind = next[index].kind.clone();
        if parent_id.as_deref() == Some(id) {
            return Err("分组不能移动到自身".into());
        }
        if let Some(parent) = parent_id.as_deref() {
            let parent_group = next
                .iter()
                .find(|group| group.id == parent)
                .ok_or("目标父分组不存在")?;
            if parent_group.kind != kind {
                return Err("不能跨资源树移动分组".into());
            }
            let descendants = descendant_ids(&next, id);
            if descendants.iter().any(|candidate| candidate == parent) {
                return Err("分组不能移动到自己的子分组".into());
            }
        }
        let old_parent = next[index].parent_id.clone();
        next[index].parent_id = parent_id.clone();
        let mut target_siblings = next
            .iter()
            .enumerate()
            .filter(|(candidate, group)| {
                *candidate != index && group.kind == kind && group.parent_id == parent_id
            })
            .map(|(candidate, group)| (candidate, group.order))
            .collect::<Vec<_>>();
        target_siblings.sort_by_key(|(_, order)| *order);
        let insert_at = usize::try_from(position.max(0))
            .unwrap_or(usize::MAX)
            .min(target_siblings.len());
        target_siblings.insert(insert_at, (index, 0));
        for (order, (candidate, _)) in target_siblings.into_iter().enumerate() {
            next[candidate].order = order as i32;
        }
        if old_parent != parent_id {
            let mut old_siblings = next
                .iter()
                .enumerate()
                .filter(|(_, group)| group.kind == kind && group.parent_id == old_parent)
                .map(|(candidate, group)| (candidate, group.order))
                .collect::<Vec<_>>();
            old_siblings.sort_by_key(|(_, order)| *order);
            for (order, (candidate, _)) in old_siblings.into_iter().enumerate() {
                next[candidate].order = order as i32;
            }
        }
        let result = next[index].clone();
        self.persist(&next)?;
        *guard = next;
        Ok(result)
    }

    pub async fn descendants(&self, id: &str) -> Result<Vec<String>, String> {
        let guard = self.groups.lock().await;
        if !guard.iter().any(|group| group.id == id) {
            return Err("分组不存在".into());
        }
        let mut ids = vec![id.to_string()];
        ids.extend(descendant_ids(&guard, id));
        Ok(ids)
    }

    pub async fn find(&self, id: &str) -> Option<ProfileGroup> {
        self.groups
            .lock()
            .await
            .iter()
            .find(|group| group.id == id)
            .cloned()
    }

    pub async fn delete_tree(&self, ids: &[String]) -> Result<(), String> {
        let mut guard = self.groups.lock().await;
        guard.retain(|group| !ids.contains(&group.id));
        self.persist(&guard)
    }

    /// 旧版连接和项目共用分组。首次 SQLite 启动时为项目复制独立目录树，随后
    /// 重写项目引用；连接树和项目树从此互不影响。
    pub async fn separate_legacy_project_tree(
        &self,
        projects: &ProjectStore,
    ) -> Result<(), String> {
        let referenced = projects
            .list()
            .await
            .into_iter()
            .filter_map(|project| project.group_id)
            .collect::<Vec<_>>();
        if referenced.is_empty() {
            return Ok(());
        }
        let mut guard = self.groups.lock().await;
        if referenced.iter().all(|id| {
            guard
                .iter()
                .any(|group| group.id == *id && group.kind == "project")
        }) {
            return Ok(());
        }
        let connection_groups = guard
            .iter()
            .filter(|group| group.kind == "connection")
            .cloned()
            .collect::<Vec<_>>();
        let mut mapping = std::collections::HashMap::new();
        for group in &connection_groups {
            mapping.insert(group.id.clone(), Uuid::new_v4().to_string());
        }
        for group in connection_groups {
            guard.push(ProfileGroup {
                id: mapping[&group.id].clone(),
                name: group.name,
                order: group.order,
                parent_id: group
                    .parent_id
                    .and_then(|parent| mapping.get(&parent).cloned()),
                kind: "project".into(),
            });
        }
        self.persist(&guard)?;
        drop(guard);
        projects.remap_group_ids(&mapping).await
    }

    /// 删除分组（调用方负责将组内 profile 移出）。
    pub async fn delete(&self, id: &str) -> Result<(), String> {
        let mut guard = self.groups.lock().await;
        let before = guard.len();
        guard.retain(|g| g.id != id);
        if guard.len() == before {
            return Err(format!("group not found: {id}"));
        }
        self.persist(&guard)?;
        Ok(())
    }

    fn persist(&self, groups: &[ProfileGroup]) -> Result<(), String> {
        self.database.save("groups", groups)
    }
}

fn descendant_ids(groups: &[ProfileGroup], root: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut pending = vec![root.to_string()];
    while let Some(parent) = pending.pop() {
        for child in groups
            .iter()
            .filter(|group| group.parent_id.as_deref() == Some(parent.as_str()))
        {
            if !result.contains(&child.id) {
                result.push(child.id.clone());
                pending.push(child.id.clone());
            }
        }
    }
    result
}

impl Default for GroupStore {
    fn default() -> Self {
        Self::new(Arc::new(AppDatabase::default()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn arbitrary_depth_and_cycle_protection() {
        let store = GroupStore::new(Arc::new(AppDatabase::memory()));
        let root = store.create_in("project", None, "根".into()).await.unwrap();
        let child = store
            .create_in("project", Some(root.id.clone()), "子".into())
            .await
            .unwrap();
        let leaf = store
            .create_in("project", Some(child.id.clone()), "叶".into())
            .await
            .unwrap();
        assert_eq!(store.descendants(&root.id).await.unwrap().len(), 3);
        assert!(store.move_group(&root.id, Some(leaf.id), 0).await.is_err());
        assert_eq!(
            store.find(&root.id).await.unwrap().parent_id,
            None,
            "failed moves must not mutate in-memory state"
        );
        assert!(store
            .create_in("connection", Some(root.id), "跨树".into())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn moving_group_reindexes_siblings() {
        let store = GroupStore::new(Arc::new(AppDatabase::memory()));
        let first = store
            .create_in("connection", None, "A".into())
            .await
            .unwrap();
        let second = store
            .create_in("connection", None, "B".into())
            .await
            .unwrap();
        store.move_group(&second.id, None, 0).await.unwrap();
        let groups = store.list_kind("connection").await;
        assert_eq!(
            groups
                .iter()
                .map(|group| group.id.as_str())
                .collect::<Vec<_>>(),
            vec![second.id, first.id]
        );
    }
}
