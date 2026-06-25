import { useEffect, useState, type FormEvent } from "react";
import { Plug, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SessionInfo } from "../types";
import { ConnSteps } from "./ConnSteps";

type Progress = { stage: string; message: string };

type Props = {
  onClose: () => void;
  onConnected: (s: SessionInfo) => void;
};

export function ConnectDialog({ onClose, onConnected }: Props) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connectId, setConnectId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  // 连接期间监听后端推送的阶段进度（按 connectId 过滤）
  useEffect(() => {
    if (!connectId) return;
    setProgress({ stage: "resolve", message: "开始连接…" });
    let unlisten: (() => void) | undefined;
    listen<{ connect_id: string; stage: string; message: string }>(
      "ssh://progress",
      (e) => {
        if (e.payload.connect_id === connectId) {
          setProgress({ stage: e.payload.stage, message: e.payload.message });
        }
      }
    ).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [connectId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const id = crypto.randomUUID();
    setConnectId(id);
    try {
      const s = await invoke<SessionInfo>("ssh_connect", {
        connectId: id,
        host,
        port,
        user,
        password,
      });
      if (save && name.trim()) {
        await invoke("profile_save", {
          name: name.trim(),
          host,
          port,
          user,
          password,
        });
      }
      onConnected(s);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={busy ? undefined : onClose}>
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="dialog-head">
          <div className="dialog-title">
            <Plug size={16} /> 新建连接
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            disabled={busy}
          >
            <X size={16} />
          </button>
        </div>

        {busy && progress ? (
          <div className="conn-view">
            <div className="conn-spinner" />
            <div className="conn-msg">{progress.message}</div>
            <ConnSteps stage={progress.stage} />
          </div>
        ) : (
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
            <div className="field">
              <label>名称（保存时用）</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="我的服务器"
                disabled={!save}
              />
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={save}
                onChange={(e) => setSave(e.target.checked)}
              />
              保存这个连接（密码存入系统钥匙串，不落明文）
            </label>
          </div>
        )}

        {error && <div className="dialog-error">{error}</div>}

        <div className="dialog-foot">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={busy}
          >
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
