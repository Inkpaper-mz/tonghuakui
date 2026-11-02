/* ═══════════════════════════════════════════════════════════════
   同花亏 · main.js —— 应用引导 / 路由 / 外壳行为 / 协议分发
   ═══════════════════════════════════════════════════════════════ */

import { state, setState, patchUi, touch, stockList, activeStock } from './store.js';
import { $, $$, el, clear, fmtMoney, fmtPct, fmtNum, fmtTime, fmtPrice, signClass, confirmBox, infoBox, escapeHtml, throttle, uid } from './util.js';
import { createToast } from './components/toast.js';

/* ───────── 0. 运行参数（?mock=1&real=1&view=trade&auto=1&nick=xxx）───────── */
const Q = new URLSearchParams(location.search);
const FORCE_REAL = Q.get('real') === '1';
const FORCE_MOCK = Q.get('mock') === '1';
const BOOT_VIEW = Q.get('view') || null;
const AUTO = Q.get('auto') === '1';
const NICK = Q.get('nick') || '韭菜甲';

state.source = FORCE_MOCK ? 'mock' : 'real';

/* ───────── 1. 数据源 ─────────
   默认连"本机真实服务端"（多人对战）；若 2.5 秒内连不上（例如只把 client/
   用静态服务器托管起来预览 UI），自动降级为内置演示数据。
   URL 参数： ?real=1 强制真实   ?mock=1 强制演示                        */
let net = null;
let netReady = false;

async function createReal() {
  const { NetClient } = await import('./net.js');
  return new NetClient();
}
async function createMock() {
  const { MockNet } = await import('./mock.js');
  return new MockNet(state, { nick: NICK, auto: AUTO, bootView: BOOT_VIEW });
}
/** 挂载数据源：重挂订阅 → 建立连接 */
function adopt(impl, source) {
  net = impl;
  if (ctx) ctx.net = impl;
  state.source = source;
  netReady = false;
  wire();
  net.connect(location.origin.replace(/^http/, 'ws') + '/ws');
}
/** 等待服务端握手（welcome）；超时返回 false */
function waitWelcome(ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); off(); resolve(v); };
    const off = net.on('welcome', () => finish(true));
    const timer = setTimeout(() => finish(false), ms);
  });
}

/* ───────── 2. 全局上下文 ctx（DESIGN.md §4.1）───────── */
const toast = createToast($('#toast-host'));

/* ───────── 原生外壳桥（在 macOS .app 内运行时，把窗口按钮接到真窗口）───────── */
const NativeUI = (() => {
  const h = (typeof window !== 'undefined' && window.webkit &&
             window.webkit.messageHandlers && window.webkit.messageHandlers.ths) || null;
  return {
    available: !!h,
    post(action, extra) {
      try { h.postMessage(Object.assign({ action }, extra || {})); return true; }
      catch (e) { return false; }
    },
  };
})();

/* ───────── 平台识别：macOS 下换成原生观感与 ⌘ 系快捷键 ───────── */
const PLATFORM = (() => {
  const ua = (navigator.userAgent || '') + ' ' + (navigator.platform || '');
  const mac = /Mac|iPhone|iPad|iPod/.test(ua);
  const nativeShell = NativeUI.available;            // 跑在 .app 里
  if (mac) document.body.classList.add('mac');
  if (nativeShell) document.body.classList.add('app-mac');
  if (/Windows/.test(ua)) document.body.classList.add('win');
  /* 启动时恢复夜间模式（token 在 store 里已从 localStorage 读回） */
  try { if (state.ui && state.ui.dark) document.body.classList.add('dark'); } catch (e) { /* ignore */ }
  return { mac, nativeShell };
})();

/* Mac 上把菜单里的 Ctrl/Alt 快捷键提示换成 ⌘ 系，避免"A 键提示却按不出来" */
const MAC_KEYS = {
  'Ctrl+L': '⌘L', 'Ctrl+D': '⌘D', 'Ctrl+Shift+C': '⇧⌘C', 'Ctrl+K': '⌘K',
  'Ctrl+R': '⌘R', 'F11': '⌃⌘F', 'Alt+F4': '⌘Q',
};
function localizeKeys() {
  if (!PLATFORM.mac) return;
  for (const k of $$('#menubar .mi .k')) {
    const t = (k.textContent || '').trim();
    if (MAC_KEYS[t]) k.textContent = MAC_KEYS[t];
  }
}

/* 在 .app 内：网页顶栏即窗口标题栏 —— 按住顶栏空白处可拖动整个窗口 */
function wireTitlebarDrag() {
  if (!NativeUI.available) return;
  const tb = $('#titlebar');
  if (!tb) return;
  let dragging = false, lx = 0, ly = 0;
  tb.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.menu-item, button, input, a, .win-btns, .gsearch')) return;
    dragging = true; lx = e.screenX; ly = e.screenY;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - lx, dy = e.screenY - ly;
    lx = e.screenX; ly = e.screenY;
    if (dx || dy) NativeUI.post('drag', { dx, dy });
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('blur', () => { dragging = false; });
  tb.addEventListener('dblclick', (e) => {
    if (e.target.closest('.menu-item, button, input, a')) return;
    NativeUI.post('maximize');
  });
}

/* 在 .app 内运行时，把布局尺寸打到应用日志（真机排查 UI 问题用） */
function dumpLayoutDiag(tag) {
  try {
    const r = (sel) => {
      const n = $(sel);
      if (!n) return sel + '=缺失';
      const b = n.getBoundingClientRect();
      return sel + '=' + Math.round(b.width) + 'x' + Math.round(b.height) +
             '@(' + Math.round(b.left) + ',' + Math.round(b.top) + ')';
    };
    const cs = getComputedStyle(document.body);
    const vc = document.querySelector('#view') && document.querySelector('#view').firstElementChild;
    const vcs = vc ? getComputedStyle(vc) : null;
    const hitTitle = document.elementFromPoint(200, 10);
    const hitBrand = document.elementFromPoint(30, 16);
    const win = document.querySelector('.v-login-win');
    console.log('[diag3:' + tag + '] scrollY=' + window.scrollY +
      ' 命中(200,10)=' + (hitTitle ? hitTitle.tagName + '.' + (hitTitle.className || '') : 'null') +
      ' 命中(30,16)=' + (hitBrand ? hitBrand.tagName + '.' + (hitBrand.className || '') : 'null') +
      ' v-login-win=' + (win ? JSON.stringify(win.getBoundingClientRect().toJSON()) : '无') +
      ' v-login=' + JSON.stringify(($('.v-login') || {getBoundingClientRect:null}).getBoundingClientRect ? $('.v-login').getBoundingClientRect().toJSON() : null) +
      ' titlebarInnerText="' + (($('#titlebar') && $('#titlebar').innerText) || '').replace(/\n/g, ' ').slice(0, 60) + '"');
    console.log('[diag2:' + tag + '] menubar=' + r('#menubar') + ' brand=' + r('.brand') +
      ' search=' + r('#global-search') + ' view=' + r('#view') +
      ' | 视图根=' + (vc ? vc.className : '无') + ' rect=' + (vc ? JSON.stringify(vc.getBoundingClientRect().toJSON()) : '-') +
      ' pos=' + (vcs ? vcs.position : '-') + ' z=' + (vcs ? vcs.zIndex : '-') +
      ' | titlebarZ=' + getComputedStyle($('#titlebar')).zIndex +
      ' menubarVisible=' + (($('#menubar') && $('#menubar').offsetParent !== null)));
    console.log('[diag:' + tag + '] viewport=' + window.innerWidth + 'x' + window.innerHeight +
      ' dpr=' + window.devicePixelRatio +
      ' bodyClass="' + document.body.className + '"' +
      ' | ' + r('#titlebar') + ' ' + r('#toolbar') + ' ' + r('#tabstrip') + ' ' + r('#workspace') +
      ' | titlebarDisplay=' + (($('#titlebar') && getComputedStyle($('#titlebar')).display) || '?') +
      ' titlebarH=' + (($('#titlebar') && getComputedStyle($('#titlebar')).height) || '?') +
      ' appOverflow=' + cs.overflow);
  } catch (e) { console.log('[diag] 失败 ' + (e && e.message)); }
}

