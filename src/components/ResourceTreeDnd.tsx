import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type ResourceTreeKind = "connection" | "project";
export type ResourceNodeType = "group" | "item";
export type ResourceDragData = {
  treeKind: ResourceTreeKind;
  nodeType: ResourceNodeType;
  id: string;
  parentId: string | null;
  position: number;
  label: string;
};

export type ResourceDropData = {
  treeKind: ResourceTreeKind;
  targetType: ResourceNodeType | "root";
  targetId?: string;
  parentId: string | null;
  position: number;
  mode: "before" | "inside" | "after" | "root";
};

export function resolveResourceDrop(source: ResourceDragData, target: ResourceDropData): { parentId: string | null; position: number } | null {
  if (source.treeKind !== target.treeKind || target.targetId === source.id) return null;
  if ((target.mode === "before" || target.mode === "after") && source.nodeType !== target.targetType) return null;
  if (source.nodeType === "item" && target.targetType === "group" && target.mode !== "inside") return null;
  let position = target.mode === "after" ? target.position + 1 : target.position;
  if (target.mode === "inside" || target.mode === "root") position = Number.MAX_SAFE_INTEGER;
  if (source.parentId === target.parentId && source.position < position && Number.isFinite(position)) position -= 1;
  if (source.parentId === target.parentId && source.position === position) return null;
  return { parentId: target.parentId, position };
}

type Props = {
  kind: ResourceTreeKind;
  disabled?: boolean;
  children: ReactNode;
  onMove: (source: ResourceDragData, parentId: string | null, position: number) => Promise<void> | void;
  onAutoExpand?: (groupId: string) => void;
  onError?: (message: string) => void;
};

export function ResourceTreeDnd({ kind, disabled = false, children, onMove, onAutoExpand, onError }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const [active, setActive] = useState<ResourceDragData | null>(null);
  const expandTimer = useRef<number | null>(null);

  const clearExpand = useCallback(() => {
    if (expandTimer.current != null) window.clearTimeout(expandTimer.current);
    expandTimer.current = null;
  }, []);
  useEffect(() => clearExpand, [clearExpand]);

  const restoreFocus = useCallback((id?: string) => {
    if (!id) return;
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-resource-drag-id="${globalThis.CSS.escape(id)}"]`);
      (row?.querySelector<HTMLElement>('[role="treeitem"]') ?? row)?.focus();
    });
  }, []);

  function handleStart(event: DragStartEvent) {
    const source = event.active.data.current as ResourceDragData | undefined;
    if (source?.treeKind === kind) setActive(source);
  }

  function handleOver(event: DragOverEvent) {
    clearExpand();
    const target = event.over?.data.current as ResourceDropData | undefined;
    if (!target || target.treeKind !== kind || target.mode !== "inside" || target.targetType !== "group" || !target.targetId || !onAutoExpand) return;
    expandTimer.current = window.setTimeout(() => onAutoExpand(target.targetId!), 650);
  }

  async function handleEnd(event: DragEndEvent) {
    clearExpand();
    const source = event.active.data.current as ResourceDragData | undefined;
    const target = event.over?.data.current as ResourceDropData | undefined;
    setActive(null);
    restoreFocus(source?.id);
    if (!source || !target || source.treeKind !== kind || target.treeKind !== kind) return;
    const resolved = resolveResourceDrop(source, target);
    if (!resolved) return;
    try {
      await onMove(source, resolved.parentId, resolved.position);
    } catch (error) {
      onError?.(String(error));
    }
  }

  return (
    <DndContext
      sensors={disabled ? [] : sensors}
      collisionDetection={closestCenter}
      onDragStart={handleStart}
      onDragOver={handleOver}
      onDragCancel={() => { clearExpand(); restoreFocus(active?.id); setActive(null); }}
      onDragEnd={(event) => void handleEnd(event)}
    >
      {children}
      <DragOverlay>{active ? <div className="resource-drag-overlay">{active.label}</div> : null}</DragOverlay>
      <span className="sr-only" aria-live="polite">{active ? `正在移动 ${active.label}` : ""}</span>
    </DndContext>
  );
}

type RowProps = {
  data: ResourceDragData;
  children: ReactNode;
  className?: string;
  allowInside?: boolean;
};

export function ResourceTreeDragRow({ data, children, className = "", allowInside = false }: RowProps) {
  const drag = useDraggable({ id: `${data.treeKind}:${data.nodeType}:${data.id}`, data });
  const before = useDroppable({
    id: `${data.treeKind}:${data.nodeType}:${data.id}:before`,
    data: { treeKind: data.treeKind, targetType: data.nodeType, targetId: data.id, parentId: data.parentId, position: data.position, mode: "before" } satisfies ResourceDropData,
  });
  const inside = useDroppable({
    id: `${data.treeKind}:${data.nodeType}:${data.id}:inside`,
    disabled: !allowInside,
    data: { treeKind: data.treeKind, targetType: data.nodeType, targetId: data.id, parentId: allowInside ? data.id : data.parentId, position: data.position, mode: "inside" } satisfies ResourceDropData,
  });
  const after = useDroppable({
    id: `${data.treeKind}:${data.nodeType}:${data.id}:after`,
    data: { treeKind: data.treeKind, targetType: data.nodeType, targetId: data.id, parentId: data.parentId, position: data.position, mode: "after" } satisfies ResourceDropData,
  });
  const style = { transform: DndCSS.Translate.toString(drag.transform), opacity: drag.isDragging ? 0.35 : undefined };
  return (
    <div ref={drag.setNodeRef} style={style} className={`resource-dnd-row ${className}`} data-resource-drag-id={data.id} {...drag.attributes} {...drag.listeners} tabIndex={-1} role="presentation">
      <span ref={before.setNodeRef} className={`resource-drop-line before ${before.isOver ? "active" : ""}`} />
      <div ref={inside.setNodeRef} className={allowInside && inside.isOver ? "resource-drop-inside" : ""}>{children}</div>
      <span ref={after.setNodeRef} className={`resource-drop-line after ${after.isOver ? "active" : ""}`} />
    </div>
  );
}

export function ResourceTreeRootDrop({ kind, children }: { kind: ResourceTreeKind; children: ReactNode }) {
  const drop = useDroppable({
    id: `${kind}:root`,
    data: { treeKind: kind, targetType: "root", parentId: null, position: Number.MAX_SAFE_INTEGER, mode: "root" } satisfies ResourceDropData,
  });
  return <div ref={drop.setNodeRef} className={`resource-tree-root ${drop.isOver ? "resource-root-drop-active" : ""}`}>{children}</div>;
}
