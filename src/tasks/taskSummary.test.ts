import { describe, expect, it } from "vitest";
import { summarizeTransferTasks } from "./taskSummary";
import type { TransferTask } from "../types";

const task = (status: TransferTask["status"]): TransferTask => ({
  id: status, session_id: "session", kind: "upload", name: "file", total: 1, transferred: 0,
  status, error: null, overwrite: "overwrite", retry_count: 0, max_retries: 3,
  local_path: "/tmp/file", remote_path: "/srv/file",
});

describe("summarizeTransferTasks", () => {
  it("counts active and failed work independent of which panel is open", () => {
    expect(summarizeTransferTasks([task("queued"), task("running"), task("paused"), task("failed"), task("done")])).toEqual({ active: 3, failed: 1 });
  });
});
