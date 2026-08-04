import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { AlertTriangle, Save } from "lucide-react";
import type { RemoteFileContent } from "../types";
import { detectLanguage, languageLabel, cmExtension } from "../utils/editorLanguages";
import { ErrorState, LoadingState } from "./LoadingState";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { invokeWithTimeout } from "../utils/invokeWithTimeout";

type Props = {
  sessionId: string;
  filePath: string;
  onTitleChange?: (title: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

/**
 * 远程文件编辑器：通过 SFTP 加载/保存，CodeMirror 6 真语法高亮 + 行号 + 撤销。
 */
export function EditorPane({ sessionId, filePath, onTitleChange, onDirtyChange }: Props) {
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [lang, setLang] = useState("text");
  const [originalModified, setOriginalModified] = useState<string | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [externalFile, setExternalFile] = useState<RemoteFileContent | null>(null);
  const conflictDialogRef = useDialogFocus(Boolean(externalFile), () => setExternalFile(null));
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef(content);
  const dirtyChangeRef = useRef(onDirtyChange);
  const loadRequestRef = useRef(0);
  const saveRequestRef = useRef(0);
  const identityRef = useRef({ sessionId, filePath });
  identityRef.current = { sessionId, filePath };
  contentRef.current = content;
  dirtyChangeRef.current = onDirtyChange;

  useEffect(() => {
    const requestId = ++loadRequestRef.current;
    setContent("");
    setOriginal("");
    setOriginalModified(null);
    setExternalFile(null);
    setError("");
    setEditorRevision((revision) => revision + 1);
    (async () => {
      setLoading(true);
      setError("");
      try {
        const file = await invokeWithTimeout(invoke<RemoteFileContent>("sftp_read_file", {
          sessionId,
          path: filePath,
        }), "sftp_read_file");
        if (requestId !== loadRequestRef.current) return;
        setContent(file.content);
        setOriginal(file.content);
        setOriginalModified(file.modified);
        setLang(detectLanguage(filePath));
        onTitleChange?.(filePath.split("/").pop() ?? filePath);
      } catch (e) {
        if (requestId === loadRequestRef.current) setError(String(e));
      } finally {
        if (requestId === loadRequestRef.current) setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, filePath, loadAttempt]);

  // 创建/重建 CodeMirror（就绪或语言变化时）
  useEffect(() => {
    if (loading || (error && !content)) return;
    const host = hostRef.current;
    if (!host) return;
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) setContent(u.state.doc.toString());
    });
    const state = EditorState.create({
      doc: contentRef.current,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        ...cmExtension(lang),
        oneDark,
        EditorView.lineWrapping,
        updateListener,
      ],
    });
    const view = new EditorView({ state, parent: host });
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, error, lang, editorRevision]);

  const isDirty = content !== original;

  useEffect(() => {
    dirtyChangeRef.current?.(isDirty);
    return () => dirtyChangeRef.current?.(false);
  }, [isDirty]);

  async function save() {
    const requestId = ++saveRequestRef.current;
    const targetSession = sessionId;
    const targetPath = filePath;
    const targetContent = content;
    const isCurrent = () => saveRequestRef.current === requestId && identityRef.current.sessionId === targetSession && identityRef.current.filePath === targetPath;
    setSaving(true);
    setError("");
    try {
      const remote = await invokeWithTimeout(invoke<RemoteFileContent>("sftp_read_file", { sessionId: targetSession, path: targetPath }), "sftp_read_file");
      if (!isCurrent()) return;
      if (remote.content !== original || remote.modified !== originalModified) {
        setExternalFile(remote);
        return;
      }
      await writeCurrentContent(requestId, targetSession, targetPath, targetContent);
    } catch (e) {
      if (isCurrent()) setError(String(e));
    } finally {
      if (isCurrent()) setSaving(false);
    }
  }

  async function writeCurrentContent(requestId = ++saveRequestRef.current, targetSession = sessionId, targetPath = filePath, targetContent = content) {
    const isCurrent = () => saveRequestRef.current === requestId && identityRef.current.sessionId === targetSession && identityRef.current.filePath === targetPath;
    try {
      await invokeWithTimeout(invoke("sftp_write_file", { sessionId: targetSession, path: targetPath, content: targetContent }), "sftp_write_file");
      if (!isCurrent()) return;
      setOriginal(targetContent);
      const refreshed = await invokeWithTimeout(invoke<RemoteFileContent>("sftp_read_file", { sessionId: targetSession, path: targetPath }), "sftp_read_file");
      if (!isCurrent()) return;
      setOriginalModified(refreshed.modified);
      setExternalFile(null);
    } catch (e) {
      if (isCurrent()) setError(String(e));
    }
  }

  function reloadExternalFile() {
    if (!externalFile) return;
    setContent(externalFile.content);
    setOriginal(externalFile.content);
    setOriginalModified(externalFile.modified);
    setExternalFile(null);
    setEditorRevision((revision) => revision + 1);
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.repeat && (e.ctrlKey || e.metaKey) && e.key === "s") {
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
        <LoadingState label="加载文件中…" />
      </div>
    );
  }

  if (error && !content) {
    return (
      <div className="editor-pane">
        <ErrorState message={error} label="无法读取远程文件" onRetry={() => setLoadAttempt((attempt) => attempt + 1)} />
      </div>
    );
  }

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        <span className="editor-path">{filePath}</span>
        <span className="editor-lang">{languageLabel(lang)}</span>
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
      <div className="editor-host" ref={hostRef} />
      {externalFile && (
        <div className="overlay editor-conflict-overlay">
          <div ref={conflictDialogRef} className="dialog editor-conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="editor-conflict-title">
            <div className="dialog-head"><div className="dialog-title" id="editor-conflict-title"><AlertTriangle size={16} /> 远程文件已变更</div></div>
            <div className="dialog-body"><p>保存前检测到 <code>{filePath}</code> 已被其他人或进程修改。请选择保留远程版本，或明确覆盖它。</p></div>
            <div className="dialog-foot"><button type="button" className="btn btn-ghost" onClick={reloadExternalFile}>重新加载远程版本</button><button type="button" className="btn btn-danger" onClick={() => void writeCurrentContent()}>覆盖远程版本</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
