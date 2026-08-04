//! Versioned SQLite storage shared by profiles, groups, projects, snippets and workspace state.
//!
//! Legacy JSON files are imported once in a single transaction. The source files are kept and
//! copied to a timestamped migration backup directory; no user data is deleted during migration.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Serialize;

const SCHEMA_VERSION: i64 = 2;

pub struct AppDatabase {
    connection: Mutex<Connection>,
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageStatus {
    pub path: String,
    pub persistent: bool,
    pub schema_version: i64,
    pub migration_warnings: Vec<String>,
    pub pending_secret_cleanup: Vec<SecretCleanupItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SecretCleanupItem {
    pub profile_id: String,
    pub credential_kind: String,
    pub attempts: u32,
    pub last_error: Option<String>,
}

impl AppDatabase {
    /// 尽可能启动应用：磁盘数据库不可用时退化到带诊断的内存库，避免 WebView 黑屏。
    /// 正常情况下仍始终使用磁盘 SQLite；内存回退不会覆盖任何旧 JSON 或损坏数据库。
    pub fn open_resilient() -> Self {
        match Self::open() {
            Ok(database) => database,
            Err(error) => {
                let database = Self::memory();
                let _ = database.record_warning(&format!(
                    "磁盘 SQLite 无法初始化，本次以只保全运行状态的内存库启动；原文件未修改。原因：{error}"
                ));
                database
            }
        }
    }

    pub fn open() -> Result<Self, String> {
        let root = storage_root();
        std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        match Self::open_in_root(&root) {
            Ok(database) => Ok(database),
            Err(original_error) => {
                let lower = original_error.to_ascii_lowercase();
                if !lower.contains("malformed")
                    && !lower.contains("not a database")
                    && !lower.contains("database disk image is malformed")
                {
                    return Err(original_error);
                }
                let path = root.join("simpl-ssh.db");
                let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
                let quarantined = root.join(format!("simpl-ssh.corrupt-{timestamp}.db"));
                if path.exists() {
                    std::fs::rename(&path, &quarantined).map_err(|error| {
                        format!("数据库损坏且无法保留副本：{original_error}；{error}")
                    })?;
                }
                for suffix in ["-wal", "-shm"] {
                    let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
                    if sidecar.exists() {
                        let _ = std::fs::rename(
                            &sidecar,
                            root.join(format!("simpl-ssh.corrupt-{timestamp}.db{suffix}")),
                        );
                    }
                }
                let database = Self::open_in_root(&root)?;
                let message = format!("原数据库无法读取，已保留为 {}。当前已创建安全数据库；可复制诊断后从旧 JSON 或备份恢复。原因：{original_error}", quarantined.display());
                database
                    .connection
                    .lock()
                    .map_err(|error| error.to_string())?
                    .execute(
                        "INSERT INTO migration_warnings(message, created_at) VALUES(?1, ?2)",
                        params![message, chrono::Utc::now().to_rfc3339()],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(database)
            }
        }
    }

    fn open_in_root(root: &Path) -> Result<Self, String> {
        let path = root.join("simpl-ssh.db");
        let mut connection = Connection::open(&path).map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = FULL;
                 CREATE TABLE IF NOT EXISTS schema_migrations (
                   version INTEGER PRIMARY KEY,
                   applied_at TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS app_collections (
                   name TEXT PRIMARY KEY,
                   payload TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS migration_warnings (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   message TEXT NOT NULL,
                   created_at TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS secret_cleanup_queue (
                   profile_id TEXT NOT NULL,
                   credential_kind TEXT NOT NULL,
                   attempts INTEGER NOT NULL DEFAULT 0,
                   last_error TEXT,
                   PRIMARY KEY(profile_id, credential_kind)
                 );
                 CREATE TABLE IF NOT EXISTS resource_groups (
                   id TEXT PRIMARY KEY,
                   kind TEXT NOT NULL CHECK(kind IN ('connection','project')),
                   parent_id TEXT REFERENCES resource_groups(id) ON DELETE CASCADE,
                   name TEXT NOT NULL,
                   position INTEGER NOT NULL DEFAULT 0,
                   payload TEXT NOT NULL,
                   UNIQUE(kind, parent_id, name)
                 );
                 CREATE TABLE IF NOT EXISTS connection_profiles (
                   id TEXT PRIMARY KEY,
                   group_id TEXT REFERENCES resource_groups(id) ON DELETE CASCADE,
                   jump_profile_id TEXT REFERENCES connection_profiles(id) ON DELETE SET NULL,
                   payload TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS projects (
                   id TEXT PRIMARY KEY,
                   group_id TEXT REFERENCES resource_groups(id) ON DELETE CASCADE,
                   payload TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS project_remote_workspaces (
                   project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                   profile_id TEXT NOT NULL REFERENCES connection_profiles(id) ON DELETE CASCADE,
                   remote_path TEXT NOT NULL DEFAULT '',
                   PRIMARY KEY(project_id, profile_id)
                 );
                 CREATE TABLE IF NOT EXISTS project_agent_bindings (
                   project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                   preset_id TEXT NOT NULL,
                   position INTEGER NOT NULL,
                   command_override TEXT,
                   PRIMARY KEY(project_id, preset_id)
                 );
                 CREATE TABLE IF NOT EXISTS command_snippets (
                   id TEXT PRIMARY KEY,
                   group_id TEXT REFERENCES resource_groups(id) ON DELETE SET NULL,
                   payload TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS workspace_snapshots (
                   id INTEGER PRIMARY KEY CHECK(id = 1),
                   payload TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 DROP INDEX IF EXISTS resource_group_sibling_name;",
            )
            .map_err(|error| error.to_string())?;

        let current = connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .map_err(|error| error.to_string())?;
        if current < 1 {
            migrate_legacy(&mut connection, root)?;
        }
        if current < 2 {
            materialize_all_collections(&mut connection)?;
        }
        if current < SCHEMA_VERSION {
            connection
                .execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))
                .map_err(|error| error.to_string())?;
            connection
                .execute(
                    "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?1, ?2)",
                    params![SCHEMA_VERSION, chrono::Utc::now().to_rfc3339()],
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
            path,
        })
    }

    pub(crate) fn memory() -> Self {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE app_collections(name TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE migration_warnings(id INTEGER PRIMARY KEY, message TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE TABLE secret_cleanup_queue(profile_id TEXT NOT NULL, credential_kind TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, PRIMARY KEY(profile_id, credential_kind));
             CREATE TABLE resource_groups(id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent_id TEXT REFERENCES resource_groups(id) ON DELETE CASCADE, name TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL);
             CREATE TABLE connection_profiles(id TEXT PRIMARY KEY, group_id TEXT REFERENCES resource_groups(id) ON DELETE CASCADE, jump_profile_id TEXT REFERENCES connection_profiles(id) ON DELETE SET NULL, payload TEXT NOT NULL);
             CREATE TABLE projects(id TEXT PRIMARY KEY, group_id TEXT REFERENCES resource_groups(id) ON DELETE CASCADE, payload TEXT NOT NULL);
             CREATE TABLE project_remote_workspaces(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, profile_id TEXT NOT NULL REFERENCES connection_profiles(id) ON DELETE CASCADE, remote_path TEXT NOT NULL, PRIMARY KEY(project_id, profile_id));
             CREATE TABLE project_agent_bindings(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, preset_id TEXT NOT NULL, position INTEGER NOT NULL, command_override TEXT, PRIMARY KEY(project_id, preset_id));
             CREATE TABLE command_snippets(id TEXT PRIMARY KEY, group_id TEXT REFERENCES resource_groups(id) ON DELETE SET NULL, payload TEXT NOT NULL);
             CREATE TABLE workspace_snapshots(id INTEGER PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
             PRAGMA foreign_keys = ON;
             PRAGMA user_version = 2;"
        ).unwrap();
        Self {
            connection: Mutex::new(connection),
            path: PathBuf::from(":memory:"),
        }
    }

    pub fn load<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let payload = connection
            .query_row(
                "SELECT payload FROM app_collections WHERE name = ?1",
                params![name],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(value) = payload {
            match serde_json::from_str(&value) {
                Ok(value) => return Ok(Some(value)),
                Err(primary_error) => {
                    if let Some(recovered) = reconstruct_collection(&connection, name)? {
                        let parsed = serde_json::from_str(&recovered).map_err(|fallback_error| {
                            format!("{name} 主集合损坏（{primary_error}），规范化副本也无法读取：{fallback_error}")
                        })?;
                        connection.execute(
                            "INSERT INTO migration_warnings(message, created_at) VALUES(?1, ?2)",
                            params![format!("{name} 主集合损坏，已从规范化 SQLite 表恢复：{primary_error}"), chrono::Utc::now().to_rfc3339()],
                        ).map_err(|error| error.to_string())?;
                        return Ok(Some(parsed));
                    }
                    return Err(format!("{name} 数据损坏：{primary_error}"));
                }
            }
        }

        reconstruct_collection(&connection, name)?
            .map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
            .transpose()
    }

    pub fn save<T: Serialize + ?Sized>(&self, name: &str, value: &T) -> Result<(), String> {
        let payload = serde_json::to_string(value).map_err(|error| error.to_string())?;
        let mut connection = self.connection.lock().map_err(|error| error.to_string())?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        materialize_collection(&transaction, name, &payload)?;
        transaction
            .execute(
                "INSERT INTO app_collections(name, payload, updated_at) VALUES(?1, ?2, ?3)
                 ON CONFLICT(name) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at",
                params![name, payload, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub fn delete(&self, name: &str) -> Result<(), String> {
        let mut connection = self.connection.lock().map_err(|error| error.to_string())?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        if name == "workspace" {
            transaction
                .execute("DELETE FROM workspace_snapshots WHERE id=1", [])
                .map_err(|error| error.to_string())?;
        }
        transaction
            .execute("DELETE FROM app_collections WHERE name=?1", params![name])
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub fn enqueue_secret_cleanup(&self, profile_id: &str, kind: &str) -> Result<(), String> {
        self.connection
            .lock()
            .map_err(|error| error.to_string())?
            .execute(
                "INSERT OR IGNORE INTO secret_cleanup_queue(profile_id, credential_kind) VALUES(?1, ?2)",
                params![profile_id, kind],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn complete_secret_cleanup(&self, profile_id: &str, kind: &str) -> Result<(), String> {
        self.connection
            .lock()
            .map_err(|error| error.to_string())?
            .execute(
                "DELETE FROM secret_cleanup_queue WHERE profile_id=?1 AND credential_kind=?2",
                params![profile_id, kind],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn pending_secret_cleanup(&self) -> Result<Vec<SecretCleanupItem>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare("SELECT profile_id, credential_kind, attempts, last_error FROM secret_cleanup_queue ORDER BY rowid")
            .map_err(|error| error.to_string())?;
        let items = statement
            .query_map([], |row| {
                Ok(SecretCleanupItem {
                    profile_id: row.get(0)?,
                    credential_kind: row.get(1)?,
                    attempts: row.get(2)?,
                    last_error: row.get(3)?,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(items)
    }

    pub fn record_warning(&self, message: &str) -> Result<(), String> {
        self.connection
            .lock()
            .map_err(|error| error.to_string())?
            .execute(
                "INSERT INTO migration_warnings(message, created_at) VALUES(?1, ?2)",
                params![message, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn fail_secret_cleanup(
        &self,
        profile_id: &str,
        kind: &str,
        error: &str,
    ) -> Result<(), String> {
        self.connection
            .lock()
            .map_err(|lock_error| lock_error.to_string())?
            .execute(
                "UPDATE secret_cleanup_queue SET attempts=attempts+1, last_error=?1 WHERE profile_id=?2 AND credential_kind=?3",
                params![error, profile_id, kind],
            )
            .map_err(|database_error| database_error.to_string())?;
        Ok(())
    }

    pub fn status(&self) -> Result<StorageStatus, String> {
        let (version, warnings) = {
            let connection = self.connection.lock().map_err(|error| error.to_string())?;
            let version = connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .map_err(|error| error.to_string())?;
            let mut statement = connection
                .prepare("SELECT message FROM migration_warnings ORDER BY id")
                .map_err(|error| error.to_string())?;
            let warnings = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?
                .filter_map(Result::ok)
                .collect();
            (version, warnings)
        };
        Ok(StorageStatus {
            path: self.path.to_string_lossy().into_owned(),
            persistent: self.path != Path::new(":memory:"),
            schema_version: version,
            migration_warnings: warnings,
            pending_secret_cleanup: self.pending_secret_cleanup()?,
        })
    }

    pub fn backup(&self) -> Result<String, String> {
        if self.path == Path::new(":memory:") {
            return Err("当前正在使用内存回退存储；磁盘数据库不可用，无法创建持久备份".into());
        }
        let root = self.path.parent().ok_or("数据库路径无效")?;
        let destination = root.join(format!(
            "simpl-ssh.backup-{}.db",
            chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
        ));
        self.connection
            .lock()
            .map_err(|error| error.to_string())?
            .execute(
                "VACUUM INTO ?1",
                params![destination.to_string_lossy().into_owned()],
            )
            .map_err(|error| format!("创建数据库备份失败：{error}"))?;
        Ok(destination.to_string_lossy().into_owned())
    }
}

/// `app_collections` 是一个版本兼容层；规范化表才是损坏恢复的第二份来源。
/// 主集合缺失或 JSON 无法解析时，重新组合相同的公开数据形状，避免界面静默变空。
fn reconstruct_collection(connection: &Connection, name: &str) -> Result<Option<String>, String> {
    let (table, order) = match name {
        "groups" => ("resource_groups", "kind, parent_id, position, id"),
        "profiles" => ("connection_profiles", "id"),
        "projects" => ("projects", "id"),
        "snippets" => ("command_snippets", "id"),
        "workspace" => {
            return connection
                .query_row(
                    "SELECT payload FROM workspace_snapshots WHERE id=1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| error.to_string())
        }
        _ => return Ok(None),
    };
    let sql = format!("SELECT payload FROM {table} ORDER BY {order}");
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if rows.is_empty() {
        return Ok(None);
    }
    let values = rows
        .into_iter()
        .map(|payload| serde_json::from_str::<serde_json::Value>(&payload))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    serde_json::to_string(&values)
        .map(Some)
        .map_err(|error| error.to_string())
}

impl Default for AppDatabase {
    fn default() -> Self {
        Self::open().expect("failed to open Simpl SSH database")
    }
}

fn migrate_legacy(connection: &mut Connection, root: &Path) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let backup_root = root.join("migration-backups").join(&timestamp);
    let sources = [
        ("profiles", "profiles.json"),
        ("groups", "groups.json"),
        ("projects", "projects.json"),
        ("snippets", "snippets.json"),
        ("workspace", "workspace.json"),
    ];
    for (name, file_name) in sources {
        let path = root.join(file_name);
        if !path.exists() {
            continue;
        }
        let payload = match std::fs::read_to_string(&path) {
            Ok(payload) if serde_json::from_str::<serde_json::Value>(&payload).is_ok() => payload,
            Ok(_) => {
                transaction
                    .execute(
                        "INSERT INTO migration_warnings(message, created_at) VALUES(?1, ?2)",
                        params![
                            format!("{file_name} 内容损坏，未自动导入；原文件已保留"),
                            chrono::Utc::now().to_rfc3339()
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                continue;
            }
            Err(error) => {
                transaction
                    .execute(
                        "INSERT INTO migration_warnings(message, created_at) VALUES(?1, ?2)",
                        params![
                            format!("无法读取 {file_name}：{error}"),
                            chrono::Utc::now().to_rfc3339()
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                continue;
            }
        };
        std::fs::create_dir_all(&backup_root).map_err(|error| error.to_string())?;
        std::fs::copy(&path, backup_root.join(file_name)).map_err(|error| error.to_string())?;
        let payload = if name == "workspace" {
            serde_json::to_string(&payload).map_err(|error| error.to_string())?
        } else {
            payload
        };
        transaction
            .execute(
                "INSERT OR IGNORE INTO app_collections(name, payload, updated_at) VALUES(?1, ?2, ?3)",
                params![name, payload, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn storage_root() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("simpl-ssh")
}

fn materialize_all_collections(connection: &mut Connection) -> Result<(), String> {
    let values = {
        let mut statement = connection
            .prepare("SELECT name, payload FROM app_collections")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    // 外键依赖要求资源树先于叶子，连接先于项目远程关联。
    for name in ["groups", "profiles", "projects", "snippets", "workspace"] {
        if let Some((_, payload)) = values.iter().find(|(candidate, _)| candidate == name) {
            materialize_collection(&transaction, name, payload)?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn materialize_collection(
    transaction: &rusqlite::Transaction<'_>,
    name: &str,
    payload: &str,
) -> Result<(), String> {
    match name {
        "groups" => materialize_groups(transaction, payload),
        "profiles" => materialize_profiles(transaction, payload),
        "projects" => materialize_projects(transaction, payload),
        "snippets" => materialize_snippets(transaction, payload),
        "workspace" => {
            transaction.execute(
                "INSERT INTO workspace_snapshots(id, payload, updated_at) VALUES(1, ?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at",
                params![payload, chrono::Utc::now().to_rfc3339()],
            ).map_err(|error| error.to_string())?;
            Ok(())
        }
        _ => Ok(()),
    }
}

fn parse_array(payload: &str) -> Result<Vec<serde_json::Value>, String> {
    serde_json::from_str(payload)
        .map_err(|error| error.to_string())
        .and_then(|value: serde_json::Value| {
            value
                .as_array()
                .cloned()
                .ok_or_else(|| "集合数据必须是数组".to_string())
        })
}

fn text(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn materialize_groups(
    transaction: &rusqlite::Transaction<'_>,
    payload: &str,
) -> Result<(), String> {
    let groups = parse_array(payload)?;
    let ids = groups
        .iter()
        .filter_map(|item| text(item, "id"))
        .collect::<std::collections::HashSet<_>>();
    let mut sibling_names = std::collections::HashSet::new();
    for group in &groups {
        let Some(id) = text(group, "id") else {
            continue;
        };
        let kind = text(group, "kind")
            .filter(|value| matches!(value.as_str(), "connection" | "project"))
            .unwrap_or_else(|| "connection".into());
        let name = text(group, "name").unwrap_or_else(|| "未命名分组".into());
        let parent_key = text(group, "parent_id")
            .filter(|candidate| ids.contains(candidate))
            .unwrap_or_default();
        let unique_key = format!("{kind}\0{parent_key}\0{}", name.to_lowercase());
        let database_name = if sibling_names.insert(unique_key) {
            name
        } else {
            let short_id: String = id.chars().take(6).collect();
            format!("{} [{}]", name, short_id)
        };
        let position = group
            .get("order")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or_default();
        transaction.execute(
            "INSERT INTO resource_groups(id, kind, parent_id, name, position, payload) VALUES(?1, ?2, NULL, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, parent_id=NULL, name=excluded.name, position=excluded.position, payload=excluded.payload",
                params![id, kind, database_name, position, group.to_string()],
        ).map_err(|error| error.to_string())?;
    }
    for group in &groups {
        let Some(id) = text(group, "id") else {
            continue;
        };
        let parent = text(group, "parent_id").filter(|candidate| ids.contains(candidate));
        transaction
            .execute(
                "UPDATE resource_groups SET parent_id=?1 WHERE id=?2",
                params![parent, id],
            )
            .map_err(|error| error.to_string())?;
    }
    delete_stale(transaction, "resource_groups", &ids)
}

fn materialize_profiles(
    transaction: &rusqlite::Transaction<'_>,
    payload: &str,
) -> Result<(), String> {
    let profiles = parse_array(payload)?;
    let ids = profiles
        .iter()
        .filter_map(|item| text(item, "id"))
        .collect::<std::collections::HashSet<_>>();
    for profile in &profiles {
        let Some(id) = text(profile, "id") else {
            continue;
        };
        let group_id = valid_group(transaction, text(profile, "group_id"), "connection")?;
        transaction.execute(
            "INSERT INTO connection_profiles(id, group_id, jump_profile_id, payload) VALUES(?1, ?2, NULL, ?3)
             ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id, jump_profile_id=NULL, payload=excluded.payload",
            params![id, group_id, profile.to_string()],
        ).map_err(|error| error.to_string())?;
    }
    for profile in &profiles {
        let Some(id) = text(profile, "id") else {
            continue;
        };
        let jump = text(profile, "jump_profile_id")
            .filter(|candidate| candidate != &id && ids.contains(candidate));
        transaction
            .execute(
                "UPDATE connection_profiles SET jump_profile_id=?1 WHERE id=?2",
                params![jump, id],
            )
            .map_err(|error| error.to_string())?;
    }
    delete_stale(transaction, "connection_profiles", &ids)
}

fn materialize_projects(
    transaction: &rusqlite::Transaction<'_>,
    payload: &str,
) -> Result<(), String> {
    let projects = parse_array(payload)?;
    let ids = projects
        .iter()
        .filter_map(|item| text(item, "id"))
        .collect::<std::collections::HashSet<_>>();
    for project in &projects {
        let Some(id) = text(project, "id") else {
            continue;
        };
        let group_id = valid_group(transaction, text(project, "group_id"), "project")?;
        transaction
            .execute(
                "INSERT INTO projects(id, group_id, payload) VALUES(?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id, payload=excluded.payload",
                params![id, group_id, project.to_string()],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM project_remote_workspaces WHERE project_id=?1",
                params![id],
            )
            .map_err(|error| error.to_string())?;
        if let Some(workspaces) = project
            .get("remote_workspaces")
            .and_then(serde_json::Value::as_array)
        {
            for workspace in workspaces {
                let Some(profile_id) = text(workspace, "profile_id") else {
                    continue;
                };
                let exists = transaction
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM connection_profiles WHERE id=?1)",
                        params![profile_id],
                        |row| row.get::<_, bool>(0),
                    )
                    .map_err(|error| error.to_string())?;
                if exists {
                    transaction.execute("INSERT OR REPLACE INTO project_remote_workspaces(project_id, profile_id, remote_path) VALUES(?1, ?2, ?3)", params![id, profile_id, text(workspace, "remote_path").unwrap_or_default()]).map_err(|error| error.to_string())?;
                }
            }
        }
        transaction
            .execute(
                "DELETE FROM project_agent_bindings WHERE project_id=?1",
                params![id],
            )
            .map_err(|error| error.to_string())?;
        if let Some(bindings) = project
            .get("agent_bindings")
            .and_then(serde_json::Value::as_array)
        {
            for (position, binding) in bindings.iter().enumerate() {
                let Some(preset_id) = text(binding, "preset_id") else {
                    continue;
                };
                transaction.execute("INSERT OR REPLACE INTO project_agent_bindings(project_id, preset_id, position, command_override) VALUES(?1, ?2, ?3, ?4)", params![id, preset_id, position as i64, text(binding, "command_override")]).map_err(|error| error.to_string())?;
            }
        }
    }
    delete_stale(transaction, "projects", &ids)
}

fn materialize_snippets(
    transaction: &rusqlite::Transaction<'_>,
    payload: &str,
) -> Result<(), String> {
    let snippets = parse_array(payload)?;
    let ids = snippets
        .iter()
        .filter_map(|item| text(item, "id"))
        .collect::<std::collections::HashSet<_>>();
    for snippet in &snippets {
        let Some(id) = text(snippet, "id") else {
            continue;
        };
        let group_id = text(snippet, "group_id").filter(|candidate| {
            transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM resource_groups WHERE id=?1)",
                    params![candidate],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap_or(false)
        });
        transaction.execute("INSERT INTO command_snippets(id, group_id, payload) VALUES(?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id, payload=excluded.payload", params![id, group_id, snippet.to_string()]).map_err(|error| error.to_string())?;
    }
    delete_stale(transaction, "command_snippets", &ids)
}

fn valid_group(
    transaction: &rusqlite::Transaction<'_>,
    id: Option<String>,
    kind: &str,
) -> Result<Option<String>, String> {
    let Some(id) = id else { return Ok(None) };
    let exists = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM resource_groups WHERE id=?1 AND kind=?2)",
            params![id, kind],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(exists.then_some(id))
}

fn delete_stale(
    transaction: &rusqlite::Transaction<'_>,
    table: &str,
    keep: &std::collections::HashSet<String>,
) -> Result<(), String> {
    let sql = format!("SELECT id FROM {table}");
    let existing = {
        let mut statement = transaction
            .prepare(&sql)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let delete_sql = format!("DELETE FROM {table} WHERE id=?1");
    for id in existing.into_iter().filter(|id| !keep.contains(id)) {
        transaction
            .execute(&delete_sql, params![id])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::AppDatabase;
    use serde_json::json;

    #[test]
    fn collection_round_trip_is_transactional() {
        let database = AppDatabase::memory();
        let key = format!("test-{}", uuid::Uuid::new_v4());
        database.save(&key, &vec!["中文", "data"]).unwrap();
        assert_eq!(
            database.load::<Vec<String>>(&key).unwrap().unwrap(),
            vec!["中文", "data"]
        );
        database.delete(&key).unwrap();
    }

    #[test]
    fn normalized_tables_enforce_relations_and_cascade() {
        let database = AppDatabase::memory();
        database
            .save(
                "groups",
                &json!([{
                    "id": "group-1", "name": "生产", "order": 0, "kind": "connection"
                }]),
            )
            .unwrap();
        database
            .save(
                "profiles",
                &json!([{
                    "id": "profile-1", "name": "server", "host": "127.0.0.1", "port": 22,
                    "user": "root", "group_id": "group-1"
                }]),
            )
            .unwrap();
        let connection = database.connection.lock().unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM connection_profiles WHERE group_id='group-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        drop(connection);

        database.save("groups", &json!([])).unwrap();
        let connection = database.connection.lock().unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM connection_profiles", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            count, 0,
            "deleting a group must cascade its application records"
        );
    }

    #[test]
    fn failed_normalization_rolls_back_collection_write() {
        let database = AppDatabase::memory();
        database
            .save(
                "groups",
                &json!([{
                    "id": "one", "name": "重复", "order": 0, "kind": "connection"
                }]),
            )
            .unwrap();
        assert!(database.save("groups", &json!({"invalid": true})).is_err());
        let stored: Vec<serde_json::Value> = database.load("groups").unwrap().unwrap();
        assert_eq!(stored.len(), 1);
    }

    #[test]
    fn corrupt_compatibility_collection_recovers_from_normalized_rows() {
        let database = AppDatabase::memory();
        database
            .save(
                "groups",
                &json!([{
                    "id": "group-recovery", "name": "恢复", "order": 0, "kind": "connection"
                }]),
            )
            .unwrap();
        database
            .connection
            .lock()
            .unwrap()
            .execute(
                "UPDATE app_collections SET payload='{' WHERE name='groups'",
                [],
            )
            .unwrap();

        let restored: Vec<serde_json::Value> = database.load("groups").unwrap().unwrap();
        assert_eq!(restored[0]["id"], "group-recovery");
        assert!(database
            .status()
            .unwrap()
            .migration_warnings
            .iter()
            .any(|warning| warning.contains("规范化 SQLite 表恢复")));
    }

    #[test]
    fn secret_cleanup_queue_is_visible_and_retryable() {
        let database = AppDatabase::memory();
        database
            .enqueue_secret_cleanup("profile-1", "password")
            .unwrap();
        database
            .fail_secret_cleanup("profile-1", "password", "locked")
            .unwrap();
        let pending = database.status().unwrap().pending_secret_cleanup;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].attempts, 1);
        assert_eq!(pending[0].last_error.as_deref(), Some("locked"));
        database
            .complete_secret_cleanup("profile-1", "password")
            .unwrap();
        assert!(database.pending_secret_cleanup().unwrap().is_empty());
    }
}
