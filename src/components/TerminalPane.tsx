import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SerializeAddon } from "@xterm/addon-serialize";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme/ThemeProvider";
import { installTerminalActions } from "../utils/terminalActions";
import { useBroadcast } from "../broadcast";
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
  sessionId: string;
  paneId: string;
  /** 新建项目工作区终端后自动执行的安全导航命令。 */
  startupCommand?: string;
  /** WebSocket 意外关闭时回调（用于断线重连） */
  onConnectionLost?: (sessionId: string) => void;
  /** 非当前标签不执行 fit/刷新，并释放 WebGL。 */
  active?: boolean;
};

/**
 * 一个终端面板：xterm.js ↔ 本地 WebSocket ↔ 后端 PTY channel。
 * 支持动态 resize、Ctrl+F 搜索、主题联动、日志语法高亮。
 */
export function TerminalPane({ sessionId, paneId, startupCommand, onConnectionLost, active = true }: Props) {
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
  // 用 ref 存储 onConnectionLost，避免其引用变化导致 useEffect 重跑（重建终端+WS）
  const connLostRef = useRef(onConnectionLost);
  connLostRef.current = onConnectionLost;
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
  const { terminalTheme } = useTheme();
  const { settings } = useSettings();
  // settings 也用 ref，保持 useEffect 依赖最小化
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const broadcast = useBroadcast();
  const broadcastRef = useRef(broadcast);
  broadcastRef.current = broadcast;
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

    // 复制 / 粘贴 / 导出日志（与本地终端共用）
    const cleanupActions = installTerminalActions({
      term,
      host,
      tag: `session-${sessionId}`,
      serialize: serializeRef.current,
    });

    const onDataDisp = term.onData((data) => {
      const bytes = encoder.encode(data);
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(bytes);
      }
      // 多会话广播：输入 fan-out 到所有其他已打开终端
      const bc = broadcastRef.current;
      if (bc?.enabled) {
        for (const [sid, p] of bc.peers) {
          if (
            sid !== sessionId &&
            bc.targetIds.has(sid) &&
            p !== ws &&
            p.readyState === WebSocket.OPEN
          ) {
            p.send(bytes);
          }
        }
      }
    });

    // 先得到稳定的真实行列数，再创建远端 PTY，避免 TUI 在默认 80×24 / 错误
    // 字体度量上完成首屏绘制，之后只能靠窗口 resize 才恢复。
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
        return invoke<{ port: number; token: string }>("terminal_open", {
          sessionId,
          cols: term.cols,
          rows: term.rows,
          enableX11: settingsRef.current.enableX11,
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
          broadcastRef.current?.register(sessionId, ws);
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
          if (!disposed) connLostRef.current?.(sessionId);
          broadcastRef.current?.unregister(sessionId);
        };
      })
      .catch((e) => {
        if (disposed) return;
        startedRef.current = false;
        startInFlightRef.current = false;
        setReady(true);
        term.write(`\r\n\x1b[31m无法打开终端: ${e}\x1b[0m\r\n`);
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
  }, [paneId, sessionId, startupCommand]);

  useEffect(() => register(paneId, {
    redraw: () => rendererRef.current?.redraw(),
    forceCanvas: () => rendererRef.current?.forceCanvas(),
  }), [paneId, register]);

  useEffect(() => {
    const term = termRef.current;
    report({
      paneId,
      transport: "SSH",
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
      /* 切换到可见状态前容器尚未完成布局时，下一次 ResizeObserver 会补偿。 */
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
          <LoadingState compact label="正在打开终端…" />
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
