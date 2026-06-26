import { Folder, Activity, Settings, X } from "lucide-react";
import type { SessionInfo } from "../types";
import { ThemePicker } from "./ThemePicker";

type Props = {
  session: SessionInfo | null;
  tabCount: number;
  onOpenSftp: () => void;
  onOpenMonitor: () => void;
  onDisconnect: () => void;
  onOpenSettings: () => void;
};

export function StatusBar({
  session,
  tabCount,
  onOpenSftp,
  onOpenMonitor,
  onDisconnect,
  onOpenSettings,
}: Props) {
  return (
    <div className="statusbar">
      <div className="status-left">
        <span className={`pulse ${session ? "" : "idle"}`} />
        {session ? (
          <span>
            已连接 · {session.user}@{session.host}:{session.port}
            {session.jump_via ? `（经 ${session.jump_via}）` : ""}
          </span>
        ) : (
          <span>就绪 · {tabCount} 个打开的面板</span>
        )}
      </div>
      <div className="status-right">
        {session && (
          <>
            <button
              className="status-action"
              onClick={onOpenMonitor}
              title="为当前会话打开系统监控"
            >
              <Activity size={13} /> 监控
            </button>
            <button
              className="status-action"
              onClick={onOpenSftp}
              title="为当前会话打开文件面板"
            >
              <Folder size={13} /> 文件
            </button>
            <button
              className="status-action danger"
              onClick={onDisconnect}
              title="断开当前会话"
            >
              <X size={13} /> 断开
            </button>
            <span className="status-sep" />
          </>
        )}
        <button
          className="status-action"
          onClick={onOpenSettings}
          title="设置 (Ctrl+,)"
        >
          <Settings size={13} /> 设置
        </button>
        <span className="status-sep" />
        <ThemePicker />
        <span className="status-sep" />
        <span className="badge">SSH</span>
        <span>simpl-ssh v0.7.0</span>
      </div>
    </div>
  );
}
