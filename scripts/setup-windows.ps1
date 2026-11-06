# Claude Quota Monitor - Windows Auto Setup (PowerShell)
# Configures 15-minute background reporting of the 5-hour quota + onlogon trigger.
# Only the CLIs installed on this machine are reported: Claude Code (claude), Antigravity (agy) and/or OpenAI Codex (codex).
# A missing CLI gets no scheduled task, and the clients themselves send nothing when their CLI is absent.

$ErrorActionPreference = "Stop"

$InstallDir = "$env:USERPROFILE\.claude\quota-monitor"
$ScriptPath = "$InstallDir\report_quota.py"
$AgyScriptPath = "$InstallDir\report_agy.py"
$CodexScriptPath = "$InstallDir\report_codex.py"
$KeyPath = "$env:USERPROFILE\.claude\claude-quota-secret-key.txt"
$SecretSrc = if ($env:CLAUDE_QUOTA_SECRET_KEY_FILE) { $env:CLAUDE_QUOTA_SECRET_KEY_FILE } else { Join-Path (Split-Path -Parent $PSScriptRoot) ".secrets\quota-key.txt" }
if ($env:CLAUDE_QUOTA_SECRET_KEY) { $SecretKey = $env:CLAUDE_QUOTA_SECRET_KEY.Trim() }
elseif (Test-Path $SecretSrc) { $SecretKey = (Get-Content $SecretSrc -Raw).Trim() }
elseif (Test-Path $KeyPath) { $SecretKey = (Get-Content $KeyPath -Raw).Trim() }
else { throw "No access key found. Put it in .secrets\quota-key.txt (gitignored) or set CLAUDE_QUOTA_SECRET_KEY. See docs/LOCAL_SECRETS.md" }

Write-Host "=== [1/4] Preparing directories ===" -ForegroundColor Cyan
if (-not (Test-Path "$InstallDir")) {
    New-Item -ItemType Directory -Path "$InstallDir" -Force | Out-Null
}
$ClaudeDir = "$env:USERPROFILE\.claude"
if (-not (Test-Path "$ClaudeDir")) {
    New-Item -ItemType Directory -Path "$ClaudeDir" -Force | Out-Null
}

# Save secret key
[IO.File]::WriteAllText($KeyPath, $SecretKey, (New-Object Text.UTF8Encoding $false))
Write-Host "✓ Secret key saved to: $KeyPath" -ForegroundColor Green

Write-Host "=== [2/4] Installing Python reporter script ===" -ForegroundColor Cyan
$ScriptFile = $MyInvocation.MyCommand.Path
if (-not $ScriptFile) {
  throw "Cannot locate this script on disk (running via irm | iex?). Clone the repo and run scripts\setup-windows.ps1 from inside it."
}
$CurrentDir = Split-Path -Parent $ScriptFile
$LocalSource = Join-Path $CurrentDir "..\client\report_quota.py"

if (Test-Path "$LocalSource") {
    Copy-Item -Path "$LocalSource" -Destination "$ScriptPath" -Force
} else {
  throw "client\report_quota.py not found. Run this script from inside a clone of the repo."
}

# Optional Agy (Antigravity CLI) reporter: imports report_quota.py, so both live in the same folder.
$AgySource = Join-Path $CurrentDir "..\client\report_agy.py"
if (-not (Test-Path "$AgySource")) {
  throw "client\report_agy.py not found. Run this script from inside a clone of the repo."
}
Copy-Item -Path "$AgySource" -Destination "$AgyScriptPath" -Force
# Optional Codex (OpenAI Codex CLI) reporter: also imports report_quota.py.
$CodexSource = Join-Path $CurrentDir "..\client\report_codex.py"
if (-not (Test-Path "$CodexSource")) {
  throw "client\report_codex.py not found. Run this script from inside a clone of the repo."
}
Copy-Item -Path "$CodexSource" -Destination "$CodexScriptPath" -Force

# v3 asks Claude Code itself for the quota and keeps no token: remove the cache older versions left behind.
Remove-Item -Path "$InstallDir\.token_cache.json" -Force -ErrorAction SilentlyContinue
Write-Host "✓ Reporter script installed at: $ScriptPath" -ForegroundColor Green

Write-Host "=== [3/4] Finding Python, detecting installed CLIs and running test execution ===" -ForegroundColor Cyan
$PythonExe = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $PythonExe) {
    $PythonExe = (Get-Command py -ErrorAction SilentlyContinue).Source
}
if (-not $PythonExe) {
    Write-Warning "Python not found in PATH! Please ensure Python 3 is installed."
    $PythonExe = "python"
}

