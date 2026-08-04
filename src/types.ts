export type SessionInfo = {
  id: string;
  host: string;
  port: number;
  user: string;
  created_at: string;
  /** 经跳板机连接时的跳板 host:port */
  jump_via?: string | null;
};

export type AuthMethod = "password" | "private_key";
export type ConnectionEnvironment = "production" | "staging" | "testing" | "local";

export type ProfileGroup = {
  id: string;
  name: string;
  order: number;
  parent_id?: string | null;
  kind?: "connection" | "project";
};

export type ResourceGroupDeletePreview = {
  group_count: number;
  connection_count: number;
  project_count: number;
  deletes_physical_files: false;
};

export type ConnectionProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth_method?: AuthMethod;
  private_key_path?: string | null;
  group_id?: string | null;
  /** 同一分组内的稳定显示顺序；旧数据缺省时按原数组顺序迁移。 */
  position?: number;
  /** 跳板机：引用另一个已保存连接的 id */
  jump_profile_id?: string | null;
  /** 远程终端编码（utf-8/gbk/gb2312/big5）；默认 utf-8 */
  encoding?: string | null;
  /** SSH keepalive 心跳间隔（秒）；0/缺省用默认 30 */
  keepalive_interval?: number | null;
  /** 连接就绪后注入终端的启动命令 */
  startup_command?: string | null;
  /** 仅用于界面风险语义，不改变连接协议。 */
  environment?: ConnectionEnvironment | null;
};

/** 分屏方向：horizontal=左右切，vertical=上下切。 */
export type SplitDir = "horizontal" | "vertical";

/** 终端 Tab 的树形布局：叶子是一个终端面板，split 是两个子布局按比例切分。 */
export type SplitNode =
  | { kind: "leaf"; paneId: string; sessionId: string }
  | {
      kind: "split";
      dir: SplitDir;
      ratio: number; // 第一个子占比，∈(0,1)
      children: [SplitNode, SplitNode];
    };

/** Tab 种类 */
export type TabKind = "terminal" | "sftp" | "monitor" | "editor" | "git" | "local-terminal" | "local-editor" | "local-git" | "project-workbench" | "lsp-catalog";

/** SSH 终端标签内的主视图。文件视图与终端共用同一个标签和 SSH 会话。 */
export type TerminalWorkspaceView = "terminal" | "files" | "split";

/** Tab 数据来源：ssh = 远程会话，local = 本地项目 */
export type TabSource = "ssh" | "local";

/** known_hosts 条目（已知主机管理面板） */
export type KnownHostEntry = {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  line: number;
  hashed: boolean;
};

/** 常用命令片段 */
export type Snippet = {
  id: string;
  title: string;
  content: string;
  tags: string[];
  created_at: string;
  group_id?: string | null;
};

export type Tab = {
  id: string;
  sessionId: string;
  title: string;
  kind: TabKind;
  /** 仅 terminal Tab 用：终端分屏布局。 */
  layout?: SplitNode;
  /** editor Tab: 远程文件路径 */
  filePath?: string;
  /** 持久化重连用（workspace restore） */
  profileId?: string;
  /** git Tab: 远程仓库路径 */
  repoPath?: string;
  /** 项目关联的远程根目录；与 Git 仓库路径分开，避免不同项目串到同一会话标签。 */
  remoteRoot?: string;
  /** 数据来源：ssh 或 local */
  source?: TabSource;
  /** 本地项目 ID（source=local 时使用） */
  projectId?: string;
  /** 创建标签时冻结的本地工作目录；项目被移动/删除后也不会意外切到默认目录。 */
  localPath?: string;
  /** 项目工作区打开终端后注入的命令（例如进入远程根目录）。 */
  startupCommand?: string;
  /** 终端标签内切换文件面板时保留终端实例和滚动缓冲，不再另开 SFTP 标签。 */
  terminalView?: TerminalWorkspaceView;
  /** 已经打开过的文件面板保持挂载，切回终端后不重新加载目录。 */
  sftpOpened?: boolean;
  terminalFileSplitDirection?: "horizontal" | "vertical";
  terminalFileSplitRatio?: number;
  /** 项目 Agent 标签不参与工作区自动恢复。 */
  agentPresetId?: string;
  agentStatus?: "running" | "exited" | "failed";
  /** Agent 本次启动时间，仅用于项目任务状态展示；不会参与恢复。 */
  agentStartedAt?: string;
};

export type ResourceTreeMoveInput = {
  kind: "connection" | "project";
  nodeType: "group" | "item";
  id: string;
  parentId: string | null;
  position: number;
};

export type ResourceTreeMoveResult = {
  kind: "connection" | "project";
  node_type: "group" | "item";
  id: string;
  parent_id: string | null;
  position: number;
};

export type FileEntry = {
  name: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  modified: string | null;
};

