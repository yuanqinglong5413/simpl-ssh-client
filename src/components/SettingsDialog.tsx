import { useEffect, useRef } from "react";
import { RotateCcw, Settings, X } from "lucide-react";
import { FONT_OPTIONS } from "../settings/types";
import { useSettings } from "../settings/SettingsProvider";

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * 设置面板：终端字体/光标选项 + 断线重连策略。
 */
export function SettingsDialog({ open, onClose }: Props) {
  const { settings, updateSettings, resetSettings } = useSettings();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="overlay settings-overlay" onClick={onClose}>
      <div
        className="dialog settings-dialog"
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <div className="dialog-title">
            <Settings size={16} /> 设置
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="dialog-body settings-body">
          <section className="settings-section">
            <h3 className="settings-section-title">终端</h3>
            <div className="field">
              <label>字体</label>
              <select
                value={settings.fontFamily}
                onChange={(e) => updateSettings({ fontFamily: e.target.value })}
              >
                {FONT_OPTIONS.map((f) => (
                  <option key={f.id} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="row-2">
              <div className="field">
                <label>字号 ({settings.fontSize}px)</label>
                <input
                  type="range"
                  min={10}
                  max={22}
                  step={1}
                  value={settings.fontSize}
                  onChange={(e) =>
                    updateSettings({ fontSize: Number(e.target.value) })
                  }
                />
              </div>
              <div className="field">
                <label>行高 ({settings.lineHeight.toFixed(1)})</label>
                <input
                  type="range"
                  min={1}
                  max={2}
                  step={0.1}
                  value={settings.lineHeight}
                  onChange={(e) =>
                    updateSettings({ lineHeight: Number(e.target.value) })
                  }
                />
              </div>
            </div>
            <div className="row-2">
              <div className="field">
                <label>光标样式</label>
                <select
                  value={settings.cursorStyle}
                  onChange={(e) =>
                    updateSettings({
                      cursorStyle: e.target.value as typeof settings.cursorStyle,
                    })
                  }
                >
                  <option value="bar">竖线 (bar)</option>
                  <option value="block">方块 (block)</option>
                  <option value="underline">下划线 (underline)</option>
                </select>
              </div>
              <div className="field">
                <label>&nbsp;</label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={settings.cursorBlink}
                    onChange={(e) =>
                      updateSettings({ cursorBlink: e.target.checked })
                    }
                  />
                  光标闪烁
                </label>
              </div>
            </div>
            <div
              className="settings-preview"
              style={{
                fontFamily: settings.fontFamily,
                fontSize: settings.fontSize,
                lineHeight: settings.lineHeight,
              }}
            >
              <span className="settings-preview-prompt">$ </span>
              echo "Hello, simpl-ssh!"
            </div>
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">连接</h3>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.autoReconnect}
                onChange={(e) =>
                  updateSettings({ autoReconnect: e.target.checked })
                }
              />
              断线后自动重连（需通过已保存连接建立）
            </label>
            <div className="field">
              <label>最大重连次数 ({settings.maxReconnectAttempts})</label>
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={settings.maxReconnectAttempts}
                disabled={!settings.autoReconnect}
                onChange={(e) =>
                  updateSettings({
                    maxReconnectAttempts: Number(e.target.value),
                  })
                }
              />
            </div>
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">快捷键</h3>
            <dl className="shortcut-list">
              <div>
                <dt>Ctrl+N</dt>
                <dd>新建连接</dd>
              </div>
              <div>
                <dt>Ctrl+W</dt>
                <dd>关闭当前 Tab</dd>
              </div>
              <div>
                <dt>Ctrl+Tab</dt>
                <dd>下一个 Tab</dd>
              </div>
              <div>
                <dt>Ctrl+,</dt>
                <dd>打开设置</dd>
              </div>
              <div>
                <dt>Ctrl+F</dt>
                <dd>终端内搜索（焦点在终端时）</dd>
              </div>
            </dl>
          </section>
        </div>

        <div className="dialog-foot">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => resetSettings()}
          >
            <RotateCcw size={14} /> 恢复默认
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
