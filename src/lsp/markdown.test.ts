// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHoverContent } from "./markdown";

describe("LSP hover markdown", () => {
  it("uses CodeMirror/Lezer token classes for supported fenced code", () => {
    const dom = renderHoverContent({ kind: "markdown", value: "```typescript\nconst answer: number = 42\n```" }, "typescript");
    expect(dom.querySelector("pre code")?.textContent).toContain("const answer");
    expect(dom.querySelector(".tok-keyword, .tok-typeName, .tok-number")).not.toBeNull();
  });

  it("keeps unsupported code safe and visibly marked as plain text", () => {
    const dom = renderHoverContent({ language: "unknown-lsp-language", value: "a < b && c" }, "text");
    const code = dom.querySelector("pre code");
    expect(code?.classList.contains("plain-text")).toBe(true);
    expect(code?.textContent).toBe("a < b && c");
    expect(dom.querySelector("script")).toBeNull();
  });
});
