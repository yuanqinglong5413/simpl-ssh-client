// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isPrimaryHoverModifier } from "./hoverModifier";

describe("LSP hover modifier", () => {
  it("requires Cmd on macOS", () => {
    expect(isPrimaryHoverModifier({ metaKey: false, ctrlKey: false }, "MacIntel")).toBe(false);
    expect(isPrimaryHoverModifier({ metaKey: true, ctrlKey: false }, "MacIntel")).toBe(true);
    expect(isPrimaryHoverModifier({ metaKey: false, ctrlKey: true }, "MacIntel")).toBe(false);
  });

  it("requires Ctrl on Windows and Linux", () => {
    expect(isPrimaryHoverModifier({ metaKey: false, ctrlKey: true }, "Win32")).toBe(true);
    expect(isPrimaryHoverModifier({ metaKey: true, ctrlKey: false }, "Linux x86_64")).toBe(false);
  });
});
