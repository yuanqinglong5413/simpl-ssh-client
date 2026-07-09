/**
 * 日志行语法高亮：为无 ANSI 转义序列的纯文本日志注入颜色。
 *
 * 重要约束（避免终端排版错乱）：
 * - 只处理「看起来像完整日志行」的文本；交互式 TUI / 提示符 / 进度条一律透传。
 * - 使用流式 UTF-8 解码器，避免中文等多字节字符被 WebSocket 分片截断。
 * - 行尾含 ESC / CSI 未完成序列时不缓冲高亮，直接透传，避免破坏远端光标状态。
 * - 含 `\r` 的行（进度条、htop 刷新）不做高亮，防止注入 ANSI 后列宽错位。
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

/** 行内是否已含任意 ESC 控制序列（含 CSI / OSC） */
const HAS_ESC = /\x1b/;

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

/** SQL 关键字（仅在已判定为日志行后使用，避免误伤 shell） */
const SQL_RE =
  /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|FROM|WHERE|JOIN|INNER|LEFT|RIGHT|GROUP|ORDER|HAVING|LIMIT|VALUES|SET|INTO|TABLE|INDEX|ON|AND|OR|NOT|NULL|DEFAULT|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|DISTINCT|AS|UNION|ALL|EXISTS|BETWEEN|LIKE|IN|IS|CASE|WHEN|THEN|ELSE|END|BEGIN|COMMIT|ROLLBACK)\b/gi;

/** 堆栈跟踪行：at xxx.yyy(File.java:NNN) */
const STACK_TRACE_RE = /^\s+at\s+([^\s(]+)\(([^:)]+)(?::(\d+))?\)/;

/** JSON 键值："key": value */
const JSON_KV_RE = /"([^"]+)"(\s*):(\s*)/;

/** 独立数值（前后非字母数字） */
const NUMBER_RE = /(?<![a-zA-Z_$])(-?\d+\.?\d+)(?![a-zA-Z_$])/g;

/** Trace/Span ID */
const TRACE_ID_RE =
  /(?:\[?(?:trace[-_ ]?id|span[-_ ]?id|request[-_ ]?id|correlation[-_ ]?id)[:=]\s*([a-f0-9-]{8,36})\]?)/gi;

// ============================ 框架格式检测 ============================

const SPRING_BOOT_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(INFO|WARN|ERROR|DEBUG|TRACE|FATAL)\s+\[([^\]]+)\]\s+([^\s:]+)\s*:\s*(.*)/;

const LOGBACK_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+\[([^\]]+)\]\s+(INFO|WARN|ERROR|DEBUG|TRACE|FATAL)\s+([^\s-]+)\s+-\s*(.*)/;

const LOG4J2_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\s+\[([^\]]+)\]\s+(INFO|WARN|ERROR|DEBUG|TRACE|FATAL)\s+([^\s-]+)\s+-\s*(.*)/;

// ============================ 辅助函数 ============================

/**
 * 判断一行是否像「可安全高亮」的日志行。
 * 比旧版更严格：单独出现 INFO/ERROR 不再触发，避免误伤 vim/htop/提示符。
 */
function looksLikeLogLine(line: string): boolean {
  if (!line.trim()) return false;
  // 已有 ESC / 含回车刷新 → 交互输出，绝不注入
  if (HAS_ESC.test(line) || line.includes("\r")) return false;

  // 框架格式（最可靠）
  if (SPRING_BOOT_RE.test(line) || LOGBACK_RE.test(line) || LOG4J2_RE.test(line)) {
    return true;
  }
  // 时间戳开头 + 级别，才视为日志（单独级别词太容易误伤）
  if (TIMESTAMP_RE.test(line)) {
    if (/\[(?:ERROR|WARN|INFO|DEBUG|TRACE|FATAL)\]/i.test(line)) return true;
    if (/\b(?:ERROR|WARN|INFO|DEBUG|FATAL|TRACE)\b/i.test(line)) return true;
    if (/\b(?:Exception|Error):/.test(line)) return true;
    return false;
  }
  // 堆栈跟踪续行
  if (STACK_TRACE_RE.test(line)) return true;
  // JSON Lines：以 { 开头且能 parse
  const trimmed = line.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object") {
        const o = obj as Record<string, unknown>;
        if (o.level || o.severity || o["@timestamp"] || o.message || o.msg) {
          return true;
        }
      }
    } catch {
      /* 非 JSON */
    }
  }
  return false;
}

