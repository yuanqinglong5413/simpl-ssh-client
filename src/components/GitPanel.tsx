import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  GitBranch,
  GitCommit,
  RefreshCw,
  FolderTree,
  Upload,
  Download,
} from "lucide-react";
import type {
  GitStatusResult,
  GitLogEntry,
  GitBranch as GitBranchType,
  GitWorktree,
  GitDiffResult,
  GitFileStatus,
} from "../types";
import { GitDiffView } from "./GitDiffView";
import { ConfirmDialog } from "./DialogPrimitives";
import { ErrorState, LoadingState } from "./LoadingState";

type Props = {
  sessionId: string;
  repoPath: string;
  onOpenFile?: (filePath: string) => void;
};

type Tab = "changes" | "log" | "worktrees";

/**
 * Git 状态面板：展示仓库状态、提交历史、Worktree 管理。
 */
export function GitPanel({ sessionId, repoPath, onOpenFile }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("changes");
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [logs, setLogs] = useState<GitLogEntry[]>([]);
  const [branches, setBranches] = useState<GitBranchType[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [diffs, setDiffs] = useState<GitDiffResult[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [pendingWorktreeRemoval, setPendingWorktreeRemoval] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const result = await invoke<GitStatusResult>("git_status", {
        sessionId,
        repoPath,
      });
      setStatus(result);
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId, repoPath]);

  const fetchBranches = useCallback(async () => {
    try {
      const result = await invoke<GitBranchType[]>("git_branches", {
        sessionId,
        repoPath,
      });
      setBranches(result);
    } catch {
      /* ignore */
    }
  }, [sessionId, repoPath]);

  const fetchLog = useCallback(async () => {
    try {
      const result = await invoke<GitLogEntry[]>("git_log", {
        sessionId,
        repoPath,
        count: 30,
      });
      setLogs(result);
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId, repoPath]);

  const fetchWorktrees = useCallback(async () => {
    try {
      const result = await invoke<GitWorktree[]>("git_worktree_list", {
        sessionId,
        repoPath,
      });
      setWorktrees(result);
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId, repoPath]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    await Promise.all([fetchStatus(), fetchBranches()]);
    if (activeTab === "log") await fetchLog();
    if (activeTab === "worktrees") await fetchWorktrees();
    setLoading(false);
  }, [fetchStatus, fetchBranches, fetchLog, fetchWorktrees, activeTab]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, repoPath]);

  async function viewDiff(filePath: string, staged?: boolean) {
    setSelectedFile(filePath);
    try {
      const result = await invoke<GitDiffResult[]>("git_diff", {
        sessionId,
        repoPath,
        filePath,
        staged: staged ?? false,
      });
      setDiffs(result);
    } catch (e) {
      setError(String(e));
    }
  }

  async function checkoutBranch(branch: string) {
    setError("");
    try {
      await invoke("git_checkout", { sessionId, repoPath, branch });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function removeWorktree(path: string) {
    setError("");
    try {
      await invoke("git_worktree_remove", { sessionId, repoPath, path });
      await fetchWorktrees();
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleStage(f: GitFileStatus) {
    setError("");
    try {
      if (f.staged) {
        await invoke("git_unstage", { sessionId, repoPath, path: f.path });
      } else {
        await invoke("git_add", { sessionId, repoPath, path: f.path });
      }
      await fetchStatus();
    } catch (e) {
      setError(String(e));
    }
  }

  async function doCommit() {
    if (!commitMsg.trim()) return;
    setError("");
    try {
      await invoke("git_commit", { sessionId, repoPath, message: commitMsg });
      setCommitMsg("");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function doPush() {
    setError("");
    try {
      await invoke("git_push", { sessionId, repoPath });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function doPull() {
    setError("");
    try {
      await invoke("git_pull", { sessionId, repoPath });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  if (loading && !status) {
    return (
      <div className="git-panel">
        <LoadingState label="加载 Git 状态…" />
      </div>
    );
  }

  if (!status && error) return <div className="git-panel"><ErrorState label="无法读取 Git 状态" message={error} onRetry={() => void refresh()} /></div>;

  return (
    <>
    <div className="git-panel">
      <div className="git-header">
        <div className="git-branch-info">
          <GitBranch size={14} />
          <span className="git-branch-name">{status?.branch ?? "—"}</span>
          {status && status.ahead + status.behind > 0 && (
            <span className="git-ahead-behind">
              ↑{status.ahead} ↓{status.behind}
            </span>
          )}
        </div>
        <div className="git-actions">
          <button className="icon-btn" title="pull --ff-only" onClick={doPull}>
            <Download size={14} />
          </button>
          <button className="icon-btn" title="push" onClick={doPush}>
            <Upload size={14} />
          </button>
          <button className="icon-btn" title="刷新" onClick={refresh}>
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {error && <div className="git-error">{error}</div>}

      <div className="git-tabs">
        <button
          className={activeTab === "changes" ? "active" : ""}
          onClick={() => setActiveTab("changes")}
        >
          变更 {status ? `(${status.files.length})` : ""}
        </button>
        <button
          className={activeTab === "log" ? "active" : ""}
          onClick={() => {
            setActiveTab("log");
            if (logs.length === 0) fetchLog();
          }}
        >
          <GitCommit size={12} /> 历史
        </button>
        <button
          className={activeTab === "worktrees" ? "active" : ""}
          onClick={() => {
            setActiveTab("worktrees");
            if (worktrees.length === 0) fetchWorktrees();
          }}
        >
          <FolderTree size={12} /> Worktrees
        </button>
      </div>

      {activeTab === "changes" && (
        <div className="git-changes">
          {branches.length > 1 && (
            <div className="git-branch-switcher">
              <select
                value={status?.branch ?? ""}
                onChange={(e) => checkoutBranch(e.target.value)}
              >
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name} {b.isCurrent ? "(当前)" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="git-file-list">
            {status?.files.length === 0 ? (
              <div className="git-empty-state">工作区干净，没有变更</div>
            ) : (
              status?.files.map((f) => (
                <div
                  key={f.path}
                  className={`git-file-row ${selectedFile === f.path ? "sel" : ""}`}
                  onClick={() => viewDiff(f.path, f.staged)}
                  onDoubleClick={() => onOpenFile?.(f.path)}
                >
                  <span className={`git-status-badge ${f.status}`}>
                    {statusChar(f.status)}
                  </span>
                  <span className="git-file-path">{f.path}</span>
                  {f.staged && <span className="git-staged-tag">staged</span>}
                  <button
                    className="icon-btn git-stage-btn"
                    title={f.staged ? "取消暂存" : "暂存"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleStage(f);
                    }}
                  >
                    {f.staged ? "−" : "+"}
                  </button>
                </div>
              ))
            )}
          </div>

          {selectedFile && diffs.length > 0 && (
            <div className="git-diff-section">
              <div className="git-diff-header">{selectedFile}</div>
              <GitDiffView diffs={diffs} />
            </div>
          )}

          <div className="git-commit-box">
            <textarea
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder="提交信息（commit message）"
              rows={2}
              spellCheck={false}
            />
            <button
              className="btn btn-primary"
              onClick={doCommit}
              disabled={!commitMsg.trim()}
            >
              提交
            </button>
          </div>
        </div>
      )}

      {activeTab === "log" && (
        <div className="git-log">
          {logs.length === 0 ? (
            <div className="git-empty-state">没有提交记录</div>
          ) : (
            logs.map((l) => (
              <div key={l.hash} className="git-log-row">
                <span className="git-log-hash">{l.shortHash}</span>
                <span className="git-log-msg">{l.message}</span>
                <span className="git-log-meta">
                  {l.author} · {l.date}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === "worktrees" && (
        <div className="git-worktrees">
          {worktrees.length === 0 ? (
            <div className="git-empty-state">没有 worktree</div>
          ) : (
            worktrees.map((w) => (
              <div key={w.path} className="git-worktree-row">
                <span className="git-wt-path">{w.path}</span>
                <span className="git-wt-branch">{w.branch}</span>
                <button
                  className="icon-btn danger"
                  title="删除"
                  aria-label={`删除 worktree ${w.path}`}
                  onClick={() => setPendingWorktreeRemoval(w.path)}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
    {pendingWorktreeRemoval && <ConfirmDialog title="删除 Git worktree" confirmLabel="删除 worktree" danger onClose={() => setPendingWorktreeRemoval(null)} onConfirm={() => { const path = pendingWorktreeRemoval; setPendingWorktreeRemoval(null); void removeWorktree(path); }}><p>将删除远程 worktree：</p><code>{pendingWorktreeRemoval}</code><p>请确认没有未提交的修改。</p></ConfirmDialog>}
    </>
  );
}

function statusChar(status: string): string {
  switch (status) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "untracked":
      return "?";
    case "renamed":
      return "R";
    default:
      return status[0]?.toUpperCase() ?? "?";
  }
}
