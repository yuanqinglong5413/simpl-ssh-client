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
    io::Cursor,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::Command;
use tokio::sync::Mutex;

const MAX_ARCHIVE_BYTES: usize = 512 * 1024 * 1024;
const MAX_CATALOG_BYTES: usize = 4 * 1024 * 1024;
const CATALOG_URL: &str = "https://github.com/yuanqinglong5413/simpl-ssh-client/releases/latest/download/lsp-catalog.json";

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
struct LspPluginDownloadProgress {
    plugin_id: String,
    version: String,
    downloaded: u64,
    total: Option<u64>,
    status: String,
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
                let installed_item = installed
                    .iter()
                    .find(|item| item.plugin_id == manifest.id && item.version == manifest.version);
                let source = installed_item
                    .map(|item| if matches!(item.source.as_str(), "bundled" | "managed") { "managed" } else { "system-detected" })
                    .unwrap_or_else(|| if manifest.runtimes.contains_key(platform_key()) { "managed" } else { "system-detected" });
                if source == "managed" {
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
                    return LspPluginAvailability {
                        plugin_id: manifest.id,
                        version: manifest.version,
                        status: if available { "available" } else { "missing" }.into(),
                        source: "managed".into(),
                        executable,
                        detail: if available { "应用托管运行时已安装" } else { "应用托管运行时尚未安装" }.into(),
                    };
                }
                match resolve_system_command(&manifest.id) {
                    Ok(executable) if manifest.id == "jdtls" => match resolve_program("java") {
                        Some(java) => LspPluginAvailability {
                            plugin_id: manifest.id,
                            version: manifest.version,
                            status: "available".into(),
                            source: "system-detected".into(),
                            executable: Some(executable),
                            detail: format!("系统命令可用；Java: {}", java.to_string_lossy()),
                        },
                        None => LspPluginAvailability {
                            plugin_id: manifest.id,
                            version: manifest.version,
                            status: "unavailable".into(),
                            source: "system-detected".into(),
                            executable: Some(executable),
                            detail: "已找到 jdtls，但没有找到 Java。请安装 JDK 并设置 JAVA_HOME 或 PATH。".into(),
                        },
                    },
                    Ok(executable) => LspPluginAvailability {
                        plugin_id: manifest.id,
                        version: manifest.version,
                        status: "available".into(),
                        source: "system-detected".into(),
                        executable: Some(executable),
                        detail: "系统命令可用".into(),
                    },
                    Err(error) => LspPluginAvailability {
                        plugin_id: manifest.id,
                        version: manifest.version,
                        status: "missing".into(),
                        source: "system-detected".into(),
                        executable: None,
                        detail: error,
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
        let runtime = manifest.runtimes.get(platform_key()).cloned();
        if runtime
            .as_ref()
            .is_none_or(|runtime| runtime.archive_url.is_empty())
        {
            let source = if resolve_system_command(plugin_id).is_ok() {
                "system-detected"
            } else {
                let key = format!("{plugin_id}@{version}");
                let cancelled = Arc::new(AtomicBool::new(false));
                {
                    let mut downloads = self.downloads.lock().await;
                    if downloads.contains_key(&key) {
                        return Err("该语言服务正在下载".into());
                    }
                    downloads.insert(key.clone(), cancelled.clone());
                }
                let result = self
                    .install_system_runtime(app, plugin_id, &cancelled)
                    .await;
                self.downloads.lock().await.remove(&key);
                result?
            };
            let item = InstalledLspPlugin {
                plugin_id: manifest.id,
                version: manifest.version,
                enabled: true,
                priority: 0,
                source: source.into(),
            };
            let mut items = self.load(app).await?;
            items.retain(|old| old.plugin_id != item.plugin_id || old.version != item.version);
            items.push(item.clone());
            self.save(app, &items).await?;
            return Ok(item);
        }
        let runtime = runtime.expect("checked above");
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
        let bytes = result?;
        verify_archive(&bytes, &runtime.sha256, &runtime.signature)?;
        let _ = app.emit(
            "lsp-plugin://download",
            LspPluginDownloadProgress {
                plugin_id: manifest.id.clone(),
                version: manifest.version.clone(),
                downloaded: bytes.len() as u64,
                total: Some(bytes.len() as u64),
                status: "verifying".into(),
            },
        );
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
        let temp_for_extract = temp.clone();
        tokio::task::spawn_blocking(move || extract_archive(&bytes, &temp_for_extract))
            .await
            .map_err(|error| error.to_string())??;
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
        if let Err(error) = tokio::fs::rename(&temp, &final_root).await {
            if tokio::fs::try_exists(&rollback_root).await.unwrap_or(false) {
                let _ = tokio::fs::rename(&rollback_root, &final_root).await;
            }
            return Err(error.to_string());
        }
        let item = InstalledLspPlugin {
            plugin_id: manifest.id,
            version: manifest.version,
            enabled: true,
            priority: 0,
            source: "managed".into(),
        };
        let mut items = self.load(app).await?;
        items.retain(|old| old.plugin_id != item.plugin_id || old.version != item.version);
        items.push(item.clone());
        self.save(app, &items).await?;
        Ok(item)
    }

    async fn download_archive(
        &self,
        app: &AppHandle,
        manifest: &LspPluginManifest,
        runtime: &LspPluginRuntime,
        cancelled: &AtomicBool,
    ) -> Result<Vec<u8>, String> {
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
        let total = response.content_length();
        if total.is_some_and(|size| size as usize > MAX_ARCHIVE_BYTES) {
            return Err("插件包超过 512MB 限制".into());
        }
        let mut stream = response.bytes_stream();
        let mut bytes =
            Vec::with_capacity(total.unwrap_or_default().min(16 * 1024 * 1024) as usize);
        while let Some(chunk) = stream.next().await {
            if cancelled.load(Ordering::Acquire) {
                return Err("下载已取消".into());
            }
            let chunk = chunk.map_err(|error| format!("读取插件失败：{error}"))?;
            if bytes.len().saturating_add(chunk.len()) > MAX_ARCHIVE_BYTES {
                return Err("插件包超过 512MB 限制".into());
            }
            bytes.extend_from_slice(&chunk);
            let _ = app.emit(
                "lsp-plugin://download",
                LspPluginDownloadProgress {
                    plugin_id: manifest.id.clone(),
                    version: manifest.version.clone(),
                    downloaded: bytes.len() as u64,
                    total,
                    status: "downloading".into(),
                },
            );
        }
        Ok(bytes)
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

    /// 内置目录尚未发布签名包时的用户主动安装回退。命令不经过 shell、不会
    /// 使用 sudo 或修改项目目录；当前支持 Homebrew / Linuxbrew。
    async fn install_system_runtime(
        &self,
        app: &AppHandle,
        plugin_id: &str,
        cancelled: &AtomicBool,
    ) -> Result<&'static str, String> {
        let formula = system_formula(plugin_id)?;
        let brew = resolve_program("brew").ok_or_else(|| {
            "当前设备没有可用的自动安装器。请安装 Homebrew 后重试；Simpl SSH 不会在后台自行执行系统安装。"
                .to_string()
        })?;
        let _ = app.emit(
            "lsp-plugin://download",
            LspPluginDownloadProgress {
                plugin_id: plugin_id.into(),
                version: "1.0.0".into(),
                downloaded: 0,
                total: None,
                status: "installing-system".into(),
            },
        );
        let mut command = Command::new(&brew);
        command
            .args(["install", formula])
            .env("HOMEBREW_NO_AUTO_UPDATE", "1")
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let child = command
            .spawn()
            .map_err(|error| format!("无法启动自动安装器：{error}"))?;
        let output_future = child.wait_with_output();
        tokio::pin!(output_future);
        let output = tokio::time::timeout(Duration::from_secs(15 * 60), async {
            loop {
                tokio::select! {
                    result = &mut output_future => return result.map_err(|error| format!("自动安装器执行失败：{error}")),
                    _ = tokio::time::sleep(Duration::from_millis(120)) => if cancelled.load(Ordering::Acquire) { return Err("下载已取消".into()); }
                }
            }
        }).await.map_err(|_| format!("下载 {formula} 超时，请检查网络后重试"))??;
        if !output.status.success() {
            let mut detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if detail.is_empty() {
                detail = String::from_utf8_lossy(&output.stdout).trim().to_string();
            }
            let detail = detail
                .chars()
                .rev()
                .take(1_200)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>();
            return Err(format!(
                "下载 {formula} 失败{}",
                if detail.is_empty() {
                    String::new()
                } else {
                    format!("：{detail}")
                }
            ));
        }
        resolve_system_command(plugin_id)
            .map_err(|_| format!("{formula} 已下载，但未找到可执行文件；请重新打开设置后重试"))?;
        let _ = app.emit("lsp-plugin://download", format!("{plugin_id} 已下载并启用"));
        Ok("system-detected")
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
            return Ok((resolve_system_command(plugin_id)?, system_args(plugin_id)));
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
        .ok_or("托管 LSP 目录尚未配置可信签名公钥；系统语言服务仍可继续使用。")?;
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
    if catalog.schema_version != 1 {
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

fn verify_archive(bytes: &[u8], expected_hash: &str, signature: &str) -> Result<(), String> {
    let digest = Sha256::digest(bytes);
    let actual = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if !actual.eq_ignore_ascii_case(expected_hash) {
        return Err("插件包 SHA-256 校验失败".into());
    }
    let key = official_signing_key()?;
    let signature = Signature::from_slice(
        &BASE64
            .decode(signature)
            .map_err(|_| "插件签名编码无效".to_string())?,
    )
    .map_err(|_| "插件签名格式无效".to_string())?;
    key.verify(bytes, &signature)
        .map_err(|_| "插件签名校验失败".to_string())
}
fn extract_archive(bytes: &[u8], destination: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("插件包格式无效：{error}"))?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|error| error.to_string())?;
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

fn system_command(plugin_id: &str) -> Result<String, String> {
    let command = match plugin_id {
        "typescript" => "typescript-language-server",
        "pyright" => "pyright-langserver",
        "rust-analyzer" => "rust-analyzer",
        "gopls" => "gopls",
        "jdtls" => "jdtls",
        "clangd" => "clangd",
        _ => return Err("未知插件命令".into()),
    };
    Ok(command.into())
}

fn system_formula(plugin_id: &str) -> Result<&'static str, String> {
    match plugin_id {
        "typescript" => Ok("typescript-language-server"),
        "pyright" => Ok("pyright"),
        "rust-analyzer" => Ok("rust-analyzer"),
        "gopls" => Ok("gopls"),
        "jdtls" => Ok("jdtls"),
        // Homebrew 的 clangd 随 LLVM 发布；下方会在 opt/llvm/bin 内寻找它。
        "clangd" => Ok("llvm"),
        _ => Err("未知插件安装来源".into()),
    }
}

/// 桌面应用从 Finder 启动时通常没有继承交互式 shell 的完整 PATH。
/// 系统插件仍然直接执行真实文件（不经过 shell），这里只负责查找可执行文件。
fn resolve_system_command(plugin_id: &str) -> Result<String, String> {
    let command = system_command(plugin_id)?;
    resolve_program(&command)
        .map(|candidate| candidate.to_string_lossy().into_owned())
        .ok_or_else(|| format!("`{command}` 尚未下载"))
}

fn resolve_program(command: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if Path::new(command).is_absolute() {
        candidates.push(PathBuf::from(command));
    } else {
        if let Some(path) = std::env::var_os("PATH") {
            candidates.extend(std::env::split_paths(&path).flat_map(|directory| {
                #[cfg(windows)]
                {
                    let extensions = std::env::var_os("PATHEXT")
                        .unwrap_or_else(|| ".EXE;.CMD;.BAT".into())
                        .to_string_lossy()
                        .split(';')
                        .map(str::to_owned)
                        .collect::<Vec<_>>();
                    let mut paths = vec![directory.join(command)];
                    paths.extend(
                        extensions
                            .into_iter()
                            .map(|extension| directory.join(format!("{command}{extension}"))),
                    );
                    paths
                }
                #[cfg(not(windows))]
                {
                    vec![directory.join(command)]
                }
            }));
        }
        if let Some(home) = dirs::home_dir() {
            candidates.extend([
                home.join(".local/bin").join(command),
                home.join(".local/share/nvim/mason/bin").join(command),
                home.join(".local/share/mason/bin").join(command),
                home.join(".sdkman/candidates/jdtls/current/bin")
                    .join(command),
            ]);
        }
        #[cfg(target_os = "macos")]
        candidates.extend([
            PathBuf::from("/opt/homebrew/bin").join(command),
            PathBuf::from("/usr/local/bin").join(command),
            PathBuf::from("/opt/homebrew/opt/llvm/bin").join(command),
            PathBuf::from("/usr/local/opt/llvm/bin").join(command),
        ]);
    }
    candidates
        .into_iter()
        .find(|candidate| is_executable(candidate))
}

fn system_args(plugin_id: &str) -> Vec<String> {
    if matches!(plugin_id, "typescript" | "pyright") {
        vec!["--stdio".into()]
    } else {
        Vec::new()
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

    fn signed_catalog(plugin_id: &str) -> (Vec<u8>, VerifyingKey) {
        let signing_key = SigningKey::from_bytes(&[7; 32]);
        let payload = serde_json::to_vec(&LspCatalogPayload {
            schema_version: 1,
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
                        signature: "signature".into(),
                        executable: "bin/test-lsp".into(),
                        args: vec![],
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
    fn builtin_installers_cover_every_official_plugin() {
        for plugin in [
            "typescript",
            "pyright",
            "rust-analyzer",
            "gopls",
            "jdtls",
            "clangd",
        ] {
            assert!(
                system_formula(plugin).is_ok(),
                "missing installer for {plugin}"
            );
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
            std::io::Write::write_all(&mut writer, b"bad").unwrap();
            writer.finish().unwrap();
            buffer.into_inner()
        };
        assert!(
            extract_archive(&bytes, Path::new("/tmp/simpl-lsp-test")).is_err()
                || !Path::new("/tmp/escape").exists()
        );
    }
}
