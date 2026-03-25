[CmdletBinding()]
param(
    [string]$DistroName = "BoostOS",
    [string]$LinuxUser = "boost",
    [int]$RdpPort = 3390,
    [int]$GuestRdpPort = 3391,
    [ValidateSet("minimal", "xfce", "niri")]
    [string]$SessionMode = "xfce",
    [switch]$UseRelay,
    [switch]$OpenMstsc
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-WslRoot {
    param(
        [string]$Name,
        [string]$Command
    )

    $Command | & wsl.exe -d $Name -u root -- bash -lc "tr -d '\r' | bash -s --"
    if ($LASTEXITCODE -ne 0) {
        throw "WSL command failed: $Command"
    }
}

function Convert-WindowsPathToWslPath {
    param([string]$Path)

    $resolved = (Resolve-Path $Path).Path
    $drive = $resolved.Substring(0, 1).ToLowerInvariant()
    $rest = $resolved.Substring(2).Replace('\', '/')
    return "/mnt/$drive$rest"
}

function Update-GuestXrdpConfig {
    param(
        [string]$Name,
        [int]$Port
    )

    $command = @"
python3 - <<'PY'
from pathlib import Path

path = Path('/etc/xrdp/xrdp.ini')
lines = path.read_text().splitlines()
updated = []
section = None
replaced_port = False

for line in lines:
    stripped = line.strip()
    if stripped.startswith('[') and stripped.endswith(']'):
        section = stripped
        updated.append(line)
        continue
    if section == '[Globals]':
        if stripped.startswith('port='):
            updated.append('port=tcp://:$Port')
            replaced_port = True
            continue
        if stripped.startswith('security_layer='):
            updated.append('security_layer=rdp')
            continue
        if stripped.startswith('allow_multimon='):
            updated.append('allow_multimon=false')
            continue
        if stripped.startswith('max_bpp='):
            updated.append('max_bpp=24')
            continue
        if stripped.startswith('use_fastpath='):
            updated.append('use_fastpath=none')
            continue
        if stripped.startswith('autorun='):
            updated.append('autorun=Xorg')
            continue
    if section == '[Channels]':
        if stripped.startswith('drdynvc='):
            updated.append('drdynvc=false')
            continue
        if stripped.startswith('rail='):
            updated.append('rail=false')
            continue
        if stripped.startswith('xrdpvr='):
            updated.append('xrdpvr=false')
            continue
        if stripped.startswith('tcutils='):
            updated.append('tcutils=false')
            continue
    updated.append(line)

if not replaced_port:
    raise SystemExit('Could not locate [Globals] port entry in /etc/xrdp/xrdp.ini')

path.write_text('\n'.join(updated) + '\n')
PY
install -d -o root -g root -m 0755 /run/xrdp
install -d -o root -g root -m 01777 /run/xrdp/sockdir
"@
    Invoke-WslRoot -Name $Name -Command $command
}

function Sync-GuestXrdpAssets {
    param(
        [string]$Name,
        [string]$Mode
    )

    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $configRoot = Convert-WindowsPathToWslPath -Path (Join-Path $repoRoot "config\xrdp")
    $niriConfigRoot = Convert-WindowsPathToWslPath -Path (Join-Path $repoRoot "config\niri")

    $command = @"
set -euo pipefail
umount /tmp/.X11-unix 2>/dev/null || true
install -d -m 01777 /tmp/.X11-unix
install -d -m 0755 /etc/xrdp
install -d -m 0755 /etc/boostos/xrdp
install -d -m 0755 /etc/boostos/niri
install -m 0755 '$configRoot/startwm.sh' /etc/xrdp/startwm.sh
install -m 0755 '$configRoot/startwm-common.sh' /etc/boostos/xrdp/startwm-common.sh
install -m 0755 '$configRoot/startwm-minimal.sh' /etc/boostos/xrdp/startwm-minimal.sh
install -m 0755 '$configRoot/startwm-xfce.sh' /etc/boostos/xrdp/startwm-xfce.sh
install -m 0755 '$configRoot/startwm-niri.sh' /etc/boostos/xrdp/startwm-niri.sh
install -m 0755 '$configRoot/niri-session.sh' /etc/boostos/xrdp/niri-session.sh
install -m 0755 '$configRoot/niri-cursor-hide.py' /etc/boostos/xrdp/niri-cursor-hide.py
install -m 0644 '$niriConfigRoot/config.kdl' /etc/boostos/niri/config.kdl
printf '%s\n' '$Mode' >/etc/boostos/xrdp-session-mode
cat >/home/$LinuxUser/.xsession <<'EOF'
#!/bin/sh
exec /etc/xrdp/startwm.sh
EOF
chown ${LinuxUser}:${LinuxUser} /home/$LinuxUser/.xsession
chmod 0755 /home/$LinuxUser/.xsession
"@

    Invoke-WslRoot -Name $Name -Command $command
}

function Get-BoostOsIp {
    param([string]$Name)

    $ip = & wsl.exe -d $Name -u root -- bash -lc "ip -o -4 addr show scope global | grep -v ' lo ' | head -n 1 | tr -s ' ' | cut -d ' ' -f 4 | cut -d/ -f1"
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to determine BoostOS IP address."
    }

    return ($ip -replace "`0", "").Trim()
}

function Get-WslNetworkingMode {
    $wslConfigPath = Join-Path $HOME ".wslconfig"
    if (-not (Test-Path $wslConfigPath)) {
        return ""
    }

    $content = Get-Content $wslConfigPath -ErrorAction SilentlyContinue
    $line = $content | Where-Object { $_ -match '^\s*networkingMode\s*=' } | Select-Object -First 1
    if (-not $line) {
        return ""
    }

    return (($line -split '=', 2)[1]).Trim().ToLowerInvariant()
}

function Ensure-GuestCommand {
    param(
        [string]$Name,
        [string]$CommandName
    )

    & wsl.exe -d $Name -- bash -lc "command -v $CommandName >/dev/null 2>&1"
    return $LASTEXITCODE -eq 0
}

function Ensure-GuestNiri {
    param([string]$Name)

    $command = @'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if command -v niri >/dev/null 2>&1; then
  echo "present"
  exit 0
fi

apt-get update -qq
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  matchbox-window-manager \
  python3 \
  xwayland \
  xz-utils

. /etc/os-release
ubuntu_codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
ubuntu_ver="${VERSION_ID:-unknown}"
ppa_base="https://ppa.launchpadcontent.net/avengemedia/danklinux/ubuntu"
ppa_key_url="https://keyserver.ubuntu.com/pks/lookup?op=get&search=0xFC44813D2A7788B7"
packages_url="${ppa_base}/dists/${ubuntu_codename}/main/binary-amd64/Packages.gz"

if [[ -n "$ubuntu_codename" ]] && python3 - "$packages_url" <<'PY'
import gzip
import sys
import urllib.request

url = sys.argv[1]
request = urllib.request.Request(url, headers={"User-Agent": "BoostOS"})
with urllib.request.urlopen(request, timeout=20) as response:
    data = gzip.decompress(response.read()).decode("utf-8", "replace")

sys.exit(0 if "\nPackage: niri\n" in f"\n{data}" else 1)
PY
then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL "$ppa_key_url" | gpg --dearmor >/usr/share/keyrings/danklinux-archive-keyring.gpg
  cat >/etc/apt/sources.list.d/danklinux.list <<EOF
deb [signed-by=/usr/share/keyrings/danklinux-archive-keyring.gpg arch=amd64] $ppa_base $ubuntu_codename main
EOF
  apt-get update -qq
  apt-get install -y --no-install-recommends niri
  exit 0
fi

echo "No packaged niri build found for Ubuntu ${ubuntu_ver} (${ubuntu_codename:-unknown}); building from source" >&2

apt-get install -y --no-install-recommends \
  build-essential \
  clang \
  libdbus-1-dev \
  libdisplay-info-dev \
  libegl1-mesa-dev \
  libgbm-dev \
  libinput-dev \
  libpango1.0-dev \
  libpipewire-0.3-dev \
  libseat-dev \
  libsystemd-dev \
  libudev-dev \
  libwayland-dev \
  libxkbcommon-dev \
  lld \
  pkg-config

export CARGO_HOME=/opt/boostos/cargo
export RUSTUP_HOME=/opt/boostos/rustup
export PATH="$CARGO_HOME/bin:$PATH"

if [[ ! -x "$CARGO_HOME/bin/cargo" ]]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --no-modify-path
fi

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

release_json="$tmpdir/release.json"
curl -fsSL https://api.github.com/repos/niri-wm/niri/releases/latest >"$release_json"
version_tag="$(python3 - "$release_json" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    print(json.load(handle)["tag_name"])
PY
)"
source_url="https://github.com/niri-wm/niri/archive/refs/tags/${version_tag}.tar.gz"
curl -fsSL "$source_url" | tar -xz -C "$tmpdir"
srcdir="$(find "$tmpdir" -mindepth 1 -maxdepth 1 -type d -name 'niri-*' | head -n 1)"
if [[ -z "$srcdir" ]] || [[ ! -f "$srcdir/Cargo.toml" ]]; then
  echo "Unable to locate extracted niri source tree in $tmpdir" >&2
  exit 1
fi
python3 - "$srcdir/src/backend/winit.rs" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = '.with_inner_size(LogicalSize::new(1280.0, 800.0))\n'
replacement = needle + '            .with_decorations(false)\n'
if '.with_decorations(false)' not in text:
    if needle not in text:
        raise SystemExit(f"Could not find expected winit builder line in {path}")
    text = text.replace(needle, replacement, 1)
    path.write_text(text, encoding="utf-8")
PY
"$CARGO_HOME/bin/cargo" build --manifest-path "$srcdir/Cargo.toml" --release
install -m 0755 "$srcdir/target/release/niri" /usr/local/bin/niri
echo "Installed niri from source release ${version_tag}" >&2
'@

    Invoke-WslRoot -Name $Name -Command $command
}

