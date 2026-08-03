import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, showTooltip } from "@codemirror/view";
import { languageClientStore } from "./LanguageClientStore";
import { offsetToLspPosition } from "./navigation";

type SignatureDeps = { getServerId: () => string | undefined; uri: string };

const setSignature = StateEffect.define<{ pos: number; label: string } | null>();

const signatureField = StateField.define<{ pos: number; label: string } | null>({
  create: () => null,
  update: (value, tr) => {
    for (const effect of tr.effects) if (effect.is(setSignature)) return effect.value;
    return value;
  },
  provide: (field) => showTooltip.from(field, (value) => value ? { pos: value.pos, above: true, create: () => ({ dom: signatureDom(value.label) }) } : null),
});

function signatureDom(label: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "lsp-signature";
  root.textContent = label;
  return root;
}

function pickSignatureLabel(result: unknown): string | null {
  const shape = result as { signatures?: Array<{ label: string }>; activeSignature?: number } | null;
  return shape?.signatures?.[shape.activeSignature ?? 0]?.label ?? null;
}

/** 签名提示：输入 ( 或 , 时请求 signatureHelp，光标上方显示当前函数签名；其他输入清除。 */
export function lspSignatureExtension(deps: SignatureDeps): Extension[] {
  const listener = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    const view = update.view;
    const pos = view.state.selection.main.head;
    const before = pos > 0 ? view.state.doc.sliceString(pos - 1, pos) : "";
    if (before !== "(" && before !== ",") { view.dispatch({ effects: setSignature.of(null) }); return; }
    const serverId = deps.getServerId();
    if (!serverId) return;
    void languageClientStore.signatureHelp(serverId, deps.uri, offsetToLspPosition(view.state.doc, pos)).then((result) => {
      const label = pickSignatureLabel(result);
      view.dispatch({ effects: setSignature.of(label ? { pos, label } : null) });
    }).catch(() => undefined);
  });
  return [signatureField, listener];
}
