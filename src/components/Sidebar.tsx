import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  FolderTree,
  Pencil,
  Plus,
  Search,
  Server,
  Star,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import type { ConnectionProfile, ProfileGroup } from "../types";
import { ConfirmDialog, TextInputDialog } from "./DialogPrimitives";

type Props = {
  profiles: ConnectionProfile[];
  groups: ProfileGroup[];
  /** 当前有活动会话的配置，用于让连接状态一眼可见。 */
  activeProfileIds?: string[];
  connectingProfileIds?: string[];
  /** 最近一次连接失败原因；成功连接会由上层清除。 */
  connectionErrors?: Record<string, string>;
  onConnectProfile: (id: string) => void;
  onEditProfile: (profile: ConnectionProfile) => void;
  onDeleteProfile: (id: string) => void;
  onCreateGroup: (name: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onDeleteGroup: (id: string) => void;
  onNew: () => void;
  onImportSshConfig: () => void;
  onModeChange: (mode: "ssh" | "project") => void;
};

const environmentLabel: Record<NonNullable<ConnectionProfile["environment"]>, string> = {
  production: "生产",
  staging: "预发",
  testing: "测试",
  local: "本地",
};

/** 侧栏连接库：按分组树形展示，支持折叠/新建分组。 */
export function Sidebar({
  profiles,
  groups,
  activeProfileIds = [],
  connectingProfileIds = [],
  connectionErrors = {},
  onConnectProfile,
  onEditProfile,
  onDeleteProfile,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onNew,
  onImportSshConfig,
  onModeChange,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState<ProfileLibrary>(() => loadLibrary());
  const [filter, setFilter] = useState<"all" | "favorites" | "recent">("all");
  const [pendingProfileDeletion, setPendingProfileDeletion] = useState<ConnectionProfile | null>(null);
  const [groupDialog, setGroupDialog] = useState<
    | { kind: "create" }
    | { kind: "rename"; group: ProfileGroup }
    | { kind: "delete"; group: ProfileGroup }
    | null
  >(null);

  const activeIds = new Set(activeProfileIds);
  const connectingIds = new Set(connectingProfileIds);
  const queryText = query.trim().toLowerCase();
  const visibleProfiles = profiles.filter((profile) => {
    if (filter === "favorites" && !library.favorites.includes(profile.id)) return false;
    if (filter === "recent" && !library.recent.includes(profile.id)) return false;
    if (!queryText) return true;
    return [profile.name, profile.host, profile.user, profile.environment ?? "", profile.environment ? environmentLabel[profile.environment] : "", `${profile.user}@${profile.host}`]
      .some((value) => value.toLowerCase().includes(queryText));
  });

  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => a.order - b.order),
    [groups]
  );

  const orderedVisibleProfiles = [...visibleProfiles].sort((a, b) => {
    if (filter === "recent") return library.recent.indexOf(a.id) - library.recent.indexOf(b.id);
    return Number(library.favorites.includes(b.id)) - Number(library.favorites.includes(a.id));
  });
  const ungrouped = orderedVisibleProfiles.filter((p) => !p.group_id);
  const byGroup = (gid: string) => orderedVisibleProfiles.filter((p) => p.group_id === gid);

  function saveLibrary(next: ProfileLibrary) {
    setLibrary(next);
    localStorage.setItem(PROFILE_LIBRARY_KEY, JSON.stringify(next));
  }

  function markRecent(id: string) {
    saveLibrary({
      ...library,
      recent: [id, ...library.recent.filter((item) => item !== id)].slice(0, 8),
    });
  }

  function toggleFavorite(id: string) {
    const favorites = library.favorites.includes(id)
      ? library.favorites.filter((item) => item !== id)
      : [...library.favorites, id];
    saveLibrary({ ...library, favorites });
  }

  function toggleGroup(id: string) {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function handleCreateGroup() {
    setGroupDialog({ kind: "create" });
  }

  function handleRenameGroup(g: ProfileGroup, e: React.MouseEvent) {
    e.stopPropagation();
    setGroupDialog({ kind: "rename", group: g });
  }

  function handleDeleteGroup(g: ProfileGroup, e: React.MouseEvent) {
    e.stopPropagation();
    setGroupDialog({ kind: "delete", group: g });
  }

  function renderProfile(p: ConnectionProfile) {
    const connected = activeIds.has(p.id);
    const connecting = connectingIds.has(p.id);
    const favorite = library.favorites.includes(p.id);
    const failure = connectionErrors[p.id];
    return (
      <div
        key={p.id}
        className={`session-item ${connected ? "active" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => {
          markRecent(p.id);
          onConnectProfile(p.id);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            markRecent(p.id);
            onConnectProfile(p.id);
          }
        }}
        title={connected ? "已连接，点击打开终端" : "点击连接"}
      >
        {connected ? <span className="status-dot on" title="已连接" /> : connecting ? <span className="status-dot connecting" title="连接中" /> : <Server size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />}
        <span className="session-meta">
          <div className="session-title">{p.name}{p.environment && <span className={`environment-badge environment-${p.environment}`}>{environmentLabel[p.environment]}</span>}</div>
          <div className="session-sub">
            {p.auth_method === "private_key" ? "🔑 " : ""}
            {p.jump_profile_id ? "↪ " : ""}
            {p.user}@{p.host}:{p.port}
          </div>
          {connecting && <div className="session-sub">连接中…</div>}
          {failure && <div className="session-error" title={failure}>连接失败：{failure}</div>}
        </span>
        <button
          className={`session-x favorite ${favorite ? "on" : ""}`}
          title={favorite ? "取消收藏" : "收藏连接"}
          aria-label={`${favorite ? "取消收藏" : "收藏"} ${p.name}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(p.id);
          }}
        >
          <Star size={13} fill={favorite ? "currentColor" : "none"} />
        </button>
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
            setPendingProfileDeletion(p);
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
    );
  }

  return (
    <>
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <Terminal size={13} strokeWidth={2.5} />
        </span>
        <span className="brand-name">
          simpl<b>-ssh</b>
        </span>
      </div>
      <div className="resource-switcher" role="tablist" aria-label="资源类型">
        <button role="tab" aria-selected className="active"><Server size={13} /> 连接</button>
        <button role="tab" aria-selected={false} onClick={() => onModeChange("project")}><FolderTree size={13} /> 项目</button>
      </div>

      <div className="session-list">
        <div className="sidebar-label-row">
          <span className="sidebar-label">
            已保存的连接 ({profiles.length})
          </span>
          <button
            className="sidebar-icon-btn"
            title="从 ~/.ssh/config 导入"
            onClick={onImportSshConfig}
          >
            <Upload size={14} />
          </button>
          <button
            className="sidebar-icon-btn"
            title="新建分组"
            onClick={handleCreateGroup}
          >
            <FolderPlus size={14} />
          </button>
        </div>

        <label className="sidebar-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索连接、主机或用户…"
            aria-label="搜索连接"
            spellCheck={false}
          />
        </label>

        <div className="sidebar-filters" role="tablist" aria-label="连接筛选">
          {(["all", "favorites", "recent"] as const).map((item) => (
            <button key={item} role="tab" aria-selected={filter === item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>
              {item === "all" ? "全部" : item === "favorites" ? "收藏" : "最近"}
            </button>
          ))}
        </div>

        {profiles.length === 0 ? (
          <div className="sidebar-empty">
            还没有保存的连接。
            <br />
            点下方"新建连接"，勾选保存即可收藏到这里。
          </div>
        ) : (
          <>
            {filter === "recent" && <div className="profile-group-head static"><span className="profile-group-name">最近连接</span><span className="profile-group-count">{orderedVisibleProfiles.length}</span></div>}
            {sortedGroups.map((g) => {
              const items = byGroup(g.id);
              if (items.length === 0) return null;
              const isCollapsed = collapsed[g.id];
              return (
                <div key={g.id} className="profile-group">
                  <div
                    className="profile-group-head"
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleGroup(g.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleGroup(g.id);
                      }
                    }}
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
                  {[...ungrouped].sort((a, b) => Number(library.favorites.includes(b.id)) - Number(library.favorites.includes(a.id))).map(renderProfile)}
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
    {groupDialog?.kind === "create" && <TextInputDialog title="新建连接分组" label="分组名称" confirmLabel="创建" onClose={() => setGroupDialog(null)} onConfirm={(name) => { onCreateGroup(name); setGroupDialog(null); }} />}
    {groupDialog?.kind === "rename" && <TextInputDialog title="重命名连接分组" label="分组名称" initialValue={groupDialog.group.name} onClose={() => setGroupDialog(null)} onConfirm={(name) => { if (name !== groupDialog.group.name) onRenameGroup(groupDialog.group.id, name); setGroupDialog(null); }} />}
    {groupDialog?.kind === "delete" && <ConfirmDialog title="删除连接分组" confirmLabel="删除分组" danger onClose={() => setGroupDialog(null)} onConfirm={() => { onDeleteGroup(groupDialog.group.id); setGroupDialog(null); }}><p>删除「<strong>{groupDialog.group.name}</strong>」后，组内连接会保留并移到“未分组”。</p></ConfirmDialog>}
    {pendingProfileDeletion && <ConfirmDialog title="删除连接配置" confirmLabel="删除配置" danger onClose={() => setPendingProfileDeletion(null)} onConfirm={() => { const profile = pendingProfileDeletion; setPendingProfileDeletion(null); onDeleteProfile(profile.id); }}><p>将删除保存的连接配置及其本机钥匙串凭据；不会中断已建立的会话。</p><p><code>{pendingProfileDeletion.user}@{pendingProfileDeletion.host}:{pendingProfileDeletion.port}</code></p></ConfirmDialog>}
    </>
  );
}

type ProfileLibrary = { favorites: string[]; recent: string[] };
const PROFILE_LIBRARY_KEY = "simpl-ssh-profile-library";

function loadLibrary(): ProfileLibrary {
  try {
    const raw = JSON.parse(localStorage.getItem(PROFILE_LIBRARY_KEY) || "{}");
    return {
      favorites: Array.isArray(raw.favorites) ? raw.favorites.filter((id: unknown): id is string => typeof id === "string") : [],
      recent: Array.isArray(raw.recent) ? raw.recent.filter((id: unknown): id is string => typeof id === "string") : [],
    };
  } catch {
    return { favorites: [], recent: [] };
  }
}
