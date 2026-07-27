import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronUp, Pause, Play, RotateCw, Trash2, X } from "lucide-react";
import type { TransferKind, TransferStatus, TransferTask } from "../types";

/**
 * 全局传输队列面板：底部抽屉，列出所有 SFTP 传输任务（排队/进行/完成/失败/取消），
 * 进行中可取消。状态来自后端 `transfer://state` 事件 + 轮询 `transfer_list`，
 * 进度来自 `transfer://progress`（按 task_id 更新）。
 */
export function TransferPanel() {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<TransferTask[]>([]);
  const [speedMap, setSpeedMap] = useState<Record<string, number>>({});
  const [concurrency, setConcurrency] = useState(2);
  const speedRef = useRef<
    Record<string, { last_t: number; last_bytes: number; ema: number }>
  >({});

  useEffect(() => {
    let un1: (() => void) | undefined;
    let un2: (() => void) | undefined;
    const refresh = () => {
      invoke<TransferTask[]>("transfer_list")
        .then(setTasks)
        .catch(() => {});
    };
    refresh();
    const iv = setInterval(refresh, 1500);
    listen<TransferTask>("transfer://state", (e) => {
      setTasks((prev) => upsert(prev, e.payload));
    }).then((fn) => (un1 = fn));
    listen<{ task_id: string; transferred: number; total: number }>(
      "transfer://progress",
      (e) => {
        // EMA 滑动窗口算速度（B/s），alpha=1-exp(-dt)
        const now = Date.now();
        const s = speedRef.current[e.payload.task_id] ?? {
          last_t: now,
          last_bytes: 0,
          ema: 0,
        };
        const dt = Math.max(0.001, (now - s.last_t) / 1000);
        const db = e.payload.transferred - s.last_bytes;
        if (db > 0) {
          const inst = db / dt;
          const alpha = 1 - Math.exp(-dt);
          s.ema = alpha * inst + (1 - alpha) * s.ema;
        }
        s.last_t = now;
        s.last_bytes = e.payload.transferred;
        speedRef.current[e.payload.task_id] = s;
        const ema = s.ema;
        setSpeedMap((m) => ({ ...m, [e.payload.task_id]: ema }));
        setTasks((prev) =>
          prev.map((t) =>
            t.id === e.payload.task_id
              ? {
                  ...t,
                  transferred: e.payload.transferred,
                  total: e.payload.total,
                }
              : t
          )
        );
      }
    ).then((fn) => (un2 = fn));
    return () => {
      clearInterval(iv);
      un1?.();
      un2?.();
    };
  }, []);

  const active = tasks.filter(
    (t) => t.status === "queued" || t.status === "running"
  ).length;

  async function cancel(id: string) {
    try {
      await invoke("transfer_cancel", { id });
    } catch {
      /* ignore */
    }
  }
  async function pause(id: string) {
    try {
      await invoke("transfer_pause", { id });
    } catch {
      /* ignore */
    }
  }
  async function resume(id: string) {
    try {
      await invoke("transfer_resume", { id });
    } catch {
      /* ignore */
    }
  }
  async function retry(id: string) {
    try {
      await invoke("transfer_retry", { id });
    } catch {
      /* ignore */
    }
  }
  async function clearDone() {
    try {
      await invoke("transfer_clear_done");
      // 后端清理后，下一次 state 事件/轮询会同步；主动刷新一次
      invoke<TransferTask[]>("transfer_list").then(setTasks).catch(() => {});
    } catch {
      /* ignore */
    }
  }
  async function setConc(n: number) {
    const v = Math.max(1, Math.min(8, n));
    try {
      const actual = await invoke<number>("transfer_set_concurrency", { n: v });
      setConcurrency(actual);
    } catch {
      /* ignore */
    }
  }

  // 无任务且未展开：不显示入口，避免常驻按钮
  if (tasks.length === 0 && !open) return null;

  return (
    <>
      <button className="transfer-fab" onClick={() => setOpen((o) => !o)}>
        传输{active > 0 ? ` (${active})` : ""}
        {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
      {open && (
        <div className="transfer-panel">
          <div className="transfer-head">
            <span>传输队列（{tasks.length}）</span>
            <label className="transfer-concurrency" title="并发传输数（1-8）">
              并发
              <input
                type="number"
                min={1}
                max={8}
                value={concurrency}
                onChange={(e) => setConc(Number(e.target.value) || 1)}
              />
            </label>
            <button className="icon-btn" title="清空已完成" onClick={() => clearDone()}>
              <Trash2 size={14} />
            </button>
            <button className="icon-btn" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>
          <div className="transfer-list">
            {tasks.length === 0 ? (
              <div className="transfer-empty">暂无传输任务</div>
            ) : (
              tasks.map((t) => {
                const live =
                  t.status === "queued" ||
                  t.status === "running" ||
                  t.status === "paused";
                return (
                  <div key={t.id} className="transfer-row">
                    <div className="transfer-info">
                      <span className="transfer-kind">
                        {kindLabel(t.kind)}
                      </span>
                      <span className="transfer-name" title={t.name}>
                        {t.name}
                      </span>
                      <span className={`transfer-status st-${t.status}`}>
                        {statusLabel(t.status)}
                      </span>
                    </div>
                    {live ? (
                      <>
                        <div className="bar">
                          <div style={{ width: `${pct(t)}%` }} />
                        </div>
                        <span className="transfer-speed">
                          {t.status === "running" && speedMap[t.id]
                            ? `${fmtSpeed(speedMap[t.id])}${
                                t.total > 0
                                  ? ` · ${fmtEta((t.total - t.transferred) / speedMap[t.id])}`
                                  : ""
                              }`
                            : pct(t) > 0
                            ? `${pct(t)}%`
                            : ""}
                        </span>
                        {(t.status === "queued" || t.status === "running") && (
                          <button
                            className="icon-btn"
                            title="暂停"
                            onClick={() => pause(t.id)}
                          >
                            <Pause size={13} />
                          </button>
                        )}
                        {t.status === "paused" && (
                          <button
                            className="icon-btn"
                            title="继续"
                            onClick={() => resume(t.id)}
                          >
                            <Play size={13} />
                          </button>
                        )}
                        <button
                          className="icon-btn danger"
                          title="取消"
                          onClick={() => cancel(t.id)}
                        >
                          <X size={13} />
                        </button>
                      </>
                    ) : t.status === "failed" || t.status === "cancelled" ? (
                      <>
                        <span className="transfer-error" title={t.error || ""}>
                          {t.status === "failed" ? t.error : "已取消"}
                        </span>
                        <button
                          className="icon-btn"
                          title="重试"
                          onClick={() => retry(t.id)}
                        >
                          <RotateCw size={13} />
                        </button>
                      </>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </>
  );
}

function upsert(list: TransferTask[], t: TransferTask): TransferTask[] {
  const i = list.findIndex((x) => x.id === t.id);
  if (i >= 0) {
    const next = [...list];
    next[i] = t;
    return next;
  }
  return [...list, t];
}

function pct(t: TransferTask): number {
  return t.total > 0
    ? Math.min(100, Math.round((t.transferred / t.total) * 100))
    : 0;
}

function kindLabel(k: TransferKind): string {
  return k === "upload"
    ? "↑ 上传"
    : k === "uploadDir"
    ? "↑ 目录"
    : k === "download"
    ? "↓ 下载"
    : k;
}

function statusLabel(s: TransferStatus): string {
  return (
    {
      queued: "排队",
      running: "进行中",
      paused: "已暂停",
      done: "完成",
      failed: "失败",
      cancelled: "已取消",
    }[s] ?? s
  );
}

function fmtSpeed(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
}

function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "";
  if (sec < 60) return `${sec.toFixed(0)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${Math.floor(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}
