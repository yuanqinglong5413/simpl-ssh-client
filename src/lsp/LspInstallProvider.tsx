import { listen } from "@tauri-apps/api/event";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { LspInstallProgress } from "../settings/types";

type LspInstallContextValue = {
  progress: Record<string, LspInstallProgress>;
  clear: (pluginId: string) => void;
};

const LspInstallContext = createContext<LspInstallContextValue | null>(null);

/** 应用级托管 LSP 安装状态；目录标签关闭或切换后进度仍持续更新。 */
export function LspInstallProvider({ children }: { children: ReactNode }) {
  const [progress, setProgress] = useState<Record<string, LspInstallProgress>>({});
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<LspInstallProgress>("lsp-plugin://download", (event) => {
      if (!disposed) setProgress((current) => ({ ...current, [event.payload.pluginId]: event.payload }));
    }).then((cleanup) => { if (disposed) cleanup(); else unlisten = cleanup; });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const value = useMemo(() => ({ progress, clear: (pluginId: string) => setProgress((current) => { const next = { ...current }; delete next[pluginId]; return next; }) }), [progress]);
  return <LspInstallContext.Provider value={value}>{children}</LspInstallContext.Provider>;
}

export function useLspInstallProgress() {
  const context = useContext(LspInstallContext);
  if (!context) throw new Error("useLspInstallProgress 必须在 LspInstallProvider 中使用");
  return context;
}
