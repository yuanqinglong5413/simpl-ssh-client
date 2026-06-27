import { useMemo, useState } from "react";
import {
  Folder,
  FolderPlus,
  FolderTree,
  Pencil,
  Plus,
  Terminal,
  Trash2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Project, ProjectInput } from "../types";

type Props = {
  projects: Project[];
  onConnectProject: (project: Project) => void;
  onDeleteProject: (id: string) => void;
  onSaved?: () => void;
};

/**
 * 项目侧栏：本地项目列表，双击打开本地终端。
 * 复用 SSH 侧栏的 CSS 类（session-item / session-meta / session-x 等）保持视觉一致。
 */
export function ProjectSidebar({
  projects,
  onConnectProject,
  onDeleteProject,
  onSaved,
}: Props) {
  const [editTarget, setEditTarget] = useState<Project | null>(null);
  const [showCreate, setShowCreate] = useState(false);

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

        {sorted.map((p) => (
          <div
            key={p.id}
            className="session-item"
            onDoubleClick={() => onConnectProject(p)}
            title={p.local_path}
          >
            <Folder size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
            <span className="session-meta">
              <div className="session-title">{p.name}</div>
              <div className="session-sub">{p.local_path}</div>
            </span>
            <button
              className="session-x"
              title="打开终端"
              onClick={(e) => {
                e.stopPropagation();
                onConnectProject(p);
              }}
            >
              <Terminal size={13} />
            </button>
            <button
              className="session-x"
              title="编辑"
              onClick={(e) => {
                e.stopPropagation();
                setEditTarget(p);
              }}
            >
              <Pencil size={13} />
            </button>
            <button
              className="session-x"
              title="删除"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteProject(p.id);
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>

      {(showCreate || editTarget) && (
        <ProjectDialog
          project={editTarget}
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
        />
      )}
    </aside>
  );
}

/** 新建/编辑项目对话框 */
function ProjectDialog({
  project,
  onClose,
  onSave,
}: {
  project: Project | null;
  onClose: () => void;
  onSave: (input: ProjectInput) => Promise<void>;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [localPath, setLocalPath] = useState(project?.local_path ?? "");
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
        linked_profiles: project?.linked_profiles ?? [],
      });
    } catch (e) {
      setError(String(e));
    }
    setSaving(false);
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h3 className="dialog-title">
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
