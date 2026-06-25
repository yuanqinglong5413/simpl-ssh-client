import { Plus, Server, Terminal, Trash2 } from "lucide-react";
import type { ConnectionProfile } from "../types";

type Props = {
  profiles: ConnectionProfile[];
  onConnectProfile: (id: string) => void;
  onDeleteProfile: (id: string) => void;
  onNew: () => void;
};

export function Sidebar({
  profiles,
  onConnectProfile,
  onDeleteProfile,
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

      <div className="session-list">
        <div className="sidebar-label">已保存的连接 ({profiles.length})</div>
        {profiles.length === 0 ? (
          <div className="sidebar-empty">
            还没有保存的连接。
            <br />
            点下方"新建连接"，勾选保存即可收藏到这里。
          </div>
        ) : (
          profiles.map((p) => (
            <div
              key={p.id}
              className="session-item"
              onClick={() => onConnectProfile(p.id)}
              title="点击连接"
            >
              <Server
                size={13}
                style={{ color: "var(--accent)", flexShrink: 0 }}
              />
              <span className="session-meta">
                <div className="session-title">{p.name}</div>
                <div className="session-sub">
                  {p.user}@{p.host}:{p.port}
                </div>
              </span>
              <button
                className="session-x"
                title="删除"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteProfile(p.id);
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="sidebar-foot">
        <button className="btn btn-primary btn-block" onClick={onNew}>
          <Plus size={15} /> 新建连接
        </button>
      </div>
    </aside>
  );
}
