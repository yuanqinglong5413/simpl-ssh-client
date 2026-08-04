//! Signed, application-managed LSP runtimes.
//! Plugins are deliberately limited to standard LSP executables. They are never
//! launched through a shell and their archives are extracted with path checks.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CATALOG_BYTES: usize = 4 * 1024 * 1024;
const CATALOG_URL: &str = "https://github.com/yuanqinglong5413/simpl-ssh-client/releases/download/lsp-runtime-stable/lsp-catalog.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspPluginLanguage {
    pub id: String,
    pub extensions: Vec<String>,
    pub lsp_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspPluginRuntime {
    pub archive_url: String,
    pub sha256: String,
    pub signature: String,
    pub executable: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspPluginManifest {
    pub id: String,
    pub version: String,
    pub name: String,
    pub publisher: String,
    pub description: String,
    pub languages: Vec<LspPluginLanguage>,
    pub root_markers: Vec<String>,
    pub capabilities: Vec<String>,
    pub runtimes: HashMap<String, LspPluginRuntime>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LspCatalogPayload {
    schema_version: u32,
    plugins: Vec<LspPluginManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedLspCatalog {
    /// Base64 编码的 JSON payload；签名覆盖解码后的原始字节，避免 JSON 重新序列化歧义。
    payload: String,
    signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledLspPlugin {
    pub plugin_id: String,
    pub version: String,
    pub enabled: bool,
    pub priority: i32,
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspPluginAvailability {
    pub plugin_id: String,
    pub version: String,
    pub status: String,
    pub source: String,
    pub executable: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspInstallProgress {
    plugin_id: String,
    version: String,
    phase: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    bytes_per_second: Option<u64>,
    message: Option<String>,
}

#[derive(Default)]
pub struct LspPluginManager {
    installed: Arc<Mutex<Vec<InstalledLspPlugin>>>,
    catalog: Arc<Mutex<Option<Vec<LspPluginManifest>>>>,
    downloads: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl LspPluginManager {
    pub async fn catalog(&self, app: &AppHandle) -> Result<Vec<LspPluginManifest>, String> {
        if let Some(catalog) = self.catalog.lock().await.clone() {
            return Ok(catalog);
        }
        let catalog = self
            .load_cached_catalog(app)
            .await
            .unwrap_or_else(|_| builtin_catalog());
        *self.catalog.lock().await = Some(catalog.clone());
        let _ = app.emit("lsp-plugin://catalog", &catalog);
        Ok(catalog)
    }

    /// 只由用户显式触发的目录刷新；网络目录必须由编译进应用的公钥签名。
    pub async fn refresh_catalog(&self, app: &AppHandle) -> Result<Vec<LspPluginManifest>, String> {
        let key = match official_signing_key() {
            Ok(key) => key,
            // 第一个 Release 尚未配置托管目录时，内置“点击安装”来源仍可用。
            // 这是安全能力降级，不应在设置页伪装成错误。
            Err(message) if message.contains("尚未配置") => {
                let catalog = self.catalog(app).await?;
                let _ = app.emit("lsp-plugin://update", "正在使用内置驱动目录");
                return Ok(catalog);
            }
            Err(error) => return Err(error),
        };
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|error| format!("无法创建插件目录请求：{error}"))?;
        let response = client
            .get(CATALOG_URL)
            .send()
            .await
            .map_err(|error| format!("下载插件目录失败：{error}"))?
            .error_for_status()
            .map_err(|error| format!("插件目录请求失败：{error}"))?;
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("读取插件目录失败：{error}"))?;
        if bytes.len() > MAX_CATALOG_BYTES {
            return Err("插件目录超过 4MB 限制".into());
        }
        let catalog = parse_signed_catalog(&bytes, &key)?;
        self.save_catalog(app, &bytes).await?;
        *self.catalog.lock().await = Some(catalog.clone());
        let _ = app.emit("lsp-plugin://catalog", &catalog);
        let _ = app.emit("lsp-plugin://update", "插件目录已刷新");
        Ok(catalog)
    }
    pub async fn status(&self, app: &AppHandle) -> Result<Vec<InstalledLspPlugin>, String> {
        self.load(app).await
    }
    pub async fn check(&self, app: &AppHandle) -> Result<Vec<LspPluginAvailability>, String> {
        let installed = self.load(app).await?;
        Ok(self
            .catalog(app)
            .await?
            .into_iter()
            .map(|manifest| {
                let runtime = manifest.runtimes.get(platform_key());
                let executable = runtime.and_then(|item| {
                    self.plugin_root(app, &manifest.id, &manifest.version)
                        .ok()
                        .map(|root| root.join(&item.executable).to_string_lossy().into_owned())
                });
                let available = executable
                    .as_deref()
                    .map(Path::new)
                    .is_some_and(is_executable);
                let installed_here = installed.iter().any(|item| {
                    item.plugin_id == manifest.id
                        && item.version == manifest.version
                        && item.source == "managed"
                });
                LspPluginAvailability {
                    plugin_id: manifest.id,
                    version: manifest.version,
                    status: if available && installed_here {
                        "available"
                    } else if runtime.is_some() {
                        "missing"
                    } else {
                        "unavailable"
                    }
                    .into(),
                    source: "managed".into(),
                    executable,
                    detail: if available && installed_here {
                        "应用托管运行时已安装".into()
                    } else if runtime.is_some() {
                        "可下载 Simpl SSH 签名托管运行时".into()
                    } else {
                        "当前平台暂不可安装".into()
                    },
                }
            })
            .collect())
    }
    pub async fn enable(
        &self,
        app: &AppHandle,
        plugin_id: &str,
        version: &str,
        enabled: bool,
        priority: i32,
    ) -> Result<Vec<InstalledLspPlugin>, String> {
        let mut items = self.load(app).await?;
        let item = items
            .iter_mut()
            .find(|item| item.plugin_id == plugin_id && item.version == version)
            .ok_or_else(|| "语言服务插件尚未安装".to_string())?;
        item.enabled = enabled;
        item.priority = priority;
        self.save(app, &items).await?;
        Ok(items)
    }
    pub async fn install(
        &self,
        app: &AppHandle,
        plugin_id: &str,
        version: &str,
    ) -> Result<InstalledLspPlugin, String> {
        let manifest = self
            .catalog(app)
            .await?
            .into_iter()
            .find(|item| item.id == plugin_id && item.version == version)
            .ok_or_else(|| "插件不在受信任目录中".to_string())?;
        emit_install_progress(
            app,
            &manifest,
            "resolving",
            0,
            None,
            None,
            Some("正在解析当前平台运行时"),
        );
        let runtime = manifest
            .runtimes
            .get(platform_key())
            .cloned()
            .filter(|runtime| !runtime.archive_url.is_empty())
            .ok_or_else(|| {
                "当前平台暂不可安装；Simpl SSH 不会调用 Homebrew 或修改系统环境".to_string()
            })?;
        if runtime.sha256.is_empty() || runtime.signature.is_empty() {
            return Err("该插件尚未发布经过签名的当前平台运行时".into());
        }
        let download_key = format!("{}@{}", manifest.id, manifest.version);
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut downloads = self.downloads.lock().await;
            if downloads.contains_key(&download_key) {
                return Err("该语言服务正在下载".into());
            }
            downloads.insert(download_key.clone(), cancelled.clone());
        }
        let result = self
            .download_archive(app, &manifest, &runtime, &cancelled)
            .await;
        self.downloads.lock().await.remove(&download_key);
        let (archive_path, downloaded, actual_hash) = match result {
            Ok(value) => value,
            Err(error) => {
                if let Ok(data_dir) = app.path().app_data_dir() {
                    let _ = tokio::fs::remove_file(
                        data_dir
                            .join("lsp/downloads")
                            .join(format!("{}-{}.zip.part", manifest.id, manifest.version)),
                    )
                    .await;
                }
                let phase = if cancelled.load(Ordering::Acquire) {
                    "cancelled"
                } else {
                    "failed"
                };
                emit_install_progress(
                    app,
                    &manifest,
                    phase,
                    0,
                    runtime.size_bytes,
                    None,
                    Some(&error),
                );
                return Err(error);
            }
        };
        emit_install_progress(
            app,
            &manifest,
            "verifying",
            downloaded,
            Some(downloaded),
            None,
            Some("正在校验 SHA-256 与 Ed25519 签名"),
        );
        if let Err(error) = verify_runtime_descriptor(
            &manifest,
            &runtime,
            platform_key(),
            &actual_hash,
            downloaded,
        ) {
            let _ = tokio::fs::remove_file(&archive_path).await;
            emit_install_progress(
                app,
                &manifest,
                "failed",
                downloaded,
                Some(downloaded),
                None,
                Some(&error),
            );
            return Err(error);
        }
        let root = self.plugin_root(app, &manifest.id, &manifest.version)?;
        let temp = root.with_extension("part");
        if tokio::fs::try_exists(&temp).await.unwrap_or(false) {
            tokio::fs::remove_dir_all(&temp)
                .await
                .map_err(|error| format!("无法清理未完成的插件安装：{error}"))?;
        }
        tokio::fs::create_dir_all(&temp)
            .await
            .map_err(|error| error.to_string())?;
        emit_install_progress(
            app,
            &manifest,
            "extracting",
            downloaded,
            Some(downloaded),
            None,
            Some("正在安全解压运行时"),
        );
        let archive_for_extract = archive_path.clone();
        let temp_for_extract = temp.clone();
        let extract_result = tokio::task::spawn_blocking(move || {
            extract_archive_file(&archive_for_extract, &temp_for_extract)
        })
        .await
        .map_err(|error| error.to_string())?;
        let _ = tokio::fs::remove_file(&archive_path).await;
        if let Err(error) = extract_result {
            let _ = tokio::fs::remove_dir_all(&temp).await;
            emit_install_progress(
                app,
                &manifest,
                "failed",
                downloaded,
                Some(downloaded),
                None,
                Some(&error),
            );
            return Err(error);
        }
        let final_root = root.clone();
        // 保留一个版本级回滚目录，原子切换失败时仍可恢复上一份运行时。
        let rollback_root = root.with_extension("rollback");
        if tokio::fs::try_exists(&rollback_root).await.unwrap_or(false) {
            tokio::fs::remove_dir_all(&rollback_root)
                .await
                .map_err(|error| error.to_string())?;
        }
        if tokio::fs::try_exists(&final_root).await.unwrap_or(false) {
            tokio::fs::rename(&final_root, &rollback_root)
                .await
                .map_err(|error| error.to_string())?;
        }
        emit_install_progress(
            app,
            &manifest,
            "activating",
            downloaded,
            Some(downloaded),
            None,
            Some("正在原子启用运行时"),
        );
        if let Err(error) = tokio::fs::rename(&temp, &final_root).await {
            if tokio::fs::try_exists(&rollback_root).await.unwrap_or(false) {
                let _ = tokio::fs::rename(&rollback_root, &final_root).await;
            }
            let message = format!("无法启用语言服务运行时：{error}");
            let _ = tokio::fs::remove_dir_all(&temp).await;
            emit_install_progress(
                app,
                &manifest,
                "failed",
                downloaded,
                Some(downloaded),
                None,
                Some(&message),
            );
            return Err(message);
        }
        let item = InstalledLspPlugin {
            plugin_id: manifest.id.clone(),
            version: manifest.version.clone(),
            enabled: true,
            priority: 0,
            source: "managed".into(),
        };
        let mut items = self.load(app).await?;
        items.retain(|old| old.plugin_id != item.plugin_id || old.version != item.version);
        items.push(item.clone());
        self.save(app, &items).await?;
        emit_install_progress(
            app,
            &manifest,
            "ready",
            downloaded,
            Some(downloaded),
            None,
            Some("语言服务已就绪"),
        );
        Ok(item)
    }

    async fn download_archive(
        &self,
        app: &AppHandle,
        manifest: &LspPluginManifest,
        runtime: &LspPluginRuntime,
        cancelled: &AtomicBool,
    ) -> Result<(PathBuf, u64, String), String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|error| format!("无法创建插件下载请求：{error}"))?;
        let response = client
            .get(&runtime.archive_url)
            .send()
            .await
            .map_err(|error| format!("下载插件失败：{error}"))?
            .error_for_status()
            .map_err(|error| format!("插件下载请求失败：{error}"))?;
        let total = response.content_length().or(runtime.size_bytes);
        if total.is_some_and(|size| size > MAX_ARCHIVE_BYTES) {
            return Err("插件包超过 512MB 限制".into());
        }
        let download_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("lsp/downloads");
        tokio::fs::create_dir_all(&download_dir)
            .await
            .map_err(|error| error.to_string())?;
        let path = download_dir.join(format!("{}-{}.zip.part", manifest.id, manifest.version));
        let _ = tokio::fs::remove_file(&path).await;
        let mut file = tokio::fs::File::create(&path)
            .await
            .map_err(|error| error.to_string())?;
        let mut stream = response.bytes_stream();
        let mut digest = Sha256::new();
        let mut downloaded = 0u64;
        let started = Instant::now();
        let mut last_progress = Instant::now();
        while let Some(chunk) = stream.next().await {
            if cancelled.load(Ordering::Acquire) {
                drop(file);
                let _ = tokio::fs::remove_file(&path).await;
                return Err("下载已取消".into());
            }
            let chunk = chunk.map_err(|error| format!("读取插件失败：{error}"))?;
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            if downloaded > MAX_ARCHIVE_BYTES {
                drop(file);
                let _ = tokio::fs::remove_file(&path).await;
                return Err("插件包超过 512MB 限制".into());
            }
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("写入插件临时文件失败：{error}"))?;
            digest.update(&chunk);
            if last_progress.elapsed().as_millis() >= 100 || total == Some(downloaded) {
                let speed = (downloaded as f64 / started.elapsed().as_secs_f64().max(0.05)) as u64;
                emit_install_progress(
                    app,
                    manifest,
                    "downloading",
                    downloaded,
                    total,
                    Some(speed),
                    None,
                );
                last_progress = Instant::now();
            }
        }
        let speed = (downloaded as f64 / started.elapsed().as_secs_f64().max(0.05)) as u64;
        emit_install_progress(
            app,
            manifest,
            "downloading",
            downloaded,
            total,
            Some(speed),
            None,
        );
        file.flush().await.map_err(|error| error.to_string())?;
        file.sync_all().await.map_err(|error| error.to_string())?;
        let actual_hash = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Ok((path, downloaded, actual_hash))
    }

    pub async fn cancel_install(&self, plugin_id: &str, version: &str) -> bool {
        let key = format!("{plugin_id}@{version}");
        if let Some(cancelled) = self.downloads.lock().await.get(&key) {
            cancelled.store(true, Ordering::Release);
            true
        } else {
            false
        }
    }

    pub async fn uninstall(
        &self,
        app: &AppHandle,
        plugin_id: &str,
        version: &str,
    ) -> Result<(), String> {
        let root = self.plugin_root(app, plugin_id, version)?;
        if tokio::fs::try_exists(&root).await.unwrap_or(false) {
            tokio::fs::remove_dir_all(root)
                .await
                .map_err(|error| error.to_string())?;
        }
        let mut items = self.load(app).await?;
        items.retain(|item| item.plugin_id != plugin_id || item.version != version);
        self.save(app, &items).await
    }

    pub async fn rollback(
        &self,
        app: &AppHandle,
        plugin_id: &str,
        version: &str,
    ) -> Result<(), String> {
        let root = self.plugin_root(app, plugin_id, version)?;
        let rollback = root.with_extension("rollback");
        if !tokio::fs::try_exists(&rollback).await.unwrap_or(false) {
            return Err("没有可回滚的上一版本运行时".into());
        }
        let failed = root.with_extension("failed");
        if tokio::fs::try_exists(&failed).await.unwrap_or(false) {
            tokio::fs::remove_dir_all(&failed)
                .await
                .map_err(|error| error.to_string())?;
        }
        if tokio::fs::try_exists(&root).await.unwrap_or(false) {
            tokio::fs::rename(&root, &failed)
                .await
                .map_err(|error| error.to_string())?;
        }
        if let Err(error) = tokio::fs::rename(&rollback, &root).await {
            if tokio::fs::try_exists(&failed).await.unwrap_or(false) {
                let _ = tokio::fs::rename(&failed, &root).await;
            }
            return Err(format!("回滚语言服务失败：{error}"));
        }
        if tokio::fs::try_exists(&failed).await.unwrap_or(false) {
            tokio::fs::rename(&failed, &rollback)
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
    pub async fn resolve(
        &self,
        app: &AppHandle,
        plugin_id: &str,
        version: &str,
    ) -> Result<(String, Vec<String>), String> {
        let installed = self
            .load(app)
            .await?
            .into_iter()
            .find(|item| item.plugin_id == plugin_id && item.version == version);
        let Some(installed) = installed else {
            return Err("语言服务插件尚未安装".into());
        };
        let manifest = self
            .catalog(app)
            .await?
            .into_iter()
            .find(|item| item.id == plugin_id && item.version == version)
            .ok_or("插件清单不存在")?;
        // 早期版本没有持久化 source 字段；这些条目原本只能引用 PATH 中的
        // 系统命令，按 system 兼容处理，避免升级后“已启用但无法解析”。
        if installed.source.is_empty()
            || installed.source == "system"
            || installed.source == "system-detected"
            || installed.source == "managed-system"
        {
            return Err("该语言服务来自旧版系统检测，请从插件目录重新下载 Simpl SSH 托管运行时；不会再访问 PATH 或系统包管理器".into());
        }
        let runtime = manifest
            .runtimes
            .get(platform_key())
            .ok_or("当前平台没有插件运行时")?;
        let executable = self
            .plugin_root(app, plugin_id, version)?
            .join(&runtime.executable);
        let canonical_root = self
            .plugin_root(app, plugin_id, version)?
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let canonical_executable = executable
            .canonicalize()
            .map_err(|error| format!("插件可执行文件不存在：{error}"))?;
        if !canonical_executable.starts_with(canonical_root)
            || !is_executable(&canonical_executable)
        {
            return Err("插件可执行文件不在受控目录内".into());
        }
        Ok((
            canonical_executable.to_string_lossy().into_owned(),
            runtime.args.clone(),
        ))
    }
    fn plugin_root(&self, app: &AppHandle, id: &str, version: &str) -> Result<PathBuf, String> {
        if id.is_empty()
            || version.is_empty()
            || id.contains(['/', '\\'])
            || version.contains(['/', '\\'])
        {
            return Err("无效插件标识".into());
        }
        Ok(app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("lsp/plugins")
            .join(id)
            .join(version))
    }
    fn catalog_path(&self, app: &AppHandle) -> Result<PathBuf, String> {
        Ok(app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("lsp/catalog.json"))
    }
    async fn load_cached_catalog(&self, app: &AppHandle) -> Result<Vec<LspPluginManifest>, String> {
        let path = self.catalog_path(app)?;
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|error| format!("无法读取缓存插件目录：{error}"))?;
        parse_signed_catalog(&bytes, &official_signing_key()?)
    }
    async fn save_catalog(&self, app: &AppHandle, bytes: &[u8]) -> Result<(), String> {
        let path = self.catalog_path(app)?;
        let parent = path.parent().ok_or("无效插件目录路径")?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
        let temp = path.with_extension("tmp");
        tokio::fs::write(&temp, bytes)
            .await
            .map_err(|error| error.to_string())?;
        tokio::fs::rename(temp, path)
            .await
            .map_err(|error| error.to_string())
    }
    async fn load(&self, app: &AppHandle) -> Result<Vec<InstalledLspPlugin>, String> {
        let path = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("lsp/plugins.json");
        if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
            return Ok(self.installed.lock().await.clone());
        }
        let raw = tokio::fs::read_to_string(path)
            .await
            .map_err(|error| error.to_string())?;
        let mut value: Vec<InstalledLspPlugin> =
            serde_json::from_str(&raw).map_err(|error| format!("插件状态损坏：{error}"))?;
        for item in &mut value {
            item.source = match item.source.as_str() {
                "bundled" => "managed".into(),
                "system" | "managed-system" | "" => "system-detected".into(),
                _ => item.source.clone(),
            };
        }
        let before = value.len();
        value.retain(|item| item.source == "managed");
        if value.len() != before {
            // 旧版 PATH/Homebrew 插件记录不再视为已安装；自定义命令仍由 customServers 保留。
            self.save(app, &value).await?;
        }
        *self.installed.lock().await = value.clone();
        Ok(value)
    }
    async fn save(&self, app: &AppHandle, items: &[InstalledLspPlugin]) -> Result<(), String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("lsp");
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|error| error.to_string())?;
        let path = dir.join("plugins.json");
        let temp = path.with_extension("tmp");
        tokio::fs::write(
            &temp,
            serde_json::to_vec_pretty(items).map_err(|error| error.to_string())?,
        )
        .await
        .map_err(|error| error.to_string())?;
        tokio::fs::rename(temp, path)
            .await
            .map_err(|error| error.to_string())?;
        *self.installed.lock().await = items.to_vec();
        Ok(())
    }
}

