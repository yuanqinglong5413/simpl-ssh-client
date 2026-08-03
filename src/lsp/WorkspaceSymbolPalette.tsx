import { useEffect, useState } from "react";
import { languageClientStore } from "./LanguageClientStore";
import { relativePathFromFileUri, type LspLocation } from "./navigation";
import { useDialogFocus } from "../hooks/useDialogFocus";

type SymbolInfo = { name?: string; kind?: number; containerName?: string; location?: { uri?: string; range?: { start?: { line?: number; character?: number } } } };

function locationOf(symbol: SymbolInfo): LspLocation | null {
  const uri = symbol.location?.uri;
  const start = symbol.location?.range?.start;
  if (!uri || !start) return null;
  const position = { line: start.line ?? 0, character: start.character ?? 0 };
  return { uri, range: { start: position, end: position } };
}

/** 工作区符号搜索面板：debounce 后请求 LSP workspace/symbol，点击跳转到定义位置。 */
export function WorkspaceSymbolPalette({ serverId, root, onClose, onOpen }: { serverId: string | undefined; root: string; onClose: () => void; onOpen: (location: LspLocation) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SymbolInfo[]>([]);
  const [index, setIndex] = useState(0);
  const ref = useDialogFocus(true, onClose);
  useEffect(() => {
    if (!serverId || !query.trim()) { setResults([]); return; }
    const timer = window.setTimeout(() => {
      void languageClientStore.workspaceSymbol(serverId, query).then((symbols) => { setResults(Array.isArray(symbols) ? (symbols as SymbolInfo[]) : []); setIndex(0); }).catch(() => setResults([]));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [serverId, query]);
  const open = (symbol: SymbolInfo) => { const location = locationOf(symbol); if (location) { onOpen(location); onClose(); } };
  return <div className="project-quick-open" onClick={onClose}><div ref={ref} role="dialog" aria-modal="true" aria-label="工作区符号" onClick={(event) => event.stopPropagation()}><input autoFocus value={query} placeholder="搜索工作区符号（Cmd/Ctrl+T）" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") onClose(); if (event.key === "ArrowDown") { event.preventDefault(); setIndex((value) => Math.min(value + 1, Math.max(0, results.length - 1))); } if (event.key === "ArrowUp") { event.preventDefault(); setIndex((value) => Math.max(value - 1, 0)); } if (event.key === "Enter" && results[index]) open(results[index]); }} />{serverId ? <div>{results.slice(0, 100).map((symbol, itemIndex) => <button key={itemIndex} className={itemIndex === index ? "active" : ""} onMouseEnter={() => setIndex(itemIndex)} onClick={() => open(symbol)}><strong>{symbol.containerName ? `${symbol.containerName}.` : ""}{symbol.name ?? "?"}</strong><small>{relativePathFromFileUri(root, symbol.location?.uri ?? "") ?? symbol.location?.uri ?? ""}</small></button>)}</div> : <p>当前没有可用的语言服务。</p>}</div></div>;
}
