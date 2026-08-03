import type { LspHover } from "./LanguageClientStore";

type MarkedString = string | { language?: string; value?: string };
type Block = { type: "code"; lang: string; value: string } | { type: "text"; value: string };

/** 把 LSP Hover contents（MarkupContent / MarkedString / 数组）归一为 MarkedString 列表。 */
function collectMarkedStrings(contents: LspHover["contents"]): MarkedString[] {
  if (contents == null) return [];
  if (typeof contents === "string") return [contents];
  if (Array.isArray(contents)) return contents as MarkedString[];
  const obj = contents as { language?: string; value?: string };
  return [{ language: obj.language, value: obj.value ?? "" }];
}

/** 按围栏代码块 ``` 把 markdown 拆成 code/text 段落，其余整体作为文本块。 */
function splitBlocks(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let text: string[] = [];
  const flush = () => { if (text.length) { blocks.push({ type: "text", value: text.join("\n") }); text = []; } };
  for (let i = 0; i < lines.length; i += 1) {
    const fence = lines[i].match(/^```(.*)$/);
    if (!fence) { text.push(lines[i]); continue; }
    flush();
    const code: string[] = [];
    for (i += 1; i < lines.length && !lines[i].startsWith("```"); i += 1) code.push(lines[i]);
    blocks.push({ type: "code", lang: (fence[1] ?? "").trim(), value: code.join("\n") });
  }
  flush();
  return blocks;
}

/** 行内渲染 `` `code` `` 与 **bold**，其余为文本节点；全程 textContent，无 XSS 风险。 */
function renderInline(text: string): Node[] {
  const nodes: Node[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  for (const match of text.matchAll(regex)) {
    if (match.index > last) nodes.push(document.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      nodes.push(code);
    } else {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      nodes.push(strong);
    }
    last = (match.index ?? 0) + token.length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

function codeBlock(value: string, lang: string): HTMLElement {
  const code = document.createElement("code");
  if (lang) code.className = `language-${lang}`;
  code.textContent = value;
  const pre = document.createElement("pre");
  pre.appendChild(code);
  return pre;
}

function appendText(host: HTMLElement, value: string) {
  for (const para of value.split(/\n\s*\n/)) {
    if (!para.trim()) continue;
    const p = document.createElement("p");
    p.append(...renderInline(para.replace(/\n/g, " ")));
    host.appendChild(p);
  }
}

/** 渲染 LSP Hover 内容为安全 DOM（无 innerHTML）。 */
export function renderHoverContent(contents: LspHover["contents"]): HTMLElement {
  const root = document.createElement("div");
  root.className = "lsp-hover";
  for (const item of collectMarkedStrings(contents)) {
    if (typeof item === "string") for (const block of splitBlocks(item)) block.type === "code" ? root.appendChild(codeBlock(block.value, block.lang)) : appendText(root, block.value);
    else root.appendChild(codeBlock(item.value ?? "", item.language ?? ""));
  }
  return root;
}
