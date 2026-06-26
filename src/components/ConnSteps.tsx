/** 连接进度步骤：跳板（可选）→ 解析/隧道 → 加密握手 → 身份认证。 */
const STEPS = [
  { key: "jump", label: "连接跳板" },
  { key: "resolve", label: "连接目标" },
  { key: "handshake", label: "加密握手" },
  { key: "auth", label: "身份认证" },
];

const ORDER = STEPS.map((s) => s.key);

/** `stage` 为当前阶段 key；ready 时全部完成。 */
export function ConnSteps({ stage }: { stage: string }) {
  const allDone = stage === "ready";
  const currentIdx = allDone
    ? ORDER.length
    : Math.max(0, ORDER.indexOf(stage));

  return (
    <div className="conn-steps">
      {STEPS.map((s) => {
        const stepIdx = ORDER.indexOf(s.key);
        const state =
          allDone || stepIdx < currentIdx
            ? "done"
            : stepIdx === currentIdx
              ? "active"
              : "";
        return (
          <div key={s.key} className={`conn-step ${state}`}>
            <span className="conn-dot" />
            <span>{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}
