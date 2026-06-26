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

export type ProfileGroup = {
  id: string;
  name: string;
  order: number;
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
  /** 跳板机：引用另一个已保存连接的 id */
  jump_profile_id?: string | null;
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

export type Tab = {
  id: string;
  sessionId: string;
  title: string;
  kind: "terminal" | "sftp" | "monitor";
  /** 仅 terminal Tab 用：终端分屏布局。 */
  layout?: SplitNode;
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
