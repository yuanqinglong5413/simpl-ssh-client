/** 终端光标样式 */
export type CursorStyle = "bar" | "block" | "underline";
export type TerminalRendererPreference = "auto" | "canvas" | "webgl";
export type LogHighlightMode = "smart" | "off";
export type SemanticHighlighting = "auto" | "on" | "off";
export type LanguageServerConfig = {
  id: string;
  name: string;
  languages: string[];
  command: string;
  args: string[];
  enabled: boolean;
  rootMarkers: string[];
};
export type LspPluginLanguage = { id: string; extensions: string[]; lspId: string };
export type LspPluginManifest = {
  id: string; version: string; name: string; publisher: string; description: string;
  languages: LspPluginLanguage[]; rootMarkers: string[]; capabilities: string[];
  runtimes: Record<string, { archiveUrl: string; sha256: string; signature: string; executable: string; args: string[] }>;
};
export type InstalledLspPlugin = { pluginId: string; version: string; enabled: boolean; priority: number; source?: "managed" | "custom" | "system-detected" };
export type LspPluginAvailability = {
  pluginId: string;
  version: string;
  status: "available" | "missing" | "unavailable";
  source: "managed" | "custom" | "system-detected";
  executable?: string;
  detail: string;
};
/** 用户定义的项目 Agent 启动项；不提供任何内置命令。 */
export type AgentPreset = { id: string; name: string; command: string };

/** 应用设置（持久化至 localStorage） */
export type AppSettings = {
  /** 工作台密度：专注终端 / 运维任务抽屉 */
  workspaceLayout: "focus" | "operations";
  /** 资源侧栏宽度（220-360px） */
  sidebarWidth: number;
  /** 是否临时收起资源侧栏 */
  sidebarCollapsed: boolean;
  /** 右侧任务抽屉是否展开 */
  taskDrawerOpen: boolean;
  /** WebGL 可提升普通日志性能；TUI 保持原始字节流，仅渲染异常才回退 Canvas。 */
  terminalRenderer: TerminalRendererPreference;
  /** 只对无控制序列的普通输出尝试日志高亮。 */
  logHighlightMode: LogHighlightMode;
  /** 用户自定义 Agent 启动项。 */
  agentPresets: AgentPreset[];
  /** 用户自定义本地语言服务；不提供内置命令。 */
  languageServers: LanguageServerConfig[];
  /** 新名称；languageServers 仅作为旧配置兼容别名。 */
  customServers: LanguageServerConfig[];
  installedLspPlugins: InstalledLspPlugin[];
  lspUpdateChannel: "stable";
  /** 编辑器语法高亮与 LSP 语义高亮偏好。 */
  syntaxHighlighting: boolean;
  /** 按语言覆盖语法高亮；缺省或 true 表示开启。 */
  languageHighlighting: Record<string, boolean>;
  semanticHighlighting: SemanticHighlighting;
  bracketMatching: boolean;
  highlightActiveLine: boolean;
  showWhitespace: boolean;
  /** 代码补全（LSP completion）。 */
  codeCompletion: boolean;
  /** 悬浮提示（LSP hover）。 */
  hoverEnabled: boolean;
  /** 保存时自动格式化（LSP formatting）。 */
  formatOnSave: boolean;
  /** 函数参数签名提示（LSP signatureHelp）。 */
  signatureHelp: boolean;
  /** 终端字体 */
  fontFamily: string;
  /** 终端字号 (px) */
  fontSize: number;
  /** 终端行高 */
  lineHeight: number;
  /** 光标样式 */
  cursorStyle: CursorStyle;
  /** 光标闪烁 */
  cursorBlink: boolean;
  /** 终端回滚缓冲行数 */
  scrollback: number;
  /** 断线后自动重连 */
  autoReconnect: boolean;
  /** 最大重连次数 */
  maxReconnectAttempts: number;
  /** 终端开启 X11 转发（需本机 DISPLAY） */
  enableX11: boolean;
  /** 启动时检查更新 */
  checkUpdatesOnStart: boolean;
  /** 界面语言 */
  language: "zh" | "en";
};

export const SETTINGS_STORAGE_KEY = "simpl-ssh-settings";

export const DEFAULT_SETTINGS: AppSettings = {
  workspaceLayout: "focus",
  sidebarWidth: 280,
  sidebarCollapsed: false,
  taskDrawerOpen: false,
  terminalRenderer: "auto",
  logHighlightMode: "smart",
  agentPresets: [],
  languageServers: [],
  customServers: [],
  installedLspPlugins: [],
  lspUpdateChannel: "stable",
  syntaxHighlighting: true,
  languageHighlighting: {},
  semanticHighlighting: "auto",
  bracketMatching: true,
  highlightActiveLine: true,
  showWhitespace: false,
  codeCompletion: true,
  hoverEnabled: true,
  formatOnSave: false,
  signatureHelp: true,
  fontFamily: "'IBM Plex Mono', 'JetBrains Mono', Menlo, monospace",
  fontSize: 13,
  lineHeight: 1.3,
  cursorStyle: "bar",
  cursorBlink: true,
  scrollback: 10000,
  autoReconnect: true,
  maxReconnectAttempts: 5,
  enableX11: false,
  checkUpdatesOnStart: true,
  language: "zh",
};

/** 可选终端字体列表 */
export const FONT_OPTIONS = [
  { id: "ibm-plex", label: "IBM Plex Mono", value: "'IBM Plex Mono', Menlo, monospace" },
  { id: "jetbrains", label: "JetBrains Mono", value: "'JetBrains Mono', Menlo, monospace" },
  { id: "fira", label: "Fira Code", value: "'Fira Code', Menlo, monospace" },
  { id: "cascadia", label: "Cascadia Code", value: "'Cascadia Code', Menlo, monospace" },
  { id: "menlo", label: "Menlo / 系统等宽", value: "Menlo, Monaco, 'Courier New', monospace" },
] as const;
