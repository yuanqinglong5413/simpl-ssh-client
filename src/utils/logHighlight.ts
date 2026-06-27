/**
 * 日志行语法高亮：为无 ANSI 转义序列的纯文本日志注入颜色。
 *
 * 增强功能：
 * - 结构化 JSON 日志解析与美化（Logstash / Spring Boot JSON / 通用 JSON Lines）
 * - 框架格式适配（Spring Boot / Logback / Log4j2）
 * - 更多模式：SQL / URL / IP / 堆栈跟踪 / JSON 键值 / TraceID / 数值
 * - 颜色对比度提升（brightCyan / bold / 背景色微提示）
 */

// ============================ ANSI SGR 颜色码 ============================

const SGR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  brightBlack: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
} as const;

/** 行内是否已含 ANSI 转义序列 */
const HAS_ANSI = /\x1b\[[0-9;]*m/;

// ============================ 正则模式 ============================

/** ISO / 常见日志时间戳前缀 */
const TIMESTAMP_RE =
  /^(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}[-/]\d{2}[-/]\d{4} \d{2}:\d{2}:\d{2}|\w{3} \d{1,2} \d{2}:\d{2}:\d{2})/;

/** 日志级别关键字（整词匹配） */
const LEVEL_PATTERNS: { re: RegExp; color: string; bg?: string }[] = [
  { re: /\b(FATAL|CRITICAL|CRIT|EMERG|EMERGENCY|PANIC)\b/i, color: SGR.brightRed, bg: SGR.bgRed },
  { re: /\b(ERROR|ERR|SEVERE)\b/i, color: SGR.red },
  { re: /\b(WARN|WARNING|WRN)\b/i, color: SGR.yellow, bg: SGR.bgYellow },
  { re: /\b(INFO|INFORMATION|NOTICE)\b/i, color: SGR.brightCyan },
  { re: /\b(DEBUG|TRACE|VERBOSE|FINE|FINER|FINEST)\b/i, color: SGR.dim + SGR.brightBlack },
];

/** 方括号/圆括号内的级别标记，如 [ERROR]、(WARN) */
const BRACKET_LEVEL_RE =
  /(\[|\()(\s*(?:FATAL|CRITICAL|ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE|VERBOSE)\s*)(\]|\))/gi;

/** HTTP 状态码 */
const HTTP_STATUS_RE = /\b(1\d{2}|2\d{2}|3\d{2}|4\d{2}|5\d{2})\b/g;

/** Java/JS 异常类名 */
const EXCEPTION_RE = /\b([A-Z][a-zA-Z0-9]*(?:Exception|Error|Throwable))\b/g;

/** URL */
const URL_RE = /https?:\/\/[^\s"'<>]+/g;

/** IP 地址 */
const IP_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?\b/g;

/** SQL 关键字 */
const SQL_RE = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|FROM|WHERE|JOIN|INNER|LEFT|RIGHT|GROUP|ORDER|HAVING|LIMIT|VALUES|SET|INTO|TABLE|INDEX|ON|AND|OR|NOT|NULL|DEFAULT|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|DISTINCT|AS|UNION|ALL|EXISTS|BETWEEN|LIKE|IN|IS|CASE|WHEN|THEN|ELSE|END|BEGIN|COMMIT|ROLLBACK)\b/gi;

/** 堆栈跟踪行：at xxx.yyy(File.java:NNN) */
const STACK_TRACE_RE = /^\s+at\s+([^\s(]+)\(([^:)]+)(?::(\d+))?\)/;

/** JSON 键值："key": value */
const JSON_KV_RE = /"([^"]+)"(\s*):(\s*)/;

/** 独立数值（前后非字母数字） */
const NUMBER_RE = /(?<![a-zA-Z_$])(-?\d+\.?\d+)(?![a-zA-Z_$])/g;

/** Trace/Span ID：[trace-id:xxx] 或 traceId=xxx */
const TRACE_ID_RE = /(?:\[?(?:trace[-_ ]?id|span[-_ ]?id|request[-_ ]?id|correlation[-_ ]?id)[:=]\s*([a-f0-9-]{8,36})\]?)/gi;

// ============================ 框架格式检测 ============================

/** Spring Boot 默认格式：yyyy-MM-dd HH:mm:ss.SSS  LEVEL [thread] class : message */
const SPRING_BOOT_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(INFO|WARN|ERROR|DEBUG|TRACE|FATAL)\s+\[([^\]]+)\]\s+([^\s:]+)\s*:\s*(.*)/;

/** Logback 经典格式：yyyy-MM-dd HH:mm:ss [thread] LEVEL  logger - message */
const LOGBACK_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+\[([^\]]+)\]\s+(INFO|WARN|ERROR|DEBUG|TRACE|FATAL)\s+([^\s-]+)\s+-\s*(.*)/;