/* ───────── 菜单勾选状态（让每个开关类菜单项反映当前状态）───────── */
function applyMenuState() {
  const set = (cmd, on) => {
    for (const mi of $$('#menubar .mi[data-cmd="' + cmd + '"]')) mi.classList.toggle('checked', !!on);
  };
  set('theme', state.ui.dark);
  set('toggle:confirm', state.ui.confirmOrder !== false);
  set('ind:ma', state.ui.showMA !== false);
  set('ind:macd', state.ui.showMACD !== false);
  set('ind:vol', state.ui.showVOL !== false);
  for (const tf of ['timeshare', '1m', '5m', '15m', '1d']) set('tf:' + tf, state.ui.tf === tf);
  for (const k of ['changePct', 'v', 'turn', 'speed', 'vr', 'code']) set('sort:' + k, state.ui.sortKey === k);
  for (const t of ['quote', 'watch']) set('tab:' + t, (state.ui.boardTab || 'quote') === t);
  for (const t of ['positions', 'orders', 'trades', 'cash', 'rank', 'news', 'ai']) set('tab:' + t, state.ui.bottomTab === t);
}

/* ── 真实服务端模式：按需拉 K 线 + 本地拼分时（Mock 模式由 mock.js 直接提供）── */
let _klineKey = '';
let _klineTick = 0;
let _lastVClock = '';
const _lastVol = new Map();

function requestActiveKline(force = false) {
  if (state.source !== 'real' || !state.match) return;
  const id = state.ui.stockId;
  if (!id) return;
  const tf = state.ui.tf === 'timeshare' ? '1m' : state.ui.tf;
  const key = id + ':' + tf;
  if (!force && key === _klineKey) return;
  _klineKey = key;
  _klineTick = 0;
  net.send('kline:get', { stockId: id, tf });
}

function buildTimeshare(id, bars) {
  const meta = state.stocks.get(id) || {};
  const q = state.quotes.get(id);
  const prevClose = (q && q.pc) || meta.prevClose || (bars.length ? bars[0][4] : 0);
  let cumV = 0, cumA = 0;
  const points = [];
  for (const b of bars) {
    const t = b[0], c = b[4], v = b[5] || 0;
    cumV += v; cumA += v * c;
    points.push([t, c, cumV > 0 ? Math.round((cumA / cumV) * 100) / 100 : c, v]);
  }
  state.timeshare.set(id, { prevClose, points });
}

function appendTimeshare(m) {
  if (state.source !== 'real') return;
  if (_lastVClock && m.vclock && m.vclock < _lastVClock) {   // 虚拟日切换 → 分时图重开
    for (const [id, ts] of state.timeshare) state.timeshare.set(id, { prevClose: ts.prevClose, points: [] });
    _lastVol.clear();
    _lastKlineKey = '';
    requestActiveKline(true);
  }
  if (m.vclock) _lastVClock = m.vclock;
  for (const q of (m.quotes || [])) {
    let ts = state.timeshare.get(q.i);
    if (!ts) { ts = { prevClose: q.pc, points: [] }; state.timeshare.set(q.i, ts); }
    const prev = _lastVol.get(q.i) || 0;
    const dv = Math.max(0, (q.v || 0) - prev);
    _lastVol.set(q.i, q.v || 0);
    ts.points.push([m.vtime, q.p, q.avg || q.p, dv]);
    if (ts.points.length > 300) ts.points.splice(0, ts.points.length - 300);
  }
  _klineTick += 1;
  if (_klineTick % 60 === 0) requestActiveKline(true);
}

const ctx = {
  net: null,          // 由 adopt() 注入
  state,
  root: $('#view'),
  go,
  toast: (msg, level = 'info') => toast.show(msg, level),
  on: (type, fn) => net.on(type, fn),
  onState: (fn) => subscribeState(fn),
};

/* ───────── 3. 视图路由 ───────── */
const VIEW_LOADERS = {
  login: () => import('./views/login.js').then(m => m.renderLogin),
  lobby: () => import('./views/lobby.js').then(m => m.renderLobby),
  trade: () => import('./views/trade.js').then(m => m.renderTrade),
  result: () => import('./views/result.js').then(m => m.renderResult),
};

let currentView = null;
let currentHandle = null;
let viewToken = 0;

async function go(view, params = {}) {
  if (!VIEW_LOADERS[view]) view = 'trade';
  if (currentView === view && !params.force) { syncChrome(); return; }
  const token = ++viewToken;

  if (currentHandle && typeof currentHandle.destroy === 'function') {
    try { currentHandle.destroy(); } catch (e) { console.error(e); }
  }
  currentHandle = null;
  currentView = view;
  state.view = view;
  document.body.dataset.view = view;

  const root = ctx.root;
  root.style.overflow = view === 'trade' || view === 'lobby' ? 'hidden' : 'auto';
  clear(root);

  try {
    const loader = await VIEW_LOADERS[view]();
    if (token !== viewToken) return;          // 期间又切走了
    const handle = await loader(ctx, params);
    if (token !== viewToken) { if (handle && handle.destroy) handle.destroy(); return; }
    currentHandle = handle || null;
  } catch (e) {
    console.error('[main] 视图加载失败:', view, e);
    if (token !== viewToken) return;
    const stack = String((e && e.stack) || '').split('\n').slice(0, 6).join('\n');
    root.appendChild(el('div', { class: 'empty', html:
      `<div class="ico">⚠️</div><div>视图 <b>${escapeHtml(view)}</b> 加载失败</div>
       <div class="dim">${escapeHtml(String(e && e.message || e))}</div>
       <pre class="dim" style="font-size:11px;text-align:left;max-width:760px;white-space:pre-wrap;margin:6px 0">${escapeHtml(stack)}</pre>` }));
  }
  syncChrome();
  renderTabs();
}

/* ───────── 4. 状态订阅分发 ───────── */
const stateSubs = new Set();
function subscribeState(fn) { stateSubs.add(fn); return () => stateSubs.delete(fn); }

const notifyViews = throttle(() => {
  for (const fn of Array.from(stateSubs)) {
    try { fn(state); } catch (e) { console.error('[main] onState 回调异常', e); }
  }
  syncStatusBar();
}, 60);

/* ───────── 5. 协议分发 ───────── */

/** 统一订阅：单条消息的处理异常只记日志，绝不冒泡打断 UI */
function onMsg(type, fn) {
  return net.on(type, (m) => {
    try { fn(m); } catch (e) { console.error('[main] 处理 ' + type + ' 消息失败:', e); }
  });
}

