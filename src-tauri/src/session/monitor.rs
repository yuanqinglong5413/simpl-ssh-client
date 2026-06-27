//! 远程系统监控：在已有 SSH 会话上 exec 采集 Linux /proc 指标（轻量、无额外依赖）。

use std::collections::HashMap;

use serde::Serialize;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::timeout;

use super::manager::SessionManager;

/// 磁盘分区用量。
#[derive(Debug, Clone, Serialize)]
pub struct DiskUsage {
    pub mount: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub avail_bytes: u64,
}

/// 一次监控快照（前端轮询展示）。
#[derive(Debug, Clone, Serialize)]
pub struct MonitorSnapshot {
    pub cpu_percent: f32,
    pub mem_total_bytes: u64,
    pub mem_used_bytes: u64,
    pub mem_avail_bytes: u64,
    pub load_1: f32,
    pub load_5: f32,
    pub load_15: f32,
    pub uptime_secs: u64,
    pub disks: Vec<DiskUsage>,
}

/// CPU 采样缓存（两次 /proc/stat 差分算利用率）。
#[derive(Debug, Clone, Copy)]
struct CpuSample {
    total: u64,
    idle: u64,
}

/// 各会话的上次 CPU 采样。
#[derive(Default)]
pub struct MonitorStore {
    cpu_prev: Mutex<HashMap<String, CpuSample>>,
}

impl MonitorStore {
    /// 采集指定会话的监控快照；非 Linux 或命令失败时返回友好错误。
    pub async fn snapshot(
        &self,
        sessions: &SessionManager,
        session_id: &str,
    ) -> Result<MonitorSnapshot, String> {
        let entry = sessions
            .get(session_id)
            .await
            .ok_or_else(|| format!("session not found: {session_id}"))?;

        let script = r#"bash -c '
load=$(awk "{print \$1,\$2,\$3}" /proc/loadavg)
uptime=$(awk "{print int(\$1)}" /proc/uptime)
mem=$(awk "/MemTotal:/ {t=\$2} /MemAvailable:/ {a=\$2} END {print t\" \"t-a\" \"a}" /proc/meminfo)
cpu=$(grep "^cpu " /proc/stat)
echo "LOAD:$load"
echo "UPTIME:$uptime"
echo "MEM:$mem"
echo "CPU:$cpu"
echo "DISK_START"
df -B1 --output=target,size,used,avail -x tmpfs -x devtmpfs -x squashfs 2>/dev/null | tail -n +2
echo "DISK_END"
'"#;

        let output = exec_on_session(&entry.handle, script).await?;
        parse_snapshot(&output, session_id, &self.cpu_prev).await
    }

    pub async fn clear_session(&self, session_id: &str) {
        self.cpu_prev.lock().await.remove(session_id);
    }
}

/// 在会话上执行命令并收集 stdout+stderr 文本。
async fn exec_on_session(
    handle: &std::sync::Arc<russh::client::Handle<super::ClientHandler>>,
    command: &str,
) -> Result<String, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel
        .exec(true, command)
        .await
        .map_err(|e| e.to_string())?;

    let mut out = String::new();
    // 15 秒超时：防止远程命令挂起导致监控面板卡死
    let channel_result = timeout(Duration::from_secs(15), async {
        while let Some(msg) = channel.wait().await {
            use russh::ChannelMsg;
            match msg {
                ChannelMsg::Data { data } => {
                    out.push_str(&String::from_utf8_lossy(&data));
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    out.push_str(&String::from_utf8_lossy(&data));
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    if exit_status != 0 {
                        return Err(format!(
                            "远程监控脚本退出码 {exit_status}（可能非 Linux 主机）"
                        ));
                    }
                }
                ChannelMsg::Eof => break,
                _ => {}
            }
        }
        Ok(())
    })
    .await;

    match channel_result {
        Ok(inner) => inner.map(|_| out),
        Err(_) => Err("监控命令超时（15s），请检查网络连接或主机负载".to_string()),
    }
}

async fn parse_snapshot(
    raw: &str,
    session_id: &str,
    cpu_prev: &Mutex<HashMap<String, CpuSample>>,
) -> Result<MonitorSnapshot, String> {
    let mut load_parts: Option<Vec<f32>> = None;
    let mut uptime_secs = 0u64;
    let mut mem_parts: Option<Vec<u64>> = None;
    let mut cpu_line: Option<String> = None;
    let mut disks = Vec::new();
    let mut in_disk = false;

    for line in raw.lines() {
        let line = line.trim();
        if line.starts_with("LOAD:") {
            load_parts = Some(
                line.trim_start_matches("LOAD:")
                    .split_whitespace()
                    .filter_map(|s| s.parse().ok())
                    .collect(),
            );
        } else if line.starts_with("UPTIME:") {
            uptime_secs = line
                .trim_start_matches("UPTIME:")
                .trim()
                .parse()
                .unwrap_or(0);
        } else if line.starts_with("MEM:") {
            mem_parts = Some(
                line.trim_start_matches("MEM:")
                    .split_whitespace()
                    .filter_map(|s| s.parse().ok())
                    .collect(),
            );
        } else if line.starts_with("CPU:") {
            cpu_line = Some(line.trim_start_matches("CPU:").trim().to_string());
        } else if line == "DISK_START" {
            in_disk = true;
        } else if line == "DISK_END" {
            in_disk = false;
        } else if in_disk && !line.is_empty() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 4 {
                if let (Ok(total), Ok(used), Ok(avail)) = (
                    parts[1].parse::<u64>(),
                    parts[2].parse::<u64>(),
                    parts[3].parse::<u64>(),
                ) {
                    disks.push(DiskUsage {
                        mount: parts[0].to_string(),
                        total_bytes: total,
                        used_bytes: used,
                        avail_bytes: avail,
                    });
                }
            }
        }
    }

    let load = load_parts.unwrap_or_default();
    let mem = mem_parts.unwrap_or_default();
    let cpu_percent = if let Some(ref line) = cpu_line {
        compute_cpu_percent(line, session_id, cpu_prev).await?
    } else {
        0.0
    };

    Ok(MonitorSnapshot {
        cpu_percent,
        mem_total_bytes: *mem.first().unwrap_or(&0),
        mem_used_bytes: mem.get(1).copied().unwrap_or(0),
        mem_avail_bytes: mem.get(2).copied().unwrap_or(0),
        load_1: *load.first().unwrap_or(&0.0),
        load_5: *load.get(1).unwrap_or(&0.0),
        load_15: *load.get(2).unwrap_or(&0.0),
        uptime_secs,
        disks,
    })
}

async fn compute_cpu_percent(
    cpu_line: &str,
    session_id: &str,
    cpu_prev: &Mutex<HashMap<String, CpuSample>>,
) -> Result<f32, String> {
    let parts: Vec<u64> = cpu_line
        .split_whitespace()
        .skip(1)
        .filter_map(|s| s.parse().ok())
        .collect();
    if parts.len() < 4 {
        return Ok(0.0);
    }
    let idle = parts[3] + parts.get(4).copied().unwrap_or(0);
    let total: u64 = parts.iter().sum();
    let sample = CpuSample { total, idle };

    let mut guard = cpu_prev.lock().await;
    let pct = if let Some(prev) = guard.get(session_id) {
        let dt = sample.total.saturating_sub(prev.total);
        let di = sample.idle.saturating_sub(prev.idle);
        if dt == 0 {
            0.0
        } else {
            ((dt - di) as f32 / dt as f32 * 100.0).clamp(0.0, 100.0)
        }
    } else {
        0.0
    };
    guard.insert(session_id.to_string(), sample);
    Ok(pct)
}
