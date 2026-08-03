import type { AppSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

export type PreferenceCategoryId =
  | "general"
  | "appearance"
  | "terminal"
  | "language"
  | "lspPlugins"
  | "connection"
  | "workspace"
  | "agents"
  | "shortcuts"
  | "updates";

export type PreferenceCategory = {
  id: PreferenceCategoryId;
  label: string;
  description: string;
  keywords: string[];
};

export const PREFERENCE_CATEGORIES: PreferenceCategory[] = [
  { id: "general", label: "常规", description: "语言与应用行为", keywords: ["general", "language", "语言", "启动"] },
  { id: "appearance", label: "外观", description: "主题与配色", keywords: ["appearance", "theme", "主题", "颜色", "配色"] },
  { id: "terminal", label: "终端", description: "字体、渲染与 TUI", keywords: ["terminal", "font", "renderer", "字体", "渲染", "光标"] },
  { id: "language", label: "语言服务与高亮", description: "自定义服务、语法与语义高亮", keywords: ["language server", "semantic", "syntax", "语言服务", "高亮", "补全", "诊断", "CodeMirror"] },
  { id: "lspPlugins", label: "LSP 插件目录", description: "安装、启用与管理语言服务插件", keywords: ["lsp", "plugin", "插件", "目录", "安装", "启用", "语言服务插件", "runtime"] },
  { id: "connection", label: "连接与安全", description: "重连、X11 与已知主机", keywords: ["connection", "security", "ssh", "安全", "重连", "known hosts"] },
  { id: "workspace", label: "工作台", description: "布局与任务抽屉", keywords: ["workspace", "layout", "sidebar", "工作台", "布局", "侧栏"] },
  { id: "agents", label: "Agent 启动项", description: "项目 CLI 与命令", keywords: ["agent", "cli", "command", "命令", "启动项"] },
  { id: "shortcuts", label: "快捷键", description: "工作台与终端操作", keywords: ["shortcut", "keybinding", "快捷键", "键盘"] },
  { id: "updates", label: "更新与关于", description: "版本、更新与诊断", keywords: ["update", "about", "版本", "更新", "诊断"] },
];

type SearchEntry = { category: PreferenceCategoryId; text: string };

const SEARCH_ENTRIES: SearchEntry[] = [
  { category: "general", text: "语言 language 启动时检查更新" },
  { category: "appearance", text: "主题 theme 配色 ANSI truecolor 外观" },
  { category: "terminal", text: "字体 字号 行高 光标 回滚 缓冲 WebGL Canvas 日志 TUI 终端" },
  { category: "language", text: "language server 语言服务 自定义命令 语法高亮 语义高亮 补全 悬浮 格式化 重命名 签名 大纲 符号 诊断 CodeMirror Java XML HTML CSS Python Rust Go Kotlin Scala Dart PHP Zig Ruby Lua Perl PowerShell Swift TOML CMake Groovy Haskell INI Nginx Dockerfile" },
  { category: "lspPlugins", text: "LSP plugin 插件目录 安装 启用 停用 卸载 系统命令 运行时 runtime" },
  { category: "connection", text: "自动重连 重试 X11 已知主机 host key SSH 安全" },
  { category: "workspace", text: "专注 运维 布局 侧栏 任务抽屉 工作台" },
  { category: "agents", text: "Agent CLI 命令 项目 启动项 npx" },
  { category: "shortcuts", text: "快捷键 标签 命令面板 搜索 keyboard" },
  { category: "updates", text: "检查更新 版本 release GitHub 诊断" },
];

export function searchPreferenceCategories(query: string): PreferenceCategoryId[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return PREFERENCE_CATEGORIES
    .filter((category) => {
      const entry = SEARCH_ENTRIES.find((item) => item.category === category.id)?.text ?? "";
      const haystack = `${category.label} ${category.description} ${category.keywords.join(" ")} ${entry}`.toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .map((category) => category.id);
}

export function resetPatchForCategory(category: PreferenceCategoryId): Partial<AppSettings> {
  switch (category) {
    case "general": return { language: DEFAULT_SETTINGS.language };
    case "terminal": return {
      fontFamily: DEFAULT_SETTINGS.fontFamily,
      fontSize: DEFAULT_SETTINGS.fontSize,
      lineHeight: DEFAULT_SETTINGS.lineHeight,
      cursorStyle: DEFAULT_SETTINGS.cursorStyle,
      cursorBlink: DEFAULT_SETTINGS.cursorBlink,
      scrollback: DEFAULT_SETTINGS.scrollback,
      terminalRenderer: DEFAULT_SETTINGS.terminalRenderer,
      logHighlightMode: DEFAULT_SETTINGS.logHighlightMode,
    };
    case "language": return {
      languageServers: DEFAULT_SETTINGS.languageServers,
      customServers: DEFAULT_SETTINGS.customServers,
      syntaxHighlighting: DEFAULT_SETTINGS.syntaxHighlighting,
      languageHighlighting: DEFAULT_SETTINGS.languageHighlighting,
      semanticHighlighting: DEFAULT_SETTINGS.semanticHighlighting,
      bracketMatching: DEFAULT_SETTINGS.bracketMatching,
      highlightActiveLine: DEFAULT_SETTINGS.highlightActiveLine,
      showWhitespace: DEFAULT_SETTINGS.showWhitespace,
      codeCompletion: DEFAULT_SETTINGS.codeCompletion,
      hoverEnabled: DEFAULT_SETTINGS.hoverEnabled,
      formatOnSave: DEFAULT_SETTINGS.formatOnSave,
      signatureHelp: DEFAULT_SETTINGS.signatureHelp,
    };
    case "lspPlugins": return {
      installedLspPlugins: DEFAULT_SETTINGS.installedLspPlugins,
      lspUpdateChannel: DEFAULT_SETTINGS.lspUpdateChannel,
    };
    case "connection": return {
      autoReconnect: DEFAULT_SETTINGS.autoReconnect,
      maxReconnectAttempts: DEFAULT_SETTINGS.maxReconnectAttempts,
      enableX11: DEFAULT_SETTINGS.enableX11,
    };
    case "workspace": return {
      workspaceLayout: DEFAULT_SETTINGS.workspaceLayout,
      sidebarWidth: DEFAULT_SETTINGS.sidebarWidth,
      sidebarCollapsed: DEFAULT_SETTINGS.sidebarCollapsed,
      taskDrawerOpen: DEFAULT_SETTINGS.taskDrawerOpen,
    };
    case "agents": return { agentPresets: [] };
    case "updates": return { checkUpdatesOnStart: DEFAULT_SETTINGS.checkUpdatesOnStart };
    case "appearance":
    case "shortcuts":
      return {};
  }
}
