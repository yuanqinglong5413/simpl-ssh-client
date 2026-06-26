//! PTY + WebSocket 终端传输。
//!
//! 设计：
//! - 前端 `terminal_open(session_id)` → 后端在该会话上开 PTY channel，起一个桥接 task
//!   **拥有**该 channel，把 channel 与一对 mpsc 管道（输入 / 输出）串接；
//!   管道按 token 登记到 `TerminalBridge`。
//! - 前端再连本地 WS（首条消息 = token），WS handler 取出管道，把 mpsc 与 WS 串接。
//!
//! 之所以用 mpsc 中转：russh 的 `Channel<Msg>` 类型参数 `Msg` 未导出，无法在
//! `HashMap` 中命名该类型；channel 只能在创建它的 task 内被拥有（靠类型推断）。

use std::collections::HashMap;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

/// 前端经 WS 发来的控制消息（终端 resize 等）。
#[derive(Debug, Deserialize)]
struct WsControlMsg {
    #[serde(rename = "type")]
    msg_type: String,
    cols: u32,
    rows: u32,
}

/// 一个终端的输入 / 输出 / 尺寸管道。
pub struct TerminalPipes {
    /// 前端按键 → 发到此 Sender → 桥接 task 写进 channel。
    pub input_tx: mpsc::Sender<Vec<u8>>,
    /// 桥接 task 从 channel 读出 → 发到此管道 → WS handler 从 Receiver 取。
    pub output_rx: mpsc::Receiver<Vec<u8>>,
    /// 前端窗口尺寸变化 → 桥接 task 调用 channel.window_change。
    pub resize_tx: mpsc::Sender<(u32, u32)>,
}

/// 终端桥：本地 WS 服务 + token→pipes 映射。作为 Tauri State（包成 `Arc`）注入。
pub struct TerminalBridge {
    pub port: u16,
    pipes: Mutex<HashMap<String, TerminalPipes>>,
}

impl TerminalBridge {
    /// 绑定 `127.0.0.1` 随机端口并启动 WS accept 循环。
    pub async fn start() -> anyhow::Result<Arc<Self>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let bridge = Arc::new(Self {
            port,
            pipes: Mutex::new(HashMap::new()),
        });
        let bridge_clone = bridge.clone();
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, addr)) => {
                        let b = bridge_clone.clone();
                        tokio::spawn(async move {
                            if let Err(e) = b.handle_connection(stream).await {
                                tracing::warn!(%addr, error = %e, "terminal ws connection ended");
                            }
                        });
                    }
                    Err(e) => tracing::warn!(%e, "terminal ws accept error"),
                }
            }
        });
        Ok(bridge)
    }

    /// 登记一对管道，返回一次性 token。
    pub async fn register(&self, pipes: TerminalPipes) -> String {
        let token = Uuid::new_v4().to_string();
        self.pipes.lock().await.insert(token.clone(), pipes);
        token
    }

    /// 取出并移除 token 对应的管道（一次性：每次 open 对应一次 WS 连接）。
    pub async fn take(&self, token: &str) -> Option<TerminalPipes> {
        self.pipes.lock().await.remove(token)
    }

    async fn handle_connection(&self, stream: tokio::net::TcpStream) -> anyhow::Result<()> {
        let ws = tokio_tungstenite::accept_async(stream).await?;
        let (mut ws_out, mut ws_in) = ws.split();

        // 协议：第一条消息必须是 token（文本）。
        let token = match ws_in.next().await {
            Some(Ok(Message::Text(t))) => t.as_str().to_string(),
            _ => anyhow::bail!("expected terminal token as first ws message"),
        };

        let TerminalPipes {
            input_tx,
            mut output_rx,
            resize_tx,
        } = self
            .take(&token)
            .await
            .ok_or_else(|| anyhow::anyhow!("unknown terminal token"))?;

        loop {
            tokio::select! {
                // 前端 → WS → channel
                msg = ws_in.next() => match msg {
                    Some(Ok(Message::Binary(b))) => {
                        if input_tx.send(b.to_vec()).await.is_err() { break; }
                    }
                    Some(Ok(Message::Text(t))) => {
                        /* 控制消息：{"type":"resize","cols":N,"rows":M} */
                        if let Ok(ctrl) = serde_json::from_str::<WsControlMsg>(&t) {
                            if ctrl.msg_type == "resize" && ctrl.cols > 0 && ctrl.rows > 0 {
                                if resize_tx.send((ctrl.cols, ctrl.rows)).await.is_err() {
                                    break;
                                }
                                continue;
                            }
                        }
                        if input_tx.send(t.as_str().as_bytes().to_vec()).await.is_err() { break; }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                },
                // channel → WS → 前端
                out = output_rx.recv() => match out {
                    Some(bytes) => {
                        ws_out.send(Message::binary(bytes)).await?;
                    }
                    None => {
                        let _ = ws_out.close().await;
                        break;
                    }
                },
            }
        }
        Ok(())
    }
}
