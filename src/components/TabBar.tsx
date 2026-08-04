import { Activity, ChevronDown, FileCode, Folder, FolderTree, GitBranch, MoreHorizontal, PlugZap, Plus, SquareTerminal, Terminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Tab } from "../types";

type Props = {
  tabs: Tab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew?: () => void;
};

export function TabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onNew,
}: Props) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" }), [activeTabId]);
  function onTabKeyDown(event: React.KeyboardEvent, index: number) {
    if (!tabs.length) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      onActivate(tabs[(index + direction + tabs.length) % tabs.length].id);
    }
  }
  return (
    <div className="tabbar">
      <div className="tabbar-scroll" role="tablist" aria-label="工作区标签">
      {tabs.map((t, index) => (
        <div
          key={t.id}
          ref={t.id === activeTabId ? activeRef : undefined}
          role="tab"
          aria-selected={t.id === activeTabId}
          tabIndex={t.id === activeTabId ? 0 : -1}
          className={`tab ${t.id === activeTabId ? "active" : ""}`}
          onClick={() => onActivate(t.id)}
          onKeyDown={(event) => onTabKeyDown(event, index)}
          title={t.title}
        >
          {t.kind === "lsp-catalog" ? (
            <PlugZap size={13} />
          ) : t.kind === "project-workbench" ? (
            <FolderTree size={13} />
          ) : t.kind === "sftp" ? (
            <Folder size={13} />
          ) : t.kind === "monitor" ? (
            <Activity size={13} />
          ) : t.kind === "editor" ? (
            <FileCode size={13} />
          ) : t.kind === "git" ? (
            <GitBranch size={13} />
          ) : t.kind === "local-terminal" ? (
            <SquareTerminal size={13} />
          ) : (
            <Terminal size={13} />
          )}
          {t.agentPresetId && <span className={`agent-tab-status ${t.agentStatus ?? "running"}`} title={t.agentStatus === "failed" ? "Agent 启动失败" : t.agentStatus === "exited" ? "Agent 已退出" : "Agent 运行中"} aria-label={t.agentStatus === "failed" ? "Agent 启动失败" : t.agentStatus === "exited" ? "Agent 已退出" : "Agent 运行中"} />}
          <span className="tab-name">{t.title}</span>
          <button
            className="tab-x"
            aria-label={`关闭 ${t.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.id);
            }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      </div>
      <div className="tab-spacer" />
      {tabs.length > 0 && <div className="tab-overflow">
        <button className="tab-new" onClick={() => setOverflowOpen((value) => !value)} aria-label="查看所有标签" title="所有标签"><MoreHorizontal size={16} /></button>
        {overflowOpen && <div className="tab-overflow-menu">{tabs.map((tab) => <button key={tab.id} className={tab.id === activeTabId ? "active" : ""} onClick={() => { onActivate(tab.id); setOverflowOpen(false); }}><span>{tab.title}</span>{tab.id === activeTabId && <ChevronDown size={13} />}</button>)}</div>}
      </div>}
      {onNew && (
        <button className="tab-new" onClick={onNew} title="新建连接">
          <Plus size={16} />
        </button>
      )}
    </div>
  );
}
