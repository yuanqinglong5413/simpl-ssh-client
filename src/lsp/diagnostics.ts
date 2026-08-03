import type { Diagnostic } from "@codemirror/lint";
import { Text } from "@codemirror/state";
import type { LspDiagnostic } from "./LanguageClientStore";
import { lspPosition, lspPositionToOffset } from "./navigation";

/** LSP severity（1 Error / 2 Warning）映射到 CodeMirror lint 级别，其余归为 info。 */
const SEVERITY_MAP: Record<number, Diagnostic["severity"]> = { 1: "error", 2: "warning" };

/** 把 LSP 诊断数组转成 CodeMirror lint Diagnostic，range→offset，缺省退化为 0。 */
export function lspDiagnosticsToCm(diagnostics: LspDiagnostic[], doc: Text): Diagnostic[] {
  return diagnostics.map((diagnostic) => {
    const range = diagnostic.range;
    const from = range?.start ? lspPositionToOffset(doc, lspPosition(range.start)) : 0;
    const rawTo = range?.end ? Math.min(lspPositionToOffset(doc, lspPosition(range.end)), doc.length) : from;
    const severity = SEVERITY_MAP[diagnostic.severity ?? 0] ?? "info";
    const prefix = diagnostic.source ? `${diagnostic.source}: ` : "";
    return { from, to: Math.max(rawTo, from), severity, message: `${prefix}${diagnostic.message ?? ""}` };
  });
}
