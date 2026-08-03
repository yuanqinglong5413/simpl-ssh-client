import { describe, expect, it } from "vitest";
import { loadWorkbenchState } from "./workbenchState";

describe("workbench state", () => {
  it("falls back safely when old or malformed state is loaded", () => {
    expect(loadWorkbenchState("{bad").openFiles).toEqual([]);
    expect(loadWorkbenchState(JSON.stringify({ activity: "invalid", openFiles: ["src/main.ts", 4], bottomHeight: 9999 }))).toMatchObject({ activity: "explorer", openFiles: ["src/main.ts"], bottomHeight: 520 });
  });
});
