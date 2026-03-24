# BoostOS Phase 1 Foundation

## Goal

Deliver a Windows-first Linux coding desktop inside WSL2 that is comfortable enough for a real coding session. Phase 1 stops at the desktop, remoting, terminal, and editor experience. It does not include agent infrastructure.

## Deliverable

The Phase 1 deliverable is a repeatable bootstrap flow with:

- Ubuntu 24.04 installed in WSL2 as `BoostOS`
- repo-managed XRDP session modes for `minimal` and `xfce`
- `xrdp` configured as the default remote session path
- core development packages installed
- documented editor setup paths for Cursor and VS Code
- a validation checklist for the one-hour coding-session test

## Architecture

### Host responsibilities

- ensure WSL2 is available
- install the base Ubuntu distro
- rename it to `BoostOS`
- create a Linux user for the distro
- invoke the in-guest provisioning script
- start and stop the Linux services needed for remoting
- surface the connection details for Windows Remote Desktop

### Guest responsibilities

- install XFCE and core desktop packages
- install and configure `xrdp`
- install terminal and development toolchain basics
- configure the desktop session startup
- configure a predictable shell environment for remote sessions

## Defaults

- Platform: Windows 11 + WSL2
- Distro: Ubuntu 24.04 LTS
- Desktop environment: XFCE
- Remoting: RDP via `xrdp`
- XRDP recovery default: `minimal`
- Default coding shell: `zsh` with `tmux` available
- Included toolchains: Git, curl, build-essential, Python 3, Node.js LTS via `nvm`

## Deliverables In This Repo

- [`scripts/windows/install-boostos.ps1`](/C:/Desktop/Boost/BoostOS/scripts/windows/install-boostos.ps1)
- [`scripts/windows/connect-boostos.ps1`](/C:/Desktop/Boost/BoostOS/scripts/windows/connect-boostos.ps1)
- [`scripts/linux/provision-phase1.sh`](/C:/Desktop/Boost/BoostOS/scripts/linux/provision-phase1.sh)
- [`config/xrdp/startwm.sh`](/C:/Desktop/Boost/BoostOS/config/xrdp/startwm.sh)
- [`config/xrdp/startwm-minimal.sh`](/C:/Desktop/Boost/BoostOS/config/xrdp/startwm-minimal.sh)
- [`config/xrdp/startwm-xfce.sh`](/C:/Desktop/Boost/BoostOS/config/xrdp/startwm-xfce.sh)
- [`config/profile/boostos-session.sh`](/C:/Desktop/Boost/BoostOS/config/profile/boostos-session.sh)
- [`docs/editor-setup.md`](/C:/Desktop/Boost/BoostOS/docs/editor-setup.md)
- [`docs/wslg-validation.md`](/C:/Desktop/Boost/BoostOS/docs/wslg-validation.md)
- [`docs/validation-checklist.md`](/C:/Desktop/Boost/BoostOS/docs/validation-checklist.md)

## Execution Order

1. Run the Windows installer script from an elevated PowerShell session.
2. Create the BoostOS Linux user when prompted.
3. Let the script copy and run the Linux provisioning script inside WSL.
4. Start the distro services and connect from Windows Remote Desktop.
5. Complete the validation checklist before declaring Phase 1 usable.

## Known Gaps

- Editor installation is documented, not fully automated, because package/source choice may change and both Cursor and VS Code need separate Linux install flows.
- `xrdp` on WSL can require environment-specific tuning for audio, clipboard edge cases, or reconnect behavior.
- WSL networking mode can change how the host reaches the distro. The current scripts target mirrored-mode `localhost` access where supported.
- On this machine, WSLg is the current validation path for Phase 1 usability because Windows-to-WSL RDP transport remains host-dependent. This is only a validation concession, not the product direction.
- The intended Phase 1 end-state is still a full RDP-accessible BoostOS desktop from Windows. WSLg is acceptable for proving the environment and coding workflow, but it does not satisfy the final remoting requirement.
- The current recovery implementation treats XRDP session startup as mode-driven. `minimal` is the stability baseline, and `xfce` is reintroduced only after the base session remains open.

## Current RDP Status

- The BoostOS environment itself is viable. WSLg has already validated Linux GUI editor launch, file editing, and basic coding workflow.
- Windows-to-BoostOS RDP transport is working on this machine through a localhost relay path, so the remaining blocker is not networking reachability.
- The primary recovery path is the current `BoostOS` distro, not the backup tarball. The backup exists for rollback only, because it contains the same XRDP/Xorg base and an older startup script rather than a clearly cleaner desktop state.
- The first live `BoostOS` distro was exported to [`BoostOS-20260322-072353.tar`](/C:/Desktop/Boost/BoostOS/.backup/BoostOS-20260322-072353.tar) before the clean rebuild work. That tarball is the rollback point for the original environment.
- The clean rebuild path uses a separate distro name, `BoostOS-RDP`, so XRDP fixes can be validated without losing the original `BoostOS` instance.
- The rebuilt bootstrap now starts XRDP through the repo-managed [`startwm.sh`](/C:/Desktop/Boost/BoostOS/config/xrdp/startwm.sh) instead of falling back to `xfce4-session`.
- `localhost:3390` is reachable on the clean rebuild, and the remaining work is validating/stabilizing the full desktop session over a fresh login.
- Phase 1 should continue to treat RDP as a core requirement. WSLg is only a temporary validation path while the in-guest session startup is being stabilized.
- Any claim that Phase 1 is complete must include a real end-to-end RDP login into a usable Linux desktop on a supported Windows setup.