fn official_signing_key() -> Result<VerifyingKey, String> {
    verifying_key_from_encoded(option_env!("SIMPL_SSH_LSP_CATALOG_PUBLIC_KEY"))
}

fn verifying_key_from_encoded(encoded: Option<&str>) -> Result<VerifyingKey, String> {
    let encoded = encoded
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("托管 LSP 目录尚未配置可信签名公钥。")?;
    let raw = BASE64
        .decode(encoded)
        .map_err(|_| "托管 LSP 签名公钥编码无效".to_string())?;
    let raw: [u8; 32] = raw
        .try_into()
        .map_err(|_| "托管 LSP 签名公钥长度无效".to_string())?;
    VerifyingKey::from_bytes(&raw).map_err(|_| "托管 LSP 签名公钥无效".to_string())
}

fn parse_signed_catalog(
    bytes: &[u8],
    key: &VerifyingKey,
) -> Result<Vec<LspPluginManifest>, String> {
    let envelope: SignedLspCatalog =
        serde_json::from_slice(bytes).map_err(|error| format!("插件目录格式无效：{error}"))?;
    let payload = BASE64
        .decode(envelope.payload)
        .map_err(|_| "插件目录 payload 编码无效".to_string())?;
    let signature = Signature::from_slice(
        &BASE64
            .decode(envelope.signature)
            .map_err(|_| "插件目录签名编码无效".to_string())?,
    )
    .map_err(|_| "插件目录签名格式无效".to_string())?;
    key.verify(&payload, &signature)
        .map_err(|_| "插件目录签名校验失败".to_string())?;
    let catalog: LspCatalogPayload = serde_json::from_slice(&payload)
        .map_err(|error| format!("插件目录 payload 无效：{error}"))?;
    if catalog.schema_version != 2 {
        return Err(format!("不支持的插件目录版本：{}", catalog.schema_version));
    }
    if catalog.plugins.is_empty() {
        return Err("插件目录不能为空".into());
    }
    for plugin in &catalog.plugins {
        if plugin.id.is_empty()
            || plugin.version.is_empty()
            || plugin.id.contains(['/', '\\'])
            || plugin.version.contains(['/', '\\'])
            || plugin.runtimes.values().any(|runtime| {
                runtime.executable.is_empty()
                    || runtime.executable.contains(['\\', '\0'])
                    || !is_safe_runtime_relative_path(&runtime.executable)
                    || !runtime.archive_url.starts_with("https://")
                    || runtime.sha256.len() != 64
                    || !runtime.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                    || runtime
                        .size_bytes
                        .is_none_or(|size| size == 0 || size > MAX_ARCHIVE_BYTES)
                    || BASE64
                        .decode(&runtime.signature)
                        .map_or(true, |value| value.len() != 64)
            })
        {
            return Err("插件目录包含无效插件标识或运行时路径".into());
        }
    }
    Ok(catalog.plugins)
}

