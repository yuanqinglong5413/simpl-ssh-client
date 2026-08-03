import type { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";

export type TerminalRendererPreference = "auto" | "canvas" | "webgl";
export type TerminalRenderStatus = "webgl" | "canvas";
export type TerminalRendererState = {
  preference: TerminalRendererPreference;
  effective: TerminalRenderStatus;
  locked: boolean;
  reason?: string;
};

/** 管理 WebGL 生命周期，真正的渲染器错误才回退到 xterm 自带 Canvas renderer。 */
export class TerminalRenderer {
  private webgl: WebglAddon | null = null;
  private preference: TerminalRendererPreference;
  private visible = true;
  /** 用户只对当前标签选择 Canvas；不等同于 WebGL 错误回退。 */
  private manualCanvas = false;
  /** 同一标签发生真实渲染故障后锁定，避免设置刷新时再次启用坏掉的 WebGL。 */
  private fallbackLocked = false;
  private disposed = false;

  constructor(
    private readonly terminal: Terminal,
    preference: TerminalRendererPreference,
    private readonly onStatus: (state: TerminalRendererState) => void,
    visible = true,
  ) {
    this.preference = preference;
    this.visible = visible;
    this.applyPreference(preference);
  }

  applyPreference(preference: TerminalRendererPreference): void {
    if (this.disposed) return;
    this.preference = preference;
    if (preference !== "canvas") this.manualCanvas = false;
    if (preference === "canvas") {
      this.manualCanvas = true;
      this.releaseWebgl("已选择 Canvas");
      return;
    }
    if (this.manualCanvas || this.fallbackLocked) return;
    if (!this.visible || this.webgl) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => this.fallback("WebGL 上下文丢失"));
      this.terminal.loadAddon(addon);
      this.webgl = addon;
      this.onStatus({ preference: this.preference, effective: "webgl", locked: false });
    } catch {
      this.fallback("WebGL 不可用");
    }
  }

  setVisible(visible: boolean): void {
    if (this.disposed) return;
    this.visible = visible;
    if (!visible && this.webgl) {
      // Hidden panes keep xterm's buffer but release GPU resources. Avoid a
      // refresh here: only the active pane should repaint during tab changes.
      this.webgl.dispose();
      this.webgl = null;
      this.onStatus({ preference: this.preference, effective: "canvas", locked: this.manualCanvas || this.fallbackLocked, reason: "后台标签已释放 WebGL" });
    } else if (visible) this.applyPreference(this.preference);
  }

  /** 仅当前终端标签降级，不修改全局渲染偏好。 */
  forceCanvas(): void {
    if (this.disposed) return;
    this.manualCanvas = true;
    this.releaseWebgl("用户为当前标签选择 Canvas");
  }

  redraw(): void {
    if (this.disposed) return;
    try {
      this.webgl?.clearTextureAtlas();
    } catch {
      this.fallback("WebGL 字形缓存异常");
    }
    this.refreshAll();
  }

  dispose(): void {
    this.disposed = true;
    this.webgl?.dispose();
    this.webgl = null;
  }

  private fallback(reason: string, lock = true): void {
    if (this.disposed) return;
    if (lock) this.fallbackLocked = true;
    this.releaseWebgl(reason);
  }

  private releaseWebgl(reason: string, refresh = true): void {
    this.webgl?.dispose();
    this.webgl = null;
    this.onStatus({ preference: this.preference, effective: "canvas", locked: this.manualCanvas || this.fallbackLocked, reason });
    if (!refresh) return;
    this.refreshAll();
  }

  private refreshAll(): void {
    requestAnimationFrame(() => {
      if (!this.disposed) this.terminal.refresh(0, Math.max(0, this.terminal.rows - 1));
    });
  }
}
