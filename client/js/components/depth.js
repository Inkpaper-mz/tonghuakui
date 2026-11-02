/* ═══════════════════════════════════════════════════════════
   同花亏 · depth.js —— 五档盘口 + 分时明细
   接口：createDepth(host, ctx) → { update(), destroy() }
   说明：点击某一档 → 在 ctx.root 上派发 'tr:pick-price'，
        由 order-form 接收（不直接跨组件引用）。
   ═══════════════════════════════════════════════════════════ */
import { el, clear, fmtPrice, fmtVol, fmtPct, signText, signClass, fmtTime } from '../util.js';
import { derived } from '../store.js';

const ASK_LABEL = ['卖一', '卖二', '卖三', '卖四', '卖五'];
const BID_LABEL = ['买一', '买二', '买三', '买四', '买五'];
const MAX_DETAIL = 60;

export function createDepth(host, ctx) {
  const state = ctx.state;
  clear(host);
  host.classList.add('tr-depth');

  /* ═══════════ 五档盘口 ═══════════ */
  const bookHd = el('div', { class: 'panel-hd' }, '五档盘口',
    el('span', { class: 'hd-right dim', text: '单位：手' }));
  const bookBd = el('div', { class: 'panel-bd' });
  const bookBox = el('div', { class: 'tr-book' });
  bookBd.appendChild(bookBox);
  const bookPanel = el('div', { class: 'panel tr-book' }, bookHd, bookBd);

  /* 卖五 → 卖一（上），中间现价，买一 → 买五（下） */
  const askRows = [];   // 索引 0 = 卖五，4 = 卖一
  const bidRows = [];   // 索引 0 = 买一，4 = 买五
  for (let i = 4; i >= 0; i--) askRows.push(makeRow('lv-ask', ASK_LABEL[i]));
  const mid = el('div', { class: 'tr-bk-mid' });
  const midPx = el('span', { class: 'big flat', text: '--' });
  const midChg = el('span', { class: 'chg flat', text: '--' });
  const midPct = el('span', { class: 'pct flat', text: '--' });
  const midAvg = el('span', { class: 'avg', text: '' });
  mid.appendChild(midPx); mid.appendChild(midChg); mid.appendChild(midPct); mid.appendChild(midAvg);
  for (let i = 0; i < 5; i++) bidRows.push(makeRow('lv-bid', BID_LABEL[i]));

  function makeRow(sideCls, label) {
    const bar = el('div', { class: 'tr-bk-bar', style: { width: '0%' } });
    const px = el('span', { class: 'px', text: '--' });
    const vol = el('span', { class: 'vol', text: '' });
    const row = el('div', { class: 'tr-bk-row ' + sideCls, title: '点击填入下单价格' },
      bar, el('span', { class: 'lbl', text: label }), px, vol);
    row.onclick = () => {
      const p = Number(row.dataset.price);
      if (!Number.isFinite(p) || p <= 0) return;
      ctx.root.dispatchEvent(new CustomEvent('tr:pick-price', {
        detail: { price: p, side: sideCls === 'lv-ask' ? 'buy' : 'sell' },
      }));
    };
    return { row, bar, px, vol };
  }

  for (let i = 0; i < 5; i++) bookBox.appendChild(askRows[i].row);
  bookBox.appendChild(mid);
  for (let i = 0; i < 5; i++) bookBox.appendChild(bidRows[i].row);

  /* ═══════════ 分时明细 ═══════════ */
  const dHd = el('div', { class: 'panel-hd' }, '分时明细',
    el('span', { class: 'hd-right dim', text: '最近 0 笔' }));
  const dCount = dHd.querySelector('.hd-right');
  const dBd = el('div', { class: 'panel-bd scroll' });
  const dTable = el('table', { class: 'tbl tr-dtable' });
  const dHead = el('thead', {}, el('tr', {},
    el('th', { class: 'col-t', text: '时间' }),
    el('th', { text: '价格' }),
    el('th', { text: '手数' }),
    el('th', { text: '方向' })));
  const dBody = el('tbody');
  dTable.appendChild(dHead);
  dTable.appendChild(dBody);
  dBd.appendChild(dTable);
  const dPanel = el('div', { class: 'panel tr-detail' }, dHd, dBd);

  host.appendChild(bookPanel);
  host.appendChild(dPanel);

  /* 明细缓存（最新在上，最多 60 行） */
  const entries = [];
  let lastTr = null;

  function pushDetail(q) {
    if (!q || !q.tr || q.tr === lastTr) return;
    lastTr = q.tr;
    const time = state.vclock && state.vclock !== '--:--' ? state.vclock : fmtTime(Date.now());
    let added = 0;
    for (const t of q.tr) {
      const p = Number(t[0]) || 0, v = Number(t[1]) || 0, dir = Number(t[2]) >= 0 ? 1 : -1;
      const cls = dir > 0 ? 'up' : 'down';
      const node = el('tr', {},
        el('td', { class: 'col-t', text: time }),
        el('td', { class: 'num ' + cls, text: fmtPrice(p) }),
        el('td', { class: 'num', text: fmtVol(v) }),
        el('td', { class: 'c ' + cls, text: dir > 0 ? 'B' : 'S' }));
      dBody.insertBefore(node, dBody.firstChild);
      entries.unshift(node);
      if (++added >= 12) break;   // 单 tick 最多入 12 笔，防爆量
    }
    while (entries.length > MAX_DETAIL) {
      const n = entries.pop();
      if (n && n.parentNode) n.remove();
    }
    dCount.textContent = '最近 ' + entries.length + ' 笔';
  }

  /* ═══════════ 更新（每秒 1 次 tick 调用） ═══════════ */
  function update() {
    const id = state.ui.stockId;
    const d = id ? derived(id) : null;
    const q = id ? state.quotes.get(id) : null;
    const pc = d ? (d.prevClose || d.p) : 0;

    if (!d) {
      setText(midPx, '--'); midPx.className = 'big flat';
      setText(midChg, '--'); midChg.className = 'chg flat';
      setText(midPct, '--'); midPct.className = 'pct flat';
      setText(midAvg, '');
      for (const r of askRows.concat(bidRows)) {
        setText(r.px, '--'); r.px.className = 'px flat';
        setText(r.vol, ''); r.bar.style.width = '0%';
        delete r.row.dataset.price;
      }
      return;
    }

    /* 量柱基准：十档最大挂单量 */
    let maxQty = 0;
    for (const lv of [d.b, d.s]) for (const x of (lv || [])) maxQty = Math.max(maxQty, Number(x[1]) || 0);
    if (maxQty <= 0) maxQty = 1;

    /* 卖盘视觉顺序为 卖五→卖一，故把 s（卖一在首）倒序后逐行填充 */
    fillLevels(askRows, d.s ? d.s.slice().reverse() : null, pc, maxQty);
    fillLevels(bidRows, d.b, pc, maxQty);

    /* 中间现价 */
    const cls = signClass(d.change);
    setText(midPx, fmtPrice(d.p)); midPx.className = 'big ' + cls;
    setText(midChg, signText(d.change)); midChg.className = 'chg ' + cls;
    setText(midPct, fmtPct(d.changePct)); midPct.className = 'pct ' + cls;
    const avg = d.v > 0 ? d.a / d.v : d.p;
    setText(midAvg, '均价 ' + fmtPrice(avg));

    pushDetail(q);
  }

  function fillLevels(rows, levels, pc, maxQty) {
    for (let i = 0; i < 5; i++) {
      const r = rows[i];
      const lv = levels ? levels[i] : null;
      if (!lv) {
        setText(r.px, '--'); r.px.className = 'px flat';
        setText(r.vol, '--'); r.bar.style.width = '0%';
        delete r.row.dataset.price;
        continue;
      }
      const p = Number(lv[0]) || 0, v = Number(lv[1]) || 0;
      setText(r.px, fmtPrice(p));
      r.px.className = 'px ' + signClass(p - pc);
      setText(r.vol, fmtVol(v));
      const w = Math.max(2, Math.min(100, (v / maxQty) * 100));
      r.bar.style.width = w.toFixed(1) + '%';
      r.row.dataset.price = String(p);
    }
  }

  function setText(node, s) { if (node.textContent !== s) node.textContent = s; }

  update();
  return {
    update,
    destroy() {
      entries.length = 0;
      lastTr = null;
      clear(host);
    },
  };
}
