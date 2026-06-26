import { useEffect, useRef, useState } from "react";
import { Check, Palette } from "lucide-react";
import { useTheme } from "../theme/ThemeProvider";

/**
 * 主题选择器：状态栏按钮 + 弹出面板，展示全部可用主题的色块预览。
 */
export function ThemePicker() {
  const { themeId, themes, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  /* 点击外部关闭面板 */
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  /* Esc 关闭 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="theme-picker" ref={panelRef}>
      <button
        className="status-action"
        onClick={() => setOpen((v) => !v)}
        title="切换主题"
        aria-expanded={open}
      >
        <Palette size={13} /> 主题
      </button>

      {open && (
        <div className="theme-panel">
          <div className="theme-panel-head">选择主题（{themes.length}）</div>
          <div className="theme-grid">
            {themes.map((t) => {
              const active = t.id === themeId;
              return (
                <button
                  key={t.id}
                  className={`theme-card ${active ? "active" : ""} ${t.isLight ? "light" : ""}`}
                  onClick={() => {
                    setTheme(t.id);
                    setOpen(false);
                  }}
                  title={t.name}
                >
                  <div className="theme-swatches">
                    <span style={{ background: t.app.bg }} />
                    <span style={{ background: t.app.panel }} />
                    <span style={{ background: t.app.accent }} />
                    <span style={{ background: t.terminal.red ?? "#ff0000" }} />
                    <span style={{ background: t.terminal.green ?? "#00ff00" }} />
                    <span style={{ background: t.terminal.cyan ?? "#00ffff" }} />
                  </div>
                  <span className="theme-card-name">{t.name}</span>
                  {active && (
                    <span className="theme-card-check">
                      <Check size={12} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
