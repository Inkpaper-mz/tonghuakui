/* ═══════════════════════════════════════════════════════════
   同花亏 · store.js —— 全局状态单例（结构见 DESIGN.md §4.2，冻结）
   ═══════════════════════════════════════════════════════════ */

export const state = {
  connected: false,
  view: 'login',
  online: 0,
  serverTime: 0,
  latency: 0,
  source: 'mock',            // 'mock' | 'real'

  player: null,
  token: null,
  config: null,

  lobby: { rooms: [] },
  room: null,
  chat: [],

  match: null,
  watch: new Set(),          // 自选股 id 集合（持久化于 localStorage['thk.watch']）
  stocks: new Map(),         // id -> meta
  quotes: new Map(),         // id -> quote
  klines: new Map(),         // `${id}:${tf}` -> bars [[t,o,h,l,c,v]...]
  timeshare: new Map(),      // id -> { prevClose, points:[[t, price, avgPrice, vol]...] } 分时数据

  indices: [],               // [{c,n,v,pc,pct,amt}]
  account: null,
  rank: [],
  news: [],
  result: null,
  vclock: '--:--',

  ui: {
    stockId: null,
    tf: '1d',
    dark: (() => { try { return localStorage.getItem('thk.dark') === '1'; } catch (e) { return false; } })(),
    orderSide: 'buy',
    bottomTab: 'positions',
    boardTab: 'quote',
    topTab: 'trade',
    search: '',
    sector: '全部',
    sortKey: 'changePct',
    sortDir: -1,
    confirmOrder: true,
  },
};

/* ───────── 订阅 ───────── */
const listeners = new Set();
let notifyScheduled = false;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 合并顶层字段并通知 */
export function setState(patch) {
  Object.assign(state, patch);
  touch();
}

/** 合并 ui 字段并通知 */
export function patchUi(patch) {
  Object.assign(state.ui, patch);
  touch();
}

/** 强制通知（Map 内部变更后使用） */
export function touch() {
  if (notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    for (const fn of Array.from(listeners)) {
      try { fn(state); } catch (e) { console.error('[store] listener error', e); }
    }
  });
}

/* ───────── 选择器 ───────── */

export function quote(id) { return state.quotes.get(id); }
export function stock(id) { return state.stocks.get(id); }

/** 按服务端顺序返回股票 meta 数组 */
export function stockList() { return Array.from(state.stocks.values()); }

/** 返回 {price, prevClose, change, changePct, ...} 的派生行情 */
export function derived(id) {
  const q = state.quotes.get(id);
  const m = state.stocks.get(id);
  if (!q) return null;
  const pc = q.pc || (m && m.prevClose) || q.p;
  const change = q.p - pc;
  const changePct = pc ? change / pc : 0;
  return { ...q, name: (m && m.name) || q.name || id, prevClose: pc, change, changePct };
}

/** 行情数组（含派生字段），按当前排序规则 */
export function quoteRows() {
  const rows = [];
  for (const id of state.stocks.keys()) {
    const d = derived(id);
    if (d) rows.push(d);
  }
  const k = state.ui.sortKey, dir = state.ui.sortDir;
  rows.sort((a, b) => {
    let va, vb;
    if (k === 'code') { va = a.i; vb = b.i; return va < vb ? -1 * dir : va > vb ? 1 * dir : 0; }
    va = a[k]; vb = b[k];
    if (va === undefined) va = 0; if (vb === undefined) vb = 0;
    return (va - vb) * dir;
  });
  return rows;
}

/* ═══════════ 自选股（localStorage['thk.watch']，JSON 数组） ═══════════
   规则：
   · 有存档 → 用存档（空数组也算存档，尊重用户清空）
   · 无存档 → 首屏股票到位后补一份默认自选（id 必须真实存在才采纳）
   · 存档损坏 / localStorage 不可用 → 静默降级为空集合，绝不抛异常，
     且不播种默认自选（有存档就说明用户用过，不能覆盖他的数据）
   ══════════════════════════════════════════════════════════════════ */