function wire() {
  onMsg('welcome', (m) => {
    setState({ connected: true, online: m.online || 0, serverTime: m.serverTime, latency: 0 });
    setConn(true);
  });

  onMsg('login_ok', (m) => {
    setState({ player: m.player, token: m.token, config: m.config, serverTime: m.serverTime });
    toast.show(`欢迎回来，${m.player.nick}（${m.player.tier} ${m.player.elo}）`, 'success');
    if (currentView === 'login' || !currentView) go('lobby');
    net.send('lobby:list');
    /* 「游客快速体验（AI 演示）」必须在这里补发 room:quick：
       登录视图自己注册的 login_ok 会在 go('lobby') 的同步 destroy() 里被移除，
       根本轮不到执行（这就是以前那个按钮点了没反应的原因）。 */
    if (state.ui.guestDemo) {
      patchUi({ guestDemo: false });
      net.send('room:quick', { mode: 'ffa', durationSec: 900, startCash: 1000000, maxPlayers: 8, fillBots: true });
      toast.show('已为你开启 AI 演示对局，倒计时后开盘', 'info');
    }
    syncStatusBar();
  });

  onMsg('lobby:rooms', (m) => { state.lobby.rooms = m.rooms || []; touch(); });

  onMsg('room:joined', (m) => { setState({ room: m.room }); touch(); });

  onMsg('room:update', (m) => {
    setState({ room: m.room });
    if (m.room && m.room.status === 'playing' && currentView !== 'trade') go('trade');
    if (m.room && m.room.status === 'countdown' && currentView === 'lobby') {
      toast.show(`对局将在 ${m.room.countdown} 秒后开始…`, 'warn');
    }
    renderTabs();
  });

  onMsg('room:left', () => {
    setState({ room: null });
    state.marketState = blankMarketState();
    MarketBreak.hide();
    go('lobby');
  });

  onMsg('game:start', (m) => {
    state.stocks = new Map();
    for (const s of (m.stocks || [])) state.stocks.set(s.id, s);
    state.quotes = new Map();
    state.klines = new Map();
    state.timeshare = new Map();
    state.news = [];
    state.rank = [];
    state.result = null;
    /* 新节奏参数（服务端 game:start.match 里带 virtualDayTicks / tickMs）：
       分时图按 virtualDayTicks 格映射横轴，缺省时 chart.js 用 TS_SLOTS = 120 */
    const mm = m.match || {};
    const cfg = Object.assign({}, state.config || {});
    if (Number(mm.virtualDayTicks) > 0) cfg.virtualDayTicks = Math.round(Number(mm.virtualDayTicks));
    if (Number(mm.tickMs) > 0) cfg.tickMs = Math.round(Number(mm.tickMs));
    state.config = cfg;
    state.marketState = blankMarketState();
    MarketBreak.hide();
    setState({ match: m.match });
    if (!state.ui.stockId || !state.stocks.has(state.ui.stockId)) {
      state.ui.stockId = state.stocks.keys().next().value || null;
    }
    if (state.ui.tf === '1d' && state.match) state.ui.tf = '1d';
    state.ui.topTab = 'trade';
    toast.show('开盘了！祝你好运 🍀', 'success');
    _klineKey = ''; _lastVol.clear(); _lastVClock = '';
    go('trade', { force: true });
    requestActiveKline(true);
    syncStatusBar();
  });

  /* 午间休市 / 暂停（新时间模型，见 §6.5） */
  onMsg('break', onBreakMsg);

  onMsg('tick', (m) => {
    for (const q of (m.quotes || [])) {
      state.quotes.set(q.i, q);
      /* ⚠️ 虚拟日切后涨跌停会按新昨收重算，必须同步回 stocks 元数据：
         否则行情列表、K 线限价线、下单校验全都用着开局那天的旧涨跌停，
         价格涨过旧涨停后会出现「看着超过涨停还在涨」＋「委托被本地误判拒单」。 */
      const meta = state.stocks.get(q.i);
      if (meta) {
        if (q.limitUp != null && meta.limitUp !== q.limitUp) meta.limitUp = q.limitUp;
        if (q.limitDown != null && meta.limitDown !== q.limitDown) meta.limitDown = q.limitDown;
        if (q.pc != null && meta.prevClose !== q.pc) meta.prevClose = q.pc;
      }
    }
    state.indices = m.idx || state.indices;
    /* 虚拟交易日序号：tick 不带 dayIndex，靠 vclock 回退判断日切
       （新节奏下 11:30 收盘 → 下一天 09:30 开盘，字符串比较即可） */
    const ms = marketStateOf();
    if (m.vclock && _lastVClock && m.vclock < _lastVClock) {
      ms.dayIndex = (Number(ms.dayIndex) || 0) + 1;
      ms.rolledOver = true;
      ms.break.dayIndex = ms.dayIndex;
    }
    state.vclock = m.vclock || state.vclock;
    state.serverTime = m.serverTime || state.serverTime;
    appendTimeshare(m);
    /* appendTimeshare 只在真实模式下维护 _lastVClock（Mock 模式提前 return），
       这里统一兜底，保证演示模式也能识别日切、给状态栏正确的「第 N 日」 */
    if (m.vclock) _lastVClock = m.vclock;
    notifyViews();
  });

  onMsg('account', (m) => { state.account = m; notifyViews(); });

  onMsg('rank', (m) => { state.rank = m.list || []; if (m.vclock) state.vclock = m.vclock; notifyViews(); });

  onMsg('news', (m) => {
    if (!m.news) return;
    state.news.unshift(m.news);
    if (state.news.length > 50) state.news.length = 50;
    if (m.news.level === 'hot') toast.show(m.news.title, 'warn');
    notifyViews();
  });

  onMsg('kline', (m) => {
    state.klines.set(`${m.i}:${m.tf}`, m.bars || []);
    if (m.tf === '1m') buildTimeshare(m.i, m.bars || []);
    notifyViews();
  });

  onMsg('chat', (m) => {
    if (!m || typeof m !== 'object' || typeof m.text !== 'string') return;
    // MockNet 会同时写入 state.chat，这里按引用去重，保证只有一份
    if (!state.chat.includes(m)) state.chat.push(m);
    if (state.chat.length > 200) state.chat.shift();
    notifyViews();
  });

  onMsg('player:event', (m) => {
    if (m.action === 'join') toast.show(`${m.player && m.player.nick} 加入了房间`, 'info');
    else if (m.action === 'leave') toast.show(`${m.player && m.player.nick} 离开了房间`, 'info');
  });

  onMsg('order:ack', (m) => {
    if (!m) return;
    if (m.ok) toast.show(m.msg || '委托已提交', 'success');
    else toast.show(m.msg || '委托被拒绝', 'error');
    if (m.ok && m.orderId) flashOrder(m.orderId);
  });

  onMsg('toast', (m) => toast.show(m.msg, m.level || 'info'));

  onMsg('error', (m) => toast.show(m.msg || '服务端错误', 'error'));

  onMsg('game:over', (m) => {
    setState({ result: m });
    state.ui.topTab = 'result';
    state.marketState = blankMarketState();
    MarketBreak.hide();
    toast.show('本局结束，正在结算…', 'info');
    go('result');
  });

  onMsg('pong', (m) => {
    state.latency = Math.max(0, Date.now() - (m.ts || Date.now()));
    state.serverTime = m.serverTime || state.serverTime;
  });

  net.addEventListener?.('close', () => setConn(false));
}

/** 外壳（工具栏/标签栏/状态栏）统一刷新 */
function syncChrome() {
  syncToolbar();
  renderTabs();
  syncStatusBar();
  applyMenuState();
}

function flashOrder(orderId) {
  const row = document.querySelector(`[data-order-id="${orderId}"]`);
  if (row) { row.classList.add('flash-up'); setTimeout(() => row.classList.remove('flash-up'), 700); }
}

function setConn(ok) {
  state.connected = ok;
  try {
    const dot = $('#conn-dot'), txt = $('#conn-text');
    if (dot) dot.className = 'dot ' + (ok ? 'dot-green' : 'dot-red');
    if (txt) txt.textContent = ok ? '已连接' : '连接断开';
    const sv = $('#sb-server');
    if (sv) sv.textContent = (state.source === 'real') ? (location.host || '127.0.0.1:8899') : '本地演示数据 (Mock)';
  } catch (e) { console.error('[main] setConn 失败', e); }
}

