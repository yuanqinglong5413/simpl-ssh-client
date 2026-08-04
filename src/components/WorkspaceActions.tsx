import {
  Activity,
  Folder,
  GitBranch,
  GitPullRequestArrow,
  LogOut,
  MoreHorizontal,
  PanelRight,
  Search,
  Settings,
  Columns3,
  PanelLeftClose,
  Radio,
  TerminalSquare,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ConnectionEnvironment, SessionInfo, TabKind } from "../types";
import { PopoverMenu } from "./PopoverMenu";

type Props = {
  session: SessionInfo | null;
  activeKind: TabKind | null;
  environment?: ConnectionEnvironment | null;
  onOpenTerminal: () => void;
  onOpenSftp: () => void;
  onOpenGit: () => void;
  onOpenMonitor: () => void;
  onOpenTasks: (section: "activity" | "transfers" | "forwards" | "monitor") => void;
  onDisconnect: () => void;
  onOpenSettings: () => void;
  onOpenCommandPalette: () => void;
  layout: "focus" | "operations";
  onLayoutChange: (layout: "focus" | "operations") => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  broadcastEnabled: boolean;
  onToggleBroadcast: () => void;
  onOpenSnippets: () => void;
  taskCount: number;
  failedTaskCount: number;
};

/** 当前会话的固定操作条。常用动作保持在工作区旁，不依赖底部状态栏。 */
export function WorkspaceActions({
  session,
  activeKind,
  environment,
  onOpenTerminal,
  onOpenSftp,
  onOpenGit,
  onOpenMonitor,
  onOpenTasks,
  onDisconnect,
  onOpenSettings,
  onOpenCommandPalette,
  layout,
  onLayoutChange,
  sidebarCollapsed,
  onToggleSidebar,
  broadcastEnabled,
  onToggleBroadcast,
  onOpenSnippets,
  taskCount,
  failedTaskCount,
}: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setMoreOpen(false), [session?.id]);
  const actions = [
    { id: "terminal", label: "终端", icon: Terminal, action: onOpenTerminal, active: activeKind === "terminal" },
    { id: "files", label: "文件", icon: Folder, action: onOpenSftp, active: activeKind === "sftp" || activeKind === "editor" },
    { id: "git", label: "Git", icon: GitBranch, action: onOpenGit, active: activeKind === "git" },
  ];
  return (
    <div className="workspace-actions" aria-label="当前 SSH 会话操作">
      {session ? <>
        <div className="workspace-session" title={`${session.user}@${session.host}:${session.port}`}>
          <span className="status-dot on" />
          {session.user}@{session.host}{environment && <span className={`workspace-environment workspace-environment-${environment}`}>{environment === "production" ? "生产" : environment === "staging" ? "预发" : environment === "testing" ? "测试" : "本地"}</span>}
        </div>
        <div className="workspace-action-list">
        {actions.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={`workspace-action ${item.active ? "active" : ""}`}
              onClick={item.action}
              aria-label={`打开${item.label}`}
              title={`打开${item.label}`}
            >
              <Icon size={14} /> {item.label}
            </button>
          );
        })}
        <div className="workspace-more">
          <button ref={moreTriggerRef} className={`workspace-action ${moreOpen ? "active" : ""}`} onClick={() => setMoreOpen((value) => !value)} aria-haspopup="menu" aria-expanded={moreOpen} aria-label="更多当前会话操作">
            <MoreHorizontal size={15} /> 更多
          </button>
          <PopoverMenu open={moreOpen} onClose={() => setMoreOpen(false)} triggerRef={moreTriggerRef} className="workspace-more-menu" label="更多当前会话操作">
            <button role="menuitem" onClick={() => { setMoreOpen(false); onOpenMonitor(); }}><Activity size={14} /> 监控面板</button>
            <button role="menuitem" onClick={() => { setMoreOpen(false); onOpenTasks("forwards"); }}><GitPullRequestArrow size={14} /> 端口转发</button>
            <button role="menuitem" onClick={() => { setMoreOpen(false); onOpenTasks("transfers"); }}><PanelRight size={14} /> 传输任务</button>
            <button role="menuitem" className="danger" onClick={() => { setMoreOpen(false); onDisconnect(); }}><LogOut size={14} /> 断开连接</button>
          </PopoverMenu>
        </div>
        </div>
      </> : <div className="workspace-idle">打开一个远程连接即可使用文件、Git 与会话操作。</div>}
      <div className="workspace-global-actions">
        <button className={`workspace-icon-action ${sidebarCollapsed ? "active" : ""}`} title="显示或收起资源侧栏" aria-label="显示或收起资源侧栏" onClick={onToggleSidebar}><PanelLeftClose size={15} /></button>
        <button className={`workspace-icon-action workspace-task-entry ${failedTaskCount ? "has-failures" : ""}`} title={failedTaskCount ? `${failedTaskCount} 个传输失败` : taskCount ? `${taskCount} 个后台任务` : "任务抽屉"} aria-label="打开任务抽屉" onClick={() => onOpenTasks(failedTaskCount ? "transfers" : "activity")}><PanelRight size={15} />{(taskCount || failedTaskCount) ? <span>{failedTaskCount || taskCount}</span> : null}</button>
        <button className={`workspace-icon-action ${layout === "operations" ? "active" : ""}`} title="切换工作台布局" aria-label="切换工作台布局" onClick={() => onLayoutChange(layout === "focus" ? "operations" : "focus")}><Columns3 size={15} /></button>
        <button className="workspace-icon-action" title="命令面板 (⌘/Ctrl Shift P)" aria-label="打开命令面板" onClick={onOpenCommandPalette}><Search size={15} /></button>
        <button className={`workspace-icon-action ${broadcastEnabled ? "active" : ""}`} title="多会话广播输入" aria-label="多会话广播输入" onClick={onToggleBroadcast}><Radio size={15} /></button>
        <button className="workspace-icon-action" title="命令片段" aria-label="打开命令片段" onClick={onOpenSnippets}><TerminalSquare size={15} /></button>
        <button className="workspace-icon-action" title="设置" aria-label="打开设置" onClick={onOpenSettings}><Settings size={15} /></button>
      </div>
    </div>
  );
}
