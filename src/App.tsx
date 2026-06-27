import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as TerminalIcon } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { StatusBar } from "./components/StatusBar";
import { ConnectDialog } from "./components/ConnectDialog";
import { SplitView } from "./components/SplitView";
import { SftpPane } from "./components/SftpPane";
import { MonitorPane } from "./components/MonitorPane";
import { EditorPane } from "./components/EditorPane";
import { GitPanel } from "./components/GitPanel";
import { ConnSteps } from "./components/ConnSteps";
import { TransferPanel } from "./components/TransferPanel";
import { ForwardPanel } from "./components/ForwardPanel";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import {
  CommandPalette,
  builtinCommands,
  profileCommands,
  tabCommands,
  type CommandItem,
} from "./components/CommandPalette";
import { useAppShortcuts } from "./hooks/useAppShortcuts";
import { useSettings } from "./settings/SettingsProvider";
import { useUpdater } from "./hooks/useUpdater";
import { useWorkspaceRestore } from "./hooks/useWorkspaceRestore";
import type {
  ConnectionProfile,
  HostKeyEvent,
  ProfileGroup,
  SessionInfo,
  SplitNode,
  Tab,
} from "./types";
import "./App.css";

type ToastKind = "error" | "info";

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

function App() {
  const { settings } = useSettings();
  const { checkForUpdates } = useUpdater();
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [groups, setGroups] = useState<ProfileGroup[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [editProfile, setEditProfile] = useState<ConnectionProfile | null>(null);
  const [toast, setToast] = useState("");
  const [toastKind, setToastKind] = useState<ToastKind>("error");
  const [connecting, setConnecting] = useState<{
    cid: string;
    name: string;
    stage: string;
    message: string;
  } | null>(null);
  const [hostKey, setHostKey] = useState<HostKeyEvent | null>(null);
  const [hostKeyBusy, setHostKeyBusy] = useState(false);

  const hostKeyRef = useRef<HostKeyEvent | null>(null);
  const connectingCidRef = useRef<string | null>(null);
  const retryProfileIdRef = useRef<string | null>(null);
  /** sessionId → profileId，仅 profile_connect 建立的会话可自动重连 */
  const sessionProfileRef = useRef<Map<string, string>>(new Map());
  /** 用户主动断开，避免触发自动重连 */
  const intentionalDisconnectRef = useRef<Set<string>>(new Set());
  /** 正在重连中的 session，防止分屏多 pane 重复触发 */
  const reconnectingRef = useRef<Set<string>>(new Set());

  const showToast = useCallback((msg: string, kind: ToastKind = "error") => {
    setToastKind(kind);
    setToast(msg);
  }, []);

  const refreshSessions = async () => {
    try {
      setSessions(await invoke<SessionInfo[]>("ssh_list_sessions"));
    } catch (e) {
      showToast(String(e));
    }
  };

  const refreshProfiles = async () => {
    try {
      setProfiles(await invoke<ConnectionProfile[]>("profile_list"));
    } catch (e) {
      showToast(String(e));
    }
  };

  const refreshGroups = async () => {
    try {
      setGroups(await invoke<ProfileGroup[]>("group_list"));
    } catch (e) {
      showToast(String(e));
    }
  };

  useEffect(() => {
    refreshSessions();
    refreshProfiles();
    refreshGroups();
  }, []);

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

  function openTerminal(s: SessionInfo, profileId?: string) {
    const existing = tabs.find((t) => t.sessionId === s.id && t.kind === "terminal");
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      sessionId: s.id,
      title: `${s.user}@${s.host}`,
      kind: "terminal",
      profileId,
      layout: {
        kind: "leaf",
        paneId: crypto.randomUUID(),
        sessionId: s.id,
      },
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }

  function openSftp(s: SessionInfo) {
    const existing = tabs.find((t) => t.sessionId === s.id && t.kind === "sftp");
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      sessionId: s.id,
      title: `${s.user}@${s.host} · 文件`,
      kind: "sftp",
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
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
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }

  function closeTab(id: string) {
    setTabs((prev) => prev.filter((t) => t.id !== id));
    setActiveTabId((prev) => (prev === id ? null : prev));
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
  useWorkspaceRestore({
    profiles,
    setTabs,
    setActiveTabId,
    tabs,
    activeTabId,
    showToast,
    sessionProfileRef,
  });

  async function connectProfile(id: string) {
    setToast("");
    const profile = profiles.find((p) => p.id === id);
    const name = profile?.name ?? "服务器";
    const cid = crypto.randomUUID();
    connectingCidRef.current = cid;
    retryProfileIdRef.current = id;
    setConnecting({ cid, name, stage: "resolve", message: "开始连接…" });
    try {
      const s = await invoke<SessionInfo>("profile_connect", {
        id,
        connectId: cid,
      });
      sessionProfileRef.current.set(s.id, id);
      await refreshSessions();
      setConnecting(null);
      connectingCidRef.current = null;
      openTerminal(s, id);
    } catch (e) {
      setConnecting(null);
      connectingCidRef.current = null;
      if (hostKeyRef.current?.connectId === cid) return;
      showToast(String(e));
    }
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
        showToast(`「${label}」重连失败，已达最大次数 (${max})`, "error");
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
      } catch {
        if (hostKeyRef.current) {
          reconnectingRef.current.delete(oldSessionId);
          showToast(`「${label}」重连需确认主机公钥，请手动重连`, "error");
          return;
        }
        void attemptReconnect(oldSessionId, profileId, attempt + 1);
      }
    },
    [profiles, settings.maxReconnectAttempts, showToast]
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
        showToast("SSH 连接已断开", "error");
        return;
      }

      reconnectingRef.current.add(sessionId);
      void attemptReconnect(sessionId, profileId, 0);
    },
    [attemptReconnect, settings.autoReconnect, showToast]
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
    setToast("");
    try {
      await invoke("profile_delete", { id });
      await refreshProfiles();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function createGroup(name: string) {
    try {
      await invoke("group_create", { name });
      await refreshGroups();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function renameGroup(id: string, name: string) {
    try {
      await invoke("group_rename", { id, name });
      await refreshGroups();
    } catch (e) {
      showToast(String(e));
    }
  }

  async function deleteGroup(id: string) {
    try {
      await invoke("group_delete", { id });
      await refreshGroups();
      await refreshProfiles();
    } catch (e) {
      showToast(String(e));
    }
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

  // 命令面板数据源
  const paletteCommands: CommandItem[] = [
    ...profileCommands(profiles, connectProfile),
    ...tabCommands(tabs, setActiveTabId),
    ...builtinCommands({
      onNewConnection: () => setShowConnect(true),
      onCloseTab: () => activeTabId && closeTab(activeTabId),
      onOpenSettings: () => setShowSettings(true),
      onOpenSftp: () => activeSession && openSftp(activeSession),
      onOpenMonitor: () => activeSession && openMonitor(activeSession),
      onOpenGit: () => activeSession && openGit(activeSession.id, "."),
      onDisconnect: () => activeSession && disconnect(activeSession.id),
      onSplitHorizontal: () => {
        /* 分屏操作通过当前 active tab 的 layout 实现，暂由 SplitView 内部按钮触发 */
      },
      onSplitVertical: () => {},
    }),
  ];

  return (
    <div className="app">
      <Sidebar
        profiles={profiles}
        groups={groups}
        onConnectProfile={connectProfile}
        onEditProfile={setEditProfile}
        onDeleteProfile={deleteProfile}
        onCreateGroup={createGroup}
        onRenameGroup={renameGroup}
        onDeleteGroup={deleteGroup}
        onNew={() => setShowConnect(true)}
      />

      <div className="workspace">
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onActivate={setActiveTabId}
          onClose={closeTab}
          onNew={() => setShowConnect(true)}
        />

        <main className="main">
          {tabs.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">
                <TerminalIcon size={26} />
              </div>
              <div className="empty-title">还没有打开的终端</div>
              <div className="empty-hint">
                从左侧选一个连接（终端 / 文件），或点 + 新建一个
              </div>
            </div>
          ) : (
            tabs.map((t) => (
              <div
                key={t.id}
                className={`pane ${t.id === activeTabId ? "active" : ""}`}
              >
                {t.kind === "sftp" ? (
                  <SftpPane
                    sessionId={t.sessionId}
                    onFileOpen={(fp) => openEditor(t.sessionId, fp)}
                  />
                ) : t.kind === "monitor" ? (
                  <MonitorPane sessionId={t.sessionId} />
                ) : t.kind === "editor" ? (
                  <EditorPane
                    sessionId={t.sessionId}
                    filePath={t.filePath ?? ""}
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
                ) : (
                  <SplitView
                    layout={t.layout!}
                    sessionId={t.sessionId}
                    onChange={(n) => updateTabLayout(t.id, n)}
                    onCloseAll={() => closeTab(t.id)}
                    onConnectionLost={handleConnectionLost}
                  />
                )}
              </div>
            ))
          )}
        </main>

        <StatusBar
          session={activeSession}
          tabCount={tabs.length}
          onOpenSftp={() => activeSession && openSftp(activeSession)}
          onOpenMonitor={() => activeSession && openMonitor(activeSession)}
          onOpenGit={() => activeSession && openGit(activeSession.id, ".")}
          onDisconnect={() => activeSession && disconnect(activeSession.id)}
          onOpenSettings={() => setShowSettings(true)}
          onOpenCommandPalette={() => setShowCommandPalette((v) => !v)}
        />
      </div>

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

      <SettingsDialog
        open={showSettings}
        onClose={() => setShowSettings(false)}
      />

      {connecting && (
        <div className="connecting">
          <div className="connecting-card">
            <div className="conn-spinner" />
            <div className="connecting-title">正在连接 {connecting.name}</div>
            <div className="connecting-msg">{connecting.message}</div>
            <ConnSteps stage={connecting.stage} />
          </div>
        </div>
      )}

      <TransferPanel />
      <ForwardPanel />

      {hostKey && (
        <HostKeyDialog
          data={hostKey}
          busy={hostKeyBusy}
          onTrust={handleHostKeyTrust}
          onReject={handleHostKeyReject}
        />
      )}

      {toast && (
        <div
          className={`toast ${toastKind === "info" ? "toast-info" : ""}`}
          onClick={() => setToast("")}
        >
          {toast}
        </div>
      )}

      <CommandPalette
        open={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        commands={paletteCommands}
      />
    </div>
  );
}

export default App;