/* ───────── 6. 状态栏 ───────── */
function syncStatusBar() {
  // 指数
  const bar = $('#idx-bar');
  if (state.indices && state.indices.length) {
    const html = state.indices.map(ix => {
      const cls = signClass(ix.pct);
      return `<span class="idx"><span class="n">${escapeHtml(ix.n)}</span>
        <span class="v ${cls}">${fmtNum(ix.v, 2)}</span>
        <span class="${cls}">${fmtPct(ix.pct)}</span></span>`;
    }).join('');
    if (bar.dataset.sig !== html) { bar.innerHTML = html; bar.dataset.sig = html; }
  } else if (!bar.dataset.empty) {
    bar.innerHTML = '<span class="dim">等待行情…</span>'; bar.dataset.empty = '1';
  }

  // 延迟 / 在线
  $('#latency').textContent = state.latency ? state.latency : '--';
  $('#online').textContent = state.online || 0;

  // 虚拟交易日 / 盘中 / 午间休市 / 已暂停
  const clock = $('#clock');
  if (clock) {
    const txt = marketClockText();
    if (clock.textContent !== txt) clock.textContent = txt;
  }

  // 玩家
  const me = $('#me-badge');
  if (state.player) {
    const acc = state.account;
    const assets = acc ? acc.totalAssets : state.match ? state.match.startCash : null;
    const pnlPct = acc ? acc.pnlPct : null;
    me.innerHTML = `${escapeHtml(state.player.nick)}<span class="tag" style="margin-left:6px">${escapeHtml(state.player.tier)}</span>` +
      (assets !== null ? ` <b class="${acc ? signClass(acc.pnl) : ''}" style="margin-left:8px">${fmtMoney(assets)}</b>` : '') +
      (pnlPct !== null ? ` <span class="${signClass(pnlPct)}">${fmtPct(pnlPct)}</span>` : '');
  } else {
    me.textContent = '未登录';
  }
}

/* ───────── 6.5 午间休市 / 暂停遮罩 ─────────
   新时间模型：1 个虚拟交易日 = 上午盘 09:30-11:30（120 虚拟分钟），
   每个交易日结束后进入 BREAK_SEC 秒「午间休市」，期间行情冻结、下一天 09:30 开盘；
   运维控制台还可以把整局暂停（paused）。
   遮罩是纯视觉层：pointer-events:none → 不拦截股票列表的悬停/挂单点击，
   只有中间那张卡片可交互；底部留出状态栏高度，状态栏始终可见。 */
const MarketBreak = (() => {
  const ICON = { break: '☕', paused: '⏸' };
  const TITLE = { break: '午间休市', paused: '本局已暂停' };
  const SUB = { break: '上午盘已收盘', paused: '管理员暂停了行情与撮合' };
  const TIP = { break: '下一天 09:30 开盘，现在可以继续挂单排队', paused: '等待管理员继续…' };

  let host = null;
  let icoEl = null, titleEl = null, subEl = null, tipEl = null;
  let countEl = null, numEl = null;
  let mode = '';        // '' | 'break' | 'paused'
  let left = 0;
  let subText = '';

  function build() {
    if (host) return;
    host = el('div', { id: 'market-break', class: 'mb-hidden', role: 'status', 'aria-live': 'polite' });
    const card = el('div', { class: 'mb-card' });
    const hd = el('div', { class: 'mb-hd' });
    icoEl = el('span', { class: 'mb-ico', text: ICON.break });
    titleEl = el('span', { class: 'mb-title', text: TITLE.break });
    hd.appendChild(icoEl);
    hd.appendChild(titleEl);
    const bd = el('div', { class: 'mb-bd' });
    subEl = el('div', { class: 'mb-sub' });
    countEl = el('div', { class: 'mb-count' });
    numEl = el('b', { text: '0' });
    countEl.appendChild(numEl);
    countEl.appendChild(el('i', { text: 's' }));
    tipEl = el('div', { class: 'mb-tip' });
    bd.appendChild(subEl);
    bd.appendChild(countEl);
    bd.appendChild(tipEl);
    card.appendChild(hd);
    card.appendChild(bd);
    host.appendChild(card);
    document.body.appendChild(host);
  }

  function paint() {
    if (!host) return;
    icoEl.textContent = ICON[mode] || ICON.break;
    titleEl.textContent = TITLE[mode] || TITLE.break;
    tipEl.textContent = TIP[mode] || TIP.break;
    if (mode === 'paused') {
      countEl.style.display = 'none';
    } else {
      countEl.style.display = '';
      numEl.textContent = String(Math.max(0, Math.round(left)));
    }
    subEl.textContent = subText || SUB[mode] || '';
  }

  return {
    /** @param {'break'|'paused'} m  @param {{leftSec?:number, subText?:string}} o */
    show(m, o = {}) {
      build();
      mode = m;
      subText = o.subText || SUB[m] || '';
      left = Math.max(0, Math.round(Number(o.leftSec) || 0));
      host.classList.remove('mb-hidden');
      host.dataset.mode = m;
      paint();
    },
    hide() {
      mode = '';
      left = 0;
      subText = '';
      if (host) host.classList.add('mb-hidden');
    },
    /** 本地每秒自减（服务端每秒也会推一次 leftSec，以服务端为准） */
    tickDown() {
      if (!host || mode !== 'break' || left <= 0) return;
      left -= 1;
      numEl.textContent = String(Math.max(0, left));
      const ms = state.marketState;
      if (ms && ms.break) ms.break.leftSec = Math.max(0, left);
    },
    get visible() { return !!host && !host.classList.contains('mb-hidden'); },
    get mode() { return mode; },
  };
})();

/* 遮罩倒计时本地自减（服务端休市期间每秒会广播一次，这里只是避免丢包时数字卡住） */
setInterval(() => { MarketBreak.tickDown(); if (MarketBreak.visible) syncStatusBar(); }, 1000);

/** 当前市场状态（休市 / 暂停），供状态栏与遮罩使用 */
function blankMarketState() {
  return { break: { active: false, leftSec: 0, totalSec: 0, dayIndex: 0 }, paused: false, dayIndex: 0, rolledOver: false };
}
function marketStateOf() {
  if (!state.marketState) state.marketState = blankMarketState();
  return state.marketState;
}

/** 状态栏里的「虚拟交易日 + 盘中/休市/暂停」文案 */
function marketClockText() {
  if (!state.match) return fmtTime(Date.now());
  const ms = marketStateOf();
  const vc = state.vclock && state.vclock !== '--:--' ? state.vclock : '--:--';
  if (ms.paused) return `已暂停 ${vc}`;
  const day = (Number(ms.dayIndex) || 0) + 1;
  if (ms.break && ms.break.active) return `第 ${day} 日 · 午间休市 ${Math.max(0, Math.round(Number(ms.break.leftSec) || 0))}s`;
  return `第 ${day} 日 · 盘中 ${vc}`;
}

/** 处理服务端 break 报文（休市 / 休市结束 / 暂停 / 继续） */
function onBreakMsg(m) {
  if (!m || typeof m !== 'object') return;
  const ms = marketStateOf();
  const hasDay = Number.isFinite(Number(m.dayIndex));
  if (m.paused === true) {
    /* 运维控制台暂停：无倒计时 */
    ms.paused = true;
    ms.break.active = false;
    ms.break.leftSec = 0;
    if (hasDay) { ms.dayIndex = Number(m.dayIndex); ms.break.dayIndex = Number(m.dayIndex); }
    MarketBreak.show('paused');
  } else if (m.over === true || m.paused === false) {
    /* 休市结束 / 恢复开盘 */
    ms.paused = false;
    ms.break.active = false;
    ms.break.leftSec = 0;
    ms.rolledOver = false;
    if (hasDay) { ms.dayIndex = Number(m.dayIndex); ms.break.dayIndex = Number(m.dayIndex); }
    MarketBreak.hide();
  } else if (m.active === true) {
    ms.paused = false;
    ms.break.active = true;
    ms.break.leftSec = Math.max(0, Math.round(Number(m.leftSec) || 0));
    ms.break.totalSec = Math.max(0, Math.round(Number(m.totalSec) || 0));
    if (hasDay) { ms.dayIndex = Number(m.dayIndex); ms.break.dayIndex = Number(m.dayIndex); }
    /* 「第 N 个交易日 · 上午盘已收盘」里的 N 是**刚收盘的那个交易日**：
       · 自然日切（tick 里 vclock 回退）→ dayIndex 已 +1，所以收盘日 = dayIndex
       · 控制台强制休市（没有日切）→ 收盘日 = 当前日第 dayIndex+1 个交易日 */
    const closedDay = ms.rolledOver ? (Number(ms.dayIndex) || 0) : (Number(ms.dayIndex) || 0) + 1;
    MarketBreak.show('break', {
      leftSec: ms.break.leftSec,
      subText: `第 ${Math.max(1, closedDay)} 个交易日 · 上午盘已收盘`,
    });
  }
  syncStatusBar();
}

