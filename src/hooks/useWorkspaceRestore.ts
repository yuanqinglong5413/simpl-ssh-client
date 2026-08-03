import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { invokeWithTimeout } from "../utils/invokeWithTimeout";
import type {
  ConnectionProfile,
  SessionInfo,
  SplitNode,
  Tab,
  WorkspaceSnapshot,
  WorkspaceTab,
} from "../types";

export type WorkspaceRestoreIssueKind = "transient" | "missing_profile" | "invalid_snapshot";

export type WorkspaceRestoreIssue = {
  tab: WorkspaceTab;
  kind: WorkspaceRestoreIssueKind;
  message: string;
};

export type WorkspaceLoadError = {
  kind: "transient" | "invalid_snapshot";
  message: string;
};

export type ProfilesLoadState = "loading" | "ready" | "error";

type RestoreParams = {
  profiles: ConnectionProfile[];
  /** profile_list 的真实结果；error 不能被当成空配置。 */
  profilesState: ProfilesLoadState;
  profilesError?: string;
  setTabs: React.Dispatch<React.SetStateAction<Tab[]>>;
  setActiveTabId: React.Dispatch<React.SetStateAction<string | null>>;
  tabs: Tab[];
  activeTabId: string | null;
  showToast: (msg: string, kind?: "error" | "info") => void;
  sessionProfileRef: React.MutableRefObject<Map<string, string>>;
  reloadProfiles?: () => Promise<void>;
};

/** 验证持久化快照；旧版本缺少可选字段仍可读取。 */
export function parseWorkspaceSnapshot(raw: string): WorkspaceSnapshot {
  const snapshot = JSON.parse(raw) as WorkspaceSnapshot;
  if (!Array.isArray(snapshot.tabs)) throw new Error("缺少标签列表");
  return snapshot;
}

/** 无配置关联的标签不能通过重试修复；不要把它伪装成连接故障。 */
export function classifyRestorePrecondition(tab: WorkspaceTab, profiles: ConnectionProfile[], profilesState: ProfilesLoadState, profilesError?: string): WorkspaceRestoreIssue | null {
  if (!tab.profileId) {
    return { tab, kind: "invalid_snapshot", message: "此标签没有关联的连接配置，无法恢复。" };
  }
  if (profilesState === "error") {
    return { tab, kind: "transient", message: `连接配置暂时无法读取：${profilesError || "请重试加载配置。"}` };
  }
  if (!profiles.some((profile) => profile.id === tab.profileId)) {
    return { tab, kind: "missing_profile", message: `连接配置“${tab.title}”已不存在。` };
  }
  return null;
}

export function makeTransientRestoreIssue(tab: WorkspaceTab, error: unknown): WorkspaceRestoreIssue {
  return { tab, kind: "transient", message: `连接恢复失败：${String(error)}` };
}

export function removeWorkspaceTab(snapshot: WorkspaceSnapshot, tabId: string): WorkspaceSnapshot {
  const tabs = snapshot.tabs.filter((tab) => tab.id !== tabId);
  return { ...snapshot, tabs, activeTabId: snapshot.activeTabId === tabId ? tabs[0]?.id ?? null : snapshot.activeTabId };
}

function snapshotFromTabs(tabs: Tab[], activeTabId: string | null): WorkspaceSnapshot {
  return {
    version: 2,
    activeTabId,
    tabs: tabs.map(
      (tab): WorkspaceTab => ({
        id: tab.id,
        sessionId: tab.sessionId,
        profileId: tab.profileId ?? null,
        title: tab.title,
        kind: tab.kind,
        layout: tab.layout,
        filePath: tab.filePath,
        repoPath: tab.repoPath,
        remoteRoot: tab.remoteRoot,
        source: tab.source,
        projectId: tab.projectId ?? null,
        localPath: tab.localPath,
        startupCommand: tab.startupCommand,
        agentPresetId: tab.agentPresetId,
      })
    ).filter((tab) => !tab.agentPresetId),
    updatedAt: new Date().toISOString(),
  };
}

