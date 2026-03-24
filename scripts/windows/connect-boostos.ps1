[CmdletBinding()]
param(
    [string]$DistroName = "BoostOS",
    [string]$LinuxUser = "boost",
    [int]$RdpPort = 3390,
    [int]$GuestRdpPort = 3391,
    [ValidateSet("minimal", "xfce")]
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

    & wsl.exe -d $Name -u root -- bash -lc $Command
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

    $command = @"
set -euo pipefail
umount /tmp/.X11-unix 2>/dev/null || true
install -d -m 01777 /tmp/.X11-unix
install -d -m 0755 /etc/xrdp
install -d -m 0755 /etc/boostos/xrdp
install -m 0755 '$configRoot/startwm.sh' /etc/xrdp/startwm.sh
install -m 0755 '$configRoot/startwm-common.sh' /etc/boostos/xrdp/startwm-common.sh
install -m 0755 '$configRoot/startwm-minimal.sh' /etc/boostos/xrdp/startwm-minimal.sh
install -m 0755 '$configRoot/startwm-xfce.sh' /etc/boostos/xrdp/startwm-xfce.sh
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
