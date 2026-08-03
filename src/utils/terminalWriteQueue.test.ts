import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalWriteQueue } from "./terminalWriteQueue";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

describe("TerminalWriteQueue", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("merges small output while preserving FIFO bytes and backpressure callbacks", () => {
    const writes: Uint8Array[] = [];
    const busy: boolean[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    const terminal = {
      write(data: Uint8Array, callback?: () => void) {
        writes.push(new Uint8Array(data));
        callback?.();
      },
    } as never;
    const queue = new TerminalWriteQueue(terminal, (value) => busy.push(value));
    queue.enqueue([encoder.encode("第一段"), encoder.encode(" + second + "), encoder.encode("末尾")]);
    expect(decoder.decode(concat(writes))).toBe("第一段 + second + 末尾");
    expect(busy[busy.length - 1]).toBe(false);
    queue.dispose();
  });

  it("runs a queued redraw only after xterm has parsed all pending output", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    let completeWrite: (() => void) | undefined;
    const terminal = {
      write(_data: Uint8Array, callback?: () => void) { completeWrite = callback; },
    } as never;
    const queue = new TerminalWriteQueue(terminal);
    const redraw = vi.fn();
    queue.enqueue([encoder.encode("TUI")]);
    queue.afterDrained(redraw);
    expect(redraw).not.toHaveBeenCalled();
    completeWrite?.();
    expect(redraw).toHaveBeenCalledTimes(1);
    queue.dispose();
  });

  it("does not call redraw callbacks after the terminal is disposed", () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 0;
    });
    const write = vi.fn();
    const terminal = { write } as never;
    const queue = new TerminalWriteQueue(terminal);
    const redraw = vi.fn();
    queue.enqueue([encoder.encode("pending")]);
    queue.afterDrained(redraw);
    queue.dispose();
    frame?.(0);
    expect(redraw).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((length, chunk) => length + chunk.length, 0);
  const value = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.length;
  }
  return value;
}
