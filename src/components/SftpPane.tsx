import { useEffect, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  File as FileIcon,
  Folder,
  FolderPlus,
  FolderSync,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { FileEntry } from "../types";
import { SyncDialog } from "./SyncDialog";

type Props = {
  sessionId: string;
  /** 双击远程文件时在编辑器中打开 */
  onFileOpen?: (filePath: string) => void;
};

/**
 * SFTP 双面板：左侧本地 + 右侧远程，中间跨面板传输按钮（→ 上传 / ← 下载）。
 * 传输走全局 TransferQueue（非阻塞），进度/暂停/重试见 TransferPanel。
 */
export function SftpPane({ sessionId, onFileOpen }: Props) {
  // 远程侧
  const [cwd, setCwd] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // 本地侧
  const [localCwd, setLocalCwd] = useState("");
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([]);
  const [localSelected, setLocalSelected] = useState<string | null>(null);

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

  async function loadLocal(path?: string) {
    setError("");
    try {
      const dir = path ?? localCwd;
      if (!dir) {
        const home = await invoke<string>("local_home_dir");
        return loadLocal(home);
      }
      const list = await invoke<FileEntry[]>("local_list_dir", { path: dir });
      setLocalCwd(dir);
      setLocalEntries(list);
      setLocalSelected(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
    loadLocal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const sep = localCwd.includes("\\") ? "\\" : "/";
  const join = (name: string) => (cwd === "/" ? `/${name}` : `${cwd}/${name}`);
  const parent = () => "/" + cwd.split("/").filter(Boolean).slice(0, -1).join("/");
  const localJoin = (name: string) =>
    localCwd.endsWith(sep) ? `${localCwd}${name}` : `${localCwd}${sep}${name}`;
  const localParent = () => {
    const parts = localCwd.split(/[\\/]/).filter(Boolean);
    parts.pop();
    if (parts.length === 0) return localCwd;
    return (localCwd.startsWith("/") ? "/" : "") + parts.join(sep);
  };

  function enter(e: FileEntry) {
    if (e.is_dir) {
      load(join(e.name));
    } else if (onFileOpen) {
      onFileOpen(join(e.name));
    }
  }
  function localEnter(e: FileEntry) {
    if (e.is_dir) loadLocal(localJoin(e.name));
  }

  /** → 上传：本地选中 → 远程当前目录 */
  async function crossUpload() {
    if (!localSelected) return;
    const entry = localEntries.find((e) => e.name === localSelected);
    setError("");
    try {
      await invoke("transfer_enqueue", {
        sessionId,
        kind: entry?.is_dir ? "uploadDir" : "upload",
        localPath: localJoin(localSelected),
        remotePath: join(localSelected),
      });
    } catch (e) {
      setError(String(e));
    }
  }

  /** ← 下载：远程选中 → 本地当前目录 */
  async function crossDownload() {
    if (!selected) return;
    setError("");
    try {
      await invoke("transfer_enqueue", {
        sessionId,
        kind: "download",
        localPath: localJoin(selected),
        remotePath: join(selected),
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
      await invoke("sftp_remove", { sessionId, path: join(selected), isDir: entry.is_dir });
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
        <button className="icon-btn" title="远程上一级" onClick={() => load(parent())} disabled={!cwd}>
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
        <button className="icon-btn" title="刷新远程" onClick={() => load()}>
          <RefreshCw size={15} />
        </button>
        <div className="sftp-sep" />
        <button className="icon-btn" title="新建远程文件夹" onClick={mkdir} disabled={busy}>
          <FolderPlus size={15} />
        </button>
        <button className="icon-btn" title="重命名" onClick={rename} disabled={busy || !selected}>
          <Pencil size={14} />
        </button>
        <button className="icon-btn danger" title="删除" onClick={remove} disabled={busy || !selected}>
          <Trash2 size={15} />
        </button>
        <button className="icon-btn" title="目录同步" onClick={() => setShowSync(true)}>
          <FolderSync size={15} />
        </button>
      </div>

      {error && <div className="sftp-error">{error}</div>}

      <div className="sftp-dual">
        <div className="sftp-col">
          <div className="sftp-col-head">
            <button
              className="icon-btn"
              title="本地上一级"
              onClick={() => loadLocal(localParent())}
            >
              <ArrowUp size={14} />
            </button>
            <span className="sftp-col-path" title={localCwd}>
              本地 · {localCwd}
            </span>
            <button className="icon-btn" title="刷新本地" onClick={() => loadLocal()}>
              <RefreshCw size={13} />
            </button>
          </div>
          <div className="sftp-list">
            <FileList
              entries={localEntries}
              selected={localSelected}
              onSelect={setLocalSelected}
              onEnter={localEnter}
              emptyHint="空目录"
              loading={false}
            />
          </div>
        </div>

        <div className="sftp-col-actions">
          <button
            className="icon-btn"
            title="上传 →"
            onClick={() => crossUpload()}
            disabled={!localSelected}
          >
            <ArrowRight size={18} />
          </button>
          <button
            className="icon-btn"
            title="← 下载"
            onClick={() => crossDownload()}
            disabled={!selected}
          >
            <ArrowLeft size={18} />
          </button>
        </div>

        <div className="sftp-col">
          <div className="sftp-col-head">
            <span className="sftp-col-path" title={cwd}>
              远程 · {cwd}
            </span>
          </div>
          <div className="sftp-list">
            <FileList
              entries={entries}
              selected={selected}
              onSelect={setSelected}
              onEnter={enter}
              emptyHint="空目录"
              loading={loading}
            />
          </div>
        </div>
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

/** 文件列表渲染（本地/远程共用）。 */
function FileList({
  entries,
  selected,
  onSelect,
  onEnter,
  emptyHint,
  loading,
}: {
  entries: FileEntry[];
  selected: string | null;
  onSelect: (name: string) => void;
  onEnter: (e: FileEntry) => void;
  emptyHint: string;
  loading: boolean;
}) {
  if (loading) return <div className="sftp-empty">加载中…</div>;
  if (entries.length === 0) return <div className="sftp-empty">{emptyHint}</div>;
  return (
    <>
      {entries.map((e) => (
        <div
          key={e.name}
          className={`sftp-row ${selected === e.name ? "sel" : ""}`}
          onClick={() => onSelect(e.name)}
          onDoubleClick={() => onEnter(e)}
        >
          <span className="sftp-icon">
            {e.is_dir ? <Folder size={15} /> : <FileIcon size={15} />}
          </span>
          <span className="sftp-name">{e.name}{e.is_symlink ? " →" : ""}</span>
          <span className="sftp-size">{e.is_dir ? "" : fmtSize(e.size)}</span>
          <span className="sftp-time">{e.modified ?? ""}</span>
        </div>
      ))}
    </>
  );
}

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
