/* ═══════════════════════════════════════════════════════════════════════════
   同花亏 · client/js/admin.js —— 运维控制台（OPS Console）

   作用：给运营一个人工干预界面 —— 选股票 → 投放事件（政府补贴 / 监管处罚 /
         临时停牌 / 央行加息 / 国家队救市……），并实时盯盘。

   设计约定
   ─ 纯原生 ES module，零依赖（不 import 游戏本体模块，避免与并行改动耦合）
   ─ 只消费服务端已实现的三种报文：admin:auth / admin:event / admin:state
   ─ 所有外部数据一律经 textContent 写入 DOM；全程不使用 innerHTML
   ─ 断线指数退避重连（1→8s），重连后用 localStorage 里的密钥自动重新鉴权
   ─ 每 2.5s 轮询 admin:state；页面隐藏时暂停，重新可见立即刷一次
   ─ 快照里所有个股：取 movers.up + movers.down + special 的去重并集
     （服务端 admin:state 未提供全量 61 只清单；若将来带 stocks 字段会自动并入）
   ═══════════════════════════════════════════════════════════════════════════ */

/* ───────────────────────── 常量 ───────────────────────── */
const POLL_MS = 2500;
const LOG_MAX = 100;
const STORAGE_KEY = 'thk.admin.key';
const WS_PATH = '/ws';
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 8000;
const REQ_TIMEOUT = 8000;
const EVENT_TIMEOUT = 12000;
const DONE_FLASH_MS = 1500;      // 「已投放 ✓」停留时间，同时避开服务端 1.5s 限流
const DEFAULT_STRENGTH = 1;
const DEFAULT_TICKS = 0;

/** 危险事件：dir=-1 且 |impact| >= 0.9，或点名的高危 id → 二次确认 */
const DANGER_IDS = new Set(['fine', 'earningsDown', 'blackSwan']);

const ERROR_TEXT = {
  ADMIN_DENIED: '管理密钥不正确',
  ADMIN_DISABLED: '服务端未启用运维控制台',
  NO_MATCH: '当前没有进行中的对局',
  RATE_LIMITED: '操作太快了，请稍后再试',
  BAD_REQUEST: '请求参数不合法',
};

/* ───────────────────────── 小工具 ───────────────────────── */
const $ = (sel, root) => (root || document).querySelector(sel);

/** 建元素：el('div','cls', '文本')；文本一律经 textContent 写入 */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}
function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const fmtPrice = (v) => num(v).toFixed(2);
const fmtPct = (v) => (num(v) > 0 ? '+' : '') + (num(v) * 100).toFixed(2) + '%';
const signCls = (v) => (num(v) > 0 ? 'is-up' : num(v) < 0 ? 'is-down' : 'is-flat');
const pad2 = (n) => String(n).padStart(2, '0');
function fmtClock(ts) {
  const d = new Date(num(ts) || Date.now());
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtDur(sec) {
  const s = Math.max(0, Math.round(num(sec)));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h > 0 ? h + ':' : '') + pad2(m) + ':' + pad2(ss);
}
function isDangerous(ev) { return !!ev && ((num(ev.dir) < 0 && Math.abs(num(ev.impact)) >= 0.9) || DANGER_IDS.has(ev.id)); }
function errText(err) {
  if (!err) return '未知错误';
  if (err.code) return `${ERROR_TEXT[err.code] || err.msg || err.code}（${err.code}）`;
  return err.message || String(err);
}

/* ───────────────────────── 状态 ───────────────────────── */
const S = {
  mounted: false,
  /* 连接 */
  ws: null,
  conn: 'idle',              // idle | connecting | open | closed
  retry: 0,
  retryTimer: 0,
  pollTimer: 0,
  pollInFlight: false,
  userClosed: false,
  wasOpen: false,            // 本次连接是否曾握手成功（用于断线日志去抖）
  /* 鉴权 */
  key: '',
  pendingKey: '',
  authed: false,
  /* 快照 */
  snapshot: null,
  serverTime: 0,
  online: 0,
  rooms: [],
  indices: [],
  movers: { up: [], down: [] },
  special: [],
  catalog: [],
  byId: new Map(),
  universe: new Map(),
  sectorNames: [],
  lastSnapshotAt: 0,
  tickMs: 400,               // 服务端 tick 间隔（welcome.tickMs），用于本地估算剩余 tick
  /* 本地行政状态登记：admin:state 的 halted / floor 字段在服务端恒为 false（见报告），
     因此控制台自己记下本会话投放的停牌 / 托底，按 tickMs 折算成到期时间。 */
  local: { halt: new Map(), floor: new Map(), marketFloorUntil: 0 },
  /* 对局控制 */
  ctrlRoom: '',              // '' = 全部进行中对局
  ctrlBusy: false,
  /* 选择 */
  mode: 'stock',             // stock | sector | market
  stockId: null,
  selectedRow: null,         // 选中个股的最后一次已知快照行（掉出涨跌榜后仍能稳定显示）
  sector: '',
  /* 控制 */
  strength: DEFAULT_STRENGTH,
  ticks: DEFAULT_TICKS,
  lastEvent: null,           // 最近一次 admin:event 的原始回复（调试 / 验收）
  lastControl: null,         // 最近一次 admin:control 的原始回复（调试 / 验收）
  /* 左栏筛选 */
  search: '',
  sectorFilter: '',
  onlySpecial: false,
  /* 交互锁 */
  inFlight: false,
  busyUntil: 0,
  doneEvent: null,           // { id, until }
  logCollapsed: false,
};

let seq = 0;
const pending = new Map();   // reqId -> { resolve, reject, timer }

/* ═════════════════════════ 1. 连接层 ═════════════════════════ */

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location.host || '127.0.0.1:8899';
  return `${proto}//${host}${WS_PATH}`;
}
function isOpen() { return !!S.ws && S.ws.readyState === 1; }

function setConn(state) {
  S.conn = state;
  renderTop();
}

function connect() {
  if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;
  S.userClosed = false;
  setConn('connecting');
  let ws;
  try {
    ws = new WebSocket(wsUrl());
  } catch (err) {
    setConn('closed');
    logAdd('bad', '连接失败', wsUrl(), '—', String(err && err.message || err));
    scheduleReconnect();
    return;
  }
  S.ws = ws;
  ws.onopen = () => {
    S.retry = 0;
    S.wasOpen = true;
    setConn('open');
    /* 重连后自动用已保存 / 待用的密钥重新鉴权 */
    const k = S.pendingKey || S.key || safeGetKey();
    if (k && !S.userClosed) void doAuth(k, true);
  };
  ws.onmessage = (ev) => {
    let m = null;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || typeof m !== 'object' || !m.t) return;
    route(m);
  };
  ws.onclose = () => {
    const hadSession = S.wasOpen;
    S.wasOpen = false;
    setConn('closed');
    S.ws = null;
    failPending('连接已断开');
    stopPolling();
    if (S.userClosed) return;
    /* 只有在曾经连上过、或首次连接失败时才记日志，避免服务端离线时刷屏 */
    if (hadSession || S.retry === 0) logAdd('warn', '连接断开', wsUrl(), '—', '等待自动重连');
    scheduleReconnect();
  };
  ws.onerror = () => { /* onclose 会接手 */ };
}

function scheduleReconnect() {
  if (S.userClosed) return;
  clearTimeout(S.retryTimer);
  const wait = Math.min(RECONNECT_MAX, RECONNECT_MIN * Math.pow(2, Math.min(S.retry, 3)));
  S.retry += 1;
  setConn('closed');
  S.retryTimer = setTimeout(() => connect(), wait);
  return wait;
}

