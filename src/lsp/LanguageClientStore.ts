import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { LanguageServerConfig, LspPluginManifest } from "../settings/types";
import { normalizeLspLocations, type LspLocation, type LspPosition } from "./navigation";
import type { LspTextEdit } from "./textEdits";

export type LspRuntimeStatus = "starting" | "ready" | "exited" | "crashed" | "disabled" | "unknown";
export type LspDiagnostic = { range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } }; severity?: number; message?: string; source?: string };
export type LspRuntimeState = { serverId: string; root: string; status: LspRuntimeStatus; error?: string };

/** LSP CompletionItem 最小子集，供补全扩展消费。 */
export type LspCompletionItem = {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind?: string; value?: string };
  insertText?: string;
  insertTextFormat?: number;
  filterText?: string;
  sortText?: string;
  textEdit?: { range?: LspDiagnostic["range"]; newText?: string };
};

/** LSP Hover 内容，兼容 MarkupContent / MarkedString / 数组三种形态。 */
export type LspHover = { contents?: string | { language?: string; value?: string } | { kind?: string; value?: string } | Array<string | { language?: string; value?: string }> };

type Listener = () => void;
type DiagnosticEvent = { serverId: string; params?: { uri?: string; diagnostics?: LspDiagnostic[] } };

class LanguageClientStore {
  private states = new Map<string, LspRuntimeState>();
  private diagnostics = new Map<string, LspDiagnostic[]>();
  private documentVersions = new Map<string, number>();
  private subscribers = new Set<Listener>();
  private starts = new Map<string, Promise<void>>();
  private initialized = new Set<string>();
  private capabilities = new Map<string, any>();
  private listenersReady = false;

  constructor() { void this.installListeners(); }

  private emit() { this.subscribers.forEach((listener) => listener()); }
  subscribe(listener: Listener) { this.subscribers.add(listener); return () => this.subscribers.delete(listener); }

  private async installListeners() {
    if (this.listenersReady) return;
    this.listenersReady = true;
    await listen<LspRuntimeState>("lsp://state", ({ payload }) => { this.states.set(payload.serverId, payload); this.emit(); });
    await listen<DiagnosticEvent>("lsp://diagnostics", ({ payload }) => {
      const uri = payload.params?.uri;
      if (!uri) return;
      const incomingVersion = (payload.params as { version?: unknown } | undefined)?.version;
      const versionKey = `${payload.serverId}:${uri}`;
      if (typeof incomingVersion === "number" && (this.documentVersions.get(versionKey) ?? -1) > incomingVersion) return;
      this.diagnostics.set(`${payload.serverId}:${uri}`, payload.params?.diagnostics ?? []);
      this.emit();
    });
  }

  runtimeId(projectId: string, configId: string) { return `${projectId}:${configId}`; }
  state(serverId: string) { return this.states.get(serverId); }
  diagnosticsFor(serverId: string, uri: string) { return this.diagnostics.get(`${serverId}:${uri}`) ?? []; }

  async start(projectId: string, root: string, config: LanguageServerConfig, override?: { enabled?: boolean; args?: string[]; languages?: string[] }) {
    const serverId = this.runtimeId(projectId, config.id);
    if (override?.enabled === false || config.enabled === false) {
      this.states.set(serverId, { serverId, root, status: "disabled" }); this.emit(); return serverId;
    }
    const active = this.starts.get(serverId);
    if (active) { await active; return serverId; }
    const task = (async () => {
      this.states.set(serverId, { serverId, root, status: "starting" }); this.emit();
      try {
        await invoke("lsp_start", { serverId, root, command: config.command, args: override?.args ?? config.args });
        await this.initializeServer(serverId, root);
      } catch (error) {
        this.states.set(serverId, { serverId, root, status: "crashed", error: String(error) }); this.emit();
        throw error;
      } finally { this.starts.delete(serverId); }
    })();
    this.starts.set(serverId, task); await task; return serverId;
  }

