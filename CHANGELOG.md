# 更新日志

本项目所有值得注意的变更都记录在本文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.8.3] - 2026-06-27

### 修复
- **macOS Release**：tauri-action 不再传递空的 `APPLE_ID` / `APPLE_TEAM_ID` 等 env（空字符串会误触发公证）。

## [0.8.2] - 2026-06-27

### 修复
- **Release 流水线**：Updater 预处理改用跨平台 Node 脚本（修复 Windows PowerShell 解析失败）；macOS 无 Developer ID 证书时不再注入空公证凭据（修复 `Team ID must be at least 3 characters`）。

## [0.8.1] - 2026-06-27

### 修复
- **Windows Release 构建**：X11 模块 `UnixStream` 仅在 Unix 平台编译，修复 Windows 交叉编译失败。
- **Release 流水线**：Updater 私钥无效时自动关闭 `createUpdaterArtifacts`；macOS 无证书时使用 ad-hoc 签名（`-`），不再向 tauri 传递空的 `APPLE_CERTIFICATE`。

## [0.8.0] - 2026-06-26

### 新增
- **macOS 公证流水线**：Release 工作流接入 Developer ID codesign + Apple notarize；新增 `Entitlements.plist`（WebView JIT 权限）；未配置 Apple Secrets 时仍产出未签名包，行为与 v0.7.x 兼容。

### 变更
- Release 页 macOS 安装说明：已配置 Secrets 时可直接安装；未配置时保留 `xattr -cr` 兜底提示。

## [0.7.0] - 2026-06-26

### 新增
- **X11 转发**：设置中开启后，终端 SSH 会话请求 X11 转发，远端 GUI 程序可显示到本机 DISPLAY。
- **目录同步**：SFTP 面板一键比对本地/远程目录树，按时间戳镜像/上传/下载，差异文件入传输队列。
- **自动更新**：集成 Tauri Updater，启动时可选检查 GitHub Release，设置中支持手动检查并安装。

## [0.6.0] - 2026-06-26

### 新增
- **跳板机（ProxyJump）**：连接配置可指定单跳跳板机，经 direct-tcpip 隧道连接内网目标；状态栏展示跳板路径。
- **系统监控面板**：复用已有 SSH 会话采集 Linux CPU/内存/负载/磁盘（/proc + df），2.5s 轮询，状态栏「监控」按钮打开。

## [0.5.0] - 2026-06-26

### 新增
- **连接分组树**：侧栏按分组折叠展示已保存连接，支持新建/重命名/删除分组；编辑连接时可指定分组。
- **断线自动重连**：通过已保存连接建立的会话断线后自动重试（可配置次数），toast 通知重连进度。
- **全局快捷键**：Ctrl+N 新建连接、Ctrl+W 关闭 Tab、Ctrl+Tab 切换 Tab、Ctrl+, 打开设置。
- **设置面板**：终端字体/字号/行高/光标样式、断线重连策略，持久化至 localStorage。

## [0.4.0] - 2026-06-26

### 新增
- **PTY 动态 resize**：窗口缩放 / 分屏拖拽时自动同步远端终端尺寸（vim/htop 布局正常）。
- **连接配置编辑**：侧栏铅笔按钮编辑已保存连接，支持更新主机/用户/认证方式。
- **终端搜索**：Ctrl+F / Cmd+F 打开搜索栏，Enter / Shift+Enter 导航匹配项。
- **SSH 私钥认证**：连接与保存配置均支持密码 / 私钥两种方式，私钥 passphrase 存钥匙串。

## [0.3.2] - 2026-06-26

### 新增
- **主题系统（21 套）**：GUI 界面与 SSH 终端配色联动，涵盖 Dracula、Nord、Tokyo Night、
  Catppuccin、Solarized 等经典方案；状态栏「主题」按钮切换，选择持久化至 localStorage。
- **终端完整 ANSI 16 色调色板**：`ls --color`、`grep --color` 等远端彩色输出正常显示。
- **纯文本日志语法高亮**：`cat`/`tail` 无 ANSI 的日志按 ERROR/WARN/INFO/DEBUG 级别、
  时间戳、HTTP 状态码自动着色，解决日志全文同一颜色的问题。