const WATCH_KEY = 'thk.watch';
const WATCH_DEFAULT = ['600519', '000858', 'NVDA'];   // 贵州毛台 / 五粮溢 / 英卫达

let watchLoaded = false;        // 是否已尝试读盘
let watchNoSeed = false;        // true = 盘里有存档（含空数组/坏数据）→ 不再播种默认自选
let watchSeeded = false;        // 是否已补过默认自选

/** 读盘：数组=存档；'absent'=没存过；'bad'=坏数据/不可用 */
function readWatchStore() {
  let raw;
  try { raw = localStorage.getItem(WATCH_KEY); } catch (e) { return 'bad'; }
  if (raw === null || raw === undefined) return 'absent';
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return 'bad';
    return arr;
  } catch (e) { return 'bad'; }
}

function persistWatch() {
  try { localStorage.setItem(WATCH_KEY, JSON.stringify(Array.from(state.watch))); }
  catch (e) { /* 隐私模式 / 配额满：内存态照常可用，静默忽略 */ }
}

/** 幂等初始化（读盘 + 首屏补默认自选）；其它自选 API 内部都会先调它 */
export function ensureWatch() {
  if (!watchLoaded) {
    watchLoaded = true;
    const saved = readWatchStore();
    if (Array.isArray(saved)) {
      state.watch = new Set(saved.filter((x) => typeof x === 'string' && x));
      watchNoSeed = true;          // 有存档（含空数组）→ 尊重用户选择
    } else {
      state.watch = new Set();     // 无存档或存档损坏 → 空集合起步
      /* 'bad'：存档坏了 → 静默降级为空集合，且不播种默认自选（不覆盖用户数据） */
      if (saved === 'bad') watchNoSeed = true;
    }
  }
  /* 只有「从没存过」才补默认自选；等 state.stocks 到位再补，避免写入不存在的 id */
  if (!watchNoSeed && !watchSeeded && state.stocks && state.stocks.size > 0) {
    watchSeeded = true;
    let added = 0;
    for (const id of WATCH_DEFAULT) {
      if (state.stocks.has(id) && !state.watch.has(id)) { state.watch.add(id); added++; }
    }
    if (added) persistWatch();
  }
}

/** 自选 id 数组（按加入顺序） */
export function watchIds() { ensureWatch(); return Array.from(state.watch); }

/** 自选数量 */
export function watchCount() { ensureWatch(); return state.watch.size; }

/** 是否已自选 */
export function isWatched(id) { ensureWatch(); return state.watch.has(String(id)); }

/** 加入自选；返回是否真的发生了变化 */
export function watchAdd(id) {
  ensureWatch();
  const k = String(id == null ? '' : id);
  if (!k || state.watch.has(k)) return false;
  state.watch.add(k);
  persistWatch();
  touch();
  return true;
}

/** 移出自选；返回是否真的发生了变化 */
export function watchRemove(id) {
  ensureWatch();
  const k = String(id == null ? '' : id);
  if (!k || !state.watch.has(k)) return false;
  state.watch.delete(k);
  persistWatch();
  touch();
  return true;
}

/** 切换自选；返回切换后的状态（true = 已自选） */
export function toggleWatch(id) {
  ensureWatch();
  const k = String(id == null ? '' : id);
  if (!k) return false;
  const on = !state.watch.has(k);
  if (on) state.watch.add(k); else state.watch.delete(k);
  persistWatch();
  touch();
  return on;
}

/** 自选股行情（按当前排序规则；不存在的 id 自然被忽略） */
export function watchRows() {
  ensureWatch();
  const ids = state.watch;
  return quoteRows().filter((r) => ids.has(r.i));
}

/** 当前选中股票 */
export function activeStock() {
  const id = state.ui.stockId || state.stocks.keys().next().value;
  return id ? { id, meta: state.stocks.get(id), quote: derived(id) } : null;
}

/** 账户可用资金 */
export function availableCash() {
  return state.account ? state.account.available : 0;
}

/** 某股票持仓 */
export function position(id) {
  if (!state.account) return null;
  return (state.account.positions || []).find(p => p.i === id) || null;
}

/** 是否为真实行情模式 */
export function isMock() { return state.source !== 'real'; }
