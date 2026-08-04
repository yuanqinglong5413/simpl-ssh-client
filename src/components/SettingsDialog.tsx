import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import {
  Bot, Check, CircleHelp, Code2, Download, Keyboard,
  LayoutDashboard, MonitorCog, Palette, PanelLeft, PlugZap, RefreshCw,
  RotateCcw, Search, Settings, Shield, SlidersHorizontal, Terminal, X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FONT_OPTIONS, type AgentPreset, type InstalledLspPlugin, type LspPluginAvailability, type LspPluginManifest, type LanguageServerConfig } from "../settings/types";
import { useSettings } from "../settings/SettingsProvider";
import { useUpdater } from "../hooks/useUpdater";
import { changeLanguage } from "../i18n";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useTheme } from "../theme/ThemeProvider";
import {
  PREFERENCE_CATEGORIES,
  resetPatchForCategory,
  searchPreferenceCategories,
  type PreferenceCategoryId,
} from "../settings/preferences";
import { ConfirmDialog } from "./DialogPrimitives";
import { KnownHostsDialog } from "./KnownHostsDialog";
import { LANGUAGE_DEFINITIONS } from "../utils/editorLanguages";

type Props = { open: boolean; onClose: () => void; onOpenLspCatalog?: () => void };
type ResetTarget = PreferenceCategoryId | "all";

const CATEGORY_ICONS: Record<PreferenceCategoryId, LucideIcon> = {
  general: SlidersHorizontal,
  appearance: Palette,
  terminal: Terminal,
  language: Code2,
  lspPlugins: PlugZap,
  connection: Shield,
  workspace: LayoutDashboard,
  agents: Bot,
  shortcuts: Keyboard,
  updates: Download,
};

const SHORTCUT_GROUPS = [
  ["工作台", [["新建连接", "⌘/Ctrl N"], ["打开设置", "⌘/Ctrl ,"], ["命令面板", "⌘/Ctrl K 或 P"]]],
  ["标签", [["关闭当前标签", "⌘/Ctrl W"], ["下一个标签", "⌘/Ctrl Tab"], ["上一个标签", "⌘/Ctrl Shift Tab"]]],
  ["终端", [["终端内搜索", "⌘/Ctrl F"], ["完整重绘", "Ctrl Alt R"]]],
] as const;

