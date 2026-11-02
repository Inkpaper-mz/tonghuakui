/* ═══════════════════════════════════════════════════════════
   同花亏 · tables.js —— 底部标签表格：持仓/委托/成交/资金/排行/资讯
   接口：createTables(host, ctx) → { update(), destroy() }
   要点：每个标签页骨架只建一次，行按 key 复用（不重建 DOM），
        因此每 tick 更新不闪烁、不丢滚动位置，撤单按钮不会失效。
   ═══════════════════════════════════════════════════════════ */
import { el, clear, on, uid, fmtNum, fmtMoney, fmtPrice, fmtPct, fmtTime,
         fmtDateTime, signClass } from '../util.js';
import { patchUi, derived, position } from '../store.js';

const TABS = [
  { k: 'positions', t: '持仓' },
  { k: 'orders', t: '委托' },
  { k: 'trades', t: '成交' },
  { k: 'cash', t: '资金' },
  { k: 'rank', t: '排行' },
  { k: 'news', t: '资讯' },
];

const ORDER_STATUS = {
  open: '已报', partial: '部成', filled: '已成', canceled: '已撤', rejected: '废单',
};
const SIDE_CN = { buy: '买入', sell: '卖出' };

/* 带符号的金额（万/亿 简称） */
function signedMoney(v) {
  const n = Number(v) || 0;
  return (n > 0 ? '+' : '') + fmtMoney(n);
}
function lots(shares) { return Math.round((Number(shares) || 0) / 100); }

/* ═══════════ 通用表格：骨架 + 按 key 复用行 ═══════════ */
function makeTable(cols, emptyText, withFoot) {
  const table = el('table', { class: 'tbl' });
  const thead = el('thead');
  const hr = el('tr');
  for (const c of cols) {
    hr.appendChild(el('th', {
      class: c.cls || '',
      style: c.w ? { width: c.w + 'px' } : null,
      text: c.t,
    }));
  }
  thead.appendChild(hr);
  const tbody = el('tbody');
  table.appendChild(thead);
  table.appendChild(tbody);
  let footCells = null;
  if (withFoot) {
    const tfoot = el('tfoot');
    const fr = el('tr');
    footCells = cols.map((c) => {
      const td = el('td', { class: c.cls || '' });
      fr.appendChild(td);
      return td;
    });
    tfoot.appendChild(fr);
    table.appendChild(tfoot);
  }
  return { el: table, cols, tbody, footCells, cache: new Map(), emptyRow: null, emptyText };
}

function setCell(cell, spec) {
  if (spec && spec.node) {
    if (cell.firstChild !== spec.node || cell.childNodes.length !== 1) {
      clear(cell);
      cell.appendChild(spec.node);
    }
  } else {
    const t = spec && spec.t != null ? spec.t : '';
    if (cell.__t !== t || (cell.firstChild && cell.firstChild.nodeType !== 3)) {
      cell.textContent = t;
      cell.__t = t;
    }
  }
  const c = (spec && spec.c) || '';
  if (cell.__c !== c) { cell.className = c; cell.__c = c; }
  const ti = spec && spec.title != null ? spec.title : '';
  if (cell.title !== ti) cell.title = ti;
}

function updateTable(T, rows) {
  const tb = T.tbody;
  if (!rows.length) {
    for (const row of T.cache.values()) row.node.remove();
    T.cache.clear();
    if (!T.emptyRow) {
      const td = el('td', { class: 'c', colspan: T.cols.length });
      td.appendChild(el('div', { class: 'empty' },
        el('span', { class: 'ico', text: '▤' }),
        el('span', { text: T.emptyText })));
      T.emptyRow = el('tr', { class: 'tr-empt' }, td);
    }
    if (tb.firstChild !== T.emptyRow || tb.childNodes.length !== 1) {
      clear(tb);
      tb.appendChild(T.emptyRow);
    }
    return;
  }
  if (T.emptyRow && T.emptyRow.parentNode) T.emptyRow.remove();

  const seen = new Set();
  let idx = 0;
  for (const r of rows) {
    seen.add(r.key);
    let row = T.cache.get(r.key);
    if (!row) {
      const tr = el('tr', { dataset: { key: String(r.key) } });
      const cells = T.cols.map((c) => {
        const td = el('td', { class: c.cls || '' });
        tr.appendChild(td);
        return td;
      });
      row = { node: tr, cells };
      T.cache.set(r.key, row);
    }
    const cls = r.cls || '';
    if (row.node.className !== cls) row.node.className = cls;
    for (let i = 0; i < T.cols.length; i++) setCell(row.cells[i], r.cells[i]);
    if (tb.children[idx] !== row.node) tb.insertBefore(row.node, tb.children[idx] || null);
    idx += 1;
  }
  for (const [k, row] of T.cache) {
    if (!seen.has(k)) { row.node.remove(); T.cache.delete(k); }
  }
}

