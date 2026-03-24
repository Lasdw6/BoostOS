# BoostOS WSLg Validation

## Purpose

This path exists to validate the BoostOS environment and coding workflow on machines where WSL RDP transport is unreliable. It is a temporary validation path only.

WSLg is acceptable for answering:

- can BoostOS host a usable Linux coding toolchain
- do terminal workflows feel good enough
- do Linux GUI editors launch and behave well enough to continue

WSLg is not acceptable for closing Phase 1. The intended end-state remains a full RDP-accessible BoostOS desktop.

## What To Validate With WSLg

- terminal startup and responsiveness
- clipboard and keyboard behavior in Linux GUI apps
- VS Code launch, project open, and integrated terminal
- Cursor launch, project open, and integrated terminal
- one real coding session inside BoostOS

## Recommended Flow

1. Start `BoostOS` with `wsl -d BoostOS`.
2. Confirm GUI support is present:

```bash
echo "$DISPLAY"
echo "$WAYLAND_DISPLAY"
```

3. Launch GUI apps from inside BoostOS.
4. Install and test VS Code and Cursor.
5. Record every friction point in the validation checklist.

## Decision Rule

- If WSLg validation shows the environment itself is good, keep building BoostOS.
- Treat RDP transport as a separate infrastructure problem to resolve before calling Phase 1 complete.
