<div align="center">

# simpl-ssh

**一个把 Xshell 和 Xftp 合二为一的轻量 SSH 客户端** · 用 Rust 写

终端 + 文件管理器，共享同一条 SSH 连接，跑在一个窗口里。

[![CI](https://github.com/yuanqinglong5413/simpl-ssh-client/actions/workflows/ci.yml/badge.svg)](https://github.com/yuanqinglong5413/simpl-ssh-client/actions/workflows/ci.yml)
[![Release](https://github.com/yuanqinglong5413/simpl-ssh-client/actions/workflows/release.yml/badge.svg)](https://github.com/yuanqinglong5413/simpl-ssh-client/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Made with Rust](https://img.shields.io/badge/made%20with-Rust-dea584.svg)](https://www.rust-lang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2-FFC131.svg)](https://tauri.app)

</div>

---

## 为什么再做一个

市面上的 SSH 客户端大多要么**重**（FinalShell 吃 1.7GB 内存、Electron 系打包 Chromium）、要么**割裂**（Xshell 和 Xftp 是两个软件来回切）、要么**收费 / 闭源**（Termius 高级功能要订阅）。`simpl-ssh` 想做的是：

- **合体** —— 终端和文件管理器在同一个窗口，复用一条 SSH 连接，不用切软件、不用二次认证。
- **轻** —— Rust 后端 + Tauri（用系统 WebView，不打包 Chromium），目标内存 ~34MB、安装包 <10MB。
- **开放** —— MIT 协议、完全免费、凭据本地加密不上云。

## ✨ 特性

- 🔌 **多会话管理** —— 侧栏连接库，一键开终端；多 Tab，切换 Tab 时后台终端不被打断。
- 💾 **保存的连接** —— 连接配置存本地，密码进系统钥匙串（不落明文）；24h 内重复连接走内存加密缓存，不再反复弹授权框。
- 💻 **交互式终端** —— xterm.js v6（WebGL 加速），完整 PTY，支持 vim / htop / tmux 等交互程序。
- 📂 **SFTP 文件面板** —— 与终端共享同一条 SSH 连接，浏览 / 上传 / 下载 / 目录递归传输，带进度。
- ⏱ **连接进度可见** —— 解析 → 握手 → 认证 分段超时 + 阶段反馈，告别黑盒"连接中…"。
- 🎨 **现代暗色界面** —— 深墨 + 琥珀（CRT 致敬）配色，IBM Plex 字体，IDE 式布局。
- 🖥 **三端** —— macOS / Windows / Linux。

## 📷 截图

> 把窗口截图保存为 `docs/screenshot.png` 后这里会自动显示。

![screenshot](docs/screenshot.png)

## 📦 下载安装

到 [Releases 页](https://github.com/yuanqinglong5413/simpl-ssh-client/releases) 下载对应平台安装包：

| 平台 | 文件 |
|------|------|
| macOS (Apple Silicon) | `*.dmg` (aarch64) |
| macOS (Intel) | `*.dmg` (x64) |
| Windows | `*-setup.exe` / `*.msi` |
| Linux | `*.AppImage` / `*.deb` |

> macOS 首次打开若提示"无法验证开发者"，到 *系统设置 → 隐私与安全性* 里点"仍要打开"即可。

## 🛠 从源码构建

**前置要求**：[Node.js](https://nodejs.org/) ≥ 20、[pnpm](https://pnpm.io/) 11、[Rust](https://www.rust-lang.org/) (stable)。

```bash
git clone https://github.com/yuanqinglong5413/simpl-ssh-client.git
cd simpl-ssh-client
pnpm install

# 开发模式（热重载）
pnpm tauri dev

# 打包当前平台的安装包
pnpm tauri build
```

Linux 还需要系统依赖：

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

## 🧱 技术栈

| 层 | 选型 |
|----|------|
| 前端 | React 19 · TypeScript · xterm.js v6（WebGL） |
| 桥接 | Tauri 2（系统 WebView） |
| SSH 协议 | [russh](https://github.com/Eugeny/russh) + russh-sftp（纯 Rust、async） |
| 终端传输 | tokio-tungstenite（PTY 走本地 WebSocket 流式） |
| 异步 | tokio |
| 字体 / 图标 | IBM Plex · lucide |

## 📁 项目结构

```
simpl-ssh-client/
├── src/                      # 前端 (React)
│   ├── components/           # Sidebar / TabBar / StatusBar / ConnectDialog / TerminalPane
│   ├── App.tsx               # 工作区外壳（侧栏 + Tab + 终端 + 状态栏）
│   └── App.css               # 设计系统（深墨 + 琥珀）
├── src-tauri/                # Rust 后端
│   └── src/
│       ├── commands.rs       # 暴露给前端的 Tauri 命令
│       └── session/
│           ├── manager.rs    # 会话池（持久连接，终端/SFTP 共享）
│           ├── pty.rs        # PTY channel + 本地 WebSocket 终端传输
│           ├── sftp.rs       # SFTP 文件传输（复用会话连接）
│           ├── profile.rs    # 保存的连接配置 + 钥匙串
│           ├── secrets.rs    # 密码内存加密缓存（AES-256-GCM）
│           └── ssh.rs        # russh 连接 / 认证
├── .github/workflows/        # CI 检查 + 多平台自动打包发布
└── docs/DESIGN.md            # 设计与架构
```

## 🗺 路线图

- [x] SSH 连接（密码认证）+ 交互式 PTY 终端
- [x] 多会话、多 Tab 终端管理
- [x] **SFTP 文件面板**（浏览 / 上传 / 下载 / 目录递归传输）
- [x] **保存的连接** + 凭据加密存储（OS 钥匙串 + 内存 AES-256-GCM 缓存）
- [x] 连接过程分段超时 + 阶段进度反馈
- [ ] 主机公钥校验（known_hosts）
- [ ] 分屏、连接分组树、传输队列
- [ ] 系统监控面板、端口转发、跳板机

详见 [docs/DESIGN.md](docs/DESIGN.md)。

## ⚠️ 安全提示

当前为早期版本（v0.1.x）：`check_server_key` 暂时**接受任意主机公钥**（仅适合本地可信网络），正式校验 `known_hosts` 在路线图中。生产敏感场景请暂缓，或先在受控环境使用。

## 🤝 参与贡献

欢迎 Issue 和 PR。开发请走 `pnpm tauri dev`，提交前确保 `pnpm build` 与 `cargo check` 通过。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 📄 许可证

[MIT](LICENSE) © 2026 yuanqinglong5413

## 🙏 鸣谢

- [russh](https://github.com/Eugeny/russh) —— 纯 Rust 的 SSH 实现
- [Tauri](https://tauri.app) —— 用系统 WebView 做桌面应用
- [R-Shell](https://github.com/GOODBOY008/r-shell) —— 同类技术栈的优秀参考
- [xterm.js](https://github.com/xtermjs/xterm.js) · [Tabby](https://tabby.sh) · IBM Plex