function Start-Relay {
    param(
        [string]$Name,
        [string]$TargetHost,
        [int]$ListenPort,
        [int]$TargetPort
    )

    $relayScript = Join-Path $PSScriptRoot "start-rdp-relay.ps1"

    Get-CimInstance Win32_Process |
        Where-Object { $_.CommandLine -like "*start-rdp-relay.ps1*" -and $_.CommandLine -like "*-ListenPort $ListenPort*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    Start-Process "powershell.exe" -ArgumentList @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $relayScript,
        "-ListenPort", $ListenPort,
        "-TargetHost", $TargetHost,
        "-TargetPort", $TargetPort
    ) | Out-Null
}

if ($UseRelay) {
    Get-CimInstance Win32_Process |
        Where-Object { $_.CommandLine -like "*start-rdp-relay.ps1*" -and $_.CommandLine -like "*-ListenPort $RdpPort*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Update-GuestXrdpConfig -Name $DistroName -Port $GuestRdpPort
}
else {
    Update-GuestXrdpConfig -Name $DistroName -Port $RdpPort
}

Sync-GuestXrdpAssets -Name $DistroName -Mode $SessionMode

if ($SessionMode -eq "niri") {
    $niriPresent = & wsl.exe -d $DistroName -- bash -lc "command -v niri >/dev/null 2>&1 && echo yes || echo no"
    $niriPresent = ($niriPresent -replace "`0", "").Trim()
    if ($niriPresent -ne "yes") {
        Write-Step "Installing niri (not found in distro)"
        Ensure-GuestNiri -Name $DistroName
    } else {
        Write-Host "  niri already installed, skipping"
    }
}

Write-Step "Starting BoostOS remoting services"
Invoke-WslRoot -Name $DistroName -Command @"
service dbus start >/dev/null 2>&1 || true
service xrdp stop >/dev/null 2>&1 || true
service xrdp-sesman stop >/dev/null 2>&1 || true
pkill -x xrdp >/dev/null 2>&1 || true
pkill -x xrdp-sesman >/dev/null 2>&1 || true
rm -f /run/xrdp/xrdp.pid /run/xrdp/xrdp-sesman.pid >/dev/null 2>&1 || true
service xrdp-sesman start
service xrdp start
"@

Write-Step "Refreshing localhost RDP forwarding"
Invoke-WslRoot -Name $DistroName -Command @"
python3 - <<'PY'
from pathlib import Path

in_globals = False
for line in Path('/etc/xrdp/xrdp.ini').read_text().splitlines():
    stripped = line.strip()
    if stripped == '[Globals]':
        in_globals = True
        continue
    if in_globals and stripped.startswith('['):
        break
    if in_globals and stripped.startswith('port='):
        print(stripped)
        break
PY
"@

$networkingMode = Get-WslNetworkingMode
if ($UseRelay) {
    $boostOsIp = Get-BoostOsIp -Name $DistroName
    Start-Relay -Name $DistroName -TargetHost $boostOsIp -ListenPort $RdpPort -TargetPort $GuestRdpPort
    $connectionTarget = "localhost:$RdpPort"
}
elseif ($networkingMode -eq "mirrored") {
    $connectionTarget = "localhost:$RdpPort"
}
else {
    $boostOsIp = Get-BoostOsIp -Name $DistroName
    $connectionTarget = "${boostOsIp}:$RdpPort"
}
Write-Host "Connect with Remote Desktop to $connectionTarget"
Write-Host "Username: $LinuxUser"
Write-Host "XRDP session mode: $SessionMode"
Write-Host "If you have not already set a Linux password, run: wsl -d $DistroName -- passwd $LinuxUser"

# Keep a background WSL process alive so Windows does not auto-terminate the
# distro after the script's own wsl.exe calls exit.  The loop exits on its own
# once xrdp stops, which lets WSL idle-terminate normally at that point.
#
# wsl.exe launched directly with -WindowStyle Hidden exits immediately because it
# needs a console to stay alive while forwarding I/O.  Wrapping it in a hidden
# powershell.exe process provides that console.
Write-Step "Starting WSL keep-alive (exits when xrdp stops)"
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*boostos-keepalive*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$keepAliveBash = 'while pgrep -x xrdp >/dev/null 2>&1; do sleep 5; done'
Start-Process "powershell" -ArgumentList @(
    "-NonInteractive", "-NoProfile", "-WindowStyle", "Hidden",
    "-Command", "& wsl.exe -d '$DistroName' -u root -- bash -c '$keepAliveBash' # boostos-keepalive"
) -WindowStyle Hidden

if ($OpenMstsc) {
    Start-Process "mstsc.exe" "/v:$connectionTarget"
}
