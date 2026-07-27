//! 远程终端编码转换（UTF-8 ↔ GBK/GB2312 等 legacy 编码）。
//!
//! 后端 PTY 字节流按 profile 指定的编码与 UTF-8 互转：
//! - 输出（服务器 → 前端）：按编码**流式**解码为 UTF-8 字节，前端 xterm 直接渲染；
//!   流式 Decoder 持有跨片状态，正确处理被分片切断的多字节字符。
//! - 输入（前端 → 服务器）：把前端 UTF-8 按编码编码后发给 PTY。
//!
//! `None` / `utf-8` 编码时全部直通，零开销。

use encoding_rs::{Decoder, Encoding};

/// 按标签解析编码。`None` / 空 / `utf-8` / 未知 → `None`（表示直通不转换）。
pub fn encoding_for(label: Option<&str>) -> Option<&'static Encoding> {
    let label = label?.trim();
    if label.is_empty() || label.eq_ignore_ascii_case("utf-8") || label.eq_ignore_ascii_case("utf8") {
        return None;
    }
    Encoding::for_label(label.as_bytes())
}

/// 终端编解码器：持有流式 Decoder 状态，处理跨片多字节字符。
pub struct TerminalCodec {
    enc: Option<&'static Encoding>,
    decoder: Option<Decoder>,
}

impl TerminalCodec {
    /// `label` 为 `None` / `utf-8` 时构造"直通"编解码器（不解码也不编码）。
    pub fn new(label: Option<&str>) -> Self {
        let enc = encoding_for(label);
        Self {
            enc,
            decoder: enc.map(|e| e.new_decoder()),
        }
    }

    /// 把服务器输出的字节解码为 UTF-8 字节；直通时原样返回。
    /// `buf` 由调用方持有以复用分配。`last` 为 true 时 flush 残留（PTY 流中通常 false）。
    pub fn decode_output(&mut self, src: &[u8], buf: &mut String, last: bool) -> Vec<u8> {
        let Some(dec) = self.decoder.as_mut() else {
            return src.to_vec();
        };
        buf.clear();
        // decode_to_string 把 dst 的 capacity 作为输出上限且不主动扩容，
        // 因此必须先预留足够空间（最坏 1 字节 → 1 个 UTF-8 字符 ≈ 4 字节）。
        buf.reserve(src.len() * 4);
        let _ = dec.decode_to_string(src, buf, last);
        buf.as_bytes().to_vec()
    }

    /// 把前端输入的 UTF-8 字节编码为目标编码后返回；直通时原样返回。
    pub fn encode_input(&self, src: &[u8]) -> Vec<u8> {
        let Some(enc) = self.enc else {
            return src.to_vec();
        };
        // 前端 TextEncoder 产出合法 UTF-8；lossy 容错偶发非法字节。
        let s = String::from_utf8_lossy(src);
        let (cow, _, _) = enc.encode(&s);
        cow.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_is_passthrough() {
        assert!(encoding_for(None).is_none());
        assert!(encoding_for(Some("utf-8")).is_none());
        assert!(encoding_for(Some("UTF8")).is_none());
        assert!(encoding_for(Some("")).is_none());
    }

    #[test]
    fn gbk_roundtrip() {
        // "你好" 的 GBK 字节
        let gbk = [0xc4, 0xe3, 0xba, 0xc3];
        let mut codec = TerminalCodec::new(Some("gbk"));
        let mut buf = String::new();
        let utf8 = codec.decode_output(&gbk, &mut buf, false);
        let s = String::from_utf8(utf8.clone()).unwrap();
        assert_eq!(s, "你好");
        // 输入方向：UTF-8 "你好" → GBK
        let back = codec.encode_input("你好".as_bytes());
        assert_eq!(back, gbk);
    }

    #[test]
    fn passthrough_keeps_bytes() {
        let mut codec = TerminalCodec::new(None);
        let mut buf = String::new();
        let data = b"hello \xe4\xbd\xa0\xe5\xa5\xbd"; // UTF-8 "hello 你好"
        assert_eq!(codec.decode_output(data, &mut buf, false), data);
        assert_eq!(codec.encode_input(data), data);
    }
}
