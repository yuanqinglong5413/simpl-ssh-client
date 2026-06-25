import { Plus, Terminal, X } from "lucide-react";
import type { SessionInfo } from "../types";

type Props = {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onOpen: (s: SessionInfo) => void;
  onDisconnect: (id: string) => void;
  onNew: () => void;
};

export function Sidebar({
  sessions,
  activeSessionId,
  onOpen,
  onDisconnect,
  onNew,
}: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <Terminal size={13} strokeWidth={2.5} />
        </span>
        <span className="brand-name">
          simpl<b>-ssh</b>
        </span>
      </div>

      <div className="sidebar-label">连接</div>
      <div className="session-list">
        {sessions.length === 0 ? (
          <div className="sidebar-empty">还没有连接。点下方按钮新建一个。</div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${
                s.id === activeSessionId ? "active" : ""
              }`}
              onClick={() => onOpen(s)}
            >
              <span className="status-dot on" />
              <span className="session-meta">
                <div className="session-title">
                  {s.user}@{s.host}
                </div>
                <div className="session-sub">
                  {s.host}:{s.port}
                </div>
              </span>
              <button
                className="session-x"
                title="断开"
                onClick={(e) => {
                  e.stopPropagation();
                  onDisconnect(s.id);
                }}
              >
                <X size={13} />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="sidebar-foot">
        <button className="btn btn-ghost btn-block" onClick={onNew}>
          <Plus size={15} /> 新建连接
        </button>
      </div>
    </aside>
  );
}
