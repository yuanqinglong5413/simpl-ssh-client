import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { lspDiagnosticsToCm } from "./diagnostics";

describe("LSP 诊断映射", () => {
  const doc = Text.of(["const x = 1;", "const y = 2;"]);

  it("maps severity, range→offset 并拼接 source 前缀", () => {
    const [item] = lspDiagnosticsToCm([{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, severity: 1, message: "未使用", source: "pyright" }], doc);
    expect(item?.severity).toBe("error");
    expect(item?.from).toBe(6);
    expect(item?.to).toBe(7);
    expect(item?.message).toBe("pyright: 未使用");
  });

  it("把 warning 映射为 accent 级别，未知 severity 归 info", () => {
    const [warn, info] = lspDiagnosticsToCm([{ severity: 2, message: "w", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }, { severity: 4, message: "i", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }], doc);
    expect(warn?.severity).toBe("warning");
    expect(info?.severity).toBe("info");
  });

  it("缺省 range 退化为 0，且 to 不小于 from", () => {
    const [item] = lspDiagnosticsToCm([{ message: "x" }], doc);
    expect(item?.from).toBe(0);
    expect(item?.to).toBe(0);
    expect(item?.severity).toBe("info");
  });
});
