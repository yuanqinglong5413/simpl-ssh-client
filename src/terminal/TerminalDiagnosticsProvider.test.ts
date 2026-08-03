import { describe, expect, it } from "vitest";
import { formatTerminalDiagnostics } from "./TerminalDiagnosticsProvider";

describe("formatTerminalDiagnostics", () => {
  it("contains runtime facts without terminal output or connection identity", () => {
    const text = formatTerminalDiagnostics({ paneId: "pane", transport: "SSH", renderer: "canvas", rendererReason: "WebGL 上下文丢失", tuiRawMode: true, outputBusy: false, cols: 120, rows: 40, layoutStable: true });
    expect(text).toContain("Renderer: canvas");
    expect(text).toContain("120 cols × 40 rows");
    expect(text).not.toContain("host");
  });
});
