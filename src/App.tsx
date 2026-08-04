import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BroadcastContext } from "./broadcast";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { MonitorCog, RefreshCw } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceActions } from "./components/WorkspaceActions";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { TabBar } from "./components/TabBar";
import { ConnectDialog } from "./components/ConnectDialog";
import { ConnSteps } from "./components/ConnSteps";
import type { TaskSection } from "./components/TaskDrawer";
import { ConfirmDialog } from "./components/DialogPrimitives";
import { HostKeyDialog } from "./components/HostKeyDialog";
import {
  CommandPalette,
  builtinCommands,
  profileCommands,
  tabCommands,
  snippetCommands,
  type CommandItem,
} from "./components/CommandPalette";
import { useAppShortcuts } from "./hooks/useAppShortcuts";
import { useSettings } from "./settings/SettingsProvider";
import type { AgentPreset } from "./settings/types";
import { useUpdater } from "./hooks/useUpdater";
import { useWorkspaceRestore, type ProfilesLoadState } from "./hooks/useWorkspaceRestore";
import { useTaskSummary, useTasks } from "./tasks/TaskProvider";
import { useTerminalDiagnostics } from "./terminal/TerminalDiagnosticsProvider";
import { useToast, type ToastKind } from "./feedback/ToastProvider";
import { LoadingState } from "./components/LoadingState";
import { useActivity } from "./activity/ActivityProvider";
import { StartPage } from "./components/StartPage";
import { ProjectWorkbenchBoundary } from "./components/ProjectWorkbenchBoundary";
import type {
  AppMode,
  ConnectionProfile,
  HostKeyEvent,
  Project,
  ProjectRemoteWorkspace,
  ProjectAgentBinding,
  ProfileGroup,
  SessionInfo,
  Snippet,
  SplitDir,
  SplitNode,
  Tab,
  TerminalWorkspaceView,
} from "./types";
import "./App.css";

// 仅在用户打开对应工作区时加载重量级面板。终端、编辑器与 LSP 依赖不再阻塞
// 连接列表和开始页的首次可交互时间。
const SftpPane = lazy(() => import("./components/SftpPane").then((module) => ({ default: module.SftpPane })));
const MonitorPane = lazy(() => import("./components/MonitorPane").then((module) => ({ default: module.MonitorPane })));
const EditorPane = lazy(() => import("./components/EditorPane").then((module) => ({ default: module.EditorPane })));
const GitPanel = lazy(() => import("./components/GitPanel").then((module) => ({ default: module.GitPanel })));
const LocalTerminalPane = lazy(() => import("./components/LocalTerminalPane").then((module) => ({ default: module.LocalTerminalPane })));
const TaskDrawer = lazy(() => import("./components/TaskDrawer").then((module) => ({ default: module.TaskDrawer })));
const SettingsDialog = lazy(() => import("./components/SettingsDialog").then((module) => ({ default: module.SettingsDialog })));
const SnippetManager = lazy(() => import("./components/SnippetManager").then((module) => ({ default: module.SnippetManager })));
const BroadcastDialog = lazy(() => import("./components/BroadcastDialog").then((module) => ({ default: module.BroadcastDialog })));
const UnsavedChangesDialog = lazy(() => import("./components/UnsavedChangesDialog").then((module) => ({ default: module.UnsavedChangesDialog })));
const ProjectWorkbench = lazy(() => import("./components/ProjectWorkbench").then((module) => ({ default: module.ProjectWorkbench })));
const TerminalFileWorkspace = lazy(() => import("./components/TerminalFileWorkspace").then((module) => ({ default: module.TerminalFileWorkspace })));
const LspPluginCatalogPane = lazy(() => import("./components/LspPluginCatalogPane").then((module) => ({ default: module.LspPluginCatalogPane })));

type PendingAgentLaunch = {
  project: Project;
  binding: ProjectAgentBinding;
  preset: AgentPreset;
  command: string;
  executable: string;
};

