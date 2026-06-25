import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal as TerminalIcon } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { StatusBar } from "./components/StatusBar";
import { ConnectDialog } from "./components/ConnectDialog";
import { TerminalPane } from "./components/TerminalPane";
import type { SessionInfo, Tab } from "./types";
import "./App.css";

function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [toast, setToast] = useState("");

  const refresh = async () => {
    try {
      setSessions(await invoke<SessionInfo[]>("ssh_list_sessions"));
    } catch (e) {
      setToast(String(e));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  function openTerminal(s: SessionInfo) {
    const existing = tabs.find((t) => t.sessionId === s.id);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      sessionId: s.id,
      title: `${s.user}@${s.host}`,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }

  function closeTab(id: string) {
    setTabs((prev) => prev.filter((t) => t.id !== id));
    setActiveTabId((prev) => (prev === id ? null : prev));
  }

  async function disconnect(id: string) {
    const wasActive = tabs.some((t) => t.id === activeTabId && t.sessionId === id);
    setTabs((prev) => prev.filter((t) => t.sessionId !== id));
    if (wasActive) setActiveTabId(null);
    try {
      await invoke("ssh_disconnect", { id });
      await refresh();
    } catch (e) {
      setToast(String(e));
    }
  }

  async function onConnected(s: SessionInfo) {
    await refresh();
    setShowConnect(false);
    openTerminal(s);
  }

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeSession = activeTab
    ? (sessions.find((s) => s.id === activeTab.sessionId) ?? null)
    : null;

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeSessionId={activeTab?.sessionId ?? null}
        onOpen={openTerminal}
        onDisconnect={disconnect}
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
              <div className="empty-hint">从左侧选一个连接，或点 + 新建一个</div>
            </div>
          ) : (
            tabs.map((t) => (
              <div
                key={t.id}
                className={`pane ${t.id === activeTabId ? "active" : ""}`}
              >
                <TerminalPane sessionId={t.sessionId} />
              </div>
            ))
          )}
        </main>

        <StatusBar session={activeSession} tabCount={tabs.length} />
      </div>

      {showConnect && (
        <ConnectDialog
          onClose={() => setShowConnect(false)}
          onConnected={onConnected}
        />
      )}

      {toast && <div className="toast" onClick={() => setToast("")}>{toast}</div>}
    </div>
  );
}

export default App;
