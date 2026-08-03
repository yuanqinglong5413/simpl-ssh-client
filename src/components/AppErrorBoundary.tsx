import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Copy, RefreshCw } from "lucide-react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * 最后的应用级保护：面板级错误边界无法覆盖的异常也必须给出可恢复界面，
 * 而不是让 Tauri WebView 留下一块没有解释的空白区域。
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("应用渲染失败", error, info.componentStack);
  }

  private copyDiagnostics = () => {
    const error = this.state.error;
    if (!error) return;
    const text = [
      "Simpl SSH 应用渲染诊断",
      `时间: ${new Date().toISOString()}`,
      `错误: ${error.name || "Error"}`,
      `信息: ${error.message || "未知错误"}`,
    ].join("\n");
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="app-fatal-error" role="alert">
        <AlertTriangle size={28} />
        <div>
          <h1>无法继续显示 Simpl SSH</h1>
          <p>{error.message || "应用渲染时发生未知错误。"}</p>
          <div className="app-fatal-actions">
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              <RefreshCw size={15} /> 重新加载应用
            </button>
            <button type="button" className="btn btn-ghost" onClick={this.copyDiagnostics}>
              <Copy size={15} /> 复制安全诊断
            </button>
          </div>
        </div>
      </main>
    );
  }
}