/** IDEA 式偏好设置窗口：分类导航 + 全局搜索；所有修改立即持久化。 */
export function SettingsDialog({ open, onClose, onOpenLspCatalog }: Props) {
  const { settings, updateSettings, resetSettings } = useSettings();
  const { checking, message: updateMsg, checkForUpdates } = useUpdater();
  const { themeId, themes, setTheme, resetTheme } = useTheme();
  const dialogRef = useDialogFocus(open, onClose);
  const searchRef = useRef<HTMLInputElement>(null);
  const [activeCategory, setActiveCategory] = useState<PreferenceCategoryId>("general");
  const [query, setQuery] = useState("");
  const [agentName, setAgentName] = useState("");
  const [agentCommand, setAgentCommand] = useState("");
  const [knownHostsOpen, setKnownHostsOpen] = useState(false);
  const [pendingReset, setPendingReset] = useState<ResetTarget | null>(null);
  const [pendingDeleteAgent, setPendingDeleteAgent] = useState<AgentPreset | null>(null);
  const [languageServerName, setLanguageServerName] = useState("");
  const [languageServerCommand, setLanguageServerCommand] = useState("");
  const [languageServerLanguages, setLanguageServerLanguages] = useState("");
  const [languageServerArgs, setLanguageServerArgs] = useState("");
  const [languageServerMarkers, setLanguageServerMarkers] = useState("");
  const [pendingDeleteLanguageServer, setPendingDeleteLanguageServer] = useState<LanguageServerConfig | null>(null);
  const [pluginCatalog, setPluginCatalog] = useState<LspPluginManifest[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledLspPlugin[]>([]);
  const [pluginAvailability, setPluginAvailability] = useState<LspPluginAvailability[]>([]);
  const [pluginBusy, setPluginBusy] = useState<string | null>(null);
  const [pluginError, setPluginError] = useState("");
  const [appVersion, setAppVersion] = useState("…");
  const [storageMessage, setStorageMessage] = useState("");

  useEffect(() => {
    if (!open) return;
    setActiveCategory("general");
    setQuery("");
  }, [open]);
  useEffect(() => { if (!open) return; setPluginError(""); void Promise.all([invoke<LspPluginManifest[]>("lsp_catalog_list"), invoke<InstalledLspPlugin[]>("lsp_plugin_status"), invoke<LspPluginAvailability[]>("lsp_plugin_check").catch(() => [])]).then(([catalog, installed, availability]) => { setPluginCatalog(catalog); setInstalledPlugins(installed); setPluginAvailability(availability); updateSettings({ installedLspPlugins: installed }); }).catch((error) => setPluginError(String(error))); }, [open, updateSettings]);
  useEffect(() => { if (open) void getVersion().then(setAppVersion).catch(() => setAppVersion("未知")); }, [open]);

  const searchMatches = useMemo(() => searchPreferenceCategories(query), [query]);
  const visibleCategories = query.trim() ? searchMatches : [activeCategory];

  if (!open) return null;

  const selectCategory = (id: PreferenceCategoryId) => {
    setActiveCategory(id);
    setQuery("");
  };
  const reset = (target: ResetTarget) => {
    if (target === "all") {
      resetSettings();
      resetTheme();
    } else {
      const patch = resetPatchForCategory(target);
      if (Object.keys(patch).length) updateSettings(patch);
      if (target === "appearance") resetTheme();
    }
    setPendingReset(null);
  };

  return (
    <>
      <div className="overlay settings-overlay" onClick={onClose}>
        <div
          ref={dialogRef}
          className="dialog preferences-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="偏好设置"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
              event.preventDefault();
              searchRef.current?.focus();
            }
          }}
        >
          <header className="preferences-head">
            <div className="preferences-title"><Settings size={17} /> 偏好设置</div>
            <label className="preferences-search">
              <Search size={15} />
              <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索设置，例如：字体、重连、Agent" aria-label="搜索设置" />
              {query && <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}><X size={13} /></button>}
            </label>
            <button type="button" className="preferences-close" onClick={onClose} aria-label="关闭设置"><X size={17} /></button>
          </header>

          <div className="preferences-main">
            <nav className="preferences-nav" aria-label="设置分类">
              <div className="preferences-nav-caption">设置</div>
              {PREFERENCE_CATEGORIES.map((category, index) => {
                const Icon = CATEGORY_ICONS[category.id];
                const searching = Boolean(query.trim());
                const matched = !searching || searchMatches.includes(category.id);
                return (
                  <button
                    key={category.id}
                    type="button"
                    className={`preferences-nav-item ${activeCategory === category.id && !searching ? "active" : ""} ${matched ? "" : "dim"}`}
                    aria-current={activeCategory === category.id && !searching ? "page" : undefined}
                    onClick={() => selectCategory(category.id)}
                    onKeyDown={(event) => navigateCategories(event, index, selectCategory)}
                  >
                    <Icon size={15} /><span>{category.label}</span>
                  </button>
                );
              })}
            </nav>

            <section className="preferences-content">
              {query.trim() && <div className="preferences-search-summary">搜索 “{query}” · {visibleCategories.length} 个分类</div>}
              {visibleCategories.length === 0 ? (
                <div className="preferences-empty"><Search size={22} /><strong>没有匹配的设置</strong><span>试试“主题”、“重连”、“字体”或“Agent”。</span></div>
              ) : visibleCategories.map((id) => (
                <PreferenceCategoryView
                  key={id}
                  id={id}
                  searchQuery={query}
                  settings={settings}
                  updateSettings={updateSettings}
                  themeId={themeId}
                  themes={themes}
                  setTheme={setTheme}
                  checking={checking}
                  updateMessage={updateMsg}
                  appVersion={appVersion}
                  storageMessage={storageMessage}
                  onBackupStorage={async () => { try { const path = await invoke<string>("storage_backup"); setStorageMessage(`数据库备份已创建：${path}`); } catch (error) { setStorageMessage(`备份失败：${String(error)}`); } }}
                  onCopyStorageDiagnostic={async () => { try { const status = await invoke("storage_status"); await navigator.clipboard.writeText(JSON.stringify(status, null, 2)); setStorageMessage("存储诊断已复制，不包含凭据或项目文件内容。"); } catch (error) { setStorageMessage(`复制诊断失败：${String(error)}`); } }}
                  onRetrySecretCleanup={async () => { try { const remaining = await invoke<number>("storage_retry_secret_cleanup"); setStorageMessage(remaining === 0 ? "钥匙串清理队列已处理完成。" : `仍有 ${remaining} 项钥匙串凭据无法删除，可稍后重试。`); } catch (error) { setStorageMessage(`重试凭据清理失败：${String(error)}`); } }}
                  onCheckUpdates={() => checkForUpdates(false)}
                  agentName={agentName}
                  agentCommand={agentCommand}
                  onAgentName={setAgentName}
                  onAgentCommand={setAgentCommand}
                  onDeleteAgent={setPendingDeleteAgent}
                  languageServerName={languageServerName}
                  languageServerCommand={languageServerCommand}
                  languageServerLanguages={languageServerLanguages}
                  languageServerArgs={languageServerArgs}
                  languageServerMarkers={languageServerMarkers}
                  onLanguageServerName={setLanguageServerName}
                  onLanguageServerCommand={setLanguageServerCommand}
                  onLanguageServerLanguages={setLanguageServerLanguages}
                  onLanguageServerArgs={setLanguageServerArgs}
                  onLanguageServerMarkers={setLanguageServerMarkers}
                  onDeleteLanguageServer={setPendingDeleteLanguageServer}
                  pluginCatalog={pluginCatalog}
                  installedPlugins={installedPlugins}
                  pluginAvailability={pluginAvailability}
                  pluginBusy={pluginBusy}
                  pluginError={pluginError}
                  onPluginRefresh={async () => {
                    setPluginBusy("catalog");
                    setPluginError("");
                    try {
                      const catalog = await invoke<LspPluginManifest[]>("lsp_plugin_refresh_catalog");
                      const [installed, availability] = await Promise.all([
                        invoke<InstalledLspPlugin[]>("lsp_plugin_status"),
                        invoke<LspPluginAvailability[]>("lsp_plugin_check").catch(() => []),
                      ]);
                      setPluginCatalog(catalog);
                      setInstalledPlugins(installed);
                      setPluginAvailability(availability);
                      updateSettings({ installedLspPlugins: installed });
                    } catch (error) {
                      setPluginError(String(error));
                    } finally {
                      setPluginBusy(null);
                    }
                  }}
                  onPluginInstall={async (plugin) => { setPluginBusy(plugin.id); setPluginError(""); try { const installed = await invoke<InstalledLspPlugin>("lsp_plugin_install", { pluginId: plugin.id, version: plugin.version }); const availability = await invoke<LspPluginAvailability[]>("lsp_plugin_check").catch(() => []); setInstalledPlugins((items) => { const next = [...items.filter((item) => !(item.pluginId === installed.pluginId && item.version === installed.version)), installed]; updateSettings({ installedLspPlugins: next }); return next; }); setPluginAvailability(availability); } catch (error) { setPluginError(String(error)); } finally { setPluginBusy(null); } }}
                  onPluginToggle={async (plugin, enabled) => { const installed = installedPlugins.find((item) => item.pluginId === plugin.id && item.version === plugin.version); if (!installed) return; try { const next = await invoke<InstalledLspPlugin[]>(enabled ? "lsp_plugin_enable" : "lsp_plugin_disable", { pluginId: plugin.id, version: plugin.version, priority: installed.priority }); setInstalledPlugins(next); updateSettings({ installedLspPlugins: next }); } catch (error) { setPluginError(String(error)); } }}
                  onPluginUninstall={async (plugin) => { try { await invoke("lsp_plugin_uninstall", { pluginId: plugin.id, version: plugin.version }); setInstalledPlugins((items) => { const next = items.filter((item) => !(item.pluginId === plugin.id && item.version === plugin.version)); updateSettings({ installedLspPlugins: next }); return next; }); } catch (error) { setPluginError(String(error)); } }}
                  onOpenLspCatalog={onOpenLspCatalog}
                  onKnownHosts={() => setKnownHostsOpen(true)}
                  onReset={() => setPendingReset(id)}
                />
              ))}
            </section>
          </div>

          <footer className="preferences-foot">
            <span>修改会立即生效并自动保存</span>
            <button type="button" className="btn btn-ghost" onClick={() => setPendingReset("all")}><RotateCcw size={14} /> 恢复全部默认</button>
            <button type="button" className="btn btn-primary" onClick={onClose}>完成</button>
          </footer>
        </div>
      </div>

      {knownHostsOpen && <KnownHostsDialog onClose={() => setKnownHostsOpen(false)} />}
      {pendingReset && <ConfirmDialog title={pendingReset === "all" ? "恢复全部默认设置" : "恢复此分类默认设置"} confirmLabel="恢复默认" danger={pendingReset === "all" || pendingReset === "agents"} onClose={() => setPendingReset(null)} onConfirm={() => reset(pendingReset)}>
        <p>{pendingReset === "agents" ? "这会删除所有自定义 Agent 启动项，并移除项目中的关联。" : pendingReset === "all" ? "这会恢复应用设置和主题；项目、连接和已知主机不会被删除。" : "此操作会立即恢复当前分类的默认值。"}</p>
      </ConfirmDialog>}
      {pendingDeleteAgent && <ConfirmDialog title="删除 Agent 启动项" confirmLabel="删除启动项" danger onClose={() => setPendingDeleteAgent(null)} onConfirm={() => { updateSettings({ agentPresets: settings.agentPresets.filter((preset) => preset.id !== pendingDeleteAgent.id) }); setPendingDeleteAgent(null); }}>
        <p>删除「<strong>{pendingDeleteAgent.name}</strong>」后，关联项目将不再显示或启动此 Agent。</p>
      </ConfirmDialog>}
      {pendingDeleteLanguageServer && <ConfirmDialog title="删除语言服务" confirmLabel="删除服务" danger onClose={() => setPendingDeleteLanguageServer(null)} onConfirm={() => { updateSettings({ languageServers: settings.languageServers.filter((server) => server.id !== pendingDeleteLanguageServer.id) }); setPendingDeleteLanguageServer(null); }}>
        <p>删除「<strong>{pendingDeleteLanguageServer.name}</strong>」后，相关项目将回退到语法高亮，已经打开的文件不会丢失。</p>
      </ConfirmDialog>}
    </>
  );
}