function raw(obj) {
  if (!isOpen()) return false;
  try { S.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
}

function request(t, fields, timeoutMs) {
  const reqId = 'adm_' + (++seq).toString(36) + '_' + Date.now().toString(36).slice(-3);
  return new Promise((resolve, reject) => {
    if (!isOpen()) { reject(Object.assign(new Error('未连接服务端'), { code: 'OFFLINE' })); return; }
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(Object.assign(new Error('请求超时'), { code: 'TIMEOUT' }));
    }, timeoutMs || REQ_TIMEOUT);
    pending.set(reqId, { resolve, reject, timer });
    raw(Object.assign({ t }, fields, { reqId }));
  });
}

function failPending(msg) {
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error(msg), { code: 'OFFLINE' })); }
  pending.clear();
}

/** 收到报文：先按 reqId 兑现请求，再处理快照类推送 */
function route(m) {
  if (m.reqId && pending.has(m.reqId)) {
    const p = pending.get(m.reqId);
    pending.delete(m.reqId);
    clearTimeout(p.timer);
    if (m.t === 'error') p.reject(Object.assign(new Error(m.msg || m.code || '请求失败'), { code: m.code, msg: m.msg }));
    else p.resolve(m);
    return;
  }
  /* 没有 reqId 的广播（welcome / ping / pong 等）：只做可见提示 */
  if (m.t === 'welcome') {
    if (num(m.tickMs) > 0) S.tickMs = num(m.tickMs);
    return;
  }
  if (m.t === 'error') {
    logAdd('bad', '服务端错误', '—', '—', errText({ code: m.code, msg: m.msg }));
  }
}

/* ═════════════════════════ 2. 鉴权 ═════════════════════════ */

function safeGetKey() {
  try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; }
}
function safeSetKey(k) {
  try { if (k) localStorage.setItem(STORAGE_KEY, k); else localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 隐私模式忽略 */ }
}

async function doAuth(key, silent) {
  const k = String(key || '').trim();
  if (!k) { setGateError('请输入管理密钥'); return false; }
  S.pendingKey = k;
  if (!isOpen()) { connect(); return false; }
  try {
    const m = await request('admin:auth', { key: k });
    S.key = k;
    S.authed = true;
    safeSetKey(k);
    setGateError('');
    hideGate();
    syncKeyInputs();
    applySnapshot(m);
    startPolling();
    if (!silent) logAdd('info', '鉴权成功', '运维控制台', '—', `在线 ${S.online} · 对局 ${S.rooms.length}`);
    return true;
  } catch (err) {
    S.authed = false;
    showGate();
    const txt = errText(err);
    setGateError(err.code === 'ADMIN_DENIED' ? '管理密钥不正确' : txt);
    logAdd('bad', '鉴权失败', '运维控制台', '—', txt);
    syncKeyInputs();
    return false;
  }
}

function disconnect() {
  S.userClosed = true;
  S.authed = false;
  S.key = '';
  S.pendingKey = '';
  clearTimeout(S.retryTimer);
  stopPolling();
  failPending('已断开连接');
  try { if (S.ws) S.ws.close(1000, 'admin close'); } catch (e) { /* ignore */ }
  S.ws = null;
  setConn('closed');
  showGate();
  setGateError('');
  updateGateFoot();
  syncKeyInputs();
  logAdd('warn', '已断开', '运维控制台', '—', '连接已关闭');
}

/* ═════════════════════════ 3. 快照 ═════════════════════════ */

/** 判定一条报文是否携带完整快照：admin:state / admin:event / admin:control 都会带 */
function isSnapshotMsg(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.t === 'admin:state') return true;
  return Array.isArray(m.catalog) && !!m.movers && Array.isArray(m.rooms);
}

function applySnapshot(m) {
  if (!isSnapshotMsg(m)) return;
  S.snapshot = m;
  S.serverTime = num(m.serverTime) || Date.now();
  S.online = num(m.online);
  S.rooms = Array.isArray(m.rooms) ? m.rooms : [];
  S.indices = Array.isArray(m.indices) ? m.indices : [];
  S.special = Array.isArray(m.special) ? m.special : [];
  S.movers = {
    up: (m.movers && Array.isArray(m.movers.up)) ? m.movers.up : [],
    down: (m.movers && Array.isArray(m.movers.down)) ? m.movers.down : [],
  };
  if (Array.isArray(m.catalog) && m.catalog.length) {
    S.catalog = m.catalog;
    S.byId = new Map(S.catalog.map((e) => [e.id, e]));
  }
  buildUniverse(m);
  ensureSelection();
  S.lastSnapshotAt = Date.now();
  renderAll();
}

/** 快照里可见的个股 = movers.up + movers.down + special 去重（+ 可选的 stocks 全量字段） */
function buildUniverse(m) {
  const rows = [];
  for (const r of (m.movers && m.movers.up) || []) rows.push(r);
  for (const r of (m.movers && m.movers.down) || []) rows.push(r);
  for (const r of m.special || []) rows.push(r);
  if (Array.isArray(m.stocks)) for (const r of m.stocks) rows.push(r);
  const map = new Map();
  for (const r of rows) {
    if (!r || !r.id) continue;
    const old = map.get(r.id);
    map.set(r.id, old ? Object.assign({}, old, r) : r);
  }
  S.universe = map;
  const secs = new Set();
  for (const r of map.values()) if (r.sector) secs.add(r.sector);
  S.sectorNames = Array.from(secs).sort((a, b) => String(a).localeCompare(String(b), 'zh'));
}

/**
 * 维护选中项。
 * ⚠️ 关键安全约定：个股选中一旦确立就**不自动跳走**。
 *   admin:state 只给涨榜 / 跌榜各 8 条，个股随时可能掉出这个篮子；
 *   若此时回落到「涨榜第一只」，运营刚瞄准的目标会被悄悄换掉，
 *   一不留神就把事件投给了另一只股票。因此掉出篮子时保留选中，
 *   用最后一次已知快照继续显示（并标注「快照未含」）。
 */
function ensureSelection() {
  if (S.mode === 'stock') {
    if (S.stockId) {
      const row = S.universe.get(S.stockId);
      if (row) S.selectedRow = row;          // 仍在篮子内：刷新最新行情
      return;                                // 掉出篮子：保留选中与最后已知数据
    }
    const first = S.movers.up[0] || S.movers.down[0] || (S.universe.size ? S.universe.values().next().value : null);
    S.stockId = first ? first.id : null;
    S.selectedRow = first || null;
  } else if (S.mode === 'sector') {
    if (S.sector && S.sectorNames.indexOf(S.sector) >= 0) return;
    S.sector = S.sectorNames[0] || '';
  }
}

/** 当前选中个股：{ id, row, stale }；stale=本帧快照已不含它（用最后已知数据） */
function currentStock() {
  if (!S.stockId) return null;
  const live = S.universe.get(S.stockId);
  if (live) { S.selectedRow = live; return { id: S.stockId, row: live, stale: false }; }
  return { id: S.stockId, row: S.selectedRow, stale: true };
}

function selectStock(id, opts) {
  if (!id) return;
  S.mode = 'stock';
  S.stockId = id;
  const row = S.universe.get(id);
  if (row) S.selectedRow = row;
  if (!opts || opts.scroll !== false) scrollStockIntoView(id);
  renderAll();
}

