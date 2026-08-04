import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Activity, ArrowLeft, ArrowRight, Braces, ChevronDown, ChevronRight, Clipboard, Code2, Copy, Download, FileCode2, FilePlus2, FileSearch, Folder, FolderGit2, FolderPlus, GitBranch, MoreHorizontal, PanelBottomClose, PanelBottomOpen, Play, Plus, Search, Server, SquareTerminal, Trash2, Upload, X } from "lucide-react";
import type { ConnectionProfile, FileEntry, GitDiffResult, GitStatusResult, Project, ProjectBatchChange, ProjectBatchJob, ProjectDeletePreview, ProjectRemoteWorkspace, ProjectTaskRun, RemoteFileContent } from "../types";
import { LocalEditorPane } from "./LocalEditorPane";
import { LocalTerminalPane } from "./LocalTerminalPane";
import { ProjectTaskPanel } from "./ProjectTaskPanel";
import { ErrorState, LoadingState } from "./LoadingState";
import { EMPTY_WORKSPACE_CONFIG, parseWorkspaceConfig, serializeWorkspaceConfig, type LanguageServerOverride, type WorkspaceConfig, type WorkspaceTask } from "../ide/workspaceConfig";
import { loadWorkbenchState, saveWorkbenchState, type ProjectWorkbenchState } from "../ide/workbenchState";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useToast } from "../feedback/ToastProvider";
import { invokeWithTimeout } from "../utils/invokeWithTimeout";
import { useSettings } from "../settings/SettingsProvider";
import { languageDefinition } from "../utils/editorLanguages";
import { LSP_PLUGIN_CATALOG } from "../lsp/plugins";
import type { LspDiagnostic } from "../lsp/LanguageClientStore";
import type { LspProblemRow } from "./ProjectTaskPanel";
import { relativePathFromFileUri, type LspLocation, type NavigationSource, type NavigationTarget } from "../lsp/navigation";
import { applyEditsToString, type FileTextEdit } from "../lsp/workspaceEdit";
import { WorkspaceSymbolPalette } from "../lsp/WorkspaceSymbolPalette";

type ActivityId = ProjectWorkbenchState["activity"];
type SearchMatch = { path: string; line: number; preview: string };
type ReferenceMatch = { path: string; line: number; character: number; preview: string; location: LspLocation };
type OutlineNode = { name?: string; detail?: string; kind?: number; range?: { start?: { line?: number; character?: number } }; selectionRange?: { start?: { line?: number; character?: number } }; location?: { range?: { start?: { line?: number; character?: number } } }; children?: OutlineNode[] };
type ClipboardState = { mode: "copy" | "cut"; paths: string[] } | null;
type ProjectPathChange = { from: string; to: string };
type EntryDialogState = { type: "file" | "folder" | "rename"; path?: string } | null;

type Props = {
  project: Project;
  profiles: ConnectionProfile[];
  active: boolean;
  onOpenRemote: (workspace: ProjectRemoteWorkspace, target: "terminal" | "sftp" | "git" | "monitor") => void;
  onDirtyChange: (dirty: boolean, files?: string[]) => void;
};

const ACTIVITY_ITEMS: { id: ActivityId; label: string; icon: typeof Folder }[] = [
  { id: "explorer", label: "资源管理器", icon: Folder }, { id: "search", label: "搜索", icon: Search }, { id: "scm", label: "源代码管理", icon: GitBranch }, { id: "run", label: "任务", icon: Play }, { id: "remote", label: "远程环境", icon: Server }, { id: "language", label: "语言服务", icon: Code2 },
];
const BOTTOM_VIEWS: { id: ProjectWorkbenchState["bottomView"]; label: string }[] = [{ id: "terminal", label: "终端" }, { id: "tasks", label: "任务" }, { id: "problems", label: "问题" }, { id: "references", label: "引用" }, { id: "outline", label: "大纲" }, { id: "output", label: "输出" }];
function joinPath(parent: string, name: string) { return parent ? `${parent}/${name}` : name; }
function displayName(path: string) { return path.split("/").pop() || path; }
function workspaces(project: Project): ProjectRemoteWorkspace[] { return project.remote_workspaces?.length ? project.remote_workspaces : (project.linked_profiles ?? []).map((profile_id) => ({ profile_id, remote_path: "" })); }

