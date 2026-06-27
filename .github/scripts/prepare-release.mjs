/**
 * Release 构建前预处理：
 * - 校验 TAURI_SIGNING_PRIVATE_KEY 格式，无效时关闭 updater 产物
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
  console.log('Updater 签名密钥未配置或格式无效，关闭 createUpdaterArtifacts / latest.json。');
  const confPath = 'src-tauri/tauri.conf.json';
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
  conf.bundle.createUpdaterArtifacts = false;
  fs.writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);
  fs.appendFileSync(githubEnv, 'INCLUDE_UPDATER_JSON=false\n');
} else {
  fs.appendFileSync(githubEnv, 'INCLUDE_UPDATER_JSON=true\n');
}
