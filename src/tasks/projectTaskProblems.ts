import type { ProjectTaskRun } from "../types";

export type TaskProblem = { taskId: string; path: string; line: number; column?: number; message: string };

/** 兼容 TypeScript、Rust、Python/pytest 等常见 `path:line(:column): message` 输出。 */
export function parseTaskProblems(tasks: ProjectTaskRun[]): TaskProblem[] {
  const problems: TaskProblem[] = [];
  for (const task of tasks) {
    for (const line of task.output.split("\n")) {
      const match = line.match(/^(.+?):(\d+)(?::(\d+))?:\s*(?:error(?:\[[^\]]+\])?|warning|E\d+)?\s*:?\s*(.+)$/i);
      if (!match) continue;
      const [, path, lineNumber, column, message] = match;
      if (!path || path.startsWith("http")) continue;
      problems.push({ taskId: task.id, path: path.replace(/^\.\//, ""), line: Number(lineNumber), column: column ? Number(column) : undefined, message: message.trim() });
      if (problems.length >= 200) return problems;
    }
  }
  return problems;
}
