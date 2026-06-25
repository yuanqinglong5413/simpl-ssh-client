# 更新日志

本项目所有值得注意的变更都记录在本文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- **SFTP 文件面板**：在会话已建立的连接上开 SFTP channel（russh-sftp），复用同一条连接。
  支持浏览、进入目录、新建 / 重命名 / 删除，作为新的"文件"标签页类型接入（侧栏文件夹按钮）。
- **文件传输**：多文件上传、整个目录递归上传、文件与目录递归下载（跳过符号链接防环），
  64KB 分块流式 + `sftp://transfer` 进度事件；本地文件对话框用 `rfd`。

### 计划中
- 凭据加密存储（OS 钥匙串 + age）
- 主机公钥校验（known_hosts）
- 分屏、连接分组树、传输队列

## [0.1.0] - 2026-06-25

### 新增
- 🎉 项目首版。
- SSH 连接（密码认证）+ 持久会话管理（`SessionManager`）。
- 交互式 PTY 终端：xterm.js（WebGL）经本地 WebSocket 与后端 russh channel 双向通信。
- 多会话、多 Tab 终端管理；切换 Tab 时后台终端保持存活。
- IDE 式工作区：侧栏连接列表 + 顶部 Tab 栏 + 终端主区 + 底部连接状态栏。
- 深墨 + 琥珀（CRT 致敬）设计系统，IBM Plex 字体，lucide 图标。
- GitHub Actions：CI 检查 + tag 触发的 macOS / Windows / Linux 多平台自动打包发布。

### 已知限制
- `check_server_key` 暂接受任意主机公钥（仅适合本地可信网络）。
- 终端走明文 `ws://`（开发模式无碍；生产环境打包后需改 wss 或走 IPC）。

[Unreleased]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yuanqinglong5413/simpl-ssh-client/releases/tag/v0.1.0
