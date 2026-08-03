import { Clock3, FolderPlus, FolderTree, Import, Plus, Server, Terminal } from "lucide-react";
import type { AppMode, ConnectionProfile, Project } from "../types";

type Props = {
  mode: AppMode;
  projects: Project[];
  profiles: ConnectionProfile[];
  onOpenProject: (project: Project) => void;
  onConnectProfile: (profile: ConnectionProfile) => void;
  onSwitchMode: (mode: AppMode) => void;
  onNewConnection: () => void;
  onImportConfig: () => void;
};

/** 没有标签时的开始页：让首次使用和回到空工作区都有明确下一步。 */
export function StartPage({ mode, projects, profiles, onOpenProject, onConnectProfile, onSwitchMode, onNewConnection, onImportConfig }: Props) {
  const recentProjects = [...projects].slice(0, 5);
  const recentProfiles = [...profiles].slice(0, 5);
  return (
    <section className="start-page" aria-label="开始页">
      <div className="start-page-hero">
        <div className="start-page-mark"><Terminal size={24} /></div>
        <div>
          <h1>{mode === "project" ? "从项目开始" : "开始远程开发"}</h1>
          <p>选择一个工作区或连接；终端保持专注，文件与任务在需要时打开。</p>
        </div>
      </div>
      <div className="start-page-actions">
        <button className="btn btn-primary" onClick={onNewConnection}><Plus size={15} /> 新建连接</button>
        <button className="btn btn-ghost" onClick={onImportConfig}><Import size={15} /> 导入 SSH 配置</button>
        <button className="btn btn-ghost" onClick={() => onSwitchMode("project")}><FolderPlus size={15} /> 管理项目</button>
      </div>
      <div className="start-page-grid">
        <section className="start-page-section">
          <header><FolderTree size={16} /><h2>项目</h2><button type="button" onClick={() => onSwitchMode("project")}>查看全部</button></header>
          {recentProjects.length ? <div className="start-page-list">{recentProjects.map((project) => (
            <button key={project.id} className="start-page-item" onClick={() => onOpenProject(project)}>
              <FolderTree size={15} /><span><strong>{project.name}</strong><small title={project.local_path}>{project.local_path}</small></span>
            </button>
          ))}</div> : <div className="start-page-empty">还没有项目。进入项目管理后创建一个本地工作区。</div>}
        </section>
        <section className="start-page-section">
          <header><Server size={16} /><h2>已保存连接</h2><button type="button" onClick={() => onSwitchMode("ssh")}>查看全部</button></header>
          {recentProfiles.length ? <div className="start-page-list">{recentProfiles.map((profile) => (
            <button key={profile.id} className="start-page-item" onClick={() => onConnectProfile(profile)}>
              <Server size={15} /><span><strong>{profile.name}</strong><small>{profile.user}@{profile.host}:{profile.port}</small></span>{profile.environment === "production" && <em>生产</em>}
            </button>
          ))}</div> : <div className="start-page-empty"><Clock3 size={15} /> 导入 <code>~/.ssh/config</code> 或创建首个连接。</div>}
        </section>
      </div>
    </section>
  );
}
