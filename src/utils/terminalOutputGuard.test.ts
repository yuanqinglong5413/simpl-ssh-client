import { describe, expect, it } from "vitest";
import { TerminalOutputGuard } from "./terminalOutputGuard";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ESC = String.fromCharCode(0x1b);
const LF = String.fromCharCode(10);

function join(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

describe("TerminalOutputGuard", () => {
  it("keeps split UTF-8 and box drawing bytes intact", () => {
    const sourceText = `中文 ┌── Agent ──┐${LF}`;
    const source = encoder.encode(sourceText);
    const guard = new TerminalOutputGuard("smart");
    const written = [
      ...guard.process(source.slice(0, 2).buffer).chunks,
      ...guard.process(source.slice(2, 9).buffer).chunks,
      ...guard.process(source.slice(9).buffer).chunks,
    ];
    expect(decoder.decode(join(written))).toBe(sourceText);
    expect(decoder.decode(join(written))).not.toContain("�");
  });

  it("detects an alternate screen sequence across WebSocket frames without rewriting it", () => {
    const guard = new TerminalOutputGuard("smart");
    const first = encoder.encode(`${ESC}[?10`);
    const second = encoder.encode(`49h${ESC}[2JClaude Code`);
    const one = guard.process(first.buffer);
    const two = guard.process(second.buffer);
    expect(one.enteredTui).toBe(false);
    expect(two.enteredTui).toBe(true);
    expect(decoder.decode(join([...one.chunks, ...two.chunks]))).toBe(`${ESC}[?1049h${ESC}[2JClaude Code`);
  });

  it("passes ANSI 16-color and truecolor sequences through byte-for-byte", () => {
    const guard = new TerminalOutputGuard("smart");
    const source = encoder.encode(`${ESC}[31mred${ESC}[0m ${ESC}[38;2;90;160;255mtruecolor${ESC}[0m`);
    const first = guard.process(source.slice(0, 11).buffer);
    const second = guard.process(source.slice(11).buffer);
    expect(join([...first.chunks, ...second.chunks])).toEqual(source);
    expect(first.rawPassthrough || second.rawPassthrough).toBe(true);
  });

  it("locks Canvas-compatible TUI mode after rapid cursor and erase control flow", () => {
    const guard = new TerminalOutputGuard("smart");
    guard.process(`${ESC}[1;1H${ESC}[2J`);
    const second = guard.process(`${ESC}[2;1H${ESC}[K`);
    const result = guard.process(`${ESC}[3;1H${ESC}[K`);
    expect(second.enteredTui || result.enteredTui).toBe(true);
    expect(guard.isTui).toBe(true);
    expect(result.rawPassthrough).toBe(true);
  });
});
