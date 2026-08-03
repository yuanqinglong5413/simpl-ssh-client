import { Text } from "@codemirror/state";

export type LspPosition = {
  line: number;
  character: number;
};

export type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

export type LspLocation = {
  uri: string;
  range: LspRange;
};

export type NavigationSource = {
  filePath: string;
  line: number;
  character: number;
};

export type NavigationTarget = NavigationSource & {
  requestId: number;
};

function position(value: unknown): LspPosition | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { line?: unknown; character?: unknown };
  if (typeof candidate.line !== "number" || typeof candidate.character !== "number") return null;
  return {
    line: Math.max(0, Math.floor(candidate.line)),
    character: Math.max(0, Math.floor(candidate.character)),
  };
}

function range(value: unknown): LspRange | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { start?: unknown; end?: unknown };
  const start = position(candidate.start);
  const end = position(candidate.end);
  return start && end ? { start, end } : null;
}

/** 将 LSP Location、LocationLink、单项和数组统一成 Location。 */
export function normalizeLspLocations(value: unknown): LspLocation[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as { uri?: unknown; range?: unknown; targetUri?: unknown; targetRange?: unknown; targetSelectionRange?: unknown };
    const uri = typeof candidate.uri === "string" ? candidate.uri : typeof candidate.targetUri === "string" ? candidate.targetUri : "";
    const locationRange = range(candidate.range) ?? range(candidate.targetSelectionRange) ?? range(candidate.targetRange);
    return uri && locationRange ? [{ uri, range: locationRange }] : [];
  });
}

function normalizedPath(value: string): string {
  const slash = value.replace(/\\/g, "/").replace(/\/+/g, "/");
  const drive = slash.match(/^[A-Z]:/i);
  return drive ? `${drive[0].toLowerCase()}${slash.slice(2)}` : slash;
}

/** 将 file URI 安全转换为项目根目录内的相对路径。 */
export function relativePathFromFileUri(root: string, uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri.slice("file://".length));
  } catch {
    return null;
  }
  if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1);
  const rootPath = normalizedPath(root).replace(/\/+$/, "");
  const targetPath = normalizedPath(decoded).replace(/\/+$/, "");
  const caseInsensitive = /^[a-z]:\//i.test(rootPath);
  const comparableRoot = caseInsensitive ? rootPath.toLowerCase() : rootPath;
  const comparableTarget = caseInsensitive ? targetPath.toLowerCase() : targetPath;
  if (comparableTarget !== comparableRoot && !comparableTarget.startsWith(`${comparableRoot}/`)) return null;
  const relative = targetPath.slice(rootPath.length).replace(/^\/+/, "");
  if (!relative || relative.split("/").some((part) => part === ".." || part === ".")) return null;
  return relative;
}

export function clampPosition(line: number, character: number, text: string): { line: number; character: number; offset: number } {
  const lines = text.split("\n");
  const safeLine = Math.max(0, Math.min(Math.floor(line), Math.max(0, lines.length - 1)));
  const lineText = lines[safeLine] ?? "";
  const safeCharacter = Math.max(0, Math.min(Math.floor(character), lineText.length));
  const offset = lines.slice(0, safeLine).reduce((total, current) => total + current.length + 1, 0) + safeCharacter;
  return { line: safeLine, character: safeCharacter, offset };
}

/** 把可选的 LSP 位置字段补全为确定值（line/character 缺省 0），供诊断/补全 textEdit 复用。 */
export function lspPosition(value: { line?: number; character?: number } | undefined): LspPosition {
  return { line: Math.max(0, Math.floor(value?.line ?? 0)), character: Math.max(0, Math.floor(value?.character ?? 0)) };
}

/**
 * CodeMirror 文档偏移量 → LSP 位置。
 * 复用 doc.lineAt 的 O(1) 查询，避免 clampPosition 对纯字符串的逐行拆分。
 */
export function offsetToLspPosition(doc: Text, offset: number): LspPosition {
  const safeOffset = Math.max(0, Math.min(Math.floor(offset), doc.length));
  const line = doc.lineAt(safeOffset);
  return { line: line.number - 1, character: safeOffset - line.from };
}

/** LSP 位置 → CodeMirror 文档偏移量，character 超出行尾自动截断。 */
export function lspPositionToOffset(doc: Text, position: LspPosition): number {
  const lineNumber = Math.max(1, Math.min(Math.floor(position.line) + 1, doc.lines));
  const line = doc.line(lineNumber);
  const character = Math.max(0, Math.min(Math.floor(position.character), line.length));
  return line.from + character;
}

/** LSP 范围 → CodeMirror 偏移量区间，to 截断到文档末尾。供诊断/补全 textEdit 复用。 */
export function lspRangeToOffsets(doc: Text, range: LspRange): { from: number; to: number } {
  return { from: lspPositionToOffset(doc, range.start), to: Math.min(lspPositionToOffset(doc, range.end), doc.length) };
}
