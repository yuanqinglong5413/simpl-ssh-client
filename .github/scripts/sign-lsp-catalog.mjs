/**
 * Sign an LSP catalog payload for a GitHub Release asset.
 *
 * The private key is supplied only by CI as a base64-encoded PKCS#8 Ed25519
 * PEM. The resulting envelope is what the application verifies before it can
 * resolve an archive URL or run a managed plugin.
 */
import { createPrivateKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const [input, output] = process.argv.slice(2);
const encodedKey = process.env.LSP_CATALOG_SIGNING_PRIVATE_KEY;

if (!input || !output) {
  throw new Error("Usage: node sign-lsp-catalog.mjs <payload.json> <catalog.json>");
}
if (!encodedKey) {
  throw new Error("LSP_CATALOG_SIGNING_PRIVATE_KEY is required");
}

const payload = await readFile(input);
const privateKey = createPrivateKey(Buffer.from(encodedKey, "base64").toString("utf8"));
const signature = sign(null, payload, privateKey).toString("base64");

await writeFile(output, `${JSON.stringify({
  payload: payload.toString("base64"),
  signature,
}, null, 2)}\n`);
