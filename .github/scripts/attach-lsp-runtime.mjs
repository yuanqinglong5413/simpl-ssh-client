/**
 * Attach one self-contained runtime archive to a schema-v2 catalog payload.
 * The runtime signature covers the same normalized digest that the Rust client verifies,
 * so installation can stream the archive to disk without buffering it in memory.
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";

const [catalogPath, pluginId, version, platform, archivePath, archiveUrl, executable, ...args] = process.argv.slice(2);
const encodedKey = process.env.LSP_CATALOG_SIGNING_PRIVATE_KEY;
if (!catalogPath || !pluginId || !version || !platform || !archivePath || !archiveUrl || !executable) {
  throw new Error("Usage: node attach-lsp-runtime.mjs <catalog.json> <plugin> <version> <platform> <archive.zip> <archive-url> <executable> [...args]");
}
if (!encodedKey) throw new Error("LSP_CATALOG_SIGNING_PRIVATE_KEY is required");

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
if (catalog.schemaVersion !== 2) throw new Error("Catalog schemaVersion must be 2");
const plugin = catalog.plugins.find((item) => item.id === pluginId);
if (!plugin) throw new Error(`Unknown plugin: ${pluginId}`);
plugin.version = version;
const archive = await readFile(archivePath);
const sizeBytes = (await stat(archivePath)).size;
const sha256 = createHash("sha256").update(archive).digest("hex");
const payload = Buffer.from(`simpl-ssh-lsp-runtime-v2\n${pluginId}\n${version}\n${platform}\n${sha256}\n${sizeBytes}\n${executable}\n`);
const privateKey = createPrivateKey(Buffer.from(encodedKey, "base64").toString("utf8"));
const signature = sign(null, payload, privateKey).toString("base64");
plugin.runtimes[platform] = { archiveUrl, sha256, signature, executable, args, sizeBytes };
await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
