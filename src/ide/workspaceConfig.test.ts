import { describe, expect, it } from "vitest";
import { parseWorkspaceConfig, serializeWorkspaceConfig } from "./workspaceConfig";

describe("workspace configuration", () => {
  it("keeps only complete non-sensitive task and language definitions", () => {
    const config = parseWorkspaceConfig(JSON.stringify({ version: 1, tasks: [{ id: "test", label: "Test", command: "pnpm test" }, { id: "bad", label: "", command: "x" }], languageServers: [{ id: "rust", command: "rust-analyzer", languages: ["rust"] }, { id: "bad", command: "", languages: [] }] }));
    expect(config.tasks).toEqual([{ id: "test", label: "Test", command: "pnpm test", group: undefined }]);
    expect(config.languageServers).toEqual([{ id: "rust", command: "rust-analyzer", languages: ["rust"], args: undefined }]);
    expect(parseWorkspaceConfig(serializeWorkspaceConfig(config))).toEqual(config);
  });
});
