import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

type Props = { projectName: string; children: ReactNode };
type State = { error: Error | null };

/** 项目工作台不应因单个项目状态损坏而留下空白画布。 */
export class ProjectWorkbenchBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("项目工作台渲染失败", error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (previous.projectName !== this.props.projectName && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <section className="project-workbench-error" role="alert"><AlertTriangle size={22} /><div><h2>无法打开 {this.props.projectName} 工作台</h2><p>{this.state.error.message || "工作台初始化时发生未知错误。"}</p><button className="btn btn-primary" onClick={() => this.setState({ error: null })}><RefreshCw size={14} /> 重新加载工作台</button></div></section>;
  }
}