function tryParseJsonLog(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj !== "object" || obj === null) return null;
    return formatJsonLog(obj as Record<string, unknown>);
  } catch {
    return null;
  }
}

function formatJsonLog(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  const ts = obj["@timestamp"] ?? obj.timestamp ?? obj.time ?? obj.ts;
  if (typeof ts === "string") {
    parts.push(`${SGR.dim}${SGR.brightBlue}${ts}${SGR.reset}`);
  }
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
  const logger = obj.logger_name ?? obj.logger;
  if (typeof logger === "string") {
    parts.push(`${SGR.magenta}${logger}${SGR.reset}`);
  }
  const thread = obj.thread_name ?? obj.thread ?? obj.tid;
  if (typeof thread === "string") {
    parts.push(`${SGR.dim}[${thread}]${SGR.reset}`);
  }
  const msg = obj.message ?? obj.msg ?? obj["@message"];
  if (typeof msg === "string") {
    parts.push(`${SGR.white}${msg}${SGR.reset}`);
  }
  const knownKeys = new Set([
    "@timestamp",
    "timestamp",
    "time",
    "ts",
    "level",
    "severity",
    "lvl",
    "logger_name",
    "logger",
    "thread_name",
    "thread",
    "tid",
    "message",
    "msg",
    "@message",
  ]);
  for (const [key, value] of Object.entries(obj)) {
    if (knownKeys.has(key)) continue;
    const valStr = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(
      `${SGR.cyan}${key}${SGR.dim}=${SGR.reset}${SGR.green}${valStr}${SGR.reset}`
    );
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
  return line.replace(
    URL_RE,
    (m) => `${SGR.underline}${SGR.brightCyan}${m}${SGR.reset}`
  );
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
  return line.replace(
    JSON_KV_RE,
    (_m, key, sep1, sep2) => `${SGR.cyan}"${key}"${SGR.reset}${sep1}:${sep2}`
  );
}

function highlightNumbers(line: string): string {
  return line.replace(NUMBER_RE, (m) => `${SGR.brightYellow}${m}${SGR.reset}`);
}

function highlightTraceIds(line: string): string {
  return line.replace(TRACE_ID_RE, (m) => `${SGR.magenta}${m}${SGR.reset}`);
}

function tryFrameworkFormat(line: string): string | null {
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

/** 对单行日志注入 ANSI 颜色；非日志行原样返回 */
export function highlightLogLine(line: string): string {
  if (!looksLikeLogLine(line)) return line;

  const jsonResult = tryParseJsonLog(line);
  if (jsonResult) return jsonResult;

  const fwResult = tryFrameworkFormat(line);
  if (fwResult) return fwResult;

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
 * - 流式 UTF-8 解码，修复中文分片乱码
 * - 完整行才高亮；不完整尾部透传
 */
export function createLogHighlighter() {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const encoder = new TextEncoder();

  function transform(chunk: ArrayBuffer | string): Uint8Array {
    const text =
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });

    const parts: string[] = [];
    let lastIdx = 0;

    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") {
        const line = text.slice(lastIdx, i);
        parts.push(highlightLogLine(line) + "\n");
        lastIdx = i + 1;
      }
    }

    if (lastIdx < text.length) {
      parts.push(text.slice(lastIdx));
    }

    return encoder.encode(parts.join(""));
  }

  function flush(): Uint8Array {
    // 冲刷 decoder 中可能残留的不完整 UTF-8 尾字节
    const tail = decoder.decode();
    if (!tail) return new Uint8Array(0);
    return encoder.encode(tail);
  }

  return { transform, flush };
}
