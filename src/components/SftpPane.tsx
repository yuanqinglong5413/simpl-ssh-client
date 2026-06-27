import { useEffect, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowUp,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  FolderUp,
  FolderSync,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import type { FileEntry } from "../types";
import { SyncDialog } from "./SyncDialog";

type Props = {
  sessionId: string;
  /** 双击文件时在编辑器中打开 */
  onFileOpen?: (filePath: string) => void;
};

/**
 * SFTP 文件面板：浏览远程文件系统，进入目录、上传/下载（入传输队列，非阻塞）、
 * 新建 / 重命名 / 删除。上传/下载不再阻塞 UI——选好本地路径即入队，
 * 进度与状态见全局 TransferPanel。
 */
export function SftpPane({ sessionId, onFileOpen }: Props) {
  const [cwd, setCwd] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSync, setShowSync] = useState(false);

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

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const join = (name: string) => (cwd === "/" ? `/${name}` : `${cwd}/${name}`);
  const parent = () => "/" + cwd.split("/").filter(Boolean).slice(0, -1).join("/");

  function enter(e: FileEntry) {
    if (e.is_dir) {
      load(join(e.name));
    } else if (onFileOpen) {
      onFileOpen(join(e.name));
    } else {
      download(join(e.name));
    }
  }

  function baseName(p: string): string {
    return p.split("/").filter(Boolean).pop() ?? p;
  }

  async function upload() {
    setError("");
    try {
      const files = await invoke<string[]>("sftp_select_local_files");
      for (const p of files) {
        await invoke("transfer_enqueue", {
          sessionId,
          kind: "upload",
          localPath: p,
          remotePath: join(baseName(p)),
        });
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function uploadDir() {
    setError("");
    try {
      const folder = await invoke<string | null>("sftp_select_folder", {
        title: "选择要上传的文件夹",
      });
      if (!folder) return;
      await invoke("transfer_enqueue", {
        sessionId,
        kind: "uploadDir",
        localPath: folder,
        remotePath: join(baseName(folder)),
      });
    } catch (e) {
      setError(String(e));
    }
  }

  async function download(remotePath: string) {
    setError("");
    try {
      const dest = await invoke<string | null>("sftp_select_folder", {
        title: "选择保存位置（下载到该文件夹下）",
      });
      if (!dest) return;
      const name = baseName(remotePath);
      const local = dest.endsWith("/") ? `${dest}${name}` : `${dest}/${name}`;
      await invoke("transfer_enqueue", {
        sessionId,
        kind: "download",
        localPath: local,
        remotePath,
      });
    } catch (e) {
      setError(String(e));
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
      await invoke("sftp_rename", {
        sessionId,
        from: join(selected),
        to: join(to),
      });
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
        <button
          className="icon-btn"
          title="新建文件夹"
          onClick={mkdir}
          disabled={busy}
        >
          <FolderPlus size={15} />
        </button>
        <button className="icon-btn" title="上传文件" onClick={upload}>
          <Upload size={15} />
        </button>
        <button className="icon-btn" title="上传文件夹" onClick={uploadDir}>
          <FolderUp size={15} />
        </button>
        <button
          className="icon-btn"
          title="目录同步"
          onClick={() => setShowSync(true)}
        >
          <FolderSync size={15} />
        </button>
        <button
          className="icon-btn"
          title="下载"
          onClick={() => selected && download(join(selected))}
          disabled={!selected}
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

      {showSync && (
        <SyncDialog
          sessionId={sessionId}
          remoteDir={cwd || "/"}
          onClose={() => setShowSync(false)}
        />
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
