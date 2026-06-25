import { useState, type FormEvent } from "react";
import { Plug, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { SessionInfo } from "../types";

type Props = {
  onClose: () => void;
  onConnected: (s: SessionInfo) => void;
};

export function ConnectDialog({ onClose, onConnected }: Props) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const s = await invoke<SessionInfo>("ssh_connect", {
        host,
        port,
        user,
        password,
      });
      onConnected(s);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="dialog-head">
          <div className="dialog-title">
            <Plug size={16} /> 新建连接
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="dialog-body">
          <div className="row-2">
            <div className="field">
              <label>主机</label>
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.10"
                required
                autoFocus
              />
            </div>
            <div className="field">
              <label>端口</label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value) || 22)}
                min={1}
                max={65535}
              />
            </div>
          </div>
          <div className="field">
            <label>用户</label>
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="root"
              required
            />
          </div>
          <div className="field">
            <label>密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••"
            />
          </div>
        </div>

        {error && <div className="dialog-error">{error}</div>}

        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !host || !user}
          >
            {busy ? "连接中…" : "连接"}
          </button>
        </div>
      </form>
    </div>
  );
}
