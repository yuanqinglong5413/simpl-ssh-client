import { useRef } from "react";
import { Columns, Rows, X } from "lucide-react";
import { TerminalPane } from "./TerminalPane";
import type { SplitDir, SplitNode } from "../types";

type Props = {
  layout: SplitNode;
  sessionId: string;
  /** 整棵树被替换时回调（分屏/调比例）。 */
  onChange: (next: SplitNode) => void;
  /** 根叶子被关闭（整个 Tab 没有面板了）→ 关闭 Tab。 */
  onCloseAll: () => void;
  /** 终端 WebSocket 断开 */
  onConnectionLost?: (sessionId: string) => void;
  startupCommand?: string;
  active?: boolean;
};

/**
 * 终端分屏容器：递归渲染 SplitNode 树。
 * 叶子可水平/垂直分屏（替换为 split 节点）、可关闭（父 split 坍缩成兄弟）。
 */
export function SplitView({
  layout,
  sessionId,
  onChange,
  onCloseAll,
  onConnectionLost,
  startupCommand,
  active = true,
}: Props) {
  return (
    <NodeView
      node={layout}
      sessionId={sessionId}
      onConnectionLost={onConnectionLost}
      startupCommand={startupCommand}
      active={active}
      onReplace={(n) => {
        if (n === null) onCloseAll();
        else onChange(n);
      }}
    />
  );
}

/** 替换某节点：传新节点替换自己，传 null 表示关闭自己（由父坍缩）。 */
type Replace = (next: SplitNode | null) => void;

function NodeView({
  node,
  sessionId,
  onReplace,
  onConnectionLost,
  startupCommand,
  active,
}: {
  node: SplitNode;
  sessionId: string;
  onReplace: Replace;
  onConnectionLost?: (sessionId: string) => void;
  startupCommand?: string;
  active: boolean;
}) {
  // 必须在所有分支前调用 Hook：叶子被替换成 split 时同一组件实例仍会保留。
  // 将 useRef 放在条件 return 之后会触发 React 的 Hook 顺序错误。
  const containerRef = useRef<HTMLDivElement>(null);
  if (node.kind === "leaf") {
    const split = (dir: SplitDir) =>
      onReplace({
        kind: "split",
        dir,
        ratio: 0.5,
        children: [
          node,
          { kind: "leaf", paneId: crypto.randomUUID(), sessionId: node.sessionId },
        ],
      });
    return (
      <div className="split-leaf">
        <TerminalPane
          sessionId={node.sessionId}
          paneId={node.paneId}
          onConnectionLost={onConnectionLost}
          startupCommand={startupCommand}
          active={active}
        />
        <div className="pane-actions">
          <button title="左右分屏" aria-label="左右分屏" onClick={() => split("horizontal")}>
            <Columns size={14} />
          </button>
          <button title="上下分屏" aria-label="上下分屏" onClick={() => split("vertical")}>
            <Rows size={14} />
          </button>
          <button
            title="关闭面板"
            aria-label="关闭终端面板"
            className="danger"
            onClick={() => onReplace(null)}
          >
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }

  // split 节点：把字段提为局部变量，避免闭包内对联合类型 node 的字段收窄失败
  const dir = node.dir;
  const ratio = node.ratio;
  const children = node.children;

  function startDrag(e: React.PointerEvent) {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const horizontal = dir === "horizontal";
    const move = (ev: PointerEvent) => {
      const pos = horizontal ? ev.clientX - rect.left : ev.clientY - rect.top;
      const size = horizontal ? rect.width : rect.height;
      let r = size > 0 ? pos / size : 0.5;
      r = Math.min(0.9, Math.max(0.1, r));
      onReplace({ kind: "split", dir, ratio: r, children });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const replaceChild = (idx: number, n: SplitNode | null) => {
    if (n === null) {
      // 关闭该子 → 坍缩成兄弟
      onReplace(children[1 - idx]);
      return;
    }
    const next = [children[0], children[1]] as [SplitNode, SplitNode];
    next[idx] = n;
    onReplace({ kind: "split", dir, ratio, children: next });
  };

  return (
    <div className={`split split-${dir}`} ref={containerRef}>
      <div className="split-child" style={{ flex: ratio }}>
        <NodeView
          node={children[0]}
          sessionId={sessionId}
          onConnectionLost={onConnectionLost}
          startupCommand={startupCommand}
          active={active}
          onReplace={(n) => replaceChild(0, n)}
        />
      </div>
      <div
        className="splitter"
        role="separator"
        aria-label={dir === "horizontal" ? "调整左右终端面板宽度" : "调整上下终端面板高度"}
        aria-orientation={dir === "horizontal" ? "vertical" : "horizontal"}
        aria-valuemin={10}
        aria-valuemax={90}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onPointerDown={startDrag}
        onDoubleClick={() => onReplace({ kind: "split", dir, ratio: 0.5, children })}
        onKeyDown={(event) => {
          const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -0.05 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 0.05 : 0;
          if (!delta) return;
          event.preventDefault();
          onReplace({ kind: "split", dir, ratio: Math.max(0.1, Math.min(0.9, ratio + delta)), children });
        }}
      />
      <div className="split-child" style={{ flex: 1 - ratio }}>
        <NodeView
          node={children[1]}
          sessionId={sessionId}
          onConnectionLost={onConnectionLost}
          startupCommand={startupCommand}
          active={active}
          onReplace={(n) => replaceChild(1, n)}
        />
      </div>
    </div>
  );
}
