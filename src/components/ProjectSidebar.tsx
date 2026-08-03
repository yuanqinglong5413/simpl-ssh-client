import { useMemo, useState } from "react";
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Folder,
  FolderPlus,
  FolderTree,
  GitBranch,
  Pencil,
  Plus,
  Server,
  Sparkles,
  Terminal,
  Trash2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { ConfirmDialog } from "./DialogPrimitives";
import type {
  ConnectionProfile,
  Project,
  ProjectInput,
  ProjectRemoteWorkspace,
  ProjectAgentBinding,
} from "../types";
import type { AgentPreset } from "../settings/types";

type Props = {
  projects: Project[];
  profiles: ConnectionProfile[];
  onConnectProject: (project: Project) => void;
  onOpenLocalTerminal: (project: Project) => void;
  onOpenRemote: (
    project: Project,
    workspace: ProjectRemoteWorkspace,
    target: "terminal" | "sftp" | "git" | "monitor"
  ) => void;
  onDeleteProject: (id: string) => void;
  onSaved?: () => void;
  onModeChange: (mode: "ssh" | "project") => void;
  agentPresets: AgentPreset[];
  onLaunchAgent: (project: Project, binding: ProjectAgentBinding) => void;
  agentRuns?: { tabId: string; projectId: string; presetId: string; status: "running" | "exited" | "failed"; startedAt?: string }[];
  onActivateAgentTab: (tabId: string) => void;
};

/**
 * 项目侧栏：项目行进入工作台，终端按钮打开独立的本地控制台。
 * 复用 SSH 侧栏的 CSS 类（session-item / session-meta / session-x 等）保持视觉一致。
 */
