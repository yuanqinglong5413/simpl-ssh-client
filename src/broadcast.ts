import { createContext, useContext } from "react";

/**
 * 多会话广播输入：开启后，当前终端的键盘输入会 fan-out 到所有其他已打开的终端，
 * 实现「同时在多台机器执行相同命令」（运维批量操作）。
 *
 * peers: sessionId → WebSocket（每个远程终端注册自己的 WS）。
 */
export type BroadcastCtx = {
  enabled: boolean;
  peers: Map<string, WebSocket>;
  register: (id: string, ws: WebSocket) => void;
  unregister: (id: string) => void;
};

export const BroadcastContext = createContext<BroadcastCtx | null>(null);

export function useBroadcast(): BroadcastCtx | null {
  return useContext(BroadcastContext);
}