/** 将当前内存中的标签与尚未处理的旧快照合并，避免恢复横幅期间的新标签被覆盖。 */
export function mergeRecoverySnapshot(
  base: WorkspaceSnapshot,
  currentTabs: Tab[],
  activeTabId: string | null,
  removedIds: Set<string>,
): WorkspaceSnapshot {
  const current = snapshotFromTabs(currentTabs, activeTabId);
  const currentIds = new Set(current.tabs.map((tab) => tab.id));
  const pending = base.tabs.filter((tab) => !removedIds.has(tab.id) && !currentIds.has(tab.id) && !tab.agentPresetId);
  return {
    ...current,
    tabs: [...current.tabs, ...pending],
    activeTabId: current.activeTabId,
  };
}

/**
 * 工作区快照恢复：本地标签不依赖连接配置；远程标签在 profile_list 完成后恢复。
 * 未恢复标签保留在原快照中，但可恢复和不可恢复的原因及操作必须明确区分。
 */
export function useWorkspaceRestore({
  profiles,
  profilesState,
  profilesError,
  setTabs,
  setActiveTabId,
  tabs,
  activeTabId,
  showToast,
  sessionProfileRef,
  reloadProfiles,
}: RestoreParams) {
  const attemptedRef = useRef(false);
  const attemptedProfilesStateRef = useRef<ProfilesLoadState | null>(null);
  const snapshotRef = useRef<WorkspaceSnapshot | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveEnabled, setSaveEnabled] = useState(false);
  const [issues, setIssues] = useState<WorkspaceRestoreIssue[]>([]);
  const [loadError, setLoadError] = useState<WorkspaceLoadError | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const saveFailureShownRef = useRef(false);

  const writeSnapshot = useCallback(async (snapshot: WorkspaceSnapshot) => {
    await invoke("workspace_save", { snapshot: JSON.stringify(snapshot) });
  }, []);

  const restoreRemoteTabs = useCallback(async (candidates: WorkspaceTab[]) => {
    const restored: Tab[] = [];
    const failed: WorkspaceRestoreIssue[] = [];

    for (const tab of candidates) {
      const precondition = classifyRestorePrecondition(tab, profiles, profilesState, profilesError);
      if (precondition) {
        failed.push(precondition);
        continue;
      }
      try {
        const session = await invoke<SessionInfo>("profile_connect", {
          id: tab.profileId,
          connectId: crypto.randomUUID(),
        });
        sessionProfileRef.current.set(session.id, tab.profileId!);
        restored.push(restoreRemoteTab(tab, session.id));
      } catch (error) {
        failed.push(makeTransientRestoreIssue(tab, error));
      }
    }

    if (restored.length) {
      setTabs((previous) => {
        const existing = new Set(previous.map((tab) => tab.id));
        return [...previous, ...restored.filter((tab) => !existing.has(tab.id))];
      });
    }
    return { failed, restored };
  }, [profiles, profilesError, profilesState, sessionProfileRef, setTabs]);

  const finishRecoveryIfResolved = useCallback((nextIssues: WorkspaceRestoreIssue[]) => {
    if (nextIssues.length === 0) setSaveEnabled(true);
  }, []);

  const retryCandidates = useCallback(async (candidates: WorkspaceRestoreIssue[]) => {
    if (!candidates.length || retrying) return;
    setRetrying(true);
    try {
      const attemptedIds = new Set(candidates.map((issue) => issue.tab.id));
      const result = await restoreRemoteTabs(candidates.map((issue) => issue.tab));
      const nextIssues = [...issues.filter((issue) => !attemptedIds.has(issue.tab.id)), ...result.failed];
      setIssues(nextIssues);
      finishRecoveryIfResolved(nextIssues);
      if (result.restored.length) showToast(`已恢复 ${result.restored.length} 个工作区标签`, "info");
    } finally {
      setRetrying(false);
    }
  }, [finishRecoveryIfResolved, issues, restoreRemoteTabs, retrying, showToast]);

  const retryTransient = useCallback(async () => {
    await retryCandidates(issues.filter((issue) => issue.kind === "transient"));
  }, [issues, retryCandidates]);

  /** 缺失配置不会自动重试；用户补回配置后可显式重新检查这一项。 */
  const retryMissingProfile = useCallback(async (tabId: string) => {
    await retryCandidates(issues.filter((issue) => issue.tab.id === tabId && issue.kind === "missing_profile"));
  }, [issues, retryCandidates]);

  const retryLoad = useCallback(async () => {
    if (!loadError || loadError.kind !== "transient" || retrying) return;
    attemptedRef.current = false;
    setRetrying(true);
    setLoadError(null);
    await reloadProfiles?.();
    setRetryNonce((value) => value + 1);
  }, [loadError, reloadProfiles, retrying]);

  /** 跳过一项只删除该项，立即把剩余恢复记录写回磁盘。 */
  const skipIssue = useCallback(async (tabId: string) => {
    const nextIssues = issues.filter((issue) => issue.tab.id !== tabId);
    const snapshot = snapshotRef.current;
    if (snapshot) {
      const nextSnapshot = mergeRecoverySnapshot(snapshot, tabs, activeTabId, new Set([tabId]));
      snapshotRef.current = nextSnapshot;
      try {
        await writeSnapshot(nextSnapshot);
      } catch (error) {
        showToast(`无法更新恢复记录：${String(error)}`);
        return;
      }
    }
    setIssues(nextIssues);
    finishRecoveryIfResolved(nextIssues);
  }, [activeTabId, finishRecoveryIfResolved, issues, showToast, tabs, writeSnapshot]);

  /** 主动放弃当前快照中的所有未恢复项，保留已打开的正常标签。 */
  const discardPendingRecovery = useCallback(async () => {
    try {
      if (tabs.length > 0) {
        const nextSnapshot = snapshotFromTabs(tabs, activeTabId);
        await writeSnapshot(nextSnapshot);
        snapshotRef.current = nextSnapshot;
      } else {
        await invoke("workspace_clear");
        snapshotRef.current = null;
      }
      setIssues([]);
      setLoadError(null);
      setSaveEnabled(true);
      showToast(tabs.length > 0 ? "已放弃未恢复标签，当前工作区已保留" : "已清除未恢复的工作区记录", "info");
    } catch (error) {
      showToast(`无法清除恢复记录：${String(error)}`);
    }
  }, [activeTabId, showToast, tabs, writeSnapshot]);

  useEffect(() => {
    if (profilesState === "loading") return;
    if (attemptedRef.current && attemptedProfilesStateRef.current === profilesState) return;
    attemptedRef.current = true;
    attemptedProfilesStateRef.current = profilesState;

    void (async () => {
      let snapshot: WorkspaceSnapshot;
      try {
        const raw = await invokeWithTimeout(invoke<string | null>("workspace_load"), "workspace_load");
        if (!raw) {
          setSaveEnabled(true);
          setRetrying(false);
          return;
        }
        snapshot = parseWorkspaceSnapshot(raw);
        snapshotRef.current = snapshot;
      } catch (error) {
        const invalidSnapshot = error instanceof SyntaxError || error instanceof Error && error.message === "缺少标签列表";
        setLoadError({
          kind: invalidSnapshot ? "invalid_snapshot" : "transient",
          message: invalidSnapshot ? "上次工作区记录已损坏，无法读取。" : `无法读取上次工作区：${String(error)}`,
        });
        setRetrying(false);
        return;
      }

      const localTabs = snapshot.tabs
        .filter((tab) => tab.source === "local" && !tab.agentPresetId)
        .map(restoreLocalTab);
      if (localTabs.length) setTabs(localTabs);
      if (snapshot.activeTabId && localTabs.some((tab) => tab.id === snapshot.activeTabId)) {
        setActiveTabId(snapshot.activeTabId);
      }

      const remoteCandidates = snapshot.tabs.filter((tab) => tab.source !== "local" && !tab.agentPresetId);
      const result = await restoreRemoteTabs(remoteCandidates);
      if (snapshot.activeTabId && result.restored.some((tab) => tab.id === snapshot.activeTabId)) {
        setActiveTabId(snapshot.activeTabId);
      } else if (!localTabs.length && result.restored[0]) {
        setActiveTabId(result.restored[0].id);
      }

      setIssues(result.failed);
      if (result.failed.length) {
        showToast(`已恢复 ${localTabs.length + result.restored.length} 个标签，${result.failed.length} 个需要处理`, "error");
        setRetrying(false);
        return;
      }
      setSaveEnabled(true);
      setRetrying(false);
      if (localTabs.length || result.restored.length) showToast(`已恢复 ${localTabs.length + result.restored.length} 个工作区标签`, "info");
    })();
  }, [profilesState, restoreRemoteTabs, retryNonce, setActiveTabId, setTabs, showToast]);

  useEffect(() => {
    if (!saveEnabled) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (tabs.length === 0) {
        void invoke("workspace_clear").then(() => { saveFailureShownRef.current = false; }).catch((error) => {
          if (!saveFailureShownRef.current) {
            saveFailureShownRef.current = true;
            showToast(`工作区记录清除失败：${String(error)}`, "error");
          }
        });
        return;
      }
      void writeSnapshot(snapshotFromTabs(tabs, activeTabId)).then(() => {
        saveFailureShownRef.current = false;
      }).catch((error) => {
        if (!saveFailureShownRef.current) {
          saveFailureShownRef.current = true;
          showToast(`工作区保存失败：${String(error)}`, "error");
        }
      });
    }, 500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [activeTabId, saveEnabled, showToast, tabs, writeSnapshot]);

  return {
    issues,
    loadError,
    retrying,
    retryTransient,
    retryMissingProfile,
    retryLoad,
    skipIssue,
    discardPendingRecovery,
  };
}

