import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProfileGroup, ResourceGroupDeletePreview } from "../types";
import { ConfirmDialog } from "./DialogPrimitives";
import { LoadingState } from "./LoadingState";

export function ResourceGroupDeleteDialog({ group, onClose, onConfirm }: { group: ProfileGroup; onClose: () => void; onConfirm: () => void }) {
  const [preview, setPreview] = useState<ResourceGroupDeletePreview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    invoke<ResourceGroupDeletePreview>("resource_group_delete_preview", { id: group.id })
      .then((value) => { if (active) setPreview(value); })
      .catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [group.id]);
  return <ConfirmDialog title="递归删除分组" confirmLabel="确认删除全部记录" danger confirmDisabled={!preview || Boolean(error)} onClose={onClose} onConfirm={onConfirm}>
    {!preview && !error && <LoadingState compact label="正在计算影响范围…" />}
    {error && <p className="form-error">无法读取影响范围：{error}</p>}
    {preview && <>
      <p>将递归删除「<strong>{group.name}</strong>」及其内容：</p>
      <ul><li>{preview.group_count} 个分组文件夹</li><li>{preview.connection_count} 个连接配置及其应用加密凭据</li><li>{preview.project_count} 个项目记录</li></ul>
      <p><strong>不会删除任何本地项目目录、源码或远程文件。</strong></p>
    </>}
  </ConfirmDialog>;
}