export function ProjectSidebar({
  projects,
  profiles,
  onConnectProject,
  onOpenLocalTerminal,
  onOpenRemote,
  onDeleteProject,
  onSaved,
  onModeChange,
  agentPresets,
  onLaunchAgent,
  agentRuns = [],
  onActivateAgentTab,
}: Props) {
  const [editTarget, setEditTarget] = useState<Project | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [agentMenuFor, setAgentMenuFor] = useState<string | null>(null);
  const [pendingDeletion, setPendingDeletion] = useState<Project | null>(null);

  const sorted = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
    [projects]
  );

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" style={{ background: "linear-gradient(145deg, var(--accent), #e67e00)" }}>
          <FolderTree size={13} strokeWidth={2.5} />
        </span>
        <span className="brand-name">
          项目<b>管理</b>
        </span>
      </div>
      <div className="resource-switcher" role="tablist" aria-label="资源类型">
        <button role="tab" aria-selected={false} onClick={() => onModeChange("ssh")}><Server size={13} /> 连接</button>
        <button role="tab" aria-selected className="active"><FolderTree size={13} /> 项目</button>
      </div>

      <div className="session-list">
        <div className="sidebar-label-row">
          <span className="sidebar-label">
            本地项目 ({sorted.length})
          </span>
          <button
            className="sidebar-icon-btn"
            title="新建项目"
            onClick={() => setShowCreate(true)}
          >
            <Plus size={14} />
          </button>
        </div>

        {sorted.length === 0 && (
          <div className="sidebar-empty">
            <div className="sidebar-empty-icon">
              <FolderPlus size={28} />
            </div>
            <div>还没有项目</div>
            <div className="sidebar-empty-hint">点击上方 + 创建本地项目</div>
          </div>
        )}

        {sorted.map((p) => {
          const workspaces = projectWorkspaces(p);
          const bindings = (p.agent_bindings ?? []).filter((binding) => agentPresets.some((preset) => preset.id === binding.preset_id));
          const activeAgents = agentRuns.filter((run) => run.projectId === p.id && run.status === "running").length;
          return (
            <div key={p.id} className="project-card">
              <div
                className="session-item project-local-row"
                role="group"
                aria-label={`项目 ${p.name}`}
                tabIndex={0}
                onClick={() => onConnectProject(p)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onConnectProject(p);
                  }
                }}
                title={p.local_path}
              >
                <Folder size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
                <span className="session-meta">
                  <div className="session-title">{p.name}</div>
                  <div className="session-sub">本地 · {p.local_path}</div>
                </span>
                <button
                  className="session-x"
                  title="打开本地终端"
                  aria-label={`打开 ${p.name} 的本地终端`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenLocalTerminal(p);
                  }}
                >
                  <Terminal size={13} />
                </button>
                <div className="project-agent-menu">
                  <button className={`session-x ${activeAgents ? "agent-active" : ""}`} title="启动 Agent" aria-label={`启动 ${p.name} 的 Agent`} onClick={(e) => { e.stopPropagation(); setAgentMenuFor((current) => current === p.id ? null : p.id); }}><Sparkles size={13} /></button>
                  {agentMenuFor === p.id && <div className="project-agent-popover">
                    <div className="project-agent-popover-title">项目 Agent{activeAgents ? ` · ${activeAgents} 运行中` : ""}</div>
                    {bindings.length === 0 && <div className="project-agent-empty">尚未为此项目启用 Agent</div>}
                    {bindings.map((binding) => {
                      const preset = agentPresets.find((item) => item.id === binding.preset_id);
                      if (!preset) return null;
                      const running = agentRuns.find((run) => run.projectId === p.id && run.presetId === binding.preset_id && run.status === "running");
                      const command = binding.command_override || preset.command;
                      return <div className="project-agent-action" key={binding.preset_id}>
                        {running ? <button onClick={(event) => { event.stopPropagation(); setAgentMenuFor(null); onActivateAgentTab(running.tabId); }}><Activity size={13} /> {preset.name} · 运行中{running.startedAt ? `（${new Date(running.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}）` : ""}</button> : <button onClick={(event) => { event.stopPropagation(); setAgentMenuFor(null); onLaunchAgent(p, binding); }}><Sparkles size={13} /> 启动 {preset.name}</button>}
                        <button className="project-agent-copy" title="复制启动命令" aria-label={`复制 ${preset.name} 启动命令`} onClick={(event) => { event.stopPropagation(); void navigator.clipboard?.writeText(command); }}>复制命令</button>
                      </div>;
                    })}
                    <button className="project-agent-config" onClick={(event) => { event.stopPropagation(); setAgentMenuFor(null); setEditTarget(p); }}><Pencil size={13} /> 配置 Agent</button>
                  </div>}
                </div>
                <button
                  className="session-x"
                  title="编辑项目"
                  aria-label={`编辑项目 ${p.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditTarget(p);
                  }}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="session-x"
                  title="删除项目"
                  aria-label={`删除项目 ${p.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDeletion(p);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              {workspaces.length > 0 && (
                <div className="project-remotes">
                  {workspaces.map((workspace) => {
                    const profile = profiles.find((x) => x.id === workspace.profile_id);
                    if (!profile) return null;
                    return (
                      <div key={workspace.profile_id} className="project-remote-row">
                        <Server size={12} />
                        <span className="project-remote-name" title={workspace.remote_path || "登录后的默认目录"}>
                          {profile.name}{workspace.remote_path ? ` · ${workspace.remote_path}` : ""}
                        </span>
                        <button title="打开远程终端" aria-label={`打开 ${profile.name} 的远程终端`} onClick={() => onOpenRemote(p, workspace, "terminal")}><Terminal size={12} /></button>
                        <button title="打开远程文件" aria-label={`打开 ${profile.name} 的远程文件`} onClick={() => onOpenRemote(p, workspace, "sftp")}><Folder size={12} /></button>
                        <button title="打开远程 Git" aria-label={`打开 ${profile.name} 的远程 Git`} onClick={() => onOpenRemote(p, workspace, "git")}><GitBranch size={12} /></button>
                        <button title="打开远程监控" aria-label={`打开 ${profile.name} 的远程监控`} onClick={() => onOpenRemote(p, workspace, "monitor")}><Activity size={12} /></button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {(showCreate || editTarget) && (
        <ProjectDialog
          project={editTarget}
          profiles={profiles}
          onClose={() => {
            setShowCreate(false);
            setEditTarget(null);
          }}
          onSave={async (input) => {
            if (editTarget) {
              await invoke("project_update", { id: editTarget.id, input });
            } else {
              await invoke("project_create", { input });
            }
            setShowCreate(false);
            setEditTarget(null);
            onSaved?.();
          }}
          agentPresets={agentPresets}
        />
      )}
      {pendingDeletion && <ConfirmDialog title="删除项目记录" confirmLabel="删除项目" danger onClose={() => setPendingDeletion(null)} onConfirm={() => { const target = pendingDeletion; setPendingDeletion(null); onDeleteProject(target.id); }}>
        <p>将删除 Simpl SSH 中的项目记录；不会删除本地文件或远程文件。</p>
        <p><strong>本地目录</strong><br /><code>{pendingDeletion.local_path}</code></p>
        {projectWorkspaces(pendingDeletion).length > 0 && <p><strong>关联远程环境</strong><br />{projectWorkspaces(pendingDeletion).map((workspace) => <code key={workspace.profile_id}>{workspace.remote_path || "登录后的默认目录"}</code>)}</p>}
      </ConfirmDialog>}
    </aside>
  );
}

/** 新建/编辑项目对话框 */
function ProjectDialog({
  project,
  profiles,
  onClose,
  onSave,
  agentPresets,
}: {
  project: Project | null;
  profiles: ConnectionProfile[];
  onClose: () => void;
  onSave: (input: ProjectInput) => Promise<void>;
  agentPresets: AgentPreset[];
}) {
  const dialogRef = useDialogFocus(true, onClose);
  const [name, setName] = useState(project?.name ?? "");
  const [localPath, setLocalPath] = useState(project?.local_path ?? "");
  const [remoteWorkspaces, setRemoteWorkspaces] = useState<ProjectRemoteWorkspace[]>(
    () => projectWorkspaces(project)
  );
  const [agentBindings, setAgentBindings] = useState<ProjectAgentBinding[]>(() =>
    (project?.agent_bindings ?? []).filter((binding) => agentPresets.some((preset) => preset.id === binding.preset_id))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function pickFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      setLocalPath(selected);
      if (!name) setName(selected.split("/").pop() || selected);
    }
  }

  async function handleSave() {
    if (!name.trim() || !localPath.trim()) return;
    setSaving(true);
    setError("");
    try {
      await onSave({
        name: name.trim(),
        local_path: localPath.trim(),
        group_id: null,
        linked_profiles: remoteWorkspaces.map((workspace) => workspace.profile_id),
        remote_workspaces: remoteWorkspaces,
        agent_bindings: agentBindings.filter((binding) => agentPresets.some((preset) => preset.id === binding.preset_id)),
      });
    } catch (e) {
      setError(String(e));
    }
    setSaving(false);
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h3 className="dialog-title" id="project-dialog-title">
            <FolderPlus size={16} />
            {project ? "编辑项目" : "新建项目"}
          </h3>
        </div>
        <div className="dialog-body">
          <label className="form-label">
            名称
            <input
              className="form-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="项目名称"
              autoFocus
            />
          </label>
          <div className="project-remote-field">
            <div className="form-label project-remote-label">
              远程工作区
              <span>关联后可一键打开终端、文件和 Git</span>
            </div>
            {remoteWorkspaces.map((workspace, index) => (
              <div className="project-remote-editor" key={`${workspace.profile_id}-${index}`}>
                <select
                  value={workspace.profile_id}
                  onChange={(e) => setRemoteWorkspaces((previous) => previous.map((entry, entryIndex) => entryIndex === index ? { ...entry, profile_id: e.target.value } : entry))}
                >
                  <option value="">选择已保存连接</option>
                  {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} ({profile.user}@{profile.host})</option>)}
                </select>
                <input
                  className="form-input"
                  value={workspace.remote_path}
                  onChange={(e) => setRemoteWorkspaces((previous) => previous.map((entry, entryIndex) => entryIndex === index ? { ...entry, remote_path: e.target.value } : entry))}
                  placeholder="远程根目录（可选）"
                />
                <button type="button" className="icon-btn danger" title="移除远程工作区" aria-label="移除远程工作区" onClick={() => setRemoteWorkspaces((previous) => previous.filter((_, entryIndex) => entryIndex !== index))}><Trash2 size={14} /></button>
              </div>
            ))}
            <button
              type="button"
              className="btn btn-ghost project-remote-add"
              onClick={() => setRemoteWorkspaces((previous) => [...previous, { profile_id: profiles.find((profile) => !previous.some((entry) => entry.profile_id === profile.id))?.id ?? "", remote_path: "" }])}
              disabled={profiles.length === 0 || remoteWorkspaces.length >= profiles.length}
            >
              <Plus size={14} /> 添加远程环境
            </button>
            {profiles.length === 0 && <div className="form-error">请先在 SSH 管理中保存一个连接。</div>}
          </div>
          <div className="project-remote-field">
            <div className="form-label project-remote-label">项目 Agent <span>在独立终端中启动，不会随应用重启自动执行</span></div>
            {agentPresets.length === 0 && <div className="form-error">还没有可用 Agent。请先在“设置 → Agent 启动项”中创建命令。</div>}
            {agentPresets.map((preset) => {
              const binding = agentBindings.find((item) => item.preset_id === preset.id);
              return <div className="project-agent-binding" key={preset.id}>
                <label className="check"><input type="checkbox" checked={Boolean(binding)} onChange={(event) => setAgentBindings((previous) => event.target.checked ? [...previous, { preset_id: preset.id }] : previous.filter((item) => item.preset_id !== preset.id))} /> {preset.name}</label>
                {binding && <input className="form-input" value={binding.command_override ?? ""} onChange={(event) => setAgentBindings((previous) => previous.map((item) => item.preset_id === preset.id ? { ...item, command_override: event.target.value || undefined } : item))} placeholder={`默认：${preset.command}`} aria-label={`${preset.name} 命令覆盖`} />}
              </div>;
            })}
            {agentBindings.length > 1 && <div className="project-agent-order"><span>启动菜单顺序</span>{agentBindings.map((binding, index) => {
              const preset = agentPresets.find((item) => item.id === binding.preset_id);
              if (!preset) return null;
              const move = (offset: -1 | 1) => setAgentBindings((previous) => {
                const target = index + offset;
                if (target < 0 || target >= previous.length) return previous;
                const next = [...previous];
                [next[index], next[target]] = [next[target], next[index]];
                return next;
              });
              return <div className="project-agent-order-row" key={binding.preset_id}><span>{preset.name}</span><button type="button" className="icon-btn" aria-label={`上移 ${preset.name}`} disabled={index === 0} onClick={() => move(-1)}><ChevronUp size={13} /></button><button type="button" className="icon-btn" aria-label={`下移 ${preset.name}`} disabled={index === agentBindings.length - 1} onClick={() => move(1)}><ChevronDown size={13} /></button></div>;
            })}</div>}
          </div>
          <label className="form-label">
            本地路径
            <div className="path-row">
              <input
                className="form-input"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder="/path/to/project"
              />
              <button className="btn btn-ghost" onClick={pickFolder} title="选择目录">
                <Folder size={15} />
              </button>
            </div>
          </label>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="dialog-foot">
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving || !name.trim() || !localPath.trim()}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

function projectWorkspaces(project: Project | null): ProjectRemoteWorkspace[] {
  if (!project) return [];
  if (project.remote_workspaces?.length) return project.remote_workspaces;
  return (project.linked_profiles ?? []).map((profile_id) => ({ profile_id, remote_path: "" }));
}
