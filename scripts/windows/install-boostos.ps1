[CmdletBinding()]
param(
    [string]$DistroName = "BoostOS",
    [string]$BaseDistro = "Ubuntu-24.04",
    [int]$RdpPort = 3390,
    [string]$LinuxUser = "boost",
    [string]$InstallRoot = "$env:LOCALAPPDATA\BoostOS\wsl",
    [switch]$SkipProvision
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Test-Administrator {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

function Get-DistroList {
    $raw = & wsl.exe --list --quiet 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to list WSL distros."
    }

    $clean = $raw -replace "`0", "" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    return @($clean)
}

function Install-BaseDistro {
    param([string]$Name)

    $distros = Get-DistroList
    if ($distros -contains $Name) {
        return
    }

    Write-Step "Installing base distro $Name"
    & wsl.exe --install -d $Name
    if ($LASTEXITCODE -ne 0) {
        throw "WSL distro install failed for $Name."
    }
}

function Ensure-BoostOsDistro {
    param(
        [string]$TargetName,
        [string]$SourceName,
        [string]$TargetInstallRoot
    )

    $distros = Get-DistroList
    if ($distros -contains $TargetName) {
        return
    }

    if (-not ($distros -contains $SourceName)) {
        throw "Expected source distro $SourceName to exist before rename."
    }

    $resolvedInstallRoot = [System.IO.Path]::GetFullPath($TargetInstallRoot)
    $targetPath = Join-Path $resolvedInstallRoot $TargetName
    $exportPath = Join-Path $env:TEMP "$TargetName-base.tar"

    Write-Step "Cloning $SourceName into $TargetName"
    New-Item -ItemType Directory -Force -Path $resolvedInstallRoot | Out-Null
    if (Test-Path $targetPath) {
        throw "Target install path already exists: $targetPath"
    }

    & wsl.exe --export $SourceName $exportPath
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to export $SourceName."
    }

    try {
        & wsl.exe --import $TargetName $targetPath $exportPath --version 2
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to import $TargetName."
        }
    }
    finally {
        if (Test-Path $exportPath) {
            Remove-Item -Force $exportPath
        }
    }
}

function Assert-WslVersion2 {
    param([string]$Name)

    $raw = & wsl.exe --list --verbose 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to inspect WSL versions."
    }

    $clean = $raw -replace "`0", ""
    $line = $clean | Select-String -Pattern "^\s*\*?\s*$([regex]::Escape($Name))\s+.+\s+2\s*$"
    if (-not $line) {
        throw "$Name is not running as a WSL2 distro."
    }
}

function Invoke-Wsl {
    param(
        [string]$Name,
        [string]$Command
    )

    & wsl.exe -d $Name -- bash -lc $Command
    if ($LASTEXITCODE -ne 0) {
        throw "WSL command failed: $Command"
    }
}

function Ensure-LinuxUser {
    param(
        [string]$Name,
        [string]$User
    )

    Write-Step "Ensuring Linux user $User"
    $escapedUser = $User.Replace("'", "'\''")
    $command = @"
if ! id -u '$escapedUser' >/dev/null 2>&1; then
  sudo useradd -m -s /bin/bash '$escapedUser'
  echo 'Create a password for the Linux user after provisioning if you plan to use xrdp login interactively.'
fi
"@
    Invoke-Wsl -Name $Name -Command $command
}

function Copy-RepoAssets {
    param(
        [string]$Name,
        [string]$User
    )

    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
    $linuxRepoPath = "/mnt/c" + ($repoRoot.Substring(2) -replace "\\", "/")
    $linuxUser = $User.Replace("'", "'\''")

    Write-Step "Copying repo assets into the distro"
    $command = @"
set -euo pipefail
sudo mkdir -p /opt/boostos
sudo rm -rf /opt/boostos/scripts /opt/boostos/config /opt/boostos/src
sudo mkdir -p /opt/boostos/scripts /opt/boostos/config /opt/boostos/src
sudo cp -R '$linuxRepoPath/scripts/linux/.' /opt/boostos/scripts/
sudo cp -R '$linuxRepoPath/config/.' /opt/boostos/config/
sudo cp -R '$linuxRepoPath/src/.' /opt/boostos/src/
sudo chown -R '$linuxUser':'$linuxUser' /opt/boostos
"@
    Invoke-Wsl -Name $Name -Command $command
}


function Invoke-Provision {
    param(
        [string]$Name,
        [string]$User,
        [int]$Port
    )

    Write-Step "Provisioning BoostOS inside WSL"
    $escapedUser = $User.Replace("'", "'\''")
    $command = "sudo /opt/boostos/scripts/provision-phase1.sh --user '$escapedUser' --rdp-port '$Port'"
    Invoke-Wsl -Name $Name -Command $command
}

function Set-WslUserDefault {
    param(
        [string]$Name,
        [string]$User
    )

    Write-Step "Setting default user for $Name"
    & wsl.exe --manage $Name --set-default-user $User
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Falling back to /etc/wsl.conf for default user configuration."
        $escapedUser = $User.Replace("'", "'\''")
        $command = @"
cat >/etc/wsl.conf <<'EOF'
[user]
default=$escapedUser
EOF
"@
        & wsl.exe -d $Name -u root -- bash -lc $command
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not set default user automatically. Set it manually if needed."
        }
    }
}

Assert-Command -Name "wsl.exe"

if (-not (Test-Administrator)) {
    Write-Warning "Running without elevation. This is fine if WSL is already enabled and the distro install does not require admin."
}

Write-Step "Checking WSL status"
& wsl.exe --status
if ($LASTEXITCODE -ne 0) {
    throw "WSL is not available or not configured."
}

Install-BaseDistro -Name $BaseDistro
Ensure-BoostOsDistro -TargetName $DistroName -SourceName $BaseDistro -TargetInstallRoot $InstallRoot
Assert-WslVersion2 -Name $DistroName
Ensure-LinuxUser -Name $DistroName -User $LinuxUser
Copy-RepoAssets -Name $DistroName -User $LinuxUser

if (-not $SkipProvision) {
    Invoke-Provision -Name $DistroName -User $LinuxUser -Port $RdpPort
    Set-WslUserDefault -Name $DistroName -User $LinuxUser
}

Write-Step "BoostOS bootstrap complete"
Write-Host "Next steps:"
Write-Host "1. Set a password for the Linux user: wsl -d $DistroName -- passwd $LinuxUser"
Write-Host "2. Connect: .\scripts\windows\connect-boostos.ps1 -DistroName $DistroName -LinuxUser $LinuxUser -RdpPort $RdpPort"
