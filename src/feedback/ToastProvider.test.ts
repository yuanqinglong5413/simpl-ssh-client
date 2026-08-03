import { describe, expect, it } from "vitest";
import { toastDuration, upsertToast, visibleToasts, type ToastEntry } from "./ToastProvider";

const entry = (id: string): ToastEntry => ({ id, message: id, kind: "info", updatedAt: 1, count: 1 });

describe("ToastProvider helpers", () => {
  it("uses severity-specific automatic dismissal durations", () => {
    expect(toastDuration("info")).toBe(3500);
    expect(toastDuration("success")).toBe(4000);
    expect(toastDuration("error")).toBe(8000);
  });

  it("merges repeated active messages instead of creating notification noise", () => {
    const once = upsertToast([], "连接已恢复", "success", 10, "first");
    expect(upsertToast(once, "连接已恢复", "success", 20, "second")).toEqual([
      { id: "first", message: "连接已恢复", kind: "success", updatedAt: 20, count: 2 },
    ]);
  });

  it("shows at most three messages while keeping the rest queued", () => {
    const entries = [entry("1"), entry("2"), entry("3"), entry("4")];
    expect(visibleToasts(entries).map(({ id }) => id)).toEqual(["1", "2", "3"]);
  });
});
