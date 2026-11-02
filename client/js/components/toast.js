/* ═══════════════════════════════════════════════════════════════
   同花亏 · components/toast.js —— 右下角浮层通知
   接口（DESIGN.md §4.4）：createToast(host) -> { show(msg, level), destroy() }
   level: 'info' | 'success' | 'warn' | 'error'
   ═══════════════════════════════════════════════════════════════ */

import { el } from '../util.js';

const ICONS = { info: 'ℹ', success: '✔', warn: '⚠', error: '✖' };
const TITLES = { info: '提示', success: '成功', warn: '注意', error: '错误' };
const DURATION = { info: 3200, success: 3200, warn: 4200, error: 5600 };
const MAX_VISIBLE = 6;

const raf = (typeof requestAnimationFrame === 'function')
  ? requestAnimationFrame
  : (fn) => setTimeout(fn, 16);

export function createToast(host) {
  const mount = host || document.body;
  const list = el('div', { class: 'toast-list' });
  mount.appendChild(list);

  const items = [];
  let destroyed = false;

  function remove(rec) {
    const i = items.indexOf(rec);
    if (i < 0) return;
    items.splice(i, 1);
    clearTimeout(rec.timer);
    if (!rec.node.parentNode) return;
    rec.node.classList.add('out');
    setTimeout(() => { if (rec.node.parentNode) rec.node.remove(); }, 200);
  }

  /** 弹一条通知；返回记录对象（可手动 remove） */
  function show(msg, level = 'info') {
    if (destroyed) return null;
    const lv = ICONS[level] ? level : 'info';
    const text = String(msg === null || msg === undefined ? '' : msg);
    if (!text) return null;

    /* 400ms 内完全相同的内容只弹一次（避免 ack + error 双推时刷屏） */
    const last = items[items.length - 1];
    if (last && last.text === text && Date.now() - last.time < 400) return last;

    const node = el('div', { class: 'toast toast-' + lv, title: TITLES[lv] });
    node.appendChild(el('span', { class: 'toast-ico', text: ICONS[lv] }));
    const body = el('div', { class: 'toast-body' });
    body.appendChild(el('div', { class: 'toast-title', text: TITLES[lv] }));
    body.appendChild(el('div', { class: 'toast-msg', text }));
    node.appendChild(body);
    const close = el('span', { class: 'toast-x', text: '✕', title: '关闭' });
    node.appendChild(close);

    const rec = { text, time: Date.now(), node, timer: 0, remove: () => remove(rec) };
    items.push(rec);
    list.appendChild(node);

    node.onclick = (e) => { if (e.target !== close) remove(rec); else e.stopPropagation(); };
    close.onclick = (e) => { e.stopPropagation(); remove(rec); };
    rec.timer = setTimeout(() => remove(rec), DURATION[lv]);

    /* 入场动画 */
    raf(() => { if (node.parentNode) node.classList.add('in'); });

    /* 超出上限，淘汰最老的 */
    while (items.length > MAX_VISIBLE) remove(items[0]);
    return rec;
  }

  function destroy() {
    destroyed = true;
    for (const rec of items.slice()) { clearTimeout(rec.timer); if (rec.node.parentNode) rec.node.remove(); }
    items.length = 0;
    if (list.parentNode) list.remove();
  }

  return { show, destroy, get count() { return items.length; } };
}

export default createToast;
