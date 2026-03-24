# BoostOS Phase 1 Validation Checklist

Use this checklist before calling Phase 1 complete.

## Install

- Fresh Windows machine or clean WSL state can install BoostOS without manual distro surgery.
- The installer creates or imports a distro named `BoostOS`.
- The Linux provisioning script completes without package-resolution errors.

## Session

- `xrdp` starts successfully inside the distro.
- Windows can connect to BoostOS over RDP on port `3390`.
- A minimal `Xorg` user session opens successfully over RDP.
- The `minimal` XRDP session mode stays open for at least 2 minutes.
- `xfce` mode is validated only after `minimal` mode is stable.
- Login lands in a usable desktop session, not a blank or failed session.
- Disconnect and reconnect works without rebuilding the session by hand.

## Validation Note

- WSLg may be used as a temporary validation path for editor and terminal usability when host-specific WSL RDP forwarding is unreliable.
- WSLg does not satisfy the final Phase 1 remote desktop acceptance criteria.
- Do not mark Phase 1 complete until the RDP path works end to end on a supported Windows setup.
- Keep a rollback export of any working WSL distro before changing XRDP session startup. The current rollback point is [`BoostOS-20260322-072353.tar`](/C:/Desktop/Boost/BoostOS/.backup/BoostOS-20260322-072353.tar).
- Prefer validating risky XRDP fixes in a separate distro such as `BoostOS-RDP` instead of mutating the primary working environment in place.
- The current recovery sequence is: `minimal` mode first, then layer XFCE components back in one subsystem at a time.

## Terminal

- Terminal launches from the desktop and is responsive.
- `git --version`, `python3 --version`, `node --version`, and `npm --version` succeed.
- Clipboard copy and paste works between Windows and the remote terminal.
- `tmux` starts correctly inside the remote terminal.

## Editors

- VS Code Linux launches and can open a project folder.
- Cursor Linux launches and can open the same project folder.
- Both editors can use their integrated terminals successfully.
- Basic keyboard shortcuts needed for editing feel correct enough for daily work.

## Real Work Test

- Complete one uninterrupted 60-minute coding session inside BoostOS.
- Record all friction points with exact symptoms and rough severity.
- Any blocker in install, login, reconnect, terminal, or editor launch fails Phase 1.
