import { useEffect, useState } from "react";
import { Radio, ShieldAlert, X } from "lucide-react";
import type { ConnectionEnvironment, SessionInfo } from "../types";
import { useDialogFocus } from "../hooks/useDialogFocus";

type Props = {
  sessions: SessionInfo[];
  initialTargets: string[];
  environments?: Record<string, ConnectionEnvironment | null | undefined>;
  onClose: () => void;
  onConfirm: (targetIds: string[]) => void;
};

/** 广播输入必须先显式选定目标，避免把生产命令误发到所有会话。 */
export function BroadcastDialog({ sessions, initialTargets, environments = {}, onClose, onConfirm }: Props) {
  const [targets, setTargets] = useState<string[]>(initialTargets);
  const [acknowledged, setAcknowledged] = useState(false);
  const [productionPhrase, setProductionPhrase] = useState("");
  const dialogRef = useDialogFocus(true, onClose);

  useEffect(() => {
    if (targets.length === 0 && sessions.length > 0) setTargets([sessions[0].id]);
  }, [sessions, targets.length]);

  const toggle = (id: string) => setTargets((previous) =>
    previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]
  );
  const includesProduction = targets.some((id) => environments[id] === "production");

  return (
    <div className="overlay" onClick={onClose}>
      <div ref={dialogRef} className="dialog broadcast-dialog" role="dialog" aria-modal="true" aria-labelledby="broadcast-title" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <div className="dialog-title" id="broadcast-title"><Radio size={16} /> 广播输入目标</div>
          <button type="button" aria-label="关闭广播设置" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="dialog-body">
          <div className="broadcast-warning"><ShieldAlert size={16} /><span>启用后，当前终端的每一次输入都会发送到下列目标会话。请勿将生产环境与非预期主机混选。</span></div>
          {sessions.length === 0 ? <div className="form-error">没有可作为广播目标的活动会话。</div> : (
            <div className="broadcast-targets">
              {sessions.map((session) => (
                <label className="broadcast-target" key={session.id}>
                  <input type="checkbox" checked={targets.includes(session.id)} onChange={() => toggle(session.id)} />
                  <span>{session.user}@{session.host}:{session.port}{environments[session.id] === "production" && <strong className="broadcast-production">生产</strong>}</span>
                </label>
              ))}
            </div>
          )}
          <label className="check broadcast-ack"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> 我已确认目标主机和影响范围</label>
          {includesProduction && <label className="field broadcast-production-confirm">已选择生产环境。输入“生产”以确认<input value={productionPhrase} onChange={(event) => setProductionPhrase(event.target.value)} placeholder="生产" /></label>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" disabled={!acknowledged || targets.length === 0 || (includesProduction && productionPhrase.trim() !== "生产")} onClick={() => onConfirm(targets)}>启用广播（{targets.length}）</button>
        </div>
      </div>
    </div>
  );
}
