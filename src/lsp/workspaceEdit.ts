import type { LspTextEdit } from "./textEdits";
import { relativePathFromFileUri } from "./navigation";

export type FileTextEdit = { path: string; edits: LspTextEdit[] };

type WorkspaceEntry = { uri: string; edits: LspTextEdit[] };
type WorkspaceEditShape = { changes?: Record<string, LspTextEdit[]>; documentChanges?: Array<{ textDocument?: { uri?: string }; edits?: LspTextEdit[] }> };

function entriesFrom(edit: WorkspaceEditShape): WorkspaceEntry[] {
  const fromChanges = Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({ uri, edits }));
  const fromDocumentChanges = (edit.documentChanges ?? []).map((change) => ({ uri: change.textDocument?.uri ?? "", edits: change.edits ?? [] }));
  return [...fromChanges, ...fromDocumentChanges];
}

/** 把 LSP WorkspaceEdit 归一为 {path, edits}[]，过滤项目根之外的文件。 */
export function normalizeWorkspaceEdit(edit: unknown, root: string): FileTextEdit[] {
  return entriesFrom((edit as WorkspaceEditShape) ?? {}).flatMap((entry) => {
    const path = relativePathFromFileUri(root, entry.uri);
    return path && entry.edits.length ? [{ path, edits: entry.edits }] : [];
  });
}

/** 把 TextEdit[] 应用到纯字符串（多文件落地，无 CodeMirror view），从后往前替换避免 offset 偏移。 */
export function applyEditsToString(content: string, edits: LspTextEdit[]): string {
  if (!edits.length) return content;
  const lines = content.split("\n");
  const toIndex = (line: number, character: number) => {
    const safeLine = Math.max(0, Math.min(line, lines.length - 1));
    const prefix = lines.slice(0, safeLine).reduce((sum, value) => sum + value.length + 1, 0);
    return prefix + Math.max(0, Math.min(character, (lines[safeLine] ?? "").length));
  };
  const ranges = edits.map((edit) => ({ from: toIndex(edit.range.start.line, edit.range.start.character), to: toIndex(edit.range.end.line, edit.range.end.character), insert: edit.newText })).sort((a, b) => b.from - a.from);
  let result = content;
  for (const range of ranges) result = result.slice(0, range.from) + range.insert + result.slice(range.to);
  return result;
}
