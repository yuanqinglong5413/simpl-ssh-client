import { useState } from "react";
import { ArrowLeft, ArrowRight, Files, X } from "lucide-react";
import { useDialogFocus } from "../hooks/useDialogFocus";

export type OverwriteChoice = "overwrite" | "skip" | "ifNewer" | "rename";

type Props = {
  direction: "upload" | "download";
  count: number;
  source: string;
  destination: string;
  production?: boolean;
  onClose: () => void;
  onConfirm: (overwrite: OverwriteChoice) => void;
};

/** 传输前明确目标与同名文件策略，所有选择会传给现有队列。 */
export function TransferConfirmDialog({ direction, count, source, destination, production = false, onClose, onConfirm }: Props) {
  const [overwrite, setOverwrite] = useState<OverwriteChoice>("ifNewer");
  const [productionPhrase, setProductionPhrase] = useState("");
  const upload = direction === "upload";
  const dialogRef = useDialogFocus(true, onClose);
  return (
    <div className="overlay" onClick={onClose}>
      <div ref={dialogRef} className="dialog transfer-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="transfer-confirm-title" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <div className="dialog-title" id="transfer-confirm-title">{upload ? <ArrowRight size={16} /> : <ArrowLeft size={16} />} 确认{upload ? "上传" : "下载"}</div>
          <button type="button" aria-label="取消传输" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="dialog-body">
          <div className="transfer-confirm-count"><Files size={16} /> 将 {count} 项加入传输队列</div>
          <dl className="transfer-confirm-paths"><div><dt>来源</dt><dd title={source}>{source}</dd></div><div><dt>目标</dt><dd title={destination}>{destination}</dd></div></dl>
          <div className="field">
            <label>同名文件处理方式</label>
            <select value={overwrite} onChange={(event) => setOverwrite(event.target.value as OverwriteChoice)}>
              <option value="ifNewer">仅在来源较新时覆盖（推荐）</option>
              <option value="rename">保留两份，自动改名</option>
              <option value="skip">跳过已存在文件</option>
              <option value="overwrite">直接覆盖</option>
            </select>
          </div>
          {production && (overwrite === "overwrite" || overwrite === "ifNewer") && <label className="field sftp-production-confirm">目标连接标记为生产环境。输入“生产”确认可能发生的覆盖<input value={productionPhrase} onChange={(event) => setProductionPhrase(event.target.value)} placeholder="生产" /></label>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" disabled={production && (overwrite === "overwrite" || overwrite === "ifNewer") && productionPhrase.trim() !== "生产"} onClick={() => onConfirm(overwrite)}>加入队列</button>
        </div>
      </div>
    </div>
  );
}
