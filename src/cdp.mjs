// 极简 Chrome DevTools Protocol 客户端（使用 Node 22+ 自带的 WebSocket）。
export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  return res.json();
}

export class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('连接已关闭'));
      }
      this.pending.clear();
      this.onclose?.();
    });
  }

  static connect(url, timeoutMs = 5000) {
    // 只允许连接本机调试端口
    const u = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
      return Promise.reject(new Error(`拒绝连接非本机地址：${u.hostname}`));
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { ws.close(); reject(new Error('连接超时')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpSession(ws)); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败')); }, { once: true });
    });
  }

  send(method, params = {}, timeoutMs = 10000) {
    if (this.closed) return Promise.reject(new Error('连接已关闭'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

// 只处理 GitHub Copilot 应用自己的页面（tauri.localhost），外部网页不注入。
export function isAppPage(target) {
  if (target.type !== 'page' && target.type !== 'iframe') return false;
  try {
    const u = new URL(target.url);
    return (u.protocol === 'tauri:' && u.hostname === 'localhost') ||
      (/^https?:$/.test(u.protocol) && u.hostname === 'tauri.localhost');
  } catch {
    return false;
  }
}
