该 Tauri SSH 客户端应用在后端 Rust 核心中采用了一套基于 `anyhow` 和标准库 `Result` 的混合错误处理策略，并通过 Tauri 的命令边界将内部错误转换为前端可消费的字符串消息。以下是详细的架构分析：

### 1. 核心错误处理系统
*   **错误库选择**：后端主要使用 [`anyhow`](https://docs.rs/anyhow) 作为错误上下文管理工具。在会话管理、认证和底层 SSH 操作中，广泛使用 `anyhow::Result<T>` 和 `anyhow::bail!` / `anyhow::anyhow!` 宏来快速构造和传播错误。
*   **命令边界转换**：所有暴露给前端的 Tauri 命令（位于 `src-tauri/src/commands.rs`）统一使用 `Result<T, String>` 作为返回类型。内部产生的 `anyhow::Error` 或特定库错误（如 `russh::Error`）通过 `.map_err(|e| e.to_string())` 转换为简单的字符串错误消息。这种设计简化了前端与后端的通信协议，但牺牲了结构化错误信息。
*   **无自定义错误类型**：代码库中未定义全局的 `enum Error` 或实现 `std::error::Error` 的自定义错误类型。错误语义主要通过错误消息字符串的内容来区分（例如 "session not found" vs "auth failed"）。

### 2. 关键模块的错误处理模式
*   **会话管理 (`session/manager.rs`)**：
    *   使用 `anyhow::Result` 处理连接过程中的复杂错误链（TCP 超时、SSH 握手失败、认证错误）。
    *   通过 `emit_progress` 向发送 Tauri 事件 (`ssh://progress`) 来异步报告连接阶段状态，即使最终失败，前端也能收到中间状态更新。
    *   对于跳板机连接，错误会明确区分是跳板机连接失败还是目标主机连接失败。
*   **主机密钥校验 (`session/known_hosts.rs`)**：
    *   采用“探测-确认”模式。当 `check_server_key` 遇到未知或变更的主机密钥时，不直接抛出致命错误终止进程，而是返回 `Ok(false)` 让 russh 中止握手，同时通过 Tauri 事件 (`ssh://hostkey`) 通知前端。
    *   用户在前端确认后，调用 `hostkey_trust` 命令，此时若文件 I/O 失败则返回 `Result<(), String>` 错误。
*   **配置与凭据 (`session/profile.rs`)**：
    *   所有涉及钥匙串（keyring）操作和文件 I/O 的方法均返回 `Result<T, String>`。
    *   在保存或更新配置时，对输入参数进行严格校验（如密码不能为空、跳板机不能指向自身），校验失败直接返回描述性错误字符串。
*   **SFTP 与文件操作 (`session/sftp.rs`, `commands.rs`)**：
    *   SFTP 会话的建立和操作错误（如权限不足、文件不存在）直接映射为字符串错误。
    *   在 `sftp_read_file` 中，对文件大小和二进制内容进行了前置检查，若不满足条件则提前返回友好的错误提示（如 "文件过大" 或 "不支持编辑二进制文件"）。

### 3. 前端错误呈现
*   **统一的消息框**：前端 React 组件（如 `ConnectDialog.tsx`, `SettingsDialog.tsx`）在调用 Tauri 命令时，通常使用 `try/catch` 捕获错误。由于后端返回的是 `String`，前端直接将捕获到的错误消息显示在 UI 的提示框或状态栏中。
*   **进度反馈**：对于耗时操作（如连接、传输），前端监听 `ssh://progress` 和 `ssh://hostkey` 事件，根据事件中的 `kind` 或 `stage` 字段展示不同的 UI 状态（如加载动画、公钥确认弹窗）。

### 4. 开发者规范与建议
*   **命令层转换**：在编写新的 Tauri 命令时，务必将内部 `anyhow::Error` 或其他库错误转换为 `String`。建议使用 `.map_err(|e| e.to_string())` 或提供更具业务含义的错误消息（如 `Err("无法连接到主机".to_string())`）。
*   **避免 Panic**：在生产代码中严禁使用 `unwrap()` 或 `expect()`，除非在测试或确定不会失败的初始化逻辑中（如 `lib.rs` 中的 `tauri::generate_context!`）。应使用 `?` 运算符或 `match` 妥善处理所有可能的错误路径。
*   **错误消息本地化**：目前错误消息均为硬编码的中文或英文字符串。若未来需要支持多语言，建议在后端定义错误码（Error Codes），由前端根据错误码进行本地化展示，而非直接透传后端字符串。
*   **日志记录**：在返回错误给前端的同时，建议使用 `tracing::error!` 或 `tracing::warn!` 记录详细的错误上下文，以便于调试和问题排查。