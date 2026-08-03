import type { Terminal } from "@xterm/xterm";

/** xterm.write 是异步的；串行、按帧写入避免高输出终端挤爆渲染队列。 */
export class TerminalWriteQueue {
  private queue: Uint8Array[] = [];
  private writing = false;
  private disposed = false;
  private queuedBytes = 0;
  private drainCallbacks: Array<() => void> = [];

  constructor(private readonly terminal: Terminal, private readonly onBusy?: (busy: boolean) => void) {}

  enqueue(chunks: Uint8Array[]): void {
    for (const chunk of chunks) {
      if (!chunk.length) continue;
      const last = this.queue[this.queue.length - 1];
      if (last && last.length + chunk.length <= 64 * 1024) {
        const merged = new Uint8Array(last.length + chunk.length);
        merged.set(last); merged.set(chunk, last.length);
        this.queue[this.queue.length - 1] = merged;
      } else this.queue.push(chunk);
      this.queuedBytes += chunk.length;
    }
    this.onBusy?.(this.queuedBytes > 256 * 1024);
    this.drain();
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.writing = false;
    // A disposed terminal must never invoke callbacks against a detached xterm.
    this.drainCallbacks = [];
    this.onBusy?.(false);
  }

  /** 当前已入队的数据全部由 xterm 解析后执行一次；用于 TUI 首屏的最终重绘。 */
  afterDrained(callback: () => void): void {
    if (this.disposed) return;
    if (!this.writing && this.queue.length === 0) {
      callback();
      return;
    }
    this.drainCallbacks.push(callback);
  }

  private drain(): void {
    if (this.writing || this.disposed || !this.queue.length) return;
    this.writing = true;
    requestAnimationFrame(() => {
      if (this.disposed) {
        this.writing = false;
        return;
      }
      const chunk = this.queue.shift();
      if (!chunk) { this.writing = false; return; }
      this.queuedBytes -= chunk.length;
      this.terminal.write(chunk, () => {
        this.writing = false;
        if (this.disposed) return;
        this.onBusy?.(this.queuedBytes > 256 * 1024);
        if (this.queue.length === 0) {
          const callbacks = this.drainCallbacks.splice(0);
          for (const callback of callbacks) callback();
        }
        this.drain();
      });
    });
  }
}
