import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SerializeAddon } from "@xterm/addon-serialize";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme/ThemeProvider";
import { installTerminalActions } from "../utils/terminalActions";
import { useSettings } from "../settings/SettingsProvider";
import { TerminalOutputGuard } from "../utils/terminalOutputGuard";
import { TerminalRenderer, type TerminalRendererState } from "../utils/terminalRenderer";
import { TerminalWriteQueue } from "../utils/terminalWriteQueue";
import { TerminalLayout } from "../utils/terminalLayout";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { useTerminalDiagnostics } from "../terminal/TerminalDiagnosticsProvider";
import { LoadingState } from "./LoadingState";
import "@xterm/xterm/css/xterm.css";

type Props = {
  paneId: string;
  cwd: string;
  startupCommand?: string;
  onExit?: () => void;
  onStartFailed?: () => void;
  active?: boolean;
};

/**
 * 本地终端面板：xterm.js ↔ 本地 WebSocket ↔ portable-pty。
 * 不依赖 SSH 会话，直接在本地创建 shell 子进程。
 */
export function LocalTerminalPane({ paneId, cwd, startupCommand, onExit, onStartFailed, active = true }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const rendererRef = useRef<TerminalRenderer | null>(null);
  const outputGuardRef = useRef<TerminalOutputGuard | null>(null);
  const writeQueueRef = useRef<TerminalWriteQueue | null>(null);
  const layoutRef = useRef<TerminalLayout | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ready, setReady] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const openSearch = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId?: string }>).detail;
      if (!detail?.paneId || detail.paneId === paneId) setSearchOpen(true);
    };
    window.addEventListener("simpl-ssh:terminal-search", openSearch);
    return () => window.removeEventListener("simpl-ssh:terminal-search", openSearch);
  }, [paneId]);
  const [renderStatus, setRenderStatus] = useState<TerminalRendererState>({ preference: "auto", effective: "webgl", locked: false });
  const [outputBusy, setOutputBusy] = useState(false);
  const [tuiRawMode, setTuiRawMode] = useState(false);
  const [layoutStable, setLayoutStable] = useState(false);
  const [layoutSize, setLayoutSize] = useState({ cols: 0, rows: 0 });
  const [layoutError, setLayoutError] = useState<string>();
  const activeRef = useRef(active);
  activeRef.current = active;
  const startRef = useRef<(() => void) | null>(null);
  const startedRef = useRef(false);
  const startInFlightRef = useRef(false);
  const onExitRef = useRef(onExit);
  const onStartFailedRef = useRef(onStartFailed);
  onExitRef.current = onExit;
  onStartFailedRef.current = onStartFailed;
  const { terminalTheme } = useTheme();
  const { settings } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const { report, register, open: openDiagnostics } = useTerminalDiagnostics();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    setTuiRawMode(false);
    setLayoutStable(false);
    setLayoutSize({ cols: 0, rows: 0 });
    setLayoutError(undefined);
    const term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      scrollback: settings.scrollback,
      theme: terminalTheme,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.open(host);
    const renderer = new TerminalRenderer(term, settingsRef.current.terminalRenderer, setRenderStatus, activeRef.current);
    rendererRef.current = renderer;
    const writeQueue = new TerminalWriteQueue(term, setOutputBusy);
    writeQueueRef.current = writeQueue;
    const serializeAddon = new SerializeAddon();
    term.loadAddon(serializeAddon);
    serializeRef.current = serializeAddon;
    try {
      term.loadAddon(new WebLinksAddon());
    } catch {
      /* WebLinks 不可用时忽略 */
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

    const layout = new TerminalLayout({
      host,
      terminal: term,
      fitAddon,
      isActive: () => activeRef.current,
      onLayout: () => {
        setLayoutStable(true);
        setLayoutSize((previous) => previous.cols === term.cols && previous.rows === term.rows ? previous : { cols: term.cols, rows: term.rows });
        setLayoutError(undefined);
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = setTimeout(sendResize, 80);
        if (!startedRef.current && !startInFlightRef.current && activeRef.current) {
          startRef.current?.();
        }
      },
      onLayoutError: setLayoutError,
    });
    layoutRef.current = layout;

    let disposed = false;
    const encoder = new TextEncoder();
    const outputGuard = new TerminalOutputGuard(settingsRef.current.logHighlightMode);
    outputGuardRef.current = outputGuard;

    // 复制 / 粘贴 / 导出日志（与远程终端共用）
    const cleanupActions = installTerminalActions({
      term,
      host,
      tag: `local-${paneId}`,
      serialize: serializeRef.current,
    });

    const onDataDisp = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encoder.encode(data));
      }
    });

    const startTerminal = () => {
      if (disposed || startedRef.current || startInFlightRef.current || !activeRef.current) return;
      startInFlightRef.current = true;
      void layout.settleInitialLayout().then((settled) => {
        if (disposed || startedRef.current || !activeRef.current) return null;
        if (!settled || term.cols < 2 || term.rows < 2) {
          startInFlightRef.current = false;
          setLayoutError("终端容器尺寸尚未稳定，正在等待下一次布局");
          return null;
        }
        startedRef.current = true;
        return invoke<{ port: number; token: string }>("local_terminal_open", {
          cwd: cwd || null,
          cols: term.cols,
          rows: term.rows,
        });
      })
    .then((handle) => {
        if (disposed || !handle) {
          if (!startedRef.current) startInFlightRef.current = false;
          return;
        }
        const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/`);
        wsRef.current = ws;
        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
          ws.send(handle.token);
          if (startupCommand) ws.send(encoder.encode(`${startupCommand}\n`));
          setReady(true);
          term.focus();
          layout.schedule();
        };
        ws.onmessage = (e) => {
          const raw =
            e.data instanceof ArrayBuffer ? e.data : (e.data as string);
          const guarded = outputGuard.process(raw);
          if (guarded.enteredTui) setTuiRawMode(true);
          writeQueue.enqueue(guarded.chunks);
          if (guarded.enteredTui) writeQueue.afterDrained(() => renderer.redraw());
        };
        ws.onclose = () => {
          if (!disposed) {
            onExitRef.current?.();
            setReady(true);
            term.write("\r\n\x1b[33m本地终端已关闭\x1b[0m\r\n");
          }
        };
      })
      .catch((e) => {
        if (disposed) return;
        startedRef.current = false;
        startInFlightRef.current = false;
        onStartFailedRef.current?.();
        setReady(true);
        term.write(`\r\n\x1b[31m无法打开本地终端: ${e}\x1b[0m\r\n`);
      });
    };
    startRef.current = startTerminal;
    if (activeRef.current) startTerminal();

    return () => {
      disposed = true;
      startRef.current = null;
      startInFlightRef.current = false;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      layout.dispose();
      layoutRef.current = null;
      onDataDisp.dispose();
      cleanupActions();
      wsRef.current?.close();
      wsRef.current = null;
      renderer.dispose();
      rendererRef.current = null;
      writeQueue.dispose();
      writeQueueRef.current = null;
      outputGuardRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, cwd, startupCommand]);

  useEffect(() => register(paneId, {
    redraw: () => rendererRef.current?.redraw(),
    forceCanvas: () => rendererRef.current?.forceCanvas(),
  }), [paneId, register]);

  useEffect(() => {
    const term = termRef.current;
    report({
      paneId,
      transport: "本地",
      renderer: renderStatus.effective,
      rendererReason: renderStatus.reason,
      rendererPreference: renderStatus.preference,
      rendererLocked: renderStatus.locked,
      tuiRawMode,
      outputBusy,
      cols: layoutSize.cols || term?.cols || 0,
      rows: layoutSize.rows || term?.rows || 0,
      layoutStable,
      layoutError,
    });
  }, [layoutError, layoutSize, layoutStable, outputBusy, paneId, renderStatus, report, tuiRawMode]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const term = termRef.current;
    if (!renderer || !term) return;
    renderer.setVisible(active);
    if (!active) return;
    startRef.current?.();
    try {
      layoutRef.current?.schedule();
      renderer.redraw();
    } catch {
      /* 下一次布局通知会补偿尺寸。 */
    }
  }, [active]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = settings.fontFamily;
    term.options.fontSize = settings.fontSize;
    term.options.lineHeight = settings.lineHeight;
    term.options.cursorBlink = settings.cursorBlink;
    term.options.cursorStyle = settings.cursorStyle;
    term.options.scrollback = settings.scrollback;
    try {
      layoutRef.current?.schedule();
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
  ]);

  useEffect(() => {
    const term = termRef.current;
    if (term) {
      term.options.theme = terminalTheme;
    }
  }, [terminalTheme]);

  useEffect(() => {
    rendererRef.current?.applyPreference(settings.terminalRenderer);
  }, [settings.terminalRenderer]);

  useEffect(() => {
    outputGuardRef.current?.setMode(settings.logHighlightMode);
  }, [settings.logHighlightMode]);

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
          <LoadingState compact label="正在打开本地终端…" />
        </div>
      )}
      {(renderStatus.effective !== "webgl" || outputBusy || layoutError) && (
        <button type="button" className="terminal-render-status" onClick={() => openDiagnostics(paneId)} title="打开终端诊断">
          {outputBusy ? "输出繁忙" : layoutError ? "布局需要检查" : "Canvas 渲染"}
        </button>
      )}
    </div>
  );
}
