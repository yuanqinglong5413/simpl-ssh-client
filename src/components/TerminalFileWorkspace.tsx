import { Columns2, Folder, Rows2, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SftpPane } from "./SftpPane";
import { SplitView } from "./SplitView";
import type { ConnectionEnvironment, SplitNode, TerminalWorkspaceView } from "../types";

type Props = {
  layout: SplitNode;
  sessionId: string;
  initialPath?: string;
  environment?: ConnectionEnvironment | null;
  view: TerminalWorkspaceView;
  sftpOpened: boolean;
  active: boolean;
  startupCommand?: string;
  onViewChange: (view: TerminalWorkspaceView) => void;
  onLayoutChange: (layout: SplitNode) => void;
  onCloseAll: () => void;
  onConnectionLost?: (sessionId: string) => void;
  onFileOpen: (path: string) => void;
  splitDirection: "horizontal" | "vertical";
  splitRatio: number;
  onSplitChange: (direction: "horizontal" | "vertical", ratio: number) => void;
};

/**
 * 一个 SSH 标签的终端与文件工作区。
 *
 * 两个面板在首次打开文件后都会保持挂载：切换到文件不会终止 PTY，也不会丢失
 * xterm 的滚动缓冲；“分屏”仅改变布局，不会创建第二个 SFTP 标签。
 */
export function TerminalFileWorkspace({
  layout,
  sessionId,
  initialPath,
  environment,
  view,
  sftpOpened,
  active,
  startupCommand,
  onViewChange,
  onLayoutChange,
  onCloseAll,
  onConnectionLost,
  onFileOpen,
  splitDirection,
  splitRatio,
  onSplitChange,
}: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const target = contentRef.current;
    if (!target) return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 720));
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  // 过窄时不把终端压到不可用列数。保留用户的 split 偏好，但本次显示退化为终端；
  // 用户仍可显式切到“文件”，宽度恢复后自动回到原分屏。
  const effectiveView = compact && view === "split" ? "terminal" : view;
  const filesVisible = effectiveView !== "terminal";
  const terminalVisible = effectiveView !== "files";

  return (
    <div className={`terminal-file-workspace terminal-file-workspace-${effectiveView} terminal-file-direction-${splitDirection}`}>
      <div className="terminal-file-switcher" role="tablist" aria-label="终端和文件视图">
        <button type="button" role="tab" aria-selected={view === "terminal"} className={view === "terminal" ? "active" : ""} onClick={() => onViewChange("terminal")}>
          <Terminal size={14} /> 终端
        </button>
        <button type="button" role="tab" aria-selected={view === "files"} className={view === "files" ? "active" : ""} onClick={() => onViewChange("files")}>
          <Folder size={14} /> 文件
        </button>
        <button type="button" role="tab" aria-selected={effectiveView === "split"} className={effectiveView === "split" ? "active" : ""} onClick={() => onViewChange("split")} disabled={compact} title={compact ? "当前宽度不足，已暂时显示终端" : "同时显示终端和文件"}>
          <Columns2 size={14} /> 分屏
        </button>
        {compact && view === "split" && <span className="terminal-file-compact-note" role="status">宽度不足，分屏已暂时收起</span>}
        {effectiveView === "split" && <button type="button" title={splitDirection === "horizontal" ? "改为上下分屏" : "改为左右分屏"} aria-label={splitDirection === "horizontal" ? "改为上下分屏" : "改为左右分屏"} onClick={() => onSplitChange(splitDirection === "horizontal" ? "vertical" : "horizontal", splitRatio)}>{splitDirection === "horizontal" ? <Rows2 size={14} /> : <Columns2 size={14} />}</button>}
      </div>
      <div className="terminal-file-content" ref={contentRef}>
        <div className={`terminal-file-terminal ${terminalVisible ? "visible" : "hidden"}`} aria-hidden={!terminalVisible} style={effectiveView === "split" ? { flex: splitRatio } : undefined}>
          <SplitView
            layout={layout}
            sessionId={sessionId}
            onChange={onLayoutChange}
            onCloseAll={onCloseAll}
            onConnectionLost={onConnectionLost}
            startupCommand={startupCommand}
            active={active && terminalVisible}
          />
        </div>
        {effectiveView === "split" && <div className="terminal-file-divider" role="separator" aria-orientation={splitDirection === "horizontal" ? "vertical" : "horizontal"} tabIndex={0} onDoubleClick={() => onSplitChange(splitDirection, 0.58)} onPointerDown={(event) => { event.preventDefault(); const content = contentRef.current; if (!content) return; const rect = content.getBoundingClientRect(); const move = (next: PointerEvent) => { const raw = splitDirection === "horizontal" ? (next.clientX - rect.left) / rect.width : (next.clientY - rect.top) / rect.height; onSplitChange(splitDirection, Math.max(0.25, Math.min(0.75, raw))); }; const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); }} onKeyDown={(event) => { const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -0.05 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 0.05 : 0; if (delta) { event.preventDefault(); onSplitChange(splitDirection, Math.max(0.25, Math.min(0.75, splitRatio + delta))); } }} />}
        {sftpOpened && (
          <div className={`terminal-file-sftp ${filesVisible ? "visible" : "hidden"}`} aria-hidden={!filesVisible} style={effectiveView === "split" ? { flex: 1 - splitRatio } : undefined}>
            <SftpPane
              sessionId={sessionId}
              initialPath={initialPath}
              environment={environment}
              active={active && filesVisible}
              onFileOpen={onFileOpen}
            />
          </div>
        )}
      </div>
    </div>
  );
}
