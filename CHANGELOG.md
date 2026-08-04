# 更新日志

本项目所有值得注意的变更都记录在本文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.12.3] - 2026-08-04

### 新增
- **托管 LSP 安装体验**：应用级安装进度覆盖解析、下载、校验、解压与激活阶段，展示真实容量、速度，并支持取消和失败重试。
- **应用加密凭据仓库**：连接凭据迁移到本地 AES-256-GCM 加密存储，提供一次性钥匙串迁移与失败重试，日常连接不再反复请求系统授权。

### 变更
- **编辑器界面降噪**：移除完整路径、语言名称和正常 LSP 状态等常驻提示；无定义位置等预期空结果保持静默。
- **LSP Hover 交互**：仅在 Cmd/Ctrl 悬停符号时请求并显示，使用不透明、受视口约束且跟随主题语法配色的浮层。
- **签名托管运行时**：安装仅接受 Simpl SSH 稳定目录中的签名平台资产，不再静默调用 Homebrew、系统包管理器或 PATH 回退。

### 修复
- **浮层遮挡与配色**：修复 Hover 透明背景、超长内容撑破编辑区、层级遮挡和代码片段缺少主题高亮的问题。
- **下载状态失真**：修复安装过程长期显示 `0 MB`、切换标签丢失进度以及校验/解压阶段状态不清的问题。
- **凭据生命周期**：取消 24 小时缓存过期；退出时清理内存凭据，删除连接时同步清理加密记录。

## [0.12.2] - 2026-08-04

### 新增
- **完整资源树整理**：连接与项目支持拖入、拖出任意层级分组，同级排序、折叠分组自动展开、根节点投放，以及键盘“移动到分组”操作。
- **工作区交互统一**：标签支持拖动排序；弹出菜单统一方向键、Escape、外部点击和焦点恢复；分屏分隔条支持键盘调整与双击复位。

### 变更
- **终端快捷键路由**：终端焦点内仅保留命令面板快捷键，其余组合键完整透传给 shell、vim、Claude Code、OpenCode 等 PTY/TUI 程序。
- **SFTP 安全投放**：系统文件只允许投放到远程面板；悬停目录作为目标，空白区使用当前目录，并在入队前展示完整目标和覆盖策略。

### 修复
- **终端重复粘贴**：一次粘贴快捷键只在首次按键阶段执行，阻止 WebView 默认路径重复写入，并通过 xterm 原生粘贴保留 bracketed-paste 行为。
- **重复快捷操作**：复制、日志导出、应用快捷键和编辑器保存忽略按键自动重复，终端销毁后晚到的剪贴板结果不再写入。
- **资源排序可靠性**：资源位置迁移可安全重试，移动在 SQLite 事务中完成，写入失败不会污染内存排序状态。

## [0.12.1] - 2026-08-04

### 修复
- **Release 流水线**：`v0.12/v0.13` 未配置 updater 私钥时继续生成各平台安装包并关闭自动更新产物；`v0.14+` 仍强制要求有效的更新签名和托管 LSP 公钥。

## [0.12.0] - 2026-08-04

### 新增
- **可靠数据层**：引入版本化 SQLite 存储与旧 JSON 事务迁移，连接、项目、资源分组、工作区和命令片段写入更可靠，并支持备份、恢复与钥匙串清理重试。
- **真实资源树**：连接与项目支持任意层级分组、祖先路径搜索、键盘导航、递归删除影响预览和持久排序。
- **终端与文件工作区**：同一 SSH 标签内可在终端、SFTP 与分屏模式间切换，终端内容与 PTY 生命周期不会因打开文件面板而丢失。
- **LSP 插件目录**：插件目录作为独立工作区标签，补充托管运行时状态、校验、取消、回滚与安全回退入口。

### 变更
- **退出行为**：关闭应用会保存工作区并依次停止任务、LSP、本地 PTY、Agent、转发和 SSH 连接，不再默认隐藏到后台。
- **发布质量**：统一版本一致性、前端测试、生产构建、Bundle 预算、Rust 测试、格式和 Clippy 质量门禁。

### 修复
- **工作区可靠性**：修复恢复竞态、失效标签提示、旧请求覆盖新项目、后台监听释放及错误被静默吞掉的问题。
- **终端稳定性**：收口 WebSocket/PTY 清理、隐藏标签首次尺寸、TUI 重绘和渲染器回退状态，降低残影、空白和后台进程残留。
- **高风险操作**：分组删除、传输覆盖、同步与递归操作展示完整影响范围，失败保留为可处理活动。

## [0.11.1] - 2026-08-03

### 修复
- **托管 LSP**：未配置 Release 公钥时将空环境变量视为未配置，安全回退到系统语言服务，不再误报签名公钥长度无效。

## [0.11.0] - 2026-08-03

### 新增（体验升级 Phase 1-5）
- **终端**：复制粘贴（Ctrl+Shift+C/V/右键）、SSH keepalive 心跳、远程 GBK 编码（encoding_rs 双向）、启动命令、scrollback 可调 + 会话日志导出、WebLinks
- **会话管理**：常用命令片段（snippets）、known_hosts 管理面板、系统托盘（关闭到托盘）、OS 通知、`~/.ssh/config` 导入
- **SFTP**：双面板（左本地/右远程）、传输并发池（1-8）、暂停/继续/重试、覆盖策略（Overwrite/Skip/IfNewer/Rename）、断点续传、速度/ETA、chmod/copy、tar.gz 归档、文件名筛选
- **编辑器**：CodeMirror 6 真语法高亮（替换 textarea）
- **Git**：add/unstage/commit/push/pull（`GIT_TERMINAL_PROMPT=0` 防交互 hang）
- **效率**：多会话广播输入、命令片段 UI（⌘K 注入）

### 新增（可信工作台与开发体验）
- **项目工作台**：项目/文件/Git/任务/Agent 工作流、工作区恢复、外部文件修改保护与后台任务面板。
- **终端稳定性**：TUI 原始字节透传、Canvas/WebGL 运行时诊断、隐藏标签按需初始化及本地/远程 PTY 生命周期收口。
- **LSP**：本地语言服务、插件目录、语言与语义高亮、诊断、导航与多光标交互；托管插件目录采用签名与哈希校验。
- **可靠性与反馈**：统一加载/错误/Toast/活动时间线、传输任务聚合、可操作的工作区恢复错误。

### 变更
- **性能与发布**：首屏按需加载与 150KB gzip 预算，完整 CI 质量门禁，新增本机真实桌面启动冒烟检查。

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
- **主题系统（26 套）**：GUI 界面与 SSH 终端配色联动，涵盖 Dracula、Nord、Tokyo Night、
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

[Unreleased]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.12.3...HEAD
[0.12.3]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.12.2...v0.12.3
[0.12.2]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/yuanqinglong5413/simpl-ssh-client/compare/v0.10.1...v0.11.0
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
