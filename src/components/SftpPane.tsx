import { useEffect, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Archive,
  Bookmark,
  Copy,
  File as FileIcon,
  Folder,
  FolderPlus,
  FolderSync,
  Lock,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { ConnectionEnvironment, FileEntry } from "../types";
import { SyncDialog } from "./SyncDialog";
import { TransferConfirmDialog, type OverwriteChoice } from "./TransferConfirmDialog";
import { LoadingState } from "./LoadingState";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useActivity } from "../activity/ActivityProvider";
import { logicalDropPoint, resolveSftpDropTarget } from "../utils/sftpDropTarget";

type Props = {
  sessionId: string;
  /** 由项目工作区指定时，首次打开的远程目录。 */
  initialPath?: string;
  /** 双击远程文件时在编辑器中打开 */
  onFileOpen?: (filePath: string) => void;
  /** 只有当前可见的文件标签响应系统级拖放事件。 */
  active?: boolean;
  /** 连接环境只影响危险操作确认，不影响传输协议。 */
  environment?: ConnectionEnvironment | null;
};

/**
 * SFTP 双面板：左侧本地 + 右侧远程，中间跨面板传输按钮（→ 上传 / ← 下载）。
 * 传输走全局 TransferQueue（非阻塞），进度/暂停/重试见 TransferPanel。
 */
