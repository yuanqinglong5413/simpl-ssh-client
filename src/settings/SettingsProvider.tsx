import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
} from "./types";

interface SettingsContextValue {
  settings: AppSettings;
  /** 更新部分设置并持久化 */
  updateSettings: (patch: Partial<AppSettings>) => void;
  /** 恢复默认 */
  resetSettings: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<AppSettings> & { agentPresets?: Array<Record<string, unknown>>; languageServers?: Array<Record<string, unknown>>; installedLspPlugins?: Array<Record<string, unknown>> };
      const agentPresets = Array.isArray(saved.agentPresets)
        ? saved.agentPresets.flatMap((preset) => {
            const id = typeof preset.id === "string" ? preset.id.trim() : "";
            const name = typeof preset.name === "string" ? preset.name.trim() : "";
            const command = typeof preset.command === "string" ? preset.command.trim() : "";
            return id && name && command ? [{ id, name, command }] : [];
          })
        : DEFAULT_SETTINGS.agentPresets;
      const rawServers = Array.isArray(saved.languageServers) ? saved.languageServers : saved.customServers;
      const languageServers = Array.isArray(rawServers)
        ? rawServers.flatMap((server) => {
            const id = typeof server.id === "string" ? server.id.trim() : "";
            const name = typeof server.name === "string" ? server.name.trim() : id;
            const command = typeof server.command === "string" ? server.command.trim() : "";
            const languages = Array.isArray(server.languages) ? server.languages.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()) : [];
            const args = Array.isArray(server.args) ? server.args.filter((value): value is string => typeof value === "string") : [];
            const rootMarkers = Array.isArray(server.rootMarkers) ? server.rootMarkers.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()) : [];
            return id && name && command && languages.length ? [{ id, name, command, languages, args, enabled: server.enabled !== false, rootMarkers }] : [];
          })
        : DEFAULT_SETTINGS.languageServers;
      const installedLspPlugins = Array.isArray(saved.installedLspPlugins) ? saved.installedLspPlugins.flatMap((item) => {
        const value = item as Record<string, unknown>;
        const source: "managed" | "custom" | "system-detected" | undefined = value.source === "managed" || value.source === "bundled" ? "managed" : value.source === "custom" ? "custom" : value.source === "system" || value.source === "managed-system" || value.source === "system-detected" ? "system-detected" : undefined;
        return typeof value.pluginId === "string" && typeof value.version === "string" ? [{ pluginId: value.pluginId, version: value.version, enabled: value.enabled !== false, priority: typeof value.priority === "number" ? value.priority : 0, ...(source ? { source } : {}) }] : [];
      }) : DEFAULT_SETTINGS.installedLspPlugins;
      const languageHighlighting = saved.languageHighlighting && typeof saved.languageHighlighting === "object"
        ? Object.fromEntries(Object.entries(saved.languageHighlighting).filter(([, value]) => typeof value === "boolean"))
        : DEFAULT_SETTINGS.languageHighlighting;
      return { ...DEFAULT_SETTINGS, ...saved, agentPresets, languageServers, customServers: languageServers, installedLspPlugins, languageHighlighting, lspUpdateChannel: "stable" as const };
    }
  } catch {
    /* 忽略损坏数据 */
  }
  return DEFAULT_SETTINGS;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  const persist = useCallback((next: AppSettings) => {
    setSettings(next);
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* 忽略 */
    }
  }, []);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* 忽略 */
      }
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    persist(DEFAULT_SETTINGS);
  }, [persist]);

  const value = useMemo(
    () => ({ settings, updateSettings, resetSettings }),
    [settings, updateSettings, resetSettings]
  );

  return (
    <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings 必须在 SettingsProvider 内使用");
  return ctx;
}
