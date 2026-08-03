import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Trash2, X } from "lucide-react";
import type { Snippet } from "../types";
import { useDialogFocus } from "../hooks/useDialogFocus";

type Props = { onClose: () => void; onChanged?: () => void };

/**
 * 常用命令片段管理（CRUD）。片段可在命令面板（⌘K 搜「片段:」）一键注入当前活动终端。
 */
export function SnippetManager({ onClose, onChanged }: Props) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const dialogRef = useDialogFocus(true, onClose);

  async function refresh() {
    try {
      setSnippets(await invoke<Snippet[]>("snippet_list"));
      onChanged?.();
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    if (!title.trim() || !content.trim()) return;
    try {
      await invoke("snippet_create", {
        input: { title: title.trim(), content, tags: [], groupId: null },
      });
      setTitle("");
      setContent("");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(id: string) {
    try {
      await invoke("snippet_delete", { id });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="snippet-manager-title" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <div className="dialog-title" id="snippet-manager-title">常用命令片段</div>
          <button type="button" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">
          {error && <div className="dialog-error">{error}</div>}
          <div className="field">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="片段标题（如：查看日志）"
            />
          </div>
          <div className="field">
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="命令内容（可多行，注入终端时按原文发送）"
              rows={3}
              spellCheck={false}
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={create}
            disabled={!title.trim() || !content.trim()}
          >
            <Plus size={14} /> 添加片段
          </button>

          <div style={{ marginTop: 14, display: "flex", flexDirection: "column" }}>
            {snippets.length === 0 ? (
              <div className="conn-msg">
                暂无片段。添加后可在命令面板（⌘K）搜「片段:」一键注入当前活动终端。
              </div>
            ) : (
              snippets.map((s) => (
                <div
                  key={s.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 8px",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{s.title}</div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--muted)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {s.content}
                    </div>
                  </div>
                  <button className="btn btn-ghost" title="删除" onClick={() => remove(s.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="dialog-foot">
          <button className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
