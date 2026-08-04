/**
 * Release 构建前预处理：
 * - 正式发布必须具备更新签名；v0.14+ 还必须编译可信 LSP 目录公钥。
 */
import fs from 'node:fs';

const key = process.env.TAURI_SIGNING_PRIVATE_KEY ?? '';
let updaterOk = false;

if (key.includes('untrusted comment')) {
  updaterOk = true;
} else {
  try {
    const decoded = Buffer.from(key, 'base64').toString('utf8');
    if (decoded.includes('untrusted comment')) updaterOk = true;
  } catch {
    // 非 base64 或解码失败，视为无效密钥
  }
}

const githubEnv = process.env.GITHUB_ENV;
if (!githubEnv) {
  console.error('GITHUB_ENV 未设置');
  process.exit(1);
}

if (!updaterOk) {
  console.error('正式发布缺少有效的 TAURI_SIGNING_PRIVATE_KEY；已拒绝生成不可验证的更新产物。');
  process.exit(1);
}
fs.appendFileSync(githubEnv, 'INCLUDE_UPDATER_JSON=true\n');

const tag = process.env.GITHUB_REF_NAME ?? '';
const match = tag.match(/^v?(\d+)\.(\d+)/);
const requiresManagedLsp = match && (Number(match[1]) > 0 || Number(match[2]) >= 14);
if (requiresManagedLsp) {
  const encoded = process.env.SIMPL_SSH_LSP_CATALOG_PUBLIC_KEY ?? '';
  let valid = false;
  try { valid = Buffer.from(encoded, 'base64').length === 32; } catch { valid = false; }
  if (!valid) {
    console.error('v0.14+ 正式发布必须配置 32 字节 Ed25519 LSP_CATALOG_PUBLIC_KEY。');
    process.exit(1);
  }
}
