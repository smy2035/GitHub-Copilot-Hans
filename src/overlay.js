// 注入到 GitHub Copilot 页面中运行的汉化引擎。
// 下方的数据占位符会在注入前被替换为 { version, dict: [[英文, 中文], ...], custom: [[英文, 中文], ...] }。
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 'no-window';
  // 只汉化应用自己的页面；浏览器画布里打开的外部网站、扩展页面一律不碰。
  const ALLOWED_ORIGINS = ['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'];
  if (!ALLOWED_ORIGINS.includes(location.origin)) return 'skip-origin';

  const DATA = /*@@HANS_DATA@@*/ null;
  const prev = window.__copilotHans;
  if (prev && prev.version === DATA.version && prev.doc === document) return 'already';
  if (prev && typeof prev.cleanup === 'function') prev.cleanup();

  const LANG_KEY = 'copilotHans.lang';
  const POS_KEY = 'copilotHans.togglePos';
  const ATTRS = ['title', 'placeholder', 'aria-label', 'data-placeholder'];
  // 输入框、编辑器：内容不碰，但提示语等属性可以翻译
  const FORM_SELECTOR = 'textarea, input, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
  // 聊天正文、用户输入、代码、编辑器、终端：这些区域是内容而不是界面，绝不翻译。
  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'textarea', 'input', 'select', 'pre', 'code', 'kbd', 'samp',
    '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
    '.prose', '[data-markdown-root]', '[data-markdown-document-root]',
    '[data-user-message-content]', '[data-user-message-bubble]',
    '.cm-editor', '.monaco-editor', '.xterm', '[translate="no"]', '.notranslate',
    '#copilot-hans-toggle',
  ].join(',');

  // ---------- 词典 ----------
  const exact = new Map();
  const lower = new Map();
  const prefixBuckets = new Map();
  const suffixBuckets = new Map();
  const KEEP = Symbol('keep-english');

  function addPattern(en, zh) {
    const parts = en.split(/\{(\d+)\}/);
    const literal = parts.filter((_, i) => i % 2 === 0).join('');
    if ((literal.match(/[A-Za-z]/g) || []).length < 2) return; // 「{0} {1}」这种纯变量模板太危险
    let source = '^';
    const order = [];
    parts.forEach((part, i) => {
      if (i % 2 === 0) source += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      else { source += '(.+?)'; order.push(part); }
    });
    const entry = { re: new RegExp(source + '$'), order, zh };
    const head = parts[0];
    const tail = parts[parts.length - 1];
    if (head) {
      const k = head[0].toLowerCase();
      if (!prefixBuckets.has(k)) prefixBuckets.set(k, []);
      prefixBuckets.get(k).push(entry);
    } else if (tail) {
      const k = tail[tail.length - 1].toLowerCase();
      if (!suffixBuckets.has(k)) suffixBuckets.set(k, []);
      suffixBuckets.get(k).push(entry);
    }
  }

  for (const [en, zh] of DATA.dict) {
    if (/\{\d+\}/.test(en)) addPattern(en, zh);
    else {
      exact.set(en, zh);
      const l = en.toLowerCase();
      if (!lower.has(l)) lower.set(l, zh);
    }
  }
  for (const [en, zh] of DATA.custom) {
    const value = zh ? zh : KEEP;
    exact.set(en, value);
    lower.set(en.toLowerCase(), value);
  }

  function lookupExact(text) {
    if (exact.has(text)) return exact.get(text);
    const l = text.toLowerCase();
    if (lower.has(l)) return lower.get(l);
    return undefined;
  }

  function matchPattern(text) {
    const lists = [prefixBuckets.get(text[0].toLowerCase()), suffixBuckets.get(text[text.length - 1].toLowerCase())];
    for (const list of lists) {
      if (!list) continue;
      for (const p of list) {
        const m = p.re.exec(text);
        if (!m) continue;
        const values = {};
        let rejected = false;
        let translatedValue = false;
        p.order.forEach((name, i) => {
          const v = m[i + 1];
          const t = lookupExact(v);
          if (typeof t === 'string') {
            values[name] = t;
            translatedValue = true;
          } else {
            // 变量是一段没有译文的英文短语/句子时（如「Use {0}」套进一整句英文），宁可整句保留英文，也不要中英混杂
            const words = v.trim().split(/\s+/).filter((w) => /[A-Za-z]{2}/.test(w)).length;
            if (/^[a-z]+(?: [a-z]+)+$/.test(v) || words >= 4 || (words >= 2 && /[.!?]$/.test(v))) rejected = true;
            values[name] = v;
          }
        });
        if (rejected) continue;
        let out = p.zh.replace(/\{(\d+)\}/g, (_, n) => (n in values ? values[n] : `{${n}}`));
        // 变量被翻成中文后，去掉模板里为英文变量预留的空格：「在 系统托盘 中显示」->「在系统托盘中显示」
        if (translatedValue) out = out.replace(/([\u4e00-\u9fff，。：；！？、）】」])\s+(?=[\u4e00-\u9fff（【「])/g, '$1');
        return out;
      }
    }
    return undefined;
  }

  // 返回译文；KEEP 表示用户要求保留英文；undefined 表示词典没有。
  function translate(text) {
    let r = lookupExact(text);
    if (r !== undefined) return r;
    // 「Name:」「Loading...」这类只差结尾标点的变体
    const tail = text.match(/^(.*?)(\s*)(:|\.\.\.|…)$/s);
    if (tail && tail[1]) {
      const base = lookupExact(tail[1]);
      if (typeof base === 'string') return base + (tail[3] === ':' ? '：' : '…');
    }
    if (text.length <= 300) {
      r = matchPattern(text);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  // ---------- 记录原文，便于中英切换 ----------
  const textOrig = new WeakMap(); // Text -> { orig, zh }
  const attrOrig = new WeakMap(); // Element -> Map(name -> { orig, zh })
  const touchedTexts = new Set();
  const touchedAttrs = new Set();
  const missing = new Set();

  function shouldCollect(text) {
    return missing.size < 20000 && text.length <= 200 && /[A-Za-z]{2}/.test(text) && !/^[\w.\-/\\@:]+$/.test(text);
  }

  function writeText(node, value) {
    const rec = textOrig.get(node);
    if (rec && rec.zh === node.nodeValue) rec.zh = value;
    else textOrig.set(node, { orig: node.nodeValue, zh: value });
    touchedTexts.add(new WeakRef(node));
    node.nodeValue = value;
  }

  function translateTextNode(node) {
    const value = node.nodeValue;
    if (!value || !/[A-Za-z]/.test(value)) return;
    // 一句话被拆成多个相邻文本节点时，只允许整句翻译（见 translateSplitText），不单独翻其中某一段
    if (isTextFragment(node)) return;
    // 句子中间夹着链接等元素时，不单独翻译其中的片段（避免「Enable … 或 升级计划 to continue …」）
    if (isMidSentence(node)) return;
    const rec = textOrig.get(node);
    if (rec && rec.zh === value) return; // 已经是我们写入的译文
    const trimmed = value.trim();
    const zh = translate(trimmed);
    if (typeof zh === 'string') {
      const start = value.indexOf(trimmed);
      writeText(node, value.slice(0, start) + zh + value.slice(start + trimmed.length));
    } else if (zh === undefined && shouldCollect(trimmed)) {
      missing.add(trimmed);
    }
  }

  function isTextFragment(node) {
    const siblings = node.parentNode?.childNodes;
    if (!siblings || siblings.length < 2) return false;
    for (const n of siblings) if (n.nodeType !== Node.TEXT_NODE) return false;
    return true;
  }

  // 看起来像英文句子中间部分的片段：小写开头（如「 or 」「 to continue …」），或含连续多个小写单词
  function looksLikeEnglishFragment(text) {
    const t = text.trim();
    return /^[a-z]/.test(t) || /[a-z]{2,} [a-z]{2,} [a-z]{2,}/.test(t);
  }

  const INLINE_TAGS = new Set(['A', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'U', 'CODE', 'KBD']);

  function hasEnglishSentenceSibling(el, except) {
    for (const n of el.childNodes) {
      if (n === except || n.nodeType !== Node.TEXT_NODE) continue;
      const rec = textOrig.get(n);
      const current = n.nodeValue || '';
      if (rec && rec.zh === current) continue; // 已经翻成中文
      if (/[A-Za-z]{2}/.test(current) && looksLikeEnglishFragment(current)) return true;
    }
    return false;
  }

  function isMidSentence(node) {
    const parent = node.parentElement;
    if (!parent) return false;
    const hasElementSibling = [...parent.childNodes].some((n) => n.nodeType === Node.ELEMENT_NODE);
    // 1) 与链接等元素混排的文本片段本身是句子中间部分
    if (hasElementSibling && /^[a-z]/.test(node.nodeValue.trim())) return true;
    // 2) 链接等行内元素里的文字，而它所在的句子其余部分仍是英文
    if (INLINE_TAGS.has(parent.tagName) && parent.parentElement && parent.childNodes.length === 1) {
      return hasEnglishSentenceSibling(parent.parentElement, parent);
    }
    return false;
  }

  // React 会把 `Delete ${n} sessions` 渲染成多个相邻文本节点，这里合并后整体匹配。
  function translateSplitText(el) {
    const nodes = el.childNodes;
    if (nodes.length < 2 || nodes.length > 8) return false;
    for (const n of nodes) if (n.nodeType !== Node.TEXT_NODE) return false;
    const texts = [...nodes];
    const restored = texts.map((n) => {
      const rec = textOrig.get(n);
      return rec && rec.zh === n.nodeValue ? rec.orig : n.nodeValue;
    });
    const joined = restored.join('');
    const trimmed = joined.trim();
    if (!/[A-Za-z]{2}/.test(trimmed)) return false;
    const zh = translate(trimmed);
    if (typeof zh !== 'string') {
      if (zh === undefined && shouldCollect(trimmed)) missing.add(trimmed);
      return false;
    }
    const start = joined.indexOf(trimmed);
    const full = joined.slice(0, start) + zh + joined.slice(start + trimmed.length);
    texts.forEach((n, i) => {
      if (n.nodeValue !== restored[i]) n.nodeValue = restored[i];
      writeText(n, i === 0 ? full : '');
    });
    return true;
  }

  function translateAttrs(el) {
    for (const name of ATTRS) {
      const value = el.getAttribute(name);
      if (!value || !/[A-Za-z]/.test(value)) continue;
      let map = attrOrig.get(el);
      const rec = map && map.get(name);
      if (rec && rec.zh === value) continue;
      const zh = translate(value.trim());
      if (typeof zh !== 'string') continue;
      if (!map) attrOrig.set(el, (map = new Map()));
      map.set(name, { orig: value, zh });
      touchedAttrs.add(new WeakRef(el));
      el.setAttribute(name, zh);
    }
  }

  function isSkipped(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !el || !!el.closest(SKIP_SELECTOR);
  }

  // 输入框本身（不在聊天正文等跳过区域里）的属性可以翻译
  function isAttrOnlyTarget(el) {
    return el.matches(FORM_SELECTOR) && !(el.parentElement && el.parentElement.closest(SKIP_SELECTOR));
  }

  const walkerFilter = {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (!node.matches(SKIP_SELECTOR)) return NodeFilter.FILTER_ACCEPT;
        if (node.matches(FORM_SELECTOR)) translateAttrs(node);
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  };

  function translateTree(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      if (isSkipped(root)) return;
      const parent = root.parentElement;
      if (!(parent && translateSplitText(parent))) translateTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE && isSkipped(root)) {
      if (isAttrOnlyTarget(root)) translateAttrs(root);
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, walkerFilter);
    let node = root.nodeType === Node.ELEMENT_NODE ? root : walker.nextNode();
    const handled = new WeakSet();
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        translateAttrs(node);
        if (translateSplitText(node)) for (const c of node.childNodes) handled.add(c);
      } else if (!handled.has(node)) {
        translateTextNode(node);
      }
      node = walker.nextNode();
    }
  }

  function restoreAll() {
    for (const ref of touchedTexts) {
      const node = ref.deref();
      const rec = node && textOrig.get(node);
      if (rec && node.nodeValue === rec.zh) node.nodeValue = rec.orig;
      if (node) textOrig.delete(node);
    }
    for (const ref of touchedAttrs) {
      const el = ref.deref();
      const map = el && attrOrig.get(el);
      if (map) for (const [name, rec] of map) if (el.getAttribute(name) === rec.zh) el.setAttribute(name, rec.orig);
      if (el) attrOrig.delete(el);
    }
    touchedTexts.clear();
    touchedAttrs.clear();
  }

  // ---------- 监听界面变化 ----------
  let lang = 'zh';
  try { lang = localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'zh'; } catch { /* ignore */ }
  let originalLang = null;

  const observer = new MutationObserver((records) => {
    if (lang !== 'zh') return;
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) translateTree(n);
        // 拆分文本的某一段被删除/新增时，需要整体重新匹配
        if (r.target.nodeType === Node.ELEMENT_NODE && !isSkipped(r.target)) translateSplitText(r.target);
      } else if (r.type === 'characterData') {
        const node = r.target;
        const rec = textOrig.get(node);
        if (rec && rec.zh === node.nodeValue) continue;
        translateTree(node);
      } else if (r.type === 'attributes') {
        const el = r.target;
        const map = attrOrig.get(el);
        const rec = map && map.get(r.attributeName);
        if (rec && rec.zh === el.getAttribute(r.attributeName)) continue;
        if (!isSkipped(el) || isAttrOnlyTarget(el)) translateAttrs(el);
      }
    }
  });

  function applyChinese() {
    if (originalLang === null) originalLang = document.documentElement.lang || '';
    document.documentElement.lang = 'zh-CN';
    translateTree(document.body || document.documentElement);
  }

  function setLang(next) {
    lang = next === 'en' ? 'en' : 'zh';
    try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
    if (lang === 'zh') applyChinese();
    else {
      restoreAll();
      if (originalLang !== null) document.documentElement.lang = originalLang;
    }
    updateToggle();
  }

  // ---------- 右下角中英切换按钮（可拖动） ----------
  let toggle = null;
  function updateToggle() {
    if (!toggle) return;
    toggle.textContent = lang === 'zh' ? '中' : 'En';
    toggle.title = lang === 'zh' ? '汉化已开启：单击切换为英文，可拖动' : 'Chinese overlay off: click to switch to Chinese';
  }

  function mountToggle() {
    if (window.top !== window || !document.body || document.getElementById('copilot-hans-toggle')) return;
    toggle = document.createElement('button');
    toggle.id = 'copilot-hans-toggle';
    toggle.type = 'button';
    Object.assign(toggle.style, {
      position: 'fixed', right: '14px', bottom: '64px', zIndex: '2147483647', width: '26px', height: '26px',
      borderRadius: '13px', border: '1px solid rgba(127,127,127,.45)', background: 'rgba(127,127,127,.18)',
      color: 'inherit', font: '12px/1 system-ui, sans-serif', cursor: 'pointer', opacity: '.45', padding: '0',
      backdropFilter: 'blur(4px)', userSelect: 'none', transition: 'opacity .15s',
    });
    try {
      const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (pos) Object.assign(toggle.style, { right: pos.right + 'px', bottom: pos.bottom + 'px' });
    } catch { /* ignore */ }
    toggle.addEventListener('mouseenter', () => { toggle.style.opacity = '1'; });
    toggle.addEventListener('mouseleave', () => { toggle.style.opacity = '.45'; });
    let drag = null;
    toggle.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, right: parseFloat(toggle.style.right), bottom: parseFloat(toggle.style.bottom), moved: false };
      toggle.setPointerCapture(e.pointerId);
    });
    toggle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (!drag.moved) return;
      const right = Math.min(Math.max(drag.right - dx, 0), innerWidth - 30);
      const bottom = Math.min(Math.max(drag.bottom - dy, 0), innerHeight - 30);
      Object.assign(toggle.style, { right: right + 'px', bottom: bottom + 'px' });
    });
    toggle.addEventListener('pointerup', () => {
      if (!drag) return;
      if (drag.moved) {
        try { localStorage.setItem(POS_KEY, JSON.stringify({ right: parseFloat(toggle.style.right), bottom: parseFloat(toggle.style.bottom) })); } catch { /* ignore */ }
      } else {
        setLang(lang === 'zh' ? 'en' : 'zh');
      }
      drag = null;
    });
    updateToggle();
    document.body.appendChild(toggle);
  }

  function start() {
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS,
    });
    if (lang === 'zh') applyChinese();
    mountToggle();
  }

  window.__copilotHans = {
    version: DATA.version,
    doc: document,
    missing,
    setLang,
    getLang: () => lang,
    stats: () => ({ exact: exact.size, patterns: [...prefixBuckets.values(), ...suffixBuckets.values()].reduce((a, b) => a + b.length, 0), missing: missing.size }),
    cleanup() {
      observer.disconnect();
      restoreAll();
      toggle?.remove();
      if (originalLang !== null) document.documentElement.lang = originalLang;
      document.removeEventListener('DOMContentLoaded', start);
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  return 'installed';
})();
