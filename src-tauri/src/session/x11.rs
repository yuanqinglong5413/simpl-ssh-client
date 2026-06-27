//! X11 转发：SSH `request_x11` + 将远端 X11 channel 桥接到本地 DISPLAY。
//!
//! russh 只负责协议层，实际与本地 X Server 的 TCP/Unix 连接由本模块完成。

use std::path::PathBuf;

use russh::ChannelMsg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
#[cfg(unix)]
use tokio::net::UnixStream;

/// 生成 16 字节 Xauth cookie（十六进制）。
pub fn random_x11_cookie() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 读取本机 DISPLAY 环境变量（Linux/macOS 图形会话）。
pub fn local_display() -> Option<String> {
    std::env::var("DISPLAY").ok().filter(|s| !s.is_empty())
}

/// 将 SSH X11 channel 与本地 X Server 双向桥接。
pub async fn bridge_x11_channel(channel: russh::Channel<russh::client::Msg>, disp: &str) {
    let stream = match connect_display(disp).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(x11_disp = %disp, error = %e, "X11 本地 DISPLAY 连接失败");
            return;
        }
    };
    bridge_channel_stream(channel, stream).await;
}

enum X11Stream {
    Tcp(TcpStream),
    #[cfg(unix)]
    Unix(UnixStream),
}

impl X11Stream {
    async fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Self::Tcp(s) => s.read(buf).await,
            #[cfg(unix)]
            Self::Unix(s) => s.read(buf).await,
        }
    }

    async fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        match self {
            Self::Tcp(s) => s.write_all(buf).await,
            #[cfg(unix)]
            Self::Unix(s) => s.write_all(buf).await,
        }
    }
}

async fn connect_display(display: &str) -> Result<X11Stream, String> {
    #[cfg(unix)]
    {
        // Unix 路径形式（部分 macOS）
        if display.starts_with('/') {
            let s = UnixStream::connect(display)
                .await
                .map_err(|e| e.to_string())?;
            return Ok(X11Stream::Unix(s));
        }

        // :0 或 :0.0 → /tmp/.X11-unix/X0
        if display.starts_with(':') {
            let n: u32 = display
                .trim_start_matches(':')
                .split('.')
                .next()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let path = PathBuf::from(format!("/tmp/.X11-unix/X{n}"));
            if path.exists() {
                let s = UnixStream::connect(&path)
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok(X11Stream::Unix(s));
            }
            // 回退 TCP 6000+n
            let s = TcpStream::connect(("127.0.0.1", 6000 + n as u16))
                .await
                .map_err(|e| e.to_string())?;
            return Ok(X11Stream::Tcp(s));
        }
    }

    #[cfg(not(unix))]
    if display.starts_with(':') {
        let n: u16 = display
            .trim_start_matches(':')
            .split('.')
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let s = TcpStream::connect(("127.0.0.1", 6000 + n))
            .await
            .map_err(|e| e.to_string())?;
        return Ok(X11Stream::Tcp(s));
    }

    // host:display.screen 例如 localhost:10.0
    let (host, disp) = display
        .rsplit_once(':')
        .ok_or_else(|| format!("无法解析 DISPLAY: {display}"))?;
    let n: u16 = disp
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let port = 6000 + n;
    let host = if host.is_empty() { "127.0.0.1" } else { host };
    let s = TcpStream::connect((host, port))
        .await
        .map_err(|e| e.to_string())?;
    Ok(X11Stream::Tcp(s))
}

async fn bridge_channel_stream(
    mut channel: russh::Channel<russh::client::Msg>,
    mut stream: X11Stream,
) {
    let mut buf = vec![0u8; 65536];
    let mut stream_closed = false;
    loop {
        tokio::select! {
            r = stream.read(&mut buf), if !stream_closed => match r {
                Ok(0) => { stream_closed = true; let _ = channel.eof().await; }
                Ok(n) => { if channel.data(&buf[..n]).await.is_err() { break; } }
                Err(_) => break,
            },
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { ref data }) => {
                    if stream.write_all(data).await.is_err() { break; }
                }
                Some(ChannelMsg::Eof) => break,
                Some(ChannelMsg::WindowAdjusted { .. }) => {}
                _ => {}
            }
        }
    }
}
