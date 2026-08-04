/**
 * Release 构建前预处理：
 * - v0.12/v0.13 缺少更新签名时仍生成安装包，但关闭 updater 产物。
 * - v0.14+ 必须具备更新签名和可信 LSP 目录公钥。
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

const tag = process.env.GITHUB_REF_NAME ?? '';
const match = tag.match(/^v?(\d+)\.(\d+)/);
const requiresSignedRelease = match && (Number(match[1]) > 0 || Number(match[2]) >= 14);

if (!updaterOk) {
  if (requiresSignedRelease) {
    console.error('v0.14+ 正式发布必须配置有效的 TAURI_SIGNING_PRIVATE_KEY。');
    process.exit(1);
  }

  console.warn('Updater 签名密钥未配置或格式无效；本次仅生成安装包，不生成 updater 产物。');
  const confPath = 'src-tauri/tauri.conf.json';
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
  conf.bundle.createUpdaterArtifacts = false;
  fs.writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);
  fs.appendFileSync(githubEnv, 'INCLUDE_UPDATER_JSON=false\n');
} else {
  fs.appendFileSync(githubEnv, 'INCLUDE_UPDATER_JSON=true\n');
}

const requiresManagedLsp = requiresSignedRelease;
if (requiresManagedLsp) {
  const encoded = process.env.SIMPL_SSH_LSP_CATALOG_PUBLIC_KEY ?? '';
  let valid = false;
  try { valid = Buffer.from(encoded, 'base64').length === 32; } catch { valid = false; }
  if (!valid) {
    console.error('v0.14+ 正式发布必须配置 32 字节 Ed25519 LSP_CATALOG_PUBLIC_KEY。');
    process.exit(1);
  }
}
