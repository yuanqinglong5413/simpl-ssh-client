export type ShortcutScope = "terminal" | "editor" | "editable" | "chrome";
export type AppShortcutAction = "newConnection" | "closeTab" | "nextTab" | "prevTab" | "settings" | "commandPalette";

export type ShortcutEventLike = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

export function platformModifier(event: ShortcutEventLike, platform = navigator.platform): boolean {
  return /mac|iphone|ipad/i.test(platform) ? event.metaKey : event.ctrlKey;
}

/**
 * 终端绝对优先：只保留平台命令面板组合键，其他按键完整交给 PTY/TUI。
 * 其他区域沿用工作台快捷键；输入控件只开放命令面板，避免破坏文本编辑。
 */
export function resolveAppShortcut(event: ShortcutEventLike, scope: ShortcutScope, platform = navigator.platform): AppShortcutAction | null {
  if (!platformModifier(event, platform) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "p" && event.shiftKey) return "commandPalette";
  if (scope === "terminal" || scope === "editable") return null;
  if (event.shiftKey && key !== "tab") return null;
  if (key === "n") return "newConnection";
  if (key === "w") return "closeTab";
  if (key === "tab") return event.shiftKey ? "prevTab" : "nextTab";
  if (key === ",") return "settings";
  if (key === "k") return "commandPalette";
  return null;
}

export function shortcutScope(event: KeyboardEvent): ShortcutScope {
  const path = event.composedPath();
  const elements = path.filter((item): item is HTMLElement => item instanceof HTMLElement);
  if (elements.some((item) => item.classList.contains("terminal-host") || item.classList.contains("xterm"))) return "terminal";
  if (elements.some((item) => item.classList.contains("cm-editor"))) return "editor";
  const target = event.target;
  if (target instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) return "editable";
  return "chrome";
}
