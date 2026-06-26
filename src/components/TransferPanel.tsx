import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { TransferKind, TransferStatus, TransferTask } from "../types";

/**
 * 全局传输队列面板：底部抽屉，列出所有 SFTP 传输任务（排队/进行/完成/失败/取消），
 * 进行中可取消。状态来自后端 `transfer://state` 事件 + 轮询 `transfer_list`，
 * 进度来自 `transfer://progress`（按 task_id 更新）。
 */
export function TransferPanel() {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<TransferTask[]>([]);

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
            <button className="icon-btn" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>
          <div className="transfer-list">
            {tasks.length === 0 ? (
              <div className="transfer-empty">暂无传输任务</div>
            ) : (
              tasks.map((t) => {
                const live = t.status === "queued" || t.status === "running";
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
                        <button
                          className="icon-btn danger"
                          title="取消"
                          onClick={() => cancel(t.id)}
                        >
                          <X size={13} />
                        </button>
                      </>
                    ) : t.status === "failed" ? (
                      <span className="transfer-error" title={t.error || ""}>
                        {t.error}
                      </span>
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
      done: "完成",
      failed: "失败",
      cancelled: "已取消",
    }[s] ?? s
  );
}
