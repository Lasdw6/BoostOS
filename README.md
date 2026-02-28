# BoostOS Desktop

BoostOS Desktop is an Electron app for project-focused developer workflow switching:

- track agent and devserver sessions per project
- switch quickly between IDE, browser, and terminal surfaces
- map active runtime context to projects (PID/window/port signals)
- run `boost` terminal commands through the local command server

## Why this repo exists

This repository is the open-source home for the desktop app so development can happen in public with clear contribution workflows.

## Features

- Global shortcuts for project/surface switching
- Session bindings for `agent` and `devserver`
- Runtime map and terminal-debug views
- Windows-focused terminal + window orchestration
- Optional LLM-assisted runtime classification

## Stack

- Electron + electron-vite
- TypeScript
- React (renderer)
- Bun (scripts/package manager)

## Getting started

### Requirements

- Node.js 20+
- Bun 1.1+
- Windows 10/11 recommended

### Install

```bash
bun install
```

### Run in development

```bash
bun run dev
```

### Typecheck

```bash
bun run typecheck
```

### Build

```bash
bun run build
```

## Environment

Use `.env.example` as the source of truth for local configuration.

Never commit real secrets. `.env`, `.env.*` (except `.env.example`) are ignored.

## Project layout

- `src/main` Electron main process
- `src/preload` IPC bridge
- `src/renderer` React UI
- `scripts` local automation scripts
- `resources` packaging/runtime assets

## Contributing

See `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`.

## Security

See `SECURITY.md` for reporting vulnerabilities.

## License

Apache-2.0, see `LICENSE`.
