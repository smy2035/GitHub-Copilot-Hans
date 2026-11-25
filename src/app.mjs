// 负责找到 GitHub Copilot 桌面版、检测运行状态、带调试端口重启。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

export const DEFAULT_PORT = 9333;
// Tauri 默认传给 WebView2 的参数。设置 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 时
// 会覆盖应用自带的参数，所以要把它们一并带上，避免改变应用原有行为。
const FALLBACK_DISABLE_FEATURES =
  'msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion,UiaProvider,AccessibilityBlockFlowIterator';

export const DATA_DIR = process.env.COPILOT_HANS_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'copilot-hans');

export function findAppExe() {
  const candidates = [
    process.env.COPILOT_HANS_EXE,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub Copilot', 'github.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub Copilot', 'github.exe'),
  ].filter(Boolean);
  const running = listAppProcesses()[0]?.path;
  if (running) candidates.unshift(running);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function powershellJson(script) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return [];
    const data = JSON.parse(out);
    return Array.isArray(data) ? data : [data];
  } catch {
    return [];
  }
}

// 只认安装目录名为 "GitHub Copilot" 的 github.exe，避免误伤同名程序。
export function listAppProcesses() {
  return powershellJson(
    "Get-CimInstance Win32_Process -Filter \"Name='github.exe'\" | " +
      'Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress',
  )
    .filter((p) => p.ExecutablePath && /[\\/]GitHub Copilot[\\/]github\.exe$/i.test(p.ExecutablePath))
    .map((p) => ({ pid: p.ProcessId, parent: p.ParentProcessId, path: p.ExecutablePath }));
}

// 读取当前 WebView2 进程的 --disable-features，保证重启后参数与原来一致。
export function currentDisableFeatures(appPids) {
  if (!appPids.length) return null;
  const rows = powershellJson(
    "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | " +
      'Select-Object ParentProcessId,CommandLine | ConvertTo-Json -Compress',
  );
  for (const row of rows) {
    if (!appPids.includes(row.ParentProcessId) || !row.CommandLine) continue;
    const m = row.CommandLine.match(/--disable-features=(\S+)/);
    if (m) return m[1];
  }
  return null;
}

export async function isPortAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    const info = await res.json();
    return typeof info.webSocketDebuggerUrl === 'string';
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 先礼后兵：先发送正常关闭请求，超时后再强制结束整个进程树。
export async function closeApp({ log = console.log } = {}) {
  let procs = listAppProcesses();
  if (!procs.length) return true;
  const roots = procs.filter((p) => !procs.some((q) => q.pid === p.parent));
  for (const p of roots) {
    try { execFileSync('taskkill', ['/PID', String(p.pid)], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  }
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (!listAppProcesses().length) return true;
  }
  log('应用未在 10 秒内退出（可能最小化到托盘），强制结束…');
  procs = listAppProcesses();
  for (const p of procs) {
    try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  }
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (!listAppProcesses().length) return true;
  }
  return false;
}

export function launchApp(exe, port, disableFeatures) {
  const args = [
    `--disable-features=${disableFeatures || FALLBACK_DISABLE_FEATURES}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
  ];
  const child = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(exe),
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: args.join(' ') },
  });
  child.unref();
  return child.pid;
}

export async function waitForPort(port, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortAlive(port)) return true;
    await sleep(500);
  }
  return false;
}
