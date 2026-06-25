/** 连接进度的三步骤指示器：解析主机 → 加密握手 → 身份认证。 */
const STEPS = [
  { key: "resolve", label: "解析主机" },
  { key: "handshake", label: "加密握手" },
  { key: "auth", label: "身份认证" },
];

/** `stage` 为当前阶段 key（resolve|handshake|auth|ready）；ready 时全部完成。 */
export function ConnSteps({ stage }: { stage: string }) {
  const allDone = stage === "ready";
  const idx = STEPS.findIndex((s) => s.key === stage);
  return (
    <div className="conn-steps">
      {STEPS.map((s, i) => {
        const state =
          allDone || i < idx ? "done" : i === idx ? "active" : "";
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
