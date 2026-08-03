import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Copy, RotateCw, Square, XCircle } from "lucide-react";
import type { ProjectTaskRun } from "../types";
import { parseTaskProblems, type TaskProblem } from "../tasks/projectTaskProblems";
import { invokeWithTimeout } from "../utils/invokeWithTimeout";
import { useToast } from "../feedback/ToastProvider";
import { ErrorState, LoadingState } from "./LoadingState";

/** 工作台回灌的 LSP 诊断行（line/character 为 0-based，与 LSP 一致）。 */
export type LspProblemRow = { path: string; line: number; character: number; severity?: number; message?: string; source?: string };

/** 合并后的统一问题行（内部统一 0-based）。 */
type ProblemRow = { path: string; line: number; character: number; severity?: number; message: string; source?: string };

type Props = { root: string; view?: "tasks" | "problems" | "output"; onOpenFile: (path: string, line?: number, character?: number) => void; onTasksChange?: (tasks: ProjectTaskRun[]) => void; lspProblems?: LspProblemRow[] };

const SEVERITY_CLASS: Record<number, string> = { 1: "error", 2: "warning" };

/** 任务问题（编译器输出为 1-based）转 0-based 统一行，默认 error。 */
function taskProblemToRow(problem: TaskProblem): ProblemRow {
  return { path: problem.path, line: Math.max(0, problem.line - 1), character: Math.max(0, (problem.column ?? 1) - 1), severity: 1, message: problem.message };
}
function lspProblemToRow(problem: LspProblemRow): ProblemRow {
  return { path: problem.path, line: problem.line, character: problem.character, severity: problem.severity, message: problem.message ?? "", source: problem.source };
}
function severityClass(severity: number | undefined): string {
  return SEVERITY_CLASS[severity ?? 0] ?? "info";
}
function bySeverityPathLine(a: ProblemRow, b: ProblemRow): number {
  const severityA = a.severity ?? 3;
  const severityB = b.severity ?? 3;
  if (severityA !== severityB) return severityA - severityB;
  return a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1;
}

function ProblemRowView({ problem, onOpen }: { problem: ProblemRow; onOpen: (path: string, line: number, character: number) => void }) {
  const prefix = problem.source ? `${problem.source}: ` : "";
  return <button className={`problem-row problem-${severityClass(problem.severity)}`} onClick={() => onOpen(problem.path, problem.line, problem.character)}><em className="problem-severity" aria-hidden="true">{severityClass(problem.severity)[0]?.toUpperCase()}</em><strong>{problem.path}:{problem.line + 1}</strong><span>{prefix}{problem.message}</span></button>;
}

export function ProjectTaskPanel({ root, view = "tasks", onOpenFile, onTasksChange, lspProblems = [] }: Props) {
  const [tasks, setTasks] = useState<ProjectTaskRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const finalEventsRef = useRef(new Map<string, ProjectTaskRun>());
  const { toast } = useToast();
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    finalEventsRef.current.clear();
    setLoading(true); setError("");
    void (async () => {
      try {
        const cleanup = await listen<ProjectTaskRun>("project-task://state", (event) => {
          if (event.payload.cwd !== root) return;
          if (["succeeded", "failed", "cancelled"].includes(event.payload.status)) finalEventsRef.current.set(event.payload.id, event.payload);
          setTasks((current) => {
            const next = current.some((item) => item.id === event.payload.id) ? current.map((item) => item.id === event.payload.id ? event.payload : item) : [...current, event.payload];
            return next.slice(-40);
          });
          setSelectedId((current) => current ?? event.payload.id);
        });
        if (disposed) cleanup(); else unlisten = cleanup;
        const items = await invokeWithTimeout(invoke<ProjectTaskRun[]>("project_task_list", { root }), "project_task_list");
        if (disposed) return;
        setTasks(() => { const merged = new Map(items.map((item) => [item.id, item])); for (const [id, item] of finalEventsRef.current) merged.set(id, item); return [...merged.values()].slice(-40); });
        setSelectedId((current) => current ?? items[items.length - 1]?.id ?? null);
      } catch (reason) {
        if (!disposed) setError(String(reason));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => { disposed = true; unlisten?.(); };
  }, [root, retryNonce]);
  useEffect(() => onTasksChange?.(tasks), [onTasksChange, tasks]);
  const selected = tasks.find((task) => task.id === selectedId) ?? tasks[tasks.length - 1] ?? null;
  const mergedProblems = useMemo(() => [...parseTaskProblems(tasks).map(taskProblemToRow), ...lspProblems.map(lspProblemToRow)].sort(bySeverityPathLine), [tasks, lspProblems]);
  if (loading) return <LoadingState compact label="正在读取任务记录…" />;
  if (error) return <ErrorState label="任务记录不可用" message={error} onRetry={() => setRetryNonce((value) => value + 1)} />;
  function rerun(task: ProjectTaskRun) {
    void invoke("project_task_start", { root, taskId: task.task_id, label: task.label, command: task.command })
      .then(() => toast("任务已重新排队", "info"))
      .catch((reason) => toast(`任务启动失败：${String(reason)}`, "error"));
  }
  if (view === "problems") return <div className="project-task-problems project-problems-view"><strong>问题 {mergedProblems.length}</strong>{mergedProblems.length ? mergedProblems.map((problem, index) => <ProblemRowView key={`${problem.path}:${problem.line}:${index}`} problem={problem} onOpen={onOpenFile} />) : <p>暂无问题。打开文件后 LSP 实时诊断会显示在这里；运行任务后构建错误也会合并展示。</p>}</div>;
  return <div className="project-task-panel"><div className="project-task-list">{tasks.length ? tasks.slice().reverse().map((task) => <button key={task.id} className={task.id === selected?.id ? "active" : ""} onClick={() => setSelectedId(task.id)}><span className={`task-state task-${task.status}`} /> <strong>{task.label}</strong><small>{task.status === "succeeded" ? "成功" : task.status === "failed" ? "失败" : task.status === "cancelled" ? "已取消" : task.status === "running" || task.status === "cancelling" ? "运行中" : "排队中"}</small></button>) : <p>尚未运行项目任务。</p>}</div><div className="project-task-output">{selected ? <><header><code>{selected.command}</code><span className="project-task-actions">{(selected.status === "queued" || selected.status === "running" || selected.status === "cancelling") && <button className="icon-btn" title="停止任务" onClick={() => void invoke("project_task_cancel", { id: selected.id }).then(() => toast("已请求停止任务", "info")).catch((reason) => toast(`停止任务失败：${String(reason)}`, "error"))}><Square size={13} /></button>}<button className="icon-btn" title="重新运行" onClick={() => rerun(selected)}><RotateCw size={13} /></button><button className="icon-btn" title="复制命令" onClick={() => void navigator.clipboard?.writeText(selected.command).catch((reason) => toast(`复制命令失败：${String(reason)}`, "error"))}><Copy size={13} /></button><button className="icon-btn" title="清除选择" onClick={() => setSelectedId(null)}><XCircle size={13} /></button></span></header>{selected.output_truncated && <div className="project-task-output-note">输出已截断，保留最近 200KB。</div>}<pre>{selected.output || "正在等待任务输出…"}</pre></> : <p>选择一个任务查看输出。</p>}</div>{mergedProblems.length > 0 && <div className="project-task-problems"><strong>问题 {mergedProblems.length}</strong>{mergedProblems.slice(0, 30).map((problem, index) => <ProblemRowView key={`${problem.path}:${problem.line}:${index}`} problem={problem} onOpen={onOpenFile} />)}</div>}</div>;
}
