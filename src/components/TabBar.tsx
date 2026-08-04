import { Activity, ChevronDown, FileCode, Folder, FolderTree, GitBranch, MoreHorizontal, PlugZap, Plus, SquareTerminal, Terminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Tab } from "../types";
import { PopoverMenu } from "./PopoverMenu";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";

type Props = {
  tabs: Tab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onReorder?: (activeId: string, overId: string) => void;
  onNew?: () => void;
};

export function TabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onReorder,
  onNew,
}: Props) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const activeRef = useRef<HTMLDivElement>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 7 } }));
  useEffect(() => activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" }), [activeTabId]);
  useEffect(() => setOverflowOpen(false), [activeTabId]);
  function onTabKeyDown(event: React.KeyboardEvent, index: number) {
    if (!tabs.length) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const target = tabs[(index + direction + tabs.length) % tabs.length].id;
      onActivate(target);
      requestAnimationFrame(() => tabRefs.current.get(target)?.focus());
    }
  }
  return (
    <div className="tabbar">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event: DragEndEvent) => { if (event.over && event.active.id !== event.over.id) onReorder?.(String(event.active.id), String(event.over.id)); }}>
      <SortableContext items={tabs.map((tab) => tab.id)} strategy={horizontalListSortingStrategy}>
      <div className="tabbar-scroll" role="tablist" aria-label="工作区标签">
      {tabs.map((t, index) => (
        <SortableTab
          key={t.id}
          tab={t}
          active={t.id === activeTabId}
          setRef={(node) => { if (node) tabRefs.current.set(t.id, node); else tabRefs.current.delete(t.id); if (t.id === activeTabId) activeRef.current = node; }}
          onActivate={() => onActivate(t.id)}
          onKeyDown={(event) => onTabKeyDown(event, index)}
          onClose={() => onClose(t.id)}
        >
          {t.kind === "lsp-catalog" ? (
            <PlugZap size={13} />
          ) : t.kind === "project-workbench" ? (
            <FolderTree size={13} />
          ) : t.kind === "sftp" ? (
            <Folder size={13} />
          ) : t.kind === "monitor" ? (
            <Activity size={13} />
          ) : t.kind === "editor" ? (
            <FileCode size={13} />
          ) : t.kind === "git" ? (
            <GitBranch size={13} />
          ) : t.kind === "local-terminal" ? (
            <SquareTerminal size={13} />
          ) : (
            <Terminal size={13} />
          )}
          {t.agentPresetId && <span className={`agent-tab-status ${t.agentStatus ?? "running"}`} title={t.agentStatus === "failed" ? "Agent 启动失败" : t.agentStatus === "exited" ? "Agent 已退出" : "Agent 运行中"} aria-label={t.agentStatus === "failed" ? "Agent 启动失败" : t.agentStatus === "exited" ? "Agent 已退出" : "Agent 运行中"} />}
          <span className="tab-name">{t.title}</span>
        </SortableTab>
      ))}
      </div>
      </SortableContext>
      </DndContext>
      <div className="tab-spacer" />
      {tabs.length > 0 && <div className="tab-overflow">
        <button ref={overflowTriggerRef} className="tab-new" onClick={() => setOverflowOpen((value) => !value)} aria-label="查看所有标签" aria-haspopup="menu" aria-expanded={overflowOpen} title="所有标签"><MoreHorizontal size={16} /></button>
        <PopoverMenu open={overflowOpen} onClose={() => setOverflowOpen(false)} triggerRef={overflowTriggerRef} className="tab-overflow-menu" label="所有工作区标签">{tabs.map((tab) => <button role="menuitem" key={tab.id} className={tab.id === activeTabId ? "active" : ""} onClick={() => { onActivate(tab.id); setOverflowOpen(false); }}><span>{tab.title}</span>{tab.id === activeTabId && <ChevronDown size={13} />}</button>)}</PopoverMenu>
      </div>}
      {onNew && (
        <button className="tab-new" onClick={onNew} title="新建连接">
          <Plus size={16} />
        </button>
      )}
    </div>
  );
}

function SortableTab({ tab, active, setRef, onActivate, onKeyDown, onClose, children }: { tab: Tab; active: boolean; setRef: (node: HTMLDivElement | null) => void; onActivate: () => void; onKeyDown: (event: React.KeyboardEvent) => void; onClose: () => void; children: React.ReactNode }) {
  const sortable = useSortable({ id: tab.id });
  const ref = (node: HTMLDivElement | null) => { sortable.setNodeRef(node); setRef(node); };
  return <div ref={ref} style={{ transform: DndCSS.Transform.toString(sortable.transform), transition: sortable.transition, opacity: sortable.isDragging ? 0.45 : undefined }} data-tab-id={tab.id} {...sortable.attributes} {...sortable.listeners} role="tab" aria-selected={active} tabIndex={active ? 0 : -1} className={`tab ${active ? "active" : ""}`} onClick={onActivate} onKeyDown={onKeyDown} title={tab.title}>
    {children}
    <button className="tab-x" aria-label={`关闭 ${tab.title}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onClose(); }}><X size={13} /></button>
  </div>;
}
