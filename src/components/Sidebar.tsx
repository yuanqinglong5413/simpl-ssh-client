import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  FolderInput,
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
import { ResourceGroupDeleteDialog } from "./ResourceGroupDeleteDialog";
import { handleTreeKeyboard } from "../utils/treeKeyboard";
import { MoveResourceDialog } from "./MoveResourceDialog";
import { ResourceTreeDnd, ResourceTreeDragRow, ResourceTreeRootDrop, type ResourceDragData } from "./ResourceTreeDnd";

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
  onCreateGroup: (name: string, parentId?: string | null) => void;
  onRenameGroup: (id: string, name: string) => void;
  onDeleteGroup: (id: string) => void;
  onMoveGroup: (id: string, parentId: string | null, position?: number) => Promise<void> | void;
  onMoveProfile: (id: string, groupId: string | null, position?: number) => Promise<void> | void;
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
  onMoveGroup,
  onMoveProfile,
  onNew,
  onImportSshConfig,
  onModeChange,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => loadCollapsedGroups("connection"));
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState<ProfileLibrary>(() => loadLibrary());
  const [filter, setFilter] = useState<"all" | "favorites" | "recent">("all");
  const [pendingProfileDeletion, setPendingProfileDeletion] = useState<ConnectionProfile | null>(null);
  const [moveTarget, setMoveTarget] = useState<ResourceDragData | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [groupDialog, setGroupDialog] = useState<
    | { kind: "create"; parentId?: string | null }
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
  const visibleGroupIds = useMemo(() => {
    if (!queryText && filter === "all") return new Set(groups.map((group) => group.id));
    const byId = new Map(groups.map((group) => [group.id, group]));
    const visible = new Set<string>();
    const includeAncestors = (id?: string | null) => {
      let current = id ? byId.get(id) : undefined;
      while (current && !visible.has(current.id)) {
        visible.add(current.id);
        current = current.parent_id ? byId.get(current.parent_id) : undefined;
      }
    };
    visibleProfiles.forEach((profile) => includeAncestors(profile.group_id));
    if (queryText) groups.filter((group) => group.name.toLocaleLowerCase().includes(queryText)).forEach((group) => includeAncestors(group.id));
    return visible;
  }, [filter, groups, queryText, visibleProfiles]);

  const orderedVisibleProfiles = [...visibleProfiles].sort((a, b) => {
    if (filter === "recent") return library.recent.indexOf(a.id) - library.recent.indexOf(b.id);
    return (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name);
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
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      localStorage.setItem("simpl-ssh:tree:connection:collapsed", JSON.stringify(next));
      return next;
    });
  }

  function handleCreateGroup(parentId?: string | null) {
    setGroupDialog({ kind: "create", parentId });
  }

  function handleRenameGroup(g: ProfileGroup, e: React.MouseEvent) {
    e.stopPropagation();
    setGroupDialog({ kind: "rename", group: g });
  }

  function handleDeleteGroup(g: ProfileGroup, e: React.MouseEvent) {
    e.stopPropagation();
    setGroupDialog({ kind: "delete", group: g });
  }

  function renderProfile(p: ConnectionProfile, depth = 0) {
    const connected = activeIds.has(p.id);
    const connecting = connectingIds.has(p.id);
    const favorite = library.favorites.includes(p.id);
    const failure = connectionErrors[p.id];
    const dragData: ResourceDragData = { treeKind: "connection", nodeType: "item", id: p.id, parentId: p.group_id ?? null, position: p.position ?? 0, label: p.name };
    return (
      <ResourceTreeDragRow key={p.id} data={dragData}>
      <div
        key={p.id}
        className={`session-item ${connected ? "active" : ""}`}
        role="treeitem"
        aria-level={depth + 1}
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
          title="移动到分组"
          aria-label={`移动 ${p.name} 到分组`}
          onClick={(e) => { e.stopPropagation(); setMoveTarget(dragData); }}
        >
          <FolderInput size={13} />
        </button>
        <button
          className="session-x"
          title="编辑"
          aria-label={`编辑 ${p.name}`}
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
          aria-label={`删除 ${p.name}`}
          onClick={(e) => {
            e.stopPropagation();
            setPendingProfileDeletion(p);
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
      </ResourceTreeDragRow>
    );
  }

  function renderGroup(group: ProfileGroup, depth = 0): React.ReactNode {
    const children = sortedGroups.filter((candidate) => candidate.parent_id === group.id && visibleGroupIds.has(candidate.id));
    const items = byGroup(group.id);
    const isCollapsed = collapsed[group.id];
    const dragData: ResourceDragData = { treeKind: "connection", nodeType: "group", id: group.id, parentId: group.parent_id ?? null, position: group.order, label: group.name };
    return <div key={group.id} className="profile-group resource-tree-group" style={{ "--tree-depth": depth } as React.CSSProperties}>
      <ResourceTreeDragRow data={dragData} allowInside>
      <div className="profile-group-head" role="treeitem" aria-level={depth + 1} aria-expanded={!isCollapsed} tabIndex={0} onClick={() => toggleGroup(group.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleGroup(group.id); } }}>
        {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <FolderTree size={13} />
        <span className="profile-group-name">{group.name}</span>
        <span className="profile-group-count">{items.length + children.length}</span>
        <button className="session-x group-action" title="新建子分组" aria-label={`在 ${group.name} 中新建子分组`} onClick={(event) => { event.stopPropagation(); handleCreateGroup(group.id); }}><FolderPlus size={12} /></button>
        <button className="session-x group-action" title="移动分组" aria-label={`移动分组 ${group.name}`} onClick={(event) => { event.stopPropagation(); setMoveTarget(dragData); }}><FolderInput size={12} /></button>
        <button className="session-x group-action" title="重命名分组" aria-label={`重命名分组 ${group.name}`} onClick={(event) => handleRenameGroup(group, event)}><Pencil size={12} /></button>
        <button className="session-x group-action" title="递归删除分组" aria-label={`递归删除分组 ${group.name}`} onClick={(event) => handleDeleteGroup(group, event)}><Trash2 size={12} /></button>
      </div>
      </ResourceTreeDragRow>
      {!isCollapsed && <div className="profile-group-items" role="group">{children.map((child) => renderGroup(child, depth + 1))}{items.map((item) => renderProfile(item, depth + 1))}</div>}
    </div>;
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
            onClick={() => handleCreateGroup()}
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
        {(queryText || filter !== "all") && <div className="resource-drag-disabled" role="status">筛选期间暂停拖拽；清除搜索并切回“全部”后可整理顺序。</div>}

        {profiles.length === 0 ? (
          <div className="sidebar-empty">
            还没有保存的连接。
            <br />
            点下方"新建连接"，勾选保存即可收藏到这里。
          </div>
        ) : (
          <>
            {filter === "recent" && <div className="profile-group-head static"><span className="profile-group-name">最近连接</span><span className="profile-group-count">{orderedVisibleProfiles.length}</span></div>}
            <ResourceTreeDnd kind="connection" disabled={Boolean(queryText) || filter !== "all"} onAutoExpand={(id) => { if (collapsed[id]) toggleGroup(id); }} onError={setMoveError} onMove={async (source, parentId, position) => { if (source.nodeType === "group") await onMoveGroup(source.id, parentId, position); else await onMoveProfile(source.id, parentId, position); }}>
              <ResourceTreeRootDrop kind="connection"><div role="tree" aria-label="连接分组树" onKeyDown={handleTreeKeyboard}>{sortedGroups.filter((group) => visibleGroupIds.has(group.id) && (!group.parent_id || !groups.some((candidate) => candidate.id === group.parent_id))).map((group) => renderGroup(group))}</div></ResourceTreeRootDrop>

            {ungrouped.length > 0 && (
              <div className="profile-group" role="tree" aria-label="未分组连接" onKeyDown={handleTreeKeyboard}>
                {sortedGroups.some((g) => byGroup(g.id).length > 0) && (
                  <div className="profile-group-head static">
                    <span className="profile-group-name">未分组</span>
                    <span className="profile-group-count">
                      {ungrouped.length}
                    </span>
                  </div>
                )}
                <div className="profile-group-items">
                  {ungrouped.map((item) => renderProfile(item))}
                </div>
              </div>
            )}
            </ResourceTreeDnd>
          </>
        )}
      </div>

      <div className="sidebar-foot">
        <button className="btn btn-primary btn-block" onClick={onNew}>
          <Plus size={15} /> 新建连接
        </button>
      </div>
    </aside>
    {groupDialog?.kind === "create" && <TextInputDialog title={groupDialog.parentId ? "新建子分组" : "新建连接分组"} label="分组名称" confirmLabel="创建" onClose={() => setGroupDialog(null)} onConfirm={(name) => { onCreateGroup(name, groupDialog.parentId); setGroupDialog(null); }} />}
    {groupDialog?.kind === "rename" && <TextInputDialog title="重命名连接分组" label="分组名称" initialValue={groupDialog.group.name} onClose={() => setGroupDialog(null)} onConfirm={(name) => { if (name !== groupDialog.group.name) onRenameGroup(groupDialog.group.id, name); setGroupDialog(null); }} />}
    {groupDialog?.kind === "delete" && <ResourceGroupDeleteDialog group={groupDialog.group} onClose={() => setGroupDialog(null)} onConfirm={() => { onDeleteGroup(groupDialog.group.id); setGroupDialog(null); }} />}
    {pendingProfileDeletion && <ConfirmDialog title="删除连接配置" confirmLabel="删除配置" danger onClose={() => setPendingProfileDeletion(null)} onConfirm={() => { const profile = pendingProfileDeletion; setPendingProfileDeletion(null); onDeleteProfile(profile.id); }}><p>将删除保存的连接配置及其应用加密凭据；不会中断已建立的会话。</p><p><code>{pendingProfileDeletion.user}@{pendingProfileDeletion.host}:{pendingProfileDeletion.port}</code></p></ConfirmDialog>}
    {moveTarget && <MoveResourceDialog title={`移动${moveTarget.nodeType === "group" ? "分组" : "连接"}：${moveTarget.label}`} groups={groups} currentGroupId={moveTarget.parentId} movingGroupId={moveTarget.nodeType === "group" ? moveTarget.id : undefined} onClose={() => setMoveTarget(null)} onMove={(groupId) => moveTarget.nodeType === "group" ? onMoveGroup(moveTarget.id, groupId) : onMoveProfile(moveTarget.id, groupId)} />}
    {moveError && <ConfirmDialog title="无法移动资源" confirmLabel="知道了" onClose={() => setMoveError(null)} onConfirm={() => setMoveError(null)}><p>{moveError}</p></ConfirmDialog>}
    </>
  );
}

function loadCollapsedGroups(kind: "connection" | "project"): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(`simpl-ssh:tree:${kind}:collapsed`) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, boolean> : {};
  } catch {
    return {};
  }
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
