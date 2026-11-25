// 后台监视器：持续连接调试端口，给每个应用页面注入汉化脚本。
// - Page.addScriptToEvaluateOnNewDocument 让页面刷新后自动生效（需要保持连接，所以要常驻）
// - 新窗口 / 画布出现时自动注入
// - 词典文件变化时热更新，无需重启应用
// - 应用退出后自动结束
import fs from 'node:fs';
import path from 'node:path';
import { listTargets, CdpSession, isAppPage } from './cdp.mjs';
import { buildOverlay, ROOT } from './build-overlay.mjs';
import { DATA_DIR } from './app.mjs';

export const PID_FILE = path.join(DATA_DIR, 'monitor.json');
export const LOG_FILE = path.join(DATA_DIR, 'monitor.log');

export function readMonitorInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    process.kill(info.pid, 0); // 进程不存在会抛错
    return info;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runMonitor({ port }) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
  const log = (msg) => logStream.write(`[${new Date().toLocaleString()}] ${msg}\n`);

  const existing = readMonitorInfo();
  if (existing && existing.pid !== process.pid) {
    log(`已有监视器在运行 (PID ${existing.pid})，本进程退出`);
    return;
  }
  const state = { pid: process.pid, port, startedAt: Date.now(), injected: 0, version: null, entries: 0 };
  const saveState = () => fs.writeFileSync(PID_FILE, JSON.stringify(state));

  let overlay = buildOverlay();
  state.version = overlay.version;
  state.entries = overlay.entries;
  saveState();
  log(`启动，端口 ${port}，词条 ${overlay.entries}，自定义 ${overlay.custom}，版本 ${overlay.version}`);

  const sessions = new Map(); // targetId -> { session, scriptId }

  async function inject(target) {
    const session = await CdpSession.connect(target.webSocketDebuggerUrl);
    const entry = { session, scriptId: null };
    sessions.set(target.id, entry);
    session.onclose = () => {
      sessions.delete(target.id);
      state.injected = sessions.size;
      saveState();
    };
    await session.send('Page.enable');
    const added = await session.send('Page.addScriptToEvaluateOnNewDocument', { source: overlay.source });
    entry.scriptId = added.identifier;
    const result = await session.evaluate(overlay.source);
    state.injected = sessions.size;
    saveState();
    log(`已注入：${target.title || target.url} (${result})`);
  }

  async function reloadOverlay() {
    let next;
    try {
      next = buildOverlay();
    } catch (e) {
      log(`词典加载失败，保留旧版本：${e.message}`);
      return;
    }
    if (next.version === overlay.version) return;
    overlay = next;
    state.version = overlay.version;
    state.entries = overlay.entries;
    saveState();
    log(`词典已更新：${overlay.entries} 条，版本 ${overlay.version}`);
    for (const entry of sessions.values()) {
      try {
        if (entry.scriptId) await entry.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.scriptId });
        entry.scriptId = (await entry.session.send('Page.addScriptToEvaluateOnNewDocument', { source: overlay.source })).identifier;
        await entry.session.evaluate(overlay.source);
      } catch (e) {
        log(`热更新失败：${e.message}`);
      }
    }
  }

  let reloadTimer = null;
  const scheduleReload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reloadOverlay, 600);
  };
  const watchers = [];
  for (const target of [path.join(ROOT, 'dict'), path.join(ROOT, 'src', 'overlay.js'), ROOT]) {
    try {
      watchers.push(fs.watch(target, (_ev, name) => {
        if (target !== ROOT || name === 'custom-translations.txt') scheduleReload();
      }));
    } catch { /* ignore */ }
  }

  const retryAfter = new Map();
  let everConnected = false;
  let misses = 0;
  const startedAt = Date.now();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    // 被 stop 命令替换/删除 pid 文件时退出
    try {
      if (JSON.parse(fs.readFileSync(PID_FILE, 'utf8')).pid !== process.pid) break;
    } catch {
      break;
    }
    let targets = null;
    try {
      targets = await listTargets(port);
      misses = 0;
    } catch {
      misses++;
    }
    if (targets) {
      for (const t of targets) {
        if (!isAppPage(t) || sessions.has(t.id) || !t.webSocketDebuggerUrl) continue;
        if ((retryAfter.get(t.id) || 0) > Date.now()) continue;
        everConnected = true;
        await inject(t).catch((e) => {
          const entry = sessions.get(t.id);
          sessions.delete(t.id);
          entry?.session.close();
          retryAfter.set(t.id, Date.now() + 10000);
          log(`注入失败（10 秒后重试）：${t.url} - ${e.message}`);
        });
      }
    } else if ((everConnected && misses >= 10) || (!everConnected && Date.now() - startedAt > 120000)) {
      log('应用已退出（调试端口不可用），监视器结束');
      break;
    }
    await sleep(1000);
  }

  for (const w of watchers) w.close();
  for (const { session } of sessions.values()) session.close();
  try {
    if (JSON.parse(fs.readFileSync(PID_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(PID_FILE);
  } catch { /* ignore */ }
  log('监视器已停止');
  logStream.end();
}
