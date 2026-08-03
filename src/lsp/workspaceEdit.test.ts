import { describe, expect, it } from "vitest";
import { applyEditsToString, normalizeWorkspaceEdit } from "./workspaceEdit";

describe("workspaceEdit", () => {
  it("applies a single text edit to a string", () => {
    const result = applyEditsToString("foo(bar)", [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "qux" }]);
    expect(result).toBe("qux(bar)");
  });

  it("applies multiple edits without offset drift (back-to-front)", () => {
    const result = applyEditsToString("ab", [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "X" },
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, newText: "Y" },
    ]);
    expect(result).toBe("XY");
  });

  it("normalizes changes and filters files outside the project root", () => {
    const files = normalizeWorkspaceEdit({ changes: { "file:///root/src/a.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "b" }], "file:///other/x.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "y" }] } }, "/root");
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("src/a.ts");
  });

  it("normalizes documentChanges form", () => {
    const files = normalizeWorkspaceEdit({ documentChanges: [{ textDocument: { uri: "file:///root/lib/m.ts" }, edits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, newText: "ok" }] }] }, "/root");
    expect(files[0]?.path).toBe("lib/m.ts");
    expect(files[0]?.edits).toHaveLength(1);
  });
});
