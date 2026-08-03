import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProjectBatchJob, TransferTask } from "../types";
import { summarizeTransferTasks } from "./taskSummary";

type TaskContextValue = {
  tasks: TransferTask[];
  error: string;
  refresh: () => Promise<void>;
  cancel: (id: string) => Promise<void>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  clearDone: () => Promise<void>;
  batchJobs: ProjectBatchJob[];
  batchError: string;
  cancelBatch: (id: string) => Promise<void>;
  retryBatch: (job: ProjectBatchJob) => Promise<void>;
};

export type TaskSummaryState = {
  active: number;
  failed: number;
  batchActive: number;
  batchFailed: number;
};

const TaskContext = createContext<TaskContextValue | null>(null);
const TaskSummaryContext = createContext<TaskSummaryState | null>(null);

/** 应用级传输状态：抽屉关闭后仍订阅事件，仅在有活动任务时低频兜底轮询。 */
export function TaskProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<TransferTask[]>([]);
  const [error, setError] = useState("");
  const [batchJobs, setBatchJobs] = useState<ProjectBatchJob[]>([]);
  const [batchError, setBatchError] = useState("");
  const eventTasksRef = useRef(new Map<string, TransferTask>());
  const refresh = useCallback(async () => {
    try {
      const next = await invoke<TransferTask[]>("transfer_list");
      setTasks((previous) => trimTasks(next.map((task) => eventTasksRef.current.get(task.id) ?? task).concat(previous.filter((task) => !next.some((item) => item.id === task.id) && eventTasksRef.current.has(task.id)))));
      setError("");
    } catch (reason) {
      setError(`传输队列读取失败：${String(reason)}`);
      throw reason;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let unState: (() => void) | undefined;
    let unProgress: (() => void) | undefined;
    let unBatchState: (() => void) | undefined;
    let unBatchProgress: (() => void) | undefined;
    void (async () => {
      try {
        const stateCleanup = await listen<TransferTask>("transfer://state", (event) => {
          if (alive) { eventTasksRef.current.set(event.payload.id, event.payload); setTasks((previous) => upsert(previous, event.payload)); }
        });
        if (!alive) { stateCleanup(); return; }
        unState = stateCleanup;
        const progressCleanup = await listen<{ task_id: string; transferred: number; total: number }>("transfer://progress", (event) => {
          if (!alive) return;
          const current = eventTasksRef.current.get(event.payload.task_id);
          if (current) eventTasksRef.current.set(event.payload.task_id, { ...current, transferred: event.payload.transferred, total: event.payload.total });
          setTasks((previous) => previous.map((task) => task.id === event.payload.task_id ? { ...task, transferred: event.payload.transferred, total: event.payload.total } : task));
        });
        if (!alive) { progressCleanup(); return; }
        unProgress = progressCleanup;
        const batchStateCleanup = await listen<ProjectBatchJob>("project-batch://state", (event) => { if (alive) setBatchJobs((previous) => upsertBatch(previous, event.payload)); });
        if (!alive) { batchStateCleanup(); return; }
        unBatchState = batchStateCleanup;
        const batchProgressCleanup = await listen<ProjectBatchJob>("project-batch://progress", (event) => { if (alive) setBatchJobs((previous) => upsertBatch(previous, event.payload)); });
        if (!alive) { batchProgressCleanup(); return; }
        unBatchProgress = batchProgressCleanup;
        if (!alive) { stateCleanup(); progressCleanup(); batchStateCleanup(); batchProgressCleanup(); return; }
        // 订阅全部建立后再读快照，事件中的最新状态会优先于快照。
        await Promise.all([
          refresh().catch(() => undefined),
          invoke<ProjectBatchJob[]>("project_batch_list", { root: null }).then((items) => { if (alive) setBatchJobs((previous) => mergeBatchSnapshot(previous, items)); }).catch((reason) => setBatchError(`项目批量任务读取失败：${String(reason)}`)),
        ]);
      } catch (reason) {
        if (alive) setError(`后台任务监听失败：${String(reason)}`);
      }
    })();
    return () => { alive = false; unState?.(); unProgress?.(); unBatchState?.(); unBatchProgress?.(); };
  }, [refresh]);

  const hasActive = summarizeTransferTasks(tasks).active > 0;
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => { void refresh().catch(() => {}); }, 5000);
    return () => window.clearInterval(timer);
  }, [hasActive, refresh]);

  const call = useCallback(async (command: string, id?: string) => {
    try {
      await invoke(command, id ? { id } : undefined);
      await refresh();
    } catch (reason) {
      setError(`传输操作失败：${String(reason)}`);
      throw reason;
    }
  }, [refresh]);
  const cancelBatch = useCallback(async (id: string) => {
    try { await invoke("project_batch_cancel", { id }); }
    catch (reason) { setBatchError(`取消项目批量任务失败：${String(reason)}`); throw reason; }
  }, []);
  const retryBatch = useCallback(async (job: ProjectBatchJob) => {
    const paths = job.failures.length ? job.failures.map((failure) => failure.path) : job.paths;
    try { await invoke("project_batch_start", { operation: job.operation, root: job.root, paths, destination: job.destination, confirmed: true }); }
    catch (reason) { setBatchError(`重试项目批量任务失败：${String(reason)}`); throw reason; }
  }, []);
  const value = useMemo<TaskContextValue>(() => ({
    tasks,
    error,
    refresh,
    cancel: (id) => call("transfer_cancel", id),
    pause: (id) => call("transfer_pause", id),
    resume: (id) => call("transfer_resume", id),
    retry: (id) => call("transfer_retry", id),
    clearDone: () => call("transfer_clear_done"),
    batchJobs,
    batchError,
    cancelBatch,
    retryBatch,
  }), [batchError, batchJobs, call, cancelBatch, error, refresh, retryBatch, tasks]);
  const rawSummary = useMemo(() => {
    const transfer = summarizeTransferTasks(tasks);
    return {
      active: transfer.active,
      failed: transfer.failed,
      batchActive: batchJobs.filter((job) => ["queued", "running", "cancelling"].includes(job.status)).length,
      batchFailed: batchJobs.filter((job) => ["partial", "failed", "cancelled"].includes(job.status)).length,
    };
  }, [batchJobs, tasks]);
  // 传输字节进度会高频变化；工具条只依赖数量，因此不能因为每个 progress
  // 事件而让整棵应用树重新渲染。
  const summary = useMemo<TaskSummaryState>(() => rawSummary, [rawSummary.active, rawSummary.failed, rawSummary.batchActive, rawSummary.batchFailed]);
  return <TaskContext.Provider value={value}><TaskSummaryContext.Provider value={summary}>{children}</TaskSummaryContext.Provider></TaskContext.Provider>;
}