type CategoryViewProps = {
  id: PreferenceCategoryId;
  searchQuery: string;
  settings: ReturnType<typeof useSettings>["settings"];
  updateSettings: ReturnType<typeof useSettings>["updateSettings"];
  themeId: string;
  themes: ReturnType<typeof useTheme>["themes"];
  setTheme: ReturnType<typeof useTheme>["setTheme"];
  checking: boolean;
  updateMessage: string;
  appVersion: string;
  storageMessage: string;
  onBackupStorage: () => void;
  onCopyStorageDiagnostic: () => void;
  onRetrySecretCleanup: () => void;
  onCheckUpdates: () => void;
  agentName: string;
  agentCommand: string;
  onAgentName: (value: string) => void;
  onAgentCommand: (value: string) => void;
  onDeleteAgent: (preset: AgentPreset) => void;
  languageServerName: string;
  languageServerCommand: string;
  languageServerLanguages: string;
  languageServerArgs: string;
  languageServerMarkers: string;
  onLanguageServerName: (value: string) => void;
  onLanguageServerCommand: (value: string) => void;
  onLanguageServerLanguages: (value: string) => void;
  onLanguageServerArgs: (value: string) => void;
  onLanguageServerMarkers: (value: string) => void;
  onDeleteLanguageServer: (server: LanguageServerConfig) => void;
  pluginCatalog: LspPluginManifest[];
  installedPlugins: InstalledLspPlugin[];
  pluginAvailability: LspPluginAvailability[];
  pluginBusy: string | null;
  pluginError: string;
  onPluginRefresh: () => void;
  onPluginInstall: (plugin: LspPluginManifest) => void;
  onPluginToggle: (plugin: LspPluginManifest, enabled: boolean) => void;
  onPluginUninstall: (plugin: LspPluginManifest) => void;
  onOpenLspCatalog?: () => void;
  onKnownHosts: () => void;
  onReset: () => void;
};

