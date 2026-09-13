# One-shot repo directory rename: http-test -> ddtoolkit
#
# Why deferred: Windows refuses to rename a directory that has an open handle, and DSH
# both is the local dev tool AND uses this repo as its working directory (the `dsh web`
# process CWD lives inside it). So while DSH runs, the rename always fails -- which is
# exactly why the TODO item "rename directory" has been sitting there.
#
# This script is registered as a logon task (DDToolkit-RenameRepo). It retries, writes
# its verdict to a log, then unregisters the task and deletes itself.
#
# Run manually (after closing DSH):
#   powershell -NoProfile -ExecutionPolicy Bypass -File E:\work\Project\http-test\scripts\rename_repo_dir.ps1
#
# NOTE: ASCII-only on purpose. This file gets read by both PowerShell 5.1 and 7 under
# different console codepages; non-ASCII here previously mangled into a parse error.

$ErrorActionPreference = 'Stop'
$src  = 'E:\work\Project\http-test'
$dst  = 'E:\work\Project\ddtoolkit'
$log  = Join-Path $env:TEMP 'ddtoolkit-rename.log'
$task = 'DDToolkit-RenameRepo'

function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    try { Add-Content -LiteralPath $log -Value $line -Encoding UTF8 } catch {}
    Write-Host $line
}

function Unregister-Self {
    try { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue } catch {}
    try { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue } catch {}
}

Write-Log "start (src=$src)"

if (-not (Test-Path -LiteralPath $src)) {
    if (Test-Path -LiteralPath $dst) { Write-Log "src gone, dst exists -> already done, exiting" }
    else { Write-Log "neither src nor dst exists -> giving up" }
    Unregister-Self
    exit 0
}
if (Test-Path -LiteralPath $dst) {
    Write-Log "dst already exists ($dst) -> refusing to overwrite, giving up"
    Unregister-Self
    exit 0
}

$renamed = $false
for ($i = 1; $i -le 12; $i++) {
    try {
        Rename-Item -LiteralPath $src -NewName 'ddtoolkit' -ErrorAction Stop
        $renamed = $true
        Write-Log "attempt $i : RENAMED OK"
        break
    } catch {
        Write-Log "attempt $i failed: $($_.Exception.Message.Trim())"
        Start-Sleep -Seconds 10
    }
}

if (-not $renamed) {
    Write-Log "all 12 attempts failed -- most likely DSH is still running and holding the dir."
    Write-Log "Fix: close DSH, then run:"
    Write-Log "  Rename-Item -LiteralPath '$src' -NewName 'ddtoolkit'"
    exit 1   # keep the task registered so the next logon tries again
}

# Post-rename sanity check
if (Test-Path -LiteralPath (Join-Path $dst '.git')) { Write-Log "check: .git present OK" }
else { Write-Log "WARN: .git not found, verify manually" }
if (Test-Path -LiteralPath (Join-Path $dst 'backend_main.py')) { Write-Log "check: backend_main.py present OK" }
else { Write-Log "WARN: backend_main.py not found, verify manually" }

Write-Log "done: $src -> $dst"
Unregister-Self
exit 0
