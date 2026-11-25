// 把译者产出的「序号 -> 译文」合并成词典分片，并做质量校验。
// 输入：build/batches/batch-NN.json（英文数组）+ build/translations/batch-NN*.json（{"序号": "译文"}）
// 输出：dict/zh-CN.part-NN.json
// 用法：node tools/merge-batch.mjs 01 [02 ...]   （不带参数则合并全部）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const batchDir = path.join(root, 'build', 'batches');
const transDir = path.join(root, 'build', 'translations');

const ids = process.argv.slice(2).length
  ? process.argv.slice(2).map((x) => x.padStart(2, '0'))
  : fs.readdirSync(batchDir).map((f) => f.match(/^batch-(\d+)\.json$/)?.[1]).filter(Boolean);

const placeholders = (s) => (s.match(/\{\d+\}/g) || []).sort().join(',');
let failed = false;

for (const id of ids) {
  const source = JSON.parse(fs.readFileSync(path.join(batchDir, `batch-${id}.json`), 'utf8'));
  const translated = {};
  const files = fs.existsSync(transDir)
    ? fs.readdirSync(transDir).filter((f) => f.startsWith(`batch-${id}`) && f.endsWith('.json'))
    : [];
  for (const f of files) {
    try {
      Object.assign(translated, JSON.parse(fs.readFileSync(path.join(transDir, f), 'utf8')));
    } catch (e) {
      console.log(`[${id}] ${f} 不是有效 JSON：${e.message}`);
      failed = true;
    }
  }
  const dict = {};
  const problems = [];
  for (const [key, zh] of Object.entries(translated)) {
    const en = source[Number(key)];
    if (en === undefined) { problems.push(`序号 ${key} 超出范围`); continue; }
    if (typeof zh !== 'string' || !zh.trim()) continue;
    if (placeholders(en) !== placeholders(zh)) {
      problems.push(`序号 ${key} 占位符不一致：${JSON.stringify(en)} -> ${JSON.stringify(zh)}`);
      continue;
    }
    if (zh !== en) dict[en] = zh;
  }
  fs.writeFileSync(path.join(root, 'dict', `zh-CN.part-${id}.json`), JSON.stringify(dict, null, 1) + '\n');
  const covered = Object.keys(translated).length;
  console.log(`[${id}] 原文 ${source.length} 条，已处理 ${covered} 条，写入词典 ${Object.keys(dict).length} 条`);
  for (const p of problems) console.log(`  ! ${p}`);
  if (problems.length) failed = true;
}
process.exitCode = failed ? 1 : 0;
