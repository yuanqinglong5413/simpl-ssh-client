# 参与贡献

感谢你有兴趣为 simpl-ssh 出力！下面是上手要点。

## 开发环境

前置：Node.js ≥ 20、pnpm 11、Rust (stable)、macOS / Windows / Linux 任一。
Linux 需额外装系统依赖（见 [README](README.md#从源码构建)）。

```bash
git clone https://github.com/yuanqinglong5413/simpl-ssh-client.git
cd simpl-ssh-client
pnpm install
pnpm tauri dev
```

## 提交前自查

请确保以下都通过：

```bash
pnpm build                              # 前端类型检查 + 构建
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

## 约定

- **提交信息**：用 [Conventional Commits](https://www.conventionalcommits.org/) 风格，例如
  `feat: 加 SFTP 上传队列`、`fix: 修终端断线后不重连`、`docs: 补 README 截图`。
- **代码风格**：Rust 跟随 `cargo fmt` / `clippy`；前端跟随现有组件风格。
- **范围**：一次 PR 只做一件事，方便 review。
- **架构**：终端与 SFTP 应复用同一条 SSH 连接（见 [docs/DESIGN.md](docs/DESIGN.md)），
  新功能请延续这个原则。

## 提交流程

1. Fork → 新建分支（`feat/xxx` / `fix/xxx`）。
2. 改代码、补必要的说明。
3. 自查通过后开 PR，描述清楚动机和改动。

## 行为准则

请保持友善、对事不对人。对新手友好。
