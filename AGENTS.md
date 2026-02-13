# AGENTS.md - Desktop v2

This file provides contributor guidance for `apps/desktop-v2`.

## Purpose

Desktop v2 is the project/agent/devserver switchboard:

- Track agent and devserver sessions per project.
- Pair devservers to agents (label-first, then fallback).
- Switch active project and active agent quickly via shortcuts.
- Focus IDE, agent terminal, and browser surfaces for the active project.

## Key Behavior

### Session model

- Sessions are stored in `project-hub-v2.json` under:
  - `session_bindings`
  - `session_defaults_by_project`
- Binding types:
  - `agent`
  - `devserver`
- A devserver can be paired to an agent by matching `label`.

### Command server

- HTTP server: `127.0.0.1:45700`
- Main handler: `src/main/index.ts` (`executeCommandServerInput`)
- Supported relationship/session commands:
  - `boost init`
  - `boost add agent [--project ...] [--label ...]`
  - `boost add devserver [--project ...] [--label ...] [--cmd ...] [--port ...]`
  - `boost list sessions [--project ...]`
  - `boost use agent <session-id>`
  - `boost use devserver <session-id>`
  - `boost remove session <session-id>`
  - `boost relationships [--project ...]`
  - `boost reset relationships` (also `boost clear relationships`)

### Shortcuts

Defaults are in `src/shared/project-hub.ts`:

- `Ctrl+Shift+S` project switcher
- `Ctrl+Shift+I` open/focus IDE
- `Ctrl+Shift+B` open/focus devserver browser flow
- `Ctrl+Shift+A` open/focus agent
- `Ctrl+Tab` cycle active agent pair

## Important Files

- Main process:
  - `src/main/index.ts`
  - `src/main/project-hub-config.ts`
  - `src/main/window-manager.ts`
- Shared config/types:
  - `src/shared/project-hub.ts`
- Preload bridge:
  - `src/preload/index.ts`
  - `src/preload/index.d.ts`
- Renderer:
  - `src/renderer/src/App.tsx`
  - `src/renderer/src/api/ipc.ts`

## Project Switcher Rule

`Ctrl+Shift+S` overlay should show only projects with configured agent sessions (not every discovered project).

## Integrated Terminals (Cursor/VSCode)

When adding sessions from integrated terminals:

- Capture `pid` from terminal context.
- Capture `window_id` from active IDE window when needed.
- Prefer `window_id` for focus paths; fallback to `pid`.

## Working Rules

- Use Bun commands for this project.
- Do not commit secrets or `.env`.
- Preserve existing user config compatibility in `project-hub-v2.json`.
- Keep command output concise and deterministic.
- Use `@harnessgg/electron` for Electron smoke/interaction testing before shipping UI flows.
- If changing IPC contract, update:
  - `src/main/index.ts`
  - `src/preload/index.ts`
  - `src/preload/index.d.ts`
  - `src/renderer/src/api/ipc.ts`

## Validation Checklist

1. Add agent/devserver sessions from terminal.
2. Verify `boost relationships` output and pairing.
3. Verify `Ctrl+Shift+S` shows only projects with agent bindings.
4. Verify `Ctrl+Tab` cycles active agent and updates devserver pairing.
5. Verify `Ctrl+Shift+B` uses active agent's paired devserver.
6. Run typecheck:
   - `bun run --cwd apps/desktop-v2 typecheck`
7. Run Harness smoke:
   - `bun run --cwd apps/desktop-v2 test:harness:smoke`
8. Add at least one entry to `apps/desktop-v2/HARNESS_FEEDBACK.md` with:
   - what was tested
   - observed friction/bugs
   - suggested feature or UX improvement
