import { snippetCompletion, type Completion } from "@codemirror/autocomplete";
import { Text } from "@codemirror/state";
import type { LspCompletionItem } from "./LanguageClientStore";
import { lspPosition, lspPositionToOffset } from "./navigation";

/** LSP CompletionItemKind（1–25）→ CodeMirror 补全图标类别，缺省 variable。 */
const KIND_MAP: Record<number, string> = {
  2: "method", 3: "function", 4: "function", 5: "property", 6: "variable",
  7: "class", 8: "interface", 9: "namespace", 10: "property", 13: "enum",
  14: "keyword", 15: "snippet", 19: "namespace", 21: "constant", 22: "type", 25: "type",
};

export function kindToCmType(kind: number | undefined): string {
  return (kind != null && KIND_MAP[kind]) || "variable";
}

/** 单项补全：snippet 用占位符模板；textEdit 指定精确范围；否则用 insertText/label。纯函数，不依赖运行时 store。 */
export function buildCompletion(item: LspCompletionItem, doc: Text): Completion {
  const base: Completion = { label: item.label, type: kindToCmType(item.kind), detail: item.detail };
  if (item.insertTextFormat === 2 && item.insertText) return snippetCompletion(item.insertText, base);
  const edit = item.textEdit;
  if (edit?.range?.start && edit.range.end && edit.newText != null) {
    const from = lspPositionToOffset(doc, lspPosition(edit.range.start));
    const to = lspPositionToOffset(doc, lspPosition(edit.range.end));
    return { ...base, apply: (view) => view.dispatch({ changes: { from, to, insert: edit.newText as string } }) };
  }
  return { ...base, apply: item.insertText ?? item.label };
}
