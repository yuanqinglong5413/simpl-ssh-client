//! 终端通用交互：复制 / 粘贴 / 导出日志。
//!
//! 被 TerminalPane（远程）与 LocalTerminalPane（本地）共用，避免重复。
//! - 复制：Ctrl+Shift+C（Win/Linux）、Cmd+C（macOS）
//! - 粘贴：Ctrl+Shift+V（Win/Linux）、Cmd+V（macOS），以及右键粘贴
//! - 导出日志：Ctrl+Shift+L，序列化终端缓冲为纯文本写入本地文件

import type { Terminal } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";

export type TerminalActionCtx = {
  term: Terminal;
  host: HTMLElement;
  /** 导出日志的文件名标识 */
  tag: string;
  /** serialize addon（提供则支持导出；可选） */
  serialize?: SerializeAddon | null;
};

export type TerminalShortcutAction = "copy" | "paste" | "export";

/**
 * 只识别终端自己声明的组合键。xterm 会把同一次物理按键的 keydown、
 * keypress、keyup 都交给自定义处理器，因此“识别动作”和“执行一次”必须分开。
 */
export function terminalShortcutAction(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "key">
): TerminalShortcutAction | null {
  if (!event.ctrlKey && !event.metaKey) return null;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey && event.shiftKey && key === "c") || (event.metaKey && !event.shiftKey && key === "c")) return "copy";
  if ((event.ctrlKey && event.shiftKey && key === "v") || (event.metaKey && !event.shiftKey && key === "v")) return "paste";
  if (event.ctrlKey && event.shiftKey && key === "l") return "export";
  return null;
}

/** 导出终端缓冲为纯文本日志（去 ANSI）。 */
async function exportLog(ctx: TerminalActionCtx): Promise<void> {
  const ser = ctx.serialize;
  if (!ser) return;
  const ansi = ser.serialize();
  const plain = ansi.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  const path = await save({
    defaultPath: `${ctx.tag}.log`,
    filters: [{ name: "日志", extensions: ["log", "txt"] }],
  });
  if (!path) return;
  await invoke("local_write_file", { path, content: plain });
}

/** 安装终端复制/粘贴/导出交互，返回 cleanup（卸载时调用）。 */
export function installTerminalActions(ctx: TerminalActionCtx): () => void {
  const { term, host, tag } = ctx;
  let disposed = false;

  function pasteFromClipboard(): void {
    void readText().then((t) => {
      if (!disposed && t) term.paste(t);
    }).catch(() => {
      /* 剪贴板临时不可用时不影响终端输入。 */
    });
  }

  term.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
    const action = terminalShortcutAction(e);
    if (!action) return true;

    if (action === "copy") {
      const sel = term.getSelection();
      if (sel) {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "keydown" && !e.repeat) void writeText(sel);
        return false;
      }
      // 没有选择内容时保留 Ctrl+C 等终端信号语义。
      return true;
    }

    // 阻止 WebView 默认 paste 与主动读取剪贴板同时执行。keypress/keyup
    // 仍会到达这里，但只有首次 keydown 真正触发动作。
    e.preventDefault();
    e.stopPropagation();
    if (e.type !== "keydown" || e.repeat) return false;
    if (action === "paste") {
      pasteFromClipboard();
      return false;
    }
    if (action === "export") {
      void exportLog({ ...ctx, tag });
      return false;
    }
    return true;
  });

  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    pasteFromClipboard();
  };
  host.addEventListener("contextmenu", onContextMenu);

  return () => {
    disposed = true;
    host.removeEventListener("contextmenu", onContextMenu);
  };
}
