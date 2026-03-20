const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { execFile, spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const STORAGE_DIR = path.join(ROOT, "storage", "telegram");
const LOG_DIR = path.join(STORAGE_DIR, "logs");

function botArg() {
  return process.argv[3] || "zencosbot";
}

function pidFilePath(bot) {
  return path.join(STORAGE_DIR, `runner-${bot}.pid`);
}

function logPaths(bot) {
  return {
    out: path.join(LOG_DIR, `runner-${bot}.out.log`),
    err: path.join(LOG_DIR, `runner-${bot}.err.log`)
  };
}

function escapePowerShell(value) {
  return String(value).replace(/'/g, "''");
}

function execPowerShell(command) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { windowsHide: true, cwd: ROOT, timeout: 15000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || stdout.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

async function findRunnerProcesses(bot) {
  const query = [
    "Get-CimInstance Win32_Process | Where-Object {",
    "  $_.Name -eq 'node.exe' -and",
    "  $_.CommandLine -like '*telegram-polling-runner.js*' -and",
    "  $_.CommandLine -like ('*--bot ' + $bot + '*')",
    "} | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"
  ].join(" ");
  const script = "$bot = '" + escapePowerShell(bot) + "'; " + query;

  const output = await execPowerShell(script).catch(() => "");
  if (!output) {
    return [];
  }
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function tailFile(filePath, lineCount = 20) {
  try {
    const data = await fsp.readFile(filePath, "utf8");
    return data.split(/\r?\n/).filter(Boolean).slice(-lineCount).join("\n");
  } catch {
    return "";
  }
}

async function ensureDirs() {
  await fsp.mkdir(LOG_DIR, { recursive: true });
}

async function writePidFile(bot, pid) {
  await fsp.mkdir(STORAGE_DIR, { recursive: true });
  await fsp.writeFile(pidFilePath(bot), String(pid), "utf8");
}

async function removePidFile(bot) {
  try {
    await fsp.unlink(pidFilePath(bot));
  } catch {}
}

async function start(bot) {
  await ensureDirs();
  const existing = await findRunnerProcesses(bot);
  if (existing.length) {
    await writePidFile(bot, existing[0].ProcessId);
    console.log(`Runner already active for ${bot} (PID ${existing[0].ProcessId}).`);
    return;
  }

  const logs = logPaths(bot);
  await fsp.writeFile(logs.out, "", "utf8");
  await fsp.writeFile(logs.err, "", "utf8");
  const outFd = fs.openSync(logs.out, "a");
  const errFd = fs.openSync(logs.err, "a");
  const child = spawn(process.execPath, ["scripts/telegram-polling-runner.js", "--bot", bot], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", outFd, errFd]
  });

  child.unref();
  await writePidFile(bot, child.pid);
  console.log(`Started Telegram runner for ${bot} (PID ${child.pid}).`);
}

async function stop(bot) {
  const existing = await findRunnerProcesses(bot);
  if (!existing.length) {
    await removePidFile(bot);
    console.log(`No active runner process found for ${bot}.`);
    return;
  }

  for (const processInfo of existing) {
    try {
      await execPowerShell(`Stop-Process -Id ${Number(processInfo.ProcessId)} -Force`);
      console.log(`Stopped Telegram runner for ${bot} (PID ${processInfo.ProcessId}).`);
    } catch (error) {
      console.log(`Could not stop runner PID ${processInfo.ProcessId} for ${bot}: ${error.message}`);
    }
  }
  await removePidFile(bot);
}

async function status(bot) {
  await ensureDirs();
  const existing = await findRunnerProcesses(bot);
  const logs = logPaths(bot);

  if (!existing.length) {
    console.log(`Runner is not started for ${bot}.`);
  } else {
    for (const processInfo of existing) {
      console.log(`Runner active for ${bot} (PID ${processInfo.ProcessId}).`);
    }
    await writePidFile(bot, existing[0].ProcessId);
  }

  const recentErr = await tailFile(logs.err);
  if (recentErr) {
    console.log("");
    console.log("Recent stderr:");
    console.log(recentErr);
  }
}

async function installAutostart(bot) {
  const startupDir = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  await fsp.mkdir(startupDir, { recursive: true });
  const launcherPath = path.join(startupDir, `${bot}-runner.cmd`);
  const content = [
    "@echo off",
    `cd /d "${ROOT}"`,
    `node scripts\\telegram-runner-control.js start ${bot}`
  ].join("\r\n");
  await fsp.writeFile(launcherPath, content, "ascii");
  console.log(`Installed startup launcher at ${launcherPath}`);
}

async function main() {
  const action = process.argv[2];
  const bot = botArg();

  if (action === "start") {
    await start(bot);
    return;
  }
  if (action === "stop") {
    await stop(bot);
    return;
  }
  if (action === "status") {
    await status(bot);
    return;
  }
  if (action === "install-autostart") {
    await installAutostart(bot);
    return;
  }

  console.log("Usage: node scripts/telegram-runner-control.js <start|stop|status|install-autostart> [bot]");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
