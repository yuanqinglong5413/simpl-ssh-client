import { useState } from "react";
import { ShieldAlert, ShieldCheck, Copy, Check } from "lucide-react";
import type { HostKeyEvent } from "../types";

type Props = {
  data: HostKeyEvent;
  busy: boolean;
  onTrust: () => void;
  onReject: () => void;
};

/** 主机公钥确认弹窗：首次连接（TOFU）或公钥已变更（疑似 MITM）。
 *  复用对话框样式；changed 时按钮优先级反转——把「拒绝」做成显眼的安全默认项。 */
export function HostKeyDialog({ data, busy, onTrust, onReject }: Props) {
  const [copied, setCopied] = useState(false);
  const changed = data.kind === "changed";

  async function copyFingerprint() {
    try {
      await navigator.clipboard.writeText(data.fingerprint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }

  return (
    <div className="overlay hostkey-overlay">
      <div className="dialog hostkey-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <div className="dialog-title">
            {changed ? <ShieldAlert size={16} /> : <ShieldCheck size={16} />}
            {changed ? "主机公钥已变更" : "首次连接"}
          </div>
        </div>

        <div className="dialog-body">
          <div className="hostkey-host">
            {data.host}
            {data.port !== 22 ? `:${data.port}` : ""}
          </div>

          {changed ? (
            <div className="hostkey-banner">
              <strong>检测到公钥变更。</strong>
              这可能意味着<strong>中间人攻击</strong>，也可能只是服务器重装或更换了密钥。
              除非你确知变更原因并已通过可靠渠道核对新指纹，否则<strong>不要</strong>继续。
            </div>
          ) : (
            <p className="hostkey-hint">
              这台主机的公钥尚未记录。请通过可靠渠道（如服务器控制台、<code>ssh-keyscan</code>）
              核对下方指纹后再信任——这是防止中间人攻击的关键一步。
            </p>
          )}

          <div className="hostkey-fp">
            <div className="hostkey-fp-label">
              <span>{data.algorithm}</span>
              <button
                type="button"
                className="hostkey-copy"
                onClick={copyFingerprint}
                title="复制指纹"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? "已复制" : "复制"}
              </button>
            </div>
            <code className="hostkey-fp-value">{data.fingerprint}</code>
          </div>
        </div>

        <div className="dialog-foot">
          {changed ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={onReject}
                disabled={busy}
              >
                拒绝
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onTrust}
                disabled={busy}
              >
                {busy ? "处理中…" : "我已确认，信任新公钥"}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onReject}
                disabled={busy}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={onTrust}
                disabled={busy}
              >
                {busy ? "处理中…" : "信任并连接"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
