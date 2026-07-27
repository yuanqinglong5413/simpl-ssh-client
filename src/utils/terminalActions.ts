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
  /** 取当前 WebSocket（连接前可能为 null） */
  getWs: () => WebSocket | null;
  /** 把文本编码为字节用于发送 */
  encode: (s: string) => Uint8Array;
  /** 导出日志的文件名标识 */
  tag: string;
  /** serialize addon（提供则支持导出；可选） */
  serialize?: SerializeAddon | null;
};

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
  const { term, host, getWs, encode, tag } = ctx;

  function pasteFromClipboard(): void {
    void readText().then((t) => {
      const ws = getWs();
      if (ws?.readyState === WebSocket.OPEN) ws.send(encode(t));
    });
  }

  term.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return true;
    const key = e.key.toLowerCase();
    const isCopy =
      (e.ctrlKey && e.shiftKey && key === "c") ||
      (e.metaKey && !e.shiftKey && key === "c");
    const isPaste =
      (e.ctrlKey && e.shiftKey && key === "v") ||
      (e.metaKey && !e.shiftKey && key === "v");
    if (isCopy) {
      const sel = term.getSelection();
      if (sel) {
        void writeText(sel);
        return false;
      }
      return true;
    }
    if (isPaste) {
      pasteFromClipboard();
      return false;
    }
    if (e.ctrlKey && e.shiftKey && key === "l") {
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
    host.removeEventListener("contextmenu", onContextMenu);
  };
}
