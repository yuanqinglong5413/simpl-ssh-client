export type WorkspaceTask = {
  id: string;
  label: string;
  command: string;
  group?: "build" | "test" | "run" | "custom";
};

export type LanguageServerOverride = {
  id: string;
  /** Legacy workspace files may contain a command; new files keep commands in local settings. */
  command?: string;
  args?: string[];
  enabled?: boolean;
  languages: string[];
};
export type LanguageServerPluginOverride = { pluginId: string; enabled?: boolean; version?: string; args?: string[]; languages?: string[] };

export type WorkspaceConfig = {
  version: 1;
  tasks: WorkspaceTask[];
  languageServers?: LanguageServerOverride[];
  lspPlugins?: LanguageServerPluginOverride[];
  exclude?: string[];
};

export const EMPTY_WORKSPACE_CONFIG: WorkspaceConfig = { version: 1, tasks: [] };

/** 工作区文件是可提交的非敏感元数据；损坏时不阻止项目打开。 */
export function parseWorkspaceConfig(raw: string): WorkspaceConfig {
  const value = JSON.parse(raw) as Partial<WorkspaceConfig>;
  const tasks = Array.isArray(value.tasks) ? value.tasks.flatMap((item) => {
    const candidate = item as Partial<WorkspaceTask>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
    const command = typeof candidate.command === "string" ? candidate.command.trim() : undefined;
    return id && label && command ? [{ id, label, command, group: candidate.group }] : [];
  }) : [];
  const languageServers = Array.isArray(value.languageServers) ? value.languageServers.flatMap((item) => {
    const candidate = item as Partial<LanguageServerOverride>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const command = typeof candidate.command === "string" ? candidate.command.trim() : "";
    const languages = Array.isArray(candidate.languages) ? candidate.languages.filter((language): language is string => typeof language === "string" && language.trim().length > 0) : [];
    if (!id || !languages.length) return [];
    const enabled = typeof candidate.enabled === "boolean" ? { enabled: candidate.enabled } : {};
    const args = Array.isArray(candidate.args) ? candidate.args.filter((arg): arg is string => typeof arg === "string") : undefined;
    return [{ id, ...(command ? { command } : {}), languages, ...enabled, args }];
  }) : undefined;
  const lspPlugins = Array.isArray((value as Partial<WorkspaceConfig>).lspPlugins) ? (value as Partial<WorkspaceConfig>).lspPlugins?.flatMap((item) => {
    const candidate = item as LanguageServerPluginOverride;
    return typeof candidate.pluginId === "string" && candidate.pluginId.trim() ? [{ pluginId: candidate.pluginId.trim(), ...(typeof candidate.enabled === "boolean" ? { enabled: candidate.enabled } : {}), ...(typeof candidate.version === "string" && candidate.version.trim() ? { version: candidate.version.trim() } : {}), ...(Array.isArray(candidate.args) ? { args: candidate.args.filter((arg): arg is string => typeof arg === "string") } : {}), ...(Array.isArray(candidate.languages) ? { languages: candidate.languages.filter((language): language is string => typeof language === "string") } : {}) }] : [];
  }) : undefined;
  return { version: 1, tasks, languageServers, lspPlugins, exclude: Array.isArray(value.exclude) ? value.exclude.filter((entry): entry is string => typeof entry === "string") : undefined };
}

export function serializeWorkspaceConfig(config: WorkspaceConfig): string {
  // Preserve the legacy command field when an older workspace contained it so
  // loading and saving does not silently rewrite user data. New project
  // overrides created by the UI never set this field.
  const languageServers = config.languageServers?.map(({ id, command, args, enabled, languages }) => ({ id, ...(command ? { command } : {}), args, enabled, languages }));
  return `${JSON.stringify({ version: 1, tasks: config.tasks, languageServers, lspPlugins: config.lspPlugins, exclude: config.exclude }, null, 2)}\n`;
}
