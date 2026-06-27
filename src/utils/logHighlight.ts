/**
 * 日志行语法高亮：为无 ANSI 转义序列的纯文本日志注入颜色。
 *
 * 业务场景：用户在 SSH 终端中 cat/tail 日志文件时，原始输出通常不含颜色码，
 * 导致所有文字显示为同一前景色。本模块按日志级别、时间戳、HTTP 状态等模式
 * 注入 SGR 转义序列，使输出随当前终端主题 ANSI 调色板呈现语义化颜色。
 */

/** ANSI SGR 颜色码（对应 xterm 16 色调色板索引） */
const SGR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  brightBlack: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightCyan: "\x1b[96m",
} as const;

/** 行内是否已含 ANSI 转义序列 */
const HAS_ANSI = /\x1b\[[0-9;]*m/;

/** ISO / 常见日志时间戳前缀 */
const TIMESTAMP_RE =
  /^(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}[-/]\d{2}[-/]\d{4} \d{2}:\d{2}:\d{2}|\w{3} \d{1,2} \d{2}:\d{2}:\d{2})/;

/** 日志级别关键字（整词匹配） */
const LEVEL_PATTERNS: { re: RegExp; color: string }[] = [
  { re: /\b(FATAL|CRITICAL|CRIT|EMERG|EMERGENCY|PANIC)\b/i, color: SGR.brightRed },
  { re: /\b(ERROR|ERR|SEVERE)\b/i, color: SGR.red },
  { re: /\b(WARN|WARNING|WRN)\b/i, color: SGR.yellow },
  { re: /\b(INFO|INFORMATION|NOTICE)\b/i, color: SGR.cyan },
  { re: /\b(DEBUG|TRACE|VERBOSE|FINE|FINER|FINEST)\b/i, color: SGR.brightBlack },
];

/** 方括号/圆括号内的级别标记，如 [ERROR]、(WARN) */
const BRACKET_LEVEL_RE =
  /(\[|\()(\s*(?:FATAL|CRITICAL|ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE|VERBOSE)\s*)(\]|\))/gi;

/** HTTP 状态码 */
const HTTP_STATUS_RE = /\b(1\d{2}|2\d{2}|3\d{2}|4\d{2}|5\d{2})\b/g;

/** Java 异常类名 */
const EXCEPTION_RE = /\b([A-Z][a-zA-Z0-9]*(?:Exception|Error))\b/g;

/** 判断一行是否像日志行（至少匹配一种模式才着色，避免误伤交互式 shell 输出） */
function looksLikeLogLine(line: string): boolean {
  if (!line.trim()) return false;
  if (HAS_ANSI.test(line)) return false;
  if (TIMESTAMP_RE.test(line)) return true;
  if (/\[(?:ERROR|WARN|INFO|DEBUG|TRACE|FATAL)\]/i.test(line)) return true;
  if (/\b(?:ERROR|WARN|INFO|DEBUG|FATAL|TRACE)\b/i.test(line)) return true;
  if (/\b(?:Exception|Error):/.test(line)) return true;
  return false;
}

/** 为 HTTP 状态码着色 */
function highlightHttpStatus(line: string): string {
  return line.replace(HTTP_STATUS_RE, (code) => {
    const n = parseInt(code, 10);
    if (n >= 500) return `${SGR.brightRed}${code}${SGR.reset}`;
    if (n >= 400) return `${SGR.red}${code}${SGR.reset}`;
    if (n >= 300) return `${SGR.yellow}${code}${SGR.reset}`;
    if (n >= 200) return `${SGR.green}${code}${SGR.reset}`;
    return `${SGR.brightBlack}${code}${SGR.reset}`;
  });
}

/** 为日志级别关键字着色 */
function highlightLevels(line: string): string {
  let result = line;
  for (const { re, color } of LEVEL_PATTERNS) {
    result = result.replace(re, (match) => `${color}${match}${SGR.reset}`);
  }
  return result;
}

/** 为方括号级别标记着色 */
function highlightBracketLevels(line: string): string {
  return line.replace(BRACKET_LEVEL_RE, (_m, open, level, close) => {
    const trimmed = level.trim().toUpperCase();
    let color: string = SGR.cyan;
    if (/FATAL|CRITICAL/.test(trimmed)) color = SGR.brightRed;
    else if (/ERROR|ERR/.test(trimmed)) color = SGR.red;
    else if (/WARN/.test(trimmed)) color = SGR.yellow;
    else if (/DEBUG|TRACE|VERBOSE/.test(trimmed)) color = SGR.brightBlack;
    return `${open}${color}${level}${SGR.reset}${close}`;
  });
}

/** 为异常类名着色 */
function highlightExceptions(line: string): string {
  return line.replace(EXCEPTION_RE, (m) => `${SGR.magenta}${m}${SGR.reset}`);
}

/** 为行首时间戳着色（dim） */
function highlightTimestamp(line: string): string {
  const m = line.match(TIMESTAMP_RE);
  if (!m) return line;
  const ts = m[0];
  return line.replace(ts, `${SGR.dim}${SGR.brightBlack}${ts}${SGR.reset}`);
}

/** 对单行日志注入 ANSI 颜色 */
function highlightLogLine(line: string): string {
  if (!looksLikeLogLine(line)) return line;
  let result = highlightTimestamp(line);
  result = highlightBracketLevels(result);
  result = highlightLevels(result);
  result = highlightHttpStatus(result);
  result = highlightExceptions(result);
  return result;
}

/**
 * 创建流式日志高亮转换器。
 * 处理 WebSocket 分片数据，对完整行（含 \n）注入颜色。
 *
 * 不缓冲不完整行——交互式终端的回显和提示符需要实时显示，
 * 缓冲会导致输入不可见直到按回车。只有完整行才做高亮处理，
 * 不完整的尾部数据直接透传。
 */
export function createLogHighlighter() {
  /** 将二进制/字符串 chunk 转为高亮后的 Uint8Array */
  function transform(chunk: ArrayBuffer | string): Uint8Array {
    const text =
      typeof chunk === "string"
        ? chunk
        : new TextDecoder("utf-8", { fatal: false }).decode(chunk);

    const parts: string[] = [];
    let lastIdx = 0;

    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") {
        // 完整行（含 \n）—— 高亮后输出
        const line = text.slice(lastIdx, i);
        parts.push(highlightLogLine(line) + "\n");
        lastIdx = i + 1;
      }
    }

    // 不完整的尾部数据（无 \n）直接透传，不缓冲
    if (lastIdx < text.length) {
      parts.push(text.slice(lastIdx));
    }

    return new TextEncoder().encode(parts.join(""));
  }

  /** flush 空操作——无缓冲区，所有数据已在 transform 中即时输出 */
  function flush(): Uint8Array {
    return new Uint8Array(0);
  }

  return { transform, flush };
}
