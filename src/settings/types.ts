/** 终端光标样式 */
export type CursorStyle = "bar" | "block" | "underline";

/** 应用设置（持久化至 localStorage） */
export type AppSettings = {
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
  /** 滚动缓冲区行数（越大越接近 iTerm 体验，占内存也越多） */
  scrollback: number;
  /** 选中即复制（macOS 终端常见习惯） */
  copyOnSelect: boolean;
  /** 右键粘贴 */
  rightClickSelectsWord: boolean;
  /** 纯文本日志语法高亮（可能误伤交互程序，可关闭） */
  logHighlight: boolean;
  /** 断线后自动重连 */
  autoReconnect: boolean;
  /** 最大重连次数 */
  maxReconnectAttempts: number;
  /** 终端开启 X11 转发（需本机 DISPLAY） */
  enableX11: boolean;
  /** 启动时检查更新 */
  checkUpdatesOnStart: boolean;
};

export const SETTINGS_STORAGE_KEY = "simpl-ssh-settings";

export const DEFAULT_SETTINGS: AppSettings = {
  fontFamily: "'IBM Plex Mono', 'JetBrains Mono', Menlo, monospace",
  fontSize: 13,
  lineHeight: 1.3,
  cursorStyle: "bar",
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: true,
  rightClickSelectsWord: true,
  logHighlight: true,
  autoReconnect: true,
  maxReconnectAttempts: 5,
  enableX11: false,
  checkUpdatesOnStart: true,
};

/** 可选终端字体列表 */
export const FONT_OPTIONS = [
  { id: "ibm-plex", label: "IBM Plex Mono", value: "'IBM Plex Mono', Menlo, monospace" },
  { id: "jetbrains", label: "JetBrains Mono", value: "'JetBrains Mono', Menlo, monospace" },
  { id: "fira", label: "Fira Code", value: "'Fira Code', Menlo, monospace" },
  { id: "cascadia", label: "Cascadia Code", value: "'Cascadia Code', Menlo, monospace" },
  { id: "menlo", label: "Menlo / 系统等宽", value: "Menlo, Monaco, 'Courier New', monospace" },
] as const;
