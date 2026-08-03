import type { InstalledLspPlugin, LspPluginManifest } from "../settings/types";
import type { LanguageServerPluginOverride } from "../ide/workspaceConfig";

const PLUGINS: Array<[string, string, string[], string[]]> = [
  ["typescript", "TypeScript Language Server", ["javascript", "typescript"], ["js", "jsx", "ts", "tsx"]],
  ["pyright", "Pyright", ["python"], ["py", "pyw"]],
  ["rust-analyzer", "rust-analyzer", ["rust"], ["rs"]],
  ["gopls", "gopls", ["go"], ["go"]],
  ["jdtls", "Eclipse JDT Language Server", ["java"], ["java"]],
  ["clangd", "clangd", ["c", "cpp"], ["c", "h", "cpp", "hpp"]],
];
export const LSP_PLUGIN_CATALOG: LspPluginManifest[] = PLUGINS.map(([id, name, languages, extensions]) => ({ id, version: "1.0.0", name, publisher: "Simpl SSH Official", description: id === "jdtls" ? "标准 Java LSP；使用系统 PATH 中的 jdtls 命令，需要 Java/JAVA_HOME。" : `标准 LSP 服务：${languages.join(", ")}`, languages: languages.map((language) => ({ id: language, extensions, lspId: language })), rootMarkers: [".git"], capabilities: ["diagnostics", "completion", "hover", "semanticTokens"], runtimes: {} }));

export function pluginForLanguage(language: string, installed: InstalledLspPlugin[], overrides?: LanguageServerPluginOverride[]) {
  return LSP_PLUGIN_CATALOG.filter((plugin) => plugin.languages.some((item) => item.id === language) && installed.some((item) => { const override = overrides?.find((candidate) => candidate.pluginId === plugin.id); return item.pluginId === plugin.id && item.version === (override?.version ?? plugin.version) && item.enabled && override?.enabled !== false; })).sort((a, b) => (installed.find((item) => item.pluginId === b.id)?.priority ?? 0) - (installed.find((item) => item.pluginId === a.id)?.priority ?? 0))[0];
}
