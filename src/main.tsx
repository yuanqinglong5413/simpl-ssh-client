import ReactDOM from "react-dom/client";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import App from "./App";

// 注意：不使用 React.StrictMode —— 它在 dev 下会双次挂载 effect，导致终端
// 的 terminal_open + WebSocket 被连开两次（产生多余的远端 shell）。终端这类
// 有副作用的组件需要稳定的单次生命周期。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
