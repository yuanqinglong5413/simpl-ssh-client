import type { ITheme } from "@xterm/xterm";

/** GUI 层 CSS 变量，与 App.css 中的 --* 一一对应 */
export interface AppThemeVars {
  bg: string;
  panel: string;
  panel2: string;
  panel3: string;
  border: string;
  borderSoft: string;
  text: string;
  textDim: string;
  muted: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
  green: string;
  greenSoft: string;
  red: string;
  redSoft: string;
  /** 滚动条 hover 色 */
  scrollbarHover: string;
  /** 遮罩层背景 */
  overlayBg: string;
  /** 品牌标记文字色 */
  brandMarkFg: string;
  /** 主按钮文字色 */
  btnPrimaryFg: string;
}

/** 16 色 ANSI 调色板 */
export interface AnsiPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** 完整主题：GUI + 终端 */
export interface AppTheme {
  id: string;
  name: string;
  /** 是否为浅色主题（影响预览样式） */
  isLight?: boolean;
  app: AppThemeVars;
  terminal: ITheme;
}

export const THEME_STORAGE_KEY = "simpl-ssh-theme";
export const DEFAULT_THEME_ID = "ink-amber";
