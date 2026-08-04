export function logicalDropPoint(position: { x: number; y: number }, scale: number) {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { x: position.x / safeScale, y: position.y / safeScale };
}

export function resolveSftpDropTarget(element: HTMLElement | null, remotePanel: HTMLElement | null, cwd: string): string | null {
  if (!element || !remotePanel?.contains(element)) return null;
  return element.closest<HTMLElement>("[data-sftp-drop-dir]")?.dataset.sftpDropDir || cwd || "/";
}