/* ══════════════════ 3.5 停牌 / 托底状态（含本地兜底）══════════════════
   服务端 _adminState 读的是 st.haltedUntil，而 mk.getState() 返回的是**快照副本**，
   副本上并没有 haltedUntil 字段（真正的字段叫 halted / haltTicksLeft / floored），
   于是 admin:state 里所有个股的 halted / floor 恒为 false、special 恒为空。
   这是服务端既有实现的问题（本任务禁止改已有文件），控制台这样兜底：
     ① 优先读 r.halted / r.floored / r.haltTicksLeft（服务端修好后自动生效）
     ② 本会话投放过的停牌 / 托底记进 S.local，按 tickMs 折算到期时间并显示剩余 tick
     ③ 两者取并集，界面明确标注哪部分是本控制台的本地估算                        */

/** 本地：某只股票的停牌剩余 tick（0 = 无） */
function localHaltLeft(id) {
  const until = S.local.halt.get(id);
  if (!until) return 0;
  const leftMs = until - Date.now();
  if (leftMs <= 0) { S.local.halt.delete(id); return 0; }
  return Math.max(1, Math.ceil(leftMs / Math.max(50, S.tickMs)));
}
/** 本地：某只股票的托底剩余 tick（个股托底或全市场救市；0 = 无） */
function localFloorLeft(id) {
  let until = S.local.floor.get(id) || 0;
  if (S.local.marketFloorUntil > until) until = S.local.marketFloorUntil;
  if (!until) return 0;
  const leftMs = until - Date.now();
  if (leftMs <= 0) { S.local.floor.delete(id); return 0; }
  return Math.max(1, Math.ceil(leftMs / Math.max(50, S.tickMs)));
}
/** 某只股票的行政状态（快照优先，本地兜底） */
function stockFlags(r) {
  if (!r || !r.id) return { halted: false, floor: false, haltLeft: 0, floorLeft: 0, local: false, snapshot: false };
  const snapHalt = !!(r.halted || r.haltedUntil);
  const snapFloor = !!(r.floor || r.floored || r.floorUntil);
  const hLeft = num(r.haltTicksLeft);
  const fLeft = num(r.floorTicksLeft);
  const lHalt = localHaltLeft(r.id);
  const lFloor = localFloorLeft(r.id);
  const halted = snapHalt || lHalt > 0;
  const floor = snapFloor || lFloor > 0;
  return {
    halted, floor,
    haltLeft: snapHalt ? (hLeft || lHalt) : lHalt,
    floorLeft: snapFloor ? (fLeft || lFloor) : lFloor,
    local: !snapHalt && !snapFloor && (lHalt > 0 || lFloor > 0),
    snapshot: snapHalt || snapFloor,
  };
}
/** 本地登记一次行政投放的结果（只认本控制台发出的指令） */
function trackPolicy(ev, target, applied) {
  const tickMs = Math.max(50, S.tickMs);
  const anyFloor = !!(applied && applied.some((a) => num(a.floorTicks) > 0));
  const anyHalt = !!(applied && applied.some((a) => num(a.haltTicks) > 0));
  if (ev.id === 'halt' && target.stockId) {
    const ticks = S.ticks > 0 ? S.ticks : (num(ev.haltTicks) || 60);
    S.local.halt.set(target.stockId, Date.now() + ticks * tickMs);
  } else if (ev.id === 'rescue' || (anyFloor && ev.scope === 'market')) {
    const ticks = S.ticks > 0 ? S.ticks : (num(ev.floorTicks) || 120);
    S.local.marketFloorUntil = Date.now() + ticks * tickMs;
  } else if (ev.clear) {
    if (ev.scope === 'market') { S.local.halt.clear(); S.local.floor.clear(); S.local.marketFloorUntil = 0; }
    else if (target.stockId) { S.local.halt.delete(target.stockId); S.local.floor.delete(target.stockId); }
  } else if (anyHalt && target.stockId) {
    const ticks = S.ticks > 0 ? S.ticks : 60;
    S.local.halt.set(target.stockId, Date.now() + ticks * tickMs);
  }
}

/** 「特殊状态」= 快照 special ∪ 快照里带标记的个股 ∪ 本地登记的个股 */
function specialRows() {
  const out = [];
  const seenId = new Set();
  const push = (r) => {
    if (!r || !r.id || seenId.has(r.id)) return;
    const f = stockFlags(r);
    if (!f.halted && !f.floor) return;
    seenId.add(r.id);
    out.push(Object.assign({}, r, { _flags: f }));
  };
  for (const r of S.special) push(r);
  for (const r of S.universe.values()) push(r);
  if (S.stockId && S.selectedRow) push(S.selectedRow);
  for (const id of S.local.halt.keys()) {
    if (seenId.has(id)) continue;
    push(S.selectedRow && S.selectedRow.id === id ? S.selectedRow : { id, name: id });
  }
  return out;
}

/* ═════════════════════════ 4. 轮询 ═════════════════════════ */

function startPolling() {
  stopPolling();
  if (document.hidden || !S.authed) return;
  S.pollTimer = setInterval(() => { void pollOnce(); }, POLL_MS);
}
function stopPolling() {
  if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = 0; }
}

async function pollOnce() {
  if (!S.authed || document.hidden || !isOpen()) return null;
  if (S.pollInFlight) return null;
  S.pollInFlight = true;
  try {
    const m = await request('admin:state', { key: S.key });
    applySnapshot(m);
    return m;
  } catch (err) {
    if (err && err.code === 'OFFLINE') return null;      // 断线由 onclose 处理
    logAdd('bad', '刷新失败', 'admin:state', '—', errText(err));
    return null;
  } finally {
    S.pollInFlight = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopPolling(); return; }
  if (S.authed) { void pollOnce(); startPolling(); }
});

/* ═════════════════════════ 5. 投放事件 ═════════════════════════ */

function targetInfo() {
  if (S.mode === 'market') return { mode: 'market', label: '全市场', short: '全市场', stockId: null, sector: null };
  if (S.mode === 'sector') {
    return { mode: 'sector', label: S.sector ? S.sector + ' 板块' : '（未选板块）', short: S.sector || '板块', stockId: null, sector: S.sector || null };
  }
  const cur = currentStock();
  const s = cur && cur.row;
  const label = s ? `${s.name}（${s.id}）` : (S.stockId || '（未选个股）');
  return { mode: 'stock', label, short: s ? s.name : (S.stockId || '个股'), stockId: S.stockId, sector: null };
}

async function fireEvent(ev) {
  if (!ev) return;
  if (!S.authed) { logAdd('bad', ev.name, '—', '—', '尚未鉴权'); return; }
  if (!isOpen()) { logAdd('bad', ev.name, '—', '—', '未连接服务端'); return; }
  if (S.inFlight || Date.now() < S.busyUntil) { logAdd('warn', ev.name, '—', '—', '上一次投放尚未结束'); return; }

  const t = targetInfo();
  if (ev.scope === 'stock' && !t.stockId) { logAdd('bad', ev.name, '—', '—', '请先选择个股'); return; }
  if (ev.scope === 'sector' && !t.sector) { logAdd('bad', ev.name, '—', '—', '请先选择板块'); return; }

  if (isDangerous(ev)) {
    const ok = window.confirm(`确认对「${t.label}」投放危险事件「${ev.name}」？\n\n${ev.desc || ''}\n强度 ${S.strength.toFixed(1)}×`);
    if (!ok) { logAdd('warn', ev.name, t.label, '—', '已取消'); return; }
  }

  const fields = { key: S.key, eventId: ev.id, strength: S.strength, ticks: S.ticks };
  if (ev.scope === 'stock') fields.stockId = t.stockId;
  if (ev.scope === 'sector') fields.sector = t.sector;

  S.inFlight = true;
  renderOps();
  try {
    const m = await request('admin:event', fields, EVENT_TIMEOUT);
    const applied = Array.isArray(m.applied) ? m.applied : [];
    /* 先登记停牌 / 托底（服务端快照不带这些状态），再套用快照让界面立刻反映 */
    S.lastEvent = m;
    trackPolicy(ev, t, applied);
    applySnapshot(m);
    const nTargets = applied.reduce((a, r) => a + num(r.targets), 0);
    logAdd('ok', ev.name, t.label, `${applied.length} 局 / ${nTargets} 目标`,
      `成功 · 强度 ${S.strength.toFixed(1)}×${S.ticks ? ' · ' + S.ticks + ' tick' : ''}`);
    if (m.news && m.news.title) {
      logAdd('news', m.news.title, m.news.predict || '', m.news.sector || (m.news.stockId ? String(m.news.stockId) : '全市场'), m.news.level === 'hot' ? '快讯' : '资讯');
    }
    S.doneEvent = { id: ev.id, until: Date.now() + DONE_FLASH_MS };
    S.busyUntil = Date.now() + DONE_FLASH_MS;
    window.setTimeout(() => { S.doneEvent = null; renderOps(); }, DONE_FLASH_MS + 30);
  } catch (err) {
    const txt = errText(err);
    logAdd('bad', ev.name, t.label, '—', txt);
    if (err && err.code === 'RATE_LIMITED') { S.busyUntil = Date.now() + DONE_FLASH_MS; window.setTimeout(() => renderOps(), DONE_FLASH_MS + 30); }
  } finally {
    S.inFlight = false;
    renderOps();
  }
}