/* ═══════════════════════════════════════════════════════════ */
export function createTables(host, ctx) {
  const state = ctx.state;
  const offs = [];
  clear(host);
  host.classList.add('panel');

  /* ── 标题栏：标签 + 汇总 + 折叠 ── */
  const sumLab = el('span', { class: 'dim', text: '' });
  const collapseBtn = el('button', { class: 'btn btn-sm tr-collapse', type: 'button', text: '▼', title: '折叠/展开底部表格' });
  const hd = el('div', { class: 'panel-hd' });

  const tabBtns = new Map();
  const tabWrap = el('div', { class: 'tr-tabs' });
  for (const T of TABS) {
    const b = el('div', { class: 'tr-tab' + (T.k === 'positions' ? ' active' : ''), text: T.t, title: '切换到' + T.t });
    b.onclick = () => { patchUi({ bottomTab: T.k }); update(); };
    tabBtns.set(T.k, b);
    tabWrap.appendChild(b);
  }
  hd.appendChild(tabWrap);
  hd.appendChild(el('span', { class: 'hd-right' }, sumLab, collapseBtn));

  const bd = el('div', { class: 'panel-bd' });
  host.appendChild(hd);
  host.appendChild(bd);

  collapseBtn.onclick = () => {
    state.ui.bottomCollapsed = !state.ui.bottomCollapsed;
    update();
  };

  /* ── 右键菜单（持仓：卖出 / 撤单） ── */
  let menu = null;
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  function openMenu(x, y, items) {
    closeMenu();
    menu = el('div', { class: 'tr-menu' });
    for (const it of items) {
      const mi = el('div', { class: 'tr-mi' + (it.disabled ? ' disabled' : ''), text: it.label });
      if (!it.disabled) {
        mi.onclick = () => { closeMenu(); it.run(); };
      }
      menu.appendChild(mi);
    }
    (document.getElementById('ctxmenu-host') || document.body).appendChild(menu);
    const w = 140, h = items.length * 22 + 10;
    menu.style.left = Math.max(2, Math.min(x, window.innerWidth - w - 4)) + 'px';
    menu.style.top = Math.max(2, Math.min(y, window.innerHeight - h - 4)) + 'px';
  }
  offs.push(on(document, 'mousedown', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); }));
  offs.push(on(document, 'scroll', closeMenu, true));
  offs.push(on(window, 'blur', closeMenu));
  offs.push(on(document, 'keydown', (e) => { if (e.key === 'Escape') closeMenu(); }));

  /* ── 资产曲线采样（只记录本会话收到的 account 快照） ── */
  const samples = [];
  let lastSampleTs = 0;
  function sampleEquity() {
    const a = state.account;
    if (!a || !Number.isFinite(Number(a.totalAssets))) return;
    const now = Date.now();
    if (samples.length && now - lastSampleTs < 1000) {
      samples[samples.length - 1][1] = Number(a.totalAssets);
      return;
    }
    lastSampleTs = now;
    samples.push([now, Number(a.totalAssets)]);
    if (samples.length > 400) samples.shift();
  }
  function curveData() {
    const a = state.account;
    if (a && Array.isArray(a.equity) && a.equity.length > 1) return a.equity;
    return samples;
  }

  /* ═══════════ ① 持仓 ═══════════ */
  function buildPositions() {
    const cols = [
      { t: '代码', w: 62, cls: 'c' }, { t: '名称', w: 78, cls: 'l' },
      { t: '持仓', w: 64 }, { t: '可用', w: 64 }, { t: '成本价', w: 66 },
      { t: '现价', w: 66 }, { t: '市值', w: 88 }, { t: '浮动盈亏', w: 88 },
      { t: '盈亏比例', w: 74 }, { t: '占比', w: 58 }, { t: '操作', w: 58, cls: 'c' },
    ];
    const T = makeTable(cols, '暂无持仓', true);
    const sellBtns = new Map();
    const sellBtn = (id) => {
      let b = sellBtns.get(id);
      if (!b) {
        b = el('button', { class: 'btn btn-sm', type: 'button', text: '卖出' });
        b.onclick = (e) => {
          e.stopPropagation();
          const p = position(id);
          ctx.root.dispatchEvent(new CustomEvent('tr:fill-order', {
            detail: { stockId: id, side: 'sell', qty: p ? Number(p.avail) || 0 : 0 },
          }));
        };
        sellBtns.set(id, b);
      }
      return b;
    };

    const wrap = el('div', { class: 'tr-scroll' }, T.el);
    const pane = el('div', { class: 'tr-pane' }, wrap);

    offs.push(on(pane, 'click', (e) => {
      const tr = e.target.closest && e.target.closest('tr[data-key]');
      if (tr) patchUi({ stockId: tr.dataset.key });
    }));
    offs.push(on(pane, 'contextmenu', (e) => {
      const tr = e.target.closest && e.target.closest('tr[data-key]');
      if (!tr) return;
      e.preventDefault();
      const id = tr.dataset.key;
      const p = position(id);
      const m = state.stocks.get(id) || {};
      const av = p ? Number(p.avail) || 0 : 0;
      openMenu(e.clientX, e.clientY, [
        { label: '卖出 ' + (m.name || id) + '（可卖 ' + av + ' 股）', disabled: av <= 0,
          run: () => ctx.root.dispatchEvent(new CustomEvent('tr:fill-order', { detail: { stockId: id, side: 'sell', qty: av } })) },
        { label: '买入 ' + (m.name || id), run: () => ctx.root.dispatchEvent(new CustomEvent('tr:fill-order', { detail: { stockId: id, side: 'buy' } })) },
        { label: '查看行情', run: () => patchUi({ stockId: id }) },
      ]);
    }));

    function update() {
      const acc = state.account || {};
      const list = (acc.positions || []).filter((p) => (Number(p.qty) || 0) > 0);
      let mvSum = 0, pnlSum = 0, costSum = 0;
      const rows = list.map((p) => {
        const d = derived(p.i);
        const price = d ? d.p : Number(p.price) || 0;
        const qty = Number(p.qty) || 0;
        const avgCost = Number(p.avgCost) || 0;
        const mv = price * qty;
        const pnl = (price - avgCost) * qty;
        const pnlPct = avgCost > 0 ? price / avgCost - 1 : 0;
        mvSum += mv; pnlSum += pnl; costSum += avgCost * qty;
        const name = (state.stocks.get(p.i) || {}).name || p.name || p.i;
        const cls = signClass(pnl);
        return {
          key: p.i,
          cells: [
            { t: p.i, c: 'c code' },
            { t: name, c: 'l ellip', title: name },
            { t: fmtNum(qty, 0), c: 'num' },
            { t: fmtNum(p.avail, 0), c: 'num' },
            { t: fmtPrice(avgCost), c: 'num' },
            { t: fmtPrice(price), c: 'num ' + signClass(price - avgCost) },
            { t: fmtMoney(mv), c: 'num' },
            { t: signedMoney(pnl), c: 'num ' + cls, title: fmtNum(pnl, 2) },
            { t: fmtPct(pnlPct), c: 'num ' + cls },
            { t: mvSum > 0 ? fmtPct(mv / mvSum, false) : '--', c: 'num' },
            { node: sellBtn(p.i), c: 'c' },
          ],
        };
      });
      updateTable(T, rows);
      if (T.footCells) {
        const f = T.footCells;
        setCell(f[0], { t: '合计', c: 'c' });
        setCell(f[1], { t: list.length + ' 只', c: 'l' });
        for (let i = 2; i < 6; i++) setCell(f[i], { t: '' });
        setCell(f[6], { t: fmtMoney(mvSum), c: 'num', title: fmtNum(mvSum, 2) });
        setCell(f[7], { t: signedMoney(pnlSum), c: 'num ' + signClass(pnlSum), title: fmtNum(pnlSum, 2) });
        setCell(f[8], { t: costSum > 0 ? fmtPct(pnlSum / costSum) : '--', c: 'num ' + signClass(pnlSum) });
        setCell(f[9], { t: '100.00%', c: 'num' });
        setCell(f[10], { t: '', c: 'c' });
      }
    }
    return { key: 'positions', el: pane, update, summary: () => {
      const acc = state.account || {};
      let mv = 0;
      for (const p of acc.positions || []) {
        const d = derived(p.i);
        mv += (d ? d.p : Number(p.price) || 0) * (Number(p.qty) || 0);
      }
      return '持仓 ' + ((acc.positions || []).length) + ' 只 · 市值 ' + fmtMoney(mv) +
        ' · 浮动盈亏 ' + signedMoney(acc.pnl);
    } };
  }

  /* ═══════════ ② 委托 ═══════════ */
  function buildOrders() {
    const cols = [
      { t: '时间', w: 68, cls: 'c' }, { t: '代码', w: 62, cls: 'c' }, { t: '名称', w: 78, cls: 'l' },
      { t: '方向', w: 48, cls: 'c' }, { t: '类型', w: 46, cls: 'c' }, { t: '委托价', w: 68 },
      { t: '委托量', w: 66 }, { t: '已成', w: 60 }, { t: '撤单量', w: 66 },
      { t: '状态', w: 54, cls: 'c' }, { t: '操作', w: 60, cls: 'c' },
    ];
    const T = makeTable(cols, '暂无委托', false);
    const cancelBtns = new Map();
    const cancelBtn = (id) => {
      let b = cancelBtns.get(id);
      if (!b) {
        b = el('button', { class: 'btn btn-sm', type: 'button', text: '撤单' });
        b.onclick = (e) => {
          e.stopPropagation();
          ctx.net.send('order:cancel', { orderId: id, reqId: uid('c') });
        };
        cancelBtns.set(id, b);
      }
      return b;
    };
    const wrap = el('div', { class: 'tr-scroll' }, T.el);
    const pane = el('div', { class: 'tr-pane' }, wrap);

    function update() {
      const acc = state.account || {};
      const rows = (acc.orders || []).map((o) => {
        const name = (state.stocks.get(o.i) || {}).name || o.name || o.i;
        const qty = Number(o.qty) || 0, filled = Number(o.filled) || 0;
        const st = String(o.status || 'open');
        const canCancel = st === 'open' || st === 'partial';
        const sideCls = o.side === 'buy' ? 'up' : 'down';
        return {
          key: o.id,
          cells: [
            { t: fmtTime(o.time), c: 'c' },
            { t: o.i, c: 'c code' },
            { t: name, c: 'l ellip', title: name },
            { t: SIDE_CN[o.side] || o.side, c: 'c ' + sideCls },
            { t: o.type === 'market' ? '市价' : '限价', c: 'c' },
            { t: fmtPrice(o.price), c: 'num' },
            { t: fmtNum(qty, 0), c: 'num' },
            { t: fmtNum(filled, 0), c: 'num' },
            { t: st === 'filled' ? '0' : fmtNum(Math.max(0, qty - filled), 0), c: 'num' },
            { t: ORDER_STATUS[st] || st, c: 'c ' + (st === 'rejected' ? 'down' : st === 'filled' ? 'up' : '') },
            canCancel ? { node: cancelBtn(o.id), c: 'c' } : { t: '--', c: 'c dim' },
          ],
        };
      });
      updateTable(T, rows);
    }
    return { key: 'orders', el: pane, update, summary: () => {
      const os = (state.account || {}).orders || [];
      const open = os.filter((o) => o.status === 'open' || o.status === 'partial').length;
      return '委托 ' + os.length + ' 笔 · 可撤 ' + open;
    } };
  }

  /* ═══════════ ③ 成交 ═══════════ */
  function buildTrades() {
    const cols = [
      { t: '时间', w: 68, cls: 'c' }, { t: '代码', w: 62, cls: 'c' }, { t: '名称', w: 78, cls: 'l' },
      { t: '方向', w: 48, cls: 'c' }, { t: '成交价', w: 68 }, { t: '成交量', w: 66 },
      { t: '成交额', w: 92 }, { t: '手续费', w: 70 }, { t: '盈亏', w: 84 },
    ];
    const T = makeTable(cols, '暂无成交', true);
    const wrap = el('div', { class: 'tr-scroll' }, T.el);
    const pane = el('div', { class: 'tr-pane' }, wrap);

    function update() {
      const acc = state.account || {};
      let feeSum = 0, amtSum = 0, pnlSum = 0, hasPnl = false;
      const rows = (acc.trades || []).map((t) => {
        const name = (state.stocks.get(t.i) || {}).name || t.name || t.i;
        const amt = Number(t.amount) || (Number(t.price) || 0) * (Number(t.qty) || 0);
        const fee = Number(t.fee) || 0;
        feeSum += fee; amtSum += amt;
        const has = t.pnl != null;
        if (has) { pnlSum += Number(t.pnl) || 0; hasPnl = true; }
        const sideCls = t.side === 'buy' ? 'up' : 'down';
        return {
          key: t.id,
          cells: [
            { t: fmtTime(t.time), c: 'c' },
            { t: t.i, c: 'c code' },
            { t: name, c: 'l ellip', title: name },
            { t: SIDE_CN[t.side] || t.side, c: 'c ' + sideCls },
            { t: fmtPrice(t.price), c: 'num' },
            { t: fmtNum(t.qty, 0), c: 'num' },
            { t: fmtNum(amt, 2), c: 'num' },
            { t: fmtNum(fee, 2), c: 'num dim' },
            has ? { t: signedMoney(t.pnl), c: 'num ' + signClass(t.pnl) } : { t: '--', c: 'num dim' },
          ],
        };
      });
      updateTable(T, rows);
      if (T.footCells) {
        const f = T.footCells;
        setCell(f[0], { t: '合计', c: 'c' });
        setCell(f[1], { t: '', c: 'c' });
        setCell(f[2], { t: rows.length + ' 笔', c: 'l' });
        setCell(f[3], { t: '', c: 'c' });
        setCell(f[4], { t: '', c: 'num' });
        setCell(f[5], { t: '', c: 'num' });
        setCell(f[6], { t: fmtNum(amtSum, 2), c: 'num' });
        setCell(f[7], { t: fmtNum(feeSum, 2), c: 'num' });
        setCell(f[8], { t: hasPnl ? signedMoney(pnlSum) : '--', c: 'num ' + signClass(pnlSum) });
      }
    }
    return { key: 'trades', el: pane, update, summary: () => {
      const ts = (state.account || {}).trades || [];
      let fee = 0;
      for (const t of ts) fee += Number(t.fee) || 0;
      return '成交 ' + ts.length + ' 笔 · 手续费 ' + fmtNum(fee, 2);
    } };
  }

  /* ═══════════ ④ 资金 ═══════════ */
  function buildCash() {
    const mk = (k) => {
      const v = el('span', { class: 'v', text: '--' });
      return { el: el('div', { class: 'kv' }, el('span', { class: 'k', text: k }), v), v };
    };
    const cash = mk('可用资金'), frozen = mk('冻结资金'), total = mk('总资产'),
      mv = mk('持仓市值'), pnl = mk('浮动盈亏'), pnlPct = mk('总收益率'),
      today = mk('当日盈亏'), ret = mk('对局收益率');
    const canvas = el('canvas', { class: 'tr-curve' });
    const pane = el('div', { class: 'tr-pane' },
      el('div', { class: 'tr-cash' },
        el('div', { class: 'tr-cash-grid' },
          cash.el, frozen.el, total.el, mv.el, pnl.el, pnlPct.el, today.el, ret.el),
        canvas,
        el('div', { class: 'tr-cash-hint dim', text: '资产曲线（本局 account 快照采样）' })));

    function drawCurve() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;                       // 隐藏时 clientWidth=0，跳过
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      const g = canvas.getContext('2d');
      if (!g) return;
      const css = getComputedStyle(canvas);
      const cLine = (css.getPropertyValue('--accent') || '').trim();
      const cUp = (css.getPropertyValue('--up') || '').trim();
      const cDown = (css.getPropertyValue('--down') || '').trim();
      const cGrid = (css.getPropertyValue('--border-2') || '').trim();
      const cText = (css.getPropertyValue('--text-3') || '').trim();
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      const data = curveData();
      if (!data || data.length < 2) {
        g.fillStyle = cText;
        g.font = '12px sans-serif';
        g.textAlign = 'center';
        g.fillText('数据积累中…', w / 2, h / 2);
        return;
      }
      const xs = data.map((d) => Number(d[0]) || 0);
      const ys = data.map((d) => Number(d[1]) || 0);
      const x0 = xs[0], x1 = xs[xs.length - 1];
      let yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
      if (yMax - yMin < 1e-9) { yMax += 1; yMin -= 1; }
      const pad = 6;
      const X = (v) => pad + (x1 > x0 ? ((v - x0) / (x1 - x0)) * (w - pad * 2) : 0);
      const Y = (v) => h - pad - ((v - yMin) / (yMax - yMin)) * (h - pad * 2);

      /* 网格 + 上下限标注 */
      g.strokeStyle = cGrid;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, Math.round(Y(yMax)) + 0.5);
      g.lineTo(w, Math.round(Y(yMax)) + 0.5);
      g.moveTo(0, Math.round(Y(yMin)) + 0.5);
      g.lineTo(w, Math.round(Y(yMin)) + 0.5);
      g.stroke();
      g.fillStyle = cText;
      g.font = '10px sans-serif';
      g.textAlign = 'left';
      g.fillText(fmtMoney(yMax), 3, 10);
      g.fillText(fmtMoney(yMin), 3, h - 3);

      /* 折线：终点涨红跌绿 */
      const up = ys[ys.length - 1] >= ys[0];
      g.strokeStyle = up ? cUp : cDown;
      g.lineWidth = 1.4;
      g.beginPath();
      for (let i = 0; i < data.length; i++) {
        const x = X(xs[i]), y = Y(ys[i]);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }

    function update() {
      sampleEquity();
      const acc = state.account;
      const me = (state.rank || []).find((r) => r.isMe);
      const set = (o, t, cls) => { if (o.v.textContent !== t) o.v.textContent = t; o.v.className = 'v' + (cls ? ' ' + cls : ''); };
      if (!acc) {
        for (const o of [cash, frozen, total, mv, pnl, pnlPct, today, ret]) set(o, '--', '');
      } else {
        set(cash, fmtNum(acc.available != null ? acc.available : acc.cash, 2));
        set(frozen, fmtNum(acc.frozen, 2));
        set(total, fmtNum(acc.totalAssets, 2));
        set(mv, fmtNum(acc.marketValue, 2));
        set(pnl, fmtNum(acc.pnl, 2), signClass(acc.pnl));
        set(pnlPct, fmtPct(acc.pnlPct), signClass(acc.pnlPct));
        set(today, me && me.todayPnl != null ? fmtNum(me.todayPnl, 2) : '--',
          me && me.todayPnl != null ? signClass(me.todayPnl) : '');
        const base = (state.match && state.match.startCash) || (acc.totalAssets - (acc.pnl || 0));
        set(ret, base > 0 ? fmtPct((acc.totalAssets - base) / base) : '--',
          base > 0 ? signClass(acc.totalAssets - base) : '');
      }
      drawCurve();
    }
    return { key: 'cash', el: pane, update, summary: () => {
      const a = state.account;
      return a ? ('总资产 ' + fmtNum(a.totalAssets, 2) + ' · 收益率 ' + fmtPct(a.pnlPct)) : '资金 --';
    } };
  }

  /* ═══════════ ⑤ 排行 ═══════════ */
  function buildRank() {
    const cols = [
      { t: '名次', w: 50, cls: 'c' }, { t: '玩家', w: 140, cls: 'l' },
      { t: '资产', w: 110 }, { t: '收益率', w: 80 }, { t: '操作次数', w: 80, cls: 'c' },
    ];
    const T = makeTable(cols, '暂无排行数据', false);
    const wrap = el('div', { class: 'tr-scroll' }, T.el);
    const pane = el('div', { class: 'tr-pane' }, wrap);

    function update() {
      const acc = state.account || {};
      const mine = (acc.orders || []).length;
      const rows = (state.rank || []).map((r, i) => {
        const rankNo = r.rank != null ? r.rank : i + 1;
        const isMe = !!r.isMe;
        const cnt = r.tradeCount != null ? r.tradeCount : (isMe ? mine : null);
        return {
          key: r.id || ('r' + i),
          cls: isMe ? 'tr-me' : '',
          cells: [
            { t: String(rankNo), c: 'c' + (rankNo <= 3 ? ' strong' : '') },
            { t: (r.nick || r.id || '--') + (isMe ? '（我）' : '') + (r.isBot ? ' [AI]' : ''), c: 'l ellip' },
            { t: fmtNum(r.assets, 2), c: 'num' },
            { t: fmtPct(r.returnPct), c: 'num ' + signClass(r.returnPct) },
            { t: cnt != null ? String(cnt) : '--', c: 'c' },
          ],
        };
      });
      updateTable(T, rows);
    }
    return { key: 'rank', el: pane, update, summary: () => {
      const list = state.rank || [];
      const idx = list.findIndex((r) => r.isMe);
      return list.length ? ('第 ' + (idx >= 0 ? idx + 1 : '-') + ' 名 / 共 ' + list.length + ' 人') : '排行 --';
    } };
  }

  /* ═══════════ ⑥ 资讯 ═══════════ */
  function buildNews() {
    const cols = [
      { t: '时间', w: 96, cls: 'c' }, { t: '标题', cls: 'l' },
      { t: '板块', w: 76, cls: 'c' }, { t: '方向', w: 58, cls: 'c' },
    ];
    const T = makeTable(cols, '暂无资讯', false);
    const wrap = el('div', { class: 'tr-scroll' }, T.el);
    const pane = el('div', { class: 'tr-pane' }, wrap);

    function tagCls(predict) {
      if (predict === '利多') return 'tag tag-up';
      if (predict === '利空') return 'tag tag-down';
      return 'tag';
    }
    function update() {
      const list = (state.news || []).slice().sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));
      const rows = list.map((n, i) => ({
        key: n.id || ('n' + i),
        cells: [
          { t: fmtDateTime(n.time), c: 'c dim' },
          { t: n.title || '--', c: 'l ellip', title: (n.title || '') + (n.body ? '\n' + n.body : '') },
          { t: n.sector || '--', c: 'c dim' },
          { t: n.predict || '中性', c: 'c ' + tagCls(n.predict) },
        ],
      }));
      updateTable(T, rows);
    }
    return { key: 'news', el: pane, update, summary: () => '快讯 ' + ((state.news || []).length) + ' 条' };
  }

  /* ═══════════ 标签页装配 ═══════════ */
  const BUILD = {
    positions: buildPositions, orders: buildOrders, trades: buildTrades,
    cash: buildCash, rank: buildRank, news: buildNews,
  };
  const panes = new Map();
  function ensure(tab) {
    let p = panes.get(tab);
    if (!p) {
      p = BUILD[tab]();
      panes.set(tab, p);
      bd.appendChild(p.el);
    }
    return p;
  }

  function update() {
    sampleEquity();
    const ui = state.ui;
    /* 未知标签（例如 'ai' 由 trade.js 自己渲染）不要回退成 'positions'，
       否则会出现「持仓」和「AI 诊股」两个底部标签同时高亮。 */
    let tab = ui.bottomTab;
    if (!tabBtns.has(tab)) tab = '';
    for (const [k, b] of tabBtns) {
      const cls = 'tr-tab' + (k === tab ? ' active' : '');
      if (b.className !== cls) b.className = cls;
    }
    host.classList.toggle('collapsed', !!ui.bottomCollapsed);
    const arrow = ui.bottomCollapsed ? '▶' : '▼';
    if (collapseBtn.textContent !== arrow) collapseBtn.textContent = arrow;

    const pane = ensure(tab);
    for (const [k, p] of panes) p.el.classList.toggle('hidden', k !== tab);
    pane.update();
    sumLab.textContent = pane.summary ? pane.summary() : '';
  }

  offs.push(on(window, 'resize', () => {
    const tab = state.ui.bottomTab;
    const p = panes.get(tab);
    if (p && p.key === 'cash' && p.update) p.update();
  }));

  update();
  return {
    update,
    destroy() {
      closeMenu();
      for (const off of offs) { try { off(); } catch (e) { /* ignore */ } }
      offs.length = 0;
      panes.clear();
      samples.length = 0;
      clear(host);
    },
  };
}
