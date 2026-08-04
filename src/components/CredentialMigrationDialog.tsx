import { invoke } from "@tauri-apps/api/core";
import { KeyRound, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useDialogFocus } from "../hooks/useDialogFocus";

type Status = { needed: boolean; profileCount: number; complete: boolean };
type Failure = { profileId: string; profileName: string; reason: string };
type Report = { migrated: number; skipped: number; failures: Failure[]; complete: boolean };
const DISMISSED_KEY = "simpl-ssh:credential-migration:v1:dismissed";

/** 升级后仅出现一次；读取旧 keyring 只能由这个明确确认动作触发。 */
export function CredentialMigrationDialog() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const focusRef = useDialogFocus(open, () => dismiss());

  useEffect(() => {
    if (localStorage.getItem(DISMISSED_KEY)) return;
    void invoke<Status>("credential_migration_status")
      .then((status) => setOpen(status.needed))
      .catch(() => undefined);
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, "1");
    setOpen(false);
  }

  async function migrate() {
    setBusy(true);
    setError("");
    try {
      const result = await invoke<Report>("credential_migration_run");
      setReport(result);
      if (result.complete) {
        localStorage.setItem(DISMISSED_KEY, "1");
        window.setTimeout(() => setOpen(false), 900);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return <div className="overlay credential-migration-overlay"><div ref={focusRef} className="dialog credential-migration-dialog" role="dialog" aria-modal="true" aria-labelledby="credential-migration-title">
    <div className="dialog-head"><KeyRound size={18} /><strong id="credential-migration-title">导入旧连接凭据</strong></div>
    <div className="dialog-body">
      <p>Simpl SSH 现在使用应用加密仓库。确认导入时，macOS 钥匙串可能进行最后一次系统授权；成功验证的条目会从旧钥匙串删除，后续连接和应用重启后都不会再读取钥匙串。</p>
      <div className="credential-vault-note"><ShieldCheck size={16} /><span>AES-256-GCM 密文保存在本机 SQLite。它减少系统密码打扰，但不具备系统钥匙串相同的硬件与系统隔离强度。</span></div>
      {report && <div className={report.complete ? "migration-success" : "persistent-error"}><strong>{report.complete ? "凭据导入完成" : "部分凭据未导入"}</strong><span>已导入 {report.migrated} 项，跳过 {report.skipped} 项。</span>{report.failures.map((failure) => <div key={failure.profileId}><b>{failure.profileName}</b><small>{failure.reason}</small></div>)}</div>}
      {error && <div className="persistent-error" role="alert">{error}</div>}
    </div>
    <div className="dialog-foot"><button className="btn btn-ghost" disabled={busy} onClick={dismiss}>稍后（连接时重填）</button><button className="btn btn-primary" disabled={busy} onClick={() => void migrate()}>{busy ? "正在安全导入…" : report?.failures.length ? "重试失败项" : "导入并验证"}</button></div>
  </div></div>;
}
