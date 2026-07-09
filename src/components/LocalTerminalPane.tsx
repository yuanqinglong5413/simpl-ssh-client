import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme/ThemeProvider";
import { useSettings } from "../settings/SettingsProvider";
import { createLogHighlighter } from "../utils/logHighlight";
import { buildTerminalOptions } from "../utils/terminalOptions";
import { TerminalSearchBar } from "./TerminalSearchBar";
import "@xterm/xterm/css/xterm.css";

type Props = {
  paneId: string;
  cwd: string;
  /** 当前 Tab 是否可见 */
  active?: boolean;
};

/**
 * 本地终端面板：xterm.js ↔ 本地 WebSocket ↔ portable-pty。
 * 不依赖 SSH 会话，直接在本地创建 shell 子进程。
 */
export function LocalTerminalPane({ paneId, cwd, active = true }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ready, setReady] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { terminalTheme } = useTheme();
  const { settings } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal(
      buildTerminalOptions({ settings: settingsRef.current, theme: terminalTheme })
    );
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
    try {
      fitAddon.fit();
    } catch {
      /* ignore */
    }

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
      const el = hostRef.current;
      if (!el || el.clientWidth < 2 || el.clientHeight < 2) return;
      try {
        fitRef.current?.fit();
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = setTimeout(sendResize, 80);
      } catch {
        /* 容器尺寸异常时忽略 */
      }
    }

    const ro = new ResizeObserver(fitAndResize);
    ro.observe(host);

    let disposed = false;
    const encoder = new TextEncoder();
    const highlighter = settingsRef.current.logHighlight
      ? createLogHighlighter()
      : null;

    const onDataDisp = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encoder.encode(data));
      }
    });

    function copySelection(text: string) {
      if (!text) return;
      navigator.clipboard?.writeText(text).catch(() => {});
    }

    const onSelDisp = term.onSelectionChange(() => {
      if (!settingsRef.current.copyOnSelect) return;
      const sel = term.getSelection();
      if (sel && sel.length > 0) copySelection(sel);
    });

    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "c") {
        const sel = term.getSelection();
        if (sel) {
          e.preventDefault();
          copySelection(sel);
        }
      }
    };
    host.addEventListener("keydown", onKeyDown);

    invoke<{ port: number; token: string }>("local_terminal_open", {
      cwd: cwd || null,
      cols: Math.max(term.cols, 80),
      rows: Math.max(term.rows, 24),
    })
      .then((handle) => {
        if (disposed) return;
        const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`);
        wsRef.current = ws;
        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
          ws.send(handle.token);
          setReady(true);
          if (activeRef.current) term.focus();
          fitAndResize();
        };
        ws.onmessage = (e) => {
          const raw =
            e.data instanceof ArrayBuffer ? e.data : (e.data as string);
          if (highlighter) {
            const highlighted = highlighter.transform(raw);
            if (highlighted.length > 0) term.write(highlighted);
          } else if (typeof raw === "string") {
            term.write(raw);
          } else {
            term.write(new Uint8Array(raw));
          }
        };
        ws.onclose = () => {
          if (!disposed) {
            setReady(true);
            term.write("\r\n\x1b[33m本地终端已关闭\x1b[0m\r\n");
          }
        };
      })
      .catch((e) => {
        setReady(true);
        term.write(`\r\n\x1b[31m无法打开本地终端: ${e}\x1b[0m\r\n`);
      });

    return () => {
      disposed = true;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      ro.disconnect();
      onDataDisp.dispose();
      onSelDisp.dispose();
      host.removeEventListener("keydown", onKeyDown);
      highlighter?.flush();
      wsRef.current?.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, cwd]);

  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const t = window.setTimeout(() => {
      try {
        fit.fit();
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
          ws.send(
            JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
          );
        }
        term.focus();
      } catch {
        /* ignore */
      }
    }, 16);
    return () => clearTimeout(t);
  }, [active]);

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term) return;
    term.options.fontFamily = settings.fontFamily;
    term.options.fontSize = settings.fontSize;
    term.options.lineHeight = settings.lineHeight;
    term.options.cursorBlink = settings.cursorBlink;
    term.options.cursorStyle = settings.cursorStyle;
    term.options.scrollback = settings.scrollback;
    term.options.rightClickSelectsWord = settings.rightClickSelectsWord;
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
    settings.scrollback,
    settings.rightClickSelectsWord,
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
          <span>正在打开本地终端…</span>
        </div>
      )}
    </div>
  );
}