/** 本地项目工作台。所有文件动作都经由 root + relative path IPC 验证。 */
export function ProjectWorkbench({ project, profiles, active, onOpenRemote, onDirtyChange }: Props) {
  const storageKey = `simpl-ssh-project-workbench:${project.id}`;
  const initial = useMemo(() => loadWorkbenchState(localStorage.getItem(storageKey)), [storageKey]);
  const onDirtyRef = useRef(onDirtyChange); onDirtyRef.current = onDirtyChange;
  const { toast } = useToast();
  const { settings } = useSettings();
  const [activity, setActivity] = useState<ActivityId>(initial.activity);
  const [sideOpen, setSideOpen] = useState(true);
  const [bottomOpen, setBottomOpen] = useState(initial.bottomOpen);
  const [bottomHeight, setBottomHeight] = useState(initial.bottomHeight);
  const [bottomView, setBottomView] = useState<ProjectWorkbenchState["bottomView"]>(initial.bottomView);
  const [directories, setDirectories] = useState<Record<string, FileEntry[] | undefined>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [selectedDirectory, setSelectedDirectory] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [clipboard, setClipboard] = useState<ClipboardState>(null);
  const [entryDialog, setEntryDialog] = useState<EntryDialogState>(null);
  const [deletePreview, setDeletePreview] = useState<ProjectDeletePreview | null>(null);
  const [openFiles, setOpenFiles] = useState(initial.openFiles);
  const [activeFile, setActiveFile] = useState<string | null>(initial.activeFile);
  const [secondaryFile, setSecondaryFile] = useState<string | null>(initial.secondaryFile);
  const [splitEditors, setSplitEditors] = useState(initial.splitEditors);
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());
  const [missingFiles, setMissingFiles] = useState<Set<string>>(new Set());
  const [treeError, setTreeError] = useState(""); const [treeLoading, setTreeLoading] = useState(false);
  const [directoryStates, setDirectoryStates] = useState<Record<string, "loading" | "ready" | "error" | "timed_out">>({});
  const directoryRequestRef = useRef(new Map<string, number>());
  const projectIdentityRef = useRef(project.local_path);
  projectIdentityRef.current = project.local_path;
  const gitRequestRef = useRef(0);
  const workspaceConfigRequestRef = useRef(0);
  const searchRequestRef = useRef(0);
  const [query, setQuery] = useState(""); const [searchResults, setSearchResults] = useState<SearchMatch[]>([]); const [searching, setSearching] = useState(false); const [searchError, setSearchError] = useState(""); const [searchProgress, setSearchProgress] = useState<{ phase: string; scanned: number; matched: number } | null>(null); const [searchListenersReady, setSearchListenersReady] = useState(false);
  const [git, setGit] = useState<GitStatusResult | null>(null); const [gitError, setGitError] = useState(""); const [gitBusy, setGitBusy] = useState(false); const [commitMessage, setCommitMessage] = useState(""); const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [workspaceConfig, setWorkspaceConfig] = useState<WorkspaceConfig>(EMPTY_WORKSPACE_CONFIG); const [configNotice, setConfigNotice] = useState(""); const [taskLabel, setTaskLabel] = useState(""); const [taskDefinition, setTaskDefinition] = useState(""); const [taskRuns, setTaskRuns] = useState<ProjectTaskRun[]>([]);
  const [navigationTarget, setNavigationTarget] = useState<NavigationTarget | null>(null);
  const [navigationHistory, setNavigationHistory] = useState<NavigationSource[]>([]);
  const [navigationForward, setNavigationForward] = useState<NavigationSource[]>([]);
  const [currentNavigation, setCurrentNavigation] = useState<NavigationSource | null>(activeFile ? { filePath: activeFile, line: 0, character: 0 } : null);
  const [references, setReferences] = useState<ReferenceMatch[]>([]);
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [activeServerId, setActiveServerId] = useState<string | undefined>(undefined);
  const [symbolPaletteOpen, setSymbolPaletteOpen] = useState(false);
  const [referenceSource, setReferenceSource] = useState<NavigationSource | null>(null);
  const referenceRequestRef = useRef(0);
  const [lspProblems, setLspProblems] = useState<Map<string, LspDiagnostic[]>>(new Map());
  const [quickOpen, setQuickOpen] = useState(false); const [quickQuery, setQuickQuery] = useState(""); const [quickFiles, setQuickFiles] = useState<string[]>([]); const [quickIndex, setQuickIndex] = useState(0); const [quickProgress, setQuickProgress] = useState<{ phase: string; scanned: number; matched: number } | null>(null); const [quickError, setQuickError] = useState(""); const [quickRetryNonce, setQuickRetryNonce] = useState(0); const [quickListenersReady, setQuickListenersReady] = useState(false);
  const quickJobRef = useRef<string | null>(null); const quickRequestRef = useRef(0); const quickResultJobRef = useRef<string | null>(null); const searchJobRef = useRef<string | null>(null); const searchResultJobRef = useRef<string | null>(null); const quickOpenRef = useRef(false); const searchingRef = useRef(false); const cancelledQuickJobsRef = useRef(new Set<string>()); const cancelledSearchJobsRef = useRef(new Set<string>());
  quickOpenRef.current = quickOpen;
  searchingRef.current = searching;

  const persist = useCallback((override: Partial<ProjectWorkbenchState> = {}) => {
    try { localStorage.setItem(storageKey, saveWorkbenchState({ version: 1, activity, bottomOpen, bottomHeight, bottomView, openFiles, activeFile, secondaryFile, splitEditors, ...override })); } catch { /* local storage unavailable */ }
  }, [activeFile, activity, bottomHeight, bottomOpen, bottomView, openFiles, secondaryFile, splitEditors, storageKey]);
  useEffect(() => { persist(); }, [persist]);
  useEffect(() => { onDirtyRef.current(dirtyFiles.size > 0, [...dirtyFiles]); }, [dirtyFiles]);
  useEffect(() => () => onDirtyRef.current(false, []), []);

  const loadDirectory = useCallback(async (relativePath = "") => {
    const requestId = (directoryRequestRef.current.get(relativePath) ?? 0) + 1;
    directoryRequestRef.current.set(relativePath, requestId);
    const requestRoot = project.local_path;
    setTreeLoading(true);
    setDirectoryStates((current) => ({ ...current, [relativePath]: "loading" }));
    const isCurrent = () => projectIdentityRef.current === requestRoot && directoryRequestRef.current.get(relativePath) === requestId;
    try {
      const entries = await invokeWithTimeout(invoke<FileEntry[]>("project_list_dir", { root: requestRoot, relativePath, exclude: workspaceConfig.exclude ?? null }), "project_list_dir");
      if (!isCurrent()) return;
      setDirectories((current) => ({ ...current, [relativePath]: entries }));
      setTreeError("");
      setDirectoryStates((current) => ({ ...current, [relativePath]: "ready" }));
    } catch (reason) {
      if (isCurrent()) {
        const message = String(reason);
        setTreeError(message);
        setDirectoryStates((current) => ({ ...current, [relativePath]: /超时|timeout/i.test(message) ? "timed_out" : "error" }));
      }
    } finally {
      if (isCurrent()) setTreeLoading(false);
    }
  }, [project.local_path, workspaceConfig.exclude]);
  const refreshGit = useCallback(async () => { const requestId = ++gitRequestRef.current; const requestRoot = project.local_path; try { const next = await invoke<GitStatusResult>("local_git_status", { repoPath: requestRoot }); if (requestId !== gitRequestRef.current || projectIdentityRef.current !== requestRoot) return; setGit(next); setGitError(""); } catch (reason) { if (requestId === gitRequestRef.current && projectIdentityRef.current === requestRoot) setGitError(String(reason)); } }, [project.local_path]);
  const loadWorkspaceConfig = useCallback(async () => {
    const requestId = ++workspaceConfigRequestRef.current;
    const requestRoot = project.local_path;
    try {
      const file = await invokeWithTimeout(invoke<{ content: string }>("project_read_file", { root: requestRoot, relativePath: ".simpl-ssh/workspace.json" }), "project_read_file");
      if (requestId !== workspaceConfigRequestRef.current || projectIdentityRef.current !== requestRoot) return;
      setWorkspaceConfig(parseWorkspaceConfig(file.content));
      setConfigNotice("");
    } catch (reason) {
      if (requestId !== workspaceConfigRequestRef.current || projectIdentityRef.current !== requestRoot) return;
      const message = String(reason);
      // A missing workspace file is the normal first-run state. Other failures
      // must remain visible so a broken workspace never looks like an empty one.
      if (/no such file|not found|不存在|无法访问/i.test(message)) {
        setWorkspaceConfig(EMPTY_WORKSPACE_CONFIG);
        setConfigNotice("");
      } else {
        setConfigNotice(`工作区配置读取失败：${message}`);
        toast(`工作区配置读取失败：${message}`, "error");
      }
    }
  }, [project.local_path, toast]);
  const refreshTree = useCallback(() => { setDirectories({}); setDirectoryStates({}); setExpanded(new Set([""])); void loadDirectory(""); }, [loadDirectory]);

  useEffect(() => { setDirectories({}); setDirectoryStates({}); setExpanded(new Set([""])); setSelectedPaths(new Set()); void loadDirectory(""); void refreshGit(); void loadWorkspaceConfig(); return () => { gitRequestRef.current += 1; workspaceConfigRequestRef.current += 1; }; }, [loadDirectory, loadWorkspaceConfig, refreshGit]);
  // 工作区排除规则在配置读取完成后才可用；重新读取根目录，避免首次打开
  // 先展示被排除文件、之后却只在手动刷新时才消失。
  useEffect(() => {
    if (!workspaceConfig.exclude?.length) return;
    setDirectories({});
    setDirectoryStates({});
    setExpanded(new Set([""]));
    void loadDirectory("");
  }, [loadDirectory, workspaceConfig.exclude]);
  useEffect(() => {
    const watchId = Date.now() + Math.floor(Math.random() * 1000);
    if (!active || openFiles.length === 0) { void invoke("project_watch_stop", { root: project.local_path, watchId }).catch(() => undefined); return; }
    void invoke("project_watch_start", { root: project.local_path, paths: openFiles, watchId }).catch((reason) => toast(`文件监听启动失败：${String(reason)}`, "error"));
    return () => { void invoke("project_watch_stop", { root: project.local_path, watchId }).catch(() => undefined); };
  }, [active, openFiles, project.local_path, toast]);
  useEffect(() => {
    let unProgress: (() => void) | undefined;
    let unResult: (() => void) | undefined;
    let disposed = false;
    const progressPromise = listen<{ job_id: string; phase: string; scanned: number; matched: number; done: boolean; cancelled: boolean; error?: string }>("project://index-progress", (event) => {
      if (cancelledQuickJobsRef.current.has(event.payload.job_id)) return;
      if (event.payload.job_id !== quickJobRef.current) { if (quickJobRef.current === null && quickOpenRef.current) quickJobRef.current = event.payload.job_id; else return; }
      if (event.payload.error) { setQuickError(event.payload.error); setQuickProgress({ phase: "error", scanned: event.payload.scanned, matched: event.payload.matched }); toast(`快速打开索引失败：${event.payload.error}`, "error"); return; }
      if (event.payload.cancelled) { setQuickProgress({ phase: "cancelled", scanned: event.payload.scanned, matched: event.payload.matched }); return; }
      if (event.payload.done) { if (quickResultJobRef.current !== event.payload.job_id) setQuickProgress({ phase: "done", scanned: event.payload.scanned, matched: event.payload.matched }); return; }
      setQuickProgress({ phase: event.payload.phase, scanned: event.payload.scanned, matched: event.payload.matched });
    });
    const resultPromise = listen<{ job_id: string; paths: string[] }>("project://index-result", (event) => {
      if (cancelledQuickJobsRef.current.has(event.payload.job_id)) return;
      if (event.payload.job_id !== quickJobRef.current) { if (quickJobRef.current === null && quickOpenRef.current) quickJobRef.current = event.payload.job_id; else return; }
      quickResultJobRef.current = event.payload.job_id; setQuickFiles(event.payload.paths); setQuickIndex(0); setQuickProgress(null); setQuickError("");
    });
    void Promise.all([progressPromise, resultPromise]).then(([progressCleanup, resultCleanup]) => {
      if (disposed) { progressCleanup(); resultCleanup(); return; }
      unProgress = progressCleanup; unResult = resultCleanup; setQuickListenersReady(true);
    }).catch((reason) => toast(`快速打开监听失败：${String(reason)}`, "error"));
    return () => { disposed = true; setQuickListenersReady(false); unProgress?.(); unResult?.(); };
  }, [toast]);
  useEffect(() => {
    let disposed = false;
    let unProgress: (() => void) | undefined;
    let unResult: (() => void) | undefined;
    const progressPromise = listen<{ job_id: string; phase: string; scanned: number; matched: number; done: boolean; cancelled: boolean; error?: string }>("project://search-progress", (event) => {
      if (cancelledSearchJobsRef.current.has(event.payload.job_id)) return;
      if (event.payload.job_id !== searchJobRef.current) { if (searchJobRef.current === null && searchingRef.current) searchJobRef.current = event.payload.job_id; else return; }
      if (event.payload.error) { setSearchError(event.payload.error); setSearchProgress({ phase: "error", scanned: event.payload.scanned, matched: event.payload.matched }); setSearching(false); return; }
      if (event.payload.cancelled) { setSearchProgress({ phase: "cancelled", scanned: event.payload.scanned, matched: event.payload.matched }); setSearching(false); return; }
      if (event.payload.done && searchResultJobRef.current !== event.payload.job_id) { setSearchProgress({ phase: "done", scanned: event.payload.scanned, matched: event.payload.matched }); setSearching(false); return; }
      setSearchProgress({ phase: event.payload.phase, scanned: event.payload.scanned, matched: event.payload.matched });
    });
    const resultPromise = listen<{ job_id: string; matches: SearchMatch[] }>("project://search-result", (event) => {
      if (cancelledSearchJobsRef.current.has(event.payload.job_id)) return;
      if (event.payload.job_id !== searchJobRef.current) { if (searchJobRef.current === null && searchingRef.current) searchJobRef.current = event.payload.job_id; else return; }
      searchResultJobRef.current = event.payload.job_id;
      setSearchResults(event.payload.matches);
      setSearchError("");
      setSearchProgress(null);
      setSearching(false);
    });
    void Promise.all([progressPromise, resultPromise]).then(([progressCleanup, resultCleanup]) => {
      if (disposed) { progressCleanup(); resultCleanup(); return; }
      unProgress = progressCleanup; unResult = resultCleanup; setSearchListenersReady(true);
    }).catch((reason) => setSearchError(`搜索监听失败：${String(reason)}`));
    return () => { disposed = true; setSearchListenersReady(false); unProgress?.(); unResult?.(); };
  }, []);
  useEffect(() => {
    const requestId = ++quickRequestRef.current;
    const previousJob = quickJobRef.current;
    quickJobRef.current = null;
    if (previousJob) { cancelledQuickJobsRef.current.add(previousJob); void invoke("project_index_cancel", { jobId: previousJob }).catch(() => undefined); }
    if (!quickOpen || !quickListenersReady) { setQuickProgress(null); setQuickError(""); return; }
    quickResultJobRef.current = null;
    setQuickError("");
    const timer = window.setTimeout(() => {
      setQuickProgress({ phase: "scanning", scanned: 0, matched: 0 });
      void invoke<string>("project_index_start", { root: project.local_path, query: quickQuery || null, limit: 1000, exclude: workspaceConfig.exclude ?? null })
        .then((jobId) => {
          if (requestId !== quickRequestRef.current) { void invoke("project_index_cancel", { jobId }).catch(() => undefined); return; }
          quickJobRef.current = jobId;
        })
        .catch((reason) => { if (requestId === quickRequestRef.current) { setQuickError(String(reason)); setQuickProgress({ phase: "error", scanned: 0, matched: 0 }); toast(String(reason), "error"); } });
    }, 120);
    return () => { window.clearTimeout(timer); };
  }, [project.local_path, quickListenersReady, quickOpen, quickQuery, quickRetryNonce, toast, workspaceConfig.exclude]);
  useEffect(() => () => { const jobId = quickJobRef.current; if (jobId) void invoke("project_index_cancel", { jobId }).catch(() => undefined); }, []);
  useEffect(() => () => { const jobId = searchJobRef.current; if (jobId) void invoke("project_search_cancel", { jobId }).catch(() => undefined); }, []);
  const handledBatchJobsRef = useRef(new Set<string>());
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ProjectBatchJob>("project-batch://state", (event) => {
      const job = event.payload;
      if (job.root !== project.local_path || !["succeeded", "partial", "failed", "cancelled"].includes(job.status)) return;
      const key = `${job.id}:${job.status}:${job.completed}:${job.failed}:${job.skipped}`;
      if (handledBatchJobsRef.current.has(key)) return;
      handledBatchJobsRef.current.add(key);
      if (job.operation === "move" && job.changes.length > 0) applyPathChanges(job.changes);
      if (job.operation === "delete" && job.changes.length > 0) markDeletedPaths(job.changes.map((change) => change.from));
      refreshTree();
      if (job.status === "partial" || job.status === "failed") toast(`项目${job.operation === "delete" ? "删除" : job.operation === "move" ? "移动" : "复制"}部分失败，请在任务抽屉查看详情`, "error");
    }).then((cleanup) => { if (disposed) cleanup(); else unlisten = cleanup; }).catch((reason) => toast(`项目任务状态监听失败：${String(reason)}`, "error"));
    return () => { disposed = true; unlisten?.(); };
  }, [project.local_path, refreshTree, toast]);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (!active || event.repeat) return; const target = event.target instanceof HTMLElement ? event.target : null; if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight") && target?.closest(".local-editor-pane")) { event.preventDefault(); if (event.key === "ArrowLeft") navigateBack(); else navigateForwardToLocation(); return; } if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "p" || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return; event.preventDefault(); setQuickOpen(true); setQuickQuery(""); }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, [active, currentNavigation, navigationForward, navigationHistory]);
  useEffect(() => { const open = () => { if (active) { setQuickOpen(true); setQuickQuery(""); } }; window.addEventListener("simpl-ssh:project-quick-open", open); return () => window.removeEventListener("simpl-ssh:project-quick-open", open); }, [active]);

  function openFile(path: string, preserveNavigation = false) { setMissingFiles((current) => { const next = new Set(current); next.delete(path); return next; }); setOpenFiles((current) => current.includes(path) ? current : [...current, path]); setActiveFile(path); if (!preserveNavigation) setCurrentNavigation({ filePath: path, line: 0, character: 0 }); if (splitEditors && !secondaryFile) setSecondaryFile(path); }
  function applyNavigationTarget(requestId: number) { setNavigationTarget((current) => current?.requestId === requestId ? null : current); }
  function navigateToLocation(location: LspLocation, source: NavigationSource) {
    const path = relativePathFromFileUri(project.local_path, location.uri);
    if (!path) { toast("无法定位定义：目标不在当前项目目录内。", "error"); return; }
    jumpToLocation(path, location.range.start.line, location.range.start.character, source);
  }
  function jumpToLocation(path: string, line: number, character: number, historySource: NavigationSource | null) {
    if (historySource) setNavigationHistory((history) => [...history, historySource]);
    setNavigationForward([]);
    const target: NavigationTarget = { filePath: path, line, character, requestId: Date.now() };
    setCurrentNavigation({ filePath: path, line, character });
    setNavigationTarget(target);
    openFile(path, true);
  }
  function openFileAtPosition(path: string, line: number, character: number) {
    jumpToLocation(path, line, character, currentNavigation);
  }
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "t") return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      event.preventDefault();
      setSymbolPaletteOpen(true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active]);
  function navigateBack() {
    const previous = navigationHistory[navigationHistory.length - 1];
    if (!previous) return;
    setNavigationHistory((history) => history.slice(0, -1));
    if (currentNavigation) setNavigationForward((history) => [...history, currentNavigation]);
    const target: NavigationTarget = { ...previous, requestId: Date.now() };
    setCurrentNavigation(previous); setNavigationTarget(target); openFile(previous.filePath, true);
  }
  function navigateForwardToLocation() {
    const next = navigationForward[navigationForward.length - 1];
    if (!next) return;
    setNavigationForward((history) => history.slice(0, -1));
    if (currentNavigation) setNavigationHistory((history) => [...history, currentNavigation]);
    const target: NavigationTarget = { ...next, requestId: Date.now() };
    setCurrentNavigation(next); setNavigationTarget(target); openFile(next.filePath, true);
  }
  async function showReferences(locations: LspLocation[], source: NavigationSource) {
    const requestId = ++referenceRequestRef.current;
    const matches = locations.flatMap((location) => {
      const path = relativePathFromFileUri(project.local_path, location.uri);
      return path ? [{ path, line: location.range.start.line, character: location.range.start.character, preview: "", location }] : [];
    }).slice(0, 100);
    const enriched = await Promise.all(matches.map(async (match) => {
      try {
        const file = await invokeWithTimeout(invoke<RemoteFileContent>("project_read_file", { root: project.local_path, relativePath: match.path }), "project_read_file");
        const preview = file.content.split("\n")[match.line]?.trim() ?? "";
        return { ...match, preview };
      } catch { return match; }
    }));
    if (requestId !== referenceRequestRef.current) return;
    setReferences(enriched); setReferenceSource(source); setBottomOpen(true); setBottomView("references");
  }
  function closeFile(path: string) { if (dirtyFiles.has(path)) { toast(`请先保存 ${displayName(path)}，或关闭整个工作台后放弃修改。`, "info"); return; } setOpenFiles((current) => current.filter((item) => item !== path)); setActiveFile((current) => current === path ? openFiles.find((item) => item !== path) ?? null : current); setSecondaryFile((current) => current === path ? null : current); }
  const markDirty = useCallback((path: string, dirty: boolean) => {
    setDirtyFiles((current) => {
      const alreadyDirty = current.has(path);
      if (alreadyDirty === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(path); else next.delete(path);
      return next;
    });
  }, []);
  function toggleDirectory(path: string) { setSelectedDirectory(path); setExpanded((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else { next.add(path); if (!directories[path]) void loadDirectory(path); } return next; }); }
  function selectPath(path: string, event: React.MouseEvent) { setSelectedPaths((current) => { const next = new Set(current); if (event.metaKey || event.ctrlKey) { next.has(path) ? next.delete(path) : next.add(path); } else { next.clear(); next.add(path); } return next; }); }
  async function runSearch() {
    const requestId = ++searchRequestRef.current;
    const previousJob = searchJobRef.current;
    searchJobRef.current = null;
    if (previousJob) { cancelledSearchJobsRef.current.add(previousJob); void invoke("project_search_cancel", { jobId: previousJob }).catch(() => undefined); }
    if (!query.trim()) { setSearchResults([]); setSearchProgress(null); setSearchError(""); setSearching(false); return; }
    if (!searchListenersReady) { setSearchError("搜索服务正在准备，请稍后重试。"); return; }
    setSearching(true);
    setSearchError("");
    setSearchProgress({ phase: "scanning", scanned: 0, matched: 0 });
    searchResultJobRef.current = null;
    try {
      const jobId = await invoke<string>("project_search_start", { root: project.local_path, query, limit: 200, exclude: workspaceConfig.exclude ?? null });
      if (requestId !== searchRequestRef.current) { void invoke("project_search_cancel", { jobId }).catch(() => undefined); return; }
      searchJobRef.current = jobId;
    } catch (reason) {
      if (requestId === searchRequestRef.current) { setSearchError(String(reason)); setSearchProgress({ phase: "error", scanned: 0, matched: 0 }); setSearching(false); }
    }
  }
  async function createWorkspaceConfig() { const next: WorkspaceConfig = { version: 1, tasks: [] }; try { await invoke("project_write_file", { root: project.local_path, relativePath: ".simpl-ssh/workspace.json", content: serializeWorkspaceConfig(next), expectedRevision: null }); setWorkspaceConfig(next); setConfigNotice("已创建 .simpl-ssh/workspace.json。"); refreshTree(); } catch (reason) { setConfigNotice(String(reason)); } }
  async function addWorkspaceTask() { if (!taskLabel.trim() || !taskDefinition.trim()) return; const next = { ...workspaceConfig, tasks: [...workspaceConfig.tasks, { id: crypto.randomUUID(), label: taskLabel.trim(), command: taskDefinition.trim(), group: "custom" as const }] }; try { await invoke("project_write_file", { root: project.local_path, relativePath: ".simpl-ssh/workspace.json", content: serializeWorkspaceConfig(next), expectedRevision: null }); setWorkspaceConfig(next); setTaskLabel(""); setTaskDefinition(""); setConfigNotice("任务已写入可共享的工作区配置。"); } catch (reason) { setConfigNotice(String(reason)); } }
  async function updateLanguageOverride(id: string, patch: Partial<LanguageServerOverride>) {
    const current = workspaceConfig.languageServers ?? [];
    const existing = current.find((item) => item.id === id);
    const nextOverrides = existing ? current.map((item) => item.id === id ? { ...item, ...patch } : item) : [...current, { id, languages: settings.languageServers.find((server) => server.id === id)?.languages ?? [], ...patch }];
    const next = { ...workspaceConfig, languageServers: nextOverrides };
    try { await invoke("project_write_file", { root: project.local_path, relativePath: ".simpl-ssh/workspace.json", content: serializeWorkspaceConfig(next), expectedRevision: null }); setWorkspaceConfig(next); setConfigNotice("项目语言服务覆盖已保存。"); } catch (reason) { setConfigNotice(String(reason)); }
  }
  async function updatePluginOverride(pluginId: string, patch: Partial<import("../ide/workspaceConfig").LanguageServerPluginOverride>) {
    const current = workspaceConfig.lspPlugins ?? [];
    const existing = current.find((item) => item.pluginId === pluginId);
    const next = { ...workspaceConfig, lspPlugins: existing ? current.map((item) => item.pluginId === pluginId ? { ...item, ...patch } : item) : [...current, { pluginId, ...patch }] };
    try { await invoke("project_write_file", { root: project.local_path, relativePath: ".simpl-ssh/workspace.json", content: serializeWorkspaceConfig(next), expectedRevision: null }); setWorkspaceConfig(next); setConfigNotice("项目插件覆盖已保存。"); } catch (reason) { setConfigNotice(String(reason)); }
  }
  async function runTask(task: WorkspaceTask) { try { await invoke("project_task_start", { root: project.local_path, taskId: task.id, label: task.label, command: task.command }); setBottomOpen(true); setBottomView("tasks"); } catch (reason) { toast(String(reason)); } }
  async function mutateGit(command: "local_git_add" | "local_git_unstage" | "local_git_push" | "local_git_pull" | "local_git_commit", path?: string) { setGitBusy(true); setGitError(""); try { const args: Record<string, unknown> = { repoPath: project.local_path }; if (path) args.path = path; if (command === "local_git_commit") args.message = commitMessage; await invoke(command, args); if (command === "local_git_commit") setCommitMessage(""); await refreshGit(); } catch (reason) { setGitError(String(reason)); } finally { setGitBusy(false); } }
  async function showDiff(path: string) { try { setDiff(await invoke<GitDiffResult>("local_git_diff", { repoPath: project.local_path, file: path })); } catch (reason) { setGitError(String(reason)); } }
  function remapPath(path: string, changes: Array<ProjectPathChange | ProjectBatchChange>): string { for (const change of changes) { if (change.to && (path === change.from || path.startsWith(`${change.from}/`))) return `${change.to}${path.slice(change.from.length)}`; } return path; }
  function applyPathChanges(changes: Array<ProjectPathChange | ProjectBatchChange>) { if (!changes.length) return; setOpenFiles((current) => current.map((path) => remapPath(path, changes))); setActiveFile((current) => current ? remapPath(current, changes) : current); setSecondaryFile((current) => current ? remapPath(current, changes) : current); setDirtyFiles((current) => new Set([...current].map((path) => remapPath(path, changes)))); setMissingFiles((current) => new Set([...current].map((path) => remapPath(path, changes)))); }
  function markDeletedPaths(paths: string[]) { setMissingFiles((current) => { const next = new Set(current); for (const open of openFiles) if (paths.some((deleted) => open === deleted || open.startsWith(`${deleted}/`))) next.add(open); return next; }); }
  async function submitEntry(name: string) { if (!entryDialog) return; try { if (entryDialog.type === "rename" && entryDialog.path) { const result = await invoke<ProjectPathChange>("project_rename", { root: project.local_path, path: entryDialog.path, newName: name }); applyPathChanges([result]); } else await invoke("project_create_entry", { root: project.local_path, parentPath: selectedDirectory, name, directory: entryDialog.type === "folder" }); setEntryDialog(null); refreshTree(); } catch (reason) { toast(String(reason), "error"); } }
  async function pasteIntoDestination() { if (!clipboard) return; try { await invoke<string>("project_batch_start", { operation: clipboard.mode === "copy" ? "copy" : "move", root: project.local_path, paths: clipboard.paths, destination: selectedDirectory, confirmed: false }); setClipboard(null); setSelectedPaths(new Set()); toast("项目文件操作已加入后台任务", "info"); } catch (reason) { toast(String(reason), "error"); } }
  async function requestDelete() { if (!selectedPaths.size) return; try { setDeletePreview(await invoke<ProjectDeletePreview>("project_delete_preview", { root: project.local_path, paths: [...selectedPaths] })); } catch (reason) { toast(String(reason)); } }
  async function confirmDelete() { if (!deletePreview) return; try { await invoke<string>("project_batch_start", { operation: "delete", root: project.local_path, paths: deletePreview.paths, destination: null, confirmed: true }); setDeletePreview(null); setSelectedPaths(new Set()); toast("删除任务已加入后台；完成后文件标签会标记为不存在", "info"); } catch (reason) { toast(String(reason), "error"); } }
  async function dropMove(destination: string) { if (!selectedPaths.size || selectedPaths.has(destination)) return; try { await invoke<string>("project_batch_start", { operation: "move", root: project.local_path, paths: [...selectedPaths], destination, confirmed: false }); setSelectedPaths(new Set()); toast("移动任务已加入后台", "info"); } catch (reason) { toast(String(reason), "error"); } }

  const primaryFile = activeFile; const secondary = splitEditors ? (secondaryFile && secondaryFile !== primaryFile ? secondaryFile : openFiles.find((file) => file !== primaryFile) ?? null) : null;
  const primaryDirtyChange = useCallback((dirty: boolean) => { if (primaryFile) markDirty(primaryFile, dirty); }, [markDirty, primaryFile]);
  const secondaryDirtyChange = useCallback((dirty: boolean) => { if (secondary) markDirty(secondary, dirty); }, [markDirty, secondary]);
  const handleDiagnosticsChange = useCallback((path: string, diagnostics: LspDiagnostic[]) => {
    setLspProblems((prev) => { const next = new Map(prev); if (diagnostics.length) next.set(path, diagnostics); else next.delete(path); return next; });
  }, []);
  const handleApplyEdits = useCallback(async (edits: FileTextEdit[]) => {
    for (const file of edits) {
      try {
        const original = await invokeWithTimeout(invoke<RemoteFileContent>("project_read_file", { root: project.local_path, relativePath: file.path }), "project_read_file");
        await invoke("project_write_file", { root: project.local_path, relativePath: file.path, content: applyEditsToString(original.content, file.edits), expectedRevision: original.revision ?? null });
      } catch (reason) { toast(`应用编辑到 ${file.path} 失败：${String(reason)}`, "error"); }
    }
    refreshTree();
  }, [project.local_path, refreshTree, toast]);
  const lspProblemRows = useMemo<LspProblemRow[]>(() => Array.from(lspProblems.entries()).flatMap(([path, diagnostics]) => diagnostics.map((diagnostic) => ({ path, line: diagnostic.range?.start?.line ?? 0, character: diagnostic.range?.start?.character ?? 0, severity: diagnostic.severity, message: diagnostic.message ?? "", source: diagnostic.source }))), [lspProblems]);
  function renderEntries(parent = "", depth = 0): ReactNode { const entries = directories[parent]; const state = directoryStates[parent]; if (!entries) { if (state === "loading" || (depth === 0 && treeLoading)) return <LoadingState compact label="正在读取项目文件…" detail="大型项目首次索引可能需要一点时间" />; if (state === "timed_out") return <div className="project-tree-state error">读取超时<button type="button" onClick={() => void loadDirectory(parent)}>重试</button></div>; if (state === "error") return <div className="project-tree-state error">目录读取失败<button type="button" onClick={() => void loadDirectory(parent)}>重试</button></div>; return null; } return entries.map((entry) => { const path = joinPath(parent, entry.name); const directory = entry.is_dir; const selected = selectedPaths.has(path); return <div key={path}><button draggable className={`project-tree-row ${activeFile === path ? "active" : ""} ${selected ? "selected" : ""}`} style={{ paddingLeft: 10 + depth * 14 }} onClick={(event) => { selectPath(path, event); if (directory) toggleDirectory(path); else openFile(path); }} onDragStart={(event) => { if (!selected) setSelectedPaths(new Set([path])); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { if (directory) event.preventDefault(); }} onDrop={(event) => { if (directory) { event.preventDefault(); void dropMove(path); } }} title={path}>{directory ? (expanded.has(path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <FileCode2 size={14} />}<span>{entry.name}</span></button>{directory && expanded.has(path) && renderEntries(path, depth + 1)}</div>; }); }

  return <section className={`project-workbench ${sideOpen ? "" : "project-side-closed"}`} aria-label={`${project.name} 项目工作台`}>
    <nav className="project-activity-bar" aria-label="项目工作区">
      {ACTIVITY_ITEMS.map(({ id, label, icon: Icon }) => <button key={id} className={activity === id ? "active" : ""} aria-label={label} title={label} onClick={() => { setActivity(id); setSideOpen(true); }}><Icon size={19} /></button>)}
    </nav>
    <aside className="project-side-panel">
      <header><strong>{ACTIVITY_ITEMS.find((item) => item.id === activity)?.label}</strong><button className="icon-btn" title="刷新" onClick={() => { refreshTree(); void refreshGit(); }}><Activity size={14} /></button><button className="icon-btn project-side-close" title="关闭侧栏" aria-label="关闭侧栏" onClick={() => setSideOpen(false)}><X size={14} /></button></header>
      {treeError && <ErrorState label="项目文件不可用" message={treeError} onRetry={refreshTree} />}
      {activity === "explorer" && <div className="project-tree">
        <div className="project-tree-actions">
          <button title="新建文件" onClick={() => setEntryDialog({ type: "file" })}><FilePlus2 size={14} /> 文件</button><button title="新建文件夹" onClick={() => setEntryDialog({ type: "folder" })}><FolderPlus size={14} /> 文件夹</button>
          <button disabled={selectedPaths.size !== 1} onClick={() => setEntryDialog({ type: "rename", path: [...selectedPaths][0] })}>重命名</button><button disabled={!selectedPaths.size} title="复制" onClick={() => setClipboard({ mode: "copy", paths: [...selectedPaths] })}><Copy size={14} /></button><button disabled={!selectedPaths.size} title="剪切" onClick={() => setClipboard({ mode: "cut", paths: [...selectedPaths] })}><Clipboard size={14} /></button><button disabled={!clipboard} onClick={() => void pasteIntoDestination()}>粘贴</button><button disabled={!selectedPaths.size} className="danger" title="删除" onClick={() => void requestDelete()}><Trash2 size={14} /></button>
        </div>
        <div className="project-root"><FolderGit2 size={14} /> {project.name}<small>{selectedDirectory || "/"}</small></div>{renderEntries()}
      </div>}
      {activity === "search" && <div className="project-search"><div className="project-search-input"><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void runSearch()} placeholder="在项目中搜索文本" /><button className="icon-btn" onClick={() => void runSearch()} aria-label="搜索"><Search size={14} /></button></div>{searching && <LoadingState compact label="正在搜索…" detail={searchProgress ? `已扫描 ${searchProgress.scanned} 项，命中 ${searchProgress.matched} 项` : undefined} />}{searchProgress?.phase === "cancelled" && <div className="project-search-empty">搜索已取消，保留上一次结果。</div>}{searchError && <div className="project-tree-state error" role="alert">搜索失败：{searchError}<button type="button" onClick={() => void runSearch()}>重试</button>{searchResults.length > 0 && <button type="button" onClick={() => setSearchResults([])}>清除旧结果</button>}</div>}{!searching && !searchError && searchResults.length > 0 && <div className="project-search-results">{searchResults.map((result) => <button key={`${result.path}:${result.line}`} onClick={() => openFile(result.path)}><strong>{result.path}:{result.line}</strong><span>{result.preview}</span></button>)}</div>}{!searching && !searchError && searchResults.length === 0 && query.trim() && <p className="project-search-empty">暂无匹配结果。</p>}</div>}
      {activity === "scm" && <ScmPanel git={git} error={gitError} busy={gitBusy} message={commitMessage} diff={diff} onMessage={setCommitMessage} onRefresh={() => void refreshGit()} onMutate={mutateGit} onDiff={showDiff} onOpenFile={openFile} />}
      {activity === "run" && <div className="project-run"><p>任务仅在你点击后于本地项目目录执行；任务进程不会在重启后恢复。</p>{workspaceConfig.tasks.length ? workspaceConfig.tasks.map((task) => <button key={task.id} onClick={() => void runTask(task)}><Play size={14} /><span>{task.label}</span><small>{task.command}</small></button>) : <button className="btn btn-ghost" onClick={() => void createWorkspaceConfig()}><Plus size={14} /> 创建工作区任务配置</button>}<div className="project-task-create"><input value={taskLabel} onChange={(event) => setTaskLabel(event.target.value)} placeholder="任务名称，例如：测试" /><input value={taskDefinition} onChange={(event) => setTaskDefinition(event.target.value)} placeholder="命令，例如：pnpm test" /><button className="btn btn-ghost" disabled={!taskLabel.trim() || !taskDefinition.trim()} onClick={() => void addWorkspaceTask()}><Plus size={13} /> 添加任务</button></div>{configNotice && <p className="project-config-notice">{configNotice}</p>}</div>}
      {activity === "language" && <LanguagePanel servers={settings.languageServers} plugins={LSP_PLUGIN_CATALOG} installedPlugins={settings.installedLspPlugins} overrides={workspaceConfig.languageServers} pluginOverrides={workspaceConfig.lspPlugins} onUpdate={updateLanguageOverride} onPluginUpdate={updatePluginOverride} onCreateConfig={() => void createWorkspaceConfig()} />}
      {activity === "remote" && <div className="project-remote-panel">{workspaces(project).length ? workspaces(project).map((workspace) => { const profile = profiles.find((item) => item.id === workspace.profile_id); return <div key={workspace.profile_id} className="project-remote-card"><strong>{profile?.name ?? "缺失连接"}</strong><span>{workspace.remote_path || "登录默认目录"}</span><div><button onClick={() => onOpenRemote(workspace, "terminal")}><SquareTerminal size={13} /> 终端</button><button onClick={() => onOpenRemote(workspace, "sftp")}><Folder size={13} /> 文件</button><button onClick={() => onOpenRemote(workspace, "git")}><GitBranch size={13} /> Git</button></div></div>; }) : <p>此项目尚未关联远程环境。</p>}</div>}
    </aside>
    {sideOpen && <button type="button" className="project-side-scrim" aria-label="关闭项目侧栏" onClick={() => setSideOpen(false)} />}
    <main className="project-editor-area">
      <div className="project-editor-tabs"><button className="icon-btn editor-nav" aria-label="返回上一个代码位置" title="返回上一个代码位置 (Alt/Option + ←)" disabled={!navigationHistory.length} onClick={navigateBack}><ArrowLeft size={14} /></button><button className="icon-btn editor-nav" aria-label="前进到下一个代码位置" title="前进到下一个代码位置" disabled={!navigationForward.length} onClick={navigateForwardToLocation}><ArrowRight size={14} /></button>{openFiles.map((file) => <button key={file} className={file === primaryFile ? "active" : ""} onClick={() => { setActiveFile(file); setCurrentNavigation({ filePath: file, line: 0, character: 0 }); }}><span>{dirtyFiles.has(file) ? "● " : ""}{displayName(file)}</span><X size={13} onClick={(event) => { event.stopPropagation(); closeFile(file); }} /></button>)}<span className="project-editor-spacer" /><button className="icon-btn" aria-label="更多编辑器操作" title="保存使用 ⌘/Ctrl+S；更多操作可从命令面板执行" onClick={() => window.dispatchEvent(new Event("simpl-ssh:open-command-palette"))}><MoreHorizontal size={15} /></button><button className="icon-btn" title={splitEditors ? "关闭编辑器拆分" : "拆分编辑器"} onClick={() => setSplitEditors((value) => !value)}><Braces size={15} /></button><button className="icon-btn" title="打开/关闭底部面板" onClick={() => setBottomOpen((value) => !value)}>{bottomOpen ? <PanelBottomClose size={15} /> : <PanelBottomOpen size={15} />}</button></div>
      {primaryFile ? <div className={`project-editor-grid ${splitEditors ? "split" : ""}`}><LocalEditorPane root={project.local_path} filePath={primaryFile} projectId={project.id} active={active} editorActive={primaryFile === activeFile} missing={missingFiles.has(primaryFile)} languageServers={settings.languageServers} languageServerOverrides={workspaceConfig.languageServers} pluginCatalog={LSP_PLUGIN_CATALOG} installedPlugins={settings.installedLspPlugins} pluginOverrides={workspaceConfig.lspPlugins} syntaxHighlighting={settings.syntaxHighlighting} languageHighlighting={settings.languageHighlighting} semanticHighlighting={settings.semanticHighlighting} bracketMatching={settings.bracketMatching} highlightActiveLine={settings.highlightActiveLine} showWhitespace={settings.showWhitespace} codeCompletion={settings.codeCompletion} hoverEnabled={settings.hoverEnabled} formatOnSave={settings.formatOnSave} signatureHelp={settings.signatureHelp} navigationTarget={navigationTarget} canNavigateBack={navigationHistory.length > 0} canNavigateForward={navigationForward.length > 0} onNavigateBack={navigateBack} onNavigateForward={navigateForwardToLocation} onNavigateLocation={navigateToLocation} onReferenceLocations={(locations, source) => void showReferences(locations, source)} onNavigationApplied={applyNavigationTarget} onDiagnosticsChange={handleDiagnosticsChange} onApplyEdits={handleApplyEdits} onDocumentSymbol={(symbols) => setOutline(symbols as OutlineNode[])} onActiveServerId={setActiveServerId} onDirtyChange={primaryDirtyChange} />{secondary && <LocalEditorPane root={project.local_path} filePath={secondary} projectId={project.id} active={active} editorActive={secondary === activeFile} missing={missingFiles.has(secondary)} languageServers={settings.languageServers} languageServerOverrides={workspaceConfig.languageServers} pluginCatalog={LSP_PLUGIN_CATALOG} installedPlugins={settings.installedLspPlugins} pluginOverrides={workspaceConfig.lspPlugins} syntaxHighlighting={settings.syntaxHighlighting} languageHighlighting={settings.languageHighlighting} semanticHighlighting={settings.semanticHighlighting} bracketMatching={settings.bracketMatching} highlightActiveLine={settings.highlightActiveLine} showWhitespace={settings.showWhitespace} codeCompletion={settings.codeCompletion} hoverEnabled={settings.hoverEnabled} formatOnSave={settings.formatOnSave} signatureHelp={settings.signatureHelp} navigationTarget={navigationTarget} canNavigateBack={navigationHistory.length > 0} canNavigateForward={navigationForward.length > 0} onNavigateBack={navigateBack} onNavigateForward={navigateForwardToLocation} onNavigateLocation={navigateToLocation} onReferenceLocations={(locations, source) => void showReferences(locations, source)} onNavigationApplied={applyNavigationTarget} onDiagnosticsChange={handleDiagnosticsChange} onApplyEdits={handleApplyEdits} onDirtyChange={secondaryDirtyChange} />}</div> : <div className="project-editor-empty"><FileSearch size={30} /><h2>打开项目中的文件</h2><p>从左侧资源管理器选择文件，或按 <kbd>⌘P</kbd> 在整个项目中快速打开。</p></div>}
      {bottomOpen && <section className="project-bottom-panel" style={{ height: bottomHeight }}><div className="project-bottom-resize" onMouseDown={(event) => { const startY = event.clientY; const startHeight = bottomHeight; const move = (next: MouseEvent) => setBottomHeight(Math.max(150, Math.min(520, startHeight + startY - next.clientY))); const stop = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", stop); }; window.addEventListener("mousemove", move); window.addEventListener("mouseup", stop); }} /><header>{BOTTOM_VIEWS.map((view) => <button key={view.id} className={bottomView === view.id ? "active" : ""} onClick={() => setBottomView(view.id)}>{view.label}{view.id === "tasks" && taskRuns.some((task) => task.status === "running") ? " •" : ""}</button>)}<span /><button className="icon-btn" onClick={() => setBottomOpen(false)} aria-label="关闭底部面板"><X size={14} /></button></header>{bottomView === "terminal" ? <LocalTerminalPane paneId={`${project.id}:workbench`} cwd={project.local_path} active={active} /> : bottomView === "references" ? <ReferencesPanel references={references} onOpen={(match) => { if (referenceSource) setNavigationHistory((history) => [...history, referenceSource]); setNavigationForward([]); const target: NavigationTarget = { filePath: match.path, line: match.line, character: match.character, requestId: Date.now() }; setCurrentNavigation({ filePath: match.path, line: match.line, character: match.character }); openFile(match.path, true); setNavigationTarget(target); }} /> : bottomView === "outline" ? <OutlinePanel symbols={outline} onOpen={(line, character) => { if (activeFile) openFileAtPosition(activeFile, line, character); }} /> : <ProjectTaskPanel root={project.local_path} view={bottomView} lspProblems={lspProblemRows} onOpenFile={(path, line, character) => line != null ? openFileAtPosition(path, line, character ?? 0) : openFile(path)} onTasksChange={setTaskRuns} />}</section>}
    </main>
    {symbolPaletteOpen && <WorkspaceSymbolPalette serverId={activeServerId} root={project.local_path} onClose={() => setSymbolPaletteOpen(false)} onOpen={(location) => navigateToLocation(location, currentNavigation ?? { filePath: activeFile ?? "", line: 0, character: 0 })} />}{quickOpen && <QuickOpenDialog query={quickQuery} files={quickFiles} index={quickIndex} progress={quickProgress} error={quickError} onQuery={setQuickQuery} onIndex={setQuickIndex} onRetry={() => setQuickRetryNonce((value) => value + 1)} onClear={() => setQuickFiles([])} onClose={() => setQuickOpen(false)} onOpen={(path) => { openFile(path); setQuickOpen(false); }} />}{entryDialog && <EntryDialog state={entryDialog} defaultName={entryDialog.path ? displayName(entryDialog.path) : ""} onClose={() => setEntryDialog(null)} onSubmit={submitEntry} />}{deletePreview && <DeleteDialog preview={deletePreview} onClose={() => setDeletePreview(null)} onConfirm={() => void confirmDelete()} />}
  </section>;
}

function ReferencesPanel({ references, onOpen }: { references: ReferenceMatch[]; onOpen: (match: ReferenceMatch) => void }) { return <div className="project-references-panel" aria-label="查找引用结果">{references.length ? references.map((match, index) => <button key={`${match.path}:${match.line}:${match.character}:${index}`} onClick={() => onOpen(match)}><strong>{match.path}:{match.line + 1}</strong><span>{match.preview || "无法读取预览"}</span></button>) : <p>没有找到引用。</p>}</div>; }

function OutlinePanel({ symbols, onOpen }: { symbols: OutlineNode[]; onOpen: (line: number, character: number) => void }) {
  return <div className="project-outline-panel" aria-label="文档大纲">{symbols.length ? symbols.map((node, index) => <OutlineItem key={index} node={node} depth={0} onOpen={onOpen} />) : <p>当前文件没有符号，或语言服务尚未就绪。</p>}</div>;
}
function OutlineItem({ node, depth, onOpen }: { node: OutlineNode; depth: number; onOpen: (line: number, character: number) => void }) {
  const start = node.selectionRange?.start ?? node.range?.start ?? node.location?.range?.start;
  return <div className="project-outline-item"><button style={{ paddingLeft: 10 + depth * 14 }} onClick={() => onOpen(start?.line ?? 0, start?.character ?? 0)}><strong>{node.name ?? "?"}</strong>{node.detail ? <small> {node.detail}</small> : null}</button>{node.children?.map((child, index) => <OutlineItem key={index} node={child} depth={depth + 1} onOpen={onOpen} />)}</div>;
}
function QuickOpenDialog({ query, files, index, progress, error, onQuery, onIndex, onRetry, onClear, onOpen, onClose }: { query: string; files: string[]; index: number; progress: { phase: string; scanned: number; matched: number } | null; error: string; onQuery: (value: string) => void; onIndex: (value: number) => void; onRetry: () => void; onClear: () => void; onOpen: (path: string) => void; onClose: () => void }) { const ref = useDialogFocus(true, onClose); const scanning = progress?.phase === "scanning"; return <div className="project-quick-open" onClick={onClose}><div ref={ref} role="dialog" aria-modal="true" aria-label="快速打开" onClick={(event) => event.stopPropagation()}><input autoFocus value={query} placeholder="按文件名快速打开" onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") onClose(); if (event.key === "ArrowDown") { event.preventDefault(); onIndex(Math.min(index + 1, Math.max(0, files.length - 1))); } if (event.key === "ArrowUp") { event.preventDefault(); onIndex(Math.max(index - 1, 0)); } if (event.key === "Enter" && files[index]) onOpen(files[index]); }} />{progress && <div className="project-quick-progress" role={progress.phase === "error" ? "alert" : "status"}>{scanning ? `正在扫描项目… 已扫描 ${progress.scanned} 项，匹配 ${progress.matched} 项` : progress.phase === "cancelled" ? `已取消扫描，保留 ${files.length} 个旧结果` : progress.phase === "done" ? `扫描完成，共 ${progress.matched} 个匹配` : `索引失败：${error || "未知错误"}`} {progress.phase === "error" && <button type="button" onClick={onRetry}>重试</button>}{progress.phase === "error" && files.length > 0 && <button type="button" onClick={onClear}>清除旧结果</button>}</div>}<div>{files.slice(0, 100).map((file, itemIndex) => <button key={file} className={itemIndex === index ? "active" : ""} onMouseEnter={() => onIndex(itemIndex)} onClick={() => onOpen(file)}>{file}</button>)}</div></div></div>; }
function EntryDialog({ state, defaultName, onClose, onSubmit }: { state: EntryDialogState; defaultName: string; onClose: () => void; onSubmit: (name: string) => void }) { const [name, setName] = useState(defaultName); const ref = useDialogFocus(true, onClose); const title = state?.type === "rename" ? "重命名" : state?.type === "folder" ? "新建文件夹" : "新建文件"; return <div className="overlay" onClick={onClose}><div ref={ref}><form className="dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); onSubmit(name); }}><div className="dialog-head"><strong>{title}</strong></div><div className="dialog-body"><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="名称" /></div><div className="dialog-foot"><button type="button" className="btn btn-ghost" onClick={onClose}>取消</button><button className="btn btn-primary" disabled={!name.trim()}>确认</button></div></form></div></div>; }
function DeleteDialog({ preview, onClose, onConfirm }: { preview: ProjectDeletePreview; onClose: () => void; onConfirm: () => void }) { const ref = useDialogFocus(true, onClose); return <div className="overlay" onClick={onClose}><div ref={ref} className="dialog delete-project-entry-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-project-entries" onClick={(event) => event.stopPropagation()}><div className="dialog-head"><strong id="delete-project-entries">永久删除项目文件</strong></div><div className="dialog-body"><p>将永久删除 <strong>{preview.files} 个文件</strong>和 <strong>{preview.directories} 个文件夹</strong>，此操作无法恢复。</p><ul>{preview.paths.slice(0, 12).map((path) => <li key={path}><code>{path}</code></li>)}</ul></div><div className="dialog-foot"><button className="btn btn-ghost" onClick={onClose}>取消</button><button className="btn btn-danger" onClick={onConfirm}>永久删除</button></div></div></div>; }

function LanguagePanel({ servers, plugins, installedPlugins, overrides, pluginOverrides, onUpdate, onPluginUpdate, onCreateConfig }: { servers: import("../settings/types").LanguageServerConfig[]; plugins: import("../settings/types").LspPluginManifest[]; installedPlugins: import("../settings/types").InstalledLspPlugin[]; overrides?: LanguageServerOverride[]; pluginOverrides?: import("../ide/workspaceConfig").LanguageServerPluginOverride[]; onUpdate: (id: string, patch: Partial<LanguageServerOverride>) => void; onPluginUpdate: (id: string, patch: Partial<import("../ide/workspaceConfig").LanguageServerPluginOverride>) => void; onCreateConfig: () => void }) {
  const availablePlugins = plugins.filter((plugin) => installedPlugins.some((item) => item.pluginId === plugin.id && item.enabled));
  if (!servers.length && !availablePlugins.length) return <div className="project-language-panel"><Code2 size={24} /><h3>尚未配置语言服务</h3><p>在设置 → 语言服务与高亮中安装插件或添加本机 LSP 命令。编辑器仍可使用基础语法高亮。</p><button className="btn btn-ghost" onClick={onCreateConfig}>创建工作区配置</button></div>;
  return <div className="project-language-panel"><p>这里显示本项目实际使用的 LSP。插件优先于自定义命令，项目覆盖只保存启用状态、版本和参数。</p>{availablePlugins.map((plugin) => { const override = pluginOverrides?.find((item) => item.pluginId === plugin.id); const enabled = override?.enabled ?? true; return <div className="project-language-row" key={plugin.id}><div><strong>{plugin.name}</strong><small>插件 · v{override?.version ?? installedPlugins.find((item) => item.pluginId === plugin.id)?.version}</small></div><label><input type="checkbox" checked={enabled} onChange={(event) => void onPluginUpdate(plugin.id, { enabled: event.target.checked })} /> 本项目启用</label></div>; })}{servers.map((server) => { const override = overrides?.find((item) => item.id === server.id); const enabled = override?.enabled ?? server.enabled; const languages = override?.languages ?? server.languages; return <div className="project-language-row" key={server.id}><div><strong>{server.name}</strong><small>{server.command} · {languages.map((language) => languageDefinition(language)?.label ?? language).join(", ")}</small></div><label><input type="checkbox" checked={enabled} onChange={(event) => void onUpdate(server.id, { enabled: event.target.checked })} /> 启用</label><button className="icon-btn" title="覆盖语言关联" onClick={() => void onUpdate(server.id, { languages: languages.length ? [] : server.languages })}><Code2 size={14} /></button></div>; })}</div>;
}

function ScmPanel({ git, error, busy, message, diff, onMessage, onRefresh, onMutate, onDiff, onOpenFile }: { git: GitStatusResult | null; error: string; busy: boolean; message: string; diff: GitDiffResult | null; onMessage: (message: string) => void; onRefresh: () => void; onMutate: (command: "local_git_add" | "local_git_unstage" | "local_git_push" | "local_git_pull" | "local_git_commit", path?: string) => void; onDiff: (path: string) => void; onOpenFile: (path: string) => void }) { return <div className="project-scm">{error && <ErrorState label="Git 操作失败" message={error} onRetry={onRefresh} />}{git ? <><div className="project-scm-branch"><GitBranch size={14} /> {git.branch || "未初始化仓库"}<button className="icon-btn" title="拉取（仅快进）" disabled={busy} onClick={() => onMutate("local_git_pull")}><Download size={13} /></button><button className="icon-btn" title="推送" disabled={busy} onClick={() => onMutate("local_git_push")}><Upload size={13} /></button></div><div className="project-scm-files">{git.files.length ? git.files.map((file) => <div key={file.path} className="project-scm-file"><button onClick={() => { onOpenFile(file.path); onDiff(file.path); }}><em>{file.status}</em><span>{file.path}</span>{file.staged && <small>已暂存</small>}</button><button className="project-scm-stage" disabled={busy} title={file.staged ? "取消暂存" : "暂存"} onClick={() => onMutate(file.staged ? "local_git_unstage" : "local_git_add", file.path)}>{file.staged ? "−" : "+"}</button></div>) : <p>工作区干净。</p>}</div>{diff && <pre className="project-scm-diff">{diff.diff || "此文件没有未暂存差异。"}</pre>}<div className="project-scm-commit"><textarea value={message} onChange={(event) => onMessage(event.target.value)} placeholder="提交信息" rows={2} /><button className="btn btn-primary" disabled={busy || !message.trim()} onClick={() => onMutate("local_git_commit")}>提交</button></div></> : <LoadingState compact label="正在读取 Git 状态…" />}</div>; }
