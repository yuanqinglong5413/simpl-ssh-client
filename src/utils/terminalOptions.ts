/**
 * xterm.js 终端选项工厂：把应用设置映射为 Terminal 构造参数。
 * SSH / 本地终端共用，避免两处配置漂移。
 */

import type { ITerminalOptions, ITheme } from "@xterm/xterm";
import type { AppSettings } from "../settings/types";

type BuildOpts = {
  settings: AppSettings;
  theme: ITheme;
};

/**
 * 构建接近 iTerm 默认体验的 xterm 选项：
 * - 大滚动缓冲、右键选词
 * - macOS Option 作 meta（Alt 发 ESC 前缀，方便 readline）
 * - 选中即复制由面板侧 onSelectionChange 实现
 */
export function buildTerminalOptions({
  settings,
  theme,
}: BuildOpts): ITerminalOptions {
  return {
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    cursorBlink: settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    scrollback: Math.max(1000, Math.min(100000, settings.scrollback || 10000)),
    theme,
    rightClickSelectsWord: settings.rightClickSelectsWord,
    macOptionIsMeta: true,
    fastScrollSensitivity: 5,
    scrollSensitivity: 1,
    drawBoldTextInBrightColors: true,
    allowTransparency: false,
  };
}
