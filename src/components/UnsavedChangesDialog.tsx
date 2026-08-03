import { AlertTriangle } from "lucide-react";
import { useDialogFocus } from "../hooks/useDialogFocus";

type Props = {
  fileName: string;
  fileNames?: string[];
  onKeepEditing: () => void;
  onDiscard: () => void;
};

/** 关闭编辑标签前的明确保护，防止未保存的远程修改被静默丢弃。 */
export function UnsavedChangesDialog({ fileName, fileNames = [], onKeepEditing, onDiscard }: Props) {
  const dialogRef = useDialogFocus(true, onKeepEditing);
  return (
    <div className="overlay" onClick={onKeepEditing}>
      <div ref={dialogRef} className="dialog unsaved-dialog" role="dialog" aria-modal="true" aria-labelledby="unsaved-changes-title" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head"><div className="dialog-title" id="unsaved-changes-title"><AlertTriangle size={16} /> 未保存的修改</div></div>
        <div className="dialog-body"><p>{fileNames.length ? <>项目工作台中有 <strong>{fileNames.length} 个未保存文件</strong>。继续关闭将永久丢弃这些本地修改。</> : <><strong>{fileName}</strong> 有尚未保存的修改。继续关闭将永久丢弃这些改动。</>}</p>{fileNames.length > 0 && <ul className="unsaved-file-list">{fileNames.slice(0, 12).map((path) => <li key={path}><code>{path}</code></li>)}</ul>}</div>
        <div className="dialog-foot"><button type="button" className="btn btn-ghost" onClick={onKeepEditing}>继续编辑</button><button type="button" className="btn btn-danger" onClick={onDiscard}>放弃修改并关闭</button></div>
      </div>
    </div>
  );
}