export function SftpPane({ sessionId, initialPath, onFileOpen, active = true, environment }: Props) {
  // 远程侧
  const [cwd, setCwd] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  // 本地侧
  const [localCwd, setLocalCwd] = useState("");
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([]);
  const [localSelected, setLocalSelected] = useState<string[]>([]);

  const [remoteLoading, setRemoteLoading] = useState(false);
  const [localLoading, setLocalLoading] = useState(false);
  const [remoteError, setRemoteError] = useState("");
  const [localError, setLocalError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [pendingTransfer, setPendingTransfer] = useState<{
    direction: "upload" | "download";
    names: string[];
    paths?: string[];
    destinationDir?: string;
  } | null>(null);
  const [operation, setOperation] = useState<SftpOperation | null>(null);
  const remoteRequestRef = useRef(0);
  const localRequestRef = useRef(0);
  const sessionRef = useRef(sessionId);
  const remotePanelRef = useRef<HTMLDivElement>(null);
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);
  sessionRef.current = sessionId;
  const { add: addActivity } = useActivity();
  const [filterText, setFilterText] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "size" | "modified">("name");
  const [bookmarks, setBookmarks] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("sftp-bookmarks") || "[]");
    } catch {
      return [];
    }
  });
  const [recentPaths, setRecentPaths] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("sftp-recent-paths") || "[]"); } catch { return []; }
  });
  function rememberRecentPath(path: string) {
    if (!path) return;
    setRecentPaths((current) => {
      const next = [path, ...current.filter((item) => item !== path)].slice(0, 12);
      localStorage.setItem("sftp-recent-paths", JSON.stringify(next));
      return next;
    });
  }
  function persistBookmarks(b: string[]) {
    setBookmarks(b);
    localStorage.setItem("sftp-bookmarks", JSON.stringify(b));
  }
  function addBookmark() {
    if (cwd && !bookmarks.includes(cwd)) persistBookmarks([...bookmarks, cwd]);
  }
  function gotoBookmark(p: string) {
    if (p) load(p);
  }

  async function load(path?: string) {
    const requestId = ++remoteRequestRef.current;
    const requestedSession = sessionId;
    setRemoteLoading(true);
    setRemoteError("");
    try {
      const [resolved, list] = await invoke<[string, FileEntry[]]>("sftp_list", {
        sessionId,
        path: path ?? null,
      });
      if (requestId !== remoteRequestRef.current || sessionRef.current !== requestedSession) return;
      setCwd(resolved);
      setPathInput(resolved);
      setEntries(list);
      setSelected([]);
      rememberRecentPath(resolved);
    } catch (e) {
      if (requestId === remoteRequestRef.current && sessionRef.current === requestedSession) { const message = String(e); setRemoteError(message); addActivity({ id: `sftp:remote:${requestedSession}:${message}`, kind: "sftp", severity: "error", title: "远程文件加载失败", detail: message, referenceId: requestedSession }); }
    } finally {
      if (requestId === remoteRequestRef.current && sessionRef.current === requestedSession) setRemoteLoading(false);
    }
  }

  async function loadLocal(path?: string) {
    const requestId = ++localRequestRef.current;
    setLocalLoading(true);
    setLocalError("");
    try {
      const dir = path ?? localCwd;
      if (!dir) {
        const home = await invoke<string>("local_home_dir");
        if (requestId === localRequestRef.current && sessionRef.current === sessionId) return loadLocal(home);
        return;
      }
      const list = await invoke<FileEntry[]>("local_list_dir", { path: dir });
      if (requestId !== localRequestRef.current || sessionRef.current !== sessionId) return;
      setLocalCwd(dir);
      setLocalEntries(list);
      setLocalSelected([]);
    } catch (e) {
      if (requestId === localRequestRef.current && sessionRef.current === sessionId) { const message = String(e); setLocalError(message); addActivity({ id: `sftp:local:${message}`, kind: "sftp", severity: "error", title: "本地文件加载失败", detail: message }); }
    } finally {
      if (requestId === localRequestRef.current && sessionRef.current === sessionId) setLocalLoading(false);
    }
  }

  useEffect(() => {
    remoteRequestRef.current += 1;
    localRequestRef.current += 1;
    setRemoteError("");
    setLocalError("");
    setRemoteLoading(true);
    setLocalLoading(true);
    if (!active) return;
    void load(initialPath || undefined);
    void loadLocal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId, initialPath]);

  function remoteDropTarget(position: { x: number; y: number }): string | null {
    const point = logicalDropPoint(position, window.devicePixelRatio);
    return resolveSftpDropTarget(document.elementFromPoint(point.x, point.y) as HTMLElement | null, remotePanelRef.current, cwd);
  }

  // 拖拽上传是 webview 级事件；仅当前可见的远程文件面板接收投放。
  useEffect(() => {
    if (!active) return;
    let un: (() => void) | undefined;
    let disposed = false;
    const webview = getCurrentWebview();
    webview
      .onDragDropEvent((e) => {
        if (e.payload.type === "enter" || e.payload.type === "over") {
          setDropTargetDir(remoteDropTarget(e.payload.position));
          return;
        }
        if (e.payload.type === "leave") { setDropTargetDir(null); return; }
        if (e.payload.type === "drop") {
          const destinationDir = remoteDropTarget(e.payload.position);
          setDropTargetDir(null);
          if (!destinationDir) return;
          const paths = e.payload.paths;
          setPendingTransfer({
            direction: "upload",
            paths,
            destinationDir,
            names: paths.map((path) => path.split(/[\\/]/).filter(Boolean).pop() ?? "file"),
          });
        }
      })
      .then((fn) => { if (disposed) fn(); else un = fn; });
    return () => { disposed = true; un?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId, cwd]);

  const sep = localCwd.includes("\\") ? "\\" : "/";
  const join = (name: string) => (cwd === "/" ? `/${name}` : `${cwd}/${name}`);
  const remoteJoin = (directory: string, name: string) => directory === "/" ? `/${name}` : `${directory.replace(/\/$/, "")}/${name}`;
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

  function toggleSelection(
    setter: Dispatch<SetStateAction<string[]>>,
    name: string,
    additive: boolean
  ) {
    setter((previous) => {
      if (!additive) return [name];
      return previous.includes(name)
        ? previous.filter((item) => item !== name)
        : [...previous, name];
    });
  }

  /** → 上传：本地选中 → 远程当前目录。先展示同名策略。 */
  function crossUpload() {
    if (localSelected.length === 0) return;
    setPendingTransfer({ direction: "upload", names: localSelected });
  }

  async function enqueueUpload(names: string[], overwrite: OverwriteChoice) {
    setError("");
    try {
      for (const name of names) {
        const entry = localEntries.find((e) => e.name === name);
        await invoke("transfer_enqueue", {
          sessionId,
          kind: entry?.is_dir ? "uploadDir" : "upload",
          localPath: localJoin(name),
          remotePath: join(name),
          overwrite,
        });
      }
      setLocalSelected([]);
    } catch (e) {
      const message = String(e); setError(message); addActivity({ id: `sftp:upload:${sessionId}:${message}`, kind: "sftp", severity: "error", title: "上传入队失败", detail: message, referenceId: sessionId });
    }
  }

  async function enqueueDropped(paths: string[], overwrite: OverwriteChoice, destinationDir: string) {
    setError("");
    try {
      for (const path of paths) {
        const name = path.split(/[\\/]/).filter(Boolean).pop() ?? "file";
        const isDirectory = await invoke<boolean>("local_path_is_dir", { path });
        await invoke("transfer_enqueue", {
          sessionId,
          kind: isDirectory ? "uploadDir" : "upload",
          localPath: path,
          remotePath: remoteJoin(destinationDir, name),
          overwrite,
        });
      }
    } catch (e) {
      const message = String(e); setError(message); addActivity({ id: `sftp:drop:${sessionId}:${message}`, kind: "sftp", severity: "error", title: "拖放上传失败", detail: message, referenceId: sessionId });
    }
  }

  /** ← 下载：远程选中 → 本地当前目录。先展示同名策略。 */
  function crossDownload() {
    if (selected.length === 0) return;
    setPendingTransfer({ direction: "download", names: selected });
  }

  async function enqueueDownload(names: string[], overwrite: OverwriteChoice) {
    setError("");
    try {
      for (const name of names) {
        await invoke("transfer_enqueue", {
          sessionId,
          kind: "download",
          localPath: localJoin(name),
          remotePath: join(name),
          overwrite,
        });
      }
      setSelected([]);
    } catch (e) {
      const message = String(e); setError(message); addActivity({ id: `sftp:download:${sessionId}:${message}`, kind: "sftp", severity: "error", title: "下载入队失败", detail: message, referenceId: sessionId });
    }
  }

  async function runOperation(value?: string) {
    if (!operation) return;
    setBusy(true);
    setError("");
    try {
      if (operation.kind === "mkdir" && value) {
        await invoke("sftp_mkdir", { sessionId, path: join(value) });
      } else if (operation.kind === "rename" && value) {
        await invoke("sftp_rename", { sessionId, from: join(operation.names[0]), to: join(value) });
      } else if (operation.kind === "chmod" && value) {
        await Promise.all(operation.names.map((name) => invoke("sftp_chmod", { sessionId, path: join(name), mode: value })));
      } else if (operation.kind === "copy" && value) {
        await invoke("sftp_copy", { sessionId, src: join(operation.names[0]), dst: join(value) });
      } else if (operation.kind === "delete") {
        await Promise.all(operation.entries.map((entry) => invoke("sftp_remove", { sessionId, path: join(entry.name), isDir: entry.is_dir })));
      }
      await load();
      setOperation(null);
    } catch (e) {
      const message = String(e); setError(message); addActivity({ id: `sftp:operation:${sessionId}:${message}`, kind: "sftp", severity: "error", title: "SFTP 操作失败", detail: message, referenceId: sessionId });
    } finally {
      setBusy(false);
    }
  }

  /** 归档：选中 .tar.gz/.tgz → 解压到当前目录；否则 → 打包为 .tar.gz */
  async function archive() {
    if (selected.length !== 1) return;
    const selectedName = selected[0];
    setBusy(true);
    setError("");
    try {
      const isArchive = /\.(tar\.gz|tgz)$/.test(selectedName);
      if (isArchive) {
        await invoke("sftp_untar", { sessionId, src: join(selectedName), dir: cwd });
      } else {
        await invoke("sftp_tar", { sessionId, src: join(selectedName), dst: join(`${selectedName}.tar.gz`) });
      }
      await load();
    } catch (e) {
      const message = String(e); setError(message); addActivity({ id: `sftp:archive:${sessionId}:${message}`, kind: "sftp", severity: "error", title: "归档操作失败", detail: message, referenceId: sessionId });
    } finally {
      setBusy(false);
    }
  }

  function onPathEnter(e: KeyboardEvent) {
    if (e.key === "Enter") load(pathInput);
  }

  // 文件名筛选（本地+远程共用）
  const filter = filterText.trim().toLowerCase();
  const vis = (es: FileEntry[]) => {
    const filtered = filter ? es.filter((e) => e.name.toLowerCase().includes(filter)) : es;
    return [...filtered].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      if (sortBy === "size") return b.size - a.size || a.name.localeCompare(b.name);
      if (sortBy === "modified") return (b.modified ?? "").localeCompare(a.modified ?? "") || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
  };

  return (
    <div className="sftp">
      <div className="sftp-toolbar">
        <button className="icon-btn" title="远程上一级" aria-label="远程上一级" onClick={() => load(parent())} disabled={!cwd}>
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
        <input
          className="sftp-filter"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="筛选…"
          spellCheck={false}
        />
        <select className="sftp-sort" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)} title="文件排序">
          <option value="name">按名称</option>
          <option value="size">按大小</option>
          <option value="modified">按时间</option>
        </select>
        <button className="icon-btn" title="刷新远程" aria-label="刷新远程目录" onClick={() => load()}>
          <RefreshCw size={15} />
        </button>
        <div className="sftp-sep" />
        <button className="icon-btn" title="新建远程文件夹" aria-label="新建远程文件夹" onClick={() => setOperation({ kind: "mkdir", names: [], entries: [] })} disabled={busy}>
          <FolderPlus size={15} />
        </button>
        <button className="icon-btn" title="重命名" aria-label="重命名选中项" onClick={() => setOperation({ kind: "rename", names: selected, entries: [] })} disabled={busy || selected.length !== 1}>
          <Pencil size={14} />
        </button>
        <button className="icon-btn danger" title="删除" aria-label="删除选中项" onClick={() => setOperation({ kind: "delete", names: selected, entries: entries.filter((entry) => selected.includes(entry.name)) })} disabled={busy || selected.length === 0}>
          <Trash2 size={15} />
        </button>
        <button className="icon-btn" title="权限 (chmod)" aria-label="修改选中项权限" onClick={() => setOperation({ kind: "chmod", names: selected, entries: [] })} disabled={busy || selected.length === 0}>
          <Lock size={14} />
        </button>
        <button className="icon-btn" title="复制" aria-label="复制选中文件" onClick={() => setOperation({ kind: "copy", names: selected, entries: [] })} disabled={busy || selected.length !== 1}>
          <Copy size={14} />
        </button>
        <button
          className="icon-btn"
          title="归档（压缩/解压 tar.gz）"
          aria-label="归档或解压选中项"
          onClick={archive}
          disabled={busy || selected.length !== 1}
        >
          <Archive size={14} />
        </button>
        <button className="icon-btn" title="目录同步" aria-label="打开目录同步" onClick={() => setShowSync(true)}>
          <FolderSync size={15} />
        </button>
      </div>

      {error && <div className="sftp-error"><span>{error}</span><button type="button" onClick={() => setError("")}>关闭</button></div>}

      <div className="sftp-dual">
        <div className="sftp-col">
          <div className="sftp-col-head">
            <button
              className="icon-btn"
              title="本地上一级"
              aria-label="本地上一级"
              onClick={() => loadLocal(localParent())}
            >
              <ArrowUp size={14} />
            </button>
            <span className="sftp-col-path" title={localCwd}>
              本地 · {localCwd}
            </span>
            <button className="icon-btn" title="刷新本地" aria-label="刷新本地目录" onClick={() => loadLocal()}>
              <RefreshCw size={13} />
            </button>
          </div>
          <div className="sftp-list">
            <FileList
              entries={vis(localEntries)}
              selected={localSelected}
              onSelect={(name, additive) => toggleSelection(setLocalSelected, name, additive)}
              onSelectMany={setLocalSelected}
              onEnter={localEnter}
              emptyHint="空目录"
              loading={localLoading}
              error={localError}
              onRetry={() => void loadLocal()}
            />
          </div>
        </div>

        <div className="sftp-col-actions">
          <button
            className="icon-btn"
            title="上传 →"
            aria-label="上传选中的本地文件"
            onClick={() => crossUpload()}
            disabled={localSelected.length === 0}
          >
            <ArrowRight size={18} />
          </button>
          <button
            className="icon-btn"
            title="← 下载"
            aria-label="下载选中的远程文件"
            onClick={() => crossDownload()}
            disabled={selected.length === 0}
          >
            <ArrowLeft size={18} />
          </button>
        </div>

        <div ref={remotePanelRef} className={`sftp-col sftp-remote-drop-zone ${dropTargetDir === cwd || dropTargetDir === "/" && cwd === "/" ? "drop-current" : ""}`}>
          <div className="sftp-col-head">
            <SftpBreadcrumb path={cwd || "/"} onNavigate={(path) => void load(path)} />
            <button
              className="icon-btn"
              title="收藏当前远程目录"
              aria-label="收藏当前远程目录"
              onClick={addBookmark}
              disabled={!cwd}
            >
              <Bookmark size={13} />
            </button>
            <select
              className="sftp-bookmark-select"
              value=""
              onChange={(e) => gotoBookmark(e.target.value)}
              title="书签快速跳转"
            >
              <option value="">书签 ({bookmarks.length})</option>
              {bookmarks.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <select className="sftp-bookmark-select" value="" onChange={(event) => event.target.value && void load(event.target.value)} title="最近访问目录">
              <option value="">最近 ({recentPaths.length})</option>
              {recentPaths.map((path) => <option key={path} value={path}>{path}</option>)}
            </select>
          </div>
          <div className="sftp-list">
            <FileList
              entries={vis(entries)}
              selected={selected}
              onSelect={(name, additive) => toggleSelection(setSelected, name, additive)}
              onSelectMany={setSelected}
              onEnter={enter}
              emptyHint="空目录"
              loading={remoteLoading}
              error={remoteError}
              onRetry={() => void load()}
              remoteBase={cwd || "/"}
              dropTargetDir={dropTargetDir}
            />
          </div>
        </div>
      </div>

      {showSync && (
        <SyncDialog
          sessionId={sessionId}
          remoteDir={cwd || "/"}
          production={environment === "production"}
          onClose={() => setShowSync(false)}
        />
      )}
      {pendingTransfer && (
        <TransferConfirmDialog
          direction={pendingTransfer.direction}
          count={pendingTransfer.names.length}
          source={pendingTransfer.paths ? pendingTransfer.paths.join("\n") : pendingTransfer.direction === "upload" ? pendingTransfer.names.map(localJoin).join("\n") : pendingTransfer.names.map(join).join("\n")}
          destination={pendingTransfer.direction === "upload" ? pendingTransfer.names.map((name) => remoteJoin(pendingTransfer.destinationDir || cwd || "/", name)).join("\n") : pendingTransfer.names.map(localJoin).join("\n")}
          production={environment === "production"}
          onClose={() => setPendingTransfer(null)}
          onConfirm={async (overwrite) => {
            const pending = pendingTransfer;
            setPendingTransfer(null);
            if (pending.paths) await enqueueDropped(pending.paths, overwrite, pending.destinationDir || cwd || "/");
            else if (pending.direction === "upload") await enqueueUpload(pending.names, overwrite);
            else await enqueueDownload(pending.names, overwrite);
          }}
        />
      )}
      {operation && <SftpOperationDialog operation={operation} cwd={cwd} busy={busy} production={environment === "production"} onClose={() => !busy && setOperation(null)} onConfirm={runOperation} />}
    </div>
  );
}

