import type { EditorView } from "@codemirror/view";
import { lspRangeToOffsets, type LspRange } from "./navigation";

/** LSP TextEdit（格式化 / 重命名共用）。 */
export type LspTextEdit = { range: LspRange; newText: string };

/** 把 LSP TextEdit[] 应用到 CodeMirror 视图。按 offset 升序由 CodeMirror 统一映射。 */
export function applyTextEdits(view: EditorView, edits: LspTextEdit[]) {
  if (!edits.length) return;
  const changes = edits.map((edit) => {
    const { from, to } = lspRangeToOffsets(view.state.doc, edit.range);
    return { from, to, insert: edit.newText };
  });
  view.dispatch({ changes });
}
