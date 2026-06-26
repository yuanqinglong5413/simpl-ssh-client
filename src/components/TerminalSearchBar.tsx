import { useEffect, useRef } from "react";
import { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { ChevronDown, ChevronUp, X } from "lucide-react";

type Props = {
  term: Terminal | null;
  open: boolean;
  onClose: () => void;
};

/**
 * 终端内搜索栏：集成 @xterm/addon-search，支持 Ctrl+F 唤起、F3 导航。
 */
export function TerminalSearchBar({ term, open, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const addonRef = useRef<SearchAddon | null>(null);

  useEffect(() => {
    if (!term) return;
    const addon = new SearchAddon();
    term.loadAddon(addon);
    addonRef.current = addon;
    return () => {
      addonRef.current = null;
    };
  }, [term]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  if (!open) return null;

  function runSearch(backward = false) {
    const q = inputRef.current?.value ?? "";
    const addon = addonRef.current;
    if (!addon || !q) return;
    const opts = {
      caseSensitive: false,
      regex: false,
      incremental: false,
      decorations: {
        matchOverviewRuler: "#ff9f1c",
        activeMatchColorOverviewRuler: "#ff9f1c",
      },
    };
    if (backward) addon.findPrevious(q, opts);
    else addon.findNext(q, opts);
  }

  return (
    <div className="term-search" onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="term-search-input"
        placeholder="搜索终端内容…"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            runSearch(e.shiftKey);
          } else if (e.key === "Escape") {
            onClose();
          }
        }}
        onChange={() => runSearch()}
      />
      <button type="button" className="term-search-btn" title="上一个 (Shift+Enter)" onClick={() => runSearch(true)}>
        <ChevronUp size={14} />
      </button>
      <button type="button" className="term-search-btn" title="下一个 (Enter)" onClick={() => runSearch(false)}>
        <ChevronDown size={14} />
      </button>
      <button type="button" className="term-search-btn" title="关闭 (Esc)" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}
