import { hoverTooltip, type EditorView, type Tooltip } from "@codemirror/view";
import { languageClientStore } from "./LanguageClientStore";
import { offsetToLspPosition } from "./navigation";
import { renderHoverContent } from "./markdown";

type HoverDeps = { getServerId: () => string | undefined; uri: string };

async function resolveTooltip(view: EditorView, pos: number, deps: HoverDeps): Promise<Tooltip | null> {
  const serverId = deps.getServerId();
  if (!serverId) return null;
  const result = await languageClientStore.hover(serverId, deps.uri, offsetToLspPosition(view.state.doc, pos));
  if (!result) return null;
  const word = view.state.wordAt(pos);
  return { pos, end: word?.to ?? pos, above: true, create: () => ({ dom: renderHoverContent(result.contents) }) };
}

/** 悬浮扩展工厂：鼠标停在符号上时请求 hover，渲染 markdown 内容。 */
export function lspHoverExtension(deps: HoverDeps) {
  return hoverTooltip((view, pos) => resolveTooltip(view, pos, deps));
}
