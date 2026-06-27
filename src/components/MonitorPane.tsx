import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { MonitorSnapshot } from "../types";

type Props = {
  sessionId: string;
};

/** 格式化字节为人类可读单位 */
function formatBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/** 格式化 uptime 秒数 */
function formatUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

function MetricBar({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className="monitor-metric">
      <div className="monitor-metric-head">
        <span>{label}</span>
        <span className="monitor-metric-val">{detail}</span>
      </div>
      <div className="monitor-bar-track">
        <div
          className="monitor-bar-fill"
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
    </div>
  );
}

/**
 * 系统监控面板：轮询远程 Linux /proc 指标（CPU/内存/负载/磁盘）。
 * 复用已有 SSH 会话，不额外建连。
 */
export function MonitorPane({ sessionId }: Props) {
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await invoke<MonitorSnapshot>("monitor_snapshot", {
        sessionId,
      });
      setSnap(data);
      setError("");
      setLastUpdated(Date.now());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await refresh();
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refresh]);

  const memPct =
    snap && snap.mem_total_bytes > 0
      ? (snap.mem_used_bytes / snap.mem_total_bytes) * 100
      : 0;

  return (
    <div className="monitor-pane">
      <div className="monitor-head">
        <div className="monitor-title">
          <Activity size={16} /> 系统监控
        </div>
        <button
          className="btn btn-ghost monitor-refresh"
          onClick={() => refresh()}
          title="立即刷新"
        >
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      {loading && !snap && !error && (
        <div className="monitor-loading">
          <div className="conn-spinner" />
          <span>正在采集指标…</span>
        </div>
      )}

      {error && <div className="monitor-error">{error}</div>}

      {snap && (
        <div className="monitor-grid">
          <MetricBar
            label="CPU"
            value={snap.cpu_percent}
            detail={`${snap.cpu_percent.toFixed(1)}%`}
          />
          <MetricBar
            label="内存"
            value={memPct}
            detail={`${formatBytes(snap.mem_used_bytes)} / ${formatBytes(snap.mem_total_bytes)}`}
          />
          <div className="monitor-stat-row">
            <div className="monitor-stat">
              <span className="monitor-stat-label">负载 (1/5/15)</span>
              <span className="monitor-stat-value">
                {snap.load_1.toFixed(2)} / {snap.load_5.toFixed(2)} /{" "}
                {snap.load_15.toFixed(2)}
              </span>
            </div>
            <div className="monitor-stat">
              <span className="monitor-stat-label">运行时间</span>
              <span className="monitor-stat-value">
                {formatUptime(snap.uptime_secs)}
              </span>
            </div>
            <div className="monitor-stat">
              <span className="monitor-stat-label">可用内存</span>
              <span className="monitor-stat-value">
                {formatBytes(snap.mem_avail_bytes)}
              </span>
            </div>
          </div>

          {snap.disks.length > 0 && (
            <section className="monitor-disks">
              <h3 className="monitor-section-title">磁盘</h3>
              {snap.disks.map((d) => {
                const pct =
                  d.total_bytes > 0
                    ? (d.used_bytes / d.total_bytes) * 100
                    : 0;
                return (
                  <MetricBar
                    key={d.mount}
                    label={d.mount}
                    value={pct}
                    detail={`${formatBytes(d.used_bytes)} / ${formatBytes(d.total_bytes)} (${pct.toFixed(0)}%)`}
                  />
                );
              })}
            </section>
          )}
        </div>
      )}

      <p className="monitor-hint">
        基于 Linux /proc 与 df 采集；首次 CPU 采样需等待下一轮刷新。
        {lastUpdated && (
          <span className="monitor-updated">
            {" "}· 上次更新 {new Date(lastUpdated).toLocaleTimeString()}
          </span>
        )}
      </p>
    </div>
  );
}