/** Log4j2 格式：yyyy-MM-dd HH:mm:ss,SSS [thread] LEVEL  logger - message */
const LOG4J2_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\s+\[([^\]]+)\]\s+(INFO|WARN|ERROR|DEBUG|TRACE|FATAL)\s+([^\s-]+)\s+-\s*(.*)/;

// ============================ 辅助函数 ============================

/** 判断一行是否像日志行 */
function looksLikeLogLine(line: string): boolean {
  if (!line.trim()) return false;
  if (HAS_ANSI.test(line)) return false;
  if (TIMESTAMP_RE.test(line)) return true;
  if (/\[(?:ERROR|WARN|INFO|DEBUG|TRACE|FATAL)\]/i.test(line)) return true;
  if (/\b(?:ERROR|WARN|INFO|DEBUG|FATAL|TRACE)\b/i.test(line)) return true;
  if (/\b(?:Exception|Error):/.test(line)) return true;
  if (SPRING_BOOT_RE.test(line)) return true;
  if (LOGBACK_RE.test(line)) return true;
  if (LOG4J2_RE.test(line)) return true;
  return false;
}

/** 尝试解析 JSON 日志行 */
function tryParseJsonLog(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;

  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj !== "object" || obj === null) return null;
    return formatJsonLog(obj);
  } catch {
    return null;
  }
}