/* ═════════════════════════ 6. 日志 ═════════════════════════ */

const logEntries = [];

function logAdd(kind, name, target, effect, result) {
  logEntries.unshift({ kind: kind || 'info', time: fmtClock(Date.now()), name: String(name == null ? '' : name), target: String(target == null ? '' : target), effect: String(effect == null ? '' : effect), result: String(result == null ? '' : result) });
  if (logEntries.length > LOG_MAX) logEntries.length = LOG_MAX;
  renderLog();
}

function logRow(e) {
  const row = el('div', 'adm-logrow adm-log-' + e.kind);
  row.appendChild(el('span', 'adm-log-time', e.time));
  row.appendChild(el('span', 'adm-log-name', e.name));
  row.appendChild(el('span', 'adm-log-target', e.target));
  row.appendChild(el('span', 'adm-log-effect', e.effect));
  row.appendChild(el('span', 'adm-log-result', e.result));
  return row;
}

function renderLog() {
  const host = $('#logList');
  if (!host) return;
  const keep = (host.scrollTop > 4) ? host.scrollTop : 0;
  clear(host);
  const frag = document.createDocumentFragment();
  for (const e of logEntries) frag.appendChild(logRow(e));
  host.appendChild(frag);
  if (keep) host.scrollTop = keep;
  const cnt = $('#logCount');
  if (cnt) cnt.textContent = logEntries.length + ' 条';
}

/* ═════════════════════════ 7. 渲染 ═════════════════════════ */

function renderAll() {
  renderTop();
  renderLeft();
  renderMid();
  renderRight();
  const app = $('#adminApp');
  if (app) app.dataset.authed = S.authed ? '1' : '0';
}

/* ── 顶栏 ── */
function renderTop() {
  const dot = $('#connDot');
  const txt = $('#connText');
  if (dot) dot.className = 'adm-dot ' + (S.conn === 'open' ? 'is-open' : S.conn === 'connecting' ? 'is-connecting' : 'is-closed');
  if (txt) {
    txt.textContent = S.conn === 'open'
      ? (S.authed ? '已连接 · 已鉴权' : '已连接 · 待鉴权')
      : S.conn === 'connecting' ? '连接中…'
        : S.conn === 'closed' ? (S.userClosed ? '已断开' : '已断开 · 重连中') : '未连接';
  }
  const on = $('#statOnline'); if (on) on.textContent = S.snapshot ? String(S.online) : '–';
  const rm = $('#statRooms'); if (rm) rm.textContent = S.snapshot ? String(S.rooms.length) : '–';
  const ck = $('#statClock'); if (ck) ck.textContent = S.snapshot ? fmtClock(S.serverTime) : '--:--:--';
  const mrSub = $('#marketRowSub');
  if (mrSub) mrSub.textContent = S.catalog.length ? `${S.catalog.filter((e) => e.scope === 'market').length} 项宏观事件` : '宏观事件';
  updateGateFoot();
}

/* ── 左栏 ── */
function filteredStocks() {
  const q = S.search.trim().toLowerCase();
  const list = [];
  for (const r of S.universe.values()) {
    if (S.sectorFilter && r.sector !== S.sectorFilter) continue;
    if (S.onlySpecial && !(r.halted || r.floor)) continue;
    if (q) {
      const hay = (String(r.id) + ' ' + String(r.name || '')).toLowerCase();
      if (hay.indexOf(q) < 0) continue;
    }
    list.push(r);
  }
  list.sort((a, b) => num(b.chg) - num(a.chg));
  return list;
}

function renderLeft() {
  /* 板块下拉（保留当前选择） */
  const sel = $('#sectorSelect');
  if (sel) {
    const want = S.sectorFilter;
    clear(sel);
    sel.appendChild(el('option', null, '全部板块'));
    sel.firstChild.value = '';
    for (const s of S.sectorNames) {
      const o = el('option', null, s);
      o.value = s;
      sel.appendChild(o);
    }
    sel.value = S.sectorNames.indexOf(want) >= 0 ? want : '';
    S.sectorFilter = sel.value;
  }

  const list = filteredStocks();
  const host = $('#stockList');
  const keep = host ? host.scrollTop : 0;
  if (host) {
    clear(host);
    if (!list.length) {
      host.appendChild(el('div', 'adm-empty', S.universe.size ? '没有符合筛选条件的股票' : '快照暂无个股数据（等一局进行中的对局）'));
    } else {
      const frag = document.createDocumentFragment();
      for (const r of list) frag.appendChild(stockRow(r));
      host.appendChild(frag);
      host.scrollTop = keep;
    }
  }
  const cnt = $('#stockCount');
  if (cnt) cnt.textContent = list.length === S.universe.size ? `${list.length} 只` : `${list.length} / ${S.universe.size} 只`;

  const mr = $('#marketRow');
  if (mr) mr.classList.toggle('is-active', S.mode === 'market');
}

function stockRow(r) {
  const btn = el('button', 'adm-stockrow');
  btn.type = 'button';
  btn.dataset.id = r.id;
  btn.setAttribute('role', 'option');
  const f = stockFlags(r);
  if (f.halted) btn.classList.add('is-halted');
  if (S.mode === 'stock' && S.stockId === r.id) { btn.classList.add('is-active'); btn.setAttribute('aria-selected', 'true'); }

  btn.appendChild(el('span', 'c-code', r.id));
  const name = el('span', 'c-name', r.name || r.id);
  if (f.halted) name.appendChild(el('span', 'adm-tag adm-tag-halt', f.haltLeft ? '停牌 ' + f.haltLeft : '停牌'));
  if (f.floor) name.appendChild(el('span', 'adm-tag adm-tag-floor', f.floorLeft ? '托底 ' + f.floorLeft : '托底'));
  btn.appendChild(name);
  btn.appendChild(el('span', 'c-price', fmtPrice(r.p)));
  const chg = el('span', 'c-chg ' + signCls(r.chg), fmtPct(r.chg));
  btn.appendChild(chg);
  btn.title = `${r.name || r.id}（${r.id}）${r.sector ? ' · ' + r.sector : ''}\n现价 ${fmtPrice(r.p)}  涨跌 ${fmtPct(r.chg)}  内在价值 ${fmtPrice(r.fair)}`;
  btn.addEventListener('click', () => selectStock(r.id, { scroll: false }));
  return btn;
}

