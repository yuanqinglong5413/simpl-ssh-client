import { useState } from "react";
import { FolderSync, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

type SyncMode = "mirror" | "upload" | "download";

type Props = {
  sessionId: string;
  remoteDir: string;
  onClose: () => void;
  onDone?: (msg: string) => void;
};

/**
 * 目录同步对话框：选择本地目录与同步方向，差异文件入传输队列。
 */
export function SyncDialog({ sessionId, remoteDir, onClose, onDone }: Props) {
  const [localDir, setLocalDir] = useState("");
  const [mode, setMode] = useState<SyncMode>("mirror");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function pickLocal() {
    try {
      const path = await invoke<string | null>("sftp_select_folder", {
        title: "选择本地同步目录",
      });
      if (path) setLocalDir(path);
    } catch (e) {
      setError(String(e));
    }
  }

  async function start() {
    if (!localDir.trim()) {
      setError("请选择本地目录");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await invoke<{
        upload_count: number;
        download_count: number;
      }>("sync_directory", {
        sessionId,
        localDir,
        remoteDir,
        mode,
      });
      onDone?.(
        `已入队 ${result.upload_count} 个上传、${result.download_count} 个下载任务`
      );
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay sync-overlay" onClick={busy ? undefined : onClose}>
      <div className="dialog sync-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <div className="dialog-title">
            <FolderSync size={16} /> 目录同步
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">
          <div className="field">
            <label>远程目录</label>
            <input value={remoteDir} readOnly className="readonly" />
          </div>
          <div className="field">
            <label>本地目录</label>
            <div className="key-row">
              <input
                value={localDir}
                onChange={(e) => setLocalDir(e.target.value)}
                placeholder="选择本地文件夹"
                className="key-path"
              />
              <button
                type="button"
                className="btn btn-ghost"
                onClick={pickLocal}
                disabled={busy}
              >
                浏览
              </button>
            </div>
          </div>
          <div className="field">
            <label>同步模式</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as SyncMode)}
              disabled={busy}
            >
              <option value="mirror">镜像（较新文件覆盖）</option>
              <option value="upload">仅上传（本地 → 远程）</option>
              <option value="download">仅下载（远程 → 本地）</option>
            </select>
          </div>
          <p className="sync-hint">
            同步会扫描两侧目录树，按修改时间与大小比对差异，任务进入全局传输队列。
          </p>
        </div>
        {error && <div className="dialog-error">{error}</div>}
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={start} disabled={busy}>
            {busy ? "扫描中…" : "开始同步"}
          </button>
        </div>
      </div>
    </div>
  );
}
