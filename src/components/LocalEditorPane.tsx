import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EditorSelection, EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, highlightActiveLine, highlightWhitespace, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { bracketMatching } from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { ArrowLeft, ArrowRight, RefreshCw, Save } from "lucide-react";
import type { RemoteFileContent } from "../types";
import { cmExtension, detectLanguage, languageDefinition, languageLabel } from "../utils/editorLanguages";
import type { InstalledLspPlugin, LanguageServerConfig, LspPluginManifest } from "../settings/types";
import { fileUri, languageClientStore, languageServerMatches, projectLanguageOverride, useLanguageClient, type LspDiagnostic } from "../lsp/LanguageClientStore";
import { pluginForLanguage } from "../lsp/plugins";
import { lspDiagnosticsToCm } from "../lsp/diagnostics";
import { lspCompletionExtension } from "../lsp/completion";
import { lspHoverExtension } from "../lsp/hover";
import { lspSignatureExtension } from "../lsp/signatureHelp";
import { applyTextEdits } from "../lsp/textEdits";
import { normalizeWorkspaceEdit, type FileTextEdit } from "../lsp/workspaceEdit";
import { TextInputDialog } from "./DialogPrimitives";
import { ErrorState, LoadingState } from "./LoadingState";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { invokeWithTimeout } from "../utils/invokeWithTimeout";
import { clampPosition, type LspLocation, type NavigationSource, type NavigationTarget } from "../lsp/navigation";

const semanticEffect = StateEffect.define<DecorationSet>();
const semanticField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    decorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(semanticEffect)) decorations = effect.value;
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function buildSemanticDecorations(view: EditorView, data: number[], tokenTypes: string[]) {
  const ranges: Array<{ from: number; to: number; class: string }> = [];
  let line = 0; let character = 0;
  for (let index = 0; index + 4 < data.length; index += 5) {
    const deltaLine = data[index] ?? 0; const deltaStart = data[index + 1] ?? 0; const length = data[index + 2] ?? 0; const tokenType = data[index + 3] ?? 0;
    line += deltaLine; character = deltaLine === 0 ? character + deltaStart : deltaStart;
    if (length <= 0 || line >= view.state.doc.lines) continue;
    const lineInfo = view.state.doc.line(line + 1); const from = Math.min(lineInfo.from + character, lineInfo.to); const to = Math.min(from + length, lineInfo.to);
    const name = (tokenTypes[tokenType] ?? "token").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
    if (to > from) ranges.push({ from, to, class: `cm-semantic-${name}` });
  }
  return Decoration.set(ranges.map((range) => Decoration.mark({ class: range.class }).range(range.from, range.to)), true);
}

type Props = {
  root: string;
  filePath: string;
  projectId?: string;
  active: boolean;
  editorActive?: boolean;
  missing?: boolean;
  languageServers?: LanguageServerConfig[];
  pluginCatalog?: LspPluginManifest[];
  installedPlugins?: InstalledLspPlugin[];
  pluginOverrides?: Array<{ pluginId: string; enabled?: boolean; version?: string; args?: string[]; languages?: string[] }>;
  languageServerOverrides?: Array<{ id: string; enabled?: boolean; args?: string[]; languages?: string[] }>;
  syntaxHighlighting?: boolean;
  languageHighlighting?: Record<string, boolean>;
  semanticHighlighting?: "auto" | "on" | "off";
  bracketMatching?: boolean;
  highlightActiveLine?: boolean;
  showWhitespace?: boolean;
  codeCompletion?: boolean;
  hoverEnabled?: boolean;
  formatOnSave?: boolean;
  signatureHelp?: boolean;
  navigationTarget?: NavigationTarget | null;
  canNavigateBack?: boolean;
  canNavigateForward?: boolean;
  onNavigateBack?: () => void;
  onNavigateForward?: () => void;
  onNavigateLocation?: (location: LspLocation, source: NavigationSource) => void;
  onReferenceLocations?: (locations: LspLocation[], source: NavigationSource) => void;
  onNavigationApplied?: (requestId: number) => void;
  onDiagnosticsChange?: (filePath: string, diagnostics: LspDiagnostic[]) => void;
  onApplyEdits?: (edits: FileTextEdit[], currentPath: string) => void;
  onDocumentSymbol?: (symbols: unknown[]) => void;
  onActiveServerId?: (serverId: string | undefined) => void;
  onDirtyChange: (dirty: boolean) => void;
};

