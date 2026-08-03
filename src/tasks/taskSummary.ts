import type { TransferTask } from "../types";

export function summarizeTransferTasks(tasks: TransferTask[]) {
  return {
    active: tasks.filter((task) => task.status === "queued" || task.status === "running" || task.status === "paused").length,
    failed: tasks.filter((task) => task.status === "failed").length,
  };
}
