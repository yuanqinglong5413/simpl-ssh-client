import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { languageClientStore } from "./LanguageClientStore";
import { offsetToLspPosition } from "./navigation";
import { buildCompletion } from "./completionItems";

type CompletionDeps = { getServerId: () => string | undefined; uri: string };

async function requestCompletion(ctx: CompletionContext, deps: CompletionDeps): Promise<CompletionResult | null> {
  const serverId = deps.getServerId();
  if (!serverId) return null;
  const word = ctx.matchBefore(/[\w$]+/);
  const position = offsetToLspPosition(ctx.state.doc, ctx.pos);
  const items = await languageClientStore.completion(serverId, deps.uri, position);
  if (!items?.length) return null;
  return { from: word ? word.from : ctx.pos, to: ctx.pos, options: items.map((item) => buildCompletion(item, ctx.state.doc)), validFor: /[\w$.]/ };
}

/** 补全扩展工厂：getServerId 实时读取当前语言服务，避免闭包过期与编辑器重建。 */
export function lspCompletionExtension(deps: CompletionDeps) {
  return autocompletion({ override: [(ctx) => requestCompletion(ctx, deps)], activateOnTyping: true, icons: true });
}