/** 项目内本地编辑器：只调用带项目根目录校验的 IPC，不复用远程 SFTP 编辑通道。 */
export function LocalEditorPane({ root, filePath, projectId, active, editorActive = true, missing = false, languageServers = [], languageServerOverrides, pluginCatalog = [], installedPlugins = [], pluginOverrides, syntaxHighlighting = true, languageHighlighting = {}, semanticHighlighting = "auto", bracketMatching: bracketMatchingEnabled = true, highlightActiveLine: highlightActiveLineEnabled = true, showWhitespace = false, codeCompletion = true, hoverEnabled = true, formatOnSave = false, signatureHelp = true, navigationTarget = null, canNavigateBack = false, canNavigateForward = false, onNavigateBack, onNavigateForward, onNavigateLocation, onReferenceLocations, onNavigationApplied, onDirtyChange, onDiagnosticsChange, onApplyEdits, onDocumentSymbol, onActiveServerId }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef("");
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [language, setLanguage] = useState("text");
  const [revision, setRevision] = useState(0);
  const [fileRevision, setFileRevision] = useState<string | undefined>();
  const [externalContent, setExternalContent] = useState<string | null>(null);
  const [externalRevision, setExternalRevision] = useState<string | undefined>();
  const [externalNotice, setExternalNotice] = useState("");
  const [lspServerId, setLspServerId] = useState<string | undefined>(undefined);
  const [lspRetryNonce, setLspRetryNonce] = useState(0);
  const [renameState, setRenameState] = useState<{ initialName: string; position: number } | null>(null);
  const lspServerRef = useRef<string | undefined>(undefined);
  const editorViewRef = useRef<EditorView | null>(null);
  const lspVersionRef = useRef(0);
  const loadRequestRef = useRef(0);
  const saveRequestRef = useRef(0);
  const navigationRequestRef = useRef(0);
  const navigationCallbacksRef = useRef({ onNavigateLocation, onReferenceLocations, onNavigationApplied });
  navigationCallbacksRef.current = { onNavigateLocation, onReferenceLocations, onNavigationApplied };
  const onDiagnosticsChangeRef = useRef(onDiagnosticsChange);
  onDiagnosticsChangeRef.current = onDiagnosticsChange;
  const onApplyEditsRef = useRef(onApplyEdits);
  onApplyEditsRef.current = onApplyEdits;
  const onDocumentSymbolRef = useRef(onDocumentSymbol);
  onDocumentSymbolRef.current = onDocumentSymbol;
  const onActiveServerIdRef = useRef(onActiveServerId);
  onActiveServerIdRef.current = onActiveServerId;
  const [navigationNotice, setNavigationNotice] = useState("");
  const identityRef = useRef({ root, filePath });
  identityRef.current = { root, filePath };
  contentRef.current = content;
  const matchingServer = languageServers.find((server) => languageServerMatches(server, language));
  const matchingPlugin = pluginForLanguage(language, installedPlugins, pluginOverrides) && pluginCatalog.find((plugin) => plugin.id === pluginForLanguage(language, installedPlugins, pluginOverrides)?.id);
  const matchingPluginOverride = matchingPlugin ? pluginOverrides?.find((item) => item.pluginId === matchingPlugin.id) : undefined;
  const matchingOverride = matchingServer ? projectLanguageOverride(languageServerOverrides, matchingServer.id) : undefined;
  const uri = projectId ? fileUri(root, filePath) : undefined;
  const lsp = useLanguageClient(lspServerId, uri);

  const dirty = content !== original;
  const dirtyRef = useRef(dirty);
  const fileRevisionRef = useRef(fileRevision);
  dirtyRef.current = dirty;
  fileRevisionRef.current = fileRevision;

  async function requestDefinitionAt(view: EditorView, position: number) {
    const serverId = lspServerRef.current;
    if (!serverId || !uri) { setNavigationNotice("语言服务尚未就绪，无法跳转定义。"); return; }
    const word = view.state.wordAt(position);
    if (!word) { setNavigationNotice("当前位置没有可跳转的符号。"); return; }
    const line = view.state.doc.lineAt(word.from);
    const source: NavigationSource = { filePath, line: line.number - 1, character: word.from - line.from };
    const requestId = ++navigationRequestRef.current;
    setNavigationNotice("");
    try {
      const locations = await languageClientStore.definition(serverId, uri, { line: source.line, character: source.character });
      if (requestId !== navigationRequestRef.current || identityRef.current.root !== root || identityRef.current.filePath !== filePath) return;
      if (!locations.length) { setNavigationNotice("当前符号没有定义位置。"); return; }
      navigationCallbacksRef.current.onNavigateLocation?.(locations[0], source);
    } catch (reason) {
      if (requestId === navigationRequestRef.current) setNavigationNotice(String(reason));
    }
  }

  async function requestReferencesAt(view: EditorView, position: number) {
    const serverId = lspServerRef.current;
    if (!serverId || !uri) { setNavigationNotice("语言服务尚未就绪，无法查找引用。"); return; }
    const word = view.state.wordAt(position);
    if (!word) { setNavigationNotice("当前位置没有可查找引用的符号。"); return; }
    const line = view.state.doc.lineAt(word.from);
    const source: NavigationSource = { filePath, line: line.number - 1, character: word.from - line.from };
    const requestId = ++navigationRequestRef.current;
    setNavigationNotice("正在查找引用…");
    try {
      const locations = await languageClientStore.references(serverId, uri, { line: source.line, character: source.character });
      if (requestId !== navigationRequestRef.current || identityRef.current.root !== root || identityRef.current.filePath !== filePath) return;
      setNavigationNotice(locations.length ? `找到 ${locations.length} 个引用。` : "没有找到引用。");
      navigationCallbacksRef.current.onReferenceLocations?.(locations, source);
    } catch (reason) {
      if (requestId === navigationRequestRef.current) setNavigationNotice(String(reason));
    }
  }

  const load = useCallback(async (external = false) => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setError("");
    try {
      const file = await invokeWithTimeout(invoke<RemoteFileContent>("project_read_file", { root, relativePath: filePath }), "project_read_file");
      if (requestId !== loadRequestRef.current) return;
      setContent(file.content);
      setOriginal(file.content);
      setFileRevision(file.revision ?? undefined);
      setLanguage(detectLanguage(filePath));
      setRevision((value) => value + 1);
      if (external) setExternalNotice("文件已从磁盘重新加载。");
    } catch (reason) {
      if (requestId === loadRequestRef.current) setError(String(reason));
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [filePath, root]);

  useEffect(() => { navigationRequestRef.current += 1; setExternalContent(null); setExternalNotice(""); setNavigationNotice(""); setContent(""); setOriginal(""); setFileRevision(undefined); setError(""); setRevision((value) => value + 1); void load(); /* file identity drives the editor */ }, [load]);
  useEffect(() => {
    const onCommand = (event: Event) => {
      if (!active || !editorActive || !editorViewRef.current) return;
      const view = editorViewRef.current;
      if (event.type === "simpl-ssh:editor-definition") void requestDefinitionAt(view, view.state.selection.main.head);
      if (event.type === "simpl-ssh:editor-references") void requestReferencesAt(view, view.state.selection.main.head);
      if (event.type === "simpl-ssh:editor-format") void formatDocument(view);
    };
    window.addEventListener("simpl-ssh:editor-definition", onCommand);
    window.addEventListener("simpl-ssh:editor-references", onCommand);
    window.addEventListener("simpl-ssh:editor-format", onCommand);
    return () => { window.removeEventListener("simpl-ssh:editor-definition", onCommand); window.removeEventListener("simpl-ssh:editor-references", onCommand); window.removeEventListener("simpl-ssh:editor-format", onCommand); };
  }, [active, editorActive, filePath, root]);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (loading || error || !hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: contentRef.current,
        extensions: [lineNumbers(), history(), keymap.of([...defaultKeymap, ...historyKeymap, { key: "F12", run: (current) => { void requestDefinitionAt(current, current.state.selection.main.head); return true; } }, { key: "Shift-F12", run: (current) => { void requestReferencesAt(current, current.state.selection.main.head); return true; } }, { key: "Shift-Alt-f", run: (current) => { void formatDocument(current); return true; } }, { key: "F2", run: (current) => { const pos = current.state.selection.main.head; const word = current.state.wordAt(pos); if (word) setRenameState({ initialName: current.state.sliceDoc(word.from, word.to), position: pos }); return true; } }]), semanticField, lintGutter(), ...(uri ? [...(codeCompletion ? [lspCompletionExtension({ getServerId: () => lspServerRef.current, uri })] : []), ...(hoverEnabled ? [lspHoverExtension({ getServerId: () => lspServerRef.current, uri })] : []), ...(signatureHelp ? lspSignatureExtension({ getServerId: () => lspServerRef.current, uri }) : [])] : []), ...(syntaxHighlighting && languageHighlighting[language] !== false ? cmExtension(language) : []), ...(bracketMatchingEnabled ? [bracketMatching()] : []), ...(highlightActiveLineEnabled ? [highlightActiveLine()] : []), ...(showWhitespace ? [highlightWhitespace()] : []), oneDark, EditorView.lineWrapping, EditorView.domEventHandlers({ click: (event, current) => { const mouse = event as MouseEvent; if (mouse.button !== 0) return false; const position = current.posAtCoords({ x: mouse.clientX, y: mouse.clientY }); if (position == null) return false; if (mouse.altKey && !mouse.metaKey && !mouse.ctrlKey) { mouse.preventDefault(); current.dispatch({ selection: current.state.selection.addRange(EditorSelection.cursor(position)) }); return true; } if ((mouse.metaKey || mouse.ctrlKey) && !mouse.altKey) { mouse.preventDefault(); void requestDefinitionAt(current, position); return true; } return false; } }), EditorView.updateListener.of((update) => { if (update.docChanged) { const next = update.state.doc.toString(); setContent(next); lspVersionRef.current += 1; if (lspServerRef.current && uri) void languageClientStore.changeDocument(lspServerRef.current, uri, next, lspVersionRef.current).catch(() => undefined); } })],
      }),
      parent: hostRef.current,
    });
    editorViewRef.current = view;
    return () => { if (editorViewRef.current === view) editorViewRef.current = null; view.destroy(); };
  }, [bracketMatchingEnabled, codeCompletion, error, highlightActiveLineEnabled, hoverEnabled, language, languageHighlighting, loading, revision, showWhitespace, signatureHelp, syntaxHighlighting, uri]);

  useEffect(() => {
    if (!navigationTarget || navigationTarget.filePath !== filePath || loading || error || !editorViewRef.current) return;
    const view = editorViewRef.current;
    const position = clampPosition(navigationTarget.line, navigationTarget.character, view.state.doc.toString());
    view.dispatch({ selection: { anchor: position.offset }, scrollIntoView: true });
    view.focus();
    navigationCallbacksRef.current.onNavigationApplied?.(navigationTarget.requestId);
  }, [error, filePath, loading, navigationTarget, revision]);

  useEffect(() => {
    if (!projectId || (!matchingServer && !matchingPlugin) || !uri || loading || error || missing) return;
    let disposed = false;
    const version = lspVersionRef.current + 1;
    lspVersionRef.current = version;
    // 先绑定预期的运行 ID，启动失败时也能把后端返回的原因显示在编辑器工具栏。
    const expectedServerId = matchingPlugin
      ? languageClientStore.runtimeId(projectId, matchingPlugin.id)
      : matchingServer
        ? languageClientStore.runtimeId(projectId, matchingServer.id)
        : undefined;
    setLspServerId(expectedServerId);
    const open = matchingPlugin ? languageClientStore.openPluginDocument(projectId, root, matchingPlugin, uri, language, contentRef.current, version, matchingPluginOverride).catch(() => matchingServer ? languageClientStore.openDocument(projectId, root, matchingServer, matchingOverride, uri, language, contentRef.current, version) : Promise.reject(new Error("没有可用语言服务"))) : matchingServer ? languageClientStore.openDocument(projectId, root, matchingServer, matchingOverride, uri, language, contentRef.current, version) : Promise.reject(new Error("没有可用语言服务"));
    void open.then(async (serverId) => {
      if (disposed) { void languageClientStore.closeDocument(serverId, uri); return; }
      lspServerRef.current = serverId; setLspServerId(serverId);
      if (semanticHighlighting !== "off") {
        const tokens = await languageClientStore.semanticTokens(serverId, uri).catch(() => null);
        if (!disposed && tokens && editorViewRef.current) editorViewRef.current.dispatch({ effects: semanticEffect.of(buildSemanticDecorations(editorViewRef.current, tokens.data, tokens.tokenTypes)) });
      }
    }).catch(() => undefined);
    return () => { disposed = true; const serverId = lspServerRef.current; if (serverId) void languageClientStore.closeDocument(serverId, uri); lspServerRef.current = undefined; setLspServerId(undefined); onDiagnosticsChangeRef.current?.(filePath, []); };
  }, [error, filePath, language, loading, lspRetryNonce, matchingOverride, matchingPlugin, matchingPluginOverride, matchingServer, missing, pluginOverrides, projectId, root, semanticHighlighting, uri]);

  // 编辑器内诊断可视化：诊断变化或编辑器重建后重灌 lint 状态。
  useEffect(() => {
    const view = editorViewRef.current;
    if (!view || !lspServerId) return;
    view.dispatch(setDiagnostics(view.state, lspDiagnosticsToCm(lsp.diagnostics, view.state.doc)));
  }, [lsp.diagnostics, lspServerId, uri, revision]);

  // 把当前文件的 LSP 诊断回灌给工作台 Problems 面板。
  useEffect(() => {
    onDiagnosticsChangeRef.current?.(filePath, lsp.diagnostics);
  }, [lsp.diagnostics, filePath]);

  // 文档符号大纲：语言服务就绪或文档变更后重新请求并回灌。
  useEffect(() => {
    const serverId = lspServerRef.current;
    if (!serverId || !uri) return;
    void languageClientStore.documentSymbol(serverId, uri).then((symbols) => { onDocumentSymbolRef.current?.(Array.isArray(symbols) ? symbols : []); }).catch(() => undefined);
  }, [lspServerId, uri, revision]);

  // 上报当前活跃的语言服务 ID，供工作区符号搜索等 workspace 级操作复用。
  useEffect(() => { onActiveServerIdRef.current?.(lspServerId); }, [lspServerId]);

  async function formatDocument(view: EditorView) {
    const serverId = lspServerRef.current;
    if (!serverId || !uri) return;
    const edits = await languageClientStore.formatting(serverId, uri, { tabSize: languageDefinition(language)?.defaultIndent ?? 4, insertSpaces: true }).catch(() => null);
    if (!edits?.length) return;
    applyTextEdits(view, edits);
    lspVersionRef.current += 1;
    const next = view.state.doc.toString();
    setContent(next);
    void languageClientStore.changeDocument(serverId, uri, next, lspVersionRef.current).catch(() => undefined);
  }

  async function requestRenameAt(view: EditorView, position: number, newName: string) {
    const serverId = lspServerRef.current;
    if (!serverId || !uri) return;
    const word = view.state.wordAt(position);
    const line = view.state.doc.lineAt(position);
    const character = (word ? word.from : position) - line.from;
    try {
      const edit = await languageClientStore.rename(serverId, uri, { line: line.number - 1, character }, newName);
      const files = normalizeWorkspaceEdit(edit, root);
      const currentFile = files.find((file) => file.path === filePath);
      if (currentFile) { applyTextEdits(view, currentFile.edits); lspVersionRef.current += 1; const next = view.state.doc.toString(); setContent(next); void languageClientStore.changeDocument(serverId, uri, next, lspVersionRef.current).catch(() => undefined); }
      const others = files.filter((file) => file.path !== filePath);
      if (others.length) onApplyEditsRef.current?.(others, filePath);
    } catch (reason) {
      setNavigationNotice(String(reason));
    }
  }

  async function save() {
    const requestId = ++saveRequestRef.current;
    const targetRoot = root;
    const targetPath = filePath;
    let targetContent = content;
    const isCurrent = () => saveRequestRef.current === requestId && identityRef.current.root === targetRoot && identityRef.current.filePath === targetPath;
    setSaving(true);
    setError("");
    try {
      if (formatOnSave && lspServerRef.current && uri && editorViewRef.current) {
        await formatDocument(editorViewRef.current);
        if (!isCurrent()) return;
        targetContent = editorViewRef.current.state.doc.toString();
      }
      await invokeWithTimeout(invoke("project_write_file", { root: targetRoot, relativePath: targetPath, content: targetContent, expectedRevision: fileRevisionRef.current ?? null }), "project_write_file");
      if (!isCurrent()) return;
      setOriginal(targetContent);
      const refreshed = await invokeWithTimeout(invoke<RemoteFileContent>("project_read_file", { root: targetRoot, relativePath: targetPath }), "project_read_file");
      if (!isCurrent()) return;
      setFileRevision(refreshed.revision ?? undefined);
      if (lspServerRef.current && uri) void languageClientStore.saveDocument(lspServerRef.current, uri, targetContent).catch(() => undefined);
      setExternalNotice("已保存到磁盘。");
    } catch (reason) {
      if (isCurrent()) setError(String(reason));
    } finally {
      if (isCurrent()) setSaving(false);
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!active || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (dirty && !saving) void save();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, dirty, saving, content, filePath]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<{ root: string; path: string; kind: "changed" | "deleted" }>("project://file-changed", async (event) => {
      if (event.payload.root !== root || event.payload.path !== filePath) return;
      if (event.payload.kind === "deleted") { setError("文件已在磁盘上被删除。"); return; }
      const requestId = loadRequestRef.current;
      try {
        const disk = await invokeWithTimeout(invoke<RemoteFileContent>("project_read_file", { root, relativePath: filePath }), "project_read_file");
        if (requestId !== loadRequestRef.current || identityRef.current.root !== root || identityRef.current.filePath !== filePath) return;
        if (!dirtyRef.current) {
          setContent(disk.content); setOriginal(disk.content); setFileRevision(disk.revision ?? undefined); setRevision((value) => value + 1); setExternalNotice("文件已根据外部修改自动重新加载。");
        } else {
          setExternalContent(disk.content); setExternalRevision(disk.revision ?? undefined);
        }
      } catch (reason) {
        if (!disposed && requestId === loadRequestRef.current && identityRef.current.root === root && identityRef.current.filePath === filePath) setError(String(reason));
      }
    }).then((cleanup) => { if (disposed) cleanup(); else unlisten = cleanup; }).catch((reason) => setError(`文件监听失败：${String(reason)}`));
    return () => { disposed = true; unlisten?.(); };
  }, [filePath, root]);

  function useDiskVersion() {
    if (externalContent === null) return;
    setContent(externalContent); setOriginal(externalContent); setFileRevision(externalRevision); setExternalContent(null); setExternalNotice("已使用磁盘上的最新版本。"); setRevision((value) => value + 1);
  }

  function keepCurrentVersion() {
    setFileRevision(externalRevision);
    setExternalContent(null);
    setExternalNotice("已保留当前修改；下次保存会覆盖刚才看到的磁盘版本。");
  }

  if (loading) return <LoadingState label="正在打开本地文件…" />;
  if (error && !content) return <ErrorState label="无法打开文件" message={error} onRetry={() => void load()} />;
  return <div className="local-editor-pane">
    <div className="local-editor-head"><button className="icon-btn" aria-label="返回上一个位置" title="返回上一个位置 (Alt/Option ←)" disabled={!canNavigateBack} onClick={onNavigateBack}><ArrowLeft size={14} /></button><button className="icon-btn" aria-label="前进到下一个位置" title="前进到下一个位置" disabled={!canNavigateForward} onClick={onNavigateForward}><ArrowRight size={14} /></button><span title={filePath}>{filePath}</span><span>{languageLabel(language)}</span>{syntaxHighlighting && languageHighlighting[language] === false && <span className="editor-lsp-status" title="已在设置中关闭该语言的语法高亮">语法关闭</span>}{(matchingServer || matchingPlugin) && <><span className={`editor-lsp-status ${lsp.state?.status ?? "unknown"}`} title={lsp.state?.error || matchingPlugin?.name || matchingServer?.command}>LSP {matchingPlugin?.name ?? matchingServer?.name} · {lsp.state?.status === "ready" ? "就绪" : lsp.state?.status === "starting" ? "启动中" : lsp.state?.status === "crashed" ? "启动失败" : lsp.state?.status === "exited" ? "已退出" : "未启动"}{semanticHighlighting === "off" ? " · 语义关闭" : lsp.diagnostics.length > 0 ? ` · ${lsp.diagnostics.length} 个问题` : ""}</span>{lsp.state?.status !== "ready" && lsp.state?.status !== "starting" && <button className="icon-btn" aria-label="启动或重试语言服务" title={lsp.state?.error || "启动或重试语言服务"} onClick={() => setLspRetryNonce((value) => value + 1)}><RefreshCw size={14} /></button>}</>}{dirty && <em>● 未保存</em>}<button className="icon-btn" title={dirty ? "请先保存后再重新加载" : "重新加载文件"} disabled={dirty || missing} onClick={() => void load()}><RefreshCw size={14} /></button><button className="icon-btn" title={missing ? "文件不存在，无法保存" : "保存 (⌘S)"} disabled={!dirty || saving || missing} onClick={() => void save()}><Save size={14} /></button></div>
    {missing && <div className="editor-error-bar">文件已不存在或已被移动，请重新定位文件后再保存。</div>}
    {error && <div className="editor-error-bar">{error}</div>}
    {lsp.state?.error && <div className="editor-error-bar" role="status">语言服务未启动：{lsp.state.error} <button className="btn btn-ghost" onClick={() => setLspRetryNonce((value) => value + 1)}>重试</button></div>}
    {externalNotice && <div className="editor-external-notice">{externalNotice}</div>}
    {navigationNotice && <div className="editor-navigation-notice" role="status">{navigationNotice}</div>}
    <div className="editor-host" ref={hostRef} />
    {externalContent !== null && <ExternalChangeDialog diskContent={externalContent} currentContent={content} onKeep={keepCurrentVersion} onUseDisk={useDiskVersion} onClose={() => setExternalContent(null)} />}
    {renameState && <TextInputDialog title="重命名符号" label="新名称" initialValue={renameState.initialName} confirmLabel="重命名" onClose={() => setRenameState(null)} onConfirm={(name) => { const view = editorViewRef.current; if (view) void requestRenameAt(view, renameState.position, name); setRenameState(null); }} />}
  </div>;
}

function ExternalChangeDialog({ currentContent, diskContent, onKeep, onUseDisk, onClose }: { currentContent: string; diskContent: string; onKeep: () => void; onUseDisk: () => void; onClose: () => void }) {
  const ref = useDialogFocus(true, onClose);
  return <div className="overlay" onClick={onClose}><div ref={ref} className="dialog external-change-dialog" role="dialog" aria-modal="true" aria-labelledby="external-change-title" onClick={(event) => event.stopPropagation()}><div className="dialog-head"><strong id="external-change-title">文件已被外部修改</strong></div><div className="dialog-body"><p>磁盘版本与当前未保存内容不同。选择磁盘版本会丢弃当前编辑内容。</p><div className="external-change-versions"><section><strong>磁盘版本</strong><pre>{diskContent}</pre></section><section><strong>当前编辑内容</strong><pre>{currentContent}</pre></section></div></div><div className="dialog-foot"><button className="btn btn-ghost" onClick={onClose}>稍后处理</button><button className="btn btn-ghost" onClick={onKeep}>保留当前内容</button><button className="btn btn-danger" onClick={onUseDisk}>使用磁盘版本</button></div></div></div>;
}
