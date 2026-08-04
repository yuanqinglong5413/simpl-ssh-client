import { useMemo, useState } from "react";
import type { ProfileGroup } from "../types";
import { useDialogFocus } from "../hooks/useDialogFocus";

type Props = {
  title: string;
  groups: ProfileGroup[];
  currentGroupId?: string | null;
  movingGroupId?: string;
  onClose: () => void;
  onMove: (groupId: string | null) => Promise<void> | void;
};

export function MoveResourceDialog({ title, groups, currentGroupId, movingGroupId, onClose, onMove }: Props) {
  const dialogRef = useDialogFocus(true, onClose);
  const [target, setTarget] = useState(currentGroupId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const descendants = useMemo(() => {
    if (!movingGroupId) return new Set<string>();
    const result = new Set([movingGroupId]);
    let changed = true;
    while (changed) {
      changed = false;
      groups.forEach((group) => {
        if (group.parent_id && result.has(group.parent_id) && !result.has(group.id)) { result.add(group.id); changed = true; }
      });
    }
    return result;
  }, [groups, movingGroupId]);
  const options = groups.filter((group) => !descendants.has(group.id)).sort((a, b) => a.order - b.order);
  const groupPath = (group: ProfileGroup) => {
    const names = [group.name];
    let parent = group.parent_id ? groups.find((item) => item.id === group.parent_id) : undefined;
    while (parent) { names.unshift(parent.name); parent = parent.parent_id ? groups.find((item) => item.id === parent!.parent_id) : undefined; }
    return names.join(" / ");
  };
  return <div className="dialog-overlay" onClick={onClose}>
    <div ref={dialogRef} className="dialog move-resource-dialog" role="dialog" aria-modal="true" aria-labelledby="move-resource-title" onClick={(event) => event.stopPropagation()}>
      <h2 id="move-resource-title">{title}</h2>
      <p>选择目标文件夹。移动后资源会放在该文件夹末尾。</p>
      <select className="form-input" value={target} autoFocus onChange={(event) => setTarget(event.target.value)}>
        <option value="">未分组（资源根）</option>
        {options.map((group) => <option key={group.id} value={group.id}>{groupPath(group)}</option>)}
      </select>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={busy || target === (currentGroupId ?? "")} onClick={() => { setBusy(true); setError(""); Promise.resolve(onMove(target || null)).then(onClose).catch((reason) => { setError(String(reason)); setBusy(false); }); }}>{busy ? "移动中…" : "移动"}</button>
      </div>
    </div>
  </div>;
}
