import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { buildCompletion } from "./completionItems";

describe("LSP 补全项映射", () => {
  const doc = Text.of(["console.log"]);

  it("无 insertText 时用 label 作为 apply 文本", () => {
    const item = buildCompletion({ label: "foo" }, doc);
    expect(item.apply).toBe("foo");
  });

  it("优先使用 insertText", () => {
    const item = buildCompletion({ label: "foo (deprecated)", insertText: "foo" }, doc);
    expect(item.apply).toBe("foo");
  });

  it("textEdit 生成 apply 函数以精确替换范围", () => {
    const item = buildCompletion({ label: "log", textEdit: { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } }, newText: "log" } }, doc);
    expect(typeof item.apply).toBe("function");
  });

  it("insertTextFormat=2 转为 snippet 补全（apply 为函数）", () => {
    const item = buildCompletion({ label: "fn", insertText: "fn($1)", insertTextFormat: 2 }, doc);
    expect(typeof item.apply).toBe("function");
  });

  it("把 LSP kind 映射到 CodeMirror 图标类别", () => {
    expect(buildCompletion({ label: "x", kind: 3 }, doc).type).toBe("function");
    expect(buildCompletion({ label: "x", kind: 7 }, doc).type).toBe("class");
    expect(buildCompletion({ label: "x", kind: 99 }, doc).type).toBe("variable");
  });
});
