import { createLogHighlighter } from "./logHighlight";

export type TerminalOutputMode = "smart" | "off";
export type OutputGuardResult = {
  chunks: Uint8Array[];
  enteredTui: boolean;
  /** 已检测到普通 ANSI/控制流，后续不再尝试文本改写。 */
  rawPassthrough: boolean;
};

const encoder = new TextEncoder();
const TUI_ENTER = /\x1b\[\?(?:47|1047|1049)h/;
const SCREEN_PAINT = /\x1b\[(?:[0-9;]*[HfJK]|\?(?:25|1000|1002|1003|1006)[hl])/g;

/**
 * 将 PTY 输出安全地送入 xterm。
 *
 * 终端控制序列和 UTF-8 字符都可能跨 WebSocket 分片，因而不能对每个
 * data event 直接 TextDecoder + 正则替换。只要发现控制流，就固定原样透传；
 * 检测到备用屏幕后永久锁定原始输出模式；这不会改变当前渲染器。
 */
export class TerminalOutputGuard {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly highlighter = createLogHighlighter();
  private scanTail = "";
  private rawLocked = false;
  private tuiLocked = false;
  private paintEvents: number[] = [];

  constructor(private mode: TerminalOutputMode) {}

  setMode(mode: TerminalOutputMode): void {
    this.mode = mode;
  }

  get isTui(): boolean {
    return this.tuiLocked;
  }

  process(input: ArrayBuffer | string): OutputGuardResult {
    const raw = typeof input === "string" ? encoder.encode(input) : new Uint8Array(input);
    const controlView = bytesToControlString(raw);
    const combined = this.scanTail + controlView;
    const tailLength = this.scanTail.length;
    SCREEN_PAINT.lastIndex = 0;
    // 只统计本次新字节结束的序列；scanTail 只是为了识别跨分片序列，
    // 不应把上一次已经计过的擦除/定位再次累加。
    const paintCount = Array.from(combined.matchAll(SCREEN_PAINT)).filter((match) =>
      (match.index ?? 0) + match[0].length > tailLength
    ).length;
    const now = Date.now();
    if (paintCount) this.paintEvents.push(...Array(paintCount).fill(now));
    this.paintEvents = this.paintEvents.filter((at) => now - at <= 250);
    const enteredTui = !this.tuiLocked && (TUI_ENTER.test(combined) || this.paintEvents.length >= 3);
    this.scanTail = combined.slice(-16);

    const hasControl = containsTerminalControl(raw);
    if (enteredTui) this.tuiLocked = true;

    // 同一个 payload 内一旦存在控制流，整段都必须原样送到 xterm；否则
    // `\x1b[` 被高亮器拆开后会使 TUI 光标寻址、擦除和颜色状态损坏。
    if (this.tuiLocked || this.rawLocked || hasControl || this.mode === "off") {
      if (hasControl) this.rawLocked = true;
      return {
        chunks: raw.length ? [raw] : [],
        enteredTui,
        rawPassthrough: true,
      };
    }

    // 只美化完整 UTF-8 payload。分片切到字符中间时，立即锁定原始通道；
    // 这样 xterm 自己的 UTF-8 parser 可以看到完整原字节，而不会得到 U+FFFD。
    try {
      const decoded = this.decoder.decode(raw);
      const highlighted = decoded ? this.highlighter.transform(decoded) : new Uint8Array();
      return { chunks: highlighted.length ? [highlighted] : [], enteredTui: false, rawPassthrough: false };
    } catch {
      this.rawLocked = true;
      return { chunks: raw.length ? [raw] : [], enteredTui: false, rawPassthrough: true };
    }
  }

  flush(): Uint8Array[] {
    return [];
  }
}

function bytesToControlString(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += String.fromCharCode(byte);
  return output;
}

function containsTerminalControl(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    // Tab/LF/CR 是普通日志允许的空白；其余 C0 均可能改变终端状态。
    if ((byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127) return true;
  }
  return false;
}
