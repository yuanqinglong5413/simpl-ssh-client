# Managed LSP release assets

The desktop client only accepts catalog schema v2 from the fixed `lsp-runtime-stable`
release. Each platform archive must be self-contained (Node for TypeScript/Pyright,
a trimmed JRE for JDTLS) and must not depend on Homebrew, PATH, or a project command.

For each archive, run `attach-lsp-runtime.mjs` to add `sizeBytes`, SHA-256 and the
Ed25519 signature over the normalized runtime descriptor. After all six services and
target platforms are attached, run `sign-lsp-catalog.mjs`, upload the archives and
the signed `lsp-catalog.json` to the `lsp-runtime-stable` GitHub release, and verify
that every `archiveUrl` points to that immutable asset name. CI/release builds at
v0.14+ require the matching public key.