export function restoreLocalTab(tab: WorkspaceTab): Tab {
  return {
    id: tab.id,
    sessionId: tab.sessionId,
    title: tab.title,
    kind: tab.kind,
    filePath: tab.filePath,
    repoPath: tab.repoPath,
    remoteRoot: tab.remoteRoot,
    startupCommand: tab.startupCommand,
    source: "local",
    projectId: tab.projectId ?? undefined,
    localPath: tab.localPath,
  };
}

function restoreRemoteTab(tab: WorkspaceTab, sessionId: string): Tab {
  const restored: Tab = {
    id: tab.id,
    sessionId,
    title: tab.title,
    kind: tab.kind,
    filePath: tab.filePath,
    repoPath: tab.repoPath,
    remoteRoot: tab.remoteRoot ?? (tab.kind === "sftp" ? tab.repoPath : undefined),
    startupCommand: tab.startupCommand,
    profileId: tab.profileId ?? undefined,
  };
  if (tab.layout) restored.layout = replaceSessionInLayout(tab.layout, tab.sessionId, sessionId);
  else if (tab.kind === "terminal") restored.layout = { kind: "leaf", paneId: crypto.randomUUID(), sessionId };
  return restored;
}

function replaceSessionInLayout(node: SplitNode, oldId: string, newId: string): SplitNode {
  if (node.kind === "leaf") return node.sessionId === oldId ? { ...node, sessionId: newId } : node;
  return { ...node, children: [replaceSessionInLayout(node.children[0], oldId, newId), replaceSessionInLayout(node.children[1], oldId, newId)] };
}