function scrollStockIntoView(id) {
  const host = $('#stockList');
  if (!host) return;
  const node = host.querySelector('.adm-stockrow[data-id="' + cssEscape(id) + '"]');
  if (node && node.scrollIntoView) { try { node.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } }
}
function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

/* ── 中栏 ── */
function renderMid() {
  renderModeTabs();
  renderTarget();
  renderControls();
  renderOps();
}

function renderModeTabs() {
  const host = $('#modeTabs');
  if (!host) return;
  for (const b of host.querySelectorAll('.adm-tab')) {
    b.classList.toggle('is-active', b.dataset.mode === S.mode);
  }
  const mr = $('#marketRow');
  if (mr) mr.classList.toggle('is-active', S.mode === 'market');
}

function kv(k, v, cls, id) {
  const box = el('div', 'adm-kv');
  box.appendChild(el('span', 'adm-kv-k', k));
  const val = el('span', 'adm-kv-v' + (cls ? ' ' + cls : ''), v);
  if (id) val.id = id;
  box.appendChild(val);
  return box;
}

function renderTarget() {
  const host = $('#targetCard');
  if (!host) return;
  clear(host);

  if (S.mode === 'market') {
    const main = el('div', 'adm-target-main');
    const nm = el('div', 'adm-target-name');
    nm.appendChild(el('span', null, '全市场'));
    nm.id = 'targetName';
    main.appendChild(nm);
    const code = el('div', 'adm-target-code', `宏观事件作用于所有进行中对局 · 可见 ${S.universe.size} 只个股`);
    code.id = 'targetCode';
    main.appendChild(code);
    host.appendChild(main);

    const stats = el('div', 'adm-target-stats');
    stats.appendChild(kv('进行中对局', String(S.rooms.length), 'small', 'targetRooms'));
    stats.appendChild(kv('覆盖指数', String(S.indices.length), 'small', 'targetIdx'));
    stats.appendChild(kv('在线人数', String(S.online), 'small', 'targetOnline'));
    host.appendChild(stats);

    host.appendChild(el('div', 'adm-target-note', '全市场模式只显示 scope=market 的操作；「国家队救市」可用下方「时长」指定托底 tick。'));
    return;
  }

  if (S.mode === 'sector') {
    const main = el('div', 'adm-target-main');
    const nm = el('div', 'adm-target-name');
    nm.appendChild(el('span', null, S.sector || '（未选板块）'));
    nm.id = 'targetName';
    main.appendChild(nm);
    const n = S.sector ? Array.from(S.universe.values()).filter((r) => r.sector === S.sector).length : 0;
    const code = el('div', 'adm-target-code', `板块事件 · 快照内可见 ${n} 只成分股（服务端按板块全量施加）`);
    code.id = 'targetCode';
    main.appendChild(code);
    host.appendChild(main);

    const wrap = el('div', 'adm-target-stats');
    const label = el('div', 'adm-kv');
    label.appendChild(el('span', 'adm-kv-k', '目标板块'));
    const ssel = el('select', 'adm-input adm-select');
    ssel.id = 'targetSector';
    if (!S.sectorNames.length) { const o = el('option', null, '（快照暂无板块）'); o.value = ''; ssel.appendChild(o); }
    for (const s of S.sectorNames) {
      const o = el('option', null, s + `（${Array.from(S.universe.values()).filter((r) => r.sector === s).length}）`);
      o.value = s;
      ssel.appendChild(o);
    }
    ssel.value = S.sector;
    ssel.addEventListener('change', () => { S.sector = ssel.value; renderMid(); });
    label.appendChild(ssel);
    wrap.appendChild(label);
    host.appendChild(wrap);
    return;
  }

  /* 个股模式 */
  const cur = currentStock();
  const s = cur && cur.row;
  if (!s) {
    const main = el('div', 'adm-target-main');
    const nm = el('div', 'adm-target-name', '未选择个股');
    nm.id = 'targetName';
    main.appendChild(nm);
    const code = el('div', 'adm-target-code', '请在左栏点击任意股票');
    code.id = 'targetCode';
    main.appendChild(code);
    host.appendChild(main);
    host.appendChild(el('div', 'adm-target-note', '若服务端当前没有进行中的对局，admin:state 不会返回任何个股。'));
    return;
  }

  const f = stockFlags(s);
  const main = el('div', 'adm-target-main');
  const nm = el('div', 'adm-target-name');
  nm.id = 'targetName';
  nm.appendChild(el('span', null, s.name || s.id));
  if (cur.stale) nm.appendChild(el('span', 'adm-tag adm-tag-stale', '快照未含'));
  if (f.halted) nm.appendChild(el('span', 'adm-tag adm-tag-halt', f.haltLeft ? '停牌 ' + f.haltLeft + 't' : '停牌'));
  if (f.floor) nm.appendChild(el('span', 'adm-tag adm-tag-floor', f.floorLeft ? '托底 ' + f.floorLeft + 't' : '托底'));
  main.appendChild(nm);
  const code = el('div', 'adm-target-code', `${s.id}${s.sector ? ' · ' + s.sector : ''}`);
  code.id = 'targetCode';
  main.appendChild(code);
  host.appendChild(main);

  const stats = el('div', 'adm-target-stats');
  stats.appendChild(kv('现价', fmtPrice(s.p), signCls(s.chg) + (cur.stale ? ' adm-stale' : ''), 'targetPrice'));
  stats.appendChild(kv('涨跌幅', fmtPct(s.chg), signCls(s.chg) + (cur.stale ? ' adm-stale' : ''), 'targetChg'));
  stats.appendChild(kv('内在价值', fmtPrice(s.fair), 'small' + (cur.stale ? ' adm-stale' : ''), 'targetFair'));
  const flagTxt = [
    f.halted ? '停牌中（剩 ' + f.haltLeft + ' tick）' : '',
    f.floor ? '托底中（剩 ' + f.floorLeft + ' tick）' : '',
  ].filter(Boolean).join(' + ') || '正常交易';
  stats.appendChild(kv('状态', flagTxt, 'small', 'targetFlags'));
  host.appendChild(stats);

  const note = cur.stale
    ? '该股已掉出本帧快照的涨 / 跌榜，价格显示为最后一次已知值（选中不会自动跳走，避免误投）。事件依然作用于所有进行中对局的这只股票。'
    : (f.local
      ? '剩余 tick 由本控制台按 welcome.tickMs 本地估算：服务端 admin:state 的 halted / floor / special 恒为空（net.js 在 getState() 快照副本上读了不存在的 haltedUntil 字段），服务端修好后本页自动改用服务端数据。'
      : (f.halted || f.floor
        ? '状态与剩余 tick 来自服务端快照。'
        : '个股事件作用于所有进行中对局里的这只股票。快照只给涨 / 跌榜各 8 条，选中后保持稳定。'));
  host.appendChild(el('div', 'adm-target-note', note));
}

function renderControls() {
  const r = $('#strengthRange');
  if (r) { r.value = String(S.strength); r.disabled = !S.authed; }
  const sv = $('#strengthVal');
  if (sv) sv.textContent = S.strength.toFixed(1) + '×';

  const t = $('#ticksInput');
  /* 时长只对「临时停牌」（个股）与「国家队救市」（全市场）有意义 */
  const ticksUsable = S.mode === 'stock' || S.mode === 'market';
  if (t) {
    t.value = String(S.ticks);
    t.disabled = !S.authed || !ticksUsable;
    t.title = ticksUsable ? '覆盖默认时长（tick）；0 = 用目录默认值' : '当前目标没有用到时长的事件';
  }
  const hint = $('#ticksHint');
  if (hint) {
    hint.textContent = !ticksUsable
      ? '板块事件不使用时长'
      : S.mode === 'stock' ? 'tick（停牌，0=默认 60）' : 'tick（救市托底，0=默认 120）';
  }
}

