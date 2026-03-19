$bot = if ($args.Length -gt 0) { $args[0] } else { "zencosbot" }
$root = Split-Path -Parent $PSScriptRoot
$storage = Join-Path $root "storage\telegram"
$pidFile = Join-Path $storage "runner-$bot.pid"
$errLog = Join-Path $storage "logs\runner-$bot.err.log"

function Get-RunnerProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -like "*telegram-polling-runner.js*" -and
    $_.CommandLine -like "*--bot $bot*"
  }
}

$processes = @(Get-RunnerProcesses)
if (-not $processes.Length) {
  Write-Output "Runner is not started for $bot."
} else {
  foreach ($process in $processes) {
    Write-Output "Runner active for $bot (PID $($process.ProcessId))."
  }
  Set-Content -Path $pidFile -Value $processes[0].ProcessId
}

if (Test-Path $errLog) {
  Write-Output ""
  Write-Output "Recent stderr:"
  Get-Content $errLog -Tail 20
}
