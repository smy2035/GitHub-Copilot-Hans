#!/usr/bin/env node
// GitHub Copilot 桌面版汉化工具 - 命令行入口
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PORT, DATA_DIR, findAppExe, listAppProcesses, currentDisableFeatures,
  isPortAlive, closeApp, launchApp, waitForPort,
} from './app.mjs';
import { runMonitor, readMonitorInfo, PID_FILE, LOG_FILE } from './monitor.mjs';
import { listTargets, CdpSession, isAppPage } from './cdp.mjs';
import { buildOverlay, ROOT } from './build-overlay.mjs';
import { loadDictionary } from './dictionary.mjs';

const CLI = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(option('port', process.env.COPILOT_HANS_PORT || DEFAULT_PORT));
const quiet = flag('quiet');
const log = (...m) => { if (!quiet) console.log(...m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function confirm(question) {
  if (flag('yes')) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

function spawnMonitor() {
  const child = spawn(process.execPath, [CLI, 'monitor', '--port', String(port)], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}

async function waitForInjection(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = readMonitorInfo();
    if (info && info.injected > 0) return info;
    await sleep(500);
  }
  return null;
}

async function cmdStart({ attachOnly = false, confirmed = false } = {}) {
  const running = readMonitorInfo();
  if (running && (await isPortAlive(running.port))) {
    log(`汉化已在运行（端口 ${running.port}，已注入 ${running.injected} 个页面）。`);
    return 0;
  }

  if (!(await isPortAlive(port))) {
    if (attachOnly) {
      console.error(`端口 ${port} 没有可连接的 GitHub Copilot。请先用「启动汉化」重启应用。`);
      return 1;
    }
    const exe = findAppExe();
    if (!exe) {
      console.error('没有找到 GitHub Copilot 桌面版（github.exe）。可设置环境变量 COPILOT_HANS_EXE 指定路径。');
      return 1;
    }
    const procs = listAppProcesses();
    let disableFeatures = null;
    if (procs.length) {
      log('GitHub Copilot 正在运行，将重启一次以开启汉化（会话记录会保留）。');
      if (!confirmed && !(await confirm('现在重启 GitHub Copilot？'))) {
        log('已取消。');
        return 1;
      }
      disableFeatures = currentDisableFeatures(procs.map((p) => p.pid));
      log('正在关闭 GitHub Copilot…');
      if (!(await closeApp({ log }))) {
        console.error('无法关闭 GitHub Copilot，请手动退出后重试。');
        return 1;
      }
    }
    log('正在以调试模式启动 GitHub Copilot…');
    launchApp(exe, port, disableFeatures);
    if (!(await waitForPort(port, 90000))) {
      console.error(`等待调试端口 ${port} 超时。可能原因：端口被占用（用 --port 换一个），或系统策略禁用了 WebView2 调试。`);
      return 1;
    }
  }

  spawnMonitor();
  log('正在注入汉化脚本…');
  const info = await waitForInjection();
  if (!info) {
    console.error(`未能注入，请查看日志：${LOG_FILE}`);
    return 1;
  }
  log(`✓ 汉化已生效（${info.entries} 条词条）。右下角「中」按钮可切换中英文。`);
  log('  修改 dict/ 或 custom-translations.txt 后会自动热更新。');
  return 0;
}

function cmdStop() {
  const info = readMonitorInfo();
  if (!info) {
    log('监视器未运行。');
    return 0;
  }
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  try { process.kill(info.pid); } catch { /* ignore */ }
  log(`已停止监视器 (PID ${info.pid})。当前页面的汉化会保留到页面刷新或应用重启。`);
  return 0;
}

async function cmdStatus() {
  const info = readMonitorInfo();
  const alive = await isPortAlive(info?.port || port);
  log(`GitHub Copilot 进程：${listAppProcesses().length ? '运行中' : '未运行'}`);
  log(`调试端口 ${info?.port || port}：${alive ? '可用' : '不可用'}`);
  log(info ? `监视器：运行中 (PID ${info.pid})，已注入 ${info.injected} 个页面，词条 ${info.entries}` : '监视器：未运行');
  log(`日志：${LOG_FILE}`);
  return 0;
}

// 从页面收集界面上出现过、但词典里没有的英文，方便补充词典。
async function cmdDump() {
  const p = readMonitorInfo()?.port || port;
  let targets;
  try { targets = (await listTargets(p)).filter(isAppPage); } catch {
    console.error('无法连接调试端口，请先启动汉化。');
    return 1;
  }
  const dict = loadDictionary(ROOT);
  const found = new Set();
  for (const t of targets) {
    try {
      const s = await CdpSession.connect(t.webSocketDebuggerUrl);
      const list = await s.evaluate('JSON.stringify([...(window.__copilotHans?.missing || [])])');
      for (const x of JSON.parse(list || '[]')) if (!dict.has(x)) found.add(x);
      s.close();
    } catch { /* ignore */ }
  }
  const out = path.join(ROOT, 'build', 'missing.txt');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  let previous = [];
  try { previous = fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* ignore */ }
  const all = [...new Set([...previous, ...found])].filter((x) => !dict.has(x)).sort();
  fs.writeFileSync(out, all.join('\n') + '\n');
  log(`本次收集到 ${found.size} 条未翻译文本，累计 ${all.length} 条 -> ${out}`);
  return 0;
}

function cmdShortcut() {
  const exe = findAppExe();
  const desktop = path.join(os.homedir(), 'Desktop');
  const lnk = path.join(desktop, 'GitHub Copilot 中文版.lnk');
  const q = (s) => s.replace(/'/g, "''");
  const script = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut(\'' + q(lnk) + '\')',
    '$s.TargetPath = \'' + q(process.execPath) + '\'',
    '$s.Arguments = \'"' + q(CLI) + '" start --yes --quiet\'',
    '$s.WorkingDirectory = \'' + q(ROOT) + '\'',
    '$s.WindowStyle = 7',
    exe ? '$s.IconLocation = \'' + q(exe) + ',0\'' : '',
    '$s.Description = \'启动 GitHub Copilot 并自动汉化\'',
    '$s.Save()',
  ].filter(Boolean).join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit' });
  log(`已创建桌面快捷方式：${lnk}`);
  log('以后用它代替原来的图标启动 GitHub Copilot 即可自动汉化。');
  return 0;
}

function cmdBuild() {
  const o = buildOverlay();
  const out = path.join(ROOT, 'build', 'copilot-hans-overlay.js');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, o.source);
  log(`已生成 ${out}（${o.entries} 条词条，自定义 ${o.custom} 条，版本 ${o.version}）`);
  return 0;
}

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n  GitHub Copilot 汉化工具\n');
  console.log('  1. 启动汉化（会直接重启 GitHub Copilot，正在运行的任务会中断）');
  console.log('  2. 创建桌面快捷方式（以后双击它即可中文启动）');
  console.log('  0. 退出\n');
  console.log('  其他维护命令见 README，或运行：GitHub-Copilot-Hans.cmd help\n');
  const choice = (await rl.question('请选择：')).trim();
  rl.close();
  switch (choice) {
    case '1': return cmdStart({ confirmed: true });
    case '2': return cmdShortcut();
    default: return 0;
  }
}

const HELP = `用法：GitHub-Copilot-Hans.cmd [命令] [选项]
命令：
  start      启动汉化（必要时重启 GitHub Copilot）
  attach     仅连接已开启调试端口的应用
  status     查看状态
  stop       停止后台监视器
  dump       导出界面上未翻译的文本到 build/missing.txt
  shortcut   在桌面创建「GitHub Copilot 中文版」快捷方式
  build      生成独立的注入脚本 build/copilot-hans-overlay.js
选项：
  --port N   调试端口（默认 ${DEFAULT_PORT}）
  --yes      不询问直接重启应用
  --quiet    不输出信息`;

const commands = {
  start: () => cmdStart(),
  attach: () => cmdStart({ attachOnly: true }),
  status: cmdStatus,
  stop: cmdStop,
  dump: cmdDump,
  shortcut: cmdShortcut,
  build: cmdBuild,
  monitor: () => runMonitor({ port }),
  help: () => { console.log(HELP); return 0; },
};

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('需要 Node.js 22 或更高版本（当前 ' + process.version + '）。');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
const name = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const run = name ? commands[name] : menu;
if (!run) {
  console.log(HELP);
  process.exit(1);
}
process.exitCode = (await run()) ?? 0;