function renderOps() {
  const host = $('#opGroups');
  if (!host) return;
  const keep = host.scrollTop;
  clear(host);

  const scope = S.mode === 'sector' ? 'sector' : S.mode === 'market' ? 'market' : 'stock';
  const list = S.catalog.filter((e) => e.scope === scope);
  const hint = $('#opsHint');
  if (hint) hint.textContent = `scope=${scope} · ${list.length} 项`;

  if (!S.authed) { host.appendChild(el('div', 'adm-empty', '未鉴权：请输入管理密钥')); return; }
  if (!S.catalog.length) { host.appendChild(el('div', 'adm-empty', '尚未收到事件目录（admin:state.catalog）')); return; }

  const groups = [];
  const map = new Map();
  for (const e of list) {
    const g = e.group || '其它';
    if (!map.has(g)) { map.set(g, []); groups.push(g); }
    map.get(g).push(e);
  }
  if (!groups.length) { host.appendChild(el('div', 'adm-empty', '当前目标类型没有可用操作')); return; }

  const busy = S.inFlight || Date.now() < S.busyUntil;
  const frag = document.createDocumentFragment();
  for (const g of groups) {
    const block = el('div', 'adm-group');
    const title = el('div', 'adm-group-title');
    title.appendChild(el('span', null, g));
    title.appendChild(el('span', 'adm-group-count', `${map.get(g).length} 项`));
    block.appendChild(title);
    const grid = el('div', 'adm-opgrid');
    for (const ev of map.get(g)) grid.appendChild(opButton(ev, busy));
    block.appendChild(grid);
    frag.appendChild(block);
  }
  host.appendChild(frag);
  host.scrollTop = keep;
}

function opButton(ev, busy) {
  const b = el('button', 'adm-op ' + (num(ev.dir) < 0 ? 'is-bad' : 'is-good'));
  b.type = 'button';
  b.dataset.event = ev.id;
  b.dataset.scope = ev.scope;
  b.title = (ev.desc || ev.name) + `\n作用域：${ev.scope} · 冲击 ${(num(ev.impact) * 100).toFixed(0)}%`
    + (ev.fairPct ? ` · 内在价值 ${num(ev.fairPct) > 0 ? '+' : ''}${(num(ev.fairPct) * 100).toFixed(1)}%` : '')
    + (ev.haltTicks ? ` · 停牌 ${ev.haltTicks} tick` : '')
    + (ev.floorTicks ? ` · 托底 ${ev.floorTicks} tick` : '');
  if (isDangerous(ev)) b.classList.add('is-danger');
  if (busy) { b.disabled = true; b.classList.add('is-disabled'); }
  const done = S.doneEvent && S.doneEvent.id === ev.id && Date.now() < S.doneEvent.until;
  if (done) b.classList.add('is-done');

  b.appendChild(el('span', 'adm-op-icon', ev.icon || '•'));
  const nm = el('span', 'adm-op-name', done ? '已投放 ✓' : (ev.name || ev.id));
  b.appendChild(nm);
  const meta = el('span', 'adm-op-meta');
  meta.appendChild(el('span', 'adm-op-impact', `冲击 ${(num(ev.impact) * 100).toFixed(0)}%`));
  if (ev.fairPct) meta.appendChild(el('span', 'adm-op-fair', `内在 ${num(ev.fairPct) > 0 ? '+' : ''}${(num(ev.fairPct) * 100).toFixed(1)}%`));
  if (ev.haltTicks) meta.appendChild(el('span', null, `停牌 ${ev.haltTicks}t`));
  if (ev.floorTicks) meta.appendChild(el('span', null, `托底 ${ev.floorTicks}t`));
  if (ev.clear) meta.appendChild(el('span', null, '解除'));
  b.appendChild(meta);

  b.addEventListener('click', () => { void fireEvent(ev); });
  return b;
}

/* ── 右栏 ── */
function renderRight() {
  /* 指数 */
  const idx = $('#idxList');
  if (idx) {
    clear(idx);
    if (!S.indices.length) idx.appendChild(el('div', 'adm-empty', '暂无指数数据'));
    for (const i of S.indices) {
      const box = el('div', 'adm-idx');
      box.appendChild(el('div', 'adm-idx-n', i.n || i.c));
      box.appendChild(el('div', 'adm-idx-v ' + signCls(i.pct), num(i.v).toFixed(2)));
      box.appendChild(el('div', 'adm-idx-p ' + signCls(i.pct), fmtPct(i.pct)));
      idx.appendChild(box);
    }
  }

  renderMovers($('#upList'), S.movers.up);
  renderMovers($('#downList'), S.movers.down);

  /* 特殊状态（快照 ∪ 本地登记的停牌 / 托底） */
  const sp = $('#specialList');
  if (sp) {
    clear(sp);
    const rows = specialRows();
    const sc = $('#specialCount'); if (sc) sc.textContent = String(rows.length);
    if (!rows.length) {
      sp.appendChild(el('div', 'adm-empty', '当前没有停牌 / 托底的股票'));
    } else {
      for (const r of rows) sp.appendChild(specialRow(r));
      const anyLocal = rows.some((r) => r._flags && r._flags.local);
      sp.appendChild(el('div', 'adm-special-note', anyLocal
        ? '剩余 tick 为本地估算：服务端 admin:state 的 halted / floor / special 恒为空（net.js 读了 getState() 副本上不存在的 haltedUntil 字段）。'
        : '剩余 tick 来自服务端快照。'));
    }
  }

  /* 对局 */
  const rl = $('#roomList');
  if (rl) {
    clear(rl);
    const rc = $('#roomCount'); if (rc) rc.textContent = String(S.rooms.length);
    if (!S.rooms.length) {
      rl.appendChild(el('div', 'adm-empty', '暂无进行中的对局（没有可施加目标）'));
    } else {
      for (const r of S.rooms) {
        const row = el('div', 'adm-room');
        row.appendChild(el('span', 'adm-room-id', r.id || '?'));
        const b = el('span', 'adm-room-badge' + (r.status === 'playing' ? ' is-playing' : ''), r.mode || '—');
        row.appendChild(b);
        row.appendChild(el('span', null, `${num(r.players)}/${num(r.maxPlayers)} 人`));
        if (r.paused) row.appendChild(el('span', 'adm-room-badge is-paused', '已暂停'));
        if (num(r.breakLeftSec) > 0) row.appendChild(el('span', 'adm-room-badge is-break', `休市 ${num(r.breakLeftSec)}s`));
        const meta = el('span', 'adm-room-meta',
          `剩 ${fmtDur(r.endsInSec)}${r.vclock ? ' · ' + r.vclock : ''} · 1分=${num(r.secondsPerMinute) || 5}s`
          + (num(r.dayIndex) > 0 ? ' · D' + (num(r.dayIndex) + 1) : ''));
        row.appendChild(meta);
        rl.appendChild(row);
      }
    }
  }

  renderGameCtrl();
}

/* ── 右栏 · 对局控制（暂停 / 调速 / 休市 / 跳日）── */
const SPEED_PRESETS = [1, 2, 5, 10, 30];

function ctrlTargetRoom() {
  if (!S.ctrlRoom) return null;
  return S.rooms.find((r) => r.id === S.ctrlRoom) || null;
}

