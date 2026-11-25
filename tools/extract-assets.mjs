// 从 GitHub Copilot 桌面版 (github.exe) 中解包内嵌的前端资源。
// 原理：Tauri 把前端文件以 "路径字符串 + Brotli 压缩数据" 的形式编进 exe，
// 找到路径后从紧随其后的位置尝试解压即可。
// 用法：node tools/extract-assets.mjs [github.exe 路径] [输出目录]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { findAppExe } from '../src/app.mjs';

const exe = process.argv[2] || findAppExe();
const outDir = path.resolve(process.argv[3] || 'build/assets');
if (!exe || !fs.existsSync(exe)) {
  console.error('找不到 github.exe，请把路径作为第一个参数传入');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const buf = fs.readFileSync(exe);
const WINDOW = 200e6;
const seen = new Set();
const failed = new Set();
const keyPattern = /\/(?:assets\/[\w.\-]+\.(?:js|css|html)|index\.html)/g;

for (let base = 0; base < buf.length; base += WINDOW - 1000) {
  const text = buf.toString('latin1', base, Math.min(buf.length, base + WINDOW));
  for (const m of text.matchAll(keyPattern)) {
    const key = m[0];
    if (seen.has(key)) continue;
    const end = base + m.index + key.length;
    let ok = false;
    for (let start = end - 2; start < end + 8 && !ok; start++) {
      try {
        const out = zlib.brotliDecompressSync(buf.subarray(start, start + 30e6), {
          finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
        });
        if (out.length > 50 && /^[\x09\x0a\x0d\x20-\x7e]{30}/.test(out.toString('latin1', 0, 40))) {
          fs.writeFileSync(path.join(outDir, key.slice(1).replace(/\//g, '_')), out);
          seen.add(key);
          failed.delete(key);
          ok = true;
        }
      } catch { /* 不是压缩流起点，继续尝试 */ }
    }
    if (!ok) failed.add(key);
  }
}

console.log(`解包完成：${seen.size} 个文件 -> ${outDir}`);
if (failed.size) console.log(`未能解包 ${failed.size} 个（多为语言/语法高亮包，可忽略）`);
