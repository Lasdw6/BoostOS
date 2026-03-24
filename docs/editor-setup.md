# BoostOS Editor Setup

Phase 1 validates both VS Code and Cursor, but keeps editor installation separate from the base provisioning flow.

## VS Code

Install the official Debian package inside the BoostOS desktop session:

```bash
wget -qO /tmp/code.deb "https://code.visualstudio.com/sha/download?build=stable&os=linux-deb-x64"
printf 'code code/add-microsoft-repo boolean false\n' | sudo debconf-set-selections
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/code.deb
```

Launch with:

```bash
code
```

For WSLg validation, launch VS Code from inside `BoostOS` after confirming `DISPLAY` or `WAYLAND_DISPLAY` is set.

## Cursor

Cursor does not have the same Linux distribution packaging path as VS Code on every release, so keep the install method explicit and current. For Phase 1, install it manually inside the desktop session using the current Linux build from Cursor, then verify:

- the app launches from the terminal or app menu
- the login flow can open a Linux browser from the remote desktop session
- a local project folder opens correctly
- the integrated terminal works inside the remote desktop session

On the current BoostOS Phase 1 setup, install a real Linux browser and make it the desktop default before calling Cursor validation complete. The XFCE placeholder launcher is not enough for OAuth-style login redirects. For persistent accounts and browser sync, prefer a Chromium-based Linux browser in BoostOS so you can sign in normally and pull bookmarks, passwords, and extensions through browser sync rather than trying to copy a host browser profile directly.

## Acceptance Notes

- Both editors must be able to open the same sample repo.
- Both editors must support integrated terminal use without session crashes or frozen input.
- If either editor requires extra environment variables or launch flags under `xrdp`, record them here before calling Phase 1 complete.
- For WSLg validation, record any launch or rendering issues separately from RDP transport issues.
