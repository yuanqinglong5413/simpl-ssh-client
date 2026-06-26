import type { ITheme } from "@xterm/xterm";
import type { AnsiPalette, AppTheme, AppThemeVars } from "./types";

/** 将 hex 转为 rgba 字符串，用于 soft 背景色 */
export function hexAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 组装 xterm ITheme（含完整 16 色 ANSI 调色板） */
export function buildTerminalTheme(
  bg: string,
  fg: string,
  cursor: string,
  accent: string,
  ansi: AnsiPalette
): ITheme {
  return {
    background: bg,
    foreground: fg,
    cursor,
    cursorAccent: bg,
    selectionBackground: hexAlpha(accent, 0.25),
    selectionInactiveBackground: hexAlpha(accent, 0.12),
    ...ansi,
  };
}

/** 从基础色快速生成 GUI 变量 */
export function buildAppVars(
  base: Pick<
    AppThemeVars,
    "bg" | "panel" | "panel2" | "panel3" | "border" | "borderSoft" | "text" | "textDim" | "muted"
  > & {
    accent: string;
    accentHover?: string;
    green?: string;
    red?: string;
    scrollbarHover?: string;
    overlayBg?: string;
    brandMarkFg?: string;
    btnPrimaryFg?: string;
  }
): AppThemeVars {
  const accent = base.accent;
  const green = base.green ?? "#3fd9a0";
  const red = base.red ?? "#ff5c5c";
  return {
    bg: base.bg,
    panel: base.panel,
    panel2: base.panel2,
    panel3: base.panel3,
    border: base.border,
    borderSoft: base.borderSoft,
    text: base.text,
    textDim: base.textDim,
    muted: base.muted,
    accent,
    accentHover: base.accentHover ?? accent,
    accentSoft: hexAlpha(accent, 0.12),
    green,
    greenSoft: hexAlpha(green, 0.14),
    red,
    redSoft: hexAlpha(red, 0.12),
    scrollbarHover: base.scrollbarHover ?? base.border,
    overlayBg: base.overlayBg ?? hexAlpha(base.bg, 0.62),
    brandMarkFg: base.brandMarkFg ?? base.bg,
    btnPrimaryFg: base.btnPrimaryFg ?? base.bg,
  };
}

/** 组合 GUI + 终端主题 */
export function makeTheme(
  id: string,
  name: string,
  app: AppThemeVars,
  terminal: ITheme,
  isLight?: boolean
): AppTheme {
  return { id, name, app, terminal, isLight };
}
