import { useEffect } from "react";
import { resolveAppShortcut, shortcutScope } from "../utils/appShortcuts";

type ShortcutHandlers = {
  onNewConnection: () => void;
  onCloseTab: () => void;
  onNextTab: () => void;
  onPrevTab: () => void;
  onOpenSettings: () => void;
  onOpenCommandPalette: () => void;
};

/**
 * 全局应用快捷键。终端焦点内只保留 Cmd/Ctrl+Shift+P，其他组合键透传。
 */
export function useAppShortcuts(handlers: ShortcutHandlers) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 长按组合键产生的 repeat 不能重复创建连接、关闭多个标签或反复开关弹窗。
      if (e.defaultPrevented || e.repeat) return;
      const action = resolveAppShortcut(e, shortcutScope(e));
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (action === "newConnection") handlers.onNewConnection();
      else if (action === "closeTab") handlers.onCloseTab();
      else if (action === "nextTab") handlers.onNextTab();
      else if (action === "prevTab") handlers.onPrevTab();
      else if (action === "settings") handlers.onOpenSettings();
      else handlers.onOpenCommandPalette();
    };
    // 捕获阶段只拦截真正属于应用的组合键；否则 xterm 会先把命令面板按键写入 PTY。
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [handlers]);
}
