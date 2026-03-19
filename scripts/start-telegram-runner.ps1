$ErrorActionPreference = "Stop"

$bot = if ($args.Length -gt 0) { $args[0] } else { "zencosbot" }
$root = Split-Path -Parent $PSScriptRoot
$storage = Join-Path $root "storage\telegram"
$logs = Join-Path $storage "logs"
$pidFile = Join-Path $storage "runner-$bot.pid"
$outLog = Join-Path $logs "runner-$bot.out.log"
$errLog = Join-Path $logs "runner-$bot.err.log"

New-Item -ItemType Directory -Force -Path $logs | Out-Null

if (Test-Path $pidFile) {
  $existingPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($existingPid) {
    try {
      $process = Get-Process -Id $existingPid -ErrorAction Stop
      Write-Output "Runner already active for $bot (PID $($process.Id))."
      exit 0
    } catch {
      Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
  }
}

$process = Start-Process -FilePath "node" `
  -ArgumentList "scripts/telegram-polling-runner.js", "--bot", $bot `
  -WorkingDirectory $root `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -PassThru

Set-Content -Path $pidFile -Value $process.Id
Write-Output "Started Telegram runner for $bot (PID $($process.Id))."
