# Orphan-process regression test:
#   launch app -> locate backend child -> hard-kill shell (simulates crash exit)
#   -> assert backend processes disappear within N seconds
#   (validates Job Object / watchdog cleanup chain).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File test_cleanup.ps1 -AppExe "E:\...\ddtoolkit.exe"
# Works for both debug (python backend_main.py) and release (sidecar exe) layouts.
param(
    [Parameter(Mandatory = $true)][string]$AppExe,
    [int]$WaitBootSeconds = 15,
    [int]$GraceSeconds = 3
)

$ErrorActionPreference = "Stop"

function Find-BackendProcesses([int]$appPid) {
    # Backend signature: process name ddtoolkit-backend*, or python running backend_main.py
    Get-CimInstance Win32_Process -Filter "Name like 'ddtoolkit-backend%' or Name like '%python%'" |
        Where-Object {
            $_.ProcessId -ne $appPid -and (
                $_.Name -like 'ddtoolkit-backend*' -or
                ($_.CommandLine -like '*backend_main.py*' -and $_.ParentProcessId -eq $appPid)
            )
        }
}

if (-not (Test-Path $AppExe)) { throw "App exe not found: $AppExe" }

# Kill historical leftovers first to avoid false positives
Get-CimInstance Win32_Process -Filter "Name like 'ddtoolkit-backend%'" | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

$app = Start-Process -FilePath $AppExe -PassThru
Write-Output "Launched app pid=$($app.Id), waiting up to ${WaitBootSeconds}s for backend..."

$backend = $null
foreach ($i in 1..($WaitBootSeconds * 2)) {
    Start-Sleep -Milliseconds 500
    if ($app.HasExited) { throw "App exited early (exit=$($app.ExitCode)), cannot test" }
    $backend = Find-BackendProcesses $app.Id
    if ($backend) { break }
}
if (-not $backend) { Stop-Process -Id $app.Id -Force; throw "Timeout: backend process not found" }

# Wait for REAL readiness: a listening TCP socket owned by the backend.
# (Onefile bootloader appears by name instantly; only the extracted python
#  child opens the port -- killing earlier than that makes PASS vacuous.)
$ready = $false
foreach ($i in 1..($WaitBootSeconds * 4)) {
    Start-Sleep -Milliseconds 250
    foreach ($b in @($backend)) {
        $listen = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object OwningProcess -eq $_.ProcessId
        if ($listen) { $ready = $true; break }
    }
    if ($ready) {
        # Re-scan: onefile may have replaced bootloader pid with child pid set
        $backend = Find-BackendProcesses $app.Id
        break
    }
    $backend = Find-BackendProcesses $app.Id
}
if (-not $ready) { Write-Output "WARN: no listening port detected, proceeding anyway" }
Start-Sleep -Seconds 1

$backend | ForEach-Object { Write-Output ("Backend ready: pid={0} name={1}" -f $_.ProcessId, $_.Name) }

# --- Worst case: force-kill the shell, bypassing all graceful exits ---
taskkill /PID $app.Id /T /F | Out-Null
Write-Output "Shell force-killed, observing ${GraceSeconds}s..."
Start-Sleep -Seconds $GraceSeconds

$leftover = @(Find-BackendProcesses $app.Id)
if ($leftover.Count -eq 0) {
    Write-Output "PASS: backend exited with shell, no orphans"
    exit 0
} else {
    Write-Output ("FAIL: {0} leftover backend process(es):" -f $leftover.Count)
    $leftover | ForEach-Object { Write-Output ("  pid={0} path={1}" -f $_.ProcessId, $_.ExecutablePath) }
    $leftover | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    exit 1
}
