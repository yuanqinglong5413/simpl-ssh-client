//! Git 远程操作：通过 SSH exec channel 执行 git 命令并解析结构化输出。
//!
//! 参考 `monitor.rs` 的 `exec_on_session` 模式，复用已有的 SSH 会话。

use std::sync::Arc;

use serde::Serialize;

// =============================  数据结构  ================================

/// git status 结果。
#[derive(Debug, Clone, Serialize)]
pub struct GitStatusResult {
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileStatus>,
}

/// 单个文件的 git 状态。
#[derive(Debug, Clone, Serialize)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String, // "modified" | "added" | "deleted" | "untracked" | "renamed"
    pub staged: bool,
}

/// git log 条目。
#[derive(Debug, Clone, Serialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub date: String,
    pub message: String,
}

/// git diff 结果。
#[derive(Debug, Clone, Serialize)]
pub struct GitDiffResult {
    pub path: String,
    pub diff: String,
}

/// git branch 条目。
#[derive(Debug, Clone, Serialize)]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
}

/// git worktree 条目。
#[derive(Debug, Clone, Serialize)]
pub struct GitWorktree {
    pub path: String,
    pub branch: String,
    pub is_bare: bool,
}

// =============================  执行 helper  ==============================

/// 在会话上执行一条 git 命令。
pub(crate) async fn exec_git(
    handle: &Arc<russh::client::Handle<super::ClientHandler>>,
    repo_path: &str,
    git_args: &str,
) -> Result<String, String> {
    let cmd = format!("cd {} && git {}", shellescape(repo_path), git_args);
    exec_on_session(handle, &cmd).await
}

/// 在会话上执行命令并收集 stdout+stderr。
async fn exec_on_session(
    handle: &Arc<russh::client::Handle<super::ClientHandler>>,
    command: &str,
) -> Result<String, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel
        .exec(true, command)
        .await
        .map_err(|e| e.to_string())?;

    let mut out = String::new();
    while let Some(msg) = channel.wait().await {
        use russh::ChannelMsg;
        match msg {
            ChannelMsg::Data { data } => {
                out.push_str(&String::from_utf8_lossy(&data));
            }
            ChannelMsg::ExtendedData { data, .. } => {
                out.push_str(&String::from_utf8_lossy(&data));
            }
            ChannelMsg::ExitStatus { exit_status } => {
                if exit_status != 0 && out.is_empty() {
                    return Err(format!("git 命令退出码 {exit_status}"));
                }
            }
            ChannelMsg::Eof => break,
            _ => {}
        }
    }
    Ok(out)
}

/// 简单的 shell 转义（单引号包裹）。
fn shellescape(s: &str) -> String {
    if s.contains('\'') {
        format!("'{}'", s.replace('\'', "'\\''"))
    } else {
        format!("'{s}'")
    }
}

// =============================  解析函数  ================================

/// 解析 `git status --porcelain=v2 --branch` 输出。
pub fn parse_status(raw: &str) -> GitStatusResult {
    let mut branch = String::from("unknown");
    let mut upstream: Option<String> = None;
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;
    let mut files = Vec::new();

    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            upstream = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // +N -M
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() == 2 {
                ahead = parts[0].trim_start_matches('+').parse().unwrap_or(0);
                behind = parts[1].trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            // 普通/重命名条目
            // 格式: "1 XY sub mH mI mW hH hI path"
            // 或:   "2 XY sub mH mI mW hH hI Xscore Yscore path\tpathOrig"
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 9 {
                let xy = parts[1];
                let path = if line.starts_with("2 ") && parts.len() >= 11 {
                    // 重命名：path 是第 10 列（index 9），含 tab
                    parts
                        .get(9)
                        .unwrap_or(&"")
                        .split('\t')
                        .next()
                        .unwrap_or("")
                        .to_string()
                } else {
                    parts[8..].join(" ")
                };

                let index_status = xy.chars().next().unwrap_or('.');
                let worktree_status = xy.chars().nth(1).unwrap_or('.');

                if index_status != '.' {
                    files.push(GitFileStatus {
                        path: path.clone(),
                        status: status_char_to_string(index_status),
                        staged: true,
                    });
                }
                if worktree_status != '.' {
                    files.push(GitFileStatus {
                        path,
                        status: status_char_to_string(worktree_status),
                        staged: false,
                    });
                }
            }
        } else if line.starts_with("? ") {
            let path = line[2..].to_string();
            files.push(GitFileStatus {
                path,
                status: "untracked".to_string(),
                staged: false,
            });
        }
    }

    GitStatusResult {
        branch,
        upstream,
        ahead,
        behind,
        files,
    }
}

fn status_char_to_string(c: char) -> String {
    match c {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "typechanged",
        _ => "unknown",
    }
    .to_string()
}

/// 解析 `git log --format="%H|%h|%an|%aI|%s" -n {count}` 输出。
pub fn parse_log(raw: &str) -> Vec<GitLogEntry> {
    raw.lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(5, '|').collect();
            if parts.len() >= 5 {
                Some(GitLogEntry {
                    hash: parts[0].to_string(),
                    short_hash: parts[1].to_string(),
                    author: parts[2].to_string(),
                    date: parts[3].to_string(),
                    message: parts[4].to_string(),
                })
            } else {
                None
            }
        })
        .collect()
}

/// 解析 `git diff` 输出为按文件分块的结果。
pub fn parse_diff(raw: &str) -> Vec<GitDiffResult> {
    let mut results = Vec::new();
    let mut current_path = String::new();
    let mut current_diff = String::new();

    for line in raw.lines() {
        if line.starts_with("diff --git ") {
            if !current_path.is_empty() {
                results.push(GitDiffResult {
                    path: current_path.clone(),
                    diff: current_diff.clone(),
                });
            }
            // 提取 b/path
            current_path = line
                .split_whitespace()
                .last()
                .unwrap_or("")
                .trim_start_matches("b/")
                .to_string();
            current_diff = String::new();
        }
        current_diff.push_str(line);
        current_diff.push('\n');
    }

    if !current_path.is_empty() {
        results.push(GitDiffResult {
            path: current_path,
            diff: current_diff,
        });
    }

    results
}

/// 解析 `git branch -a --format="%(refname:short)|%(HEAD)"` 输出。
pub fn parse_branches(raw: &str) -> Vec<GitBranch> {
    raw.lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() >= 2 {
                let name = parts[0].trim().to_string();
                let is_current = parts[1].trim() == "*";
                let is_remote = name.starts_with("origin/") || name.starts_with("remotes/");
                Some(GitBranch {
                    name,
                    is_current,
                    is_remote,
                })
            } else {
                None
            }
        })
        .collect()
}

/// 解析 `git worktree list --porcelain` 输出。
pub fn parse_worktrees(raw: &str) -> Vec<GitWorktree> {
    let mut worktrees = Vec::new();
    let mut current_path = String::new();
    let mut current_branch = String::new();
    let mut current_bare = false;

    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            if !current_path.is_empty() {
                worktrees.push(GitWorktree {
                    path: current_path.clone(),
                    branch: current_branch.clone(),
                    is_bare: current_bare,
                });
            }
            current_path = rest.to_string();
            current_branch = String::new();
            current_bare = false;
        } else if let Some(rest) = line.strip_prefix("branch ") {
            current_branch = rest.strip_prefix("refs/heads/").unwrap_or(rest).to_string();
        } else if line == "bare" {
            current_bare = true;
        }
    }

    if !current_path.is_empty() {
        worktrees.push(GitWorktree {
            path: current_path,
            branch: current_branch,
            is_bare: current_bare,
        });
    }

    worktrees
}
