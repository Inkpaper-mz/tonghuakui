/* ═══════════════════════════════════════════════════════════
   同花亏 · util.js —— 格式化 / DOM / 通用工具
   ═══════════════════════════════════════════════════════════ */

/* ───────── 数值格式化 ───────── */

/** 价格：12.34（默认 2 位小数，空值显示 '--'） */
export function fmtPrice(v, d = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '--';
  return Number(v).toFixed(d);
}

/** 千分位数字 */
export function fmtNum(v, d = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '--';
  const n = Number(v);
  const s = Math.abs(n).toFixed(d);
  const [i, f] = s.split('.');
  const ii = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + ii + (f ? '.' + f : '');
}

/** 金额：自动 万 / 亿 简称 */
export function fmtMoney(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '--';
  const n = Number(v), a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e8) return s + (a / 1e8).toFixed(2) + '亿';
  if (a >= 1e4) return s + (a / 1e4).toFixed(2) + '万';
  return s + a.toFixed(2);
}

/** 金额：完整千分位（两位小数） */
export function fmtMoneyFull(v) {
  return fmtNum(v, 2);
}

/** 金额：带 ¥ 前缀 */
export function fmtCny(v) {
  return '¥' + fmtNum(v, 2);
}

/** 比率 → 百分比字符串。v=0.0123 → '+1.23%' */
export function fmtPct(v, withSign = true, d = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '--';
  const n = Number(v) * 100;
  const s = n > 0 && withSign ? '+' : '';
  return s + n.toFixed(d) + '%';
}

/** 股数 → 手（1 手 = 100 股） */
export function fmtQty(shares) {
  if (shares === null || shares === undefined || Number.isNaN(shares)) return '--';
  return Math.round(Number(shares) / 100).toLocaleString('en-US');
}

/** 成交量（股）→ 手（千分位） */
export function fmtVol(shares) {
  if (shares === null || shares === undefined || Number.isNaN(shares)) return '--';
  return Math.round(Number(shares) / 100).toLocaleString('en-US');
}

/** 带正负号的数字 */
export function signText(v, d = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '--';
  const n = Number(v);
  return (n > 0 ? '+' : '') + n.toFixed(d);
}

/* ───────── 时间 ───────── */

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/** 时间戳 → 'HH:MM:SS' */
export function fmtTime(ts) {
  const d = ts instanceof Date ? ts : new Date(ts || Date.now());
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/** 时间戳 → 'HH:MM' */
export function fmtHM(ts) {
  const d = ts instanceof Date ? ts : new Date(ts || Date.now());
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** 时间戳 → 'MM-DD HH:MM' */
export function fmtDateTime(ts) {
  const d = ts instanceof Date ? ts : new Date(ts || Date.now());
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** 秒 → 'MM:SS' */
export function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return pad2(Math.floor(sec / 60)) + ':' + pad2(sec % 60);
}

/** 虚拟时间戳 → 状态栏时钟（用于模拟盘中时间） */
export function fmtVClock(ts) {
  const d = new Date(ts || Date.now());
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* ───────── 语义 ───────── */

/** 数值 → 'up' | 'down' | 'flat'（红涨绿跌） */
export function signClass(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}

/** 涨跌幅（比率）→ 'up' | 'down' | 'flat' */
export function pctClass(v) { return signClass(v); }

/** 距离字符串 */
export function distText(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.round(ms / 60000) + 'min';
}

/* ───────── DOM ───────── */

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

/** 创建元素：el('div', {class:'x', html:'..'}, child1, child2) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class' || k === 'className') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  appendAll(node, children);
  return node;
}

function appendAll(node, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendAll(node, c);
    else node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** HTML 字符串 → 元素（取第一个子节点） */
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = String(html).trim();
  return t.content.firstElementChild;
}

/** HTML 字符串 → DocumentFragment */
export function frag(html) {
  const t = document.createElement('template');
  t.innerHTML = String(html);
  return t.content;
}

export function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

export function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

export function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ───────── 其他 ───────── */

let _uid = 0;
export function uid(prefix = 'u') { return prefix + '_' + (++_uid).toString(36) + Date.now().toString(36).slice(-4); }

export function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
export function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

export function debounce(fn, ms = 120) {
  let t = 0;
  return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
}

export function throttle(fn, ms = 100) {
  let last = 0, timer = 0, lastArgs = null;
  return function (...args) {
    const now = Date.now();
    lastArgs = args;
    if (now - last >= ms) { last = now; fn.apply(this, args); }
    else if (!timer) {
      timer = setTimeout(() => { timer = 0; last = Date.now(); fn.apply(this, lastArgs); }, ms - (now - last));
    }
  };
}

/** 数字动画（用于资金/收益滚动） */
export function animateNumber(from, to, ms, step) {
  const t0 = performance.now();
  const tick = (t) => {
    const k = clamp((t - t0) / ms, 0, 1);
    const e = 1 - Math.pow(1 - k, 3);
    step(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** 简易确认弹窗（Promise）。opts: {title, body, okText, cancelText, danger} */
export function confirmBox(opts = {}) {
  return new Promise((resolve) => {
    const host = document.getElementById('modal-host') || document.body;
    const mask = el('div', { class: 'modal-mask' });
    const box = el('div', { class: 'modal-box' + (opts.danger ? ' danger' : '') });
    box.appendChild(el('div', { class: 'modal-hd', text: opts.title || '请确认' }));
    box.appendChild(el('div', { class: 'modal-bd', html: opts.body || '' }));
    const ft = el('div', { class: 'modal-ft' });
    const cancel = el('button', { class: 'btn', text: opts.cancelText || '取消' });
    const ok = el('button', {
      class: 'btn ' + (opts.danger === 'buy' ? 'btn-buy' : opts.danger === 'sell' ? 'btn-sell' : 'btn-primary'),
      text: opts.okText || '确定',
    });
    /* 纯信息弹窗只留一个按钮：以前「关闭」和「知道了」行为完全相同，纯属误导 */
    if (!opts.hideCancel) ft.appendChild(cancel);
    ft.appendChild(ok);
    box.appendChild(ft);
    mask.appendChild(box);
    host.appendChild(mask);
    const done = (v) => { mask.remove(); document.removeEventListener('keydown', key); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
    cancel.onclick = () => done(false);
    ok.onclick = () => done(true);
    mask.onclick = (e) => { if (e.target === mask) done(false); };
    document.addEventListener('keydown', key);
    setTimeout(() => ok.focus(), 30);
  });
}

/** 简易信息弹窗（单按钮：信息类弹窗不需要「取消」） */
export function infoBox(title, html, okText = '知道了') {
  return confirmBox({ title, body: html, okText, hideCancel: true });
}
