import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { useDialogFocus } from "../hooks/useDialogFocus";

export function ConfirmDialog({ title, children, confirmLabel = "确认", danger = false, confirmDisabled = false, onClose, onConfirm }: {
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  confirmDisabled?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useDialogFocus(true, onClose);
  return (
    <div className="overlay" onClick={onClose}>
      <div ref={dialogRef} className="dialog confirmation-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head"><div className="dialog-title">{title}</div><button type="button" aria-label="关闭" onClick={onClose}><X size={16} /></button></div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-foot"><button type="button" className="btn btn-ghost" onClick={onClose}>取消</button><button type="button" disabled={confirmDisabled} className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm}>{confirmLabel}</button></div>
      </div>
    </div>
  );
}

export function TextInputDialog({ title, label, initialValue = "", confirmLabel = "确认", onClose, onConfirm }: {
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const dialogRef = useDialogFocus(true, onClose);
  return (
    <div className="overlay" onClick={onClose}>
      <div ref={dialogRef} className="dialog confirmation-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head"><div className="dialog-title">{title}</div><button type="button" aria-label="关闭" onClick={onClose}><X size={16} /></button></div>
        <div className="dialog-body"><div className="field"><label>{label}</label><input autoFocus value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && value.trim()) onConfirm(value.trim()); }} /></div></div>
        <div className="dialog-foot"><button type="button" className="btn btn-ghost" onClick={onClose}>取消</button><button type="button" className="btn btn-primary" disabled={!value.trim()} onClick={() => onConfirm(value.trim())}>{confirmLabel}</button></div>
      </div>
    </div>
  );
}
