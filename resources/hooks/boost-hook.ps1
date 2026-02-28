# Boost Workflow Automation - PowerShell Hook
# This script captures command history and sends it to the Boost app via HTTP.
#
# Installation:
# 1. This script is automatically added to your PowerShell profile by Boost
# 2. It overrides the `prompt` function to capture commands after execution
# 3. Sends command data to localhost:45678 (Boost HTTP server)
#
# Privacy:
# - Commands are stored locally only
# - No data is sent to external servers
# - You can disable this hook by removing it from your profile

if (Get-Variable -Name BOOST_HOOK_LOADED -Scope Global -ErrorAction SilentlyContinue) {
    return
}
$global:BOOST_HOOK_LOADED = $true

# Configuration
$BOOST_SERVER_URL = "http://localhost:45678/command"
$BOOST_SESSION_ID = [System.Guid]::NewGuid().ToString()
$BOOST_SESSION_TAG = "boost-$($BOOST_SESSION_ID.Substring(0, 8))"
$env:BOOST_TERMINAL_SESSION_ID = $BOOST_SESSION_ID
$env:BOOST_TERMINAL_SESSION_TAG = $BOOST_SESSION_TAG
$BOOST_HOOK_DIR = Split-Path -Parent $PSCommandPath
$BOOST_BIN_DIR = Join-Path (Split-Path -Parent $BOOST_HOOK_DIR) "bin"
$BOOST_CLI_SCRIPT = Join-Path $BOOST_BIN_DIR "boost.ps1"

# Ensure `boost ...` works in every PowerShell session even if PATH is stale.
function global:boost {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)

    if (-not (Test-Path $BOOST_CLI_SCRIPT)) {
        Write-Error "Boost CLI shim not found at $BOOST_CLI_SCRIPT. Re-run setup from Boost Settings."
        return
    }

    & $BOOST_CLI_SCRIPT @Args
}

# Terminal shorthand support: `:start`, `:spawn codex`, etc.
$BOOST_SHORT_COMMANDS = @(
    'init',
    'start',
    'back',
    'resume',
    'switch',
    'save',
    'status',
    'version',
    'jump',
    'spawn',
    'test',
    'search',
    'ask'
)

foreach ($commandName in $BOOST_SHORT_COMMANDS) {
    $functionName = ":$commandName"
    Set-Item -Path ("Function:\" + $functionName) -Value {
        param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
        $invoked = $MyInvocation.MyCommand.Name.TrimStart(':')
        $allArgs = @($invoked) + $Args
        boost @allArgs
    }
}

# Store the original prompt function
$BOOST_ORIGINAL_PROMPT = if (Test-Path Function:\prompt) {
    Get-Content Function:\prompt
} else {
    'PS $($executionContext.SessionState.Path.CurrentLocation)$(''>'' * ($nestedPromptLevel + 1)) '
}

# Track last command for deduplication
$BOOST_LAST_COMMAND_ID = 0
$BOOST_LAST_COMMAND_TIME = Get-Date

# Override the prompt function
function prompt {
    # Stamp terminal title so integrated-terminal quick-switch can target this session.
    try {
        $esc = [char]27
        $title = "$BOOST_SESSION_TAG :: $($PWD.Path)"
        Write-Host -NoNewline "$esc]0;$title`a"
    } catch {
        # Ignore terminal title update failures.
    }

    # Get current command from history
    $history = Get-History -Count 1 -ErrorAction SilentlyContinue

    if ($history -and $history.Id -ne $BOOST_LAST_COMMAND_ID) {
        $BOOST_LAST_COMMAND_ID = $history.Id

        # Calculate duration
        $duration = if ($BOOST_LAST_COMMAND_TIME) {
            [int](((Get-Date) - $BOOST_LAST_COMMAND_TIME).TotalMilliseconds)
        } else {
            $null
        }

        $BOOST_LAST_COMMAND_TIME = Get-Date

        # Build command event payload
        $event = @{
            command = $history.CommandLine
            cwd = $PWD.Path
            shell = 'powershell'
            exit_code = $LASTEXITCODE
            duration_ms = $duration
            timestamp = (Get-Date).ToUniversalTime().ToString('o')
            session_id = $BOOST_SESSION_ID
            env = @{
                BOOST_MODE = $env:BOOST_MODE
                NODE_ENV = $env:NODE_ENV
                CI = $env:CI
            }
        } | ConvertTo-Json -Compress

        # Send to Boost server (async, non-blocking)
        try {
            # Use Start-Job for true async (doesn't block prompt)
            $null = Start-Job -ScriptBlock {
                param($url, $body)
                try {
                    Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 1 -ErrorAction SilentlyContinue | Out-Null
                } catch {
                    # Silently fail if server not running
                }
            } -ArgumentList $BOOST_SERVER_URL, $event

            # Clean up completed jobs (prevent job accumulation)
            Get-Job -State Completed | Remove-Job -ErrorAction SilentlyContinue
        } catch {
            # Silently fail - don't interrupt user's workflow
        }
    }

    # Call original prompt
    $BOOST_LAST_COMMAND_TIME = Get-Date
    Invoke-Expression $BOOST_ORIGINAL_PROMPT
}

# Restore prompt on module unload when running inside a module context.
if ($ExecutionContext.SessionState.Module -and
    $ExecutionContext.SessionState.Module.PSObject.Properties.Name -contains 'OnRemove') {
    $ExecutionContext.SessionState.Module.OnRemove = {
        Set-Item Function:\prompt -Value ([ScriptBlock]::Create($BOOST_ORIGINAL_PROMPT))
    }
}

Write-Host "✨ Boost workflow automation enabled" -ForegroundColor Green
Write-Host "   Commands will be recorded for workflow creation" -ForegroundColor Gray
Write-Host "   Use: boost <command> or :<command>" -ForegroundColor Gray
Write-Host "   To disable, remove this hook from your PowerShell profile" -ForegroundColor Gray
Write-Host ""
