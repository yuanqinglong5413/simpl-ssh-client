import { describe, expect, it } from "vitest";
import { resolveAppShortcut, type ShortcutEventLike } from "./appShortcuts";

const key = (value: string, extra: Partial<ShortcutEventLike> = {}): ShortcutEventLike => ({ key: value, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...extra });

describe("application shortcut routing", () => {
  it("only captures the command palette in a terminal", () => {
    expect(resolveAppShortcut(key("p", { shiftKey: true }), "terminal", "Win32")).toBe("commandPalette");
    for (const value of ["c", "w", "r", "a", "z", "Tab", "F12"]) expect(resolveAppShortcut(key(value), "terminal", "Win32")).toBeNull();
  });
  it("uses the platform modifier", () => {
    expect(resolveAppShortcut(key("p", { shiftKey: true }), "terminal", "MacIntel")).toBeNull();
    expect(resolveAppShortcut(key("p", { ctrlKey: false, metaKey: true, shiftKey: true }), "terminal", "MacIntel")).toBe("commandPalette");
  });
  it("keeps workbench shortcuts outside interactive inputs", () => {
    expect(resolveAppShortcut(key("w"), "chrome", "Win32")).toBe("closeTab");
    expect(resolveAppShortcut(key("Tab", { shiftKey: true }), "editor", "Win32")).toBe("prevTab");
    expect(resolveAppShortcut(key("w"), "editable", "Win32")).toBeNull();
  });
});
