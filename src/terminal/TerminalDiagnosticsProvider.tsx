import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Clipboard, MonitorCog, RefreshCw, X } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useDialogFocus } from "../hooks/useDialogFocus";

export type TerminalRuntimeState = {
  paneId: string;
  transport: "SSH" | "本地";
  renderer: "webgl" | "canvas";
  rendererPreference?: "auto" | "canvas" | "webgl";
  rendererLocked?: boolean;
  rendererReason?: string;
  tuiRawMode: boolean;
  outputBusy: boolean;
  cols: number;
  rows: number;
  layoutStable: boolean;
  layoutError?: string;
};

type TerminalControls = { redraw: () => void; forceCanvas: () => void };
type TerminalDiagnosticsValue = {
  report: (state: TerminalRuntimeState) => void;
  register: (paneId: string, controls: TerminalControls) => () => void;
  open: (paneId: string) => void;
  redraw: (paneId: string) => void;
  forceCanvas: (paneId: string) => void;
};

const TerminalDiagnosticsContext = createContext<TerminalDiagnosticsValue | null>(null);

/** 本地诊断仅存在内存中，不收集终端输出、主机信息或认证信息。 */
export function TerminalDiagnosticsProvider({ children }: { children: ReactNode }) {
  const [states, setStates] = useState<Record<string, TerminalRuntimeState>>({});
  const [controls, setControls] = useState<Record<string, TerminalControls>>({});
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const report = useCallback((state: TerminalRuntimeState) => {
    setStates((previous) => {
      const old = previous[state.paneId];
      if (old && JSON.stringify(old) === JSON.stringify(state)) return previous;
      return { ...previous, [state.paneId]: state };
    });
  }, []);
  const register = useCallback((paneId: string, next: TerminalControls) => {
    setControls((previous) => ({ ...previous, [paneId]: next }));
    return () => {
      setControls((previous) => {
        const copy = { ...previous };
        delete copy[paneId];
        return copy;
      });
      setStates((previous) => {
        const copy = { ...previous };
        delete copy[paneId];
        return copy;
      });
    };
  }, []);
  const open = useCallback((paneId: string) => setSelectedPaneId(paneId), []);
  const redraw = useCallback((paneId: string) => controls[paneId]?.redraw(), [controls]);
  const forceCanvas = useCallback((paneId: string) => controls[paneId]?.forceCanvas(), [controls]);
  const value = useMemo(() => ({ report, register, open, redraw, forceCanvas }), [forceCanvas, open, redraw, register, report]);
  return <TerminalDiagnosticsContext.Provider value={value}>{children}<TerminalDiagnosticsDialog state={selectedPaneId ? states[selectedPaneId] : null} onClose={() => setSelectedPaneId(null)} onRedraw={() => selectedPaneId && redraw(selectedPaneId)} onForceCanvas={() => selectedPaneId && forceCanvas(selectedPaneId)} /></TerminalDiagnosticsContext.Provider>;
}

export function useTerminalDiagnostics(): TerminalDiagnosticsValue {
  const context = useContext(TerminalDiagnosticsContext);
  if (!context) throw new Error("useTerminalDiagnostics 必须在 TerminalDiagnosticsProvider 内使用");
  return context;
}

function TerminalDiagnosticsDialog({ state, onClose, onRedraw, onForceCanvas }: { state: TerminalRuntimeState | null; onClose: () => void; onRedraw: () => void; onForceCanvas: () => void }) {
  const dialogRef = useDialogFocus(Boolean(state), onClose);
  if (!state) return null;
  const lines = formatTerminalDiagnostics(state);
  const copy = async () => {
    try { await writeText(lines); } catch { /* 剪贴板不可用时不影响终端 */ }
  };
  return <div className="overlay" onMouseDown={onClose}><section ref={dialogRef} className="dialog terminal-diagnostics-dialog" role="dialog" aria-modal="true" aria-label="终端诊断" onMouseDown={(event) => event.stopPropagation()}><header className="dialog-head"><div className="dialog-title"><MonitorCog size={16} /> 终端诊断</div><button type="button" aria-label="关闭终端诊断" onClick={onClose}><X size={16} /></button></header><div className="dialog-body"><p>以下信息仅在本机生成，不包含终端输出、主机地址或认证信息。</p><pre>{lines}</pre><div className="dialog-actions"><button type="button" className="btn btn-ghost" onClick={onRedraw}><RefreshCw size={14} /> 重新绘制</button><button type="button" className="btn btn-ghost" onClick={onForceCanvas} disabled={state.renderer === "canvas"}><MonitorCog size={14} /> 当前标签改用 Canvas</button><button type="button" className="btn btn-primary" onClick={() => void copy()}><Clipboard size={14} /> 复制诊断</button></div></div></section></div>;
}

export function formatTerminalDiagnostics(state: TerminalRuntimeState): string {
  return [
    "Simpl SSH terminal diagnostics",
    `Transport: ${state.transport}`,
    `Renderer: ${state.renderer}${state.rendererReason ? ` (${state.rendererReason})` : ""}`,
    `Renderer preference: ${state.rendererPreference ?? "auto"}${state.rendererLocked ? " (locked for this tab)" : ""}`,
    `TUI raw output: ${state.tuiRawMode ? "enabled" : "disabled"}`,
    `Terminal size: ${state.cols} cols × ${state.rows} rows`,
    `Layout: ${state.layoutStable ? "stable" : "pending"}${state.layoutError ? ` (${state.layoutError})` : ""}`,
  ].join("\n");
}
