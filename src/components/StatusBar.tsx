import { useEffect, useState } from "react";
import { Folder, Activity, Settings, X, GitBranch, Radio, TerminalSquare, ListTodo } from "lucide-react";
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
  broadcastTargetCount: number;
  onToggleBroadcast: () => void;
  onOpenSnippets: () => void;
  onOpenTransfers: () => void;
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
  broadcastTargetCount,
  onToggleBroadcast,
  onOpenSnippets,
  onOpenTransfers,
}: Props) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(iv);
  }, []);
  return (
    <div className="statusbar">
      <div className="status-left">
        <span className={`pulse ${session ? "" : "idle"}`} />
        {session ? (
          <span>
            {t("status.connected")} · {session.user}@{session.host}:{session.port}
            {session.jump_via ? `（经 ${session.jump_via}）` : ""}
            {` · ${formatElapsed(now - Date.parse(session.created_at))}`}
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
          <Radio size={13} /> {t("status.broadcast")}{broadcastEnabled ? ` (${broadcastTargetCount})` : ""}
        </button>
        <button
          className="status-action"
          onClick={onOpenSnippets}
          title="常用命令片段（管理 / ⌘K 搜「片段:」注入终端）"
        >
          <TerminalSquare size={13} /> {t("status.snippets")}
        </button>
        <button className="status-action" onClick={onOpenTransfers} title={t("status.transfers")}>
          <ListTodo size={13} /> {t("status.transfers")}
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
        <span>simpl-ssh v0.11.1</span>
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  if (!isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
