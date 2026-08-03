import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./types";
import { resetPatchForCategory, searchPreferenceCategories } from "./preferences";

describe("preferences registry", () => {
  it("finds categories from Chinese and English search terms", () => {
    expect(searchPreferenceCategories("字体")).toContain("terminal");
    expect(searchPreferenceCategories("known hosts")).toContain("connection");
    expect(searchPreferenceCategories("Agent command")).toContain("agents");
    expect(searchPreferenceCategories("LSP 插件目录")).toEqual(["lspPlugins"]);
  });

  it("resets only the selected category", () => {
    const terminal = resetPatchForCategory("terminal");
    expect(terminal.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(terminal.autoReconnect).toBeUndefined();
    expect(resetPatchForCategory("agents")).toEqual({ agentPresets: [] });
    expect(resetPatchForCategory("language").installedLspPlugins).toBeUndefined();
    expect(resetPatchForCategory("lspPlugins")).toEqual({
      installedLspPlugins: DEFAULT_SETTINGS.installedLspPlugins,
      lspUpdateChannel: DEFAULT_SETTINGS.lspUpdateChannel,
    });
  });
});