/* ───────── 7. 时钟 ───────── */
setInterval(() => {
  const c = $('#clock');
  if (!c) return;
  const txt = marketClockText();
  if (c.textContent !== txt) c.textContent = txt;
}, 1000);

/* ───────── 8. 标签栏（MDI）───────── */
const TABS = [
  { id: 'watch',  label: '自选股', view: 'trade', ui: { boardTab: 'watch', bottomTab: 'positions' } },   // 以前误设成 'quote'：标签叫自选股却显示全市场
  { id: 'timeshare', label: '分时图', view: 'trade', ui: { tf: 'timeshare' } },
  { id: 'kline',  label: 'K线图', view: 'trade', ui: { tf: '1d' } },
  { id: 'trade',  label: '交易', view: 'trade', ui: { bottomTab: 'positions' } },
  { id: 'rank',   label: '排行', view: 'trade', ui: { bottomTab: 'rank' } },
  { id: 'news',   label: '资讯', view: 'trade', ui: { bottomTab: 'news' } },
  { id: 'ai',     label: 'AI 诊股', view: 'trade', ui: { bottomTab: 'ai' } },
  { id: 'lobby',  label: '对战大厅', view: 'lobby' },
  { id: 'result', label: '结算', view: 'result', need: () => !!state.result },
];

function renderTabs() {
  if (currentView === 'login') { $('#tabstrip').innerHTML = ''; return; }
  const hide = new Set(state.ui.hiddenTabs || []);
  const host = $('#tabstrip');
  const sig = currentView + '|' + JSON.stringify(state.ui.hiddenTabs || []) + '|' + (state.result ? 1 : 0) + '|' + state.ui.topTab;
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  clear(host);
  for (const t of TABS) {
    if (hide.has(t.id)) continue;
    if (t.need && !t.need()) continue;
    const active = state.ui.topTab === t.id || (t.view === 'trade' && currentView === 'trade' && t.id === state.ui.topTab);
    const tab = el('div', { class: 'tab' + (active ? ' active' : ''), dataset: { tab: t.id } });
    tab.innerHTML = `<span>${t.label}</span>`;
    if (t.id !== 'trade') {
      const x = el('span', { class: 'x', text: '✕', title: '关闭标签' });
      x.onclick = (e) => {
        e.stopPropagation();
        state.ui.hiddenTabs = Array.from(new Set([...(state.ui.hiddenTabs || []), t.id]));
        host.dataset.sig = '';
        renderTabs();
      };
      tab.appendChild(x);
    }
    tab.onclick = () => openTab(t.id);
    host.appendChild(tab);
  }
}

function openTab(id) {
  const t = TABS.find(x => x.id === id);
  if (!t) return;
  state.ui.topTab = id;
  if (t.ui) Object.assign(state.ui, t.ui);
  state.ui.hiddenTabs = (state.ui.hiddenTabs || []).filter(x => x !== id);
  if (t.view !== currentView) go(t.view);
  else { touch(); $('#tabstrip').dataset.sig = ''; renderTabs(); syncToolbar(); }
}

/* ───────── 9. 菜单栏 ───────── */
function wireMenus() {
  const items = $$('#menubar .menu-item');
  for (const it of items) {
    it.addEventListener('mouseenter', () => {
      if ($$('#menubar .menu-item.open').length) {
        items.forEach(x => x.classList.remove('open'));
        applyMenuState();
        it.classList.add('open');
      }
    });
    it.addEventListener('click', (e) => {
      e.stopPropagation();
      /* ⚠️ 必须先处理菜单项：.menu-item 会 stopPropagation，
         指望 #menubar 上的委托监听收不到这里的点击 */
      const mi = e.target.closest('.mi');
      if (mi) {
        items.forEach(x => x.classList.remove('open'));
        if (mi.dataset.cmd === 'settings') { showSettings(); return; }
        if (!mi.dataset.cmd) return;
        handleCmd(mi.dataset.cmd);
        return;
      }
      const wasOpen = it.classList.contains('open');
      items.forEach(x => x.classList.remove('open'));
      if (!wasOpen) { applyMenuState(); it.classList.add('open'); }
    });
  }
  document.addEventListener('click', () => items.forEach(x => x.classList.remove('open')));
  /* Esc 关闭已展开的菜单 */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') items.forEach(x => x.classList.remove('open'));
  });
}

/* ───────── 10. 命令总线 ───────── */
function ensureTrade() {
  if (currentView !== 'trade') go('trade');
}

