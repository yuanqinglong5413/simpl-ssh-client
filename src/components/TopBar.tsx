import { Monitor, FolderTree } from "lucide-react";
import type { AppMode } from "../types";

type Props = {
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
  sshTabCount: number;
  projectTabCount: number;
};

/**
 * 顶栏模式切换器：SSH 管理 ↔ 项目管理。
 * 切换仅切换 Sidebar 内容，不卸载 TabBar/Main。
 */
export function TopBar({ mode, onModeChange, sshTabCount, projectTabCount }: Props) {
  return (
    <div className="topbar">
      <div className="topbar-tabs">
        <button
          className={`topbar-tab ${mode === "ssh" ? "active" : ""}`}
          onClick={() => onModeChange("ssh")}
        >
          <Monitor size={14} />
          <span>SSH 管理</span>
          {sshTabCount > 0 && <span className="topbar-count">{sshTabCount}</span>}
        </button>
        <button
          className={`topbar-tab ${mode === "project" ? "active" : ""}`}
          onClick={() => onModeChange("project")}
        >
          <FolderTree size={14} />
          <span>项目管理</span>
          {projectTabCount > 0 && (
            <span className="topbar-count">{projectTabCount}</span>
          )}
        </button>
      </div>
    </div>
  );
}
