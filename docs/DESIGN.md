# Simpl SSH — 设计文档

> Xshell + Xftp 的轻量合体：一个窗口里同时有终端和文件管理器，共享同一条 SSH 连接。
> 技术栈 Rust + Tauri 2。本文是项目的总体设计与路线图。

## 1. 目标与定位

- **对标**：Xshell/Xftp（割裂）、FinalShell（重，~1.7GB 内存）、Electerm/Tabby（Electron 重）、Termius（付费）。
- **卖点**：合体（终端+SFTP 一体）、轻量（Rust 后端，目标 ~34MB 内存、<10MB 安装包）、开源免费、三端（macOS/Windows/Linux）。
- **核心架构共识**：SFTP 复用终端的 SSH 连接，不单独认证（参考 Tabby/Electerm/R-Shell）。

## 2. 技术栈（已锁定）

| 层 | 选型 | 说明 |
|----|------|------|
| 前端 | React 19 + TS + Tailwind + shadcn/ui | UI 层 |
| 终端渲染 | xterm.js v5（WebGL） | vim/htop/tmux 全兼容，硬件加速 |
| 桥接 | Tauri 2 | 系统 webview，不打包 Chromium |
| SSH 协议 | russh + russh-sftp | 纯 Rust、async；作者同时维护 Tabby |
| 异步运行时 | tokio（full） | |
| PTY 流式 | tokio-tungstenite | 终端 I/O 走 WebSocket，低延迟（参考 ttyd） |
| 凭据存储 | keyring（OS 钥匙串）+ age | 密码/密钥不明文落盘 |

加密后端：russh 默认 `aws-lc-rs`（本机已装 cmake 以支持其构建）。

## 3. 架构

```
前端 React (xterm.js / 文件列表)
        │  Tauri IPC + WebSocket
Rust 后端核心
  ├── SessionManager   一个连接 = 一个 Session，Arc 共享给终端与 SFTP
  │     ├── PTY channel   → WebSocket → xterm.js
  │     └── SFTP channel  → list/upload/download 命令
  ├── russh (SSH 协议)
  └── ProfileStore      连接配置 + 凭据加密
```

**数据流（打开连接）**：前端 `connect(profile)` → russh 建连认证拿 `Handle` → 开 PTY channel 起 WebSocket 桥到 xterm.js → 同一 `Handle` 开 SFTP channel → Handle 存入 `SessionManager` 供两个 Tab 共享。

## 4. 模块拆分（src-tauri/src/）

```
main.rs              入口
lib.rs               Tauri Builder、命令注册
commands.rs          暴露给前端的 IPC 命令（薄封装）
session/
  ├── mod.rs
  ├── ssh.rs         russh 连接 + 认证（已实现 demo）
  ├── manager.rs     会话池（待实现）
  └── pty.rs         PTY channel + WebSocket 桥（待实现）
sftp/
  ├── client.rs      russh-sftp 封装（待实现）
  └── transfer.rs    上传/下载/队列/续传（待实现）
profile/
  ├── store.rs       连接配置持久化（待实现）
  └── crypto.rs      凭据加密（待实现）
websocket_server.rs  PTY 流式传输（待实现）
```

## 5. 关键技术点与坑

| 难点 | 方案 |
|------|------|
| 终端+SFTP 共享连接 | 一个 russh `Handle` 开多 channel；`SessionManager` 用 `Arc` 持有 |
| 大数据流不卡 UI | PTY 走 WebSocket 独立通道；文件进度用 Tauri 事件 `emit` |
| 凭据安全 | `keyring` 存 OS 钥匙串；配置文件 age 加密；绝不明文 |
| 中文输入法 (IME) | xterm.js 已支持；早期就测 UTF-8 / 中文路径 |
| 主机公钥校验 | `known_hosts` 校验；未知主机回调前端确认（当前 demo 暂时全接受，**仅本地用**） |
| 大文件传输 | 分块 + 进度 + 取消；递归目录限并发 |
| 断线重连 | 指数退避；Session 状态机 |

## 6. 路线图

- **MVP**：单/多连接 + 多 Tab + 分屏（递归网格）+ 基础 SFTP（浏览/上传/下载）+ 连接配置保存。
  - 实现顺序：先打通纵向链路（连接→终端→同连 SFTP）→ 加多 Tab → 最后加分屏。
- **v1**：SFTP 完整操作、凭据加密、连接分组/标签、传输队列、主题字体快捷键。
- **v2**：系统监控面板（学 FinalShell 但轻量）、端口转发、跳板机/X11、目录同步、自动更新。

## 7. 参考

- **R-Shell**（最直接参考，几乎同栈）：https://github.com/GOODBOY008/r-shell
- russh / russh-sftp：https://github.com/Eugeny/russh
- Tabby（插件化、SFTP 复用连接）：https://tabby.sh/
- Electerm（协议最全）：https://github.com/electerm/electerm
- xterm.js：https://github.com/xtermjs/xterm.js
