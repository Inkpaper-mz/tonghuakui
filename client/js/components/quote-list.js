/* ═══════════════════════════════════════════════════════════
   同花亏 · quote-list.js —— 左侧自选/行情报价表（20 列齐全 + ★ 自选列）
   策略：建一次骨架，每 tick 只改单元格文本与类名；不重建 DOM，
        因此不闪烁、不丢输入焦点、不丢滚动位置。
   数据源：ui.boardTab === 'watch' → 只显示自选股（state.watch）；
          其它值 → 全市场。标题与计数随模式/自选数量即时变化。
   接口：createQuoteList(host, ctx) → { update(), destroy() }
   ═══════════════════════════════════════════════════════════ */
import { el, clear, on, fmtPrice, fmtVol, fmtPct, signText, signClass } from '../util.js';
import { patchUi, derived, ensureWatch, isWatched, toggleWatch, watchIds, subscribe } from '../store.js';

/* 列定义：t=表头 k=排序键（null=不可排序） w=宽度 cls=对齐 star=自选列 */
const HEADERS = [
  { t: '★',    k: null,        w: 22, cls: 'c', star: true },
  { t: '代码',  k: 'code',      w: 56, cls: 'c' },
  { t: '名称',  k: 'name',      w: 70, cls: 'l' },
  { t: '涨幅%', k: 'changePct', w: 58 },
  { t: '现价',  k: 'p',         w: 60 },
  { t: '涨跌',  k: 'change',    w: 56 },
  { t: '买价',  k: 'bid',       w: 56 },
  { t: '卖价',  k: 'ask',       w: 56 },
  { t: '总量',  k: 'v',         w: 66 },
  { t: '现手',  k: 'now',       w: 56 },
  { t: '涨速%', k: 'speed',     w: 54 },
  { t: '换手%', k: 'turn',      w: 54 },
  { t: '量比',  k: 'vr',        w: 46 },
  { t: '振幅%', k: 'amp',       w: 54 },
  { t: '均价',  k: 'avg',       w: 58 },
  { t: '市盈',  k: 'pe',        w: 50 },
  { t: '最高',  k: 'h',         w: 58 },
  { t: '最低',  k: 'l',         w: 58 },
  { t: '今开',  k: 'o',         w: 58 },
  { t: '昨收',  k: 'pc',        w: 58 },
  { t: '委比%', k: 'wb',        w: 58 },
];

const sumTr = (tr) => (tr || []).reduce((s, x) => s + (Number(x[1]) || 0), 0);
const sumLv = (lv) => (lv || []).reduce((s, x) => s + (Number(x[1]) || 0), 0);

const sigOf = (ids) => ids.join(',');

