import type { SessionInfo } from "../types";

type Props = {
  session: SessionInfo | null;
  tabCount: number;
};

export function StatusBar({ session, tabCount }: Props) {
  return (
    <div className="statusbar">
      <div className="status-left">
        <span className={`pulse ${session ? "" : "idle"}`} />
        {session ? (
          <span>
            已连接 · {session.user}@{session.host}:{session.port}
          </span>
        ) : (
          <span>就绪 · {tabCount} 个打开的终端</span>
        )}
      </div>
      <div className="status-right">
        <span className="badge">SSH</span>
        <span>simpl-ssh v0.1.0</span>
      </div>
    </div>
  );
}
