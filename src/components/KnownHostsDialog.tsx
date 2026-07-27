import { useEffect, useState } from "react";
import { Copy, Shield, Trash2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { KnownHostEntry } from "../types";

type Props = { onClose: () => void };

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  borderBottom: "1px solid var(--border)",
};
const hostStyle: React.CSSProperties = { fontWeight: 600, minWidth: 160 };
const algStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 12,
  color: "var(--text-dim, #9aa0a6)",
  minWidth: 120,
};
const fpStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 12,
  color: "var(--text-dim, #9aa0a6)",
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/**
 * 已知主机（known_hosts）管理面板：列出 ~/.ssh/known_hosts 条目，
 * 支持查看指纹并删除（调 hostkey_remove）。后端命令 hostkey_list / hostkey_remove。
 */
export function KnownHostsDialog({ onClose }: Props) {
  const [entries, setEntries] = useState<KnownHostEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function refresh(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      setEntries(await invoke<KnownHostEntry[]>("hostkey_list"));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function remove(host: string, port: number): Promise<void> {
    if (!window.confirm(`删除 ${host}${port === 22 ? "" : `:${port}`} 的已知主机记录？`))
      return;
    try {
      await invoke("hostkey_remove", { host, port });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <div className="dialog-title">
            <Shield size={16} /> 已知主机 (known_hosts)
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">
          {loading ? (
            <div className="conn-msg">加载中…</div>
          ) : error ? (
            <div className="dialog-error">{error}</div>
          ) : entries.length === 0 ? (
            <div className="conn-msg">暂无已知主机记录</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {entries.map((e) => (
                <div style={rowStyle} key={`${e.host}:${e.line}`}>
                  <span style={hostStyle}>
                    {e.hashed ? "(已哈希主机)" : `${e.host}${e.port === 22 ? "" : `:${e.port}`}`}
                  </span>
                  <span style={algStyle}>{e.algorithm}</span>
                  <span style={fpStyle} title={e.fingerprint}>
                    {e.fingerprint}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    title="复制指纹"
                    onClick={() => void writeText(e.fingerprint)}
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    title="删除"
                    onClick={() => void remove(e.host, e.port)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
