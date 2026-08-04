//! 常用命令片段（snippets）存储：SQLite 事务持久化。
//!
//! 片段 = 标题 + 命令文本 + 可选标签 + 可选分组。供命令面板 / 快捷命令栏一键注入终端。
//! 旧 `snippets.json` 仅作为首次迁移来源和只读备份保留。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::storage::AppDatabase;

/// 一个常用命令片段。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: String,
    pub title: String,
    /// 命令文本（注入终端时按原文发送，可含 \n 多行）。
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: String,
    pub group_id: Option<String>,
}

/// 创建/更新片段的输入。
#[derive(Debug, Deserialize)]
pub struct SnippetInput {
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub group_id: Option<String>,
}

/// 片段存储。作为 Tauri State 注入。
pub struct SnippetStore {
    snippets: Mutex<Vec<Snippet>>,
    database: Arc<AppDatabase>,
}

impl Default for SnippetStore {
    fn default() -> Self {
        Self::new(Arc::new(AppDatabase::default()))
    }
}

impl SnippetStore {
    /// 从磁盘加载（文件不存在则空）。
    pub fn new(database: Arc<AppDatabase>) -> Self {
        let snippets = database.load("snippets").ok().flatten().unwrap_or_default();
        Self {
            snippets: Mutex::new(snippets),
            database,
        }
    }

    pub async fn list(&self) -> Vec<Snippet> {
        self.snippets.lock().await.clone()
    }

    pub async fn create(&self, input: SnippetInput) -> Result<Snippet, String> {
        let snippet = Snippet {
            id: uuid::Uuid::new_v4().to_string(),
            title: input.title,
            content: input.content,
            tags: input.tags,
            created_at: chrono::Local::now().to_rfc3339(),
            group_id: input.group_id,
        };
        let mut guard = self.snippets.lock().await;
        guard.push(snippet.clone());
        self.persist(&guard)?;
        Ok(snippet)
    }

    pub async fn update(&self, id: &str, input: SnippetInput) -> Result<Snippet, String> {
        let mut guard = self.snippets.lock().await;
        let idx = guard
            .iter()
            .position(|s| s.id == id)
            .ok_or_else(|| format!("snippet not found: {id}"))?;
        let s = &mut guard[idx];
        s.title = input.title;
        s.content = input.content;
        s.tags = input.tags;
        s.group_id = input.group_id;
        let result = s.clone();
        self.persist(&guard)?;
        Ok(result)
    }

    pub async fn delete(&self, id: &str) -> Result<(), String> {
        let mut guard = self.snippets.lock().await;
        guard.retain(|s| s.id != id);
        self.persist(&guard)?;
        Ok(())
    }

    fn persist(&self, snippets: &[Snippet]) -> Result<(), String> {
        self.database.save("snippets", snippets)
    }
}
