/* ═══════════════════════════════════════════════════════════
   同花亏 · views/trade.js —— 交易主界面（三栏 + 底部标签表格）
   ┌ 行情列表 280 ┬ 图表 flex:1 ┬ 右栏 320 ┐
   │              │             │ 五档盘口  │
   │              │             │ 分时明细  │
   │              │             │ 下单面板  │
   ├──────────────┴─────────────┴──────────┤
   │ 底部标签表格 240：持仓/委托/成交/资金/排行/资讯 │
   └───────────────────────────────────────┘
   接口：renderTrade(ctx) → { destroy() }
   ═══════════════════════════════════════════════════════════ */
import { el, clear, on, clamp } from '../util.js';
import { patchUi } from '../store.js';
import { createQuoteList } from '../components/quote-list.js';
import { createDepth } from '../components/depth.js';
import { createOrderForm } from '../components/order-form.js';
import { createTables } from '../components/tables.js';
import { createChartPanel } from '../components/chart-panel.js';   // 图表区由他人实现，直接复用
import { createAiPanel } from '../components/ai-panel.js';         // AI 投资顾问（AI 诊股）面板

const DEF = { leftW: 320, leftMin: 200,
              rightW: 320, rightMin: 260,
              bottomH: 240, bottomMin: 120,
              minMainH: 540 };   // 三栏工作区最小高度：保证右侧五档/明细/下单可见

