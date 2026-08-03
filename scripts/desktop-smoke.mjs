/**
 * Starts the real Tauri development window, waits until the Rust binary has
 * been launched, then shuts it down. This is intentionally opt-in: desktop
 * GUI availability varies across CI runners, so the normal quality gate keeps
 * deterministic unit/build checks while maintainers run this on each desktop
 * platform before release.
 */
import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(command, ["tauri:dev"], {
  cwd: process.cwd(),
  env: { ...process.env, CI: "true" },
  stdio: ["ignore", "pipe", "pipe"],
  // Tauri dev 会再派生 Vite 与桌面进程；Unix 上必须单独建立进程组，才能
  // 在成功判定后一起回收，而不是只结束 pnpm 外壳。
  detached: process.platform !== "win32",
});

let output = "";
let ready = false;
let stopped = false;
const timeout = setTimeout(() => stop(new Error("桌面窗口未在 90 秒内启动")), 90_000);

function collect(chunk) {
  output += chunk.toString();
  if (!ready && /target\/debug\/simpl-ssh|target\\debug\\simpl-ssh/.test(output)) {
    ready = true;
    setTimeout(() => stop(), 750);
  }
}

function stop(error) {
  if (stopped) return;
  stopped = true;
  clearTimeout(timeout);
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
  } else if (child.pid) {
    try {
      process.kill(-child.pid, "SIGINT");
    } catch {
      child.kill("SIGINT");
    }
  }
  if (error) {
    console.error(error.message);
    console.error(output.slice(-4_000));
    process.exitCode = 1;
  }
}

child.stdout.on("data", collect);
child.stderr.on("data", collect);
child.on("error", (error) => stop(error));
child.on("exit", (code) => {
  clearTimeout(timeout);
  if (!ready) {
    console.error("桌面应用未启动成功。");
    console.error(output.slice(-4_000));
    process.exitCode = 1;
    return;
  }
  console.log(`桌面启动冒烟通过（进程退出码 ${code ?? "signal"}）。`);
  process.exit(0);
});
