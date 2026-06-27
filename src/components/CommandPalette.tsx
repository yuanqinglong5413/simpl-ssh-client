import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Columns,
  FileCode,
  Folder,
  FolderTree,
  GitBranch,
  LogOut,
  Monitor,
  Plus,
  Rows,
  Search,
  Settings,
  SquareTerminal,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { fuzzyFilter } from "../utils/fuzzyMatch";

export type CommandItem = {
  id: string;
  label: string;
  description?: string;
  icon: LucideIcon;
  category: "connection" | "tab" | "action";
  action: () => void;
};

type Props = {
  open: boolean;
  onClose: () => void;
  commands: CommandItem[];
};

const CATEGORY_LABELS: Record<string, string> = {
  connection: "连接",
  tab: "标签",
  action: "操作",
};

/**
 * 命令面板：Cmd+K 触发的快速搜索浮层。
 */
export function CommandPalette({ open, onClose, commands }: Props) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 打开时聚焦输入框、重置查询
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const filtered = useMemo(
    () => fuzzyFilter(commands, query, (c) => c.label),
    [commands, query]
  );

  // 选中项跟随可见
  useEffect(() => {
    setSelectedIdx((prev) => Math.min(prev, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${selectedIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  function execute(item: CommandItem) {
    item.action();
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIdx((prev) => Math.min(prev + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIdx((prev) => Math.max(prev - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (filtered[selectedIdx]) execute(filtered[selectedIdx]);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  }

  if (!open) return null;

  // 按 category 分组（保持 filtered 的排序）
  const grouped: { category: string; items: CommandItem[] }[] = [];
  const catMap = new Map<string, CommandItem[]>();
  for (const item of filtered) {
    const list = catMap.get(item.category);
    if (list) list.push(item);
    else {
      catMap.set(item.category, [item]);
      grouped.push({ category: item.category, items: catMap.get(item.category)! });
    }
  }

  let flatIdx = 0;

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input-wrap">
          <Search size={16} className="palette-search-icon" />
          <input
            ref={inputRef}
            className="palette-input"
            placeholder="搜索命令、连接、标签…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
          {query && (
            <button className="palette-clear" onClick={() => setQuery("")}>
              <X size={14} />
            </button>
          )}
        </div>

        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="palette-empty">没有匹配的命令</div>
          ) : (
            grouped.map((group) => (
              <div key={group.category} className="palette-group">
                <div className="palette-group-label">
                  {CATEGORY_LABELS[group.category] ?? group.category}
                </div>
                {group.items.map((item) => {
                  const idx = flatIdx++;
                  const Icon = item.icon;
                  return (
                    <div
                      key={item.id}
                      data-idx={idx}
                      className={`palette-item ${idx === selectedIdx ? "selected" : ""}`}
                      onClick={() => execute(item)}
                      onMouseEnter={() => setSelectedIdx(idx)}
                    >
                      <Icon size={14} className="palette-item-icon" />
                      <div className="palette-item-text">
                        <span className="palette-item-label">{item.label}</span>
                        {item.description && (
                          <span className="palette-item-desc">{item.description}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="palette-footer">
          <span>↑↓ 导航</span>
          <span>↵ 执行</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}

/** 内置动作命令生成器（供 App.tsx 使用） */
export function builtinCommands(handlers: {
  onNewConnection: () => void;
  onCloseTab: () => void;
  onOpenSettings: () => void;
  onOpenSftp: () => void;
  onOpenMonitor: () => void;
  onOpenGit: () => void;
  onDisconnect: () => void;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  onSwitchMode?: (mode: "ssh" | "project") => void;
  onOpenProjectTerminal?: (projectId: string) => void;
  projects?: { id: string; name: string }[];
}): CommandItem[] {
  const commands: CommandItem[] = [
    {
      id: "action:new",
      label: "新建连接",
      description: "Cmd+N",
      icon: Plus,
      category: "action",
      action: handlers.onNewConnection,
    },
    {
      id: "action:close-tab",
      label: "关闭当前标签",
      description: "Cmd+W",
      icon: X,
      category: "action",
      action: handlers.onCloseTab,
    },
    {
      id: "action:settings",
      label: "打开设置",
      description: "Cmd+,",
      icon: Settings,
      category: "action",
      action: handlers.onOpenSettings,
    },
    {
      id: "action:sftp",
      label: "打开 SFTP 文件面板",
      icon: Folder,
      category: "action",
      action: handlers.onOpenSftp,
    },
    {
      id: "action:monitor",
      label: "打开系统监控",
      icon: Monitor,
      category: "action",
      action: handlers.onOpenMonitor,
    },
    {
      id: "action:git",
      label: "打开 Git 面板",
      icon: GitBranch,
      category: "action",
      action: handlers.onOpenGit,
    },
    {
      id: "action:disconnect",
      label: "断开当前连接",
      icon: LogOut,
      category: "action",
      action: handlers.onDisconnect,
    },
    {
      id: "action:split-h",
      label: "水平分屏",
      icon: Columns,
      category: "action",
      action: handlers.onSplitHorizontal,
    },
    {
      id: "action:split-v",
      label: "垂直分屏",
      icon: Rows,
      category: "action",
      action: handlers.onSplitVertical,
    },
  ];

  // 模式切换命令
  if (handlers.onSwitchMode) {
    commands.push(
      {
        id: "action:mode-ssh",
        label: "切换到 SSH 管理",
        icon: Monitor,
        category: "action",
        action: () => handlers.onSwitchMode!("ssh"),
      },
      {
        id: "action:mode-project",
        label: "切换到项目管理",
        icon: FolderTree,
        category: "action",
        action: () => handlers.onSwitchMode!("project"),
      }
    );
  }

  // 项目快速打开命令
  if (handlers.projects && handlers.onOpenProjectTerminal) {
    for (const p of handlers.projects) {
      commands.push({
        id: `project:open:${p.id}`,
        label: `打开项目: ${p.name}`,
        icon: SquareTerminal,
        category: "connection",
        action: () => handlers.onOpenProjectTerminal!(p.id),
      });
    }
  }

  return commands;
}

/** 将 profiles 转为命令列表 */
export function profileCommands(
  profiles: { id: string; name: string; host: string }[],
  onConnect: (id: string) => void
): CommandItem[] {
  return profiles.map((p) => ({
    id: `conn:${p.id}`,
    label: `连接到: ${p.name}`,
    description: p.host,
    icon: Terminal,
    category: "connection" as const,
    action: () => onConnect(p.id),
  }));
}

/** 将 tabs 转为命令列表 */
export function tabCommands(
  tabs: { id: string; title: string; kind: string }[],
  onSwitch: (id: string) => void
): CommandItem[] {
  const iconMap: Record<string, LucideIcon> = {
    terminal: Terminal,
    sftp: Folder,
    monitor: Activity,
    editor: FileCode,
    git: GitBranch,
  };
  return tabs.map((t) => ({
    id: `tab:${t.id}`,
    label: `切换到: ${t.title}`,
    description: t.kind,
    icon: iconMap[t.kind] ?? Terminal,
    category: "tab" as const,
    action: () => onSwitch(t.id),
  }));
}
