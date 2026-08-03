import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const dist = path.resolve("dist");
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const match = html.match(/<script[^>]+src="\/assets\/([^"]+)"/);

if (!match) {
  throw new Error("无法在 dist/index.html 中找到首屏脚本。");
}

const file = path.join(dist, "assets", match[1]);
const size = zlib.gzipSync(fs.readFileSync(file)).byteLength;
const limit = 150 * 1024;

if (size > limit) {
  throw new Error(`首屏脚本 ${Math.ceil(size / 1024)}KB gzip，超过 ${limit / 1024}KB 预算。请继续拆分非首屏依赖。`);
}

console.log(`首屏脚本 ${Math.ceil(size / 1024)}KB gzip，预算 ${limit / 1024}KB。`);
