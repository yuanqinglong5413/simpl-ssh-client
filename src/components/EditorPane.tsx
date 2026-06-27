import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Save } from "lucide-react";
import type { RemoteFileContent } from "../types";
import { detectLanguage, languageLabel } from "../utils/editorLanguages";

type Props = {
  sessionId: string;
  filePath: string;
  onTitleChange?: (title: string) => void;
};

/**
 * 远程文件编辑器：通过 SFTP 加载/保存文件，CodeMirror 6 渲染。
 */
export function EditorPane({ sessionId, filePath, onTitleChange }: Props) {
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const file = await invoke<RemoteFileContent>("sftp_read_file", {
          sessionId,
          path: filePath,
        });
        setContent(file.content);
        setOriginal(file.content);
        onTitleChange?.(filePath.split("/").pop() ?? filePath);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, filePath]);

  const isDirty = content !== original;

  async function save() {
    setSaving(true);
    setError("");
    try {
      await invoke("sftp_write_file", {
        sessionId,
        path: filePath,
        content,
      });
      setOriginal(content);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty) save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, content, sessionId, filePath]);

  if (loading) {
    return (
      <div className="editor-pane">
        <div className="editor-empty">
          <Loader2 className="spin" size={20} />
          <span>加载文件中…</span>
        </div>
      </div>
    );
  }

  if (error && !content) {
    return (
      <div className="editor-pane">
        <div className="editor-empty">
          <span className="editor-error">{error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        <span className="editor-path">{filePath}</span>
        <span className="editor-lang">{languageLabel(detectLanguage(filePath))}</span>
        {isDirty && <span className="editor-dirty">● 未保存</span>}
        <button
          className="icon-btn"
          title="保存 (Ctrl+S)"
          disabled={!isDirty || saving}
          onClick={save}
        >
          <Save size={14} />
        </button>
      </div>
      {error && <div className="editor-error-bar">{error}</div>}
      <textarea
        className="editor-textarea"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}
