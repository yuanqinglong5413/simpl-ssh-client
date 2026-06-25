export type SessionInfo = {
  id: string;
  host: string;
  port: number;
  user: string;
  created_at: string;
};

export type ConnectionProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
};

export type Tab = {
  id: string;
  sessionId: string;
  title: string;
  kind: "terminal" | "sftp";
};

export type FileEntry = {
  name: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  modified: string | null;
};
