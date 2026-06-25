import { useEffect, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowUp,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  FolderUp,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import type { FileEntry } from "../types";

type Props = { sessionId: string };

type Progress = { name: string; transferred: number; total: number };

/**
 * SFTP 文件面板：在会话已建立的连接上浏览远程文件系统，
 * 支持进入目录、上传 / 下载（流式 + 进度）、新建 / 重命名 / 删除。
 */
export function SftpPane({ sessionId }: Props) {
  const [cwd, setCwd] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

  async function load(path?: string) {
    setLoading(true);
    setError("");
    try {
      const [resolved, list] = await invoke<[string, FileEntry[]]>("sftp_list", {
        sessionId,
        path: path ?? null,
      });
      setCwd(resolved);
      setPathInput(resolved);
      setEntries(list);
      setSelected(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // 打开时列家目录
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 监听传输进度
  useEffect(() => {
    const un = listen<Progress>("sftp://transfer", (e) => setProgress(e.payload));
    return () => {
      un.then((u) => u());
    };
  }, []);

  const join = (name: string) => (cwd === "/" ? `/${name}` : `${cwd}/${name}`);
  const parent = () => "/" + cwd.split("/").filter(Boolean).slice(0, -1).join("/");

  function enter(e: FileEntry) {
    if (e.is_dir) load(join(e.name));
    else download(join(e.name));
  }

  async function upload() {
    setBusy(true);
    setError("");
    setProgress(null);
    try {
      await invoke("sftp_upload", { sessionId, remoteDir: cwd || "/" });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function uploadDir() {
    setBusy(true);
    setError("");
    setProgress(null);
    try {
      await invoke("sftp_upload_dir", { sessionId, remoteDir: cwd || "/" });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function download(remotePath: string) {
    setBusy(true);
    setError("");
    setProgress(null);
    try {
      await invoke("sftp_download", { sessionId, remotePath });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function mkdir() {
    const name = window.prompt("新文件夹名称");
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      await invoke("sftp_mkdir", { sessionId, path: join(name) });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rename() {
    if (!selected) return;
    const to = window.prompt(`将 “${selected}” 重命名为`);
    if (!to) return;
    setBusy(true);
    setError("");
    try {
      await invoke("sftp_rename", { sessionId, from: join(selected), to: join(to) });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected) return;
    if (!window.confirm(`删除 “${selected}” ？`)) return;
    const entry = entries.find((x) => x.name === selected);
    if (!entry) return;
    setBusy(true);
    setError("");
    try {
      await invoke("sftp_remove", {
        sessionId,
        path: join(selected),
        isDir: entry.is_dir,
      });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function onPathEnter(e: KeyboardEvent) {
    if (e.key === "Enter") load(pathInput);
  }

  const pct =
    progress && progress.total > 0
      ? Math.round((progress.transferred / progress.total) * 100)
      : 0;

  return (
    <div className="sftp">
      <div className="sftp-toolbar">
        <button
          className="icon-btn"
          title="上一级"
          onClick={() => load(parent())}
          disabled={!cwd}
        >
          <ArrowUp size={15} />
        </button>
        <input
          className="sftp-addr"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={onPathEnter}
          spellCheck={false}
          placeholder="/"
        />
        <button className="icon-btn" title="刷新" onClick={() => load()}>
          <RefreshCw size={15} />
        </button>
        <div className="sftp-sep" />
        <button className="icon-btn" title="新建文件夹" onClick={mkdir} disabled={busy}>
          <FolderPlus size={15} />
        </button>
        <button className="icon-btn" title="上传文件" onClick={upload} disabled={busy}>
          <Upload size={15} />
        </button>
        <button className="icon-btn" title="上传文件夹" onClick={uploadDir} disabled={busy}>
          <FolderUp size={15} />
        </button>
        <button
          className="icon-btn"
          title="下载"
          onClick={() => selected && download(join(selected))}
          disabled={busy || !selected}
        >
          <Download size={15} />
        </button>
        <button
          className="icon-btn"
          title="重命名"
          onClick={rename}
          disabled={busy || !selected}
        >
          <Pencil size={14} />
        </button>
        <button
          className="icon-btn danger"
          title="删除"
          onClick={remove}
          disabled={busy || !selected}
        >
          <Trash2 size={15} />
        </button>
      </div>

      {error && <div className="sftp-error">{error}</div>}

      <div className="sftp-list">
        {loading ? (
          <div className="sftp-empty">加载中…</div>
        ) : entries.length === 0 ? (
          <div className="sftp-empty">空目录</div>
        ) : (
          entries.map((e) => (
            <div
              key={e.name}
              className={`sftp-row ${selected === e.name ? "sel" : ""}`}
              onClick={() => setSelected(e.name)}
              onDoubleClick={() => enter(e)}
            >
              <span className="sftp-icon">
                {e.is_dir ? <Folder size={15} /> : <FileIcon size={15} />}
              </span>
              <span className="sftp-name">
                {e.name}
                {e.is_symlink ? " →" : ""}
              </span>
              <span className="sftp-size">{e.is_dir ? "" : fmtSize(e.size)}</span>
              <span className="sftp-time">{e.modified ?? ""}</span>
            </div>
          ))
        )}
      </div>

      {(busy || progress) && (
        <div className="sftp-progress">
          {progress ? (
            <>
              <span className="sftp-pname">{progress.name}</span>
              <div className="bar">
                <div style={{ width: `${pct}%` }} />
              </div>
              <span className="sftp-pct">{pct}%</span>
            </>
          ) : (
            <span>处理中…</span>
          )}
        </div>
      )}
    </div>
  );
}

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
