import { describe, expect, it } from "vitest";
import { parseTaskProblems } from "./projectTaskProblems";

describe("project task problems", () => {
  it("extracts common file locations", () => {
    expect(parseTaskProblems([{ id: "task", output: "src/main.ts:12:4: error bad type", task_id: "x", label: "test", command: "test", cwd: "/tmp", status: "failed", started_at: "", ended_at: null, exit_code: 1 }])).toEqual([{ taskId: "task", path: "src/main.ts", line: 12, column: 4, message: "bad type" }]);
  });
});