/** 文件列表渲染（本地/远程共用）。 */
function FileList({
  entries,
  selected,
  onSelect,
  onSelectMany,
  onEnter,
  emptyHint,
  loading,
  error,
  onRetry,
  remoteBase,
  dropTargetDir,
}: {
  entries: FileEntry[];
  selected: string[];
  onSelect: (name: string, additive: boolean) => void;
  onSelectMany: (names: string[]) => void;
  onEnter: (e: FileEntry) => void;
  emptyHint: string;
  loading: boolean;
  error?: string;
  onRetry?: () => void;
  remoteBase?: string;
  dropTargetDir?: string | null;
}) {
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const anchorRef = useRef<string | null>(null);
  if (loading) return <LoadingState compact label="正在加载目录…" />;
  if (error) return <div className="sftp-empty sftp-list-error"><span>{error}</span>{onRetry && <button type="button" onClick={onRetry}>重试</button>}</div>;
  if (entries.length === 0) return <div className="sftp-empty">{emptyHint}</div>;
  const selectRange = (name: string) => {
    const anchor = anchorRef.current ?? name;
    const a = entries.findIndex((entry) => entry.name === anchor);
    const b = entries.findIndex((entry) => entry.name === name);
    if (a < 0 || b < 0) return onSelectMany([name]);
    onSelectMany(entries.slice(Math.min(a, b), Math.max(a, b) + 1).map((entry) => entry.name));
  };
  return (
    <div role="listbox" aria-multiselectable="true" className="sftp-listbox">
      {entries.map((e, index) => {
        const remoteDir = remoteBase && e.is_dir ? (remoteBase === "/" ? `/${e.name}` : `${remoteBase.replace(/\/$/, "")}/${e.name}`) : undefined;
        return (
        <div
          key={e.name}
          ref={(node) => { if (node) rowRefs.current.set(e.name, node); else rowRefs.current.delete(e.name); }}
          data-sftp-drop-dir={remoteDir}
          className={`sftp-row ${selected.includes(e.name) ? "sel" : ""} ${remoteDir && dropTargetDir === remoteDir ? "drop-target" : ""}`}
          role="option"
          aria-selected={selected.includes(e.name)}
          tabIndex={0}
          onClick={(event) => { if (event.shiftKey) selectRange(e.name); else { anchorRef.current = e.name; onSelect(e.name, event.metaKey || event.ctrlKey); } }}
          onDoubleClick={() => onEnter(e)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); onEnter(e); }
            if (event.key === " ") { event.preventDefault(); anchorRef.current = e.name; onSelect(e.name, true); }
            if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
              event.preventDefault();
              const targetIndex = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
              const target = entries[targetIndex];
              rowRefs.current.get(target.name)?.focus();
              if (event.shiftKey) selectRange(target.name); else { anchorRef.current = target.name; onSelect(target.name, false); }
            }
          }}
        >
          <span className="sftp-icon">
            {e.is_dir ? <Folder size={15} /> : <FileIcon size={15} />}
          </span>
          <span className="sftp-name">{e.name}{e.is_symlink ? " →" : ""}</span>
          <span className="sftp-size">{e.is_dir ? "" : fmtSize(e.size)}</span>
          <span className="sftp-time">{e.modified ?? ""}</span>
        </div>
      );})}
    </div>
  );
}