async function handleCmd(cmd) {
  if (!cmd) return;

  if (cmd === 'buy' || cmd === 'sell') {
    ensureTrade();
    patchUi({ orderSide: cmd, bottomTab: 'positions' });
    /* 以前这里 dispatch 一个全项目没人监听的 'ths:focus-order'（死代码）。
       改为写一个一次性标记，下单面板渲染时消费它并聚焦价格输入框。 */
    patchUi({ focusOrderAt: Date.now() });
    return;
  }

  if (cmd.startsWith('tf:')) {
    ensureTrade();
    const tf = cmd.slice(3);
    /* topTab 必须是 TABS 里真实存在的 id，否则 renderTabs 找不到匹配 → 所有标签都不高亮。
       分时 → timeshare 标签；其它周期 → kline 标签。 */
    patchUi({ tf, topTab: tf === 'timeshare' ? 'timeshare' : 'kline' });
    /* 标签栏有 sig 缓存 + 节流，这里像 openTab 一样强制重绘一次，
       否则会出现「图表已切成日K、标签栏却还高亮旧标签」的错位。 */
    const strip = $('#tabstrip');
    if (strip) strip.dataset.sig = '';
    renderTabs();
    return;
  }
  if (cmd.startsWith('tab:')) {
    const t = cmd.slice(4);
    if (t === 'lobby') return openTab('lobby');
    if (t === 'quote' || t === 'watch') { ensureTrade(); patchUi({ boardTab: t }); return; }
    if (t === 'trade') { openTab('trade'); return; }
    if (t === 'result') { if (state.result) go('result'); else toast.show('本局还没有结算数据', 'warn'); return; }
    ensureTrade();
    patchUi({ bottomTab: t });
    return;
  }
  if (cmd.startsWith('sort:')) {
    const k = cmd.slice(5);
    patchUi({ sortKey: k, sortDir: k === 'code' ? 1 : -1 });
    toast.show('已按 ' + sortName(k) + ' 排序', 'info');
    return;
  }
  if (cmd === 'reset:sort') { patchUi({ sortKey: 'changePct', sortDir: -1 }); toast.show('已恢复默认排序（涨幅 ↓）', 'info'); return; }

  switch (cmd) {
    case 'theme': {
      state.ui.dark = !state.ui.dark;
      document.body.classList.toggle('dark', state.ui.dark);
      /* 持久化：以前只改内存，刷新就丢回日间 */
      try { localStorage.setItem('thk.dark', state.ui.dark ? '1' : '0'); } catch (e) { /* 隐私模式下忽略 */ }
      toast.show(state.ui.dark ? '已切换到夜间模式' : '已切换到日间模式', 'info');
      touch();
      break;
    }
    case 'fullscreen': {
      if (NativeUI.available) { NativeUI.post('fullscreen'); break; }
      const done = () => toast.show(document.fullscreenElement ? '已进入全屏（F11 退出）' : '已退出全屏', 'info');
      const fail = (err) => toast.show('浏览器拒绝了全屏请求：' + ((err && err.message) || '当前环境不支持'), 'warn');
      try {
        if (document.fullscreenElement) {
          const r = document.exitFullscreen();
          if (r && r.then) r.then(done).catch(fail); else done();
        } else {
          const r = document.documentElement.requestFullscreen();
          if (r && r.then) r.then(done).catch(fail); else done();
        }
      } catch (err) { fail(err); }
      break;
    }
    case 'reload':
      if (NativeUI.available) NativeUI.post('reload');
      else location.reload();
      break;
    case 'toggle:confirm':
      state.ui.confirmOrder = state.ui.confirmOrder === false;
      toast.show('下单二次确认：' + (state.ui.confirmOrder ? '已开启' : '已关闭'), 'info');
      touch();
      break;
    case 'market:buy':
      await marketBuyActive();
      break;
    case 'export:trades':
      exportCsv('trades');
      break;
    case 'export:rank':
      exportCsv('rank');
      break;
    case 'copy:quote':
      copyQuote();
      break;
    case 'exit':
    case 'login':
      go('login');
      break;
    case 'settings':
      await showSettings();
      break;
    case 'cancelall':
      await cancelAll();
      break;
    case 'flatten':
      await flattenAll();
      break;
    case 'cancel': {
      const open = (state.account && state.account.orders || []).filter(o => o.status === 'open' || o.status === 'partial');
      if (!open.length) { toast.show('没有可撤的委托', 'warn'); return; }
      ensureTrade(); patchUi({ bottomTab: 'orders' });
      break;
    }
    case 'calc':
      await infoBox('收益计算器', calcTableHtml());
      break;
    case 'stats':
      await infoBox('对局统计', statsHtml());
      break;
    case 'mockend':
      if (window.__mock && window.__mock.endMatch) { window.__mock.endMatch(); }
      else toast.show('当前不是演示模式', 'warn');
      break;
    case 'help:rules':
      await infoBox('交易规则与费用', rulesHtml());
      break;
    case 'help:keys':
      await infoBox('快捷键一览', keysHtml());
      break;
    case 'help:about':
      await infoBox('关于同花亏', `<div style="text-align:center;padding:6px 0">
        <div style="font-size:20px;font-weight:700;color:#e01f26">同花亏</div>
        <div class="dim" style="margin:4px 0 10px">同样的行情，不同的亏损。</div>
        <div>商业模拟对战平台 <b>v1.0.0</b></div>
        <div class="dim" style="margin-top:6px">客户端：原生 ES Module + Canvas（无任何第三方库）</div>
        <div class="dim">服务端：Node.js（零 npm 依赖，支持 Windows Server / macOS / Linux）</div>
        <div class="dim" style="margin-top:8px">本游戏所有股票代码、名称、行情均为虚构，与真实市场无关，不构成任何投资建议。</div>
      </div>`);
      break;
    case 'ind:ma':
    case 'ind:macd':
    case 'ind:vol': {
      const key = cmd === 'ind:ma' ? 'showMA' : cmd === 'ind:macd' ? 'showMACD' : 'showVOL';
      const label = cmd === 'ind:ma' ? '均线' : cmd === 'ind:macd' ? 'MACD 副图' : '成交量副图';
      state.ui[key] = state.ui[key] === false;
      toast.show(label + (state.ui[key] === false ? '已隐藏' : '已显示'), 'info');
      touch();
      break;
    }
    case 'help:guide':
      await infoBox('新手玩法指南', guideHtml());
      break;
    default:
      if (cmd) toast.show('该功能尚未开放：' + cmd, 'warn');
  }
}

/* 排序键 → 中文名 */
function sortName(k) {
  return ({ code: '代码', name: '名称', changePct: '涨幅', p: '现价', v: '成交量',
            turn: '换手率', speed: '涨速', vr: '量比', amp: '振幅', avg: '均价' })[k] || k;
}

/* 全仓市价买入当前股票 */
async function marketBuyActive() {
  ensureTrade();
  const a = activeStock();
  if (!a || !a.quote) { toast.show('请先在行情表里选择一只股票', 'warn'); return; }
  const cash = state.account ? state.account.available : 0;
  const price = a.quote.p;
  const qty = Math.floor(cash / (price * 100 * 1.002)) * 100;
  if (qty < 100) { toast.show('可用资金不足 100 股', 'warn'); return; }
  const ok = await confirmBox({
    title: '全仓市价买入', danger: 'buy', okText: '确认买入',
    body: '<div>以 <b>市价</b> 买入 <b>' + escapeHtml(a.meta.name) + ' ' + a.id + '</b> 约 ' +
          '<span class="hl">' + qty + '</span> 股</div>' +
          '<div class="dim">按现价 ' + fmtPrice(price) + ' 估算约 ' + fmtMoney(qty * price) +
          ' 元；市价单会吃穿对手档位，有滑点成本。</div>',
  });
  if (!ok) return;
  net.send('order:place', { stockId: a.id, side: 'buy', type: 'market', qty, reqId: uid('mb') });
}

/* 复制当前行情到剪贴板 */
function copyQuote() {
  const a = activeStock();
  if (!a || !a.quote) { toast.show('请先选择一只股票', 'warn'); return; }
  const d = a.quote;
  const text = [a.meta.name + '(' + a.id + ')',
    '现价 ' + fmtPrice(d.p),
    (d.change >= 0 ? '+' : '') + d.change.toFixed(2),
    fmtPct(d.changePct),
    '开 ' + fmtPrice(d.o), '高 ' + fmtPrice(d.h), '低 ' + fmtPrice(d.l),
    '量 ' + Math.round((d.v || 0) / 100) + ' 手'].join(' ');
  const done = () => toast.show('行情已复制到剪贴板', 'success');
  const fail = () => toast.show('复制失败：浏览器未授予剪贴板权限', 'error');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, fail);
  } else { fail(); }
}

/* 导出 CSV（成交记录 / 本局排行） */
function exportCsv(kind) {
  let head, rows, name;
  if (kind === 'rank') {
    const r = state.rank || [];
    if (!r.length) { toast.show('当前没有排行数据可导出', 'warn'); return; }
    head = ['名次', '玩家', '资产', '收益率', '段位', '类型'];
    rows = r.map((x, i) => [i + 1, x.nick, x.assets, (x.returnPct * 100).toFixed(2) + '%',
      x.tier || '', x.isBot ? 'AI' : '玩家', x.isMe ? '我' : '']);
    name = '本局排行';
  } else {
    const t = (state.account && state.account.trades) || [];
    if (!t.length) { toast.show('当前没有成交记录可导出', 'warn'); return; }
    head = ['时间', '代码', '名称', '方向', '成交价', '数量(股)', '成交额', '手续费'];
    rows = t.map(x => [fmtTime(x.time), x.i, (state.stocks.get(x.i) || {}).name || '',
      x.side === 'buy' ? '买入' : '卖出', x.price, x.qty, x.amount, x.fee]);
    name = '成交记录';
  }
  const csv = [head.join(',')].concat(rows.map(r => r.join(','))).join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: '同花亏-' + name + '-' +
    new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.csv' });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast.show('已导出 ' + rows.length + ' 条' + name, 'success');
}

