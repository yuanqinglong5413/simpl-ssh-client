import { Activity, FileCode, Folder, GitBranch, Plus, SquareTerminal, Terminal, X } from "lucide-react";
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
  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === activeTabId ? "active" : ""}`}
          onClick={() => onActivate(t.id)}
          title={t.title}
        >
          {t.kind === "sftp" ? (
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
          <span className="tab-name">{t.title}</span>
          <button
            className="tab-x"
            aria-label="关闭标签"
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.id);
            }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="tab-spacer" />
      {onNew && (
        <button className="tab-new" onClick={onNew} title="新建连接">
          <Plus size={16} />
        </button>
      )}
    </div>
  );
}
