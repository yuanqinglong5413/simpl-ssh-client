import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme/ThemeProvider";
import { createLogHighlighter } from "../utils/logHighlight";
import "@xterm/xterm/css/xterm.css";

type Props = { sessionId: string; paneId: string };

/**
 * 一个终端面板：xterm.js ↔ 本地 WebSocket ↔ 后端 PTY channel。
 * 以 `paneId` 为身份——同一 session 下多个 paneId 各开独立 PTY（分屏复用）。
 * 面板常驻挂载（切换 Tab 时仅用 CSS 隐藏），保证后台终端不被打断。
 * 尺寸变化（包括从隐藏切到显示、分屏拖拽）由 ResizeObserver 触发 fit。
 * PTY 就绪前显示"正在打开终端…"占位。
 * 主题切换时实时更新 xterm 配色；纯文本日志自动注入语义化 ANSI 颜色。
 */
export function TerminalPane({ sessionId, paneId }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [ready, setReady] = useState(false);
  const { terminalTheme } = useTheme();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "'IBM Plex Mono', 'JetBrains Mono', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: "bar",
      theme: terminalTheme,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL 不可用时回退到 canvas
    }
    fitAddon.fit();

    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        /* 容器尺寸为 0（隐藏中）时忽略 */
      }
    });
    ro.observe(host);

    let ws: WebSocket | null = null;
    let disposed = false;
    const encoder = new TextEncoder();
    const highlighter = createLogHighlighter();

    const onDataDisp = term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encoder.encode(data));
      }
    });

    invoke<{ port: number; token: string }>("terminal_open", {
      sessionId,
      cols: term.cols,
      rows: term.rows,
    })
      .then((handle) => {
        if (disposed) return;
        ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`);
        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
          ws?.send(handle.token);
          setReady(true);
          term.focus();
          fitAddon.fit();
        };
        ws.onmessage = (e) => {
          const raw =
            e.data instanceof ArrayBuffer ? e.data : (e.data as string);
          /* 对纯文本日志注入语义化颜色，已有 ANSI 的行不会被重复着色 */
          const highlighted = highlighter.transform(raw);
          if (highlighted.length > 0) {
            term.write(highlighted);
          }
        };
      })
      .catch((e) => {
        setReady(true);
        term.write(`\r\n\x1b[31m无法打开终端: ${e}\x1b[0m\r\n`);
      });

    return () => {
      disposed = true;
      ro.disconnect();
      onDataDisp.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
    };
  }, [paneId, sessionId]);

  /* 主题切换时实时更新已打开终端的配色 */
  useEffect(() => {
    const term = termRef.current;
    if (term) {
      term.options.theme = terminalTheme;
    }
  }, [terminalTheme]);

  return (
    <div className="terminal-host" ref={hostRef}>
      {!ready && (
        <div className="term-overlay">
          <div className="conn-spinner" />
          <span>正在打开终端…</span>
        </div>
      )}
    </div>
  );
}
