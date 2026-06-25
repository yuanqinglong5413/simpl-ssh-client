# 更新日志

本项目所有值得注意的变更都记录在本文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- **SFTP 文件面板**：在会话已建立的连接上开 SFTP channel（russh-sftp），复用同一条连接。
  支持浏览、进入目录、新建 / 重命名 / 删除，作为新的"文件"标签页类型接入。
- **文件传输**：多文件上传、整个目录递归上传、文件与目录递归下载（跳过符号链接防环），
  64KB 分块流式 + `sftp://transfer` 进度事件；本地文件对话框用 `rfd`。
- **保存的连接（连接配置）**：侧栏连接库，一键直连；元数据存本地 JSON，密码存 OS 钥匙串不落明文。
- **连接进度反馈**：连接过程拆为「解析主机 → 加密握手 → 身份认证」三段，各自带超时
  （12 / 15 / 12 秒，不通即快速失败而非挂死），并通过 `ssh://progress` 事件推送阶段进度；
  连接弹窗与一键连接浮层展示步骤指示器，终端就绪前显示占位，告别黑盒"连接中…"。
- **密码内存加密缓存**：钥匙串密码读出后以 AES-256-GCM 加密缓存在进程内存
  （key 由机器唯一 ID + 应用盐派生），24h 内重复连接不再访问钥匙串、不再弹系统授权框；
  进程退出即清空，删除配置时同步清理。

### 变更
- **侧栏重构**：移除与顶部 Tab 重叠的"活动会话"列表，侧栏只保留连接库；
  「打开文件面板」「断开」挪到底部状态栏，针对当前活动会话。

### 计划中
- 主机公钥校验（known_hosts）
- 分屏、连接分组树、传输队列、系统监控、端口转发、跳板机

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
