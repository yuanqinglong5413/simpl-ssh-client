import { useMemo } from "react";
import { Activity, ArrowDownToLine, CircleAlert, GitPullRequestArrow, ListTodo, X, XCircle } from "lucide-react";
import type { ConnectionEnvironment, SessionInfo } from "../types";
import { TransferPanel } from "./TransferPanel";
import { ForwardPanel } from "./ForwardPanel";
import { MonitorPane } from "./MonitorPane";
import { useTasks } from "../tasks/TaskProvider";
import { summarizeTransferTasks } from "../tasks/taskSummary";
import { useActivity } from "../activity/ActivityProvider";
import { useDialogFocus } from "../hooks/useDialogFocus";

export type TaskSection = "activity" | "transfers" | "forwards" | "monitor";

type Props = {
  open: boolean;
  section: TaskSection;
  session: SessionInfo | null;
  onSectionChange: (section: TaskSection) => void;
  onClose: () => void;
  onOpenConnections?: () => void;
  environments?: Record<string, ConnectionEnvironment | null | undefined>;
};

/** 任务抽屉将后台工作统一在同一个、不会遮挡终端的上下文中。 */
export function TaskDrawer({ open, section, session, onSectionChange, onClose, onOpenConnections, environments }: Props) {
  const { tasks, error: taskError, batchJobs, batchError, cancelBatch, retryBatch } = useTasks();
  const { items: activities, dismiss: dismissActivity, clear: clearActivities } = useActivity();
  const drawerFocusRef = useDialogFocus(open, onClose);

  const summary = useMemo(() => summarizeTransferTasks(tasks), [tasks]);
  const activeBatches = batchJobs.filter((job) => ["queued", "running", "cancelling"].includes(job.status));
  const failedBatches = batchJobs.filter((job) => ["partial", "failed", "cancelled"].includes(job.status));
  const activeCount = summary.active + activeBatches.length;
  const failedCount = summary.failed + failedBatches.length;
  const tabs: { id: TaskSection; label: string; icon: typeof ListTodo }[] = [
    { id: "activity", label: "活动", icon: ListTodo },
    { id: "transfers", label: "传输", icon: ArrowDownToLine },
    { id: "forwards", label: "转发", icon: GitPullRequestArrow },
    { id: "monitor", label: "监控", icon: Activity },
  ];

  return (
    <>
      {open && <button type="button" className="task-drawer-scrim" aria-label="关闭任务抽屉" onClick={onClose} />}
      <aside className={`task-drawer ${open ? "open" : ""}`} aria-label="任务抽屉" aria-hidden={!open} inert={!open}>
      <div ref={drawerFocusRef} className="task-drawer-focus-root">
      <header className="task-drawer-head">
        <div><strong>任务</strong><span className="task-drawer-summary">{activeCount ? `${activeCount} 进行中` : "空闲"}{failedCount ? ` · ${failedCount} 失败` : ""}</span></div>
        <button className="icon-btn" onClick={onClose} aria-label="关闭任务抽屉" title="关闭任务抽屉"><X size={16} /></button>
      </header>
      <div className="task-drawer-tabs" role="tablist" aria-label="任务类别">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" aria-selected={section === id} className={section === id ? "active" : ""} onClick={() => onSectionChange(id)}>
            <Icon size={14} /> {label}{id === "transfers" && summary.active > 0 ? <span className="task-count">{summary.active}</span> : null}
          </button>
        ))}
      </div>
      <div className="task-drawer-body">
        {section === "activity" && (
          <div className="task-activity">
            {taskError && <div className="task-alert task-alert-error"><CircleAlert size={15} /> {taskError}</div>}
            {batchError && <div className="task-alert task-alert-error"><CircleAlert size={15} /> {batchError}</div>}
            <div className="task-activity-card"><ListTodo size={16} /><div><strong>{activeCount} 个后台任务</strong><span>传输和项目文件操作会在后台继续，失败项会保留以便重试。</span></div></div>
            {batchJobs.length > 0 && <div className="task-batch-list"><header><strong>项目文件操作</strong><span>{activeBatches.length ? `${activeBatches.length} 进行中` : "最近 20 条"}</span></header>{batchJobs.slice().reverse().map((job) => <div key={job.id} className="task-batch-row"><div><strong>{batchOperationLabel(job.operation)}</strong><span>{job.current_path || `${job.completed + job.failed + job.skipped} / ${job.total}`}</span></div><small>{batchStatusLabel(job.status)}</small>{["queued", "running", "cancelling"].includes(job.status) ? <button className="text-btn" onClick={() => void cancelBatch(job.id)}>取消</button> : job.failed > 0 ? <button className="text-btn" onClick={() => void retryBatch(job)}>重试失败项</button> : null}</div>)}</div>}
            {activities.length > 0 && <div className="task-activity-timeline"><header><strong>需要处理</strong><button className="text-btn" onClick={clearActivities}>清空</button></header>{activities.map((item) => <div key={item.id} className={`activity-item severity-${item.severity}`}><span className="activity-dot" /><div><strong>{item.title}</strong>{item.detail && <span>{item.detail}</span>}<small>{new Date(item.createdAt).toLocaleTimeString()}</small><div className="activity-item-actions">{item.kind === "transfer" && <button className="text-btn" onClick={() => onSectionChange("transfers")}>查看传输</button>}{item.kind === "connection" && onOpenConnections && <button className="text-btn" onClick={onOpenConnections}>打开连接列表</button>}<button className="text-btn" onClick={() => dismissActivity(item.id)}>关闭</button></div></div><button className="icon-btn" aria-label="关闭活动" title="关闭活动" onClick={() => dismissActivity(item.id)}><XCircle size={14} /></button></div>)}</div>}
            {failedCount > 0 && <div className="task-alert"><CircleAlert size={15} /> {failedCount} 个后台任务需要处理，详情见上方时间线和项目操作列表。</div>}
            {!activeCount && !failedCount && <p>当前没有后台任务。打开文件面板即可开始传输。</p>}
          </div>
        )}
        {section === "transfers" && <TransferPanel open={open} embedded onOpenChange={(next) => { if (!next) onClose(); }} />}
        {section === "forwards" && <ForwardPanel open={open} embedded environments={environments} onOpenChange={(next) => { if (!next) onClose(); }} />}
        {section === "monitor" && (session ? <MonitorPane sessionId={session.id} active={open && section === "monitor"} compact /> : <div className="task-empty">选择一个远程会话后查看监控。</div>)}
      </div>
      </div>
      </aside>
    </>
  );
}

function batchOperationLabel(operation: string): string { return operation === "copy" ? "复制文件" : operation === "move" ? "移动文件" : operation === "delete" ? "删除文件" : "项目操作"; }
function batchStatusLabel(status: string): string { return ({ queued: "排队中", running: "运行中", cancelling: "取消中", succeeded: "完成", partial: "部分失败", failed: "失败", cancelled: "已取消" } as Record<string, string>)[status] ?? status; }
