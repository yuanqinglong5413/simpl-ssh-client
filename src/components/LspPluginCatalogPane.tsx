import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Download, PlugZap, RefreshCw, Search, Trash2 } from "lucide-react";
import { useSettings } from "../settings/SettingsProvider";
import type { InstalledLspPlugin, LspPluginAvailability, LspPluginManifest } from "../settings/types";
import { LoadingState } from "./LoadingState";

/** 独立工作区中的 LSP 驱动目录；设置中心只负责跳转到这里。 */
export function LspPluginCatalogPane() {
  const { updateSettings } = useSettings();
  const [catalog, setCatalog] = useState<LspPluginManifest[]>([]);
  const [installed, setInstalled] = useState<InstalledLspPlugin[]>([]);
  const [availability, setAvailability] = useState<LspPluginAvailability[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<Record<string, { downloaded: number; total?: number; status: string }>>({});

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
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void listen<{ pluginId: string; version: string; downloaded: number; total?: number; status: string }>("lsp-plugin://download", (event) => {
      setProgress((current) => ({ ...current, [event.payload.pluginId]: event.payload }));
    }).then((unlisten) => { dispose = unlisten; });
    return () => dispose?.();
  }, []);
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
        return <article className="lsp-catalog-card" key={`${plugin.id}@${plugin.version}`}>
          <div className="lsp-catalog-card-head"><PlugZap size={18} /><span><strong>{plugin.name}</strong><small>{plugin.publisher} · v{plugin.version}</small></span></div>
          <p>{plugin.description}</p>
          <div className="lsp-catalog-languages">{plugin.languages.map((language) => <span key={language.id}>{language.id}</span>)}</div>
          <div className={`lsp-runtime-state ${state?.status ?? "missing"}`}>{state?.status === "available" ? "已就绪" : state?.detail || "尚未安装托管运行时"}</div>
          {busy === plugin.id && download && <div className="lsp-download-progress" aria-label={`已下载 ${download.downloaded} 字节`}><i style={{ width: `${download.total ? Math.min(100, download.downloaded / download.total * 100) : 15}%` }} /><span>{download.status === "verifying" ? "正在校验签名…" : download.total ? `${Math.round(download.downloaded / download.total * 100)}%` : `${(download.downloaded / 1024 / 1024).toFixed(1)} MB`}</span></div>}
          <footer>{item ? <>
            <label className="lsp-enable-toggle"><input type="checkbox" checked={item.enabled} onChange={(event) => void toggle(plugin, event.target.checked)} />{item.enabled ? "已启用" : "已停用"}</label>
            {item.source === "managed" && <button className="btn btn-ghost" onClick={async () => { try { await invoke("lsp_plugin_rollback", { pluginId: plugin.id, version: plugin.version }); await reload(); } catch (reason) { setError(String(reason)); } }}>回滚</button>}
            <button className="btn btn-ghost" disabled={busy === plugin.id} onClick={() => void remove(plugin)}><Trash2 size={13} /> 从 Simpl SSH 移除</button>
          </> : busy === plugin.id ? <button className="btn btn-ghost" onClick={() => void invoke("lsp_plugin_cancel_install", { pluginId: plugin.id, version: plugin.version })}>取消下载</button> : <button className="btn btn-primary" onClick={() => void install(plugin)}><Download size={14} /> 下载并启用</button>}</footer>
        </article>;
      })}
      {!visible.length && <div className="preferences-empty"><Search size={22} /><strong>没有匹配的语言服务</strong></div>}
    </div>}
  </section>;
}