## [0.3.1] - 2026-06-26

### 变更
- **macOS 安装说明**：未公证的 release 包会被 Gatekeeper 标「已损坏」，README 改为给出
  `xattr -cr` 清隔离属性的实际有效处理（非真损坏）；Release 页也加了同样提示。
- 路线图补 **macOS 公证（codesign + notarize）**。

> ⚠️ 本版 mac 包仍未公证。首次打开若提示「已损坏」，终端执行
> `xattr -cr "/Applications/Simpl SSH.app"` 后即可正常打开。

## [0.3.0] - 2026-06-26

### 新增
- **主机公钥校验（known_hosts）**：连接时在 `~/.ssh/known_hosts` 中校验服务器公钥
  （复用 russh 的 OpenSSH 兼容实现）。首次连接走 TOFU——弹窗展示算法与 `SHA256:...`
  指纹供用户核对后显式信任；已记录主机的公钥变更会被拦截并警示（疑似中间人攻击），
  需用户确认后才替换。写入格式与 `ssh` CLI 一致，已有 known_hosts 条目直接生效。
  修复了此前 `check_server_key` 接受任意公钥的 MITM 风险。
- **自定义应用图标**：深墨 + 琥珀的终端主题图标（`>` 提示符 + 光标块 + 交通灯圆点窗口），
  替换默认 Tauri logo；源 SVG 留档 `src-tauri/app-icon.svg`，`tauri icon` 生成全套格式。

### 修复
- **发版流水线**：v0.2.0 三平台发版在 `Setup Node` 步全失败——`actions/setup-node@v4`
  启用 pnpm 缓存时要求 `package.json` 声明 `packageManager`。补 `pnpm@11.9.0` 修复，
  本地 release 构建（`.app` / `.dmg` 含新图标）验证通过。

## [0.2.0] - 2026-06-26

### 新增
- **SFTP 文件面板**：在会话已建立的连接上开 SFTP channel（russh-sftp），复用同一条连接。
  支持浏览、进入目录、新建 / 重命名 / 删除，作为新的"文件"标签页类型接入。
- **文件传输**：多文件上传、整个目录递归上传、文件与目录递归下载（跳过符号链接防环），
  64KB 分块流式 + 进度事件；本地文件对话框用 `rfd`。
- **保存的连接（连接配置）**：侧栏连接库，一键直连；元数据存本地 JSON，密码存 OS 钥匙串不落明文。
- **连接进度反馈**：连接过程拆为「解析主机 → 加密握手 → 身份认证」三段，各自带超时
  （12 / 15 / 12 秒，不通即快速失败而非挂死），并通过 `ssh://progress` 事件推送阶段进度；
  连接弹窗与一键连接浮层展示步骤指示器，终端就绪前显示占位，告别黑盒"连接中…"。
- **密码内存加密缓存**：钥匙串密码读出后以 AES-256-GCM 加密缓存在进程内存
  （key 由机器唯一 ID + 应用盐派生），24h 内重复连接不再访问钥匙串、不再弹系统授权框；
  进程退出即清空，删除配置时同步清理。
- **终端分屏**：树形布局（左右 / 上下递归切分），同一会话可并排多个独立 PTY；
  拖拽分隔条调比例、关闭面板自动坍缩、当前获焦面板高亮。
- **SFTP 传输队列**：传输任务排队串行执行、可随时取消、不再阻塞文件浏览；
  "选文件"与"执行传输"解耦；`transfer://progress` / `transfer://state` 事件 + 全局传输面板。
- **端口转发**：本地 `-L` / 远程 `-R` / 动态 SOCKS5 `-D` 全套；`-R` 经 `ClientHandler`
  回调桥接进来的连接，SOCKS5 协议自行实现；断开会话时自动停止其所有转发。

### 变更
- **侧栏重构**：移除与顶部 Tab 重叠的"活动会话"列表，侧栏只保留连接库；
  「打开文件面板」「断开」挪到底部状态栏，针对当前活动会话。

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

[Unreleased]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.8.3...HEAD
[0.8.3]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yuanqinglong5413/simpl-ssh-client/releases/tag/v0.1.0
