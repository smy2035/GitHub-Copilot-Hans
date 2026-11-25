// 端到端自测：用无头 Edge 模拟 GitHub Copilot 页面，走真实的 attach -> 监视器 -> 注入流程。
// 用法：node tools/selftest.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listTargets, CdpSession, isAppPage } from '../src/cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'src', 'cli.mjs');
const PORT = 9444;
const HTTP_PORT = 8765;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
  .find((p) => fs.existsSync(p));
if (!edge) { console.error('需要 Microsoft Edge'); process.exit(1); }

const page = `<!doctype html><html lang="en"><body>
<button id="cancel">Cancel</button>
<span id="newSession">New session</span>
<span id="split">Remove <!---->my-repo</span>
<button id="attr" title="Settings" aria-label="Settings">x</button>
<label id="colon">Name:</label>
<div class="prose"><p id="prose">Cancel</p></div>
<div data-user-message-content><p id="user">Retry</p></div>
<code id="code">Cancel</code>
<div id="dynamic"></div>
<div id="composer" contenteditable="true" data-placeholder="Steer this session…">Cancel</div>
<p id="longVar"></p>
<p id="mixed"><a href="#">Enable additional usage</a> or <a href="#" id="mixedLink">Upgrade plan</a> to continue after plan credits run out.</p>
<p id="okMixed">Settings <a href="#" id="okLink">Cancel</a></p>
<div class="prose"><input id="proseInput" placeholder="Cancel"></div>
<p id="frag"></p><p id="trayShow"></p><p id="oddShow"></p>
<script>
  const split = (id, parts) => { const el = document.getElementById(id); el.append(...parts); };
  split('frag', ['Show the GitHub Copilot icon in the ', 'secret drawer', '.']);
  split('trayShow', ['Show in ', 'system tray']);
  split('oddShow', ['Show in ', 'some odd place']);
  document.getElementById('longVar').textContent = 'Use one windowed Live editor with preview-first loading.';
  // 模拟 React：把 "Remove " 与变量渲染成两个相邻文本节点
  const s = document.getElementById('split'); s.textContent = ''; s.append('Remove ', 'my-repo');
  setTimeout(() => { document.getElementById('dynamic').innerHTML = '<button id="later">Retry</button>'; }, 2500);
  setTimeout(() => { document.getElementById('newSession').firstChild.nodeValue = 'Try again'; }, 3000);
</script></body></html>`;

const server = http.createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); })
  .listen(HTTP_PORT, '127.0.0.1');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hans-test-'));
// 独立的监视器数据目录，避免影响正在使用的汉化
process.env.COPILOT_HANS_DATA_DIR = path.join(profile, 'hans-data');
const browser = spawn(edge, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--host-resolver-rules=MAP tauri.localhost:80 127.0.0.1:${HTTP_PORT}`, '--no-first-run',
  'http://tauri.localhost/',
], { stdio: 'ignore' });

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}：${JSON.stringify(actual)}${ok ? '' : ` （期望 ${JSON.stringify(expected)}）`}`);
};

try {
  await sleep(2000);
  execFileSync(process.execPath, [cli, 'attach', '--port', String(PORT)], { stdio: 'inherit' });
  await sleep(2500);
  const target = (await listTargets(PORT)).find(isAppPage);
  const s = await CdpSession.connect(target.webSocketDebuggerUrl);
  const q = (expr) => s.evaluate(expr);
  const text = (id) => q(`document.getElementById(${JSON.stringify(id)}).textContent`);
  for (let i = 0; i < 20 && !(await q(`!!document.getElementById('later')`)); i++) await sleep(250);
  for (let i = 0; i < 20 && (await text('newSession')) === '新建会话'; i++) await sleep(250);

  check('按钮', await text('cancel'), '取消');
  check('拆分文本（模板 Remove {0}）', await text('split'), '移除 my-repo');
  check('title 属性', await q(`document.getElementById('attr').title`), '设置');
  check('结尾冒号变体', await text('colon'), '名称：');
  check('聊天正文不翻译', await text('prose'), 'Cancel');
  check('用户消息不翻译', await text('user'), 'Retry');
  check('代码不翻译', await text('code'), 'Cancel');
  check('动态插入的节点', await text('later'), '重试');
  check('应用改写文本后重新翻译', await text('newSession'), '重试');
  check('切换按钮存在', await q(`!!document.getElementById('copilot-hans-toggle')`), true);
  check('半句不单独翻译', await text('frag'), 'Show the GitHub Copilot icon in the secret drawer.');
  check('变量译文去掉多余空格', await text('trayShow'), '在系统托盘中显示');
  check('变量是未知英文短语时保留英文', await text('oddShow'), 'Show in some odd place');
  check('输入框提示语翻译', await q(`document.getElementById('composer').dataset.placeholder`), '引导此会话…');
  check('输入框内容不翻译', await text('composer'), 'Cancel');
  check('聊天正文里的输入框不翻译', await q(`document.getElementById('proseInput').placeholder`), 'Cancel');
  check('短句式不吞整句英文', await text('longVar'), 'Use one windowed Live editor with preview-first loading.');
  check('带链接的英文句子整句保留', await text('mixed'), 'Enable additional usage or Upgrade plan to continue after plan credits run out.');
  check('普通链接照常翻译', await text('okLink'), '取消');

  await q(`window.__copilotHans.setLang('en')`);
  check('切回英文', await text('cancel'), 'Cancel');
  check('切回英文（拆分文本）', await text('split'), 'Remove my-repo');
  check('切回英文（属性）', await q(`document.getElementById('attr').title`), 'Settings');
  await q(`window.__copilotHans.setLang('zh')`);
  check('再切回中文', await text('cancel'), '取消');

  await q('location.reload()');
  await sleep(1500);
  const s2 = await CdpSession.connect(((await listTargets(PORT)).find(isAppPage)).webSocketDebuggerUrl);
  check('刷新后自动生效', await s2.evaluate(`document.getElementById('cancel').textContent`), '取消');

  const customFile = path.join(root, 'custom-translations.txt');
  if (!fs.existsSync(customFile)) {
    fs.writeFileSync(customFile, 'Cancel = 撤销\n');
    await sleep(2500);
    check('自定义译法热更新', await s2.evaluate(`document.getElementById('cancel').textContent`), '撤销');
    fs.unlinkSync(customFile);
    await sleep(2500);
    check('删除自定义后恢复', await s2.evaluate(`document.getElementById('cancel').textContent`), '取消');
  }
  s2.close();
  s.close();
} catch (e) {
  failures++;
  console.error('自测出错：', e);
} finally {
  execFileSync(process.execPath, [cli, 'stop'], { stdio: 'inherit' });
  browser.kill();
  server.close();
  await sleep(1500);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* 浏览器未完全退出时留给系统清理 */ }
}
console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
