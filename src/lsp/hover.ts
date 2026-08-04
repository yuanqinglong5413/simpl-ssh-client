import { closeHoverTooltips, EditorView, hoverTooltip, type Tooltip } from "@codemirror/view";
import { languageClientStore } from "./LanguageClientStore";
import { offsetToLspPosition } from "./navigation";
import { renderHoverContent } from "./markdown";
import { isPrimaryHoverModifier } from "./hoverModifier";

type HoverDeps = { getServerId: () => string | undefined; uri: string; language: string };

async function resolveTooltip(view: EditorView, pos: number, deps: HoverDeps): Promise<Tooltip | null> {
  const serverId = deps.getServerId();
  if (!serverId) return null;
  const result = await languageClientStore.hover(serverId, deps.uri, offsetToLspPosition(view.state.doc, pos));
  if (!result) return null;
  const word = view.state.wordAt(pos);
  return {
    pos,
    end: word?.to ?? pos,
    above: true,
    create: () => ({ dom: renderHoverContent(result.contents, deps.language) }),
  };
}

/**
 * LSP Hover 只在 Cmd(macOS)/Ctrl(Windows/Linux) 悬停时生效。
 * 普通移动鼠标不会发起 LSP 请求；松开修饰键、滚动、编辑或 Escape 都会关闭浮层。
 */
export function lspHoverExtension(deps: HoverDeps) {
  let modifierDown = false;
  const tooltip = hoverTooltip(
    (view, pos) => modifierDown ? resolveTooltip(view, pos, deps) : null,
    { hoverTime: 350, hideOnChange: true },
  );
  const close = (view: EditorView) => view.dispatch({ effects: closeHoverTooltips });
  return [
    tooltip,
    EditorView.domEventHandlers({
      mousemove(event, view) {
        modifierDown = isPrimaryHoverModifier(event);
        if (!modifierDown) close(view);
        return false;
      },
      mouseleave(_event, view) {
        modifierDown = false;
        close(view);
        return false;
      },
      keydown(event, view) {
        modifierDown = isPrimaryHoverModifier(event);
        if (event.key === "Escape") close(view);
        return false;
      },
      keyup(event, view) {
        modifierDown = isPrimaryHoverModifier(event);
        if (!modifierDown) close(view);
        return false;
      },
      scroll(_event, view) {
        close(view);
        return false;
      },
    }),
  ];
}
