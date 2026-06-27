该项目采用 **Tauri v2** 框架作为核心构建系统，结合 **pnpm workspace**、**Vite** 和 **Cargo** 实现前端（React/TypeScript）与后端（Rust）的统一管理与编译。整个构建流程高度依赖 GitHub Actions 进行持续集成（CI）与多平台自动化发布。

### 1. 构建工具链与架构
- **前端构建**：使用 `Vite` + `@vitejs/plugin-react`。在开发模式下，Vite 运行在固定端口 `1420`，并通过 HMR 提供热更新；在生产构建时，执行 `tsc && vite build` 生成静态资源至 `dist/` 目录。
- **后端构建**：使用 `Cargo` 管理 Rust 依赖。通过 `tauri-build` 插件在编译期处理 Tauri 相关的元数据与能力配置。
- **统一编排**：`tauri.conf.json` 定义了前后端构建的衔接点：
  - `beforeDevCommand`: `pnpm dev`
  - `beforeBuildCommand`: `pnpm build`
  - `frontendDist`: `../dist`

### 2. 版本管理与同步
项目采用统一的语义化版本号（当前为 `0.8.2`），该版本号在以下三个关键文件中保持严格同步：
- `package.json` (前端)
- `src-tauri/Cargo.toml` (后端)
- `src-tauri/tauri.conf.json` (Tauri 配置)

### 3. 持续集成 (CI) 规范
`.github/workflows/ci.yml` 定义了严格的代码质量门禁：
- **环境**：Ubuntu 22.04，Node.js 22，Stable Rust。
- **检查项**：
  - 前端类型检查与构建 (`pnpm build`)。
  - Rust 代码格式化检查 (`cargo fmt --check`)。
  - Rust 静态分析 (`cargo clippy -- -D warnings`)，禁止任何警告。
  - 单元测试 (`cargo test`)。

### 4. 自动化发布流程 (Release)
`.github/workflows/release.yml` 实现了基于 Git Tag (`v*`) 的多平台打包策略：
- **目标平台**：同时支持 macOS (aarch64/x86_64)、Windows 和 Linux (AppImage/deb)。
- **签名与公证**：
  - **Updater**：通过 `prepare-release.mjs` 脚本动态校验 `TAURI_SIGNING_PRIVATE_KEY`，若密钥无效则自动关闭 updater 产物生成，防止构建失败。
  - **macOS**：支持导入 Developer ID 证书进行代码签名，并可选配置 Apple Notarization（公证）以绕过 Gatekeeper 限制。若未配置证书，则回退到 ad-hoc 签名。
- **产物分发**：构建完成后自动创建 GitHub Draft Release，包含所有平台的安装包及 `latest.json` 更新清单。

### 5. 开发者遵循规则
- **依赖管理**：必须使用 `pnpm` 安装依赖，并在 CI 中使用 `--frozen-lockfile` 确保一致性。
- **构建命令**：本地开发使用 `pnpm tauri dev`，生产打包使用 `pnpm tauri build`。
- **跨平台兼容性**：修改 `tauri.conf.json` 或 `Cargo.toml` 中的版本号时，需确保三处定义保持一致。
- **安全配置**：涉及签名的敏感信息（如 `APPLE_CERTIFICATE`, `TAURI_SIGNING_PRIVATE_KEY`）必须通过 GitHub Secrets 注入，严禁硬编码。