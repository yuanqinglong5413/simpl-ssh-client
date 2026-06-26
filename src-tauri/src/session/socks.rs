//! SOCKS5 服务端握手（RFC 1928，仅无认证 + CONNECT）。
//!
//! 用于动态端口转发（`-D`）：监听本地端口，对每个进来的连接先做 SOCKS5 握手，
//! 解析出客户端要连的目标 host:port，再经 SSH `direct-tcpip` 通道连出去。

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// 完成 SOCKS5 握手，返回目标 `(host, port)`。失败返回 `None`（不合法协议 / 非 CONNECT）。
/// 失败时会向客户端回写对应的错误应答后由调用方关闭连接。
pub async fn socks5_handshake(stream: &mut TcpStream) -> Option<(String, u16)> {
    // 1) 版本 + 方法数
    let mut hdr = [0u8; 2];
    if stream.read_exact(&mut hdr).await.is_err() {
        return None;
    }
    if hdr[0] != 0x05 {
        return None;
    }
    let nmethods = hdr[1] as usize;
    let mut methods = vec![0u8; nmethods];
    if stream.read_exact(&mut methods).await.is_err() {
        return None;
    }
    // 选 NO AUTH (0x00)
    if stream.write_all(&[0x05, 0x00]).await.is_err() {
        return None;
    }

    // 2) 请求：VER CMD RSV ATYP DST.ADDR DST.PORT
    let mut req = [0u8; 4];
    if stream.read_exact(&mut req).await.is_err() {
        return None;
    }
    if req[0] != 0x05 || req[1] != 0x01 {
        // 非 CONNECT → REP=0x07 (Command not supported)
        let _ = stream
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await;
        return None;
    }
    let host = match req[3] {
        0x01 => {
            // IPv4
            let mut a = [0u8; 4];
            if stream.read_exact(&mut a).await.is_err() {
                return None;
            }
            format!("{}.{}.{}.{}", a[0], a[1], a[2], a[3])
        }
        0x03 => {
            // 域名
            let mut len = [0u8; 1];
            if stream.read_exact(&mut len).await.is_err() {
                return None;
            }
            let mut d = vec![0u8; len[0] as usize];
            if stream.read_exact(&mut d).await.is_err() {
                return None;
            }
            String::from_utf8(d).ok()?
        }
        0x04 => {
            // IPv6
            let mut a = [0u8; 16];
            if stream.read_exact(&mut a).await.is_err() {
                return None;
            }
            a.iter()
                .map(|b| format!("{b:x}"))
                .collect::<Vec<_>>()
                .join(":")
        }
        _ => {
            // 不支持的地址类型 → REP=0x08
            let _ = stream
                .write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await;
            return None;
        }
    };
    let mut port_buf = [0u8; 2];
    if stream.read_exact(&mut port_buf).await.is_err() {
        return None;
    }
    let port = u16::from_be_bytes(port_buf);

    // 3) 回成功：VER REP RSV ATYP BND.ADDR BND.PORT（用 0.0.0.0:0，客户端通常不校验）
    if stream
        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await
        .is_err()
    {
        return None;
    }
    Some((host, port))
}
