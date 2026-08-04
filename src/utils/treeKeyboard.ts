import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** 标准资源树键盘导航：上下移动，左右折叠/展开，Home/End 跳转。 */
export function handleTreeKeyboard(event: ReactKeyboardEvent<HTMLElement>) {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const target = event.target as HTMLElement;
  const current = target.closest<HTMLElement>("[role=treeitem]");
  if (!current || target !== current) return;
  const tree = event.currentTarget;
  const items = Array.from(tree.querySelectorAll<HTMLElement>("[role=treeitem]")).filter((item) => item.offsetParent !== null);
  const index = items.indexOf(current);
  if (index < 0) return;

  const focus = (item?: HTMLElement) => {
    if (!item) return;
    event.preventDefault();
    item.focus();
  };
  if (event.key === "ArrowUp") return focus(items[index - 1]);
  if (event.key === "ArrowDown") return focus(items[index + 1]);
  if (event.key === "Home") return focus(items[0]);
  if (event.key === "End") return focus(items[items.length - 1]);

  const expanded = current.getAttribute("aria-expanded");
  if (event.key === "ArrowRight") {
    if (expanded === "false") {
      event.preventDefault();
      current.click();
      return;
    }
    const level = Number(current.getAttribute("aria-level") || 1);
    const next = items[index + 1];
    if (next && Number(next.getAttribute("aria-level") || 1) > level) focus(next);
    return;
  }

  if (expanded === "true") {
    event.preventDefault();
    current.click();
    return;
  }
  const level = Number(current.getAttribute("aria-level") || 1);
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const candidateLevel = Number(items[candidate].getAttribute("aria-level") || 1);
    if (candidateLevel < level) {
      focus(items[candidate]);
      break;
    }
  }
}
