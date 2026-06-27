该 Tauri SSH 客户端应用在后端（Rust）采用 `tracing` 生态作为统一的日志与诊断框架。

### 1. 核心组件与依赖
- **框架**：使用 `tracing` (v0.1) 进行结构化事件记录，配合 `tracing-subscriber` (v0.3) 进行日志输出与过滤。
- **初始化位置**：在 `src-tauri/src/lib.rs` 的 `run()` 函数入口处完成全局订阅者初始化。
- **配置方式**：
  ```rust
  tracing_subscriber::fmt()
      .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
      .init();
  ```
  系统通过 `RUST_LOG` 环境变量动态控制日志级别和模块过滤，支持开发环境下的灵活调试。

### 2. 日志使用规范
- **宏调用**：代码中统一使用 `tracing::info!`, `tracing::warn!`, `tracing::debug!` 等宏。
- **结构化字段**：在关键路径（如网络连接、错误处理）中，开发者倾向于使用结构化字段记录上下文。例如：
  - `tracing::warn!(%addr, error = %e, "terminal ws connection ended");`
  - `tracing::debug!(exit_status, "remote command exited");`
  这种写法便于后续接入更高级的可观测性工具（如 JSON 格式化输出）。

### 3. 分布与场景
- **网络与会话管理**：在 `src-tauri/src/session/` 目录下，针对 SSH 连接状态、WebSocket 终端桥接、X11 转发等异步任务的生命周期事件进行记录。
- **错误追踪**：针对文件读取失败（如 `workspace.json`）、连接断开等非致命错误使用 `warn` 级别，确保前端能感知但不至于崩溃。

### 4. 开发者建议
- **环境变量调试**：在开发时，可通过设置 `RUST_LOG=debug` 或 `RUST_LOG=simpl_ssh=trace` 来查看详细的后端行为。
- **避免 println**：严禁在后端逻辑中使用 `println!` 或 `eprintln!`，所有输出必须经过 `tracing` 框架以保证线程安全和格式统一。
- **前端日志**：前端 React 部分目前主要依赖浏览器控制台，未观察到与后端 `tracing` 集成的专用日志上报通道。