type Props = { label: string; detail?: string; compact?: boolean; className?: string };

/** 统一加载反馈；减少动态模式下以静态标记和文本表达进行中状态。 */
export function LoadingState({ label, detail, compact = false, className = "" }: Props) {
  return <div className={`loading-state ${compact ? "compact" : ""} ${className}`} role="status" aria-live="polite" aria-busy="true"><span className="loading-spinner" aria-hidden="true" /><span className="loading-label">{label}</span>{detail ? <span className="loading-detail">{detail}</span> : null}</div>;
}

export function ErrorState({ message, onRetry, label = "加载失败" }: { message: string; onRetry: () => void; label?: string }) {
  return <div className="feedback-error" role="alert"><strong>{label}</strong><span>{message}</span><button type="button" className="btn btn-ghost" onClick={onRetry}>重试</button></div>;
}
