本项目采用 **Tauri v2** 架构，将前端（React/TypeScript）与后端（Rust）的依赖管理分离，通过 `package.json` 和 `Cargo.toml` 分别维护，并利用锁文件确保构建的可重复性。

### 1. 前端依赖管理 (Node.js)
- **包管理器**: 使用 **pnpm** (版本 `11.9.0`)，在 `package.json` 中通过 `packageManager` 字段显式声明。项目根目录包含 `pnpm-workspace.yaml`，表明其具备 Monorepo 扩展能力，目前主要用于管理单一前端工作区。
- **核心依赖**: 
  - **UI 框架**: `react@^19`, `react-dom@^19`。
  - **终端组件**: `@xterm/xterm@^6.0.0` 及其插件 (`addon-fit`, `addon-search`, `addon-webgl`)。
  - **Tauri 集成**: `@tauri-apps/api@^2` 及各类官方插件 (`plugin-dialog`, `plugin-opener`, `plugin-updater` 等)。
- **锁定机制**: 使用 `pnpm-lock.yaml` (lockfileVersion: '9.0') 记录精确的版本号和完整性哈希，确保团队协作时依赖一致。

### 2. 后端依赖管理 (Rust)
- **构建工具**: 使用 **Cargo** (Rust 官方包管理器)。
- **核心依赖**:
  - **Tauri 核心**: `tauri@2` 及 `tauri-build`。
  - **SSH 协议栈**: `russh@0.61.2` (异步 SSH 实现) 和 `russh-sftp@2.3.0`。
  - **异步运行时**: `tokio@1` (features: ["full"])。
  - **系统交互**: `keyring` (密钥管理), `rfd` (文件对话框), `dirs` (路径处理)。
- **锁定机制**: 使用 `Cargo.lock` 记录整个依赖树（包括传递性依赖）的精确版本和校验和，防止因上游库更新导致的非预期行为。

### 3. 版本同步与发布
- **版本对齐**: 前端 `package.json`、后端 `Cargo.toml` 以及 Tauri 配置文件 `src-tauri/tauri.conf.json` 中的 `version` 字段均保持同步（当前为 `0.8.2`），确保应用元数据的一致性。
- **自动更新**: 通过 `tauri-plugin-updater` 配合 `tauri.conf.json` 中配置的 GitHub Release 端点和公钥，实现客户端的增量更新依赖检查。