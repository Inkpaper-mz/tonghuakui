/* ═══════════════════════════════════════════════════════════════
   同花亏 · net.js —— 真实服务端的 WebSocket 客户端
   （MockNet 提供完全相同的对外接口，见 DESIGN.md §4.3 / §4.7）
   ═══════════════════════════════════════════════════════════════ */

import { uid } from './util.js';

const MAX_QUEUE = 60;

export class NetClient extends EventTarget {
  constructor(options = {}) {
    super();
    this.url = null;
    this.ws = null;
    this.connected = false;
    this.queue = [];
    this.pending = new Map();      // reqId -> {resolve, reject, matchType, timer}
    this.backoff = 1000;
    this.maxBackoff = 8000;
    this.closedByUser = false;
    this.nick = options.nick || null;
    this.token = options.token || null;
    this.reconnectTimer = 0;
  }

  /* ───────── 连接 ───────── */
  connect(url) {
    this.url = url || this.url;
    this.closedByUser = false;
    clearTimeout(this.reconnectTimer);
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => this.onOpen();
    this.ws.onmessage = (ev) => this.onMessage(ev);
    this.ws.onclose = (ev) => this.onClose(ev);
    this.ws.onerror = () => {};
  }

  onOpen() {
    this.connected = true;
    this.backoff = 1000;
    this.dispatchEvent(new CustomEvent('open', { detail: {} }));
    this.dispatchEvent(new CustomEvent('state', { detail: { connected: true } }));
    // 断线重连：自动用 token 恢复身份
    if (this.token || this.nick) {
      this.raw({ t: 'login', nick: this.nick, token: this.token });
    }
    const q = this.queue.splice(0, this.queue.length);
    for (const m of q) this.raw(m);
  }

  onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || !msg.t) return;

    if (msg.t === 'pong') { /* 交给订阅者计算延迟 */ }

    // 按 reqId 兑现 request()
    if (msg.reqId && this.pending.has(msg.reqId)) {
      const p = this.pending.get(msg.reqId);
      if (!p.matchType || msg.t === p.matchType) {
        clearTimeout(p.timer);
        this.pending.delete(msg.reqId);
        p.resolve(msg);
      }
    }
    this.dispatchEvent(new CustomEvent(msg.t, { detail: msg }));
    this.dispatchEvent(new CustomEvent('*', { detail: msg }));
  }

  onClose(ev) {
    this.connected = false;
    this.dispatchEvent(new CustomEvent('state', { detail: { connected: false } }));
    this.dispatchEvent(new CustomEvent('close', { detail: { code: ev && ev.code, reason: ev && ev.reason } }));
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('连接已断开')); }
    this.pending.clear();
    if (!this.closedByUser) this.scheduleReconnect();
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const wait = this.backoff;
    this.backoff = Math.min(this.maxBackoff, Math.round(this.backoff * 1.6));
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
    this.dispatchEvent(new CustomEvent('reconnecting', { detail: { wait } }));
  }

  /* ───────── 发送 ───────── */
  send(t, fields = {}) {
    const msg = Object.assign({ t }, fields);
    if (!this.connected || !this.ws || this.ws.readyState !== 1) {
      // 只缓存幂等/必要的消息，行情类不下发
      if (['login', 'lobby:list', 'room:join', 'room:leave'].includes(t) && this.queue.length < MAX_QUEUE) {
        this.queue.push(msg);
      } else if (['order:place', 'order:cancel'].includes(t)) {
        this.dispatchEvent(new CustomEvent('error', { detail: { t: 'error', code: 'OFFLINE', msg: '网络未连接，委托未发送', reqId: fields.reqId } }));
      }
      return false;
    }
    this.raw(msg);
    return true;
  }

  raw(obj) {
    try { this.ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }

  /** 发一条请求并等待应答（按 reqId 匹配；matchType 用于过滤消息类型） */
  request(t, fields = {}, matchType = null, timeoutMs = 5000) {
    const reqId = fields.reqId || uid('c');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('请求超时：' + t));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, matchType, timer });
      this.send(t, Object.assign({}, fields, { reqId }));
    });
  }

  /* ───────── 订阅 ───────── */
  on(type, fn) {
    const wrapped = (ev) => fn(ev.detail);
    this.addEventListener(type, wrapped);
    return () => this.removeEventListener(type, wrapped);
  }

  close() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    try { this.ws && this.ws.close(1000, 'client close'); } catch { /* ignore */ }
  }
}
