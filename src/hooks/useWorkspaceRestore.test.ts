import { describe, expect, it } from "vitest";
import { classifyRestorePrecondition, makeTransientRestoreIssue, mergeRecoverySnapshot, parseWorkspaceSnapshot, removeWorkspaceTab, restoreLocalTab } from "./useWorkspaceRestore";

describe("workspace local restore", () => {
  it("does not require an SSH profile to restore a local project terminal", () => {
    const tab = restoreLocalTab({
      id: "local-tab", sessionId: "local-session", profileId: null, title: "项目终端",
      kind: "local-terminal", source: "local", projectId: "project-1", startupCommand: "pnpm dev",
    });
    expect(tab).toMatchObject({ id: "local-tab", source: "local", projectId: "project-1", startupCommand: "pnpm dev" });
    expect(tab.agentPresetId).toBeUndefined();
  });

  it("classifies a missing profile reference as a non-retryable snapshot problem", () => {
    const issue = classifyRestorePrecondition({
      id: "remote-tab", sessionId: "old", profileId: null, title: "生产机", kind: "terminal",
    }, [], "ready");
    expect(issue).toMatchObject({ kind: "invalid_snapshot", tab: { id: "remote-tab" } });
  });

  it("keeps a deleted profile distinct from a temporary connection failure", () => {
    const tab = { id: "remote-tab", sessionId: "old", profileId: "missing", title: "测试机", kind: "terminal" as const };
    expect(classifyRestorePrecondition(tab, [], "ready")).toMatchObject({ kind: "missing_profile" });
    expect(makeTransientRestoreIssue(tab, "network down")).toMatchObject({ kind: "transient", message: expect.stringContaining("network down") });
  });

  it("does not misclassify a profile loading error as a missing profile", () => {
    const tab = { id: "remote-tab", sessionId: "old", profileId: "profile", title: "远程机", kind: "terminal" as const };
    expect(classifyRestorePrecondition(tab, [], "error", "读取连接配置失败")).toMatchObject({ kind: "transient" });
  });

  it("removes only the skipped tab from the persisted snapshot", () => {
    const snapshot = parseWorkspaceSnapshot(JSON.stringify({
      version: 2, activeTabId: "broken", updatedAt: "2026-01-01T00:00:00Z",
      tabs: [
        { id: "good", sessionId: "one", profileId: "profile", title: "正常", kind: "terminal" },
        { id: "broken", sessionId: "two", profileId: null, title: "失效", kind: "terminal" },
      ],
    }));
    expect(removeWorkspaceTab(snapshot, "broken")).toMatchObject({ activeTabId: "good", tabs: [{ id: "good" }] });
  });

  it("keeps tabs opened while recovery banner is visible", () => {
    const base = parseWorkspaceSnapshot(JSON.stringify({ version: 2, activeTabId: "broken", updatedAt: "now", tabs: [
      { id: "broken", sessionId: "two", profileId: null, title: "失效", kind: "terminal" },
      { id: "pending", sessionId: "three", profileId: "missing", title: "待处理", kind: "terminal" },
    ] }));
    const merged = mergeRecoverySnapshot(base, [{ id: "new", sessionId: "local", title: "新标签", kind: "local-terminal", source: "local" }], "new", new Set(["broken"]));
    expect(merged.tabs.map((tab) => tab.id)).toEqual(["new", "pending"]);
    expect(merged.activeTabId).toBe("new");
  });

  it("rejects a corrupt workspace record instead of treating it as retryable", () => {
    expect(() => parseWorkspaceSnapshot("{bad json")).toThrow();
    expect(() => parseWorkspaceSnapshot(JSON.stringify({ version: 2 }))).toThrow("缺少标签列表");
  });
});
