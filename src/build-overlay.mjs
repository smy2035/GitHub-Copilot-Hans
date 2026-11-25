// 把词典和自定义翻译打包进注入脚本。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadDictionary, loadCustomTranslations } from './dictionary.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildOverlay(root = ROOT) {
  const runtime = fs.readFileSync(path.join(root, 'src', 'overlay.js'), 'utf8');
  const dict = [...loadDictionary(root)];
  const custom = loadCustomTranslations(root);
  const body = JSON.stringify({ dict, custom });
  const version = crypto.createHash('sha1').update(runtime).update(body).digest('hex').slice(0, 12);
  const data = JSON.stringify({ version, dict, custom });
  // 用函数替换，避免词典里的 $& 等字符被当成替换模式
  const marker = '/*@@HANS_DATA@@*/ null';
  if (!runtime.includes(marker)) throw new Error('overlay.js 缺少数据占位符');
  const source = runtime.replace(marker, () => data);
  return { source, version, entries: dict.length, custom: custom.length };
}
