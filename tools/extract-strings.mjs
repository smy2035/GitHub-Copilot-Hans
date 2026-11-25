// 从解包出的前端代码中提取界面文案，生成待翻译清单。
// 用法：node tools/extract-strings.mjs [资源目录]
// 输出：build/candidates.json（全部候选）和 build/untranslated.json（词典里还没有的）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDictionary } from '../src/dictionary.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetDir = path.resolve(process.argv[2] || path.join(root, 'build', 'assets'));

// 第三方库、图表、语法高亮、扩展市场介绍、React 开发者工具等文件不含应用自身的界面文案
const SKIP_FILE = /^assets_(vendor-|Univer|.*mermaid|.*elk|.*worker|rolldown-runtime|dist-|extensionsFeatured)/i;
// 会显示在界面上的属性名
const UI_PROP = /^(children|label|description|title|"aria-label"|ariaLabel|placeholder|message|text|tooltip|header|heading|subtitle|hint|note|emptyText|actionLabel|srText|dialogTitle|searchPlaceholder|inputPlaceholder|statusLabel|failureDescription|confirmLabel|cancelLabel|buttonLabel|submitLabel|caption|summary|helperText|emptyMessage|emptyTitle|emptyDescription|errorMessage|successMessage|loadingLabel|tooltipLabel|ariaDescription|detail|details|body|imperative|gerund|past|section|labelContext|displayName|category|reason|error|title[A-Z]\w*|\w+(Label|Title|Description|Placeholder|Text|Message|Tooltip|Hint))$/;

const PROP_STRING = /([A-Za-z_$][\w$]*|"[\w-]+"):`((?:[^`\\]|\\.)*)`/g;
const CHILD_ARRAY = /children:\[((?:`(?:[^`\\]|\\.)*`|[^\[\]`])*)\]/g;

function normalize(raw) {
  // 把 ${表达式} 变成 {0} {1} 占位符；表达式里嵌套模板串的情况直接放弃
  let index = 0;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '$' && raw[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < raw.length && depth) {
        if (raw[j] === '{') depth++;
        else if (raw[j] === '}') depth--;
        j++;
      }
      if (depth) return null;
      out += `{${index++}}`;
      i = j - 1;
    } else if (raw[i] === '\\') {
      const next = raw[i + 1];
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      i++;
    } else {
      out += raw[i];
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

function looksLikeUiText(text) {
  if (!text || text.length < 2 || text.length > 300) return false;
  if (!/[A-Za-z]{2}/.test(text)) return false;
  if (/^\{\d+\}$/.test(text.replace(/[^\w{}]/g, ''))) return false;
  if (/^(https?:|mailto:|data:|\/|\.\/|#|--|@)/.test(text)) return false;
  if (/=>|function\(|\bvar\b|;\s*\w+\(|<\/?[a-z]+[ >]/.test(text)) return false;
  // Tailwind 类名、标识符、路径
  if (!/\s/.test(text) && /[-_:./\[\]]/.test(text) && !/^[A-Z][a-z]+[.!?]?$/.test(text)) return false;
  if (/^[a-z0-9-]+(\s+[a-z0-9-:\[\]./!&_()%#]+)+$/.test(text) && /[-:\[]/.test(text)) return false;
  if (/^[a-z][a-zA-Z0-9]*$/.test(text)) return false; // camelCase 标识符
  if (/^[A-Z0-9_]+$/.test(text) && text.includes('_')) return false; // 常量
  if (!/^[A-Z{"'(“0-9…⌘⇧]/.test(text) && !/\s/.test(text)) return false;
  return true;
}

const found = new Map();
function add(text, file) {
  if (!looksLikeUiText(text)) return;
  const item = found.get(text) || { text, count: 0, files: new Set() };
  item.count++;
  item.files.add(file.replace(/^assets_/, '').replace(/-[\w]{8}\.js$/, ''));
  found.set(text, item);
}

const files = fs.readdirSync(assetDir).filter((f) => f.endsWith('.js') && !SKIP_FILE.test(f));
for (const file of files) {
  const src = fs.readFileSync(path.join(assetDir, file), 'utf8');
  for (const m of src.matchAll(PROP_STRING)) {
    if (!UI_PROP.test(m[1])) continue;
    const text = normalize(m[2]);
    if (text) add(text, file);
  }
  // children:[`前半句 `, 变量, ` 后半句`] 这类被拆开的文案
  for (const m of src.matchAll(CHILD_ARRAY)) {
    for (const part of m[1].matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
      const text = normalize(part[1]);
      if (text) add(text, file);
    }
  }
  // 写在条件表达式、变量里的文案（如 a?`Show in menu bar`:`Show in system tray`）：
  // 不看属性名，只收「大写开头、至少两个单词」的自然语言句子
  // 用前瞻从每个反引号处都尝试一次，避免某处多出一个反引号导致后面整体错位、漏掉真正的文案
  for (const m of src.matchAll(/(?=`((?:[^`\\]|\\.){4,300})`)/g)) {
    const text = normalize(m[1]);
    if (text && looksLikeSentence(text)) add(text, file);
  }
}

function looksLikeSentence(text) {
  if (!/^[A-Z]/.test(text)) return false;
  const words = text.split(' ');
  if (words.length < 2) return false;
  // 自然语言里大部分单词是纯字母
  const plain = words.filter((w) => /^[A-Za-z][a-z'’]*[.,:;!?…]?$/.test(w)).length;
  if (plain / words.length < 0.7) return false;
  return !/[{}<>=]|\bfunction\b|\breturn\b|\bconst\b/.test(text.replace(/\{\d+\}/g, ''));
}

const candidates = [...found.values()]
  .map((x) => ({ text: x.text, count: x.count, files: [...x.files].slice(0, 3) }))
  .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));

const dict = loadDictionary(root);
const untranslated = candidates.filter((c) => !dict.has(c.text));

fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'candidates.json'), JSON.stringify(candidates, null, 1));
fs.writeFileSync(path.join(root, 'build', 'untranslated.json'), JSON.stringify(untranslated, null, 1));
console.log(`候选文案 ${candidates.length} 条，词典未覆盖 ${untranslated.length} 条`);
console.log(`已写入 build/candidates.json 与 build/untranslated.json`);
