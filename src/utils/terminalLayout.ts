import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

type Options = {
  host: HTMLElement;
  terminal: Terminal;
  fitAddon: FitAddon;
  isActive: () => boolean;
  /** fit 完成后通知 PTY；调用方负责自己的防抖。 */
  onLayout?: () => void;
  onLayoutError?: (reason: string) => void;
};

/**
 * 协调 xterm 的首次和后续布局。
 *
 * `Terminal.open()` 后的第一个同步 `fit()` 很容易发生在 CSS Grid、字体或
 * Canvas 尺寸仍未稳定的阶段。普通 shell 之后还会重绘，问题不明显；全屏 TUI
 * 会立即根据错误行列数绘制备用屏，直到窗口 resize 才恢复。这里统一等到两个
 * 动画帧和字体就绪后再测量，并把首个 PTY 尺寸延后到该阶段之后。
 */
export class TerminalLayout {
  private frame: number | null = null;
  private redrawFrame: number | null = null;
  private settleTimer: number | null = null;
  private disposed = false;
  private readonly observer: ResizeObserver;
  private readonly onWindowResize = () => this.schedule();
  private readonly onTransitionEnd = (event: TransitionEvent) => {
    // 任务抽屉由工作区的同级元素承载；其宽度动画不会成为 host 的祖先事件。
    // 某些 WebView 会在动画最后一帧遗漏 ResizeObserver 回调，导致 xterm 仍按旧
    // 列数绘制，留下右侧空白。动画真正结束时再精确 fit 一次。
    if (event.propertyName === "width" && event.target instanceof HTMLElement && event.target.classList.contains("task-drawer")) {
      this.schedule();
    }
  };

  constructor(private readonly options: Options) {
    this.observer = new ResizeObserver(() => {
      this.schedule();
      this.scheduleSettledLayout();
    });
    this.observer.observe(options.host);
    window.addEventListener("resize", this.onWindowResize);
    document.addEventListener("transitionend", this.onTransitionEnd, true);
  }

  /** 等待布局与 WebFont 稳定；在返回前终端行列数已经可安全传给 PTY。 */
  async settleInitialLayout(): Promise<boolean> {
    await nextFrame();
    await nextFrame();
    if (this.disposed) return false;

    // 首次使用 IBM Plex Mono 时字体可能刚开始加载。等待它最多一小段时间，
    // 防止离线字体或浏览器异常使创建终端永久挂起。
    const fontsReady = document.fonts?.ready;
    if (fontsReady) await Promise.race([fontsReady, delay(350)]);
    if (this.disposed) return false;

    await nextFrame();
    let laidOut = this.layoutNow();
    // FontFaceSet.resolve 后 Canvas 的字形尺寸有时会在下一帧才提交，补一次。
    await nextFrame();
    laidOut = this.layoutNow() || laidOut;
    return laidOut && this.options.terminal.cols > 1 && this.options.terminal.rows > 1;
  }

  schedule(): void {
    if (this.disposed || this.frame !== null) return;
    // 两帧可跨过 React 提交和 CSS Grid/抽屉 transition 的首轮计算。
    this.frame = requestAnimationFrame(() => {
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.layoutNow();
      });
    });
  }

  /**
   * 对连续尺寸变化（侧栏/任务抽屉的 transition）做一次尾帧校正。
   * 这不是定时轮询：仅在 ResizeObserver 报告尺寸变化后触发，并会被后续变化重置。
   */
  private scheduleSettledLayout(): void {
    if (this.disposed) return;
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      this.schedule();
    }, 220);
  }

  layoutNow(): boolean {
    if (this.disposed || !this.options.isActive()) return false;
    const rect = this.options.host.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    try {
      // xterm 不会自动得知 WebFont 已加载。重新提交当前字体选项会刷新字符尺寸，
      // 随后的 fit 才能得到真正的 cols/rows。
      this.options.terminal.options.fontFamily = this.options.terminal.options.fontFamily;
      this.options.fitAddon.fit();
      this.options.onLayout?.();
      if (this.redrawFrame !== null) cancelAnimationFrame(this.redrawFrame);
      this.redrawFrame = requestAnimationFrame(() => {
        this.redrawFrame = null;
        if (!this.disposed) {
          this.options.terminal.refresh(0, Math.max(0, this.options.terminal.rows - 1));
        }
      });
      return true;
    } catch (error) {
      this.options.onLayoutError?.(error instanceof Error ? error.message : String(error));
      // 隐藏标签或销毁阶段的 xterm 会抛错；下一次可见布局会补偿。
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.observer.disconnect();
    window.removeEventListener("resize", this.onWindowResize);
    document.removeEventListener("transitionend", this.onTransitionEnd, true);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.redrawFrame !== null) cancelAnimationFrame(this.redrawFrame);
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
