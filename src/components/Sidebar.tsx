import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Pencil,
  Plus,
  Server,
  Terminal,
  Trash2,
} from "lucide-react";
import type { ConnectionProfile, ProfileGroup } from "../types";

type Props = {
  profiles: ConnectionProfile[];
  groups: ProfileGroup[];
  onConnectProfile: (id: string) => void;
  onEditProfile: (profile: ConnectionProfile) => void;
  onDeleteProfile: (id: string) => void;
  onCreateGroup: (name: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onDeleteGroup: (id: string) => void;
  onNew: () => void;
};

/** 侧栏连接库：按分组树形展示，支持折叠/新建分组。 */
export function Sidebar({
  profiles,
  groups,
  onConnectProfile,
  onEditProfile,
  onDeleteProfile,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onNew,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => a.order - b.order),
    [groups]
  );

  const ungrouped = profiles.filter((p) => !p.group_id);
  const byGroup = (gid: string) => profiles.filter((p) => p.group_id === gid);

  function toggleGroup(id: string) {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function handleCreateGroup() {
    const name = window.prompt("分组名称");
    if (name?.trim()) onCreateGroup(name.trim());
  }

  function handleRenameGroup(g: ProfileGroup, e: React.MouseEvent) {
    e.stopPropagation();
    const name = window.prompt("重命名分组", g.name);
    if (name?.trim() && name.trim() !== g.name) onRenameGroup(g.id, name.trim());
  }

  function handleDeleteGroup(g: ProfileGroup, e: React.MouseEvent) {
    e.stopPropagation();
    if (window.confirm(`删除分组「${g.name}」？组内连接将移至未分组。`)) {
      onDeleteGroup(g.id);
    }
  }

  function renderProfile(p: ConnectionProfile) {
    return (
      <div
        key={p.id}
        className="session-item"
        onClick={() => onConnectProfile(p.id)}
        title="点击连接"
      >
        <Server size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
        <span className="session-meta">
          <div className="session-title">{p.name}</div>
          <div className="session-sub">
            {p.auth_method === "private_key" ? "🔑 " : ""}
            {p.jump_profile_id ? "↪ " : ""}
            {p.user}@{p.host}:{p.port}
          </div>
        </span>
        <button
          className="session-x"
          title="编辑"
          onClick={(e) => {
            e.stopPropagation();
            onEditProfile(p);
          }}
        >
          <Pencil size={13} />
        </button>
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
    );
  }

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
        <div className="sidebar-label-row">
          <span className="sidebar-label">
            已保存的连接 ({profiles.length})
          </span>
          <button
            className="sidebar-icon-btn"
            title="新建分组"
            onClick={handleCreateGroup}
          >
            <FolderPlus size={14} />
          </button>
        </div>

        {profiles.length === 0 ? (
          <div className="sidebar-empty">
            还没有保存的连接。
            <br />
            点下方"新建连接"，勾选保存即可收藏到这里。
          </div>
        ) : (
          <>
            {sortedGroups.map((g) => {
              const items = byGroup(g.id);
              if (items.length === 0) return null;
              const isCollapsed = collapsed[g.id];
              return (
                <div key={g.id} className="profile-group">
                  <div
                    className="profile-group-head"
                    onClick={() => toggleGroup(g.id)}
                  >
                    {isCollapsed ? (
                      <ChevronRight size={14} />
                    ) : (
                      <ChevronDown size={14} />
                    )}
                    <span className="profile-group-name">{g.name}</span>
                    <span className="profile-group-count">{items.length}</span>
                    <button
                      className="session-x group-action"
                      title="重命名分组"
                      onClick={(e) => handleRenameGroup(g, e)}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      className="session-x group-action"
                      title="删除分组"
                      onClick={(e) => handleDeleteGroup(g, e)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  {!isCollapsed && (
                    <div className="profile-group-items">
                      {items.map(renderProfile)}
                    </div>
                  )}
                </div>
              );
            })}

            {ungrouped.length > 0 && (
              <div className="profile-group">
                {sortedGroups.some((g) => byGroup(g.id).length > 0) && (
                  <div className="profile-group-head static">
                    <span className="profile-group-name">未分组</span>
                    <span className="profile-group-count">
                      {ungrouped.length}
                    </span>
                  </div>
                )}
                <div className="profile-group-items">
                  {ungrouped.map(renderProfile)}
                </div>
              </div>
            )}
          </>
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
