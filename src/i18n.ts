import i18n from "i18next";
import { initReactI18next } from "react-i18next";

const STORE_KEY = "simpl-ssh-lang";

/**
 * i18n 框架。所有新增界面文案应从这里取值，避免组件继续硬编码语言；
 * 其余组件文案的完整抽取/翻译作为后续专项（涉及全 UI 文案）。
 */
i18n.use(initReactI18next).init({
  resources: {
    zh: {
      translation: {
        status: {
          connected: "已连接",
          ready: "就绪",
          panels: "个打开的面板",
          monitor: "监控",
          git: "Git",
          files: "文件",
          disconnect: "断开",
          broadcast: "广播",
          snippets: "片段",
          transfers: "传输",
          settings: "设置",
        },
      },
    },
    en: {
      translation: {
        status: {
          connected: "Connected",
          ready: "Ready",
          panels: "open pane(s)",
          monitor: "Monitor",
          git: "Git",
          files: "Files",
          disconnect: "Disconnect",
          broadcast: "Broadcast",
          snippets: "Snippets",
          transfers: "Transfers",
          settings: "Settings",
        },
      },
    },
  },
  lng: localStorage.getItem(STORE_KEY) || "zh",
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
});

/** 切换语言并持久化。 */
export function changeLanguage(lng: string) {
  localStorage.setItem(STORE_KEY, lng);
  void i18n.changeLanguage(lng);
  document.documentElement.lang = lng === "en" ? "en" : "zh-CN";
}

// 同步初始 <html lang>
document.documentElement.lang =
  (localStorage.getItem(STORE_KEY) || "zh") === "en" ? "en" : "zh-CN";

export default i18n;