fn is_safe_runtime_relative_path(path: &str) -> bool {
    Path::new(path)
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
}

fn emit_install_progress(
    app: &AppHandle,
    manifest: &LspPluginManifest,
    phase: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    bytes_per_second: Option<u64>,
    message: Option<&str>,
) {
    let _ = app.emit(
        "lsp-plugin://download",
        LspInstallProgress {
            plugin_id: manifest.id.clone(),
            version: manifest.version.clone(),
            phase: phase.into(),
            downloaded_bytes,
            total_bytes,
            bytes_per_second,
            message: message.map(str::to_owned),
        },
    );
}

fn runtime_signature_payload(
    manifest: &LspPluginManifest,
    runtime: &LspPluginRuntime,
    platform: &str,
    hash: &str,
    size: u64,
) -> Vec<u8> {
    format!(
        "simpl-ssh-lsp-runtime-v2\n{}\n{}\n{}\n{}\n{}\n{}\n",
        manifest.id,
        manifest.version,
        platform,
        hash.to_ascii_lowercase(),
        size,
        runtime.executable
    )
    .into_bytes()
}

fn verify_runtime_descriptor(
    manifest: &LspPluginManifest,
    runtime: &LspPluginRuntime,
    platform: &str,
    actual_hash: &str,
    actual_size: u64,
) -> Result<(), String> {
    if !actual_hash.eq_ignore_ascii_case(&runtime.sha256) {
        return Err("插件包 SHA-256 校验失败".into());
    }
    if runtime
        .size_bytes
        .is_some_and(|expected| expected != actual_size)
    {
        return Err("插件包大小与受信任目录不一致".into());
    }
    let key = official_signing_key()?;
    let signature = Signature::from_slice(
        &BASE64
            .decode(&runtime.signature)
            .map_err(|_| "插件签名编码无效".to_string())?,
    )
    .map_err(|_| "插件签名格式无效".to_string())?;
    key.verify(
        &runtime_signature_payload(manifest, runtime, platform, actual_hash, actual_size),
        &signature,
    )
    .map_err(|_| "插件签名校验失败".to_string())
}

