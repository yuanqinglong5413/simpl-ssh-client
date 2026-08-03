import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";

export type ToastKind = "info" | "success" | "error";
export type ToastEntry = { id: string; message: string; kind: ToastKind; updatedAt: number; closing?: boolean; count: number };
type ToastContextValue = { toast: (message: string, kind?: ToastKind) => void; dismiss: (id: string) => void };

const ToastContext = createContext<ToastContextValue | null>(null);
const MAX_VISIBLE = 3;

export function toastDuration(kind: ToastKind): number {
  return kind === "info" ? 3500 : kind === "success" ? 4000 : 8000;
}

export function upsertToast(entries: ToastEntry[], message: string, kind: ToastKind, now: number, id: string = crypto.randomUUID()): ToastEntry[] {
  const match = entries.find((entry) => entry.message === message && entry.kind === kind && !entry.closing);
  if (match) return entries.map((entry) => entry.id === match.id ? { ...entry, count: entry.count + 1, updatedAt: now } : entry);
  return [...entries, { id, message, kind, updatedAt: now, count: 1 }];
}

export function visibleToasts(entries: ToastEntry[]): ToastEntry[] {
  return entries.slice(0, MAX_VISIBLE);
}

/** 全局非阻断通知：限制可见数量、自动关闭、重复合并，并且不覆盖终端输入区。 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ToastEntry[]>([]);
  const removalTimers = useRef<Map<string, number>>(new Map());
  const dismiss = useCallback((id: string) => {
    setEntries((previous) => previous.map((entry) => entry.id === id ? { ...entry, closing: true } : entry));
    if (removalTimers.current.has(id)) return;
    const timer = window.setTimeout(() => {
      removalTimers.current.delete(id);
      setEntries((previous) => previous.filter((entry) => entry.id !== id));
    }, 140);
    removalTimers.current.set(id, timer);
  }, []);
  const toast = useCallback((message: string, kind: ToastKind = "error") => {
    const normalized = message.trim();
    if (!normalized) return;
    setEntries((previous) => upsertToast(previous, normalized, kind, Date.now()));
  }, []);
  useEffect(() => () => removalTimers.current.forEach((timer) => window.clearTimeout(timer)), []);
  const value = useMemo(() => ({ toast, dismiss }), [dismiss, toast]);
  return <ToastContext.Provider value={value}>{children}<ToastViewport entries={visibleToasts(entries)} onDismiss={dismiss} /></ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast 必须在 ToastProvider 内使用");
  return context;
}

function ToastViewport({ entries, onDismiss }: { entries: ToastEntry[]; onDismiss: (id: string) => void }) {
  return <div className="toast-viewport" aria-label="应用通知">{entries.map((entry) => <ToastItem key={entry.id} entry={entry} onDismiss={onDismiss} />)}</div>;
}

function ToastItem({ entry, onDismiss }: { entry: ToastEntry; onDismiss: (id: string) => void }) {
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(toastDuration(entry.kind));
  const startedAtRef = useRef<number | null>(null);
  useEffect(() => {
    remainingRef.current = toastDuration(entry.kind);
    startedAtRef.current = null;
  }, [entry.kind, entry.updatedAt]);
  useEffect(() => {
    if (paused || entry.closing) return;
    startedAtRef.current = Date.now();
    const timer = window.setTimeout(() => onDismiss(entry.id), remainingRef.current);
    return () => {
      window.clearTimeout(timer);
      if (startedAtRef.current !== null) {
        remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
        startedAtRef.current = null;
      }
    };
  }, [entry.closing, entry.id, entry.updatedAt, onDismiss, paused]);
  const Icon = entry.kind === "error" ? CircleAlert : entry.kind === "success" ? CheckCircle2 : Info;
  return <div className={`toast toast-${entry.kind} ${entry.closing ? "leaving" : ""}`} role={entry.kind === "error" ? "alert" : "status"} aria-live={entry.kind === "error" ? "assertive" : "polite"} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocusCapture={() => setPaused(true)} onBlurCapture={() => setPaused(false)}><Icon size={16} /><span>{entry.message}{entry.count > 1 ? ` ×${entry.count}` : ""}</span><button type="button" aria-label="关闭提示" onClick={() => onDismiss(entry.id)}><X size={14} /></button></div>;
}
