import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionProfile,
  SessionInfo,
  SplitNode,
  Tab,
  WorkspaceSnapshot,
  WorkspaceTab,
} from "../types";

type RestoreParams = {
  profiles: ConnectionProfile[];
  setTabs: React.Dispatch<React.SetStateAction<Tab[]>>;
  setActiveTabId: React.Dispatch<React.SetStateAction<string | null>>;
  tabs: Tab[];
  activeTabId: string | null;
  showToast: (msg: string, kind?: "error" | "info") => void;
  /** 记录 sessionId -> profileId 映射，供自动重连使用 */
  sessionProfileRef: React.MutableRefObject<Map<string, string>>;
};

/**
 * 工作区持久化 hook：
 * - 启动时加载快照并串行重连各 profile
 * - tabs 变化时 debounce 保存快照
 */
export function useWorkspaceRestore({
  profiles,
  setTabs,
  setActiveTabId,
  tabs,
  activeTabId,
  showToast,
  sessionProfileRef,
}: RestoreParams) {
  const restoredRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- 启动时恢复 ----
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    (async () => {
      try {
        const raw = await invoke<string | null>("workspace_load");
        if (!raw) return;

        const snapshot: WorkspaceSnapshot = JSON.parse(raw);
        if (!snapshot.tabs || snapshot.tabs.length === 0) return;

        const restoredTabs: Tab[] = [];
        let restoredActiveId: string | null = null;

        for (const wt of snapshot.tabs) {
          if (!wt.profileId) {
            // 无 profileId 的 Tab（手动连接）无法恢复
            continue;
          }

          // 检查 profile 是否仍存在
          const profile = profiles.find((p) => p.id === wt.profileId);
          if (!profile) {
            showToast(`配置 "${wt.title}" 已被删除，跳过恢复`, "info");
            continue;
          }

          try {
            const cid = crypto.randomUUID();
            const session = await invoke<SessionInfo>("profile_connect", {
              id: wt.profileId,
              connectId: cid,
            });
            sessionProfileRef.current.set(session.id, wt.profileId);

            // 重建 Tab，用新 sessionId 替换旧的
            const tab: Tab = {
              id: wt.id,
              sessionId: session.id,
              title: wt.title,
              kind: wt.kind,
              filePath: wt.filePath,
              repoPath: wt.repoPath,
              profileId: wt.profileId,
            };
            if (wt.layout) {
              tab.layout = replaceSessionInLayout(wt.layout, wt.sessionId, session.id);
            } else if (wt.kind === "terminal") {
              tab.layout = {
                kind: "leaf",
                paneId: crypto.randomUUID(),
                sessionId: session.id,
              };
            }

            restoredTabs.push(tab);

            if (snapshot.activeTabId === wt.id) {
              restoredActiveId = wt.id;
            }
          } catch (e) {
            showToast(`恢复 "${wt.title}" 失败: ${String(e)}`, "error");
          }
        }

        if (restoredTabs.length > 0) {
          setTabs(restoredTabs);
          setActiveTabId(restoredActiveId ?? restoredTabs[0].id);
          showToast(`已恢复 ${restoredTabs.length} 个工作区标签`, "info");
        }
      } catch {
        // workspace.json 损坏或解析失败，静默忽略
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- tabs 变化时 debounce 保存 ----
  useEffect(() => {
    if (!restoredRef.current) return;
    if (tabs.length === 0) return;

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(() => {
      const snapshot: WorkspaceSnapshot = {
        version: 1,
        activeTabId,
        tabs: tabs.map(
          (t): WorkspaceTab => ({
            id: t.id,
            sessionId: t.sessionId,
            profileId: t.profileId ?? null,
            title: t.title,
            kind: t.kind,
            layout: t.layout,
            filePath: t.filePath,
            repoPath: t.repoPath,
          })
        ),
        updatedAt: new Date().toISOString(),
      };
      invoke("workspace_save", { snapshot: JSON.stringify(snapshot) }).catch(
        () => {
          /* 保存失败静默忽略 */
        }
      );
    }, 500);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [tabs, activeTabId]);
}

/** 在分屏树中替换 sessionId */
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
