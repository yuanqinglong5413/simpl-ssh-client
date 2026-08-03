import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ProjectBatchJob, ProjectTaskRun, TransferTask } from "../types";

export type ActivitySeverity = "info" | "warning" | "error";
export type ActivityKind = "transfer" | "task" | "connection" | "workspace" | "file" | "sftp";

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  severity: ActivitySeverity;
  title: string;
  detail?: string;
  createdAt: string;
  referenceId?: string;
  projectId?: string;
};

type ActivityContextValue = {
  items: ActivityItem[];
  add: (item: Omit<ActivityItem, "id" | "createdAt"> & { id?: string }) => void;
  dismiss: (id: string) => void;
  clear: () => void;
};

const ActivityContext = createContext<ActivityContextValue | null>(null);
const MAX_ITEMS = 100;

/** 运行期“需要处理”时间线：不持久化，失败项不会像 Toast 一样自动消失。 */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const seenRef = useRef(new Set<string>());
  const add = useCallback((input: Omit<ActivityItem, "id" | "createdAt"> & { id?: string }) => {
    const id = input.id ?? `${input.kind}:${input.referenceId ?? ""}:${input.title}`;
    setItems((current) => {
      if (seenRef.current.has(id)) return current;
      seenRef.current.add(id);
      return [{ ...input, id, createdAt: new Date().toISOString() }, ...current].slice(0, MAX_ITEMS);
    });
  }, []);
  const dismiss = useCallback((id: string) => setItems((current) => current.filter((item) => item.id !== id)), []);
  const clear = useCallback(() => { setItems([]); seenRef.current.clear(); }, []);

  useEffect(() => {
    let alive = true;
    const cleanups: Array<() => void> = [];
    void listen<TransferTask>("transfer://state", (event) => {
      if (!alive || (event.payload.status !== "failed" && event.payload.status !== "cancelled")) return;
      const task = event.payload;
      add({ id: `transfer:${task.id}:${task.status}:${task.retry_count}`, kind: "transfer", severity: task.status === "failed" ? "error" : "warning", title: task.status === "failed" ? "文件传输失败" : "文件传输已取消", detail: task.error || `${task.local_path} → ${task.remote_path}`, referenceId: task.id });
    }).then((cleanup) => { if (alive) cleanups.push(cleanup); else cleanup(); }).catch(() => {});
    void listen<ProjectTaskRun>("project-task://state", (event) => {
      if (!alive || (event.payload.status !== "failed" && event.payload.status !== "cancelled")) return;
      const task = event.payload;
      add({ id: `task:${task.id}:${task.status}`, kind: "task", severity: task.status === "failed" ? "error" : "warning", title: task.status === "failed" ? `任务失败：${task.label}` : `任务已取消：${task.label}`, detail: task.output || `退出码：${task.exit_code ?? "未知"}`, referenceId: task.id });
    }).then((cleanup) => { if (alive) cleanups.push(cleanup); else cleanup(); }).catch(() => {});
    void listen<ProjectBatchJob>("project-batch://state", (event) => {
      if (!alive || !["partial", "failed", "cancelled"].includes(event.payload.status)) return;
      const job = event.payload;
      add({ id: `batch:${job.id}:${job.status}`, kind: "file", severity: job.status === "cancelled" ? "warning" : "error", title: job.status === "partial" ? "项目文件操作部分失败" : job.status === "cancelled" ? "项目文件操作已取消" : "项目文件操作失败", detail: `${job.completed} 完成、${job.failed} 失败、${job.skipped} 未执行`, referenceId: job.id });
    }).then((cleanup) => { if (alive) cleanups.push(cleanup); else cleanup(); }).catch(() => {});
    return () => { alive = false; cleanups.forEach((cleanup) => cleanup()); };
  }, [add]);

  const value = useMemo(() => ({ items, add, dismiss, clear }), [add, clear, dismiss, items]);
  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>;
}

export function useActivity(): ActivityContextValue {
  const context = useContext(ActivityContext);
  if (!context) throw new Error("useActivity 必须在 ActivityProvider 内使用");
  return context;
}