  private async initializeServer(serverId: string, root: string) {
    if (this.initialized.has(serverId)) {
      this.states.set(serverId, { serverId, root, status: "ready" }); this.emit();
      return;
    }
    this.states.set(serverId, { serverId, root, status: "starting" }); this.emit();
    const initializeResult = await this.request(serverId, "initialize", { processId: null, rootUri: `file://${encodeURI(root)}`, capabilities: { textDocument: { synchronization: { didSave: true }, completion: {}, hover: {}, publishDiagnostics: {}, semanticTokens: { requests: { range: false, full: true }, tokenTypes: [], tokenModifiers: [], formats: ["relative"] }, documentFormatting: {}, documentRangeFormatting: {}, rename: { prepareSupport: false }, documentSymbol: { hierarchicalDocumentSymbolSupport: true }, signatureHelp: { signatureInformation: { parameterInformation: { labelOffsetSupport: true } } } }, workspace: { symbol: {} } }, initializationOptions: null });
    this.capabilities.set(serverId, initializeResult?.capabilities ?? {});
    await this.notify(serverId, "initialized", {}); this.initialized.add(serverId);
    this.states.set(serverId, { serverId, root, status: "ready" }); this.emit();
  }

  async startPlugin(projectId: string, root: string, plugin: LspPluginManifest, override?: { args?: string[] }) {
    const serverId = this.runtimeId(projectId, plugin.id);
    if (this.states.get(serverId)?.status === "ready") return serverId;
    const active = this.starts.get(serverId);
    if (active) { await active; return serverId; }
    const task = (async () => {
      this.states.set(serverId, { serverId, root, status: "starting" }); this.emit();
      try {
        await invoke("lsp_start_plugin", { projectId, pluginId: plugin.id, version: plugin.version, root, args: override?.args });
        await this.initializeServer(serverId, root);
      } catch (error) {
        this.initialized.delete(serverId);
        this.capabilities.delete(serverId);
        this.states.set(serverId, { serverId, root, status: "crashed", error: String(error) }); this.emit();
        throw error;
      } finally { this.starts.delete(serverId); }
    })();
    this.starts.set(serverId, task); await task; return serverId;
  }

