import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, PlugZap, RefreshCw, Search, Trash2 } from "lucide-react";
import { useSettings } from "../settings/SettingsProvider";
import type { InstalledLspPlugin, LspPluginAvailability, LspPluginManifest } from "../settings/types";
import { LoadingState } from "./LoadingState";
import { useLspInstallProgress } from "../lsp/LspInstallProvider";

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 1024 ? 0 : 1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function phaseLabel(phase: import("../settings/types").LspInstallPhase) {
  return { resolving: "正在准备…", downloading: "正在下载", verifying: "正在校验签名…", extracting: "正在解压…", activating: "正在启用…", ready: "已就绪", cancelled: "已取消", failed: "安装失败" }[phase];
}

/** 独立工作区中的 LSP 驱动目录；设置中心只负责跳转到这里。 */
export function LspPluginCatalogPane() {
  const { updateSettings } = useSettings();
  const { progress } = useLspInstallProgress();
  const [catalog, setCatalog] = useState<LspPluginManifest[]>([]);
  const [installed, setInstalled] = useState<InstalledLspPlugin[]>([]);
  const [availability, setAvailability] = useState<LspPluginAvailability[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setError("");
    const [nextCatalog, nextInstalled, nextAvailability] = await Promise.all([
      invoke<LspPluginManifest[]>("lsp_catalog_list"),
      invoke<InstalledLspPlugin[]>("lsp_plugin_status"),
      invoke<LspPluginAvailability[]>("lsp_plugin_check").catch(() => []),
    ]);
    setCatalog(nextCatalog);
    setInstalled(nextInstalled);
    setAvailability(nextAvailability);
    updateSettings({ installedLspPlugins: nextInstalled });
  }, [updateSettings]);

  useEffect(() => { void reload().catch((reason) => setError(String(reason))); }, [reload]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? catalog.filter((plugin) => `${plugin.name} ${plugin.description} ${plugin.languages.map((language) => language.id).join(" ")}`.toLowerCase().includes(needle)) : catalog;
  }, [catalog, query]);

  async function install(plugin: LspPluginManifest) {
    setBusy(plugin.id);
    setError("");
    try {
      await invoke("lsp_plugin_install", { pluginId: plugin.id, version: plugin.version });
      await reload();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(plugin: LspPluginManifest, enabled: boolean) {
    const item = installed.find((candidate) => candidate.pluginId === plugin.id && candidate.version === plugin.version);
    if (!item) return;
    try {
      const next = await invoke<InstalledLspPlugin[]>(enabled ? "lsp_plugin_enable" : "lsp_plugin_disable", { pluginId: plugin.id, version: plugin.version, priority: item.priority });
      setInstalled(next);
      updateSettings({ installedLspPlugins: next });
    } catch (reason) { setError(String(reason)); }
  }

  async function remove(plugin: LspPluginManifest) {
    setBusy(plugin.id);
    try {
      await invoke("lsp_plugin_uninstall", { pluginId: plugin.id, version: plugin.version });
      await reload();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(null); }
  }

  return <section className="lsp-catalog-workspace">
    <header className="lsp-catalog-header">
      <div><PlugZap size={20} /><span><strong>LSP 插件目录</strong><small>应用托管的语言服务与本机自定义服务彼此独立</small></span></div>
      <label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索语言或服务…" /></label>
      <button className="btn btn-ghost" disabled={busy === "catalog"} onClick={async () => { setBusy("catalog"); try { await invoke("lsp_plugin_refresh_catalog"); await reload(); } catch (reason) { setError(String(reason)); } finally { setBusy(null); } }}><RefreshCw size={14} /> 刷新受信任目录</button>
    </header>
    {error && <div className="persistent-error" role="alert"><strong>语言服务目录操作失败</strong><span>{error}</span><button onClick={() => void reload()}>重试</button></div>}
    {!catalog.length && !error ? <LoadingState label="正在读取语言服务目录…" /> : <div className="lsp-catalog-grid">
      {visible.map((plugin) => {
        const item = installed.find((candidate) => candidate.pluginId === plugin.id && candidate.version === plugin.version);
        const state = availability.find((candidate) => candidate.pluginId === plugin.id && candidate.version === plugin.version);
        const download = progress[plugin.id];
        const installing = download && ["resolving", "downloading", "verifying", "extracting", "activating"].includes(download.phase);
        return <article className="lsp-catalog-card" key={`${plugin.id}@${plugin.version}`}>
          <div className="lsp-catalog-card-head"><PlugZap size={18} /><span><strong>{plugin.name}</strong><small>{plugin.publisher} · v{plugin.version}</small></span></div>
          <p>{plugin.description}</p>
          <div className="lsp-catalog-languages">{plugin.languages.map((language) => <span key={language.id}>{language.id}</span>)}</div>
          <div className={`lsp-runtime-state ${state?.status ?? "missing"}`}>{state?.status === "available" ? "已就绪" : state?.detail || "尚未安装托管运行时"}</div>
          {download && !["ready", "cancelled"].includes(download.phase) && <div className={`lsp-download-progress ${download.phase}`} aria-live="polite" aria-label={download.message ?? phaseLabel(download.phase)}><i style={{ width: `${download.phase === "downloading" && download.totalBytes ? Math.min(100, download.downloadedBytes / download.totalBytes * 100) : download.phase === "resolving" ? 8 : download.phase === "verifying" ? 72 : download.phase === "extracting" ? 84 : 94}%` }} /><span><strong>{phaseLabel(download.phase)}</strong>{download.phase === "downloading" && <> {formatBytes(download.downloadedBytes)}{download.totalBytes ? ` / ${formatBytes(download.totalBytes)} (${Math.round(download.downloadedBytes / download.totalBytes * 100)}%)` : ""}{download.bytesPerSecond ? ` · ${formatBytes(download.bytesPerSecond)}/s` : ""}</>}{download.phase === "failed" && download.message ? ` · ${download.message}` : ""}</span></div>}
          <footer>{item ? <>
            <label className="lsp-enable-toggle"><input type="checkbox" checked={item.enabled} onChange={(event) => void toggle(plugin, event.target.checked)} />{item.enabled ? "已启用" : "已停用"}</label>
            {item.source === "managed" && <button className="btn btn-ghost" onClick={async () => { try { await invoke("lsp_plugin_rollback", { pluginId: plugin.id, version: plugin.version }); await reload(); } catch (reason) { setError(String(reason)); } }}>回滚</button>}
            <button className="btn btn-ghost" disabled={busy === plugin.id} onClick={() => void remove(plugin)}><Trash2 size={13} /> 从 Simpl SSH 移除</button>
          </> : busy === plugin.id || installing ? <button className="btn btn-ghost" onClick={() => void invoke("lsp_plugin_cancel_install", { pluginId: plugin.id, version: plugin.version })}>取消下载</button> : state?.status === "unavailable" ? <button className="btn btn-ghost" disabled>当前平台暂不可安装</button> : <button className="btn btn-primary" onClick={() => void install(plugin)}><Download size={14} /> 下载并启用</button>}</footer>
        </article>;
      })}
      {!visible.length && <div className="preferences-empty"><Search size={22} /><strong>没有匹配的语言服务</strong></div>}
    </div>}
  </section>;
}
