import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme/ThemeProvider";
import { useSettings } from "../settings/SettingsProvider";
import { createLogHighlighter } from "../utils/logHighlight";
import { TerminalSearchBar } from "./TerminalSearchBar";
import "@xterm/xterm/css/xterm.css";

type Props = {
  sessionId: string;
  paneId: string;
  /** WebSocket 意外关闭时回调（用于断线重连） */
  onConnectionLost?: (sessionId: string) => void;
};

/**
 * 一个终端面板：xterm.js ↔ 本地 WebSocket ↔ 后端 PTY channel。
 * 支持动态 resize、Ctrl+F 搜索、主题联动、日志语法高亮。
 */
export function TerminalPane({ sessionId, paneId, onConnectionLost }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ready, setReady] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { terminalTheme } = useTheme();
  const { settings } = useSettings();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      theme: terminalTheme,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* WebGL 不可用时回退 canvas */
    }
    fitAddon.fit();

    /** 通知远端 PTY 尺寸变化（防抖，避免拖拽分隔条时洪泛） */
    function sendResize() {
      const ws = wsRef.current;
      const t = termRef.current;
      if (ws?.readyState === WebSocket.OPEN && t && t.cols > 0 && t.rows > 0) {
        ws.send(
          JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows })
        );
      }
    }

    function fitAndResize() {
      try {
        fitRef.current?.fit();
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = setTimeout(sendResize, 80);
      } catch {
        /* 容器尺寸为 0（隐藏中）时忽略 */
      }
    }

    const ro = new ResizeObserver(fitAndResize);
    ro.observe(host);

    let disposed = false;
    const encoder = new TextEncoder();
    const highlighter = createLogHighlighter();

    const onDataDisp = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encoder.encode(data));
      }
    });

    /** Ctrl+F / Cmd+F 打开终端搜索 */
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    host.addEventListener("keydown", onKeyDown);

    invoke<{ port: number; token: string }>("terminal_open", {
      sessionId,
      cols: term.cols,
      rows: term.rows,
    })
      .then((handle) => {
        if (disposed) return;
        const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`);
        wsRef.current = ws;
        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
          ws.send(handle.token);
          setReady(true);
          term.focus();
          fitAndResize();
        };
        ws.onmessage = (e) => {
          const raw =
            e.data instanceof ArrayBuffer ? e.data : (e.data as string);
          const highlighted = highlighter.transform(raw);
          if (highlighted.length > 0) {
            term.write(highlighted);
          }
        };
        ws.onclose = () => {
          if (!disposed) onConnectionLost?.(sessionId);
        };
      })
      .catch((e) => {
        setReady(true);
        term.write(`\r\n\x1b[31m无法打开终端: ${e}\x1b[0m\r\n`);
      });

    return () => {
      disposed = true;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      ro.disconnect();
      onDataDisp.dispose();
      host.removeEventListener("keydown", onKeyDown);
      wsRef.current?.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [onConnectionLost, paneId, sessionId, terminalTheme]);

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term) return;
    term.options.fontFamily = settings.fontFamily;
    term.options.fontSize = settings.fontSize;
    term.options.lineHeight = settings.lineHeight;
    term.options.cursorBlink = settings.cursorBlink;
    term.options.cursorStyle = settings.cursorStyle;
    try {
      fit?.fit();
    } catch {
      /* 容器隐藏时忽略 */
    }
  }, [
    settings.cursorBlink,
    settings.cursorStyle,
    settings.fontFamily,
    settings.fontSize,
    settings.lineHeight,
  ]);

  useEffect(() => {
    const term = termRef.current;
    if (term) {
      term.options.theme = terminalTheme;
    }
  }, [terminalTheme]);

  return (
    <div className="terminal-host" ref={hostRef} tabIndex={0}>
      <TerminalSearchBar
        term={termRef.current}
        open={searchOpen}
        onClose={() => {
          setSearchOpen(false);
          termRef.current?.focus();
        }}
      />
      {!ready && (
        <div className="term-overlay">
          <div className="conn-spinner" />
          <span>正在打开终端…</span>
        </div>
      )}
    </div>
  );
}