export function createQuoteList(host, ctx) {
  const state = ctx.state;
  const offs = [];
  const stats = new Map();   // id -> { samples, total, lastP, lastQ, lastTr, speed, vr }
  const nodes = new Map();   // id -> { tr, cells[] }
  let sectorKey = '';
  let lastMode = '';         // 上次渲染的数据源：'quote' | 'watch'
  let lastWatchSig = '';     // 上次渲染时的自选集合快照
  let lastTopTab = state.ui.topTab || '';

  host.classList.add('panel');
  clear(host);

  /* ───────── 工具条：搜索 + 板块筛选 ───────── */
  const search = el('input', {
    class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false',
    placeholder: '代码/名称/拼音', value: state.ui.search || '',
  });
  const sectorSel = el('select', { class: 'select', title: '板块筛选' });
  const countLab = el('span', { class: 'tr-count dim', text: '' });
  const titleLab = el('span', { class: 'tr-qtitle', text: '行情报价' });
  const tools = el('div', { class: 'tr-qtools' }, search, sectorSel);
  const hd = el('div', { class: 'panel-hd' }, titleLab, el('span', { class: 'hd-right' }, countLab));
  const wrap = el('div', { class: 'panel-bd scroll tr-qwrap' });

  /* ───────── 表头骨架 ───────── */
  const table = el('table', { class: 'tbl tr-qtable' });
  const thead = el('thead');
  const hrow = el('tr');
  const arrows = [];
  let totalW = 0;
  HEADERS.forEach((H) => {
    const sortable = !!H.k;
    const arw = sortable ? el('span', { class: 'arw', text: '' }) : null;
    const th = el('th', {
      class: (sortable ? 'sortable' : '') + (H.cls ? ' ' + H.cls : ''),
      style: { width: H.w + 'px' },
      title: sortable ? ('点击按「' + H.t + '」排序') : '自选股：点 ★ 加入 / 移出',
    }, arw ? [H.t, arw] : [H.t]);
    if (sortable) th.onclick = () => {
      const ui = state.ui;
      const same = ui.sortKey === H.k;
      const isText = H.k === 'code' || H.k === 'name';
      patchUi({ sortKey: H.k, sortDir: same ? -ui.sortDir : (isText ? 1 : -1) });
      update();
    };
    arrows.push(arw);
    totalW += H.w;
    hrow.appendChild(th);
  });
  table.style.width = (totalW + 24) + 'px';
  thead.appendChild(hrow);
  const tbody = el('tbody');
  table.appendChild(thead);
  table.appendChild(tbody);
  wrap.appendChild(table);

  /* ───────── 空态行：只在「自选为空 / 筛选无结果」时挂到 tbody ───────── */
  const emptyTd = el('td', {
    colspan: String(HEADERS.length),
    style: { textAlign: 'center', color: 'var(--text-3)', padding: '18px 8px', whiteSpace: 'normal', lineHeight: '1.6' },
  });
  const emptyTr = el('tr', { class: 'tr-qempty' }, emptyTd);

  host.appendChild(hd);
  host.appendChild(tools);
  host.appendChild(wrap);

  /* ───────── 板块模式：'watch' 只显示自选，其它值显示全市场 ───────── */
  const boardMode = () => ((state.ui.boardTab || 'quote') === 'watch' ? 'watch' : 'quote');

  /* ───────── 事件 ───────── */
  offs.push(on(search, 'input', () => {
    patchUi({ search: search.value });
    update();
  }));
  offs.push(on(sectorSel, 'change', () => {
    patchUi({ sector: sectorSel.value });
    update();
  }));
  offs.push(on(tbody, 'click', (e) => {
    const tr = e.target.closest && e.target.closest('tr[data-id]');
    if (!tr) return;
    /* ★ 列：只切自选，绝不切股（stopPropagation 防止走下面的 selectRow） */
    const star = e.target.closest && e.target.closest('td.tr-star');
    if (star) {
      e.stopPropagation();
      e.preventDefault();
      toggleWatch(tr.dataset.id);
      update();
      return;
    }
    selectRow(tr.dataset.id);
  }));

  /* ───────── 状态订阅：boardTab / topTab / 自选集合变化 → 立即重渲染 ─────────
     说明：main.js 的 ctx.onState 只在收到网络消息时触发（不跟 store 的 touch 联动），
     只靠它切板块要等下一个 tick；所以这里直接订阅 store 单例（microtask 内响应），
     ctx.onState 仍然保留作为兜底。 */
  function syncFromState() {
    const top = state.ui.topTab || '';
    const board = state.ui.boardTab || 'quote';
    /* 兼容 shim：main.js 的 TABS 把 MDI「自选股」标签写成 boardTab:'quote'
       （该文件不由本模块负责）。这里只在「刚切到该标签」的瞬间纠正为 'watch'；
       用户随后点菜单「行情报价表」只改 boardTab、topTab 不变，因此不会被误纠正。 */
    if (top === 'watch' && board === 'quote' && top !== lastTopTab) {
      lastTopTab = top;
      patchUi({ boardTab: 'watch' });   // patchUi 同步改 state，随后立刻按自选渲染
      update();
      return;
    }
    lastTopTab = top;
    if (boardMode() !== lastMode || sigOf(watchIds()) !== lastWatchSig) update();
  }

  /* 建表时就停在 MDI「自选股」标签（main.js TABS 误设 boardTab:'quote'）也一并纠正 */
  if ((state.ui.topTab || '') === 'watch' && (state.ui.boardTab || 'quote') === 'quote') {
    patchUi({ boardTab: 'watch' });
  }

  offs.push(subscribe(syncFromState));
  if (typeof ctx.onState === 'function') offs.push(ctx.onState(syncFromState));

  function selectRow(id) {
    if (!id || state.ui.stockId === id) return;
    patchUi({ stockId: id });
    update();
  }

  /* ───────── 单元格：仅内容变化时才写 DOM ───────── */
  function setCell(cell, text, cls) {
    if (cell.__t !== text) { cell.textContent = text; cell.__t = text; }
    const c = cls || '';
    if (cell.__c !== c) { cell.className = c; cell.__c = c; }
  }

  /** ★ 单元格：实心红星=已自选，空心灰星=未自选（inline 色，跟随亮/暗主题） */
  function setStar(cell, on) {
    if (cell.__star === on) return;
    cell.__star = on;
    cell.style.color = on ? 'var(--up)' : 'var(--text-3)';
    cell.title = on ? '移出自选股' : '加入自选股';
  }

  function ensureRow(id) {
    let n = nodes.get(id);
    if (n) return n;
    const tr = el('tr', { class: 'tr-qrow', dataset: { id } });
    const cells = HEADERS.map((H) => {
      const td = H.star
        ? el('td', {
            class: 'c tr-star',
            style: { cursor: 'pointer', userSelect: 'none', padding: '0' },
            title: '加入自选股',
          })
        : el('td', { class: H.cls || '' });
      tr.appendChild(td);
      return td;
    });
    n = { tr, cells };
    nodes.set(id, n);
    return n;
  }

  /* ───────── 单只股票 → 一行数据 ───────── */
  function buildRow(id) {
    const m = state.stocks.get(id) || {};
    const q = state.quotes.get(id);
    const d = derived(id);
    if (!d) return null;
    const pc = d.prevClose || d.p || 0;
    const bid = d.b && d.b[0] ? d.b[0][0] : null;
    const ask = d.s && d.s[0] ? d.s[0][0] : null;
    const amt = Number(d.a) || 0;
    const v = Number(d.v) || 0;
    const trSum = sumTr(d.tr);

    /* 会话内累计：现手/量比 基准（不造数据，只做本会话统计） */
    let acc = stats.get(id);
    if (!acc) { acc = { samples: 0, total: 0, lastP: 0, lastQ: null, lastTr: null, speed: 0, vr: null }; stats.set(id, acc); }
    if (q && acc.lastQ !== q) {
      acc.speed = acc.lastP > 0 ? (d.p / acc.lastP - 1) : 0;
      acc.lastP = d.p;
      acc.lastQ = q;
    }
    if (d.tr && acc.lastTr !== d.tr) {
      acc.lastTr = d.tr;
      acc.samples += 1;
      acc.total += trSum;
      acc.vr = acc.samples >= 8 && acc.total > 0 ? trSum / (acc.total / acc.samples) : null;
    }

    const avg = v > 0 ? amt / v : d.p;
    const floatShares = m.floatShares || (m.floatMv && d.p ? m.floatMv / d.p : 0);
    const turn = floatShares > 0 ? v / floatShares : null;
    const amp = pc ? (d.h - d.l) / pc : null;
    const bv = sumLv(d.b), sv = sumLv(d.s);
    const wb = (bv + sv) > 0 ? (bv - sv) / (bv + sv) : null;
    const pCls = signClass(d.change);
    const ztUp = d.limitUp != null ? d.limitUp : (m && m.limitUp);
    const zt = ztUp != null && d.p >= ztUp - 1e-9;
    const dt = m.limitDown != null && d.p <= m.limitDown + 1e-9;
    const name = m.name || d.name || id;
    const speed = acc.speed || 0;
    const vr = acc.vr;
    const watched = isWatched(id);

    const cells = [
      { t: watched ? '★' : '☆', c: 'c tr-star' + (watched ? ' on' : ''), star: true },
      { t: id, c: 'c code' },
      { t: name, c: 'l ellip' },
      { t: fmtPct(d.changePct), c: pCls },
      { t: fmtPrice(d.p), c: 'price ' + pCls + (zt || dt ? ' tr-bold' : '') },
      { t: signText(d.change), c: pCls },
      { t: fmtPrice(bid), c: signClass(bid != null ? bid - pc : 0) },
      { t: fmtPrice(ask), c: signClass(ask != null ? ask - pc : 0) },
      { t: fmtVol(v), c: '' },
      { t: fmtVol(trSum), c: '' },
      { t: fmtPct(speed), c: signClass(speed) },
      { t: turn == null ? '--' : fmtPct(turn, false), c: '' },
      { t: vr == null ? '--' : vr.toFixed(2), c: vr == null ? '' : signClass(vr - 1) },
      { t: amp == null ? '--' : fmtPct(amp, false), c: '' },
      { t: fmtPrice(avg), c: signClass(avg - pc) },
      { t: m.pe != null ? fmtPrice(m.pe) : '--', c: '' },
      { t: fmtPrice(d.h), c: signClass(d.h - pc) },
      { t: fmtPrice(d.l), c: signClass(d.l - pc) },
      { t: fmtPrice(d.o), c: signClass(d.o - pc) },
      { t: fmtPrice(pc), c: '' },
      { t: wb == null ? '--' : fmtPct(wb), c: signClass(wb) },
    ];

    return {
      id, cells, name, pinyin: m.pinyin || '', sector: m.sector || '',
      zt, dt, watched,
      sort: {
        code: id, name, changePct: d.changePct, p: d.p, change: d.change,
        bid: bid == null ? -1 : bid, ask: ask == null ? -1 : ask,
        v, now: trSum, speed, turn: turn == null ? -1 : turn,
        vr: vr == null ? -1 : vr, amp: amp == null ? -1 : amp, avg,
        pe: m.pe || 0, h: d.h, l: d.l, o: d.o, pc,
        wb: wb == null ? -1 : wb,
      },
    };
  }

  /* 搜索匹配：代码/名称子串，拼音按空格分词后按「词首」匹配（兼容全拼与首字母） */
  function matchQuery(r, q) {
    if (r.id.toLowerCase().indexOf(q) >= 0) return true;
    if (r.name.toLowerCase().indexOf(q) >= 0) return true;
    const py = r.pinyin.toLowerCase();
    if (!py) return false;
    const parts = py.split(/[\s,;/]+/);
    for (const t of parts) if (t && t.indexOf(q) === 0) return true;
    return py.indexOf(q) >= 0 && q.length >= 2;
  }

  /* ───────── 更新（每秒 1 次 tick 调用，代价极低） ───────── */
  function update() {
    const ui = state.ui;
    ensureWatch();
    const mode = boardMode();
    const wIds = watchIds();
    const wSet = new Set(wIds);

    /* 板块下拉：选项集合变化时才重建 */
    const sectors = ['全部'];
    for (const m of state.stocks.values()) if (m.sector && sectors.indexOf(m.sector) < 0) sectors.push(m.sector);
    const sk = sectors.join('|');
    if (sk !== sectorKey) {
      sectorKey = sk;
      clear(sectorSel);
      for (const s of sectors) sectorSel.appendChild(el('option', { value: s, text: s }));
      if (sectors.indexOf(ui.sector) < 0) ui.sector = '全部';
      sectorSel.value = ui.sector || '全部';
    }

    /* 计算行：自选模式只取自选股，其余模式取全市场；排序规则一致 */
    const q = String(ui.search || '').trim().toLowerCase();
    const sec = ui.sector || '全部';
    const rows = [];
    for (const id of state.stocks.keys()) {
      if (mode === 'watch' && !wSet.has(id)) continue;
      const r = buildRow(id);
      if (!r) continue;
      if (sec !== '全部' && r.sector !== sec) continue;
      if (q && !matchQuery(r, q)) continue;
      rows.push(r);
    }

    /* 排序 */
    const key = ui.sortKey || 'changePct';
    const dir = (ui.sortDir === 0 ? -1 : ui.sortDir) < 0 ? -1 : 1;
    const isText = key === 'code' || key === 'name';
    rows.sort((a, b) => {
      if (key === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN') * dir;
      const va = a.sort[key], vb = b.sort[key];
      if (isText) return String(va).localeCompare(String(vb)) * dir;
      const na = Number(va), nb = Number(vb);
      if (!Number.isFinite(na) && !Number.isFinite(nb)) return 0;
      if (!Number.isFinite(na)) return 1;
      if (!Number.isFinite(nb)) return -1;
      return (na - nb) * dir;
    });

    if (rows.length && emptyTr.parentNode) emptyTr.remove();

    /* 应用：复用行节点，仅改文本/类名，按顺序 appendChild 重排 */
    const seen = new Set();
    let idx = 0;
    for (const r of rows) {
      seen.add(r.id);
      const n = ensureRow(r.id);
      for (let i = 0; i < HEADERS.length; i++) {
        const c = r.cells[i];
        setCell(n.cells[i], c.t, c.c);
        if (c.star) setStar(n.cells[i], c.t === '★');
      }
      const cls = 'tr-qrow' + (state.ui.stockId === r.id ? ' sel' : '') + (r.zt ? ' zt' : r.dt ? ' dt' : '');
      if (n.tr.className !== cls) n.tr.className = cls;
      if (tbody.children[idx] !== n.tr) tbody.insertBefore(n.tr, tbody.children[idx] || null);
      idx++;
    }
    for (const [id, n] of nodes) {
      if (seen.has(id)) continue;
      n.tr.remove();
      nodes.delete(id);
      stats.delete(id);
    }

    /* 表头排序箭头（★ 列无箭头） */
    HEADERS.forEach((H, i) => {
      const arw = arrows[i];
      if (!arw) return;
      const mark = ui.sortKey === H.k ? (dir < 0 ? '▼' : '▲') : '';
      if (arw.textContent !== mark) arw.textContent = mark;
    });

    /* 空态文案 */
    if (!rows.length) {
      let msg;
      if (mode === 'watch') {
        msg = wIds.length
          ? '没有匹配的自选股（共 ' + wIds.length + ' 只自选，被搜索/板块筛选隐藏）'
          : '自选股为空：在行情列表最左侧点 ☆ 把股票加入自选';
      } else {
        msg = '没有匹配的股票：请调整搜索或板块筛选';
      }
      if (emptyTd.__t !== msg) { emptyTd.textContent = msg; emptyTd.__t = msg; }
      if (emptyTr.parentNode !== tbody) tbody.appendChild(emptyTr);
    } else if (emptyTr.parentNode) {
      emptyTr.remove();
    }

    /* 标题 + 计数：随模式与自选数量即时变化 */
    const title = mode === 'watch' ? '我的自选 ' + wIds.length + ' 只' : '行情报价';
    if (titleLab.__t !== title) { titleLab.textContent = title; titleLab.__t = title; }
    const count = mode === 'watch'
      ? '自选 ' + wIds.length + ' 只 · 显示 ' + rows.length
      : '共 ' + state.stocks.size + ' 只 · 显示 ' + rows.length;
    if (countLab.__t !== count) { countLab.textContent = count; countLab.__t = count; }

    lastMode = mode;
    lastWatchSig = sigOf(wIds);
  }

  update();
  return {
    update,
    destroy() {
      for (const off of offs) { try { off(); } catch (e) { /* ignore */ } }
      offs.length = 0;
      nodes.clear();
      stats.clear();
      clear(host);
    },
  };
}
