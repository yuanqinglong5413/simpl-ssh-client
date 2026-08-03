export class InvokeTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`命令 ${command} 在 ${timeoutMs}ms 内没有返回`);
    this.name = "InvokeTimeoutError";
  }
}

/**
 * Tauri invoke 本身没有取消正在执行的 IPC，但 UI 不能因此永久停在加载态。
 * 超时只放弃当前响应；调用方应配合 requestId/active 标记忽略迟到结果。
 */
export function invokeWithTimeout<T>(
  request: Promise<T>,
  command: string,
  timeoutMs = 12_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new InvokeTimeoutError(command, timeoutMs)), timeoutMs);
    request.then((value) => { globalThis.clearTimeout(timer); resolve(value); }, (error) => { globalThis.clearTimeout(timer); reject(error); });
  });
}