function renderGameCtrl() {
  const host = $('#gameCtrl');
  if (!host) return;
  const rooms = S.rooms;
  const cur = ctrlTargetRoom() || rooms[0] || null;
  const disabled = !S.authed || !rooms.length || S.ctrlBusy;

  /* 作用域下拉：全部对局 / 指定某一局 */
  const sel = $('#ctrlRoom');
  if (sel) {
    const want = S.ctrlRoom;
    clear(sel);
    const all = el('option', null, `全部进行中对局（${rooms.length}）`);
    all.value = '';
    sel.appendChild(all);
    for (const r of rooms) {
      const o = el('option', null, `${r.id} · ${r.mode || ''} · ${num(r.players)}人`);
      o.value = r.id;
      sel.appendChild(o);
    }
    sel.value = rooms.some((r) => r.id === want) ? want : '';
    S.ctrlRoom = sel.value;
    sel.disabled = !S.authed || !rooms.length;
  }

  /* 暂停 / 继续 */
  const pb = $('#btnPause');
  if (pb) {
    const paused = !!(cur && cur.paused);
    pb.textContent = paused ? '▶ 继续' : '⏸ 暂停';
    pb.dataset.action = paused ? 'resume' : 'pause';
    pb.className = 'adm-btn' + (paused ? ' adm-btn-warn is-on' : '');
    pb.disabled = disabled;
    pb.title = paused ? '继续本局（resume）' : '暂停本局（pause，需二次确认）';
  }
  const ps = $('#ctrlPauseState');
  if (ps) {
    ps.textContent = !rooms.length ? '无对局' : (cur && cur.paused ? '已暂停' : '运行中');
    ps.className = 'adm-ctrl-state ' + (cur && cur.paused ? 'is-paused' : 'is-running');
  }

  /* 速度预设 + 自定义 */
  const sw = $('#speedBtns');
  if (sw) {
    const curSec = cur ? (num(cur.secondsPerMinute) || 5) : 5;
    clear(sw);
    for (const v of SPEED_PRESETS) {
      const b = el('button', 'adm-speedbtn' + (v === curSec ? ' is-active' : ''), String(v));
      b.type = 'button';
      b.dataset.speed = String(v);
      b.disabled = disabled;
      b.title = `1 个虚拟分钟 = ${v} 秒`;
      b.addEventListener('click', () => { void sendControl('speed', { secondsPerMinute: v }, '调速'); });
      sw.appendChild(b);
    }
  }
  /* 当前速度文案：「1 虚拟分钟 = N 秒」 */
  const stxt = $('#speedText');
  if (stxt) {
    const sec = cur ? String(num(cur.secondsPerMinute) || 5) : null;
    clear(stxt);
    if (sec) {
      stxt.appendChild(document.createTextNode('1 虚拟分钟 = '));
      const b = el('b', 'adm-speedval', sec);
      b.id = 'speedVal';
      stxt.appendChild(b);
      stxt.appendChild(document.createTextNode(' 秒'));
    } else {
      stxt.appendChild(document.createTextNode('无进行中对局'));
    }
  }
  const sc = $('#speedCustom');
  if (sc) {
    sc.disabled = disabled;
    if (!disabled && document.activeElement !== sc) sc.value = String(cur ? (num(cur.secondsPerMinute) || 5) : 5);
  }
  const sbtn = $('#speedApply');
  if (sbtn) sbtn.disabled = disabled;

  /* 午间休市 */
  const bs = $('#breakSec');
  if (bs) bs.disabled = disabled;
  const bb = $('#btnBreak');
  if (bb) bb.disabled = disabled;
  const be = $('#btnEndBreak');
  if (be) be.disabled = disabled;
  const bl = $('#breakLeft');
  if (bl) {
    const left = S.rooms.reduce((a, r) => Math.max(a, num(r.breakLeftSec)), 0);
    bl.textContent = left > 0 ? `休市中 ${left}s` : '';
    bl.className = 'adm-break-left' + (left > 0 ? ' is-on' : '');
  }

  /* 下一交易日 */
  const nb = $('#btnNextDay');
  if (nb) nb.disabled = disabled;
  const di = $('#ctrlDay');
  if (di) di.textContent = cur ? `第 ${num(cur.dayIndex) + 1} 个虚拟交易日 · ${cur.vclock || ''}` : '';
}

function controlTargetLabel() {
  if (S.ctrlRoom) return S.ctrlRoom;
  return `全部对局（${S.rooms.length}）`;
}

/** 发一条 admin:control 指令（回复自带完整快照，直接应用） */
async function sendControl(action, fields, label) {
  if (!S.authed) { logAdd('bad', label || action, '—', '—', '尚未鉴权'); return null; }
  if (!isOpen()) { logAdd('bad', label || action, '—', '—', '未连接服务端'); return null; }
  if (S.ctrlBusy) { logAdd('warn', label || action, '—', '—', '上一条控制指令尚未返回'); return null; }

  const t = controlTargetLabel();
  if (action === 'pause' || action === 'nextday') {
    const tip = action === 'pause'
      ? `确认暂停「${t}」？\n\n暂停后行情与倒计时都会冻结，直到你点「继续」。`
      : `确认让「${t}」立刻跳到下一个交易日？\n\n当前交易日的持仓盈亏会立即结转，玩家会看到跳空缺口。`;
    if (!window.confirm(tip)) { logAdd('warn', label || action, t, '—', '已取消'); return null; }
  }

  S.ctrlBusy = true;
  renderGameCtrl();
  const body = Object.assign({ key: S.key, action }, fields || {});
  if (S.ctrlRoom) body.roomId = S.ctrlRoom;
  try {
    const m = await request('admin:control', body, EVENT_TIMEOUT);
    S.lastControl = m;
    applySnapshot(m);
    const results = Array.isArray(m.results) ? m.results : [];
    logAdd('ok', label || action, t, `${results.length} 局`, '成功');
    return m;
  } catch (err) {
    logAdd('bad', label || action, t, '—', errText(err));
    return null;
  } finally {
    S.ctrlBusy = false;
    renderGameCtrl();
  }
}

function renderMovers(host, rows) {
  if (!host) return;
  clear(host);
  if (!rows || !rows.length) { host.appendChild(el('div', 'adm-empty', '暂无数据')); return; }
  for (const r of rows) {
    const b = el('button', 'adm-mover');
    b.type = 'button';
    b.dataset.id = r.id;
    if (S.mode === 'stock' && S.stockId === r.id) b.classList.add('is-active');
    const nm = el('span', 'adm-mover-name', r.name || r.id);
    nm.appendChild(el('em', null, r.id));
    b.appendChild(nm);
    b.appendChild(el('span', 'adm-mover-p', fmtPrice(r.p)));
    b.appendChild(el('span', 'adm-mover-c ' + signCls(r.chg), fmtPct(r.chg)));
    b.title = `${r.name || r.id}（${r.id}）· 点击选中`;
    b.addEventListener('click', () => selectStock(r.id, { scroll: true }));
    host.appendChild(b);
  }
}

function specialRow(r) {
  const row = el('div', 'adm-specialrow');
  const f = r._flags || stockFlags(r);
  row.title = `${r.name || r.id}（${r.id}）· 点击选中`;
  if (f.halted) row.appendChild(el('span', 'adm-tag adm-tag-halt', f.haltLeft ? `停牌 ${f.haltLeft}t` : '停牌'));
  if (f.floor) row.appendChild(el('span', 'adm-tag adm-tag-floor', f.floorLeft ? `托底 ${f.floorLeft}t` : '托底'));
  row.appendChild(el('span', 'adm-specialrow-name', `${r.name || r.id} ${r.id}`));
  row.appendChild(el('span', 'adm-specialrow-p ' + signCls(r.chg), r.p != null ? fmtPrice(r.p) : '—'));
  row.addEventListener('click', () => selectStock(r.id, { scroll: true }));
  return row;
}