export function useTasks(): TaskContextValue {
  const context = useContext(TaskContext);
  if (!context) throw new Error("useTasks 必须在 TaskProvider 内使用");
  return context;
}

/** 轻量任务统计；适用于全局工具条和应用壳层。 */
export function useTaskSummary(): TaskSummaryState {
  const context = useContext(TaskSummaryContext);
  if (!context) throw new Error("useTaskSummary 必须在 TaskProvider 内使用");
  return context;
}

function upsert(list: TransferTask[], task: TransferTask): TransferTask[] {
  const index = list.findIndex((item) => item.id === task.id);
  if (index === -1) return trimTasks([...list, task]);
  const next = [...list];
  next[index] = task;
  return trimTasks(next);
}

function trimTasks(list: TransferTask[]): TransferTask[] {
  return list.slice(-20);
}

function upsertBatch(list: ProjectBatchJob[], job: ProjectBatchJob): ProjectBatchJob[] {
  const index = list.findIndex((item) => item.id === job.id);
  if (index === -1) return [...list, job].slice(-20);
  const previous = list[index];
  const progress = job.completed + job.failed + job.skipped;
  const previousProgress = previous.completed + previous.failed + previous.skipped;
  if (progress < previousProgress && !["succeeded", "partial", "failed", "cancelled"].includes(job.status)) return list;
  const next = [...list];
  next[index] = job;
  return next;
}

function mergeBatchSnapshot(current: ProjectBatchJob[], snapshot: ProjectBatchJob[]): ProjectBatchJob[] {
  const merged = new Map(snapshot.map((job) => [job.id, job]));
  for (const job of current) {
    const fromSnapshot = merged.get(job.id);
    if (!fromSnapshot || job.completed + job.failed + job.skipped >= fromSnapshot.completed + fromSnapshot.failed + fromSnapshot.skipped || ["succeeded", "partial", "failed", "cancelled"].includes(job.status)) merged.set(job.id, job);
  }
  return [...merged.values()].slice(-20);
}
