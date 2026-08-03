import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { clampPosition, lspPositionToOffset, lspRangeToOffsets, normalizeLspLocations, offsetToLspPosition, relativePathFromFileUri } from "./navigation";

describe("LSP navigation helpers", () => {
  it("normalizes Location and LocationLink responses", () => {
    const locations = normalizeLspLocations([
      { uri: "file:///workspace/a.ts", range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } },
      { targetUri: "file:///workspace/b.ts", targetSelectionRange: { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } } },
    ]);
    expect(locations).toHaveLength(2);
    expect(locations[1]?.uri).toBe("file:///workspace/b.ts");
  });

  it("rejects paths outside the project root", () => {
    expect(relativePathFromFileUri("/workspace/project", "file:///workspace/project/src/main.ts")).toBe("src/main.ts");
    expect(relativePathFromFileUri("/workspace/project", "file:///workspace/project-other/a.ts")).toBeNull();
    expect(relativePathFromFileUri("/workspace/project", "https://example.com/a.ts")).toBeNull();
    expect(relativePathFromFileUri("C:/Work/Project", "file:///c:/work/project/src/Main.java")).toBe("src/Main.java");
  });

  it("clamps line and character without breaking UTF-16 offsets", () => {
    expect(clampPosition(5, 99, "😀 name\nnext")).toEqual({ line: 1, character: 4, offset: 12 });
    expect(clampPosition(0, 2, "😀 name").offset).toBe(2);
  });

  it("round-trips CodeMirror offsets and LSP positions with clamping", () => {
    const doc = Text.of(["abc", "def"]);
    expect(offsetToLspPosition(doc, 5)).toEqual({ line: 1, character: 1 });
    expect(lspPositionToOffset(doc, { line: 1, character: 0 })).toBe(4);
    expect(lspPositionToOffset(doc, { line: 1, character: 99 })).toBe(7);
    expect(lspRangeToOffsets(doc, { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } })).toEqual({ from: 1, to: 3 });
  });
});
