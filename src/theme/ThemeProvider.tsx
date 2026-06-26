import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ITheme } from "@xterm/xterm";
import { DEFAULT_THEME_ID, getTheme, themes, THEME_STORAGE_KEY } from "../themes";
import type { AppTheme } from "../themes/types";

interface ThemeContextValue {
  /** 当前主题 id */
  themeId: string;
  /** 当前完整主题对象 */
  theme: AppTheme;
  /** 切换主题并持久化 */
  setTheme: (id: string) => void;
  /** 所有可用主题列表 */
  themes: AppTheme[];
  /** xterm 终端配色（含 16 色 ANSI） */
  terminalTheme: ITheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** 将 AppThemeVars 写入 document 根节点的 CSS 变量 */
function applyAppTheme(theme: AppTheme) {
  const root = document.documentElement;
  const v = theme.app;

  root.dataset.theme = theme.id;
  root.style.setProperty("--bg", v.bg);
  root.style.setProperty("--panel", v.panel);
  root.style.setProperty("--panel-2", v.panel2);
  root.style.setProperty("--panel-3", v.panel3);
  root.style.setProperty("--border", v.border);
  root.style.setProperty("--border-soft", v.borderSoft);
  root.style.setProperty("--text", v.text);
  root.style.setProperty("--text-dim", v.textDim);
  root.style.setProperty("--muted", v.muted);
  root.style.setProperty("--accent", v.accent);
  root.style.setProperty("--accent-hover", v.accentHover);
  root.style.setProperty("--accent-soft", v.accentSoft);
  root.style.setProperty("--green", v.green);
  root.style.setProperty("--green-soft", v.greenSoft);
  root.style.setProperty("--red", v.red);
  root.style.setProperty("--red-soft", v.redSoft);
  root.style.setProperty("--scrollbar-hover", v.scrollbarHover);
  root.style.setProperty("--overlay-bg", v.overlayBg);
  root.style.setProperty("--brand-mark-fg", v.brandMarkFg);
  root.style.setProperty("--btn-primary-fg", v.btnPrimaryFg);
  /* 兼容 HostKeyDialog 中使用的 --fg */
  root.style.setProperty("--fg", v.text);
}

/** 从 localStorage 读取已保存的主题 id */
function loadSavedThemeId(): string {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved && themes.some((t) => t.id === saved)) return saved;
  } catch {
    /* 隐私模式等场景下 localStorage 不可用 */
  }
  return DEFAULT_THEME_ID;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeId] = useState(loadSavedThemeId);
  const theme = useMemo(() => getTheme(themeId), [themeId]);

  useEffect(() => {
    applyAppTheme(theme);
  }, [theme]);

  const setTheme = useCallback((id: string) => {
    const next = getTheme(id);
    setThemeId(next.id);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next.id);
    } catch {
      /* 忽略存储失败 */
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeId,
      theme,
      setTheme,
      themes,
      terminalTheme: theme.terminal,
    }),
    [themeId, theme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** 获取当前主题上下文 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return ctx;
}