/** 将 JSON 日志对象格式化为带颜色的字符串 */
function formatJsonLog(obj: Record<string, unknown>): string {
  const parts: string[] = [];

  // 时间戳
  const ts = obj["@timestamp"] ?? obj.timestamp ?? obj.time ?? obj.ts;
  if (typeof ts === "string") {
    parts.push(`${SGR.dim}${SGR.brightBlue}${ts}${SGR.reset}`);
  }

  // 级别
  const level = (obj.level ?? obj.severity ?? obj.lvl) as string | undefined;
  if (typeof level === "string") {
    const levelUpper = level.toUpperCase();
    let color: string = SGR.brightCyan;
    if (/FATAL|CRITICAL/.test(levelUpper)) color = SGR.bold + SGR.brightRed;
    else if (/ERROR|ERR/.test(levelUpper)) color = SGR.red;
    else if (/WARN/.test(levelUpper)) color = SGR.yellow;
    else if (/DEBUG|TRACE/.test(levelUpper)) color = SGR.dim + SGR.brightBlack;
    parts.push(`${color}${levelUpper}${SGR.reset}`);
  }

  // Logger / thread
  const logger = obj.logger_name ?? obj.logger ?? obj["logger_name"];
  if (typeof logger === "string") {
    parts.push(`${SGR.magenta}${logger}${SGR.reset}`);
  }

  const thread = obj.thread_name ?? obj.thread ?? obj.tid;
  if (typeof thread === "string") {
    parts.push(`${SGR.dim}[${thread}]${SGR.reset}`);
  }

  // 消息
  const msg = obj.message ?? obj.msg ?? obj["@message"];
  if (typeof msg === "string") {
    parts.push(`${SGR.white}${msg}${SGR.reset}`);
  }

  // 其他字段
  const knownKeys = new Set([
    "@timestamp", "timestamp", "time", "ts",
    "level", "severity", "lvl",
    "logger_name", "logger", "thread_name", "thread", "tid",
    "message", "msg", "@message",
  ]);

  for (const [key, value] of Object.entries(obj)) {
    if (knownKeys.has(key)) continue;
    const valStr = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${SGR.cyan}${key}${SGR.dim}=${SGR.reset}${SGR.green}${valStr}${SGR.reset}`);
  }

  return parts.join(" ");
}

// ============================ 高亮函数 ============================

function highlightTimestamp(line: string): string {
  const m = line.match(TIMESTAMP_RE);
  if (!m) return line;
  const ts = m[0];
  return line.replace(ts, `${SGR.dim}${SGR.brightBlue}${ts}${SGR.reset}`);
}

function highlightLevels(line: string): string {
  let result = line;
  for (const { re, color, bg } of LEVEL_PATTERNS) {
    result = result.replace(re, (match) => {
      const prefix = bg ? `${SGR.bold}${bg}${SGR.white}` : `${SGR.bold}${color}`;
      return `${prefix}${match}${SGR.reset}`;
    });
  }
  return result;
}

function highlightBracketLevels(line: string): string {
  return line.replace(BRACKET_LEVEL_RE, (_m, open, level, close) => {
    const trimmed = level.trim().toUpperCase();
    let color: string = SGR.brightCyan;
    if (/FATAL|CRITICAL/.test(trimmed)) color = SGR.brightRed;
    else if (/ERROR|ERR/.test(trimmed)) color = SGR.red;
    else if (/WARN/.test(trimmed)) color = SGR.yellow;
    else if (/DEBUG|TRACE|VERBOSE/.test(trimmed)) color = SGR.brightBlack;
    return `${open}${SGR.bold}${color}${level}${SGR.reset}${close}`;
  });
}

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

function highlightExceptions(line: string): string {
  return line.replace(EXCEPTION_RE, (m) => `${SGR.magenta}${m}${SGR.reset}`);
}

function highlightUrls(line: string): string {
  return line.replace(URL_RE, (m) => `${SGR.underline}${SGR.brightCyan}${m}${SGR.reset}`);
}

function highlightIps(line: string): string {
  return line.replace(IP_RE, (m) => `${SGR.magenta}${m}${SGR.reset}`);
}

function highlightSql(line: string): string {
  return line.replace(SQL_RE, (m) => `${SGR.blue}${m}${SGR.reset}`);
}

function highlightStackTrace(line: string): string {
  const m = line.match(STACK_TRACE_RE);
  if (!m) return line;
  const [, method, file, lineNum] = m;
  const filePart = lineNum ? `${file}:${lineNum}` : file;
  return line.replace(
    STACK_TRACE_RE,
    `${SGR.dim}  at ${SGR.cyan}${method}${SGR.dim}(${SGR.brightCyan}${filePart}${SGR.dim})${SGR.reset}`
  );
}

function highlightJsonKv(line: string): string {
  return line.replace(JSON_KV_RE, (_m, key, sep1, sep2) =>
    `${SGR.cyan}"${key}"${SGR.reset}${sep1}:${sep2}`
  );
}

function highlightNumbers(line: string): string {
  return line.replace(NUMBER_RE, (m) => `${SGR.brightYellow}${m}${SGR.reset}`);
}

function highlightTraceIds(line: string): string {
  return line.replace(TRACE_ID_RE, (m) => `${SGR.magenta}${m}${SGR.reset}`);
}

// ============================ 框架格式解析 ============================

function tryFrameworkFormat(line: string): string | null {
  // Spring Boot
  let m = line.match(SPRING_BOOT_RE);
  if (m) {
    const [, ts, level, thread, cls, msg] = m;
    const levelColor = getLevelColor(level);
    return [
      `${SGR.dim}${SGR.brightBlue}${ts}${SGR.reset}`,
      `${SGR.bold}${levelColor}${level.padEnd(5)}${SGR.reset}`,
      `${SGR.dim}[${thread}]${SGR.reset}`,
      `${SGR.magenta}${cls}${SGR.reset}:`,
      msg,
    ].join("  ");
  }

  // Logback
  m = line.match(LOGBACK_RE);
  if (m) {
    const [, ts, thread, level, logger, msg] = m;
    const levelColor = getLevelColor(level);
    return [
      `${SGR.dim}${SGR.brightBlue}${ts}${SGR.reset}`,
      `${SGR.dim}[${thread}]${SGR.reset}`,
      `${SGR.bold}${levelColor}${level.padEnd(5)}${SGR.reset}`,
      `${SGR.magenta}${logger}${SGR.reset} -`,
      msg,
    ].join("  ");
  }

  // Log4j2
  m = line.match(LOG4J2_RE);
  if (m) {
    const [, ts, thread, level, logger, msg] = m;
    const levelColor = getLevelColor(level);
    return [
      `${SGR.dim}${SGR.brightBlue}${ts}${SGR.reset}`,
      `${SGR.dim}[${thread}]${SGR.reset}`,
      `${SGR.bold}${levelColor}${level.padEnd(5)}${SGR.reset}`,
      `${SGR.magenta}${logger}${SGR.reset} -`,
      msg,
    ].join("  ");
  }

  return null;
}

function getLevelColor(level: string): string {
  const u = level.toUpperCase();
  if (/FATAL|CRITICAL/.test(u)) return SGR.brightRed;
  if (/ERROR|ERR/.test(u)) return SGR.red;
  if (/WARN/.test(u)) return SGR.yellow;
  if (/DEBUG|TRACE/.test(u)) return SGR.brightBlack;
  return SGR.brightCyan;
}

// ============================ 主高亮入口 ============================

/** 对单行日志注入 ANSI 颜色 */
function highlightLogLine(line: string): string {
  if (!looksLikeLogLine(line)) return line;

  // 1. 尝试 JSON 日志解析
  const jsonResult = tryParseJsonLog(line);
  if (jsonResult) return jsonResult;

  // 2. 尝试框架格式解析
  const fwResult = tryFrameworkFormat(line);
  if (fwResult) return fwResult;

  // 3. 通用模式高亮
  let result = highlightTimestamp(line);
  result = highlightBracketLevels(result);
  result = highlightLevels(result);
  result = highlightTraceIds(result);
  result = highlightSql(result);
  result = highlightUrls(result);
  result = highlightIps(result);
  result = highlightHttpStatus(result);
  result = highlightExceptions(result);
  result = highlightStackTrace(result);
  result = highlightJsonKv(result);
  result = highlightNumbers(result);
  return result;
}

// ============================ 流式转换器 ============================

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
