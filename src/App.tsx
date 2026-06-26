import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as TerminalIcon } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { StatusBar } from "./components/StatusBar";
import { ConnectDialog } from "./components/ConnectDialog";
import { SplitView } from "./components/SplitView";
import { SftpPane } from "./components/SftpPane";
import { ConnSteps } from "./components/ConnSteps";
import { TransferPanel } from "./components/TransferPanel";
import { ForwardPanel } from "./components/ForwardPanel";
import { HostKeyDialog } from "./components/HostKeyDialog";
import type {
  ConnectionProfile,
  HostKeyEvent,
  SessionInfo,
  SplitNode,
  Tab,
} from "./types";
import "./App.css";

function App() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [editProfile, setEditProfile] = useState<ConnectionProfile | null>(null);
  const [toast, setToast] = useState("");
  const [connecting, setConnecting] = useState<{
    cid: string;
    name: string;
    stage: string;
    message: string;
  } | null>(null);
  const [hostKey, setHostKey] = useState<HostKeyEvent | null>(null);
  const [hostKeyBusy, setHostKeyBusy] = useState(false);
  // 同步镜像，避免 ssh://hostkey 事件与 connect() reject 的竞态导致误弹错误 toast。
  const hostKeyRef = useRef<HostKeyEvent | null>(null);
  // 当前 profile 连接的 cid（供事件匹配）与可重试的 profile id。
  const connectingCidRef = useRef<string | null>(null);
  const retryProfileIdRef = useRef<string | null>(null);

  const refreshSessions = async () => {
    try {
      setSessions(await invoke<SessionInfo[]>("ssh_list_sessions"));
    } catch (e) {
      setToast(String(e));
    }
  };
  const refreshProfiles = async () => {
    try {
      setProfiles(await invoke<ConnectionProfile[]>("profile_list"));
    } catch (e) {
      setToast(String(e));
    }
  };

  useEffect(() => {
    refreshSessions();
    refreshProfiles();
  }, []);

  // 侧栏一键连接时，按 connectId 跟踪后端推送的阶段进度
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

  // 主机公钥待确认（首次连接 / 公钥变更）：仅处理本应用发起的 profile 连接。
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

  function openTerminal(s: SessionInfo) {
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

  function closeTab(id: string) {
    setTabs((prev) => prev.filter((t) => t.id !== id));
    setActiveTabId((prev) => (prev === id ? null : prev));
  }

  function updateTabLayout(tabId: string, layout: SplitNode) {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, layout } : t))
    );
  }

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
      await refreshSessions();
      setConnecting(null);
      connectingCidRef.current = null;
      openTerminal(s);
    } catch (e) {
      setConnecting(null);
      connectingCidRef.current = null;
      // 主机公钥待确认：事件已到，交给确认弹窗，不弹错误 toast。
      if (hostKeyRef.current?.connectId === cid) return;
      setToast(String(e));
    }
  }

  // 用户在主机公钥弹窗点「信任」：落盘到 known_hosts 后以新 cid 重连。
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
      setToast(String(e));
    }
  }

  // 用户拒绝主机公钥：清缓存、断开本次连接尝试。
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
    setToast("已拒绝主机公钥，未连接。");
  }

  async function deleteProfile(id: string) {
    setToast("");
    try {
      await invoke("profile_delete", { id });
      await refreshProfiles();
    } catch (e) {
      setToast(String(e));
    }
  }

  async function disconnect(id: string) {
    const wasActive = tabs.some((t) => t.id === activeTabId && t.sessionId === id);
    setTabs((prev) => prev.filter((t) => t.sessionId !== id));
    if (wasActive) setActiveTabId(null);
    try {
      await invoke("ssh_disconnect", { id });
      await refreshSessions();
    } catch (e) {
      setToast(String(e));
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

  return (
    <div className="app">
      <Sidebar
        profiles={profiles}
        onConnectProfile={connectProfile}
        onEditProfile={setEditProfile}
        onDeleteProfile={deleteProfile}
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
                  <SftpPane sessionId={t.sessionId} />
                ) : (
                  <SplitView
                    layout={t.layout!}
                    sessionId={t.sessionId}
                    onChange={(n) => updateTabLayout(t.id, n)}
                    onCloseAll={() => closeTab(t.id)}
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
          onDisconnect={() => activeSession && disconnect(activeSession.id)}
        />
      </div>

      {(showConnect || editProfile) && (
        <ConnectDialog
          editProfile={editProfile ?? undefined}
          onClose={() => {
            setShowConnect(false);
            setEditProfile(null);
          }}
          onConnected={onConnected}
          onProfileSaved={refreshProfiles}
        />
      )}

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

      {toast && <div className="toast" onClick={() => setToast("")}>{toast}</div>}
    </div>
  );
}

export default App;
