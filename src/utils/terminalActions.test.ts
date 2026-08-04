// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const clipboard = vi.hoisted(() => ({
  readText: vi.fn<() => Promise<string>>(),
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => clipboard);
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { installTerminalActions, terminalShortcutAction } from "./terminalActions";

type KeyHandler = (event: KeyboardEvent) => boolean;

function setup(selection = "") {
  let handler: KeyHandler | undefined;
  const term = {
    attachCustomKeyEventHandler: vi.fn((next: KeyHandler) => { handler = next; }),
    getSelection: vi.fn(() => selection),
    paste: vi.fn(),
  };
  const host = document.createElement("div");
  const cleanup = installTerminalActions({ term: term as never, host, tag: "test" });
  return { term, host, cleanup, dispatch: (type: string, init: KeyboardEventInit) => handler?.(new KeyboardEvent(type, init)) };
}

describe("terminal actions", () => {
  beforeEach(() => {
    clipboard.readText.mockReset().mockResolvedValue("粘贴内容");
    clipboard.writeText.mockReset().mockResolvedValue();
  });

  it("一次粘贴快捷键跨三个键盘阶段只写入一次", async () => {
    const view = setup();
    const init = { key: "v", metaKey: true, cancelable: true };
    expect(view.dispatch("keydown", init)).toBe(false);
    expect(view.dispatch("keypress", init)).toBe(false);
    expect(view.dispatch("keyup", init)).toBe(false);
    await Promise.resolve();
    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(view.term.paste).toHaveBeenCalledTimes(1);
    expect(view.term.paste).toHaveBeenCalledWith("粘贴内容");
    view.cleanup();
  });

  it("按键自动重复不会重复粘贴", async () => {
    const view = setup();
    view.dispatch("keydown", { key: "v", ctrlKey: true, shiftKey: true, repeat: false, cancelable: true });
    view.dispatch("keydown", { key: "v", ctrlKey: true, shiftKey: true, repeat: true, cancelable: true });
    await Promise.resolve();
    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(view.term.paste).toHaveBeenCalledTimes(1);
    view.cleanup();
  });

  it("复制与导出组合键只在声明的平台形式下匹配", () => {
    expect(terminalShortcutAction({ key: "c", metaKey: true, ctrlKey: false, shiftKey: false })).toBe("copy");
    expect(terminalShortcutAction({ key: "c", metaKey: false, ctrlKey: true, shiftKey: true })).toBe("copy");
    expect(terminalShortcutAction({ key: "c", metaKey: false, ctrlKey: true, shiftKey: false })).toBeNull();
  });

  it("有选择内容时复制只执行一次，没有选择时保留 Ctrl+C", async () => {
    const selected = setup("selected");
    selected.dispatch("keydown", { key: "c", metaKey: true, cancelable: true });
    selected.dispatch("keyup", { key: "c", metaKey: true, cancelable: true });
    await Promise.resolve();
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    selected.cleanup();

    const empty = setup();
    expect(empty.dispatch("keydown", { key: "c", ctrlKey: true })).toBe(true);
    empty.cleanup();
  });

  it("卸载后晚到的剪贴板结果不会写入已销毁终端", async () => {
    let resolveClipboard!: (value: string) => void;
    clipboard.readText.mockReturnValue(new Promise((resolve) => { resolveClipboard = resolve; }));
    const view = setup();
    view.dispatch("keydown", { key: "v", metaKey: true, cancelable: true });
    view.cleanup();
    resolveClipboard("late");
    await Promise.resolve();
    expect(view.term.paste).not.toHaveBeenCalled();
  });
});