function executableFromCommand(command: string): string {
  const match = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

/** 在分屏树中替换 sessionId（重连后新会话 id 不同）。 */
function replaceSessionInLayout(
  node: SplitNode,
  oldId: string,
  newId: string
): SplitNode {
  if (node.kind === "leaf") {
    return node.sessionId === oldId ? { ...node, sessionId: newId } : node;
  }
  return {
    ...node,
    children: [
      replaceSessionInLayout(node.children[0], oldId, newId),
      replaceSessionInLayout(node.children[1], oldId, newId),
    ],
  };
}

function firstPaneId(layout?: SplitNode): string | null {
  if (!layout) return null;
  return layout.kind === "leaf" ? layout.paneId : firstPaneId(layout.children[0]);
}

function App() {
  const { settings, updateSettings } = useSettings();
  const taskSummaryState = useTaskSummary();
  const { toast } = useToast();
  const { open: openTerminalDiagnostics, redraw: redrawTerminal, forceCanvas: forceTerminalCanvas } = useTerminalDiagnostics();
  const { checkForUpdates } = useUpdater();
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [profilesState, setProfilesState] = useState<ProfilesLoadState>("loading");
  const [profilesError, setProfilesError] = useState("");
  const [groups, setGroups] = useState<ProfileGroup[]>([]);
  const [projectGroups, setProjectGroups] = useState<ProfileGroup[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [broadcastEnabled, setBroadcastEnabled] = useState(false);
  const [broadcastTargets, setBroadcastTargets] = useState<string[]>([]);
  const [showBroadcastDialog, setShowBroadcastDialog] = useState(false);
  const broadcastPeers = useRef(new Map<string, WebSocket>());
  const broadcast = useMemo(
    () => ({
      enabled: broadcastEnabled,
      targetIds: new Set(broadcastTargets),
      peers: broadcastPeers.current,
      register: (id: string, ws: WebSocket) => broadcastPeers.current.set(id, ws),
      unregister: (id: string) => {
        broadcastPeers.current.delete(id);
      },
    }),
    [broadcastEnabled, broadcastTargets]
  );
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [showSnippets, setShowSnippets] = useState(false);
  const [taskSection, setTaskSection] = useState<TaskSection>("activity");
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const [dirtyEditorTabs, setDirtyEditorTabs] = useState<Set<string>>(new Set());
  const [dirtyEditorFiles, setDirtyEditorFiles] = useState<Record<string, string[]>>({});
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  const [shuttingDown, setShuttingDown] = useState(false);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void listen<string>("app://shutdown-progress", (event) => setShuttingDown(event.payload !== "done")).then((unlisten) => { dispose = unlisten; });
    return () => dispose?.();
  }, []);
  useEffect(() => {
    invoke<Snippet[]>("snippet_list").then(setSnippets).catch((reason) => toast(`命令片段读取失败：${String(reason)}`, "error"));
  }, [toast]);
  const [showConnect, setShowConnect] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [editProfile, setEditProfile] = useState<ConnectionProfile | null>(null);
  // Part 3: 双模式（SSH / 项目）
  const [mode, setMode] = useState<AppMode>("ssh");
  const [projects, setProjects] = useState<Project[]>([]);
  const [connecting, setConnecting] = useState<{
    cid: string;
    name: string;
    stage: string;
    message: string;
  } | null>(null);
  const [connectingProfileId, setConnectingProfileId] = useState<string | null>(null);
  const [hostKey, setHostKey] = useState<HostKeyEvent | null>(null);
  const [hostKeyBusy, setHostKeyBusy] = useState(false);
  const [pendingAgentLaunch, setPendingAgentLaunch] = useState<PendingAgentLaunch | null>(null);
  const agentPresets = settings.agentPresets;
  const agentPresetIds = useMemo(() => agentPresets.map((preset) => preset.id), [agentPresets]);

  const hostKeyRef = useRef<HostKeyEvent | null>(null);
  const connectingCidRef = useRef<string | null>(null);
  const retryProfileIdRef = useRef<string | null>(null);
  /** sessionId → profileId，仅 profile_connect 建立的会话可自动重连 */
  const sessionProfileRef = useRef<Map<string, string>>(new Map());
  /** 用户主动断开，避免触发自动重连 */
  const intentionalDisconnectRef = useRef<Set<string>>(new Set());
  /** 正在重连中的 session，防止分屏多 pane 重复触发 */
  const reconnectingRef = useRef<Set<string>>(new Set());
  const sessionEnvironments = useMemo(() => Object.fromEntries(sessions.map((session) => [
    session.id,
    profiles.find((profile) => profile.id === sessionProfileRef.current.get(session.id))?.environment,
  ])), [profiles, sessions]);

  const showToast = useCallback((msg: string, kind: ToastKind = "error") => {
    toast(msg, kind);
  }, [toast]);

  const refreshSessions = async () => {
    try {
      setSessions(await invoke<SessionInfo[]>("ssh_list_sessions"));
    } catch (e) {
      showToast(String(e));
    }
  };

  const refreshProfiles = async () => {
    setProfilesState("loading");
    try {
      setProfiles(await invoke<ConnectionProfile[]>("profile_list"));
      setProfilesError("");
      setProfilesState("ready");
    } catch (e) {
      setProfilesError(String(e));
      setProfilesState("error");
      showToast(String(e));
    }
  };

  /** 从 ~/.ssh/config 批量导入连接配置。 */
  const importSshConfig = async () => {
    try {
      const n = await invoke<number>("profiles_import_ssh_config");
      await refreshProfiles();
      showToast(
        n > 0 ? `已从 ~/.ssh/config 导入 ${n} 条连接` : "~/.ssh/config 中无可导入的主机"
      );
    } catch (e) {
      showToast(String(e));
    }
  };

  /** 窗口隐藏（最小化到托盘）时发 OS 通知，避免与应用内 toast 重复打扰。 */
  const notifyIfHidden = useCallback(async (body: string) => {
    try {
      if (!(await getCurrentWindow().isVisible())) {
        await sendNotification({ title: "Simpl SSH", body });
      }
    } catch {
      /* 通知不可用时忽略 */
    }
  }, []);

  const refreshGroups = async () => {
    try {
      setGroups(await invoke<ProfileGroup[]>("group_list"));
    } catch (e) {
      showToast(String(e));
    }
  };

  const refreshProjectGroups = async () => {
    try { setProjectGroups(await invoke<ProfileGroup[]>("resource_group_list", { kind: "project" })); }
    catch (error) { showToast(String(error)); }
  };

  const refreshProjects = async () => {
    try {
      setProjects(await invoke<Project[]>("project_list"));
    } catch (e) {
      showToast(String(e));
    }
  };

  useEffect(() => {
    refreshSessions();
    refreshProfiles();
    refreshGroups();
    refreshProjectGroups();
    refreshProjects();
  }, []);

  // Agent 预设属于本地设置而非项目 JSON。预设被删除或升级移除内置项时，
  // 清理项目内失效引用，确保菜单不会复活旧默认 Agent。
  useEffect(() => {
    void invoke<number>("project_prune_agent_bindings", { presetIds: agentPresetIds })
      .then((removed) => { if (removed > 0) void refreshProjects(); })
      .catch((reason) => toast(`项目 Agent 配置清理失败：${String(reason)}`, "error"));
  // refreshProjects 是稳定的本地加载动作；只在预设集合改变时触发清理。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentPresetIds.join("\u0000"), toast]);

  useEffect(() => {
    if (settings.checkUpdatesOnStart) {
      void checkForUpdates(true);
    }
    // 仅启动时检查一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ connect_id: string; stage: string; message: string }>(
      "ssh://progress",
      (e) => {
        setConnecting((prev) =>
          prev && prev.cid === e.payload.connect_id
            ? { ...prev, stage: e.payload.stage, message: e.payload.message }
            : prev
        );
      }
    ).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<HostKeyEvent>("ssh://hostkey", (e) => {
      if (e.payload.connectId === connectingCidRef.current) {
        hostKeyRef.current = e.payload;
        setHostKey(e.payload);
      }
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  function replaceSessionInTabs(oldSessionId: string, newSessionId: string) {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.sessionId !== oldSessionId) return t;
        const next: Tab = { ...t, sessionId: newSessionId };
        if (t.layout) {
          next.layout = replaceSessionInLayout(t.layout, oldSessionId, newSessionId);
        }
        return next;
      })
    );
  }

  function openTerminal(s: SessionInfo, profileId?: string, startupCommand?: string, remoteRoot?: string) {
    const normalizedRoot = remoteRoot?.trim() || undefined;
    const existing = tabs.find((t) => t.sessionId === s.id && t.kind === "terminal" && t.remoteRoot === normalizedRoot);
    if (existing) {
      setTabs((current) => current.map((tab) => tab.id === existing.id ? { ...tab, terminalView: "terminal" } : tab));
      setActiveTabId(existing.id);
      return;
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      sessionId: s.id,
      title: normalizedRoot ? `${s.user}@${s.host} · ${normalizedRoot.split("/").filter(Boolean).pop() || normalizedRoot}` : `${s.user}@${s.host}`,
      kind: "terminal",
      profileId,
      startupCommand,
      remoteRoot: normalizedRoot,
      layout: {
        kind: "leaf",
        paneId: crypto.randomUUID(),
        sessionId: s.id,
      },
      terminalView: "terminal",
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }

  function openSftp(s: SessionInfo, initialPath?: string) {
    const normalizedRoot = initialPath?.trim() || undefined;
    // 文件是当前 SSH 工作区的一部分，而不是另一个会话。优先复用同会话终端标签，
    // 使终端的 PTY、滚动缓冲和正在运行的命令保持原样。
    const terminal = tabs.find((tab) => tab.sessionId === s.id && tab.kind === "terminal" && tab.remoteRoot === normalizedRoot)
      ?? tabs.find((tab) => tab.sessionId === s.id && tab.kind === "terminal");
    if (terminal) {
      setTabs((current) => current.map((tab) => tab.id === terminal.id ? {
        ...tab,
        remoteRoot: normalizedRoot ?? tab.remoteRoot,
        sftpOpened: true,
        terminalView: "files",
      } : tab));
      setActiveTabId(terminal.id);
      return;
    }
    const existing = tabs.find((t) => t.sessionId === s.id && t.kind === "sftp" && (t.remoteRoot ?? t.repoPath) === normalizedRoot);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      sessionId: s.id,
      title: normalizedRoot ? `${s.user}@${s.host} · ${normalizedRoot.split("/").filter(Boolean).pop() || normalizedRoot}` : `${s.user}@${s.host}`,
      kind: "terminal",
      remoteRoot: normalizedRoot,
      profileId: sessionProfileRef.current.get(s.id),
      terminalView: "files",
      sftpOpened: true,
      layout: { kind: "leaf", paneId: crypto.randomUUID(), sessionId: s.id },
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }

  function setTerminalWorkspaceView(tabId: string, view: TerminalWorkspaceView) {
    setTabs((current) => current.map((tab) => tab.id === tabId ? {
      ...tab,
      terminalView: view,
      sftpOpened: tab.sftpOpened || view !== "terminal",
    } : tab));
  }

  function openMonitor(s: SessionInfo) {
    const existing = tabs.find(
      (t) => t.sessionId === s.id && t.kind === "monitor"
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      sessionId: s.id,
      title: `${s.user}@${s.host} · 监控`,
      kind: "monitor",
      profileId: sessionProfileRef.current.get(s.id),
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }

  function openEditor(sessionId: string, filePath: string) {
    const existing = tabs.find(
      (t) => t.kind === "editor" && t.sessionId === sessionId && t.filePath === filePath
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      sessionId,
      title: filePath.split("/").pop() ?? filePath,
      kind: "editor",
      filePath,
      profileId: sessionProfileRef.current.get(sessionId),
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }

  function openGit(sessionId: string, repoPath: string) {
    const existing = tabs.find(
      (t) => t.kind === "git" && t.sessionId === sessionId && t.repoPath === repoPath
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      sessionId,
      title: `Git: ${repoPath.split("/").pop() ?? repoPath}`,
      kind: "git",
      repoPath,
      profileId: sessionProfileRef.current.get(sessionId),
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }

  /** 优先回到这个项目已打开的标签，避免从项目入口反复创建空终端。 */
  function openProjectWorkspace(project: Project) {
    const existing = tabs.find((tab) => tab.projectId === project.id && tab.kind === "project-workbench");
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    // 旧版本把项目入口恢复为 local-terminal。迁移它而非再叠加一个标签，
    // 这样点击项目不会回到只剩终端画布的历史布局。
    const legacyProjectTerminal = tabs.find((tab) => tab.projectId === project.id && tab.kind === "local-terminal" && !tab.agentPresetId);
    if (legacyProjectTerminal) {
      setTabs((current) => current.map((tab) => tab.id === legacyProjectTerminal.id ? {
        ...tab,
        kind: "project-workbench",
        sessionId: project.id,
        title: project.name,
        source: "local",
        localPath: project.local_path,
        startupCommand: undefined,
      } : tab));
      setActiveTabId(legacyProjectTerminal.id);
      return;
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      sessionId: project.id,
      title: project.name,
      kind: "project-workbench",
      source: "local",
      projectId: project.id,
      localPath: project.local_path,
    };
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  }

  /** 打开项目专用的本地控制台。项目行本身进入工作台，终端图标则直接进入可交互的终端标签。 */
  function openProjectLocalTerminal(project: Project) {
    const existing = tabs.find(
      (tab) => tab.projectId === project.id && tab.kind === "local-terminal" && !tab.agentPresetId,
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      sessionId: project.id,
      title: `${project.name} · 终端`,
      kind: "local-terminal",
      source: "local",
      projectId: project.id,
      localPath: project.local_path,
    };
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  }

  async function launchProjectAgent(project: Project, binding: ProjectAgentBinding) {
    const preset = agentPresets.find((item) => item.id === binding.preset_id);
    if (!preset) return showToast("该 Agent 预设已被删除");
    const command = binding.command_override || preset.command;
    const executable = executableFromCommand(command);
    let available = false;
    try {
      available = Boolean(executable) && await invoke<boolean>("local_command_available", { executable });
    } catch {
      // PATH 检查只是提示；不妨碍 alias、shell function 或自定义脚本启动。
    }
    if (!available) return setPendingAgentLaunch({ project, binding, preset, command, executable });
    startProjectAgent(project, preset, command);
  }

  function startProjectAgent(project: Project, preset: AgentPreset, command: string) {
    const tab: Tab = {
      id: crypto.randomUUID(), sessionId: project.id, title: `${project.name} · ${preset.name}`,
      kind: "local-terminal", source: "local", projectId: project.id,
      localPath: project.local_path,
      startupCommand: command,
      agentPresetId: preset.id, agentStatus: "running", agentStartedAt: new Date().toISOString(),
    };
    setTabs((previous) => [...previous, tab]);
    setActiveTabId(tab.id);
  }

  /** 项目中的远程快捷操作：复用已连接会话，否则先用保存配置建立连接。 */
  async function openProjectRemote(
    _project: Project,
    workspace: ProjectRemoteWorkspace,
    target: "terminal" | "sftp" | "git" | "monitor"
  ) {
    const session = await ensureProfileSession(workspace.profile_id);
    if (!session) return;
    const remotePath = workspace.remote_path || ".";
    if (target === "terminal") {
      openTerminal(
        session,
        workspace.profile_id,
        workspace.remote_path ? `cd -- ${shellQuote(workspace.remote_path)}` : undefined,
        workspace.remote_path || undefined,
      );
    }
    else if (target === "sftp") openSftp(session, workspace.remote_path || undefined);
    else if (target === "git") openGit(session.id, remotePath);
    else openMonitor(session);
  }

  async function deleteProject(id: string) {
    try {
      await invoke("project_delete", { id });
      await refreshProjects();
    } catch (e) {
      showToast(String(e));
    }
  }

  function performCloseTab(id: string) {
    setTabs((prev) => {
      const index = prev.findIndex((tab) => tab.id === id);
      const next = prev.filter((tab) => tab.id !== id);
      setActiveTabId((active) => active === id ? next[Math.min(Math.max(index, 0), next.length - 1)]?.id ?? null : active);
      return next;
    });
    setDirtyEditorTabs((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
    setDirtyEditorFiles((previous) => { const next = { ...previous }; delete next[id]; return next; });
  }

  function openLspCatalog() {
    const existing = tabs.find((tab) => tab.kind === "lsp-catalog");
    if (existing) { setActiveTabId(existing.id); return; }
    const tab: Tab = { id: crypto.randomUUID(), sessionId: "local:lsp-catalog", title: "LSP 插件目录", kind: "lsp-catalog", source: "local" };
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  }

  function closeTab(id: string) {
    if (dirtyEditorTabs.has(id)) {
      setPendingCloseTabId(id);
      return;
    }
    performCloseTab(id);
  }

  function updateTabLayout(tabId: string, layout: SplitNode) {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, layout } : t))
    );
  }

  /** 切换到相邻 Tab（direction: 1=下一个，-1=上一个） */
  const cycleTab = useCallback(
    (direction: 1 | -1) => {
      if (tabs.length === 0) return;
      const idx = tabs.findIndex((t) => t.id === activeTabId);
      const base = idx >= 0 ? idx : 0;
      const next = (base + direction + tabs.length) % tabs.length;
      setActiveTabId(tabs[next].id);
    },
    [activeTabId, tabs]
  );

  useAppShortcuts({
    onNewConnection: () => setShowConnect(true),
    onCloseTab: () => activeTabId && closeTab(activeTabId),
    onNextTab: () => cycleTab(1),
    onPrevTab: () => cycleTab(-1),
    onOpenSettings: () => setShowSettings(true),
    onOpenCommandPalette: () => setShowCommandPalette((v) => !v),
  });

  // 工作区持久化：启动时恢复，tabs 变化时自动保存
  const {
    issues: workspaceRestoreIssues,
    loadError: workspaceRestoreLoadError,
    retrying: workspaceRestoreRetrying,
    retryTransient: retryWorkspaceRestore,
    retryMissingProfile: retryMissingWorkspaceProfile,
    retryLoad: retryWorkspaceLoad,
    skipIssue: skipWorkspaceRestoreIssue,
    discardPendingRecovery: discardPendingWorkspaceRecovery,
  } = useWorkspaceRestore({
    profiles,
    profilesState,
    profilesError,
    setTabs,
    setActiveTabId,
    tabs,
    activeTabId,
    showToast,
    sessionProfileRef,
    reloadProfiles: refreshProfiles,
  });
  const hasWorkspaceRecovery = workspaceRestoreIssues.length > 0 || workspaceRestoreLoadError !== null;
  const hasTransientWorkspaceIssue = workspaceRestoreIssues.some((issue) => issue.kind === "transient");
  const { add: addActivity } = useActivity();
  useEffect(() => {
    let alive = true;
    void invoke<{
      persistent: boolean;
      migration_warnings: string[];
      pending_secret_cleanup: Array<{ profile_id: string; credential_kind: string; attempts: number; last_error?: string | null }>;
    }>("storage_status").then((status) => {
      if (!alive) return;
      if (!status.persistent) addActivity({
        id: "storage-memory-fallback",
        kind: "workspace",
        severity: "error",
        title: "本机数据库当前不可写",
        detail: "应用已进入内存安全模式，本次修改不会跨重启保留。请复制存储诊断并检查配置目录权限。",
      });
      status.migration_warnings.forEach((warning, index) => addActivity({
        id: `storage-warning:${index}:${warning}`,
        kind: "workspace",
        severity: "warning",
        title: "本机数据需要检查",
        detail: warning,
      }));
      if (status.pending_secret_cleanup.length > 0) {
        addActivity({
          id: `credential-cleanup:${status.pending_secret_cleanup.map((item) => `${item.profile_id}:${item.attempts}`).join("|")}`,
          kind: "workspace",
          severity: "warning",
          title: `${status.pending_secret_cleanup.length} 项钥匙串凭据待清理`,
          detail: "应用记录已删除，不会恢复；可在设置 → 更新与关于 → 本机数据与诊断中重试。",
        });
      }
    }).catch((error) => {
      if (alive) addActivity({ id: `storage-status:${String(error)}`, kind: "workspace", severity: "error", title: "无法读取本机存储状态", detail: String(error) });
    });
    return () => { alive = false; };
  }, [addActivity]);
  useEffect(() => {
    for (const issue of workspaceRestoreIssues) {
      addActivity({ id: `workspace:${issue.tab.id}:${issue.kind}`, kind: "workspace", severity: "error", title: `工作区标签未恢复：${issue.tab.title}`, detail: issue.message, referenceId: issue.tab.id });
    }
    if (workspaceRestoreLoadError) addActivity({ id: `workspace-load:${workspaceRestoreLoadError.kind}`, kind: "workspace", severity: "error", title: "工作区恢复失败", detail: workspaceRestoreLoadError.message });
  }, [addActivity, workspaceRestoreIssues, workspaceRestoreLoadError]);

  async function ensureProfileSession(id: string): Promise<SessionInfo | null> {
    const existing = sessions.find((session) => sessionProfileRef.current.get(session.id) === id);
    if (existing) return existing;
    const profile = profiles.find((p) => p.id === id);
    const name = profile?.name ?? "服务器";
    const cid = crypto.randomUUID();
    setConnectingProfileId(id);
    connectingCidRef.current = cid;
    retryProfileIdRef.current = id;
    setConnecting({ cid, name, stage: "resolve", message: "开始连接…" });
    try {
      const s = await invoke<SessionInfo>("profile_connect", {
        id,
        connectId: cid,
      });
      sessionProfileRef.current.set(s.id, id);
      setProfileErrors((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
      await refreshSessions();
      setConnecting(null);
      setConnectingProfileId(null);
      connectingCidRef.current = null;
      return s;
    } catch (e) {
      setConnecting(null);
      setConnectingProfileId(null);
      connectingCidRef.current = null;
      if (hostKeyRef.current?.connectId === cid) return null;
      setProfileErrors((previous) => ({ ...previous, [id]: String(e) }));
      addActivity({ id: `connection:connect:${id}:${String(e)}`, kind: "connection", severity: "error", title: `连接失败：${name}`, detail: String(e), referenceId: id });
      showToast(String(e));
      return null;
    }
  }

  async function connectProfile(id: string) {
    const session = await ensureProfileSession(id);
    if (session) openTerminal(session, id);
  }

  /** 断线后按 profile 自动重连，指数退避重试 */
  const attemptReconnect = useCallback(
    async (oldSessionId: string, profileId: string, attempt: number) => {
      const profile = profiles.find((p) => p.id === profileId);
      const label = profile?.name ?? profile?.host ?? "服务器";
      const max = settings.maxReconnectAttempts;

      if (attempt >= max) {
        reconnectingRef.current.delete(oldSessionId);
        sessionProfileRef.current.delete(oldSessionId);
        addActivity({ id: `connection:reconnect:${profileId}:${oldSessionId}`, kind: "connection", severity: "error", title: `重连失败：${label}`, detail: `已达到最大重试次数（${max}）。`, referenceId: profileId });
        showToast(`「${label}」重连失败，已达最大次数 (${max})`, "error");
        void notifyIfHidden(`「${label}」重连失败，已达最大次数`);
        return;
      }

      showToast(
        `「${label}」连接断开，重连中 (${attempt + 1}/${max})…`,
        "info"
      );

      const delayMs = Math.min(1000 * 2 ** attempt, 8000);
      await new Promise((r) => setTimeout(r, delayMs));

      if (intentionalDisconnectRef.current.has(oldSessionId)) {
        intentionalDisconnectRef.current.delete(oldSessionId);
        reconnectingRef.current.delete(oldSessionId);
        return;
      }

      try {
        const cid = crypto.randomUUID();
        const s = await invoke<SessionInfo>("profile_connect", {
          id: profileId,
          connectId: cid,
        });
        sessionProfileRef.current.delete(oldSessionId);
        sessionProfileRef.current.set(s.id, profileId);
        reconnectingRef.current.delete(oldSessionId);
        replaceSessionInTabs(oldSessionId, s.id);
        await refreshSessions();
        showToast(`「${label}」已重新连接`, "info");
        void notifyIfHidden(`「${label}」已重新连接`);
      } catch {
        if (hostKeyRef.current) {
          reconnectingRef.current.delete(oldSessionId);
          addActivity({ id: `connection:hostkey:${profileId}:${oldSessionId}`, kind: "connection", severity: "warning", title: `重连需要确认主机指纹：${label}`, detail: "为保护连接安全，需先确认新的主机公钥。", referenceId: profileId });
          showToast(`「${label}」重连需确认主机公钥，请手动重连`, "error");
          return;
        }
        void attemptReconnect(oldSessionId, profileId, attempt + 1);
      }
    },
    [addActivity, notifyIfHidden, profiles, settings.maxReconnectAttempts, showToast]
  );

  const handleConnectionLost = useCallback(
    (sessionId: string) => {
      if (intentionalDisconnectRef.current.has(sessionId)) {
        intentionalDisconnectRef.current.delete(sessionId);
        return;
      }
      if (reconnectingRef.current.has(sessionId)) return;

      const profileId = sessionProfileRef.current.get(sessionId);
      if (!profileId || !settings.autoReconnect) {
        addActivity({ id: `connection:lost:${sessionId}`, kind: "connection", severity: "error", title: "SSH 连接已断开", detail: settings.autoReconnect ? "当前会话没有可用的已保存连接配置，无法自动恢复。" : "已关闭自动重连。", referenceId: sessionId });
        showToast("SSH 连接已断开", "error");
        return;
      }

      reconnectingRef.current.add(sessionId);
      void attemptReconnect(sessionId, profileId, 0);
    },
    [addActivity, attemptReconnect, settings.autoReconnect, showToast]
  );

  async function handleHostKeyTrust() {
    if (!hostKey) return;
    setHostKeyBusy(true);
    try {
      await invoke("hostkey_trust", {
        host: hostKey.host,
        port: hostKey.port,
      });
      const retryId = retryProfileIdRef.current;
      setHostKey(null);
      hostKeyRef.current = null;
      setHostKeyBusy(false);
      if (retryId) connectProfile(retryId);
    } catch (e) {
      setHostKeyBusy(false);
      showToast(String(e));
    }
  }

  async function handleHostKeyReject() {
    if (!hostKey) return;
    try {
      await invoke("hostkey_reject", {
        host: hostKey.host,
        port: hostKey.port,
      });
    } catch {
      /* 忽略 */
    }
    setHostKey(null);
    hostKeyRef.current = null;
    setConnecting(null);
    connectingCidRef.current = null;
    showToast("已拒绝主机公钥，未连接。", "error");
  }

  async function deleteProfile(id: string) {
    try {
      await invoke("profile_delete", { id });
      await refreshProfiles();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function createGroup(name: string, parentId?: string | null, kind: "connection" | "project" = "connection") {
    try {
      await invoke("resource_group_create", { kind, parentId: parentId ?? null, name });
      if (kind === "connection") await refreshGroups(); else await refreshProjectGroups();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function renameGroup(id: string, name: string, kind: "connection" | "project" = "connection") {
    try {
      await invoke("group_rename", { id, name });
      if (kind === "connection") await refreshGroups(); else await refreshProjectGroups();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function deleteGroup(id: string, kind: "connection" | "project" = "connection") {
    try {
      await invoke("resource_group_delete", { id, confirmed: true });
      if (kind === "connection") await refreshGroups(); else await refreshProjectGroups();
      await refreshProfiles();
      await refreshProjects();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function moveResourceGroup(id: string, parentId: string | null, kind: "connection" | "project") {
    try { await invoke("resource_group_move", { id, parentId, position: 2_147_483_647 }); if (kind === "connection") await refreshGroups(); else await refreshProjectGroups(); }
    catch (error) { showToast(String(error)); }
  }

  async function moveResourceItem(id: string, groupId: string | null, kind: "connection" | "project") {
    try { await invoke("resource_item_move", { kind, id, groupId }); if (kind === "connection") await refreshProfiles(); else await refreshProjects(); }
    catch (error) { showToast(String(error)); }
  }

  async function disconnect(id: string) {
    intentionalDisconnectRef.current.add(id);
    sessionProfileRef.current.delete(id);
    reconnectingRef.current.delete(id);
    const wasActive = tabs.some((t) => t.id === activeTabId && t.sessionId === id);
    setTabs((prev) => prev.filter((t) => t.sessionId !== id));
    if (wasActive) setActiveTabId(null);
    try {
      await invoke("ssh_disconnect", { id });
      await refreshSessions();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function onConnected(s: SessionInfo) {
    await refreshSessions();
    await refreshProfiles();
    setShowConnect(false);
    openTerminal(s);
  }

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeSession = activeTab
    ? sessions.find((s) => s.id === activeTab.sessionId) ?? null
    : null;
  const activeTerminalPaneId = activeTab?.kind === "local-terminal"
    ? activeTab.id
    : activeTab?.kind === "terminal"
      ? firstPaneId(activeTab.layout)
      : null;
  const taskSummary = { active: taskSummaryState.active + taskSummaryState.batchActive, failed: taskSummaryState.failed + taskSummaryState.batchFailed };

  const openTaskDrawer = useCallback((section: TaskSection = "activity") => {
    setTaskSection(section);
    updateSettings({ taskDrawerOpen: true });
  }, [updateSettings]);

  const setWorkspaceLayout = useCallback((workspaceLayout: "focus" | "operations") => {
    updateSettings({
      workspaceLayout,
      taskDrawerOpen: workspaceLayout === "operations" ? true : false,
    });
  }, [updateSettings]);

  const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = Math.max(220, Math.min(360, settings.sidebarWidth));
    const move = (moveEvent: PointerEvent) => updateSettings({ sidebarWidth: Math.max(220, Math.min(360, startWidth + moveEvent.clientX - startX)) });
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }, [settings.sidebarWidth, updateSettings]);

  /** 注入命令到当前活动终端（命令片段用），复用广播 peers 的 WS */
  const injectSnippet = useCallback(
    (text: string) => {
      if (!activeSession) return;
      const ws = broadcastPeers.current.get(activeSession.id);
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(text));
      }
    },
    [activeSession]
  );

  /** 命令面板分屏：在当前活动 tab 的最深左叶处分屏。 */
  const onSplit = (dir: SplitDir) => {
    if (!activeTab) return;
    const base: SplitNode = activeTab.layout ?? {
      kind: "leaf",
      paneId: activeTab.id,
      sessionId: activeTab.sessionId,
    };
    updateTabLayout(activeTab.id, splitFirstLeaf(base, dir));
  };

  // 命令面板数据源
  const paletteCommands: CommandItem[] = [
    ...profileCommands(profiles, connectProfile),
    ...tabCommands(tabs, setActiveTabId),
    ...snippetCommands(snippets, injectSnippet),
    ...builtinCommands({
      onNewConnection: () => setShowConnect(true),
      onCloseTab: () => activeTabId && closeTab(activeTabId),
      onOpenSettings: () => setShowSettings(true),
      onOpenSftp: () => activeSession && openSftp(activeSession),
      onOpenMonitor: () => openTaskDrawer("monitor"),
      onOpenGit: () => activeSession && openGit(activeSession.id, "."),
      onOpenTransfers: () => openTaskDrawer("transfers"),
      onOpenForwards: () => openTaskDrawer("forwards"),
      onImportSshConfig: importSshConfig,
      onOpenSecurity: () => setShowSettings(true),
      onDisconnect: () => activeSession && disconnect(activeSession.id),
      onSplitHorizontal: () => onSplit("horizontal"),
      onSplitVertical: () => onSplit("vertical"),
      onSwitchMode: (m) => setMode(m),
      onOpenProjectTerminal: (pid) => {
        const p = projects.find((p) => p.id === pid);
        if (p) openProjectWorkspace(p);
      },
      onGoToDefinition: () => window.dispatchEvent(new CustomEvent("simpl-ssh:editor-definition")),
      onFindReferences: () => window.dispatchEvent(new CustomEvent("simpl-ssh:editor-references")),
      onFormatDocument: () => window.dispatchEvent(new CustomEvent("simpl-ssh:editor-format")),
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
    }),
    ...(activeTerminalPaneId ? [
      { id: "terminal:diagnostics", label: "终端：打开诊断", description: "查看渲染器、TUI 原始输出和布局状态", icon: MonitorCog, category: "action" as const, action: () => openTerminalDiagnostics(activeTerminalPaneId) },
      { id: "terminal:redraw", label: "终端：重新绘制", description: "清理当前渲染器缓存并完整刷新", icon: RefreshCw, category: "action" as const, action: () => redrawTerminal(activeTerminalPaneId) },
      { id: "terminal:canvas", label: "终端：当前标签改用 Canvas", description: "仅当前终端标签降级，不修改全局设置", icon: MonitorCog, category: "action" as const, action: () => forceTerminalCanvas(activeTerminalPaneId) },
    ] : []),
  ];

  return (
    <BroadcastContext.Provider value={broadcast}>
    <div
      className={`app layout-${settings.workspaceLayout} ${settings.taskDrawerOpen ? "task-drawer-open" : ""} ${settings.sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      style={{ "--sidebar-w": `${Math.max(220, Math.min(360, settings.sidebarWidth))}px` } as CSSProperties}
    >
      {mode === "ssh" ? (
        <Sidebar
          profiles={profiles}
          groups={groups}
          activeProfileIds={sessions.flatMap((session) => {
            const profileId = sessionProfileRef.current.get(session.id);
            return profileId ? [profileId] : [];
          })}
          connectionErrors={profileErrors}
          connectingProfileIds={connectingProfileId ? [connectingProfileId] : []}
          onConnectProfile={connectProfile}
          onEditProfile={setEditProfile}
          onDeleteProfile={deleteProfile}
          onCreateGroup={createGroup}
          onRenameGroup={renameGroup}
          onDeleteGroup={deleteGroup}
          onMoveGroup={(id, parentId) => moveResourceGroup(id, parentId, "connection")}
          onMoveProfile={(id, groupId) => moveResourceItem(id, groupId, "connection")}
          onNew={() => setShowConnect(true)}
          onImportSshConfig={importSshConfig}
          onModeChange={setMode}
        />
      ) : (
        <ProjectSidebar
          projects={projects}
          profiles={profiles}
          groups={projectGroups}
          onCreateGroup={(name, parentId) => createGroup(name, parentId, "project")}
          onRenameGroup={(id, name) => renameGroup(id, name, "project")}
          onDeleteGroup={(id) => deleteGroup(id, "project")}
          onMoveGroup={(id, parentId) => moveResourceGroup(id, parentId, "project")}
          onMoveProject={(id, groupId) => moveResourceItem(id, groupId, "project")}
          onConnectProject={openProjectWorkspace}
          onOpenLocalTerminal={openProjectLocalTerminal}
          onOpenRemote={openProjectRemote}
          onDeleteProject={deleteProject}
          onSaved={refreshProjects}
          onModeChange={setMode}
          agentPresets={agentPresets}
          onLaunchAgent={launchProjectAgent}
          agentRuns={tabs.filter((tab) => tab.agentPresetId && tab.projectId).map((tab) => ({
            tabId: tab.id,
            projectId: tab.projectId!,
            presetId: tab.agentPresetId!,
            status: tab.agentStatus ?? "running",
            startedAt: tab.agentStartedAt,
          }))}
          onActivateAgentTab={setActiveTabId}
        />
      )}

      <div className="sidebar-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整资源侧栏宽度" onPointerDown={startSidebarResize} />

      <div className={`workspace ${hasWorkspaceRecovery ? "has-recovery" : ""} ${activeTab?.kind === "project-workbench" ? "workspace-project" : ""}`}>
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onActivate={setActiveTabId}
          onClose={closeTab}
          onNew={mode === "ssh" ? () => setShowConnect(true) : undefined}
        />

        {activeTab?.kind !== "project-workbench" && activeTab?.kind !== "lsp-catalog" && <WorkspaceActions
          session={activeSession}
          activeKind={activeTab?.kind ?? null}
          environment={profiles.find((profile) => profile.id === activeTab?.profileId)?.environment}
          onOpenTerminal={() => activeSession && openTerminal(activeSession, activeTab?.profileId)}
          onOpenSftp={() => activeSession && openSftp(activeSession)}
          onOpenGit={() => activeSession && openGit(activeSession.id, ".")}
          onOpenMonitor={() => openTaskDrawer("monitor")}
          onOpenTasks={openTaskDrawer}
          onDisconnect={() => activeSession && disconnect(activeSession.id)}
          onOpenSettings={() => setShowSettings(true)}
          onOpenCommandPalette={() => setShowCommandPalette((value) => !value)}
          layout={settings.workspaceLayout}
          onLayoutChange={setWorkspaceLayout}
          sidebarCollapsed={settings.sidebarCollapsed}
          onToggleSidebar={() => updateSettings({ sidebarCollapsed: !settings.sidebarCollapsed })}
          broadcastEnabled={broadcastEnabled}
          onToggleBroadcast={() => {
            if (broadcastEnabled) setBroadcastEnabled(false);
            else setShowBroadcastDialog(true);
          }}
          onOpenSnippets={() => setShowSnippets(true)}
          taskCount={taskSummary.active}
          failedTaskCount={taskSummary.failed}
        />}

        {hasWorkspaceRecovery && (
          <section className="workspace-recovery-banner" role="status" aria-live="polite">
            <div className="workspace-recovery-copy">
              {workspaceRestoreLoadError ? (
                <strong>{workspaceRestoreLoadError.message}</strong>
              ) : (
                <>
                  <strong>{workspaceRestoreIssues.length} 个工作区标签未恢复</strong>
                  <div className="workspace-recovery-issues">
                    {workspaceRestoreIssues.map((issue) => (
                      <div className="workspace-recovery-issue" key={issue.tab.id}>
                        <span><b>{issue.tab.title}</b>：{issue.message}</span>
                        {issue.kind === "missing_profile" && <button type="button" disabled={workspaceRestoreRetrying} onClick={() => void retryMissingWorkspaceProfile(issue.tab.id)}>重新检查配置</button>}
                        {issue.kind !== "transient" && <button type="button" className="danger" disabled={workspaceRestoreRetrying} onClick={() => void skipWorkspaceRestoreIssue(issue.tab.id)}>跳过并移除</button>}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="workspace-recovery-actions">
              {workspaceRestoreLoadError?.kind === "transient" && <button type="button" disabled={workspaceRestoreRetrying} onClick={retryWorkspaceLoad}>重试读取</button>}
              {hasTransientWorkspaceIssue && <button type="button" disabled={workspaceRestoreRetrying} onClick={() => void retryWorkspaceRestore()}>{workspaceRestoreRetrying ? "正在恢复…" : "重试恢复"}</button>}
              <button type="button" className="danger" disabled={workspaceRestoreRetrying} onClick={() => void discardPendingWorkspaceRecovery()}>{workspaceRestoreLoadError?.kind === "invalid_snapshot" ? "清除损坏记录" : "放弃未恢复标签"}</button>
            </div>
          </section>
        )}

        <main className="main">
          {tabs.length === 0 ? (
            <StartPage
              mode={mode}
              projects={projects}
              profiles={profiles}
              onOpenProject={openProjectWorkspace}
              onConnectProfile={(profile) => connectProfile(profile.id)}
              onSwitchMode={setMode}
              onNewConnection={() => setShowConnect(true)}
              onImportConfig={importSshConfig}
            />
          ) : (
            tabs.map((t) => (
              <div
                key={t.id}
                className={`pane ${t.id === activeTabId ? "active" : ""}`}
              >
                <Suspense fallback={<LoadingState className="pane-loading" label="正在加载工作区…" />}>
                {t.kind === "lsp-catalog" ? (
                  <LspPluginCatalogPane />
                ) : t.kind === "project-workbench" ? (
                  <ProjectWorkbenchBoundary projectName={t.title}>
                  <ProjectWorkbench
                    project={projects.find((project) => project.id === t.projectId) ?? { id: t.projectId ?? t.id, name: t.title, local_path: t.localPath ?? "", group_id: null, created_at: "", linked_profiles: [], remote_workspaces: [], agent_bindings: [] }}
                    profiles={profiles}
                    active={t.id === activeTabId}
                    onOpenRemote={(workspace, target) => {
                      const project = projects.find((item) => item.id === t.projectId);
                      if (project) void openProjectRemote(project, workspace, target);
                    }}
                    onDirtyChange={(dirty, files = []) => {
                      setDirtyEditorTabs((current) => { const next = new Set(current); if (dirty) next.add(t.id); else next.delete(t.id); return next; });
                      setDirtyEditorFiles((current) => ({ ...current, [t.id]: files }));
                    }}
                  />
                  </ProjectWorkbenchBoundary>
                ) : t.kind === "sftp" ? (
                  <SftpPane
                    sessionId={t.sessionId}
                    initialPath={t.remoteRoot ?? t.repoPath}
                    environment={profiles.find((profile) => profile.id === t.profileId)?.environment}
                    active={t.id === activeTabId}
                    onFileOpen={(fp) => openEditor(t.sessionId, fp)}
                  />
                ) : t.kind === "monitor" ? (
                  <MonitorPane sessionId={t.sessionId} active={t.id === activeTabId} />
                ) : t.kind === "editor" ? (
                  <EditorPane
                    sessionId={t.sessionId}
                    filePath={t.filePath ?? ""}
                    onDirtyChange={(dirty) => setDirtyEditorTabs((previous) => {
                      if (previous.has(t.id) === dirty) return previous;
                      const next = new Set(previous);
                      if (dirty) next.add(t.id);
                      else next.delete(t.id);
                      return next;
                    })}
                    onTitleChange={(name) => {
                      setTabs((prev) =>
                        prev.map((tb) =>
                          tb.id === t.id ? { ...tb, title: name } : tb
                        )
                      );
                    }}
                  />
                ) : t.kind === "git" ? (
                  <GitPanel
                    sessionId={t.sessionId}
                    repoPath={t.repoPath ?? ""}
                    onOpenFile={(fp) => openEditor(t.sessionId, fp)}
                  />
                ) : t.kind === "local-terminal" ? (
                  <LocalTerminalPane
                    paneId={t.id}
                    cwd={
                      t.localPath ?? projects.find((p) => p.id === t.projectId)?.local_path ?? ""
                    }
                    startupCommand={t.startupCommand}
                    onExit={() => {
                      if (!t.agentPresetId) return;
                      setTabs((previous) => previous.map((tab) => tab.id === t.id ? { ...tab, agentStatus: "exited" } : tab));
                      showToast(`${t.title} 已退出`, "info");
                    }}
                    onStartFailed={() => {
                      if (!t.agentPresetId) return;
                      setTabs((previous) => previous.map((tab) => tab.id === t.id ? { ...tab, agentStatus: "failed" } : tab));
                      showToast(`${t.title} 启动失败`, "error");
                    }}
                    active={t.id === activeTabId}
                  />
                ) : (
                  <TerminalFileWorkspace
                    layout={t.layout!}
                    sessionId={t.sessionId}
                    initialPath={t.remoteRoot}
                    environment={profiles.find((profile) => profile.id === t.profileId)?.environment}
                    view={t.terminalView ?? "terminal"}
                    sftpOpened={Boolean(t.sftpOpened)}
                    splitDirection={t.terminalFileSplitDirection ?? "horizontal"}
                    splitRatio={Math.max(0.25, Math.min(0.75, t.terminalFileSplitRatio ?? 0.58))}
                    active={t.id === activeTabId}
                    startupCommand={t.startupCommand}
                    onViewChange={(view) => setTerminalWorkspaceView(t.id, view)}
                    onSplitChange={(direction, ratio) => {
                      setTabs((current) => current.map((tab) => tab.id === t.id
                        ? {
                            ...tab,
                            terminalFileSplitDirection: direction,
                            terminalFileSplitRatio: Math.max(0.25, Math.min(0.75, ratio)),
                          }
                        : tab));
                    }}
                    onLayoutChange={(layout) => updateTabLayout(t.id, layout)}
                    onCloseAll={() => closeTab(t.id)}
                    onConnectionLost={handleConnectionLost}
                    onFileOpen={(path) => openEditor(t.sessionId, path)}
                  />
                )}
                </Suspense>
              </div>
            ))
          )}
        </main>

      </div>

      <TaskFeedbackBridge notifyIfHidden={notifyIfHidden} />

      {settings.taskDrawerOpen && <Suspense fallback={null}><TaskDrawer
        open
        section={taskSection}
        session={activeSession}
        environments={sessionEnvironments}
        onSectionChange={setTaskSection}
        onOpenConnections={() => setMode("ssh")}
        onClose={() => updateSettings({ taskDrawerOpen: false, workspaceLayout: "focus" })}
      /></Suspense>}

      {(showConnect || editProfile) && (
        <ConnectDialog
          editProfile={editProfile ?? undefined}
          groups={groups}
          profiles={profiles}
          onClose={() => {
            setShowConnect(false);
            setEditProfile(null);
          }}
          onConnected={onConnected}
          onProfileSaved={async () => {
            await refreshProfiles();
            await refreshGroups();
          }}
        />
      )}

      {showSettings && <Suspense fallback={null}><SettingsDialog
        open
        onClose={() => setShowSettings(false)}
        onOpenLspCatalog={() => { setShowSettings(false); openLspCatalog(); }}
      /></Suspense>}

      {showSnippets && (
        <Suspense fallback={null}><SnippetManager
          onClose={() => setShowSnippets(false)}
          onChanged={() => {
            invoke<Snippet[]>("snippet_list").then(setSnippets).catch((reason) => toast(`命令片段刷新失败：${String(reason)}`, "error"));
          }}
        /></Suspense>
      )}

      {showBroadcastDialog && (
        <Suspense fallback={null}><BroadcastDialog
          sessions={sessions}
          initialTargets={broadcastTargets}
          environments={sessionEnvironments}
          onClose={() => setShowBroadcastDialog(false)}
          onConfirm={(targetIds) => {
            setBroadcastTargets(targetIds);
            setBroadcastEnabled(true);
            setShowBroadcastDialog(false);
            showToast(`已向 ${targetIds.length} 个目标会话启用输入广播`, "info");
          }}
        /></Suspense>
      )}

      {pendingAgentLaunch && (
        <ConfirmDialog
          title="未在 PATH 中找到 Agent 命令"
          confirmLabel="仍然启动"
          onClose={() => setPendingAgentLaunch(null)}
          onConfirm={() => {
            const pending = pendingAgentLaunch;
            setPendingAgentLaunch(null);
            startProjectAgent(pending.project, pending.preset, pending.command);
          }}
        >
          <p>未检测到 <code>{pendingAgentLaunch.executable || pendingAgentLaunch.command}</code>。如果它由 shell alias、函数、npx 或项目脚本提供，仍可继续启动。</p>
          <p><strong>{pendingAgentLaunch.preset.name}</strong> 将在项目目录的新终端中执行：</p>
          <code>{pendingAgentLaunch.command}</code>
        </ConfirmDialog>
      )}

      {pendingCloseTabId && (
        <Suspense fallback={null}><UnsavedChangesDialog
          fileName={tabs.find((tab) => tab.id === pendingCloseTabId)?.title ?? "当前文件"}
          fileNames={dirtyEditorFiles[pendingCloseTabId]}
          onKeepEditing={() => setPendingCloseTabId(null)}
          onDiscard={() => {
            const id = pendingCloseTabId;
            setPendingCloseTabId(null);
            performCloseTab(id);
          }}
        /></Suspense>
      )}

      {connecting && (
        <div className="connecting">
          <div className="connecting-card">
            <LoadingState label={`正在连接 ${connecting.name}`} detail={connecting.message} />
            <ConnSteps stage={connecting.stage} />
          </div>
        </div>
      )}

      {shuttingDown && <div className="shutdown-overlay" role="status" aria-live="assertive"><div><LoadingState label="正在关闭连接并保存工作区…" detail="终端、任务与语言服务将安全停止，应用不会留在后台。" /></div></div>}

      {hostKey && (
        <Suspense fallback={null}><HostKeyDialog
          data={hostKey}
          busy={hostKeyBusy}
          onTrust={handleHostKeyTrust}
          onReject={handleHostKeyReject}
        /></Suspense>
      )}

      {showCommandPalette && <Suspense fallback={null}><CommandPalette
        open={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        commands={paletteCommands}
      /></Suspense>}
    </div>
    </BroadcastContext.Provider>
  );
}

/** 高频传输状态只在此桥接组件消费，避免进度刷新整棵 App。 */
function TaskFeedbackBridge({ notifyIfHidden }: { notifyIfHidden: (body: string) => Promise<void> }) {
  const { tasks } = useTasks();
  const { toast } = useToast();
  const knownRef = useRef(new Map<string, string>());

  useEffect(() => {
    for (const task of tasks) {
      const previous = knownRef.current.get(task.id);
      if (previous && previous !== task.status) {
        if (task.status === "failed") toast(`传输失败：${task.name}`, "error");
        else if (task.status === "done") void notifyIfHidden(`传输完成：${task.name}`);
      }
      knownRef.current.set(task.id, task.status);
    }
  }, [notifyIfHidden, tasks, toast]);

  return null;
}

/** 在 layout 的最深左叶处分屏（命令面板 split 用）。 */
function splitFirstLeaf(node: SplitNode, dir: SplitDir): SplitNode {
  if (node.kind === "leaf") {
    return {
      kind: "split",
      dir,
      ratio: 0.5,
      children: [
        node,
        { kind: "leaf", paneId: crypto.randomUUID(), sessionId: node.sessionId },
      ],
    };
  }
  return {
    ...node,
    children: [splitFirstLeaf(node.children[0], dir), node.children[1]],
  };
}

/** 最小 shell 单引号转义：项目远程根目录只作为 `cd --` 的参数发送。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export default App;