function PreferenceCategoryView(props: CategoryViewProps) {
  const category = PREFERENCE_CATEGORIES.find((item) => item.id === props.id)!;
  const Icon = CATEGORY_ICONS[props.id];
  return (
    <div className="preference-category">
      <div className="preference-category-head">
        <div><h2><Icon size={18} /> <Highlight text={category.label} query={props.searchQuery} /></h2><p>{category.description}</p></div>
        {props.id !== "shortcuts" && <button type="button" className="preference-reset" onClick={props.onReset}><RotateCcw size={13} /> 恢复此分类默认</button>}
      </div>
      <CategorySettings {...props} />
    </div>
  );
}

function CategorySettings(props: CategoryViewProps) {
  const { settings, updateSettings } = props;
  switch (props.id) {
    case "general": return <>
      <SettingCard title="显示语言" description="界面语言会立即切换。">
        <select value={settings.language} onChange={(event) => { const language = event.target.value as "zh" | "en"; updateSettings({ language }); changeLanguage(language); }}><option value="zh">中文</option><option value="en">English</option></select>
      </SettingCard>
      <SettingCard title="启动时检查更新" description="启动应用时检查 GitHub Release 是否有新版本。"><Toggle checked={settings.checkUpdatesOnStart} onChange={(checked) => updateSettings({ checkUpdatesOnStart: checked })} label="自动检查" /></SettingCard>
    </>;
    case "appearance": return <div className="preference-theme-grid">{props.themes.map((theme) => <button key={theme.id} type="button" className={`preference-theme-card ${theme.id === props.themeId ? "active" : ""}`} onClick={() => props.setTheme(theme.id)}><div className="preference-theme-swatches"><i style={{ background: theme.app.bg }} /><i style={{ background: theme.app.panel }} /><i style={{ background: theme.app.accent }} /><i style={{ background: theme.terminal.red ?? "#e06c75" }} /><i style={{ background: theme.terminal.green ?? "#98c379" }} /><i style={{ background: theme.terminal.cyan ?? "#56b6c2" }} /></div><span>{theme.name}</span>{theme.id === props.themeId && <Check size={14} />}</button>)}</div>;
    case "terminal": return <>
      <SettingCard title="终端字体" description="对本地、SSH 与 Agent 终端立即生效。"><select value={settings.fontFamily} onChange={(event) => updateSettings({ fontFamily: event.target.value })}>{FONT_OPTIONS.map((font) => <option key={font.id} value={font.value}>{font.label}</option>)}</select></SettingCard>
      <SettingCard title={`字号 · ${settings.fontSize}px`} description="建议在高分辨率屏幕上使用 13–15px。"><input type="range" min={10} max={22} value={settings.fontSize} onChange={(event) => updateSettings({ fontSize: Number(event.target.value) })} /></SettingCard>
      <SettingCard title={`行高 · ${settings.lineHeight.toFixed(1)}`} description="调整终端文本的垂直间距。"><input type="range" min={1} max={2} step={0.1} value={settings.lineHeight} onChange={(event) => updateSettings({ lineHeight: Number(event.target.value) })} /></SettingCard>
      <SettingCard title="光标" description="光标样式与闪烁行为。"><div className="preference-inline"><select value={settings.cursorStyle} onChange={(event) => updateSettings({ cursorStyle: event.target.value as typeof settings.cursorStyle })}><option value="bar">竖线</option><option value="block">方块</option><option value="underline">下划线</option></select><Toggle checked={settings.cursorBlink} onChange={(checked) => updateSettings({ cursorBlink: checked })} label="闪烁" /></div></SettingCard>
      <SettingCard title={`回滚缓冲 · ${settings.scrollback.toLocaleString()} 行`} description="保留终端历史；较高数值会占用更多内存。"><input type="range" min={1000} max={50000} step={1000} value={settings.scrollback} onChange={(event) => updateSettings({ scrollback: Number(event.target.value) })} /></SettingCard>
      <SettingCard title="渲染策略" description="TUI 始终原始透传；自动模式仅在 WebGL 实际失效时回退 Canvas。"><select value={settings.terminalRenderer} onChange={(event) => updateSettings({ terminalRenderer: event.target.value as typeof settings.terminalRenderer })}><option value="auto">智能自动（推荐）</option><option value="canvas">Canvas 兼容模式</option><option value="webgl">强制 WebGL</option></select></SettingCard>
      <SettingCard title="日志美化" description="检测到 ANSI 或全屏 TUI 后会自动原样传递字节流。"><select value={settings.logHighlightMode} onChange={(event) => updateSettings({ logHighlightMode: event.target.value as typeof settings.logHighlightMode })}><option value="smart">智能识别</option><option value="off">关闭（原始输出）</option></select></SettingCard>
      <div className="preference-terminal-preview" style={{ fontFamily: settings.fontFamily, fontSize: settings.fontSize, lineHeight: settings.lineHeight }}><span>$</span> printf "TrueColor · TUI compatible"</div>
    </>;
    case "language": return <>
      <SettingCard title="编辑器语法高亮" description="使用 CodeMirror 语言扩展；没有解析器的语言会安全回退为纯文本。"><Toggle checked={settings.syntaxHighlighting} onChange={(checked) => updateSettings({ syntaxHighlighting: checked })} label="启用语法高亮" /></SettingCard>
      <SettingCard title="按语言启用语法高亮" description="可以单独关闭某种语言的语法颜色；未设置的语言默认开启。"><div className="preference-language-toggle-grid">{LANGUAGE_DEFINITIONS.map((language) => <Toggle key={language.id} checked={settings.languageHighlighting[language.id] !== false} onChange={(enabled) => updateSettings({ languageHighlighting: { ...settings.languageHighlighting, [language.id]: enabled } })} label={language.label} />)}</div></SettingCard>
      <SettingCard title="LSP 语义高亮" description="在语法高亮之上显示变量、类型和函数等语义颜色。"><select value={settings.semanticHighlighting} onChange={(event) => updateSettings({ semanticHighlighting: event.target.value as typeof settings.semanticHighlighting })}><option value="auto">自动</option><option value="on">开启</option><option value="off">关闭</option></select></SettingCard>
      <SettingCard title="编辑器显示细节" description="调整括号匹配、当前行和空白字符显示。"><div className="preference-checks"><Toggle checked={settings.bracketMatching} onChange={(checked) => updateSettings({ bracketMatching: checked })} label="括号匹配" /><Toggle checked={settings.highlightActiveLine} onChange={(checked) => updateSettings({ highlightActiveLine: checked })} label="当前行" /><Toggle checked={settings.showWhitespace} onChange={(checked) => updateSettings({ showWhitespace: checked })} label="显示空白字符" /></div></SettingCard>
      <SettingCard title="LSP 智能编辑" description="控制代码补全、悬浮提示、保存时格式化与参数签名；需对应语言服务支持。"><div className="preference-checks"><Toggle checked={settings.codeCompletion} onChange={(checked) => updateSettings({ codeCompletion: checked })} label="代码补全" /><Toggle checked={settings.hoverEnabled} onChange={(checked) => updateSettings({ hoverEnabled: checked })} label="悬浮提示" /><Toggle checked={settings.formatOnSave} onChange={(checked) => updateSettings({ formatOnSave: checked })} label="保存时格式化" /><Toggle checked={settings.signatureHelp} onChange={(checked) => updateSettings({ signatureHelp: checked })} label="参数签名" /></div></SettingCard>
      <SettingCard title="新增本地语言服务" description="命令直接启动，不经过 shell；不会自动安装或执行项目命令。"><div className="preference-language-create"><input value={props.languageServerName} onChange={(event) => props.onLanguageServerName(event.target.value)} placeholder="名称，例如 Pyright" /><input value={props.languageServerCommand} onChange={(event) => props.onLanguageServerCommand(event.target.value)} placeholder="可执行文件，例如 pyright-langserver" /><input value={props.languageServerLanguages} onChange={(event) => props.onLanguageServerLanguages(event.target.value)} placeholder="语言，例如 python" /><input value={props.languageServerArgs} onChange={(event) => props.onLanguageServerArgs(event.target.value)} placeholder="参数（空格分隔）" /><input value={props.languageServerMarkers} onChange={(event) => props.onLanguageServerMarkers(event.target.value)} placeholder="根标记（逗号分隔，例如 pyproject.toml）" /><button type="button" className="btn btn-primary" disabled={!props.languageServerName.trim() || !props.languageServerCommand.trim() || !props.languageServerLanguages.trim()} onClick={() => { const server: LanguageServerConfig = { id: crypto.randomUUID(), name: props.languageServerName.trim(), command: props.languageServerCommand.trim(), languages: props.languageServerLanguages.split(",").map((value) => value.trim()).filter(Boolean), args: props.languageServerArgs.split(/\s+/).filter(Boolean), rootMarkers: props.languageServerMarkers.split(",").map((value) => value.trim()).filter(Boolean), enabled: true }; updateSettings({ languageServers: [...settings.languageServers, server] }); props.onLanguageServerName(""); props.onLanguageServerCommand(""); props.onLanguageServerLanguages(""); props.onLanguageServerArgs(""); props.onLanguageServerMarkers(""); }}><Code2 size={14} /> 添加服务</button></div></SettingCard>
      <div className="preference-language-list">{settings.languageServers.length === 0 ? <div className="preferences-empty compact"><Code2 size={20} /><strong>还没有语言服务</strong><span>可以添加任意本地 LSP 命令，例如 pyright-langserver、rust-analyzer 或自定义服务。</span></div> : settings.languageServers.map((server) => <div key={server.id} className="preference-language-row"><div className="preference-language-edit"><input aria-label={`${server.name} 名称`} value={server.name} onChange={(event) => updateSettings({ languageServers: settings.languageServers.map((item) => item.id === server.id ? { ...item, name: event.target.value } : item) })} /><input aria-label={`${server.name} 命令`} value={server.command} onChange={(event) => updateSettings({ languageServers: settings.languageServers.map((item) => item.id === server.id ? { ...item, command: event.target.value } : item) })} /><input aria-label={`${server.name} 语言`} value={server.languages.join(", ")} onChange={(event) => updateSettings({ languageServers: settings.languageServers.map((item) => item.id === server.id ? { ...item, languages: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) } : item) })} /><small>{server.rootMarkers.length ? `根标记：${server.rootMarkers.join(", ")}` : "未设置根标记"}</small></div><Toggle checked={server.enabled} onChange={(enabled) => updateSettings({ languageServers: settings.languageServers.map((item) => item.id === server.id ? { ...item, enabled } : item) })} label={server.enabled ? "启用" : "停用"} /><button type="button" className="icon-btn danger" aria-label={`删除 ${server.name}`} onClick={() => props.onDeleteLanguageServer(server)}><X size={15} /></button></div>)}</div>
    </>;
    case "lspPlugins": return <SettingCard title="LSP 插件目录" description="插件安装、版本、回滚与运行时诊断在独立工作区标签中管理，避免偏好设置变成任务面板。"><div className="preference-inline"><button type="button" className="btn btn-primary" onClick={props.onOpenLspCatalog}><PlugZap size={14} /> 在工作区打开插件目录</button><small>{props.installedPlugins.filter((item) => item.enabled).length} 个已启用 · 不会后台下载或自动执行项目命令</small></div></SettingCard>;
    case "connection": return <>
      <SettingCard title="自动重连" description="仅对通过已保存连接建立的 SSH 会话生效。"><Toggle checked={settings.autoReconnect} onChange={(checked) => updateSettings({ autoReconnect: checked })} label="断线后自动重连" /></SettingCard>
      <SettingCard title={`最大重连次数 · ${settings.maxReconnectAttempts}`} description="达到次数上限后会保留失败原因，不再继续重试。"><input type="range" min={1} max={10} disabled={!settings.autoReconnect} value={settings.maxReconnectAttempts} onChange={(event) => updateSettings({ maxReconnectAttempts: Number(event.target.value) })} /></SettingCard>
      <SettingCard title="X11 转发" description="允许远程 GUI 程序显示到本机；要求本机 DISPLAY 可用。"><Toggle checked={settings.enableX11} onChange={(checked) => updateSettings({ enableX11: checked })} label="启用 X11 转发" /></SettingCard>
      <SettingCard title="已知主机" description="查看、复制或移除已验证的 SSH 主机指纹。"><button type="button" className="btn btn-ghost" onClick={props.onKnownHosts}><Shield size={14} /> 管理已知主机</button></SettingCard>
    </>;
    case "workspace": return <>
      <SettingCard title="默认工作台布局" description="专注布局优先终端；运维布局默认显示任务抽屉。"><div className="preference-layouts"><button type="button" className={settings.workspaceLayout === "focus" ? "active" : ""} onClick={() => updateSettings({ workspaceLayout: "focus", taskDrawerOpen: false })}><MonitorCog size={18} /><strong>专注</strong><span>终端优先</span></button><button type="button" className={settings.workspaceLayout === "operations" ? "active" : ""} onClick={() => updateSettings({ workspaceLayout: "operations", taskDrawerOpen: true })}><PanelLeft size={18} /><strong>运维</strong><span>任务抽屉</span></button></div></SettingCard>
      <SettingCard title={`资源侧栏宽度 · ${settings.sidebarWidth}px`} description="拖动工作台侧栏时也会自动保存此数值。"><input type="range" min={220} max={360} value={settings.sidebarWidth} onChange={(event) => updateSettings({ sidebarWidth: Number(event.target.value) })} /></SettingCard>
    </>;
    case "agents": return <>
      <SettingCard title="新增 Agent 启动项" description="定义名称与任意 shell 命令，再在项目中按需启用。"><div className="preference-agent-create"><input value={props.agentName} onChange={(event) => props.onAgentName(event.target.value)} placeholder="名称，例如 Aider" /><input value={props.agentCommand} onChange={(event) => props.onAgentCommand(event.target.value)} placeholder="命令，例如 aider --model ..." /><button type="button" className="btn btn-primary" disabled={!props.agentName.trim() || !props.agentCommand.trim()} onClick={() => { updateSettings({ agentPresets: [...settings.agentPresets, { id: crypto.randomUUID(), name: props.agentName.trim(), command: props.agentCommand.trim() }] }); props.onAgentName(""); props.onAgentCommand(""); }}><PlugZap size={14} /> 添加</button></div></SettingCard>
      <div className="preference-agent-list">{settings.agentPresets.length === 0 ? <div className="preferences-empty compact"><Bot size={20} /><strong>还没有 Agent 启动项</strong><span>可以添加任意 CLI、npx、项目脚本或 shell 命令。</span></div> : settings.agentPresets.map((preset) => <div key={preset.id} className="preference-agent-row"><input value={preset.name} aria-label="Agent 名称" onChange={(event) => updateSettings({ agentPresets: settings.agentPresets.map((item) => item.id === preset.id ? { ...item, name: event.target.value } : item) })} /><input value={preset.command} aria-label="Agent 命令" onChange={(event) => updateSettings({ agentPresets: settings.agentPresets.map((item) => item.id === preset.id ? { ...item, command: event.target.value } : item) })} /><button type="button" className="icon-btn danger" aria-label={`删除 ${preset.name}`} onClick={() => props.onDeleteAgent(preset)}><X size={15} /></button></div>)}</div>
    </>;
    case "shortcuts": return <div className="preference-shortcuts">{SHORTCUT_GROUPS.map(([title, items]) => <SettingCard key={title} title={title} description="当前版本支持查看与搜索，快捷键映射不可修改。"><dl>{items.map(([label, shortcut]) => <div key={label}><dt>{label}</dt><dd><kbd>{shortcut}</kbd></dd></div>)}</dl></SettingCard>)}</div>;
    case "updates": return <>
      <SettingCard title="应用更新" description="从 GitHub Release 检查并安装新版本。"><div className="preference-inline"><Toggle checked={settings.checkUpdatesOnStart} onChange={(checked) => updateSettings({ checkUpdatesOnStart: checked })} label="启动时检查" /><button type="button" className="btn btn-ghost" disabled={props.checking} onClick={props.onCheckUpdates}><RefreshCw size={14} /> {props.checking ? "检查中…" : "立即检查"}</button></div>{props.updateMessage && <p className="preference-status">{props.updateMessage}</p>}</SettingCard>
      <SettingCard title="关于 Simpl SSH" description="轻量级跨平台 SSH、SFTP 与远程开发工作台。"><div className="preference-about"><CircleHelp size={16} /><span>Simpl SSH v{props.appVersion}</span></div></SettingCard>
      <SettingCard title="本机数据与诊断" description="连接结构和工作区存于 SQLite；凭据仍保存在系统钥匙串。诊断不包含密码、源码或终端输出。"><div className="preference-inline"><button className="btn btn-ghost" onClick={props.onBackupStorage}>创建数据库备份</button><button className="btn btn-ghost" onClick={props.onCopyStorageDiagnostic}>复制存储诊断</button><button className="btn btn-ghost" onClick={props.onRetrySecretCleanup}>重试凭据清理</button></div>{props.storageMessage && <p className="preference-status">{props.storageMessage}</p>}</SettingCard>
    </>;
  }
}

function SettingCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <div className="preference-card"><div className="preference-card-copy"><h3>{title}</h3><p>{description}</p></div><div className="preference-card-control">{children}</div></div>;
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <label className="preference-toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span aria-hidden="true" /><em>{label}</em></label>;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const term = query.trim();
  const index = term ? text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase()) : -1;
  if (index < 0) return <>{text}</>;
  return <>{text.slice(0, index)}<mark>{text.slice(index, index + term.length)}</mark>{text.slice(index + term.length)}</>;
}

function navigateCategories(event: React.KeyboardEvent<HTMLButtonElement>, index: number, select: (id: PreferenceCategoryId) => void) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const next = (index + (event.key === "ArrowDown" ? 1 : -1) + PREFERENCE_CATEGORIES.length) % PREFERENCE_CATEGORIES.length;
  const category = PREFERENCE_CATEGORIES[next];
  select(category.id);
  (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(".preferences-nav-item")[next])?.focus();
}