  async stop(serverId: string) { await invoke("lsp_stop", { serverId }).catch(() => undefined); this.initialized.delete(serverId); this.capabilities.delete(serverId); this.states.delete(serverId); this.emit(); }
  async notify(serverId: string, method: string, params: unknown) { await invoke("lsp_notify", { serverId, method, params }); }
  async request(serverId: string, method: string, params: unknown): Promise<any> {
    const response = await invoke<any>("lsp_request", { serverId, method, params });
    if (response && typeof response === "object" && "result" in response) return response.result;
    if (response?.error) throw new Error(response.error.message ?? "LSP 请求失败");
    return response;
  }
  async definition(serverId: string, uri: string, position: LspPosition): Promise<LspLocation[]> {
    if (!this.capabilities.get(serverId)?.definitionProvider) throw new Error("当前语言服务不支持跳转定义");
    return normalizeLspLocations(await this.request(serverId, "textDocument/definition", { textDocument: { uri }, position }));
  }
  async references(serverId: string, uri: string, position: LspPosition, includeDeclaration = true): Promise<LspLocation[]> {
    if (!this.capabilities.get(serverId)?.referencesProvider) throw new Error("当前语言服务不支持查找引用");
    return normalizeLspLocations(await this.request(serverId, "textDocument/references", { textDocument: { uri }, position, context: { includeDeclaration } }));
  }
  async openDocument(projectId: string, root: string, config: LanguageServerConfig, override: any, uri: string, languageId: string, text: string, version: number) {
    const serverId = await this.start(projectId, root, config, override);
    this.documentVersions.set(`${serverId}:${uri}`, version);
    await this.notify(serverId, "textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
    return serverId;
  }
  async openPluginDocument(projectId: string, root: string, plugin: LspPluginManifest, uri: string, languageId: string, text: string, version: number, override?: { args?: string[] }) {
    const serverId = await this.startPlugin(projectId, root, plugin, override);
    this.documentVersions.set(`${serverId}:${uri}`, version);
    await this.notify(serverId, "textDocument/didOpen", { textDocument: { uri, languageId, version, text } }); return serverId;
  }
  async changeDocument(serverId: string, uri: string, text: string, version: number) { this.documentVersions.set(`${serverId}:${uri}`, version); await this.notify(serverId, "textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] }); }
  async saveDocument(serverId: string, uri: string, text: string) { await this.notify(serverId, "textDocument/didSave", { textDocument: { uri }, text }); }
  async closeDocument(serverId: string, uri: string) { this.documentVersions.delete(`${serverId}:${uri}`); await this.notify(serverId, "textDocument/didClose", { textDocument: { uri } }).catch(() => undefined); }
  async semanticTokens(serverId: string, uri: string): Promise<{ data: number[]; tokenTypes: string[] } | null> {
    const provider = this.capabilities.get(serverId)?.semanticTokensProvider;
    if (!provider) return null;
    const result = await this.request(serverId, "textDocument/semanticTokens/full", { textDocument: { uri } });
    if (!Array.isArray(result?.data)) return null;
    const legend = provider.legend?.tokenTypes;
    return { data: result.data.filter((value: unknown): value is number => typeof value === "number"), tokenTypes: Array.isArray(legend) ? legend : [] };
  }
  async completion(serverId: string, uri: string, position: LspPosition): Promise<LspCompletionItem[] | null> {
    if (!this.capabilities.get(serverId)?.completionProvider) return null;
    const result = await this.request(serverId, "textDocument/completion", { textDocument: { uri }, position });
    return Array.isArray(result) ? result : result?.items ?? null;
  }
  async hover(serverId: string, uri: string, position: LspPosition): Promise<LspHover | null> {
    if (!this.capabilities.get(serverId)?.hoverProvider) return null;
    return this.request(serverId, "textDocument/hover", { textDocument: { uri }, position });
  }
  async formatting(serverId: string, uri: string, options: Record<string, unknown>): Promise<LspTextEdit[] | null> {
    if (!this.capabilities.get(serverId)?.documentFormattingProvider) return null;
    const result = await this.request(serverId, "textDocument/formatting", { textDocument: { uri }, options });
    return Array.isArray(result) ? (result as LspTextEdit[]) : null;
  }
  async rename(serverId: string, uri: string, position: LspPosition, newName: string): Promise<unknown> {
    if (!this.capabilities.get(serverId)?.renameProvider) throw new Error("当前语言服务不支持重命名");
    return this.request(serverId, "textDocument/rename", { textDocument: { uri }, position, newName });
  }
  async documentSymbol(serverId: string, uri: string): Promise<unknown> {
    if (!this.capabilities.get(serverId)?.documentSymbolProvider) return null;
    return this.request(serverId, "textDocument/documentSymbol", { textDocument: { uri } });
  }
  async workspaceSymbol(serverId: string, query: string): Promise<unknown> {
    if (!this.capabilities.get(serverId)?.workspaceSymbolProvider) return null;
    return this.request(serverId, "workspace/symbol", { query });
  }
  async signatureHelp(serverId: string, uri: string, position: LspPosition): Promise<unknown> {
    if (!this.capabilities.get(serverId)?.signatureHelpProvider) return null;
    return this.request(serverId, "textDocument/signatureHelp", { textDocument: { uri }, position });
  }
}

export const languageClientStore = new LanguageClientStore();

export function useLanguageClient(serverId?: string, uri?: string) {
  const [, setVersion] = useState(0);
  useEffect(() => { const unsubscribe = languageClientStore.subscribe(() => setVersion((value) => value + 1)); return () => { unsubscribe(); }; }, []);
  return useMemo(() => ({ state: serverId ? languageClientStore.state(serverId) : undefined, diagnostics: serverId && uri ? languageClientStore.diagnosticsFor(serverId, uri) : [], request: (method: string, params: unknown) => serverId ? languageClientStore.request(serverId, method, params) : Promise.reject(new Error("语言服务未启动")), }), [serverId, uri]);
}

export function languageServerMatches(config: LanguageServerConfig, language: string) {
  const values = config.languages.map((value) => value.toLowerCase());
  return values.includes(language.toLowerCase()) || values.includes(language === "javascript" ? "typescript" : language === "typescript" ? "javascript" : language);
}

export function projectLanguageOverride(overrides: Array<{ id: string; enabled?: boolean; args?: string[]; languages?: string[] }> | undefined, id: string) { return overrides?.find((item) => item.id === id); }

export function fileUri(root: string, relativePath: string) { return `file://${encodeURI(`${root.replace(/\\/g, "/")}/${relativePath}`)}`; }

export function useLspRequest(serverId?: string, uri?: string) { return useLanguageClient(serverId, uri); }
