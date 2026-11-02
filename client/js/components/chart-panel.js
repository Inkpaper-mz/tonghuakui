/* ═══════════════════════════════════════════════════════════════════════════
   同花亏 · components/chart-panel.js —— 图表面板（工具条 + 图例 + 图表 + 右键菜单）
   ───────────────────────────────────────────────────────────────────────────
   契约（DESIGN.md §4.4，冻结）：
     createChartPanel(host, ctx) → { setStock(id), refresh(), destroy() }
   · 不发网络请求；数据全部来自 ctx.state（klines / timeshare / quotes）；
   · 通过 ctx.onState 订阅，throttle 到 ~4 帧/秒，避免抖动；
   · 画布之外的 DOM 只有本组件自有类（chart-panel / chart-toolbar / ...）。
   ═══════════════════════════════════════════════════════════════════════════ */

import { Chart } from './chart.js';
import { state, patchUi, touch } from '../store.js';
import { el, on, clear, fmtPrice, fmtNum, fmtVol, fmtPct, signClass, throttle } from '../util.js';

const TFS = [
  { v: 'timeshare', label: '分时' },
  { v: '1m', label: '1分' },
  { v: '5m', label: '5分' },
  { v: '15m', label: '15分' },
  { v: '1d', label: '日K' },
];

const TF_TEXT = { timeshare: '分时', '1m': '1分', '5m': '5分', '15m': '15分', '1d': '日K' };

