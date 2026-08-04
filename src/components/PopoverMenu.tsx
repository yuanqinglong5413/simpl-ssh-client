import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";

type Props = { open: boolean; onClose: () => void; triggerRef: RefObject<HTMLElement | null>; className?: string; label: string; children: ReactNode };

/** 统一的非模态菜单：外部点击、Escape、方向键与焦点恢复。 */
export function PopoverMenu({ open, onClose, triggerRef, className = "", label, children }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus(), 0);
    const pointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) onClose();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      const restore = Boolean(menuRef.current?.contains(document.activeElement));
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", escape, true);
      if (restore) requestAnimationFrame(() => triggerRef.current?.focus());
    };
  }, [onClose, open, triggerRef]);
  if (!open) return null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Home") items[0].focus();
    else if (event.key === "End") items[items.length - 1].focus();
    else if (event.key === "ArrowDown") items[(current + 1 + items.length) % items.length].focus();
    else items[(current - 1 + items.length) % items.length].focus();
  };
  return <div ref={menuRef} className={className} role="menu" aria-label={label} onKeyDown={onKeyDown}>{children}</div>;
}
