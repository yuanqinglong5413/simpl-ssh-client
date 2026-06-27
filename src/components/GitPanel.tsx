import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  GitBranch,
  GitCommit,
  RefreshCw,
  Loader2,
  FolderTree,
} from "lucide-react";
import type {
  GitStatusResult,
  GitLogEntry,
  GitBranch as GitBranchType,
  GitWorktree,
  GitDiffResult,
} from "../types";
import { GitDiffView } from "./GitDiffView";

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
    if (!window.confirm(`删除 worktree: ${path}？`)) return;
    setError("");
    try {
      await invoke("git_worktree_remove", { sessionId, repoPath, path });
      await fetchWorktrees();
    } catch (e) {
      setError(String(e));
    }
  }

  if (loading && !status) {
    return (
      <div className="git-panel">
        <div className="git-empty">
          <Loader2 className="spin" size={20} />
          <span>加载 Git 状态…</span>
        </div>
      </div>
    );
  }

  return (
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
                  onClick={() => removeWorktree(w.path)}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
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