export function renderTrade(ctx) {
  const state = ctx.state;
  const root = ctx.root;
  clear(root);

  /* ═══════════ 骨架 ═══════════ */
  const wrap = el('div', { class: 'tr-root' });
  const main = el('div', { class: 'tr-main' });

  const left = el('div', { class: 'tr-left panel' });
  const splitLeft = el('div', { class: 'split split-v', title: '拖动调整行情列表宽度' });

  const center = el('div', { class: 'tr-center' });
  const chartHost = el('div', { class: 'tr-chart' });
  center.appendChild(chartHost);

  const splitRight = el('div', { class: 'split split-v', title: '拖动调整右侧面板宽度' });

  const right = el('div', { class: 'tr-right' });
  const depthHost = el('div', { class: 'tr-depth-host' });
  const formHost = el('div', { class: 'tr-form-host' });
  right.appendChild(depthHost);
  right.appendChild(formHost);

  main.appendChild(left);
  main.appendChild(splitLeft);
  main.appendChild(center);
  main.appendChild(splitRight);
  main.appendChild(right);

  const splitBottom = el('div', { class: 'split split-h', title: '拖动调整底部表格高度' });
  const bottom = el('div', { class: 'tr-bottom panel' });

  wrap.appendChild(main);
  wrap.appendChild(splitBottom);
  wrap.appendChild(bottom);
  root.appendChild(wrap);

  /* ═══════════ 尺寸（记住用户拖过的值；窗口变小时自适应） ═══════════ */
  const ui = state.ui;
  let leftW = DEF.leftW, rightW = DEF.rightW, bottomH = DEF.bottomH;

  function toggleBottomCollapsed(v) {
    ui.bottomCollapsed = !!v;
    bottom.classList.toggle('collapsed', ui.bottomCollapsed);
  }

  /** 统一套用尺寸：三栏区至少留 MIN_MAIN_H 高，保证五档+明细+下单可见 */
  function applyLayout() {
    const vw = root.clientWidth || 1200;
    const vh = root.clientHeight || 700;
    /* 「AI 诊股」页内容高：它需要更大的底部区域，主工作区最少留 260（其它页仍留 minMainH） */
    const keepMain = (state.ui.bottomTab === 'ai') ? Math.min(260, DEF.minMainH) : DEF.minMainH;
    rightW = Math.round(clamp(Number(ui.rightW) || DEF.rightW, DEF.rightMin,
      Math.max(DEF.rightMin, vw - DEF.leftMin - 300)));
    leftW = Math.round(clamp(Number(ui.leftW) || DEF.leftW, DEF.leftMin,
      Math.max(DEF.leftMin, vw - rightW - 300)));
    bottomH = Math.round(clamp(Number(ui.bottomH) || DEF.bottomH, DEF.bottomMin,
      Math.max(DEF.bottomMin, vh - keepMain)));
    left.style.width = leftW + 'px';
    right.style.width = rightW + 'px';
    bottom.style.height = (ui.bottomCollapsed ? 24 : bottomH) + 'px';
    if (chart && typeof chart.refresh === 'function') {
      try { chart.refresh(); } catch (e) { /* 图表刷新失败不影响布局 */ }
    }
  }

  /** 「AI 诊股」页需要的底部高度：min(460, 视口高 - 260)，不超过拖动上限 */
  function aiBottomWant() {
    const vh = window.innerHeight || root.clientHeight || 700;
    const max = Math.max(DEF.bottomMin, Math.min(vh - 260, (root.clientHeight || 700) - 200));
    return Math.round(clamp(Math.min(460, vh - 260), DEF.bottomMin, max));
  }

  /* ═══════════ 可拖拽分隔条 ═══════════ */
  function makeSplit(handle, opts) {
    let dragging = false, startPos = 0, startSize = 0;
    const offs = [];
    const down = (e) => {
      if (e.button !== 0) return;
      if (opts.before) opts.before();
      dragging = true;
      startPos = opts.axis === 'x' ? e.clientX : e.clientY;
      startSize = opts.get();
      handle.classList.add('dragging');
      document.body.style.cursor = opts.axis === 'x' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    };
    const move = (e) => {
      if (!dragging) return;
      const cur = opts.axis === 'x' ? e.clientX : e.clientY;
      const delta = (cur - startPos) * (opts.invert ? -1 : 1);
      const max = Math.max(opts.min + 20, opts.max());
      opts.set(Math.round(clamp(startSize + delta, opts.min, max)));
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (opts.after) opts.after();
    };
    offs.push(on(handle, 'pointerdown', down));
    offs.push(on(window, 'pointermove', move));
    offs.push(on(window, 'pointerup', up));
    offs.push(on(window, 'pointercancel', up));
    return { offs };
  }

  const splits = [
    /* 左栏宽度 */
    makeSplit(splitLeft, {
      axis: 'x', invert: false, min: DEF.leftMin,
      get: () => left.offsetWidth || leftW,
      set: (w) => { leftW = w; left.style.width = w + 'px'; ui.leftW = w; },
      max: () => (root.clientWidth || 1200) - right.offsetWidth - 260,
      after: () => { if (chart && chart.refresh) chart.refresh(); },
    }),
    /* 右栏宽度（分隔条右侧，向内拖 = 变宽） */
    makeSplit(splitRight, {
      axis: 'x', invert: true, min: DEF.rightMin,
      get: () => right.offsetWidth || rightW,
      set: (w) => { rightW = w; right.style.width = w + 'px'; ui.rightW = w; },
      max: () => (root.clientWidth || 1200) - left.offsetWidth - 320,
      after: () => { if (chart && chart.refresh) chart.refresh(); },
    }),
    /* 底部表格高度（向上拖 = 变高） */
    makeSplit(splitBottom, {
      axis: 'y', invert: true, min: DEF.bottomMin,
      get: () => bottom.offsetHeight || bottomH,
      set: (h) => { bottomH = h; bottom.style.height = h + 'px'; ui.bottomH = h; },
      max: () => (root.clientHeight || 700) - 200,
      before: () => { if (ui.bottomCollapsed) toggleBottomCollapsed(false); },
      after: () => { if (chart && chart.refresh) chart.refresh(); },
    }),
  ];

  /* ═══════════ 组件装配 ═══════════ */
  let chart = null;
  try {
    if (typeof createChartPanel === 'function') chart = createChartPanel(chartHost, ctx);
  } catch (e) {
    console.error('[trade] 图表区初始化失败', e);
  }

  const quoteList = createQuoteList(left, ctx);
  const depth = createDepth(depthHost, ctx);
  const orderForm = createOrderForm(formHost, ctx);
  const tables = createTables(bottom, ctx);

  /* ── 底部标签栏追加「AI 诊股」页 ──
     tables.js 不改动：这里往它的标签条里插一个 tab、往它的 pane 容器里插一个 pane，
     切换时把表格的 pane 藏起来即可（刷新顺序保证：先 tables.update() 再 syncAiTab()）。 */
  const bdEl = bottom.querySelector('.panel-bd');
  const tabWrap = bottom.querySelector('.tr-tabs');
  const sumLab = bottom.querySelector('.panel-hd .hd-right > span');
  const aiPane = el('div', { class: 'tr-pane ai-pane hidden' });
  const aiPanel = createAiPanel(aiPane, ctx);
  if (bdEl) bdEl.appendChild(aiPane);
  const aiTab = el('div', { class: 'tr-tab', text: 'AI 诊股', title: 'AI 投资顾问：个股诊断 + 大盘观点' });
  if (tabWrap) tabWrap.appendChild(aiTab);
  let aiOpen = false;
  aiTab.onclick = () => patchUi({ bottomTab: 'ai' });

  /** AI 页与表格页互斥显示；每次切入 AI 页时把底部面板抬高到够看（不每帧改） */
  function syncAiTab() {
    const on = state.ui.bottomTab === 'ai';
    aiPane.classList.toggle('hidden', !on);
    aiTab.classList.toggle('active', on);
    if (on) {
      if (bdEl) {
        for (const p of Array.from(bdEl.children)) {
          if (p !== aiPane && p.classList && p.classList.contains('tr-pane')) p.classList.add('hidden');
        }
      }
      if (sumLab) sumLab.textContent = 'AI 投资顾问 · 服务端权威诊断（个股 + 大盘）';
      /* 只在「切入这一下」判断：底部还不到一屏就先抬高一次；用户拖过的更大尺寸不动 */
      if (!aiOpen && !ui.bottomCollapsed && bottomH < 380) {
        const want = aiBottomWant();
        if (want > bottomH) { bottomH = want; ui.bottomH = want; bottom.style.height = want + 'px'; }
      }
    }
    aiOpen = on;
  }

  const comps = [quoteList, depth, orderForm, tables];
  /* 标签点击要立即生效：否则要等到下一个 tick（1s）才切页，期间两个 pane 会同时显示 */
  const offTabClick = tabWrap
    ? on(tabWrap, 'click', () => { aiPanel.update(); syncAiTab(); })
    : (() => {});

  /* ═══════════ 状态刷新（每秒 1 次 tick；只做局部更新） ═══════════ */
  let lastStock = null;
  let chartErr = false;
  function refresh() {
    /* 自愈：行情到位后若仍未选股（或选中了已不存在的股票），自动选中第一只 */
    if ((!state.ui.stockId || !state.stocks.has(state.ui.stockId)) && state.stocks.size) {
      patchUi({ stockId: state.stocks.keys().next().value });
    }
    quoteList.update();
    depth.update();
    orderForm.update();
    tables.update();
    aiPanel.update();
    syncAiTab();
    const id = state.ui.stockId;
    if (chart) {
      try {
        if (id !== lastStock) {
          lastStock = id;
          if (typeof chart.setStock === 'function') chart.setStock(id);
        }
        if (typeof chart.refresh === 'function') chart.refresh();
      } catch (e) {
        if (!chartErr) { chartErr = true; console.error('[trade] 图表刷新失败', e); }
      }
    }
  }

  const offState = typeof ctx.onState === 'function' ? ctx.onState(refresh) : (() => {});
  const offAck = typeof ctx.on === 'function'
    ? ctx.on('order:ack', (msg) => {
      if (!msg) return;
      const ok = !!msg.ok;
      ctx.toast(msg.msg || (ok ? '委托已受理' : '委托失败'), ok ? 'success' : 'error');
    })
    : (() => {});
  const offResize = on(window, 'resize', applyLayout);

  applyLayout();
  refresh();

  /* ═══════════ 销毁 ═══════════ */
  return {
    destroy() {
      try { offResize(); } catch (e) { /* ignore */ }
      try { offState(); } catch (e) { /* ignore */ }
      try { offAck(); } catch (e) { /* ignore */ }
      try { offTabClick(); } catch (e) { /* ignore */ }
      for (const s of splits) {
        for (const off of s.offs) { try { off(); } catch (e) { /* ignore */ } }
        s.offs.length = 0;
      }
      if (chart && typeof chart.destroy === 'function') {
        try { chart.destroy(); } catch (e) { console.error('[trade] 图表销毁失败', e); }
      }
      try { aiPanel.destroy(); } catch (e) { /* ignore */ }
      for (const c of comps) {
        try { c.destroy(); } catch (e) { /* ignore */ }
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      clear(root);
    },
  };
}
