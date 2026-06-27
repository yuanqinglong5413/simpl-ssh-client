该应用采用**分层、多源**的配置系统，根据数据的敏感性和用途将其分散在不同的存储介质中，实现了安全性与便捷性的平衡。

### 1. 核心架构与策略

*   **前端 UI/偏好配置 (Client-side)**:
    *   **存储位置**: `localStorage`。
    *   **内容**: 终端字体、字号、光标样式、自动重连设置、主题 ID 等。
    *   **实现**: 通过 React Context (`SettingsProvider`, `ThemeProvider`) 进行管理。启动时从 `localStorage` 加载并合并默认值，变更时同步写入。
    *   **特点**: 轻量、即时生效，不跨设备同步。

*   **后端连接元数据 (Persistent JSON)**:
    *   **存储位置**: 操作系统配置目录 (`dirs::config_dir()`) 下的 `simpl-ssh/profiles.json`。
    *   **内容**: SSH 连接的名称、主机、端口、用户名、认证方式（密码/私钥）、私钥路径、分组及跳板机引用。
    *   **实现**: Rust 端的 `ProfileStore` 负责序列化/反序列化。使用 `serde_json` 进行持久化。
    *   **特点**: 结构化存储，便于管理和迁移，但不包含敏感信息。

*   **敏感凭据 (OS Keyring + Encrypted Cache)**:
    *   **存储位置**: 操作系统钥匙串 (Keychain/Keyring) + 进程内存加密缓存。
    *   **内容**: SSH 登录密码、私钥 Passphrase。
    *   **安全机制**:
        1.  **持久层**: 使用 `keyring` crate 将密码存入 OS 原生钥匙串，确保**不落明文磁盘**。
        2.  **缓存层**: 为避免 macOS 等平台频繁弹出钥匙串授权框，实现了 `PasswordCache`。从钥匙串读取后，密码在内存中使用 **AES-256-GCM** 加密缓存，密钥由机器唯一 ID 派生。
        3.  **生命周期**: 缓存有效期为 24 小时，进程退出即清空，兼顾了用户体验与内存安全。

*   **工作区状态 (Session State)**:
    *   **存储位置**: `simpl-ssh/workspace.json` (同配置目录)。
    *   **内容**: 前端 Tab 布局、分屏状态等会话快照。
    *   **实现**: `WorkspaceStore` 提供简单的读写接口，支持启动时恢复上次的工作区。

*   **应用级配置 (Tauri Config)**:
    *   **存储位置**: `src-tauri/tauri.conf.json`。
    *   **内容**: 窗口大小、构建命令、Updater 公钥、Bundle 信息等。
    *   **特点**: 编译期确定，用于 Tauri 框架初始化和打包。

### 2. 关键文件与模块

| 文件/模块 | 职责 |
| :--- | :--- |
| `src/settings/types.ts` | 定义前端 `AppSettings` 类型及默认值 |
| `src/settings/SettingsProvider.tsx` | 前端设置 Context，处理 `localStorage` 读写 |
| `src/theme/ThemeProvider.tsx` | 主题管理 Context，同步 CSS 变量与 `localStorage` |
| `src-tauri/src/session/profile.rs` | 后端连接配置管理，协调 JSON 存储与 Keyring 交互 |
| `src-tauri/src/session/secrets.rs` | 内存加密缓存实现 (AES-256-GCM)，减少 Keyring 访问频率 |
| `src-tauri/src/session/workspace.rs` | 工作区状态持久化逻辑 |
| `src-tauri/tauri.conf.json` | Tauri 应用基础配置 |

### 3. 开发者规范

1.  **严禁明文存储**: 任何密码、Passphrase 或私钥内容**绝对禁止**直接写入 `profiles.json` 或 `localStorage`。必须通过 `ProfileStore` 的 `store_credentials` 流程存入 Keyring。
2.  **配置分层**: 
    *   UI 表现层配置放在前端 `localStorage`。
    *   业务元数据（如主机名）放在后端 JSON。
    *   敏感数据走 Keyring。
3.  **缓存一致性**: 当用户在 UI 中更新密码或删除连接时，必须同步调用 `ProfileStore` 的清理方法，确保 Keyring 和内存缓存 (`PasswordCache`) 中的数据被及时移除或更新。
4.  **错误处理**: 读取 Keyring 或解析 JSON 时应具备容错能力（如 `profiles.json` 损坏时回退到空列表），避免应用崩溃。