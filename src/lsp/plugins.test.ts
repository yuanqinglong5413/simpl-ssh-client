import { describe, expect, it } from "vitest";
import { LSP_PLUGIN_CATALOG, pluginForLanguage } from "./plugins";

describe("LSP plugin selection", () => {
  it("selects only installed enabled plugins", () => {
    expect(LSP_PLUGIN_CATALOG.some((plugin) => plugin.id === "pyright")).toBe(true);
    expect(pluginForLanguage("python", [{ pluginId: "pyright", version: "1.0.0", enabled: true, priority: 1 }])?.id).toBe("pyright");
    expect(pluginForLanguage("python", [{ pluginId: "pyright", version: "1.0.0", enabled: false, priority: 1 }])).toBeUndefined();
  });

  it("honors project disable and version overrides", () => {
    expect(pluginForLanguage("rust", [{ pluginId: "rust-analyzer", version: "1.0.0", enabled: true, priority: 1 }], [{ pluginId: "rust-analyzer", enabled: false }])).toBeUndefined();
    expect(pluginForLanguage("rust", [{ pluginId: "rust-analyzer", version: "1.0.0", enabled: true, priority: 1 }], [{ pluginId: "rust-analyzer", version: "2.0.0" }])).toBeUndefined();
  });

  it("selects JDTLS for enabled Java projects", () => {
    expect(pluginForLanguage("java", [{ pluginId: "jdtls", version: "1.0.0", enabled: true, priority: 1 }])?.id).toBe("jdtls");
  });
});
