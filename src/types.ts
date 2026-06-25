export type SessionInfo = {
  id: string;
  host: string;
  port: number;
  user: string;
  created_at: string;
};

export type Tab = {
  id: string;
  sessionId: string;
  title: string;
};
