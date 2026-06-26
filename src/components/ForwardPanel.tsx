import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";
import type { ForwardEntry, ForwardKind, SessionInfo } from "../types";

const KINDS: { value: ForwardKind; label: string }[] = [
  { value: "local", label: "-L 本地" },
  { value: "remote", label: "-R 远程" },
  { value: "dynamic", label: "-D 动态" },
];

/**
 * 端口转发面板（全局，浮动按钮 + 底部抽屉）：跨会话管理 -L/-R/-D 转发。
 * 添加表单选会话 + 类型 + 本地/远程参数；列表显示每条转发与状态，可停止。
 */
export function ForwardPanel() {
  const [open, setOpen] = useState(false);
  const [forwards, setForwards] = useState<ForwardEntry[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [kind, setKind] = useState<ForwardKind>("local");
  const [localAddr, setLocalAddr] = useState("127.0.0.1");
  const [localPort, setLocalPort] = useState(8080);
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePort, setRemotePort] = useState(80);
  const [error, setError] = useState("");

  useEffect(() => {
    const refresh = () => {
      invoke<ForwardEntry[]>("forward_list")
        .then(setForwards)
        .catch(() => {});
      invoke<SessionInfo[]>("ssh_list_sessions")
        .then(setSessions)
        .catch(() => {});
    };
    refresh();
    const iv = setInterval(refresh, 1000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (!sessionId && sessions.length > 0) setSessionId(sessions[0].id);
  }, [sessions, sessionId]);

  async function add() {
    setError("");
    try {
      await invoke("forward_add", {
        sessionId,
        kind,
        localAddr,
        localPort,
        remoteHost: kind === "dynamic" ? null : remoteHost || null,
        remotePort: kind === "dynamic" ? null : remotePort,
      });
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(id: string) {
    try {
      await invoke("forward_remove", { id });
    } catch {
      /* ignore */
    }
  }

  const showRemote = kind !== "dynamic";

  return (
    <>
      <button className="forward-fab" onClick={() => setOpen((o) => !o)}>
        转发{forwards.length > 0 ? ` (${forwards.length})` : ""}
        {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
      {open && (
        <div className="forward-panel">
          <div className="forward-head">
            <span>端口转发（{forwards.length}）</span>
            <button className="icon-btn" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>
          <div className="forward-form">
            <select
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
            >
              {sessions.length === 0 ? (
                <option value="">（无活动会话）</option>
              ) : (
                sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.user}@{s.host}
                  </option>
                ))
              )}
            </select>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as ForwardKind)}
            >
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
            <input
              value={localAddr}
              onChange={(e) => setLocalAddr(e.target.value)}
              placeholder="本地地址"
            />
            <input
              className="port"
              type="number"
              value={localPort}
              onChange={(e) => setLocalPort(Number(e.target.value) || 0)}
              placeholder="本地端口"
            />
            {showRemote && (
              <>
                <input
                  value={remoteHost}
                  onChange={(e) => setRemoteHost(e.target.value)}
                  placeholder="远程主机"
                />
                <input
                  className="port"
                  type="number"
                  value={remotePort}
                  onChange={(e) => setRemotePort(Number(e.target.value) || 0)}
                  placeholder="远程端口"
                />
              </>
            )}
            <button
              className="btn btn-primary"
              onClick={add}
              disabled={!sessionId}
            >
              <Plus size={14} /> 添加
            </button>
          </div>
          {error && <div className="forward-error">{error}</div>}
          <div className="forward-list">
            {forwards.length === 0 ? (
              <div className="forward-empty">暂无转发</div>
            ) : (
              forwards.map((f) => (
                <div key={f.id} className="forward-row">
                  <span className={`forward-badge k-${f.kind}`}>
                    {f.kind === "local"
                      ? "-L"
                      : f.kind === "remote"
                      ? "-R"
                      : "-D"}
                  </span>
                  <span className="forward-target" title={formatTarget(f)}>
                    {formatTarget(f)}
                  </span>
                  <span className={`forward-state s-${f.state}`}>
                    {stateLabel(f.state)}
                  </span>
                  <button
                    className="icon-btn danger"
                    title="停止"
                    onClick={() => remove(f.id)}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}

function formatTarget(f: ForwardEntry): string {
  const lp = f.localPort === 0 ? f.boundPort : f.localPort;
  if (f.kind === "dynamic") return `${f.localAddr}:${lp} (SOCKS5)`;
  if (f.kind === "remote")
    return `${f.remoteHost}:${f.remotePort ?? f.boundPort} ⇄ ${f.localAddr}:${f.localPort}`;
  return `${f.localAddr}:${lp} → ${f.remoteHost}:${f.remotePort}`;
}

function stateLabel(s: string): string {
  if (typeof s === "string") {
    return (
      (
        {
          starting: "启动中",
          active: "运行中",
          failed: "失败",
          stopped: "已停止",
        } as Record<string, string>
      )[s] ?? s
    );
  }
  return "失败";
}
