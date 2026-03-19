$bot = if ($args.Length -gt 0) { $args[0] } else { "zencosbot" }
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root "storage\telegram\runner-$bot.pid"

function Get-RunnerProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -like "*telegram-polling-runner.js*" -and
    $_.CommandLine -like "*--bot $bot*"
  }
}

$processes = @(Get-RunnerProcesses)
if (-not $processes.Length) {
  Write-Output "No active runner process found for $bot."
} else {
  foreach ($process in $processes) {
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
      Write-Output "Stopped Telegram runner for $bot (PID $($process.ProcessId))."
    } catch {
      Write-Output "Could not stop runner PID $($process.ProcessId) for $bot."
    }
  }
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
