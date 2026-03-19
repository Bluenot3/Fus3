$root = Split-Path -Parent $PSScriptRoot
$startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$launcherPath = Join-Path $startupDir "zencosbot-runner.cmd"

$content = @"
@echo off
cd /d "$root"
powershell -ExecutionPolicy Bypass -File "$root\scripts\start-telegram-runner.ps1" zencosbot
"@

Set-Content -Path $launcherPath -Value $content -Encoding ASCII
Write-Output "Installed startup launcher at $launcherPath"