export function createChartPanel(host, ctx) {
  if (!host) throw new Error('[createChartPanel] 需要一个 host 元素');
  const S = (ctx && ctx.state) || state;

  /* ── DOM 骨架 ── */
  const root = el('div', { class: 'chart-panel' });
  const toolbar = el('div', { class: 'chart-toolbar' });

  const chip = el('div', { class: 'chart-chip' });
  const titleEl = el('span', { class: 'chart-name', text: '--' });
  const codeEl = el('span', { class: 'chart-code', text: '--' });
  const tfEl = el('span', { class: 'chart-chip-tf', text: '日K' });
  chip.append(titleEl, codeEl, tfEl);

  const priceEl = el('span', { class: 'chart-price flat num', text: '--' });
  const chgEl = el('span', { class: 'chart-chg flat', text: '--' });
  const pctEl = el('span', { class: 'chart-pct flat', text: '--' });

  const quoteBox = el('div', { class: 'chart-quote' }, priceEl, chgEl, pctEl);
  const summaryBox = el('div', { class: 'chart-summary' });

  const tfBox = el('div', { class: 'chart-tfgroup' });
  const tfBtns = new Map();
  for (const tf of TFS) {
    const b = el('button', {
      type: 'button',
      class: 'chart-tf',
      text: tf.label,
      title: tf.v === 'timeshare' ? '分时图' : tf.v.toUpperCase() + ' K 线',
      dataset: { tf: tf.v },
    });
    tfBtns.set(tf.v, b);
    tfBox.appendChild(b);
  }

  const hint = el('span', { class: 'chart-hint', title: '右键切换周期与指标；K 线图可滚轮缩放、按住拖动平移、双击复位', text: '右键菜单' });
  const refreshBtn = el('button', { type: 'button', class: 'chart-ibtn', title: '刷新图表', text: '⟳' });

  toolbar.append(chip, quoteBox, summaryBox, el('div', { class: 'chart-spring' }), tfBox, refreshBtn, hint);

  const wrap = el('div', { class: 'chart-canvas-wrap' });
  const canvas = el('canvas', { class: 'chart-canvas' });
  const emptyEl = el('div', { class: 'chart-empty empty', text: '暂无行情数据' });
  wrap.append(canvas, emptyEl);

  const menuHost = el('div', { class: 'chart-ctxmenu', style: { display: 'none' } });

  root.append(toolbar, wrap, menuHost);
  host.appendChild(root);

  /* ── 摘要字段 ── */
  const SUM_FIELDS = [
    { k: 'h', label: '高' },
    { k: 'l', label: '低' },
    { k: 'o', label: '开' },
    { k: 'v', label: '量', fmt: (v) => fmtVol(v) },
    { k: 'a', label: '额', fmt: (v) => fmtNum(v, 0) },
  ];
  const sumEls = new Map();
  for (const f of SUM_FIELDS) {
    const kEl = el('span', { class: 'ck', text: f.label });
    const vEl = el('span', { class: 'cv num', text: '--' });
    summaryBox.appendChild(el('span', { class: 'cell' }, kEl, vEl));
    sumEls.set(f.k, vEl);
  }

  /* ── 状态 ── */
  const chart = new Chart(canvas);
  let destroyed = false;
  let lastKey = '';
  let lastData = '';
  let rafId = 0;
  let resizeObserver = null;

  /* ── 数据组装 ── */
  function currentId() {
    return S.ui.stockId || (S.stocks && S.stocks.size ? S.stocks.keys().next().value : null);
  }

  function buildData() {
    const id = currentId();
    if (!id) return null;
    const tf = S.ui.tf || '1d';
    const meta = S.stocks ? S.stocks.get(id) : null;
    const q = S.quotes ? S.quotes.get(id) : null;
    const title = (meta && meta.name) || (q && q.name) || id;

    if (tf === 'timeshare') {
      const ts = S.timeshare ? S.timeshare.get(id) : null;
      const points = ts && Array.isArray(ts.points) ? ts.points : [];
      const prevClose = ts && Number.isFinite(Number(ts.prevClose)) && Number(ts.prevClose) > 0
        ? Number(ts.prevClose)
        : (q && Number(q.pc)) || (meta && Number(meta.prevClose)) || 0;
      if (!points.length) return null;
      return {
        type: 'timeshare',
        title, code: id, tf,
        prevClose,
        timesharePoints: points,
        showVOL: true,
        dark: !!S.ui.dark,
        limitUp: q ? q.limitUp : undefined,
        limitDown: q ? q.limitDown : undefined,
      };
    }

    const bars = S.klines ? S.klines.get(id + ':' + tf) : null;
    if (!bars || !bars.length) return null;
    const prevClose = (q && Number(q.pc)) || (meta && Number(meta.prevClose)) || 0;
    return {
      type: 'candle',
      title, code: id, tf,
      prevClose,
      bars,
      showMA: uiFlag('showMA', true),
      showMACD: uiFlag('showMACD', true),
      showVOL: uiFlag('showVOL', true),
      dark: !!S.ui.dark,
      limitUp: q ? q.limitUp : undefined,
      limitDown: q ? q.limitDown : undefined,
    };
  }

  /** 指标开关：state.ui 存在则用之，否则默认开启；不改动别人负责的字段结构 */
  function uiFlag(name, def) {
    const ui = S.ui || {};
    return ui[name] === undefined ? def : !!ui[name];
  }

  function setFlag(name, value) {
    if (S.ui) patchUi({ [name]: value });
    else touch();
  }

  /** 结构性指纹：股票 / 周期 / 根数 / 指标开关 / 主题 —— 变化即重建数据集（视图复位） */
  function structKey() {
    const id = currentId();
    if (!id) return '';
    const tf = S.ui.tf || '1d';
    if (tf === 'timeshare') {
      const ts = S.timeshare ? S.timeshare.get(id) : null;
      const n = ts && Array.isArray(ts.points) ? ts.points.length : 0;
      return [id, tf, n, !!S.ui.dark].join('|');
    }
    const bars = S.klines ? S.klines.get(id + ':' + tf) : null;
    return [
      id, tf, bars ? bars.length : 0,
      uiFlag('showMA', true), uiFlag('showMACD', true), uiFlag('showVOL', true), !!S.ui.dark,
    ].join('|');
  }

  /** 内容指纹：只重画一帧，不重建数据集（保住缩放 / 平移状态） */
  function dataKey() {
    const id = currentId();
    if (!id) return '';
    const tf = S.ui.tf || '1d';
    const q = S.quotes ? S.quotes.get(id) : null;
    const p = q ? q.p : '';
    if (tf === 'timeshare') {
      const ts = S.timeshare ? S.timeshare.get(id) : null;
      const pts = ts && Array.isArray(ts.points) ? ts.points : [];
      const lastPt = pts.length ? pts[pts.length - 1] : null;
      return [id, 'ts', pts.length, lastPt ? lastPt[1] : '', ts && ts.prevClose, p].join('|');
    }
    const bars = S.klines ? S.klines.get(id + ':' + tf) : null;
    const lastBar = bars && bars.length ? bars[bars.length - 1] : null;
    return [id, tf, bars ? bars.length : 0, lastBar ? lastBar[4] : '', p].join('|');
  }

  /* ── 工具条渲染 ── */
  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function renderToolbar() {
    const id = currentId();
    const meta = id && S.stocks ? S.stocks.get(id) : null;
    const q = id && S.quotes ? S.quotes.get(id) : null;
    const tf = S.ui.tf || '1d';

    setText(titleEl, meta ? meta.name : (q && q.name) || (id || '--'));
    setText(codeEl, id || '--');
    setText(tfEl, TF_TEXT[tf] || tf);

    const pc = (q && Number(q.pc)) || (meta && Number(meta.prevClose)) || (q && Number(q.p)) || 0;
    const p = q && Number.isFinite(Number(q.p)) ? Number(q.p) : null;
    const has = p !== null && pc > 0;
    const chg = has ? p - pc : 0;
    const pct = has ? chg / pc : 0;

    setText(priceEl, p === null ? '--' : fmtPrice(p));
    setText(chgEl, has ? (chg > 0 ? '+' : '') + fmtPrice(chg) : '--');
    setText(pctEl, has ? fmtPct(pct) : '--');
    for (const node of [priceEl, chgEl, pctEl]) {
      node.classList.remove('up', 'down', 'flat');
      node.classList.add(has ? signClass(chg) : 'flat');
    }

    for (const f of SUM_FIELDS) {
      const node = sumEls.get(f.k);
      const v = q ? q[f.k] : undefined;
      setText(node, v === undefined || v === null ? '--' : (f.fmt ? f.fmt(v) : fmtPrice(v)));
    }

    for (const [v, btn] of tfBtns) {
      btn.classList.toggle('active', v === tf);
      btn.setAttribute('aria-pressed', v === tf ? 'true' : 'false');
    }
  }

  /* ── 刷新（取数 + 绘制）── */
  function doRefresh() {
    if (destroyed) return;
    const sk = structKey();
    if (sk !== lastKey) {
      lastKey = sk;
      lastData = '';
      chart.setData(buildData());
    } else {
      const dk = dataKey();
      if (dk !== lastData) {
        lastData = dk;
        const d = buildData();
        chart.setData(d);
        if (d) chart.render();   // 同结构下保留缩放 / 平移
      }
    }
    renderToolbar();
    if (emptyEl) emptyEl.classList.toggle('hidden', !!chart.data);
  }

  const throttledRefresh = throttle(() => { doRefresh(); }, 240);

  function schedule() {
    if (destroyed || rafId) return;
    const raf = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
    rafId = raf(() => {
      rafId = 0;
      doRefresh();
    });
  }

  /** 让下一帧强制重建数据集并重绘 */
  function invalidate() {
    lastKey = '';
    lastData = '';
    schedule();
  }

  /* ── 容器宽度降级（贴合 theme.css 的响应式约定）── */
  function applyWidth() {
    const w = host.clientWidth || 0;
    root.classList.toggle('narrow', w > 0 && w < 720);
    root.classList.toggle('tiny', w > 0 && w < 520);
  }

  /* ── 周期切换 / 右键菜单 ── */
  function setTf(tf) {
    if (!TF_TEXT[tf]) return;
    if (S.ui.tf !== tf) patchUi({ tf });
    else touch();
    invalidate();
  }

  function menuRow(label, fn, opts = {}) {
    const row = el('div', {
      class: 'cm-row' + (opts.checked ? ' chk' : '') + (opts.disabled ? ' disabled' : ''),
      text: label,
    });
    if (!opts.disabled) row.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return row;
  }

  function sep() { return el('div', { class: 'cm-sep' }); }

  function buildMenu() {
    clear(menuHost);
    const tf = S.ui.tf || '1d';
    for (const t of TFS) {
      menuHost.appendChild(menuRow(t.label + '  ' + (t.v === 'timeshare' ? '(分时图)' : 'K 线'), () => { closeMenu(); setTf(t.v); }, { checked: t.v === tf }));
    }
    menuHost.appendChild(sep());
    const isCandle = tf !== 'timeshare';
    menuHost.appendChild(menuRow('均线 MA5/10/20/60', () => {
      setFlag('showMA', !uiFlag('showMA', true));
      closeMenu();
      invalidate();
    }, { checked: uiFlag('showMA', true), disabled: !isCandle }));
    menuHost.appendChild(menuRow('MACD 副图', () => {
      setFlag('showMACD', !uiFlag('showMACD', true));
      closeMenu();
      invalidate();
    }, { checked: uiFlag('showMACD', true), disabled: !isCandle }));
    menuHost.appendChild(menuRow('成交量副图', () => {
      setFlag('showVOL', !uiFlag('showVOL', true));
      closeMenu();
      invalidate();
    }, { checked: uiFlag('showVOL', true) }));
    menuHost.appendChild(sep());
    menuHost.appendChild(menuRow('夜间模式', () => {
      const dark = !S.ui.dark;
      patchUi({ dark });
      if (typeof document !== 'undefined' && document.body) document.body.classList.toggle('dark', dark);
      closeMenu();
      invalidate();
    }, { checked: !!S.ui.dark }));
    menuHost.appendChild(menuRow('刷新数据', () => { closeMenu(); invalidate(); doRefresh(); }));
  }

  function openMenu(clientX, clientY) {
    buildMenu();
    menuHost.style.display = 'block';
    menuHost.style.visibility = 'hidden';
    const rw = menuHost.offsetWidth || 190;
    const rh = menuHost.offsetHeight || 240;
    const hostRect = host.getBoundingClientRect();
    let x = clientX - hostRect.left;
    let y = clientY - hostRect.top;
    const maxX = Math.max(4, (host.clientWidth || hostRect.width) - rw - 4);
    const maxY = Math.max(4, (host.clientHeight || hostRect.height) - rh - 4);
    x = Math.max(2, Math.min(x, maxX));
    y = Math.max(2, Math.min(y, maxY));
    menuHost.style.left = x + 'px';
    menuHost.style.top = y + 'px';
    menuHost.style.visibility = '';
  }

  function closeMenu() {
    menuHost.style.display = 'none';
  }

  /* ── 事件绑定 ── */
  const offs = [];

  offs.push(on(wrap, 'contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY);
  }));
  offs.push(on(canvas, 'contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY);
  }));
  offs.push(on(menuHost, 'contextmenu', (e) => e.preventDefault()));
  offs.push(on(document, 'mousedown', (e) => {
    if (menuHost.style.display !== 'none' && !menuHost.contains(e.target)) closeMenu();
  }));
  offs.push(on(document, 'keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
    if (e.ctrlKey || e.metaKey) return;
    const tag = e.target && e.target.tagName ? String(e.target.tagName).toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
    /* 图表快捷键统一要求 Alt/Option：
       以前 1/5/0/m/d 是「裸单键」，随手一按就把周期切了、甚至把界面切成夜间，极易误触。 */
    if (!e.altKey) return;
    switch (e.key) {
      case '1': setTf('timeshare'); break;
      case '5': setTf('5m'); break;
      case '0': setTf('1d'); break;
      case 'd': case 'D': {
        const dark = !S.ui.dark;
        patchUi({ dark });
        if (document.body) document.body.classList.toggle('dark', dark);
        try { localStorage.setItem('thk.dark', dark ? '1' : '0'); } catch (err) { /* ignore */ }
        invalidate();
        break;
      }
      case 'm': case 'M':
        if ((S.ui.tf || '1d') !== 'timeshare') {
          setFlag('showMA', !uiFlag('showMA', true));
          invalidate();
        }
        break;
      default: break;
    }
  }));
  offs.push(on(window, 'resize', () => { chart.resize(); renderToolbar(); applyWidth(); }));
  offs.push(on(window, 'blur', () => closeMenu()));

  for (const [v, btn] of tfBtns) {
    offs.push(on(btn, 'click', () => setTf(v)));
  }
  offs.push(on(refreshBtn, 'click', () => { invalidate(); doRefresh(); }));

  /* ── 订阅 ── */
  if (typeof ctx.onState === 'function') {
    const off = ctx.onState(() => {
      if (destroyed) return;
      throttledRefresh();
    });
    if (typeof off === 'function') offs.push(off);
  }

  /* ── 尺寸监听 ── */
  if (typeof ResizeObserver !== 'undefined') {
    try {
      resizeObserver = new ResizeObserver(() => { chart.resize(); renderToolbar(); applyWidth(); });
      resizeObserver.observe(wrap);
    } catch (e) { resizeObserver = null; }
  }

  /* ── 首帧 ── */
  applyWidth();
  doRefresh();
  schedule();

  return {
    /** 切换当前股票（同时同步 ui.stockId） */
    setStock(id) {
      if (destroyed || !id) return;
      if (S.ui.stockId !== id) patchUi({ stockId: id });
      else touch();
      lastKey = '';
      lastData = '';
      doRefresh();
    },
    /** 立即刷新（重新取数 + 绘制） */
    refresh() {
      if (destroyed) return;
      invalidate();
      doRefresh();
    },
    /** 可选：设定周期（'timeshare'|'1m'|'5m'|'15m'|'1d'） */
    setTf,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (rafId) {
        const caf = window.cancelAnimationFrame || clearTimeout;
        try { caf(rafId); } catch (e) { /* ignore */ }
        rafId = 0;
      }
      if (resizeObserver) {
        try { resizeObserver.disconnect(); } catch (e) { /* ignore */ }
        resizeObserver = null;
      }
      for (const off of offs) {
        try { off(); } catch (e) { /* ignore */ }
      }
      offs.length = 0;
      try { chart.destroy(); } catch (e) { /* ignore */ }
      if (root.parentNode) root.parentNode.removeChild(root);
      clear(menuHost);
    },
    /** 内部对象（调试用） */
    get chart() { return chart; },
    get el() { return root; },
  };
}

export default createChartPanel;
