import { useCallback, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask } from "@tauri-apps/plugin-dialog";

type UpdateState = {
  checking: boolean;
  message: string;
};

/** 检查 GitHub Release 更新并可选安装重启。 */
export function useUpdater() {
  const [state, setState] = useState<UpdateState>({
    checking: false,
    message: "",
  });

  const checkForUpdates = useCallback(async (silent = false) => {
    // 开发窗口使用独立 Bundle ID，不能也不应查询正式 Release 更新；否则每次
    // 启动都会在后端留下一个无意义的 updater 错误。
    if (import.meta.env.DEV) {
      setState({
        checking: false,
        message: silent ? "" : "开发环境不检查正式版更新",
      });
      return;
    }
    setState({ checking: true, message: "正在检查更新…" });
    try {
      const update = await check();
      if (!update) {
        setState({ checking: false, message: silent ? "" : "当前已是最新版本" });
        return;
      }
      const notes = update.body?.trim();
      const detail = notes
        ? `\n\n${notes.slice(0, 400)}${notes.length > 400 ? "…" : ""}`
        : "";
      const yes = await ask(
        `发现新版本 ${update.version}，是否下载并安装？${detail}`,
        { title: "软件更新", kind: "info" }
      );
      if (!yes) {
        setState({ checking: false, message: "已取消更新" });
        return;
      }
      setState({ checking: true, message: `正在下载 ${update.version}…` });
      await update.downloadAndInstall();
      const restart = await ask("更新已安装，是否立即重启应用？", {
        title: "重启应用",
        kind: "info",
      });
      if (restart) await relaunch();
      setState({ checking: false, message: "更新完成，请重启应用" });
    } catch (e) {
      setState({
        checking: false,
        message: silent ? "" : `检查更新失败：${String(e)}`,
      });
    }
  }, []);

  return { ...state, checkForUpdates };
}