fn extract_archive_file(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let input = std::fs::File::open(archive_path).map_err(|error| error.to_string())?;
    let mut archive =
        zip::ZipArchive::new(input).map_err(|error| format!("插件包格式无效：{error}"))?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|error| error.to_string())?;
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("插件包包含符号链接，已拒绝安装".into());
        }
        let Some(name) = file.enclosed_name().map(|path| path.to_path_buf()) else {
            return Err("插件包包含越界路径".into());
        };
        let target = destination.join(name);
        if file.is_dir() {
            std::fs::create_dir_all(&target).map_err(|error| error.to_string())?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut output = std::fs::File::create(&target).map_err(|error| error.to_string())?;
            std::io::copy(&mut file, &mut output).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            if let Some(mode) = file.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode & 0o777))
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}
fn is_executable(path: &Path) -> bool {
    path.is_file() && {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(path)
                .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        }
        #[cfg(not(unix))]
        {
            true
        }
    }
}
fn platform_key() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("windows", "aarch64") => "windows-arm64",
        ("windows", _) => "windows-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("linux", _) => "linux-x64",
        _ => "unsupported",
    }
}

fn builtin_catalog() -> Vec<LspPluginManifest> {
    [
        (
            "typescript",
            "TypeScript Language Server",
            vec!["javascript", "typescript"],
        ),
        ("pyright", "Pyright", vec!["python"]),
        ("rust-analyzer", "rust-analyzer", vec!["rust"]),
        ("gopls", "gopls", vec!["go"]),
        ("jdtls", "Eclipse JDT Language Server", vec!["java"]),
        ("clangd", "clangd", vec!["c", "cpp"]),
    ]
    .into_iter()
    .map(|(id, name, languages)| LspPluginManifest {
        id: id.into(),
        version: "1.0.0".into(),
        name: name.into(),
        publisher: "Simpl SSH Official".into(),
        description: format!(
            "标准 LSP 服务：{}。需要时点击“下载并启用”。",
            languages.join(", ")
        ),
        languages: languages
            .into_iter()
            .map(|language| LspPluginLanguage {
                id: language.into(),
                extensions: Vec::new(),
                lsp_id: language.into(),
            })
            .collect(),
        root_markers: vec![".git".into()],
        capabilities: vec![
            "diagnostics".into(),
            "completion".into(),
            "hover".into(),
            "semanticTokens".into(),
        ],
        runtimes: HashMap::new(),
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::io::{Cursor, Write};

    fn signed_catalog(plugin_id: &str) -> (Vec<u8>, VerifyingKey) {
        let signing_key = SigningKey::from_bytes(&[7; 32]);
        let payload = serde_json::to_vec(&LspCatalogPayload {
            schema_version: 2,
            plugins: vec![LspPluginManifest {
                id: plugin_id.into(),
                version: "1.2.3".into(),
                name: "Test server".into(),
                publisher: "Simpl SSH".into(),
                description: "Test".into(),
                languages: vec![],
                root_markers: vec![],
                capabilities: vec![],
                runtimes: HashMap::from([(
                    platform_key().into(),
                    LspPluginRuntime {
                        archive_url: "https://example.invalid/test.zip".into(),
                        sha256: "00".repeat(32),
                        signature: BASE64.encode([0u8; 64]),
                        executable: "bin/test-lsp".into(),
                        args: vec![],
                        size_bytes: Some(12),
                    },
                )]),
            }],
        })
        .unwrap();
        let envelope = SignedLspCatalog {
            payload: BASE64.encode(&payload),
            signature: BASE64.encode(signing_key.sign(&payload).to_bytes()),
        };
        (
            serde_json::to_vec(&envelope).unwrap(),
            signing_key.verifying_key(),
        )
    }

    #[test]
    fn accepts_valid_signed_catalog() {
        let (bytes, key) = signed_catalog("test-lsp");
        let catalog = parse_signed_catalog(&bytes, &key).unwrap();
        assert_eq!(catalog[0].id, "test-lsp");
    }

    #[test]
    fn rejects_catalog_with_modified_signed_payload() {
        let (bytes, key) = signed_catalog("test-lsp");
        let mut envelope: SignedLspCatalog = serde_json::from_slice(&bytes).unwrap();
        let mut payload = BASE64.decode(&envelope.payload).unwrap();
        payload[0] ^= 1;
        envelope.payload = BASE64.encode(payload);
        assert!(parse_signed_catalog(&serde_json::to_vec(&envelope).unwrap(), &key).is_err());
    }

    #[test]
    fn rejects_catalog_runtime_path_escape() {
        let (bytes, key) = signed_catalog("test-lsp");
        let signing_key = SigningKey::from_bytes(&[7; 32]);
        let mut envelope: SignedLspCatalog = serde_json::from_slice(&bytes).unwrap();
        let mut payload: LspCatalogPayload =
            serde_json::from_slice(&BASE64.decode(&envelope.payload).unwrap()).unwrap();
        payload.plugins[0]
            .runtimes
            .get_mut(platform_key())
            .unwrap()
            .executable = "../escape".into();
        let payload = serde_json::to_vec(&payload).unwrap();
        envelope.payload = BASE64.encode(&payload);
        envelope.signature = BASE64.encode(signing_key.sign(&payload).to_bytes());
        assert!(parse_signed_catalog(&serde_json::to_vec(&envelope).unwrap(), &key).is_err());
    }

    #[test]
    fn missing_or_empty_public_key_is_reported_as_unconfigured() {
        for value in [None, Some(""), Some("  \n\t")] {
            assert!(verifying_key_from_encoded(value)
                .unwrap_err()
                .contains("尚未配置"));
        }
    }

    #[test]
    fn rejects_path_traversal_archive_entry() {
        let bytes = {
            let mut buffer = Cursor::new(Vec::new());
            let mut writer = zip::ZipWriter::new(&mut buffer);
            writer
                .start_file("../escape", zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"bad").unwrap();
            writer.finish().unwrap();
            buffer.into_inner()
        };
        let unique = uuid::Uuid::new_v4().to_string();
        let archive = std::env::temp_dir().join(format!("simpl-lsp-{unique}.zip"));
        let destination = std::env::temp_dir().join(format!("simpl-lsp-{unique}"));
        std::fs::write(&archive, bytes).unwrap();
        assert!(extract_archive_file(&archive, &destination).is_err());
        assert!(!destination.parent().unwrap().join("escape").exists());
        let _ = std::fs::remove_file(archive);
        let _ = std::fs::remove_dir_all(destination);
    }
}
