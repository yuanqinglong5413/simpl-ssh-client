import { useEffect } from "react";

type ShortcutHandlers = {
  onNewConnection: () => void;
  onCloseTab: () => void;
  onNextTab: () => void;
  onPrevTab: () => void;
  onOpenSettings: () => void;
};

/** 是否在可编辑元素中（此时不拦截快捷键） */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

/**
 * 全局应用快捷键（终端焦点时不拦截 Ctrl+F，留给终端搜索）。
 */
export function useAppShortcuts(handlers: ShortcutHandlers) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      switch (e.key.toLowerCase()) {
        case "n":
          e.preventDefault();
          handlers.onNewConnection();
          break;
        case "w":
          e.preventDefault();
          handlers.onCloseTab();
          break;
        case "tab":
          e.preventDefault();
          if (e.shiftKey) handlers.onPrevTab();
          else handlers.onNextTab();
          break;
        case ",":
          e.preventDefault();
          handlers.onOpenSettings();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlers]);
}
