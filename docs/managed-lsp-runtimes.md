# 托管 LSP 运行时发布说明

Simpl SSH 不会在首次打开项目时自动下载、安装或执行语言服务。用户必须在“偏好设置 → LSP 插件目录”中主动刷新受信任目录、安装并启用某个插件。

## 信任链

1. 应用仅从 GitHub Release 的 `lsp-catalog.json` 获取目录。
2. 目录是一个 Ed25519 签名信封；应用内置的**公开验证密钥**校验目录后，才会读取其中的运行时 URL。
3. 每个 zip 运行时再同时校验 SHA-256 与 Ed25519 签名。
4. 解压仅允许普通相对路径，拒绝软链接和路径穿越；应用只会从自己的应用数据目录启动已验证的可执行文件。

若发行版没有编译 `SIMPL_SSH_LSP_CATALOG_PUBLIC_KEY`，应用会安全回退到系统 LSP 检测，且拒绝刷新或安装托管二进制。

## 发布新的目录

1. 为每个平台打包独立 zip：`darwin-aarch64`、`darwin-x86_64`、`linux-x86_64`、`windows-x86_64`。运行时必须包含它依赖的 Node 或 JRE；不得依赖用户的 PATH、`JAVA_HOME`、npm 或 pip。
2. 填写 `.github/lsp/lsp-catalog.payload.example.json` 的副本。每个 `runtimes.<platform>` 必须包括：Release asset URL、zip 的 SHA-256、zip 的 Ed25519 签名、相对可执行文件路径和参数。
3. 用 `LSP_CATALOG_SIGNING_PRIVATE_KEY`（base64 编码的 PKCS#8 Ed25519 PEM）运行：

   ```bash
   node .github/scripts/sign-lsp-catalog.mjs lsp-catalog.payload.json lsp-catalog.json
   ```

4. 将 zip、其签名和 `lsp-catalog.json` 一起上传到同一个 GitHub Release。将对应的原始 32 字节 Ed25519 公钥以 base64 形式设置为仓库变量 `LSP_CATALOG_PUBLIC_KEY`，让正式应用编译进验证密钥。

## 运行时约束

- 只能发布标准 LSP JSON-RPC 服务，不能发布 VS Code `.vsix`、扩展宿主或任意项目脚本。
- `executable` 必须是 zip 中的普通相对路径；目录清单校验会拒绝绝对路径、`..` 与反斜杠。
- 插件启动不经过 shell，也不会继承认证 Token、私钥或密码环境变量。
- 上游许可、第三方 notices、升级策略与安全公告必须随每个运行时版本审核并记录。