function SftpBreadcrumb({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const parts = path.split("/").filter(Boolean);
  return <nav className="sftp-breadcrumb" aria-label="远程目录路径"><button type="button" onClick={() => onNavigate("/")} aria-label="远程根目录">/</button>{parts.map((part, index) => { const target = `/${parts.slice(0, index + 1).join("/")}`; return <span key={target}><i>/</i><button type="button" title={target} onClick={() => onNavigate(target)}>{part}</button></span>; })}</nav>;
}

type SftpOperationKind = "mkdir" | "rename" | "delete" | "chmod" | "copy";
type SftpOperation = { kind: SftpOperationKind; names: string[]; entries: FileEntry[] };

function SftpOperationDialog({ operation, cwd, busy, production, onClose, onConfirm }: { operation: SftpOperation; cwd: string; busy: boolean; production: boolean; onClose: () => void; onConfirm: (value?: string) => void }) {
  const [value, setValue] = useState(operation.kind === "chmod" ? "644" : operation.kind === "copy" ? `${operation.names[0]}_copy` : operation.names[0] ?? "");
  const [acknowledged, setAcknowledged] = useState(false);
  const [productionPhrase, setProductionPhrase] = useState("");
  const isDelete = operation.kind === "delete";
  const hasDirectory = operation.entries.some((entry) => entry.is_dir);
  const dialogRef = useDialogFocus(true, () => {
    if (!busy) onClose();
  });
  const title: Record<SftpOperationKind, string> = { mkdir: "新建远程文件夹", rename: "重命名远程文件", delete: "确认删除", chmod: "修改权限", copy: "复制远程文件" };
  const inputLabel: Partial<Record<SftpOperationKind, string>> = { mkdir: "文件夹名称", rename: "新名称", chmod: "权限（如 755）", copy: "目标文件名或路径" };
  return (
    <div className="overlay" onClick={busy ? undefined : onClose}>
      <div ref={dialogRef} className="dialog sftp-operation-dialog" role="dialog" aria-modal="true" aria-labelledby="sftp-operation-title" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head"><div className="dialog-title" id="sftp-operation-title">{title[operation.kind]}</div><button type="button" aria-label="关闭" disabled={busy} onClick={onClose}>×</button></div>
        <div className="dialog-body">
          {isDelete ? <>
            <p className="sftp-danger-copy">将从远程主机永久删除以下 {operation.names.length} 项。{hasDirectory ? "目录删除可能失败（非空目录），请先确认其内容。" : ""}</p>
            <div className="sftp-operation-paths">{operation.names.map((name) => <code key={name}>{cwd === "/" ? `/${name}` : `${cwd}/${name}`}</code>)}</div>
            <label className="check"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> 我已确认这些远程路径和影响范围</label>
            {production && <label className="field sftp-production-confirm">这是生产环境。输入“生产”以删除<input value={productionPhrase} onChange={(event) => setProductionPhrase(event.target.value)} placeholder="生产" /></label>}
          </> : <div className="field"><label>{inputLabel[operation.kind]}</label><input value={value} autoFocus onChange={(event) => setValue(event.target.value)} /></div>}
        </div>
        <div className="dialog-foot"><button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>取消</button><button type="button" className={`btn ${isDelete ? "btn-danger" : "btn-primary"}`} disabled={busy || (isDelete ? (!acknowledged || (production && productionPhrase.trim() !== "生产")) : !value.trim())} onClick={() => onConfirm(isDelete ? undefined : value.trim())}>{busy ? "处理中…" : isDelete ? "删除" : "确认"}</button></div>
      </div>
    </div>
  );
}

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
