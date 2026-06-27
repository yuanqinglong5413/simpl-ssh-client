import { useMemo, useState } from "react";
import { FolderPlus, Pencil, Plus, Trash2, Folder, Terminal } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Project, ProjectInput } from "../types";

type Props = {
  projects: Project[];
  onConnectProject: (project: Project) => void;
  onDeleteProject: (id: string) => void;
};

/**
 * 项目侧栏：本地项目列表，双击打开本地终端。
 */
export function ProjectSidebar({
  projects,
  onConnectProject,
  onDeleteProject,
}: Props) {
  const [editTarget, setEditTarget] = useState<Project | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const sorted = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
    [projects]
  );

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">项目</span>
        <button
          className="btn btn-ghost"
          title="新建项目"
          onClick={() => setShowCreate(true)}
        >
          <Plus size={15} />
        </button>
      </div>

      <div className="sidebar-list">
        {sorted.length === 0 && (
          <div className="sidebar-empty">
            还没有项目
            <br />
            点击 + 创建
          </div>
        )}
        {sorted.map((p) => (
          <div
            key={p.id}
            className="profile-item"
            onDoubleClick={() => onConnectProject(p)}
            title={p.local_path}
          >
            <button
              className="profile-connect"
              onClick={() => onConnectProject(p)}
              title="打开终端"
            >
              <Terminal size={14} />
            </button>
            <div className="profile-info">
              <span className="profile-name">{p.name}</span>
              <span className="profile-detail">{p.local_path}</span>
            </div>
            <div className="profile-actions">
              <button
                className="btn btn-ghost"
                title="编辑"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditTarget(p);
                }}
              >
                <Pencil size={12} />
              </button>
              <button
                className="btn btn-ghost danger"
                title="删除"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteProject(p.id);
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
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
          }}
        />
      )}
    </div>
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
    try {
      await onSave({
        name: name.trim(),
        local_path: localPath.trim(),
        group_id: null,
        linked_profiles: project?.linked_profiles ?? [],
      });
    } catch (e) {
      console.error("project save error:", e);
    }
    setSaving(false);
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">
          <FolderPlus size={16} />
          {project ? "编辑项目" : "新建项目"}
        </h3>
        <label className="form-label">
          名称
          <input
            className="form-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="项目名称"
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
        <div className="dialog-actions">
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