Write-Host "Using Python: $PythonExe"
# The clients use the same search paths as at run time (Task Scheduler has a minimal PATH), so detection matches what will run.
function Get-DetectedBinary([string]$Script) {
    try {
        $out = & $PythonExe "$Script" --detect
        if ($out) { return ("$out").Trim() }
    } catch { }
    return ""
}
$ClaudeBin = Get-DetectedBinary $ScriptPath
$AgyBin = Get-DetectedBinary $AgyScriptPath
$CodexBin = Get-DetectedBinary $CodexScriptPath
$ClaudeShown = if ($ClaudeBin) { $ClaudeBin } else { "not installed" }
$AgyShown = if ($AgyBin) { $AgyBin } else { "not installed" }
Write-Host "  claude: $ClaudeShown"
$CodexShown = if ($CodexBin) { $CodexBin } else { "not installed" }
Write-Host "  agy:    $AgyShown"
Write-Host "  codex:  $CodexShown"
if (-not $ClaudeBin -and -not $AgyBin -and -not $CodexBin) {
    Write-Warning "None of 'claude' (Claude Code), 'agy' (Antigravity CLI) or 'codex' (Codex CLI) was found, so no reporting task was installed."
    Write-Warning "Install and log in to at least one of them, then re-run this script."
    exit 0
}
if ($ClaudeBin) {
    & $PythonExe "$ScriptPath" --no-jitter
    Write-Host "✓ Claude test run completed successfully!" -ForegroundColor Green
}
if ($AgyBin) {
    & $PythonExe "$AgyScriptPath" --no-jitter
    Write-Host "✓ Agy test run completed successfully!" -ForegroundColor Green
}
if ($CodexBin) {
    & $PythonExe "$CodexScriptPath" --no-jitter
    Write-Host "✓ Codex test run completed successfully!" -ForegroundColor Green
}

Write-Host "=== [4/4] Creating Windows Scheduled Tasks (Every 15 min + OnLogon) ===" -ForegroundColor Cyan
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

# Register via the ScheduledTasks module: Windows PowerShell 5.1 mangles embedded quotes
# when passing a /tr string to schtasks.exe, which breaks paths containing spaces.
function Register-QuotaTasks([string]$Name, [string]$Script, [string]$Log, [datetime]$FirstRun, [int]$EveryMinutes = 2) {
    $ActionArgs = "/c `"`"$PythonExe`" `"$Script`" >> `"$Log`" 2>&1`""
    $Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $ActionArgs
    # Recurring task: 2 minutes for Claude (its client dynamically sleeps up to 15m based on burn rate), 15 for Codex
    $RepeatTrigger = New-ScheduledTaskTrigger -Once -At $FirstRun -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
    Register-ScheduledTask -TaskName $Name -Action $Action -Trigger $RepeatTrigger -Settings $Settings -Force | Out-Null
    # OnLogon instant boot task
    $LogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    Register-ScheduledTask -TaskName "${Name}OnBoot" -Action $Action -Trigger $LogonTrigger -Settings $Settings -Force | Out-Null
}

if ($ClaudeBin) {
    Register-QuotaTasks "ClaudeQuotaMonitor" $ScriptPath "$InstallDir\quota.log" (Get-Date)
    Write-Host "✓ Claude tasks registered: ClaudeQuotaMonitor (every 15 minutes) and ClaudeQuotaMonitorOnBoot (on logon)" -ForegroundColor Green
}
if ($AgyBin) {
    # Offset by 7 minutes so the two heavy /usage scans do not start together.
    Register-QuotaTasks "AgyQuotaMonitor" $AgyScriptPath "$InstallDir\agy-quota.log" ((Get-Date).AddMinutes(7))
    Write-Host "✓ Agy tasks registered: AgyQuotaMonitor (every 15 minutes, +7 min offset) and AgyQuotaMonitorOnBoot (on logon)" -ForegroundColor Green
}

if ($CodexBin) {
    # Offset by 3 minutes so the CLI scans do not start together; the Codex client has no adaptive interval, so 15 minutes.
    Register-QuotaTasks "CodexQuotaMonitor" $CodexScriptPath "$InstallDir\codex-quota.log" ((Get-Date).AddMinutes(3)) 15
    Write-Host "✓ Codex tasks registered: CodexQuotaMonitor (every 15 minutes, +3 min offset) and CodexQuotaMonitorOnBoot (on logon)" -ForegroundColor Green
}

Write-Host "==========================================================" -ForegroundColor Green
Write-Host "🎉 Quota Monitor installed successfully on Windows!" -ForegroundColor Green
Write-Host "Logs: $InstallDir\quota.log (claude), $InstallDir\agy-quota.log (agy), $InstallDir\codex-quota.log (codex)" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