/* ═════════════════════════ 8. 遮罩 / 顶栏输入 ═════════════════════════ */

function showGate() { const g = $('#admGate'); if (g) g.classList.remove('is-hidden'); }
function hideGate() { const g = $('#admGate'); if (g) g.classList.add('is-hidden'); }
function setGateError(msg) {
  const e = $('#gateErr'); if (e) e.textContent = msg || '';
  const g = $('#admGate'); if (g) g.dataset.state = msg ? 'denied' : 'waiting';
}
function updateGateFoot() {
  const dot = $('#gateDot'); const t = $('#gateFoot');
  if (dot) dot.className = 'adm-dot ' + (S.conn === 'open' ? 'is-open' : S.conn === 'connecting' ? 'is-connecting' : 'is-closed');
  if (t) t.textContent = S.conn === 'open' ? '已连接服务端 ' + (location.host || '') : S.conn === 'connecting' ? '正在连接服务端…' : '服务端未连接（自动重连中）';
}
function syncKeyInputs() {
  const g = $('#gateKey'); if (g && document.activeElement !== g) g.value = S.authed ? '' : (S.pendingKey || '');
  const k = $('#keyInput'); if (k && document.activeElement !== k) k.value = S.authed ? '' : '';
}

/* ═════════════════════════ 9. 挂载 ═════════════════════════ */

function bind() {
  /* 顶栏密钥 */
  const keyInput = $('#keyInput');
  const keyApply = $('#keyApply');
  if (keyInput) {
    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void doAuth(keyInput.value); } });
  }
  if (keyApply) keyApply.addEventListener('click', () => { void doAuth(keyInput ? keyInput.value : ''); });

  const gateKey = $('#gateKey');
  const gateBtn = $('#gateBtn');
  if (gateKey) gateKey.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void doAuth(gateKey.value); } });
  if (gateBtn) gateBtn.addEventListener('click', () => { void doAuth(gateKey ? gateKey.value : ''); });

  const dis = $('#btnDisconnect');
  if (dis) dis.addEventListener('click', disconnect);

  /* 左栏筛选 */
  const search = $('#stockSearch');
  if (search) search.addEventListener('input', () => { S.search = search.value; renderLeft(); });
  const sectorSelect = $('#sectorSelect');
  if (sectorSelect) sectorSelect.addEventListener('change', () => { S.sectorFilter = sectorSelect.value; renderLeft(); });
  const onlySpecial = $('#onlySpecial');
  if (onlySpecial) onlySpecial.addEventListener('change', () => { S.onlySpecial = !!onlySpecial.checked; renderLeft(); });

  /* 全市场伪条目 */
  const mr = $('#marketRow');
  if (mr) {
    mr.addEventListener('click', () => {
      S.mode = 'market';
      renderAll();
      logAdd('info', '切换目标', '全市场', '—', '已进入全市场模式');
    });
  }

  /* 中栏模式页签 */
  const tabs = $('#modeTabs');
  if (tabs) {
    tabs.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.adm-tab') : null;
      if (!btn) return;
      S.mode = btn.dataset.mode;
      ensureSelection();
      renderAll();
    });
  }

  /* 强度 / 时长 */
  const range = $('#strengthRange');
  if (range) range.addEventListener('input', () => {
    S.strength = Math.min(1.5, Math.max(0.2, num(range.value) || DEFAULT_STRENGTH));
    const sv = $('#strengthVal'); if (sv) sv.textContent = S.strength.toFixed(1) + '×';
  });
  const ticks = $('#ticksInput');
  if (ticks) ticks.addEventListener('input', () => {
    S.ticks = Math.max(0, Math.round(num(ticks.value)));
  });

  /* 日志工具 */
  const lc = $('#logClear');
  if (lc) lc.addEventListener('click', () => { logEntries.length = 0; renderLog(); });
  const lt = $('#logToggle');
  if (lt) lt.addEventListener('click', () => {
    S.logCollapsed = !S.logCollapsed;
    const p = $('#logPanel'); if (p) p.classList.toggle('is-collapsed', S.logCollapsed);
    lt.textContent = S.logCollapsed ? '展开' : '折叠';
  });

  /* ── 对局控制（暂停 / 调速 / 休市 / 跳日）── */
  const ctrlRoomSel = $('#ctrlRoom');
  if (ctrlRoomSel) ctrlRoomSel.addEventListener('change', () => { S.ctrlRoom = ctrlRoomSel.value; renderGameCtrl(); });
  const btnPause = $('#btnPause');
  if (btnPause) btnPause.addEventListener('click', () => {
    const action = btnPause.dataset.action === 'resume' ? 'resume' : 'pause';
    void sendControl(action, {}, action === 'resume' ? '继续' : '暂停');
  });
  const applySpeed = () => {
    const inp = $('#speedCustom');
    const v = Math.max(1, Math.min(60, Math.round(num(inp && inp.value) || 5)));
    void sendControl('speed', { secondsPerMinute: v }, '调速');
  };
  const speedApply = $('#speedApply');
  if (speedApply) speedApply.addEventListener('click', applySpeed);
  const speedCustom = $('#speedCustom');
  if (speedCustom) speedCustom.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applySpeed(); } });
  const btnBreak = $('#btnBreak');
  if (btnBreak) btnBreak.addEventListener('click', () => {
    const inp = $('#breakSec');
    const sec = Math.max(1, Math.min(600, Math.round(num(inp && inp.value) || 60)));
    void sendControl('break', { seconds: sec }, '强制休市');
  });
  const btnEndBreak = $('#btnEndBreak');
  if (btnEndBreak) btnEndBreak.addEventListener('click', () => { void sendControl('endbreak', {}, '结束休市'); });
  const btnNextDay = $('#btnNextDay');
  if (btnNextDay) btnNextDay.addEventListener('click', () => { void sendControl('nextday', {}, '跳到下一交易日'); });

  window.addEventListener('beforeunload', () => { S.userClosed = true; });
}

function init() {
  const root = $('#adminApp');
  if (!root) return false;
  S.mounted = true;

  /* 控制参数初值 */
  S.strength = DEFAULT_STRENGTH;
  S.ticks = DEFAULT_TICKS;

  bind();
  showGate();
  setGateError('');
  syncKeyInputs();

  /* 先把界面渲染成空态，避免首屏空白 */
  renderAll();
  renderLog();
  logAdd('info', '控制台就绪', location.host || '', '—', '等待连接与鉴权');

  /* localStorage 里的密钥：回车提交成功后已保存，这里直接自动重连鉴权 */
  S.pendingKey = safeGetKey();
  if (S.pendingKey) { const g = $('#gateKey'); if (g) g.value = S.pendingKey; }

  connect();

  /* 顶栏时钟：每秒滴答（快照里的 serverTime 为准，本地推算） */
  window.setInterval(() => {
    if (document.hidden || !S.snapshot) return;
    const ck = $('#statClock');
    if (ck) ck.textContent = fmtClock(Date.now() + (S.lastSnapshotAt ? (S.serverTime - S.lastSnapshotAt) : 0));
  }, 1000);

  return true;
}

/* 自动挂载；被别的页面 import 时（无 #adminApp）不产生副作用 */
const mounted = init();

/* 调试 / 自动化验收钩子（只读用途为主） */
window.__admin = {
  mounted,
  state: S,
  applySnapshot,
  pollOnce,
  doAuth,
  disconnect,
  fireEvent,
  sendControl,
  selectStock,
  filteredStocks,
  specialRows,
  stockFlags,
  logAdd,
  logEntries,
  get wsUrl() { return wsUrl(); },
};

export default window.__admin;
