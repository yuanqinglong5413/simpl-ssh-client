export type ProjectWorkbenchState = {
  version: 1;
  activity: "explorer" | "search" | "scm" | "run" | "remote" | "language";
  bottomOpen: boolean;
  bottomHeight: number;
  bottomView: "terminal" | "tasks" | "problems" | "output" | "references" | "outline";
  openFiles: string[];
  activeFile: string | null;
  secondaryFile: string | null;
  splitEditors: boolean;
};

export const DEFAULT_WORKBENCH_STATE: ProjectWorkbenchState = {
  version: 1,
  activity: "explorer",
  bottomOpen: false,
  bottomHeight: 250,
  bottomView: "terminal",
  openFiles: [],
  activeFile: null,
  secondaryFile: null,
  splitEditors: false,
};

export function loadWorkbenchState(raw: string | null): ProjectWorkbenchState {
  if (!raw) return DEFAULT_WORKBENCH_STATE;
  try {
    const value = JSON.parse(raw) as Partial<ProjectWorkbenchState>;
    const activity = ["explorer", "search", "scm", "run", "remote", "language"].includes(value.activity ?? "") ? value.activity as ProjectWorkbenchState["activity"] : DEFAULT_WORKBENCH_STATE.activity;
    const bottomView = ["terminal", "tasks", "problems", "output", "references", "outline"].includes(value.bottomView ?? "") ? value.bottomView as ProjectWorkbenchState["bottomView"] : DEFAULT_WORKBENCH_STATE.bottomView;
    const openFiles = Array.isArray(value.openFiles) ? value.openFiles.filter((path): path is string => typeof path === "string" && path.length > 0).slice(0, 30) : [];
    const activeFile = typeof value.activeFile === "string" && openFiles.includes(value.activeFile) ? value.activeFile : openFiles[0] ?? null;
    const secondaryFile = typeof value.secondaryFile === "string" && openFiles.includes(value.secondaryFile) ? value.secondaryFile : null;
    return { version: 1, activity, bottomOpen: Boolean(value.bottomOpen), bottomHeight: Math.max(150, Math.min(520, Number(value.bottomHeight) || DEFAULT_WORKBENCH_STATE.bottomHeight)), bottomView, openFiles, activeFile, secondaryFile, splitEditors: Boolean(value.splitEditors) };
  } catch { return DEFAULT_WORKBENCH_STATE; }
}

export function saveWorkbenchState(state: ProjectWorkbenchState) {
  return JSON.stringify({ ...state, openFiles: state.openFiles.slice(0, 30) });
}
