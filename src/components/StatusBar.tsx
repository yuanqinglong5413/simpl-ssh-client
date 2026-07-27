import { Folder, Activity, Settings, X, GitBranch, Radio, TerminalSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SessionInfo } from "../types";
import { ThemePicker } from "./ThemePicker";

type Props = {
  session: SessionInfo | null;
  tabCount: number;
  onOpenSftp: () => void;
  onOpenMonitor: () => void;
  onOpenGit: () => void;
  onDisconnect: () => void;
  onOpenSettings: () => void;
  onOpenCommandPalette?: () => void;
  broadcastEnabled: boolean;
  onToggleBroadcast: () => void;
  onOpenSnippets: () => void;
};

export function StatusBar({
  session,
  tabCount,
  onOpenSftp,
  onOpenMonitor,
  onOpenGit,
  onDisconnect,
  onOpenSettings,
  onOpenCommandPalette,
  broadcastEnabled,
  onToggleBroadcast,
  onOpenSnippets,
}: Props) {
  const { t } = useTranslation();
  return (
    <div className="statusbar">
      <div className="status-left">
        <span className={`pulse ${session ? "" : "idle"}`} />
        {session ? (
          <span>
            {t("status.connected")} · {session.user}@{session.host}:{session.port}
            {session.jump_via ? `（经 ${session.jump_via}）` : ""}
          </span>
        ) : (
          <span>
            {t("status.ready")} · {tabCount} {t("status.panels")}
          </span>
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
              <Activity size={13} /> {t("status.monitor")}
            </button>
            <button
              className="status-action"
              onClick={onOpenGit}
              title="为当前会话打开 Git 面板"
            >
              <GitBranch size={13} /> Git
            </button>
            <button
              className="status-action"
              onClick={onOpenSftp}
              title="为当前会话打开文件面板"
            >
              <Folder size={13} /> {t("status.files")}
            </button>
            <button
              className="status-action danger"
              onClick={onDisconnect}
              title="断开当前会话"
            >
              <X size={13} /> {t("status.disconnect")}
            </button>
            <span className="status-sep" />
          </>
        )}
        <button
          className={`status-action ${broadcastEnabled ? "active" : ""}`}
          onClick={onToggleBroadcast}
          title="多会话广播输入（开关）：开启后输入同步到所有已打开终端"
        >
          <Radio size={13} /> {t("status.broadcast")}
        </button>
        <button
          className="status-action"
          onClick={onOpenSnippets}
          title="常用命令片段（管理 / ⌘K 搜「片段:」注入终端）"
        >
          <TerminalSquare size={13} /> {t("status.snippets")}
        </button>
        <button
          className="status-action"
          onClick={onOpenSettings}
          title="设置 (Ctrl+,)"
        >
          <Settings size={13} /> {t("status.settings")}
        </button>
        <span className="status-sep" />
        <ThemePicker />
        <span className="status-sep" />
        <span className="badge">SSH</span>
        {onOpenCommandPalette && (
          <button
            className="status-action"
            onClick={onOpenCommandPalette}
            title="命令面板 (⌘K)"
          >
            ⌘K
          </button>
        )}
        <span>simpl-ssh v0.10.1</span>
      </div>
    </div>
  );
}