export type TransferKind = "upload" | "uploadDir" | "download";
export type TransferStatus =
  | "queued"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export type TransferTask = {
  id: string;
  session_id: string;
  kind: TransferKind;
  name: string;
  total: number;
  transferred: number;
  status: TransferStatus;
  error: string | null;
  overwrite: string;
  retry_count: number;
  max_retries: number;
  /** 仅在本机任务抽屉显示，不会上传或写入工作区快照。 */
  local_path: string;
  remote_path: string;
};

export type ForwardKind = "local" | "remote" | "dynamic";

export type ForwardEntry = {
  id: string;
  sessionId: string;
  kind: ForwardKind;
  localAddr: string;
  localPort: number;
  remoteHost: string | null;
  remotePort: number | null;
  boundPort: number;
  state: string;
};

/** 主机公钥校验结果：unknown=首次连接，changed=公钥已变更（疑似 MITM）。 */
export type HostKeyKind = "unknown" | "changed";

/** 后端推送的待确认主机公钥（ssh://hostkey 事件载荷）。 */
export type HostKeyEvent = {
  connectId: string;
  kind: HostKeyKind;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  line: number | null;
};

export type DiskUsage = {
  mount: string;
  total_bytes: number;
  used_bytes: number;
  avail_bytes: number;
};

/** 远程系统监控快照 */
export type MonitorSnapshot = {
  cpu_percent: number;
  mem_total_bytes: number;
  mem_used_bytes: number;
  mem_avail_bytes: number;
  load_1: number;
  load_5: number;
  load_15: number;
  uptime_secs: number;
  disks: DiskUsage[];
};

// =============================  Editor  ==============================

/** 远程文件内容（sftp_read_file 返回） */
export type RemoteFileContent = {
  path: string;
  content: string;
  size: number;
  modified: string | null;
  encoding: string;
  /** 本地项目文件的乐观并发版本；远程文件不提供。 */
  revision?: string | null;
};

export type ProjectTaskStatus = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export type ProjectTaskRun = {
  id: string;
  task_id: string;
  label: string;
  command: string;
  cwd: string;
  status: ProjectTaskStatus;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  output: string;
  output_truncated?: boolean;
};

export type ProjectBatchJobStatus = "queued" | "running" | "cancelling" | "succeeded" | "partial" | "failed" | "cancelled";
export type ProjectBatchFailure = { path: string; error: string };
export type ProjectBatchChange = { from: string; to: string | null };
export type ProjectBatchJob = {
  id: string;
  operation: "copy" | "move" | "delete" | string;
  root: string;
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  current_path: string | null;
  status: ProjectBatchJobStatus;
  error: string | null;
  failures: ProjectBatchFailure[];
  paths: string[];
  destination: string | null;
  changes: ProjectBatchChange[];
};

export type ProjectDeletePreview = {
  files: number;
  directories: number;
  paths: string[];
};

// =============================  Git  ================================

export type GitFileStatus = {
  path: string;
  status: string;
  staged: boolean;
};

export type GitStatusResult = {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
};

export type GitLogEntry = {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
};

export type GitDiffResult = {
  path: string;
  diff: string;
};

export type GitBranch = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
};

export type GitWorktree = {
  path: string;
  branch: string;
  isBare: boolean;
};

// =============================  Workspace  ===========================

export type WorkspaceTab = {
  id: string;
  sessionId: string;
  profileId: string | null;
  title: string;
  kind: TabKind;
  layout?: SplitNode;
  filePath?: string;
  repoPath?: string;
  remoteRoot?: string;
  source?: TabSource;
  projectId?: string | null;
  localPath?: string;
  startupCommand?: string;
  terminalView?: TerminalWorkspaceView;
  sftpOpened?: boolean;
  terminalFileSplitDirection?: "horizontal" | "vertical";
  terminalFileSplitRatio?: number;
  agentPresetId?: string;
};

export type WorkspaceSnapshot = {
  version: number;
  activeTabId: string | null;
  tabs: WorkspaceTab[];
  updatedAt: string;
};

// =============================  Project  =============================

/** 应用模式：SSH 管理 / 项目管理 */
export type AppMode = "ssh" | "project";

/** 本地项目 */
export type Project = {
  id: string;
  name: string;
  local_path: string;
  group_id: string | null;
  position?: number;
  created_at: string;
  linked_profiles: string[];
  /** 项目关联的远程工作区。旧项目仅有 linked_profiles 时视为未指定远程根目录。 */
  remote_workspaces: ProjectRemoteWorkspace[];
  agent_bindings: ProjectAgentBinding[];
};

export type ProjectAgentBinding = {
  preset_id: string;
  command_override?: string;
};

export type ProjectRemoteWorkspace = {
  profile_id: string;
  /** 空字符串表示连接后的默认目录。 */
  remote_path: string;
};

export type ProjectInput = {
  name: string;
  local_path: string;
  group_id: string | null;
  linked_profiles: string[];
  remote_workspaces: ProjectRemoteWorkspace[];
  agent_bindings: ProjectAgentBinding[];
};
