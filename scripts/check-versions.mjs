import fs from "node:fs";

const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const tauriVersion = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
const cargo = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

if (!packageVersion || packageVersion !== tauriVersion || packageVersion !== cargoVersion) {
  console.error(`版本不一致：package=${packageVersion}, tauri=${tauriVersion}, cargo=${cargoVersion}`);
  process.exit(1);
}
console.log(`版本来源一致：${packageVersion}`);
