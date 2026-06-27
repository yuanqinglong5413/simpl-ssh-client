## 1. 核心设计系统：深墨 + 琥珀 (Ink & Amber)

该应用采用一套自定义的**深色优先（Dark-First）**设计系统，核心理念为“深墨基底 + 琥珀强调”。

*   **视觉风格**：以深蓝灰/墨色（`#0b0d12`）为背景，搭配高饱和度的琥珀色（`#ff9f1c`）作为品牌色、激活态和主要操作按钮。这种配色致敬了 CRT 终端的复古感，同时保持了现代 UI 的克制与清晰。
*   **语义色彩**：
    *   **成功/在线**：使用青绿色（`#3fd9a0`），常用于连接状态指示灯。
    *   **错误/危险**：使用柔和红（`#ff5c5c`），用于关闭按钮、错误提示和断开连接操作。
    *   **文本层级**：通过 `--text` (主文本)、`--text-dim` (次级文本) 和 `--muted` (禁用/辅助文本) 建立清晰的视觉层级。

## 2. 技术实现：CSS 变量与运行时主题引擎

项目未使用 Tailwind CSS 或预处理器框架，而是采用**原生 CSS 变量 (Custom Properties)** 结合 **React Context** 实现高性能的动态主题切换。

*   **CSS 架构**：
    *   `src/App.css` 定义了全局设计令牌（Design Tokens），如 `--bg`, `--panel`, `--accent`, `--font-mono` 等。
    *   所有组件样式均引用这些变量，确保换肤时只需更改变量值，无需重新编译 CSS。
*   **主题引擎 (`src/theme/`)**：
    *   **`ThemeProvider`**：负责从 `localStorage` 读取用户偏好，并通过 `document.documentElement.style.setProperty` 将主题变量实时注入 DOM 根节点。
    *   **双轨制主题模型**：每个主题对象 (`AppTheme`) 包含两部分：
        1.  `app`: GUI 界面的 CSS 变量映射。
        2.  `terminal`: `xterm.js` 的 `ITheme` 配置（含背景、前景、光标及 16 色 ANSI 调色板）。
    *   **一致性保障**：确保终端内部的配色与外部 UI 风格高度统一。

## 3. 主题库与扩展性

内置了 **21 套预设主题**，覆盖了主流开发者审美：

*   **默认主题**：`ink-amber` (深墨琥珀)。
*   **流行方案**：Dracula, Nord, One Dark, Gruvbox, Solarized (Dark/Light), Monokai, Tokyo Night, Catppuccin (Mocha/Latte), GitHub Dark 等。
*   **无障碍支持**：提供 `high-contrast` (高对比度) 主题，满足特殊视觉需求。
*   **构建工具**：`src/themes/build.ts` 提供了 `buildAppVars` 和 `buildTerminalTheme` 辅助函数，简化新主题的创建过程，自动处理透明度衍生色（如 `accentSoft`）。

## 4. 布局与组件规范

*   **布局策略**：
    *   采用 **Flexbox** 为主、**Grid** 为辅的布局方式。
    *   核心结构为经典的 IDE 三栏布局：左侧会话侧边栏 (`--sidebar-w: 256px`)、顶部标签栏 (`--topbar-h: 42px`)、底部状态栏 (`--status-h: 28px`) 和中间自适应工作区。
*   **字体栈**：
    *   **UI 字体**：`IBM Plex Sans Variable` / `IBM Plex Sans`，强调现代感与可读性。
    *   **等宽字体**：`IBM Plex Mono` / `JetBrains Mono`，广泛用于终端、文件路径、IP 地址等技术信息展示。
*   **交互细节**：
    *   **滚动条**：自定义了细长的暗色滚动条，hover 时高亮，减少视觉干扰。
    *   **微交互**：按钮、列表项均带有 `0.12s` 的平滑过渡动画；活跃终端面板具有内阴影聚焦效果。
    *   **玻璃拟态**：弹窗和浮层使用 `backdrop-filter: blur(3px)` 增强层次感。

## 5. 开发约定

1.  **样式编写**：禁止在组件中硬编码颜色值（如 `color: #fff`），必须使用 `var(--text)` 等语义化变量。
2.  **主题扩展**：新增主题时，需在 `src/themes/index.ts` 中定义 ANSI 调色板，并使用 `makeTheme` 工厂函数生成完整主题对象。
3.  **终端同步**：修改 GUI 主题时，必须同步更新对应的 `terminal` 配置，防止终端出现“白底黑字”或配色冲突。
4.  **响应式**：目前主要针对桌面端优化，布局尺寸（如侧边栏宽度）通过 CSS 变量集中管理，便于后续适配。