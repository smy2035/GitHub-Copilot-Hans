// 词典加载：合并 dict/*.json，再叠加用户的 custom-translations.txt（优先级最高）。
import fs from 'node:fs';
import path from 'node:path';

export function loadDictionary(root) {
  const dict = new Map();
  const dir = path.join(root, 'dict');
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (const [en, zh] of Object.entries(data)) {
        if (typeof zh === 'string' && zh.trim()) dict.set(en, zh);
      }
    }
  }
  return dict;
}

// 每行一条：「英文 = 中文」自定义译法；只写英文表示保留原文不翻译；# 开头为注释。
export function loadCustomTranslations(root) {
  const file = path.join(root, 'custom-translations.txt');
  const items = [];
  if (!fs.existsSync(file)) return items;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 0) items.push([line, '']);
    else items.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return items.filter(([en]) => en);
}
