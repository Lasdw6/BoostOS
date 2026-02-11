# Windows Release Security Setup

This document sets up a safer Windows release process so browser/SmartScreen false positives are less likely.

## 1) Configure signing secrets

Set these environment variables in your release machine/CI:

- `CSC_LINK`: base64-encoded `.pfx` certificate, or a file path/URL supported by electron-builder
- `CSC_KEY_PASSWORD`: password for the `.pfx`

Optional timestamp settings:

- `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` (Windows-specific overrides)

## 2) Build signed installer

```bash
bun run release:win:secure
```

This runs:

1. `bun run build:win`
2. `bun run verify:win-installer`

## 3) Verify before publishing

The verifier prints:

- Artifact path
- Version (from `dist/latest.yml`)
- SHA-256 checksum
- Authenticode status
- Signer/timestamp signer

On Windows, verifier fails if signature status is not `Valid`.

Override only for local testing:

```bash
ALLOW_UNSIGNED_INSTALLER=1 bun run verify:win-installer
```

## 4) Publish safely

Before releasing the installer publicly:

1. Upload only signed installers.
2. Publish SHA-256 checksum next to download.
3. Submit fresh installer to VirusTotal and review detections.
4. If flagged, submit false-positive reports:
   - Google Safe Browsing
   - Microsoft Defender/SmartScreen
5. Keep download domain stable to build reputation.
