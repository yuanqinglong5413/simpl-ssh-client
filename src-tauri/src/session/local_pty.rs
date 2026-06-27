//! 本地 PTY 终端：使用 portable-pty 创建跨平台本地 shell。
//!
//! 复用现有 TerminalBridge 的 WebSocket 桥接架构：
//! - 前端调 `local_terminal_open(cwd, cols, rows)` → 返回 port+token
//! - 前端连本地 WS，发送 token
//! - WS handler 取出 mpsc 管道，与本地 PTY 串接

use std::io::{Read, Write};
use std::sync::Arc;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::mpsc;
use tokio::sync::Mutex;

use super::pty::{TerminalBridge, TerminalPipes};

/// 管理一个本地 PTY 的 master（用于 resize）和 writer（用于写入）。
pub struct LocalPtyHandle {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

/// 存储活跃的本地 PTY，用于 resize 和写入。
pub struct LocalPtyRegistry {
    ptys: Mutex<std::collections::HashMap<String, LocalPtyHandle>>,
}

impl Default for LocalPtyRegistry {
    fn default() -> Self {
        Self {
            ptys: Mutex::new(std::collections::HashMap::new()),
        }
    }
}

impl LocalPtyRegistry {
    /// 注册一个本地 PTY。
    pub async fn register(
        &self,
        id: String,
        master: Box<dyn portable_pty::MasterPty + Send>,
        writer: Box<dyn Write + Send>,
    ) {
        self.ptys
            .lock()
            .await
            .insert(id, LocalPtyHandle { master, writer });
    }

    /// 调整指定 PTY 的窗口大小。
    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let guard = self.ptys.lock().await;
        let handle = guard
            .get(id)
            .ok_or_else(|| format!("local pty not found: {id}"))?;
        handle
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    /// 写入数据到 PTY stdin。
    pub async fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let mut guard = self.ptys.lock().await;
        let handle = guard
            .get_mut(id)
            .ok_or_else(|| format!("local pty not found: {id}"))?;
        handle.writer.write_all(data).map_err(|e| e.to_string())?;
        handle.writer.flush().map_err(|e| e.to_string())
    }

    /// 移除并关闭 PTY。
    pub async fn remove(&self, id: &str) {
        self.ptys.lock().await.remove(id);
    }
}

/// 在本地打开一个终端，返回 TerminalHandle（port + token）。
pub async fn open_local_terminal(
    bridge: &Arc<TerminalBridge>,
    registry: &Arc<LocalPtyRegistry>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<crate::commands::TerminalHandle, String> {
    let pty_system = native_pty_system();

    // 检测系统 shell
    let shell = detect_shell();
    let mut cmd = CommandBuilder::new(&shell.program);
    if let Some(ref arg) = shell.arg {
        cmd.arg(arg);
    }

    // 设置工作目录
    if let Some(ref dir) = cwd {
        cmd.cwd(dir);
    } else if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    cmd.env("TERM", "xterm-256color");

    // 创建 PTY
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // spawn 子进程
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn shell: {e}"))?;

    // 获取 master、reader 和 writer
    let master = pair.master;
    let mut reader = master
        .try_clone_reader()
        .map_err(|e| format!("failed to clone reader: {e}"))?;
    let writer = master
        .take_writer()
        .map_err(|e| format!("failed to take writer: {e}"))?;

    // 创建 mpsc 管道
    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(64);
    let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(64);
    let (resize_tx, mut resize_rx) = mpsc::channel::<(u32, u32)>(8);

    let pty_id = uuid::Uuid::new_v4().to_string();

    // 注册 PTY（用于 resize 和写入）
    registry.register(pty_id.clone(), master, writer).await;

    // spawn reader 线程：PTY stdout → output_tx
    let output_tx_clone = output_tx.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = buf[..n].to_vec();
                    if output_tx_clone.blocking_send(data).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // spawn writer 任务：input_rx → PTY stdin
    let pty_id_for_writer = pty_id.clone();
    let registry_for_writer = registry.clone();
    tokio::spawn(async move {
        while let Some(data) = input_rx.recv().await {
            if registry_for_writer
                .write(&pty_id_for_writer, &data)
                .await
                .is_err()
            {
                break;
            }
        }
    });

    // spawn resize 任务：resize_rx → PTY resize
    let pty_id_for_resize = pty_id.clone();
    let registry_for_resize = registry.clone();
    tokio::spawn(async move {
        while let Some((c, r)) = resize_rx.recv().await {
            let _ = registry_for_resize
                .resize(&pty_id_for_resize, c as u16, r as u16)
                .await;
        }
    });

    // spawn 子进程监控：等待退出
    let pty_id_for_exit = pty_id.clone();
    let registry_for_exit = registry.clone();
    tokio::spawn(async move {
        let _ = child.wait();
        registry_for_exit.remove(&pty_id_for_exit).await;
        drop(output_tx);
    });

    // 注册到 TerminalBridge
    let pipes = TerminalPipes {
        input_tx,
        output_rx,
        resize_tx,
    };
    let token = bridge.register(pipes).await;

    Ok(crate::commands::TerminalHandle {
        port: bridge.port,
        token,
    })
}

struct ShellInfo {
    program: String,
    arg: Option<String>,
}

fn detect_shell() -> ShellInfo {
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() {
            return ShellInfo {
                program: shell,
                arg: Some("-l".to_string()),
            };
        }
    }

    #[cfg(target_os = "windows")]
    {
        ShellInfo {
            program: "powershell.exe".to_string(),
            arg: None,
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        ShellInfo {
            program: "/bin/bash".to_string(),
            arg: Some("-l".to_string()),
        }
    }
}
