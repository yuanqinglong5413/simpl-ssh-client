import { describe, expect, it, vi } from "vitest";
import { InvokeTimeoutError, invokeWithTimeout } from "./invokeWithTimeout";

describe("invokeWithTimeout", () => {
  it("resolves before the deadline", async () => {
    await expect(invokeWithTimeout(Promise.resolve("ok"), "demo", 20)).resolves.toBe("ok");
  });

  it("rejects with a diagnosable timeout", async () => {
    vi.useFakeTimers();
    try {
      const pending = invokeWithTimeout(new Promise<string>(() => undefined), "project_list_dir", 100);
      const assertion = expect(pending).rejects.toBeInstanceOf(InvokeTimeoutError);
      vi.advanceTimersByTime(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
