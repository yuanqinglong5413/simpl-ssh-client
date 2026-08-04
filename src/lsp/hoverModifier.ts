/** Platform-correct modifier for semantic hover: Cmd on macOS, Ctrl elsewhere. */
export function isPrimaryHoverModifier(
  event: Pick<KeyboardEvent | MouseEvent, "metaKey" | "ctrlKey">,
  platform = navigator.platform,
): boolean {
  return platform.toLowerCase().includes("mac") ? event.metaKey : event.ctrlKey;
}