function guideHtml() {
  return '<div style="min-width:420px">' +
    '<h3 style="font-size:13px;margin-bottom:6px">一分钟上手</h3>' +
    '<div class="dim">① 左侧行情表点一只股票 → ② 按 <b>F1</b> 买入 / <b>F2</b> 卖出 → ' +
    '③ 点「买一 / 卖一 / 涨停 / 跌停」快捷填价 → ④ 用 <b>1/4 1/3 1/2 全仓</b> 定数量 → ' +
    '⑤ 点红色「买入」或绿色「卖出」并确认。</div>' +
    '<h3 style="font-size:13px;margin:10px 0 6px">三条保命建议</h3>' +
    '<div class="dim">· <b>先活着再赚钱</b>：梭哈能让你第一，也能让你最后一名。<br>' +
    '· <b>别和 T+1 对着干</b>：今天买的明天才能卖，隔夜跳空全是你扛。<br>' +
    '· <b>注意价格冲击</b>：资金体量大时，你自己就是行情，分批建仓成本更好看。</div>' +
    '<h3 style="font-size:13px;margin:10px 0 6px">胜负与段位</h3>' +
    '<div class="dim">规定时间内总资产最高者获胜；1v1 用标准 ELO，混战两两配对，团战按队伍平均收益率。' +
    '段位：青铜 → 白银 → 黄金 → 铂金 → 钻石 → 王者。</div>' +
    '<div class="dim" style="margin-top:8px">完整说明见 <b>docs/USER-GUIDE.md</b>。</div></div>';
}

async function cancelAll() {
  const orders = (state.account && state.account.orders || []).filter(o => o.status === 'open' || o.status === 'partial');
  if (!orders.length) { toast.show('当前没有可撤委托', 'warn'); return; }
  const ok = await confirmBox({ title: '全部撤单', body: `确定撤销全部 <span class="hl">${orders.length}</span> 笔未成交委托吗？`, okText: '全部撤销' });
  if (!ok) return;
  for (const o of orders) net.send('order:cancel', { orderId: o.id, reqId: 'ca_' + o.id });
}

async function flattenAll() {
  const pos = (state.account && state.account.positions || []).filter(p => p.avail > 0);
  if (!pos.length) { toast.show('没有可卖出的持仓（注意 T+1）', 'warn'); return; }
  const total = pos.reduce((s, p) => s + (p.mv || 0), 0);
  const ok = await confirmBox({
    title: '一键清仓', danger: 'sell', okText: '全部市价卖出',
    body: `确定以市价卖出全部 <span class="hl">${pos.length}</span> 只股票（合计市值约 <b>${fmtMoney(total)}</b> 元）吗？<br><span class="dim">市价单会吃掉对手盘，大额委托有滑点成本。</span>`,
  });
  if (!ok) return;
  for (const p of pos) net.send('order:place', { stockId: p.i, side: 'sell', type: 'market', qty: p.avail, reqId: 'fl_' + p.i });
}

/* ───────── 11. 设置 / 帮助弹窗内容 ───────── */
function feeRows() {
  const f = state.config && state.config.fee || { commissionRate: .00025, commissionMin: 5, stampTax: .0005, transferFee: .00001 };
  return [
    ['佣金', `成交金额 × ${(f.commissionRate * 1000).toFixed(2)}‰，最低 ${f.commissionMin} 元`],
    ['印花税', `卖出金额 × ${(f.stampTax * 1000).toFixed(1)}‰（仅卖出收取）`],
    ['过户费', `成交金额 × ${(f.transferFee * 1000).toFixed(3)}‰（双向）`],
    ['涨跌停', '主板 ±10%，创业板/科创板（30/68 开头）±20%'],
    ['交易单位', '1 手 = 100 股，买入必须为 100 股整数倍'],
    ['T+1', '当日买入的股票当日不可卖出'],
  ];
}

async function showSettings() {
  const rows = feeRows().map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  await infoBox('系统设置 · 费用与规则', `<div style="min-width:340px">${rows}</div>
    <div style="margin-top:10px;border-top:1px solid #dfe4ea;padding-top:8px">
      <div class="dim">下单二次确认：${state.ui.confirmOrder ? '已开启' : '已关闭'}（菜单 系统 → 下单二次确认 可切换，快捷键 ${PLATFORM.mac ? '⇧⌘C' : 'Ctrl+Shift+C'}）</div>
      <div class="dim">数据源：${state.source === 'real' ? '真实服务端' : '本地演示数据（Mock）'}</div>
    </div>`);
}

function rulesHtml() {
  return `<div style="min-width:380px">
    <h3 style="font-size:13px;margin-bottom:6px">一、对局目标</h3>
    <div class="dim">开局每人资金相同，在规定时间内交易虚拟股票，<b>期末总资产最高者获胜</b>。收益率 =（期末总资产 − 初始资金）/ 初始资金。</div>
    <h3 style="font-size:13px;margin:10px 0 6px">二、费用</h3>
    ${feeRows().map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}
    <h3 style="font-size:13px;margin:10px 0 6px">三、撮合</h3>
    <div class="dim">限价单先与市场合成流动性按对手价逐档成交（有滑点），再与其他玩家的挂单按"价格优先、时间优先"撮合；市价单立即吃对手五档，未成交部分自动撤销。</div>
    <h3 style="font-size:13px;margin:10px 0 6px">四、价格冲击</h3>
    <div class="dim">大额主动成交会推动股价，净买入推高、净卖出打压。<b>这就是你的资金体量对市场的影响。</b></div>
  </div>`;
}

function keysHtml() {
  const M = PLATFORM.mac;                       // mac 上显示 ⌘ 系，避免提示与实现不一致
  const ks = [['F1', '买入'], ['F2', '卖出'], ['F3', '撤单'], ['F4', '持仓'], ['F5', '委托'], ['F6', '成交'],
    ['B / S', '切换 买入 / 卖出 方向'], ['↑ / ↓', '切换股票'], ['Enter', '提交下单'], ['Esc', '关闭弹窗'],
    [M ? '⌘D' : 'Ctrl+D', '夜间模式'], [M ? '⌘K' : 'Ctrl+K', '聚焦搜索框'], [M ? '⌘L' : 'Ctrl+L', '重新登录'],
    [M ? '⇧⌘C' : 'Ctrl+Shift+C', '切换下单二次确认'], [M ? '⌃⌘F' : 'F11', '全屏'],
    [M ? '⌥1 / ⌥5 / ⌥0' : 'Alt+1 / Alt+5 / Alt+0', '图表切换 分时 / 5分 / 日K'],
    [M ? '⌥M / ⌥D' : 'Alt+M / Alt+D', '图表 均线 / 夜间']];
  return `<div style="min-width:300px">${ks.map(([k, v]) =>
    `<div class="kv"><span class="k" style="min-width:70px"><b>${k}</b></span><span class="v dim">${v}</span></div>`).join('')}</div>`;
}

function calcTableHtml() {
  const cash = state.account ? state.account.available : 0;
  const lines = [5, 10, 20].map(p => {
    const profit = cash * p / 100;
    return `<div class="kv"><span class="k">若盈利 ${p}%</span><span class="v ${profit >= 0 ? 'up' : 'down'}">+${fmtNum(profit, 2)} 元</span></div>`;
  }).join('');
  return `<div style="min-width:280px">
    <div class="kv"><span class="k">当前可用资金</span><span class="v">${fmtNum(cash, 2)} 元</span></div>
    <div style="border-top:1px solid #dfe4ea;margin:8px 0"></div>${lines}
    <div class="dim" style="margin-top:8px">换个方向想：亏 20% 只需要一根大阴线。</div></div>`;
}

function statsHtml() {
  const a = state.account;
  const st = (a && a.positions || []).length;
  const ords = (a && a.orders || []).length;
  const trs = (a && a.trades || []).length;
  return `<div style="min-width:280px">
    <div class="kv"><span class="k">持仓股票数</span><span class="v">${st}</span></div>
    <div class="kv"><span class="k">委托笔数</span><span class="v">${ords}</span></div>
    <div class="kv"><span class="k">成交笔数</span><span class="v">${trs}</span></div>
    <div class="kv"><span class="k">总资产</span><span class="v">${a ? fmtNum(a.totalAssets, 2) : '--'}</span></div>
    <div class="kv"><span class="k">总收益率</span><span class="v ${a ? signClass(a.pnlPct) : ''}">${a ? fmtPct(a.pnlPct) : '--'}</span></div>
  </div>`;
}

/* ───────── 12. 工具栏 / 全局搜索 / 快捷键 ───────── */
const syncToolbar = throttle(() => {
  for (const b of $$('#toolbar .tb-btn')) {
    const c = b.dataset.cmd || '';
    let on = false;
    if (c.startsWith('tf:')) on = state.ui.tf === c.slice(3);
    else if (c.startsWith('tab:')) on = state.ui.bottomTab === c.slice(4) && currentView === 'trade';
    b.classList.toggle('on', on);
  }
}, 80);

function wireToolbar() {
  $('#toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('.tb-btn');
    if (b) handleCmd(b.dataset.cmd);
  });
  $('.win-btns').addEventListener('click', (e) => {
    const b = e.target.closest('.wb');
    if (!b) return;
    const act = b.dataset.win;
    if (NativeUI.available) {
      if (act === 'close') NativeUI.post('close');
      else if (act === 'max') NativeUI.post('maximize');
      else NativeUI.post('minimize');
      return;
    }
    if (act === 'close') handleCmd('exit');
    else if (act === 'max') handleCmd('fullscreen');
    else toast.show('浏览器里无法最小化窗口；用桌面版 .app 可以', 'info');
    // 注：macOS 下 .win-btns 已隐藏（真窗口有红绿灯），这里只在 Windows/浏览器生效
  });
  $('#tabstrip').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (t && !e.target.classList.contains('x')) openTab(t.dataset.tab);
  });
}

function wireSearch() {
  const input = $('#search-input'), pop = $('#search-pop');
  let hl = -1;

  const close = () => { pop.classList.remove('open'); hl = -1; };

  const render = () => {
    const kw = input.value.trim().toLowerCase();
    if (!kw) { close(); return; }
    const list = stockList().filter(s =>
      s.id.includes(kw) || String(s.name).toLowerCase().includes(kw) ||
      String(s.pinyin || '').toLowerCase().includes(kw) || String(s.sector || '').includes(kw)
    ).slice(0, 12);
    if (!list.length) { close(); return; }
    clear(pop);
    list.forEach((s, i) => {
      const q = state.quotes.get(s.id);
      const pc = q ? q.pc : s.prevClose, p = q ? q.p : s.prevClose;
      const pct = pc ? (p - pc) / pc : 0;
      const r = el('div', { class: 'sr' + (i === hl ? ' hl' : ''), dataset: { id: s.id } });
      r.innerHTML = `<span class="c">${s.id}</span><span>${escapeHtml(s.name)}</span>
        <span class="dim" style="font-size:11px">${escapeHtml(s.sector || '')}</span>
        <span class="num ${signClass(pct)}" style="margin-left:auto">${fmtPrice(p)} ${fmtPct(pct)}</span>`;
      r.onclick = () => { choose(s.id); };
      pop.appendChild(r);
    });
    pop.classList.add('open');
  };

  function choose(id) {
    state.ui.stockId = id;
    state.ui.topTab = currentView === 'trade' ? state.ui.topTab : 'trade';
    close(); input.blur();
    if (currentView !== 'trade') go('trade'); else touch();
  }

  input.addEventListener('input', () => { hl = -1; render(); });
  input.addEventListener('focus', render);
  input.addEventListener('blur', () => setTimeout(close, 160));
  input.addEventListener('keydown', (e) => {
    const rows = $$('.sr', pop);
    if (e.key === 'ArrowDown') { e.preventDefault(); hl = Math.min(rows.length - 1, hl + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hl = Math.max(0, hl - 1); render(); }
    else if (e.key === 'Enter') {
      const sel = rows[hl] || rows[0];
      if (sel) choose(sel.dataset.id);
    } else if (e.key === 'Escape') { input.value = ''; close(); input.blur(); }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.focus(); input.select(); }
  });
}

function moveStock(delta) {
  const list = stockList();
  if (!list.length) return;
  let i = list.findIndex(s => s.id === state.ui.stockId);
  if (i < 0) i = 0;
  i = (i + delta + list.length) % list.length;
  state.ui.stockId = list[i].id;
  touch();
}

function wireKeys() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

    if (e.key === 'F1') { e.preventDefault(); handleCmd('buy'); return; }
    if (e.key === 'F2') { e.preventDefault(); handleCmd('sell'); return; }
    if (e.key === 'F3') { e.preventDefault(); handleCmd('cancel'); return; }
    if (e.key === 'F4') { e.preventDefault(); handleCmd('tab:positions'); return; }
    if (e.key === 'F5') { e.preventDefault(); handleCmd('tab:orders'); return; }
    if (e.key === 'F6') { e.preventDefault(); handleCmd('tab:trades'); return; }
    /* F7~F12 以前完全没绑定（审计点出来的） */
    if (e.key === 'F7') { e.preventDefault(); handleCmd('tab:cash'); return; }
    if (e.key === 'F8') { e.preventDefault(); handleCmd('tab:rank'); return; }
    if (e.key === 'F9') { e.preventDefault(); handleCmd('tab:news'); return; }
    if (e.key === 'F10') { e.preventDefault(); handleCmd('tab:ai'); return; }
    if (e.key === 'F11') { e.preventDefault(); handleCmd('fullscreen'); return; }
    if (e.key === 'F12') { e.preventDefault(); handleCmd('calc'); return; }
    /* ⌘Q / Ctrl+Q：原生壳里退出应用，浏览器里提示（菜单项一直标着却没人实现） */
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'q') {
      e.preventDefault();
      if (NativeUI.available) NativeUI.post('close');
      else toast.show('网页版无法自行退出，直接关闭标签页即可', 'info');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); handleCmd('theme'); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); handleCmd('login'); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); handleCmd('toggle:confirm'); return; }

    if (typing) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); moveStock(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveStock(1); }
    else if (e.key === 'b' || e.key === 'B') { handleCmd('buy'); }
    else if (e.key === 's' || e.key === 'S') { handleCmd('sell'); }
  });
}

/* ───────── 13. 心跳 ───────── */
setInterval(() => {
  if (!state.connected) return;
  net.send('ping', { ts: Date.now() });
}, 15000);

/* ───────── 14. 启动 ───────── */
async function boot() {
  localizeKeys();
  wireTitlebarDrag();
  wireMenus();
  wireToolbar();
  wireSearch();
  wireKeys();
  setConn(false);
  syncStatusBar();

  subscribeState(() => { syncToolbar(); renderTabs(); requestActiveKline(); });

  showLoading();

  if (FORCE_MOCK) {
    adopt(await createMock(), 'mock');
  } else {
    const real = await createReal();
    adopt(real, 'real');
    const ok = await waitWelcome(FORCE_REAL ? 6000 : 2500);
    if (!ok && !FORCE_REAL) {
      try { real.close(); } catch (e) { /* ignore */ }
      await adopt(await createMock(), 'mock');
      toast.show('未检测到服务端，已切换到本地演示数据（加 ?real=1 可强制连服务端）', 'warn');
    }
  }

  // 启动视图：URL 指定 > 已登录 > 登录页
  const startView = BOOT_VIEW || (state.player ? (state.match ? 'trade' : 'lobby') : 'login');
  go(startView);
  hideLoading();

  if (PLATFORM.nativeShell) {
    setTimeout(() => dumpLayoutDiag('boot'), 800);
    setTimeout(() => dumpLayoutDiag('ready'), 3000);
  }
}

function showLoading() {
  if ($('#loading')) return;
  $('#app').appendChild(el('div', { id: 'loading', html: '<div class="spin"></div><div>同花亏 正在启动…</div>' }));
}
function hideLoading() {
  const l = $('#loading');
  if (!l) return;
  setTimeout(() => l.remove(), 120);
}

/** 供其它模块调用 */
export { ctx, handleCmd, go };

/* 演示辅助 */
window.__ths = { state, ctx, net, go, handleCmd, toast, marketBreak: MarketBreak, onBreakMsg, marketClockText };

boot().catch((e) => { console.error('[main] 启动失败', e); hideLoading(); });
