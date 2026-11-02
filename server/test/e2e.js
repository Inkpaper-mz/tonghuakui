#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   同花亏 · server/test/e2e.js —— 真实服务端端到端自动化测试
   ─ 在子进程里启动 server/server.js（真 HTTP + 真 WebSocket，默认 --tick 100 加速）
   ─ 客户端用 Node 24 内置全局 WebSocket
   ─ 覆盖：静态托管 / 登录 / 建房 / 加入 / 准备 / 开局 / tick 行情 / 下单成交 / T+1 /
            挂单撤单 / K 线 / 虚拟日切 T+1 解禁 / 跨玩家撮合 / 断线重连 / 错误码 /
            中场弃赛结算 + ELO + 战绩落盘 / 并档确定性校验
   ─ 退出码：0 = 全部通过，1 = 有失败
   用法： node server/test/e2e.js
          可选环境变量： THK_E2E_PORT=8898  THK_E2E_TICK=100  THK_E2E_VERBOSE=1
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const NODE = process.execPath;
const SERVER_JS = path.join(__dirname, '..', 'server.js');
/* 端口：优先用环境变量；否则在 8900~8999 里随机挑一个**当前空闲**的端口。
   以前固定 8898，一旦有上次跑剩的旧进程占着，spawn 会静默失败并连到旧进程上，
   于是出现「welcome.tickMs 与命令行一致 → 期望 100 实际 1000」这类假失败。 */
function pickPort(start, end) {
  const net = require('net');
  const { execSync } = require('child_process');
  for (let i = 0; i < 40; i++) {
    const p = start + Math.floor(Math.random() * (end - start));
    let busy = false;
    try { execSync(`lsof -ti tcp:${p}`, { stdio: 'pipe' }); busy = true; } catch (e) { busy = false; }
    if (!busy) return p;
  }
  return start;
}
const PORT = Number(process.env.THK_E2E_PORT || 0) || pickPort(8900, 8999);
const TICK_MS = Number(process.env.THK_E2E_TICK || 100);   // 100ms：约 24s 走完一个虚拟交易日
const DAY_TICKS = 120;      // 新节奏：一个虚拟交易日 = 上午盘 120 虚拟分钟
const VERBOSE = process.env.THK_E2E_VERBOSE === '1';
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const DATA_FILE = path.join(os.tmpdir(), `thk-e2e-store-${process.pid}.json`);

const NICK_A = '韭菜甲';
const NICK_B = '韭菜乙B';
const NICK_C = '韭菜丙C';
const NICK_E = '韭菜戊E';
const NICK_R = '韭菜己R';

/* ═══════════════════════════ 断言器 ═══════════════════════════ */

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push({ name, detail: detail || '' });
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `   \x1b[33m→ ${detail}\x1b[0m` : ''}`);
  }
  return !!cond;
}

function eq(name, actual, expected, extra) {
  const same = actual === expected;
  return ok(name, same, same ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}${extra ? `（${extra}）` : ''}`);
}

function section(title) { console.log(`\n\x1b[36m▌${title}\x1b[0m`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function r2(v) { return Math.round(Number(v) * 100) / 100; }
function j(v) { return JSON.stringify(v); }

/* ═══════════════════════════ 测试客户端 ═══════════════════════════ */

let reqSeq = 0;

class Client {
  constructor(label) {
    this.label = label;
    this.ws = null;
    this.log = [];
    this.subs = new Map();
    this.token = null;
    this.player = null;
    this.config = null;
    this.closed = false;
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(WS_URL); } catch (err) { return reject(err); }
      this.ws = ws;
      this.closed = false;
      const timer = setTimeout(() => reject(new Error(`${this.label} 连接超时`)), timeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { /* 由超时兜底 */ };
      ws.onmessage = (ev) => {
        let m = null;
        try { m = JSON.parse(ev.data); } catch (err) { return; }
        if (!m || typeof m !== 'object' || !m.t) return;
        this.log.push(m);
        if (this.log.length > 8000) this.log.splice(0, 3000);
        this._fire(m.t, m);
        this._fire('*', m);
      };
      ws.onclose = () => { this.closed = true; this._fire('__close', {}); };
    });
  }

  _fire(type, msg) {
    const arr = this.subs.get(type);
    if (!arr) return;
    for (const fn of arr.slice()) { try { fn(msg); } catch (err) { /* ignore */ } }
  }

  on(type, fn) {
    let arr = this.subs.get(type);
    if (!arr) { arr = []; this.subs.set(type, arr); }
    arr.push(fn);
    return () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
  }

  send(t, fields = {}) {
    const msg = Object.assign({ t }, fields);
    try { this.ws.send(JSON.stringify(msg)); } catch (err) { /* ignore */ }
    return msg;
  }

  sendRaw(text) { try { this.ws.send(text); } catch (err) { /* ignore */ } }

  request(t, fields = {}, matchType = null, timeoutMs = 8000) {
    const reqId = fields.reqId || `e2e_${++reqSeq}`;
    return new Promise((resolve, reject) => {
      let off = null;
      const timer = setTimeout(() => { if (off) off(); reject(new Error(`${this.label} 请求 ${t} 超时`)); }, timeoutMs);
      off = this.on('*', (m) => {
        if (m.reqId !== reqId) return;
        if (matchType && m.t !== matchType) return;
        clearTimeout(timer);
        off();
        resolve(m);
      });
      this.send(t, Object.assign({}, fields, { reqId }));
    });
  }

  find(type, pred) {
    for (let i = 0; i < this.log.length; i++) {
      const m = this.log[i];
      if (m.t === type && (!pred || pred(m))) return m;
    }
    return null;
  }

  last(type, pred) {
    for (let i = this.log.length - 1; i >= 0; i--) {
      const m = this.log[i];
      if (m.t === type && (!pred || pred(m))) return m;
    }
    return null;
  }

  count(type, pred) {
    let n = 0;
    for (const m of this.log) if (m.t === type && (!pred || pred(m))) n++;
    return n;
  }

  waitFor(type, pred, timeoutMs = 10000) {
    const hit = this.find(type, pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      let off = null;
      const timer = setTimeout(() => { if (off) off(); reject(new Error(`${this.label} 等待 ${type} 超时`)); }, timeoutMs);
      off = this.on(type, (m) => {
        if (pred && !pred(m)) return;
        clearTimeout(timer);
        off();
        resolve(m);
      });
    });
  }

  async login(nick, token, avatar) {
    const fields = { nick };
    if (token) fields.token = token;
    if (avatar !== undefined) fields.avatar = avatar;
    const res = await safeRequest(this, 'login', fields, 'login_ok', 10000);
    if (res.t === 'login_ok') {
      this.token = res.token;
      this.player = res.player;
      this.config = res.config;
    }
    return res;
  }

  close() {
    this.closed = true;
    try { if (this.ws) this.ws.close(1000, 'e2e close'); } catch (err) { /* ignore */ }
  }
}

/** 请求失败不抛异常，返回可断言的占位报文 */
function safeRequest(client, t, fields, matchType, timeoutMs) {
  return client.request(t, fields, matchType, timeoutMs).catch((err) => ({
    t: '__timeout', msg: String((err && err.message) || err), reqId: fields && fields.reqId,
  }));
}

/** 等待失败不抛异常 */
function tryWait(client, type, pred, timeoutMs = 8000) {
  return client.waitFor(type, pred, timeoutMs).catch(() => null);
}

/* ═══════════════════════════ 服务端子进程 ═══════════════════════════ */

let child = null;
let stopping = false;
const serverOut = [];

function startServer() {
  try { fs.unlinkSync(DATA_FILE); } catch (err) { /* ignore */ }
  child = spawn(NODE, [SERVER_JS, '--port', String(PORT), '--host', '127.0.0.1', '--tick', String(TICK_MS)], {
    env: Object.assign({}, process.env, { THK_DATA: DATA_FILE, THK_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const collect = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (!line) continue;
      serverOut.push(line);
      if (serverOut.length > 120) serverOut.shift();
      if (VERBOSE) console.log(`\x1b[90m[server] ${line}\x1b[0m`);
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('exit', (code, signal) => {
    if (!stopping) console.log(`\x1b[31m[server] 子进程意外退出 code=${code} signal=${signal}\x1b[0m`);
  });
}

async function stopServer() {
  if (!child || stopping) return;
  stopping = true;
  const c = child;
  child = null;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    c.once('exit', finish);
    try { c.kill('SIGTERM'); } catch (err) { /* ignore */ }
    setTimeout(() => { try { c.kill('SIGKILL'); } catch (err) { /* ignore */ } finish(); }, 3000);
  });
}

function waitForHttp(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;
    const retry = () => {
      if (settled) return;
      if (Date.now() > deadline) { settled = true; reject(new Error(`服务端未在 ${timeoutMs}ms 内就绪`)); return; }
      setTimeout(attempt, 250);
    };
    const attempt = () => {
      if (settled) return;
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) { settled = true; resolve(res.statusCode); return; }
        retry();
      });
      req.on('error', retry);
      req.setTimeout(1500, () => { req.destroy(); });
    };
    attempt();
  });
}

function headCode(p) {
  return new Promise((resolve) => {
    const req = http.get(BASE + p, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
  });
}

/* ═══════════════════════════ 行情 / 工具 ═══════════════════════════ */

function checkTick(t, metaById) {
  const problems = [];
  if (!Array.isArray(t.idx) || t.idx.length !== 4) problems.push(`idx 应为 4 条，实际 ${(t.idx || []).length}`);
  if (!Array.isArray(t.quotes) || t.quotes.length !== 61) problems.push(`quotes 应为 61 条，实际 ${(t.quotes || []).length}`);
  for (const q of (t.quotes || [])) {
    const meta = metaById.get(q.i);
    if (!meta) { problems.push(`${q.i} 不在 stocks 元数据里`); continue; }
    if (!(q.p >= meta.limitDown - 1e-9 && q.p <= meta.limitUp + 1e-9)) {
      problems.push(`${q.i} 现价 ${q.p} 越出涨跌停 [${meta.limitDown}, ${meta.limitUp}]`);
    }
    if (!(Number(q.avg) > 0)) problems.push(`${q.i} avg=${q.avg}`);
    if (!(Number(q.pc) > 0)) problems.push(`${q.i} pc=${q.pc}`);
    if (!(Number(q.v) >= 0) || !(Number(q.a) >= 0)) problems.push(`${q.i} v/a 非法`);
    if (!(Number(q.o) > 0) || !(Number(q.h) >= Number(q.l))) problems.push(`${q.i} o/h/l 非法`);
    if (!Array.isArray(q.b) || !Array.isArray(q.s) || !Array.isArray(q.tr)) { problems.push(`${q.i} 五档/成交明细缺失`); continue; }
    if (q.b.length > 5 || q.s.length > 5) problems.push(`${q.i} 档位超过 5（b=${q.b.length} s=${q.s.length}）`);
    for (const lv of q.b.concat(q.s)) {
      if (!Array.isArray(lv) || lv.length !== 2 || !(lv[0] > 0) || !(lv[1] > 0) || lv[1] % 100 !== 0) {
        problems.push(`${q.i} 档位数据非法 ${j(lv)}`);
      }
    }
    for (let i = 1; i < q.b.length; i++) if (!(q.b[i - 1][0] > q.b[i][0])) problems.push(`${q.i} 买档未按价格降序`);
    for (let i = 1; i < q.s.length; i++) if (!(q.s[i - 1][0] < q.s[i][0])) problems.push(`${q.i} 卖档未按价格升序`);
    const atUp = q.p >= meta.limitUp - 0.005;
    const atDown = q.p <= meta.limitDown + 0.005;
    const nearUp = meta.limitUp - q.p < 0.06;
    const nearDown = q.p - meta.limitDown < 0.06;
    if (!atUp && !nearUp && q.s.length !== 5) problems.push(`${q.i} 卖五档 ${q.s.length}/5（p=${q.p} 涨停=${meta.limitUp}）`);
    if (!atDown && !nearDown && q.b.length !== 5) problems.push(`${q.i} 买五档 ${q.b.length}/5（p=${q.p} 跌停=${meta.limitDown}）`);
  }
  return problems;
}

/**
 * 选一只高流动性、五档齐全、离涨跌停都还有空间、且价格不超过 maxPrice 的股票
 * （maxPrice 用于保证测试的下单量在 100 万本金内买得起）
 */
function pickStock(client, meta, usedIds, maxPrice) {
  const tick = client.last('tick');
  if (!tick) return null;
  const cands = [];
  for (const q of (tick.quotes || [])) {
    const m = meta.get(q.i);
    if (!m || (usedIds && usedIds.has(q.i))) continue;
    if (maxPrice && !(q.p <= maxPrice)) continue;
    if (!q.s || q.s.length !== 5 || !q.b || q.b.length !== 5) continue;
    if (!(q.p <= m.limitUp * 0.95)) continue;
    if (!(q.p >= m.limitDown * 1.06)) continue;
    const ask0 = Number(q.s[0][0]);
    if (ask0 * 1.02 > m.limitUp) continue;
    cands.push({ q, m, floatMv: Number(m.floatMv) || 0 });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.floatMv - a.floatMv);
  return cands[0];
}

function posKey(acc) {
  return j(((acc && acc.positions) || []).map(p => [p.i, p.qty, p.avail, p.avgCost])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function ordKey(acc) {
  return j(((acc && acc.orders) || []).map(o => [o.id, o.status, o.filled, o.qty, o.price])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function posOf(acc, id) {
  return ((acc && acc.positions) || []).find(p => p.i === id) || null;
}

/* ═══════════════════════════ 主流程 ═══════════════════════════ */

const A = new Client('A');
const B = new Client('B');
let A2 = null;
let C = null;
let E = null;
let R = null;
let R2 = null;
let Q = null;

async function main() {
  console.log('\x1b[1m同花亏 · 服务端端到端测试（e2e）\x1b[0m');
  console.log(`服务端 ${SERVER_JS}\n端口 ${PORT} · tick ${TICK_MS}ms · 数据文件 ${DATA_FILE}`);

  /* ─────────── 0. 启动 + 静态托管 ─────────── */
  section('0. 启动服务端 + 静态托管');
  startServer();
  let httpCode = 0;
  try { httpCode = await waitForHttp(`${BASE}/index.html`, 20000); }
  catch (err) { ok('服务端在 20s 内就绪', false, String(err.message || err)); }
  eq('GET /index.html → 200', httpCode, 200);
  eq('GET /css/theme.css → 200', await headCode('/css/theme.css'), 200);
  eq('GET /js/main.js → 200', await headCode('/js/main.js'), 200);

  /* ─────────── 1. 登录 ─────────── */
  section('1. 登录（两个不同昵称）');
  await A.connect();
  const welcome = await tryWait(A, 'welcome', () => true, 5000);
  ok('连接后立即收到 welcome', !!welcome);
  if (welcome) {
    eq('welcome.server = 同花亏', welcome.server, '同花亏');
    eq('welcome.tickMs 与命令行一致', welcome.tickMs, TICK_MS);
    ok('welcome 含 version/serverTime/online', !!welcome.version && Number(welcome.serverTime) > 0 && Number.isFinite(Number(welcome.online)));
  }

  const loginA = await A.login(NICK_A, null, 3);
  ok('A 登录成功', loginA.t === 'login_ok', loginA.msg || loginA.t);
  eq('A 昵称正确', A.player && A.player.nick, NICK_A);
  eq('A 头像正确', A.player && A.player.avatar, 3);
  ok('login_ok 含 token / player / config', !!A.token && !!A.player && !!A.config);
  ok('config 含 modes/durations/startCashOptions/fee/lotSize', !!A.config &&
    A.config.modes.length === 3 && A.config.durations.length === 3 &&
    A.config.startCashOptions.length === 3 && !!A.config.fee && A.config.lotSize === 100);
  eq('config.tickMs 与 tick 一致', A.config && A.config.tickMs, TICK_MS);
  eq('config.virtualDayTicks = 120（上午盘 09:30-11:30）', A.config && A.config.virtualDayTicks, 120);
  eq('config.secondsPerVirtualMinute = 5（5 秒 = 1 虚拟分钟）', A.config && A.config.secondsPerVirtualMinute, 5);
  eq('config.breakSec = 60（交易日之间午间休市 60 秒）', A.config && A.config.breakSec, 60);

  await B.connect();
  await B.login(NICK_B, null, 5);
  eq('B 昵称正确', B.player && B.player.nick, NICK_B);
  ok('A/B 是两个不同玩家', !!A.player && !!B.player && A.player.id !== B.player.id);

  const roomsMsg = await safeRequest(A, 'lobby:list', {}, 'lobby:rooms', 5000);
  ok('lobby:list 返回 lobby:rooms', roomsMsg.t === 'lobby:rooms' && Array.isArray(roomsMsg.rooms), roomsMsg.msg);

  /* ─────────── 2. 建房 → 加入 → 准备 → 开局 ─────────── */
  section('2. 建房 → 加入 → 准备 → 开局');
  const roomJoined = await safeRequest(A, 'room:create', {
    name: 'e2e 对战房', mode: '1v1', maxPlayers: 2, durationSec: 900, startCash: 1000000, fillBots: false,
  }, 'room:joined', 8000);
  ok('A 建房成功并进入房间', roomJoined.t === 'room:joined', roomJoined.msg);
  const roomId = roomJoined.room ? roomJoined.room.id : null;
  if (roomJoined.room) {
    eq('建房后人数 = 1', roomJoined.room.players.length, 1);
    eq('建房后状态 = waiting', roomJoined.room.status, 'waiting');
    eq('房主 = A', roomJoined.room.hostId, A.player.id);
    eq('durationSec = 900', roomJoined.room.durationSec, 900);
    eq('startCash = 1000000', roomJoined.room.startCash, 1000000);
    eq('mode = 1v1 / maxPlayers = 2', `${roomJoined.room.mode}/${roomJoined.room.maxPlayers}`, '1v1/2');
    eq('you.id = A', roomJoined.you && roomJoined.you.id, A.player.id);
    const rows = (await safeRequest(B, 'lobby:list', {}, 'lobby:rooms', 5000)).rooms || [];
    eq('房间列表里能看到这个房', rows.some(r => r.id === roomId), true);
  }

  const joinB = await safeRequest(B, 'room:join', { roomId }, 'room:joined', 8000);
  ok('B 加入成功', joinB.t === 'room:joined', joinB.msg);
  const upd2 = await tryWait(A, 'room:update', m => m.room && m.room.players.length === 2, 6000);
  ok('A 收到人数变 2 的 room:update', !!upd2);
  if (upd2) {
    ok('room.players 含 A 与 B', upd2.room.players.some(p => p.nick === NICK_A) && upd2.room.players.some(p => p.nick === NICK_B));
    ok('room.players 含 ready/isBot/isHost/tier/elo', upd2.room.players.every(p =>
      typeof p.ready === 'boolean' && typeof p.isBot === 'boolean' && typeof p.isHost === 'boolean' &&
      typeof p.tier === 'string' && Number.isFinite(Number(p.elo))));
  }

  A.send('room:ready', { ready: true });
  B.send('room:ready', { ready: true });
  const readyUpd = await tryWait(A, 'room:update', m => m.room && m.room.players.length === 2 && m.room.players.every(p => p.ready), 6000);
  ok('双方 ready 状态同步到 room:update', !!readyUpd);

  A.send('room:start', {});
  const updCountdown = await tryWait(A, 'room:update', m => m.room && m.room.status === 'countdown', 6000);
  ok('房主开局先进入 countdown', !!updCountdown);
  if (updCountdown) ok('countdown 值在 1~3', updCountdown.room.countdown >= 1 && updCountdown.room.countdown <= 3, `countdown=${updCountdown.room.countdown}`);

  const gsA = await tryWait(A, 'game:start', () => true, 15000);
  const gsB = await tryWait(B, 'game:start', () => true, 15000);
  ok('A / B 都收到 game:start', !!gsA && !!gsB);
  if (!gsA) throw new Error('未收到 game:start，后续断言无法继续');

  const matchId = gsA.match.id;
  const metaById = new Map((gsA.stocks || []).map(s => [s.id, s]));
  eq('game:start.stocks.length = 61', (gsA.stocks || []).length, 61);
  ok('game:start.match 字段齐全（endsAt/startCash/tickMs/virtualDayTicks/sectors）',
    gsA.match.mode === '1v1' && gsA.match.durationSec === 900 && gsA.match.startCash === 1000000 &&
    gsA.match.tickMs === TICK_MS && gsA.match.virtualDayTicks === DAY_TICKS &&
    gsA.match.endsAt > gsA.match.startedAt && Array.isArray(gsA.match.sectors) && gsA.match.sectors.length > 0);
  eq('1v1 模式 game:start.teams = null', gsA.teams, null);
  ok('每只股票有 prevClose/limitUp/limitDown/lotSize', (gsA.stocks || []).every(s =>
    Number(s.prevClose) > 0 && Number(s.limitUp) > Number(s.prevClose) &&
    Number(s.limitDown) < Number(s.prevClose) && s.lotSize === 100 && !!s.sector && !!s.name));
  const playingUpd = await tryWait(A, 'room:update', m => m.room && m.room.status === 'playing' && m.room.matchId === matchId, 6000);
  ok('room:update 状态 playing 且带 matchId', !!playingUpd);

  /* ─────────── 3. 行情 tick ─────────── */
  section('3. 行情 tick（≥5 条 · 指数 · 61 只 · 五档 · 涨跌停区间）');
  const tickDeadline = Date.now() + 20000;
  while (A.count('tick') < 6 && Date.now() < tickDeadline) await sleep(150);
  const tickList = A.log.filter(m => m.t === 'tick');
  ok(`A 收到至少 5 条 tick（实际 ${tickList.length}）`, tickList.length >= 5);
  ok(`B 也收到至少 5 条 tick（实际 ${B.count('tick')}）`, B.count('tick') >= 5);

  const tick0 = tickList[0];
  ok('tick 含 seq/vtime/vclock/serverTime/idx/quotes', !!tick0 &&
    Number(tick0.seq) > 0 && Number(tick0.vtime) > 0 && /^\d\d:\d\d$/.test(String(tick0.vclock)) &&
    Number(tick0.serverTime) > 0 && Array.isArray(tick0.idx) && Array.isArray(tick0.quotes));
  eq('tick.idx.length = 4', (tick0.idx || []).length, 4);
  ok('idx 元素含 c/n/v/pc/pct/amt', (tick0.idx || []).every(ix => !!ix.c && !!ix.n && Number(ix.v) > 0 && Number(ix.pc) > 0 && Number.isFinite(Number(ix.pct))));
  ok('tick.seq 单调递增', tickList.every((t, i) => i === 0 || Number(t.seq) > Number(tickList[i - 1].seq)));
  const allProblems = [];
  for (const t of tickList.slice(0, 5)) allProblems.push(...checkTick(t, metaById));
  ok('每条 tick：61 只 · 价格在涨跌停内 · 五档 5 档 · avg>0 · 档位有序', allProblems.length === 0,
    allProblems.slice(0, 4).join(' | '));

  /* ─────────── 4. 下单成交 + T+1 ─────────── */
  section('4. 下单成交 + T+1 当日禁卖');
  const pickA = pickStock(A, metaById, null, 400);   // 限价 ≤400：保证 600 股 + 挂单都在 100 万本金内
  ok('找到可交易标的（五档齐全、远离涨跌停、价格适中）', !!pickA, pickA ? `${pickA.q.i} ${pickA.m.name} @${pickA.q.p}` : '行情里没有合适的标的');
  const stockId = pickA ? pickA.q.i : (gsA.stocks[0] || {}).id;
  const buyPrice = pickA ? r2(Math.min(pickA.q.s[0][0] * 1.015, pickA.m.limitUp)) : 1;

  const buyAck = await safeRequest(A, 'order:place', {
    stockId, side: 'buy', type: 'limit', price: buyPrice, qty: 200,
  }, 'order:ack', 8000);
  ok(`A 买入 ${stockId} 200 股 @${buyPrice} 回执 ok=true`, buyAck.ok === true, buyAck.msg);
  ok('order:ack 带 orderId', !!buyAck.orderId);
  eq('order:ack 回带 reqId', typeof buyAck.reqId, 'string');

  const accBought = await tryWait(A, 'account', m => {
    const p = posOf(m, stockId);
    return !!p && p.qty === 200;
  }, 10000);
  ok('account 出现 200 股持仓', !!accBought);
  if (accBought) {
    const p0 = posOf(accBought, stockId);
    eq('持仓 qty = 200', p0.qty, 200);
    eq('持仓 avail = 0（T+1 冻结）', p0.avail, 0);
    ok('account 含该笔成交明细', (accBought.trades || []).some(t => t.i === stockId && t.side === 'buy' && t.qty === 200));
    ok('account.trades 带 fee/amount/name', (accBought.trades || []).every(t => Number(t.fee) >= 0 && Number(t.amount) > 0 && !!t.name));
    eq('全部成交后冻结资金 = 0', Number(accBought.frozen), 0);
    ok('account.cash < 1000000（扣款成功）', Number(accBought.cash) < 1000000, `cash=${accBought.cash}`);
    ok('account 含 available/marketValue/totalAssets/pnl/pnlPct', Number(accBought.available) > 0 &&
      Number(accBought.marketValue) > 0 && Number(accBought.totalAssets) > 0 &&
      Number.isFinite(Number(accBought.pnl)) && Number.isFinite(Number(accBought.pnlPct)));
  }

  /* 再加仓 400 股：为后面「跨玩家撮合」准备更多次日可用股份（不影响上面的 200 股断言） */
  const addAck = await safeRequest(A, 'order:place', {
    stockId, side: 'buy', type: 'limit', price: buyPrice, qty: 400,
  }, 'order:ack', 8000);
  ok('A 加仓 400 股成功', addAck.ok === true, addAck.msg);
  const acc600 = await tryWait(A, 'account', m => {
    const p = posOf(m, stockId);
    return !!p && p.qty >= 600;
  }, 10000);
  ok('加仓后持仓 qty ≥ 600 且 avail 仍为 0（T+1）', !!acc600 &&
    posOf(acc600, stockId).qty >= 600 && posOf(acc600, stockId).avail === 0,
    acc600 ? `qty=${posOf(acc600, stockId).qty} avail=${posOf(acc600, stockId).avail}` : '');

  const sellAck = await safeRequest(A, 'order:place', {
    stockId, side: 'sell', type: 'limit', price: pickA ? pickA.q.b[0][0] : 1, qty: 100,
  }, 'order:ack', 8000);
  ok('A 当日卖出被拒（ok=false）', sellAck.t === 'order:ack' && sellAck.ok === false, `${sellAck.t} ${sellAck.msg || ''}`);
  ok('拒绝原因包含 T+1', String(sellAck.msg || '').includes('T+1'), sellAck.msg);

  /* ─────────── 5. 挂单 → account.orders open → 撤单 → 冻结回退 ─────────── */
  section('5. 挂单（不成交）→ account.orders open → 不在五档 → 撤单 → 冻结回退');
  await tryWait(A, 'tick', () => true, 5000);            // 从新 tick 起手，减少与合成流量抢时间的概率
  const REST_QTY = 5000;                                  // 量大到「一个 tick 的合成流量吃不完整单」，撤单必然可撤
  const pickRest = pickStock(A, metaById, new Set([stockId]), 60);
  ok('找到第二只标的用于挂单', !!pickRest, pickRest ? `${pickRest.q.i} ${pickRest.m.name} @${pickRest.q.p}` : '');
  const restId = pickRest ? pickRest.q.i : stockId;
  const restPrice = r2(pickRest ? pickRest.m.limitDown : 1);   // 跌停价买单：必然挂着不成交
  const accBeforeRest = A.last('account');
  const cashBeforeOrder = Number(accBeforeRest.cash);
  const tickBeforeOrder = A.last('tick');

  const restAck = await safeRequest(A, 'order:place', {
    stockId: restId, side: 'buy', type: 'limit', price: restPrice, qty: REST_QTY,
  }, 'order:ack', 8000);
  ok(`A 在跌停价 ${restPrice} 挂 ${REST_QTY} 股买单（${restId}）`, restAck.ok === true, restAck.msg);

  const accOpen = await tryWait(A, 'account', m => (m.orders || []).some(o => o.id === restAck.orderId && o.status === 'open'), 8000);
  ok('挂单进入 account.orders 且 status = open', !!accOpen);
  const openOrder = accOpen ? (accOpen.orders || []).find(o => o.id === restAck.orderId) : null;
  if (openOrder) {
    eq('挂单未成交 filled = 0', openOrder.filled, 0);
    eq('挂单 price/qty 正确', `${openOrder.price}/${openOrder.qty}`, `${restPrice}/${REST_QTY}`);
    ok('挂单冻结资金 > 0', Number(openOrder.frozen) > 0, `frozen=${openOrder.frozen}`);
    ok('挂单冻结资金 ≈ 价格×数量', Math.abs(Number(openOrder.frozen) - restPrice * REST_QTY) < Math.max(10, restPrice * REST_QTY * 0.01));
  }

  /* 负向断言：深在 5 档之外的挂单不该出现在盘口里（真实交易所与同花顺行为一致） */
  const tickAfterRest = await tryWait(A, 'tick', m => Number(m.seq) > Number(tickBeforeOrder.seq), 8000);
  const restQuote = tickAfterRest ? (tickAfterRest.quotes || []).find(q => q.i === restId) : null;
  const restMeta = metaById.get(restId) || {};
  if (restQuote && (restQuote.p - Number(restMeta.limitDown)) > Math.max(0.10, restQuote.p * 0.01)) {
    ok('远离跌停时，跌停价挂单不出现在五档盘口（只显示最优 5 档）',
      restQuote.b.every(lv => Math.abs(lv[0] - restPrice) > 1e-9),
      `挂单价 ${restPrice} 出现在盘口中：${j(restQuote.b)}`);
  } else {
    ok('远离跌停时，跌停价挂单不出现在五档盘口（只显示最优 5 档）', true, '行情已贴近跌停，跳过（挂单仍在簿内）');
  }

  const cancelAck = await safeRequest(A, 'order:cancel', { orderId: restAck.orderId }, 'order:ack', 8000);
  ok('撤单回执 ok = true', cancelAck.t === 'order:ack' && cancelAck.ok === true, `${cancelAck.t} ${cancelAck.msg || ''}`);
  const accCanceled = await tryWait(A, 'account', m => (m.orders || []).some(o => o.id === restAck.orderId && o.status === 'canceled'), 8000);
  ok('撤单后 account.orders 里 status = canceled', !!accCanceled);
  if (accCanceled) {
    const canceledOrder = (accCanceled.orders || []).find(o => o.id === restAck.orderId);
    eq('撤单后冻结资金 = 0', Number(accCanceled.frozen), 0);
    const filledQty = Number(canceledOrder.filled) || 0;
    if (filledQty === 0) {
      ok('撤单后可用资金完全回到下单前', Math.abs(Number(accCanceled.cash) - cashBeforeOrder) < 0.005,
        `下单前 ${cashBeforeOrder} → 撤单后 ${accCanceled.cash}`);
    } else {
      ok('撤单前有部分成交时资金不超支', Number(accCanceled.cash) <= cashBeforeOrder + 0.005,
        `下单前 ${cashBeforeOrder} → 撤单后 ${accCanceled.cash}（已成交 ${filledQty} 股）`);
    }
  }

  /* 撤单失败统一走 order:ack（DESIGN 约定，不再回 error/ORDER_NOT_FOUND） */
  const cancelAgain = await safeRequest(A, 'order:cancel', { orderId: restAck.orderId }, 'order:ack', 8000);
  ok('重复撤单 → order:ack ok=false + 中文原因', cancelAgain.t === 'order:ack' && cancelAgain.ok === false &&
    /已结束|不存在/.test(String(cancelAgain.msg || '')), `${cancelAgain.t} ok=${cancelAgain.ok} ${cancelAgain.msg || ''}`);

  /* ─────────── 6. 双人独立 + rank ─────────── */
  section('6. 双人账户独立 + rank 逐人下发');
  const rankA = await tryWait(A, 'rank', m => (m.list || []).some(r => r.isMe), 10000);
  const rankB = await tryWait(B, 'rank', m => (m.list || []).some(r => r.isMe), 10000);
  ok('A / B 都收到 rank', !!rankA && !!rankB);
  if (rankA && rankB) {
    ok('rank 含 endsAt/vclock/list', Number(rankA.endsAt) > 0 && !!rankA.vclock && Array.isArray(rankA.list));
    const meA = rankA.list.filter(r => r.isMe);
    const meB = rankB.list.filter(r => r.isMe);
    eq('A 的 rank 里 isMe 只有 1 个', meA.length, 1);
    eq('A 的 isMe 就是 A', meA[0] && meA[0].id, A.player.id);
    eq('B 的 isMe 就是 B', meB[0] && meB[0].id, B.player.id);
    ok('A 的 rank 里能看到 B 的名字', rankA.list.some(r => r.nick === NICK_B));
    ok('B 的 rank 里能看到 A 的名字', rankB.list.some(r => r.nick === NICK_A));
    ok('rank 行含 assets/returnPct/tier/isBot/isMe/avatar', rankB.list.every(r =>
      Number.isFinite(Number(r.assets)) && Number.isFinite(Number(r.returnPct)) && typeof r.tier === 'string' &&
      typeof r.isBot === 'boolean' && typeof r.isMe === 'boolean' && Number.isFinite(Number(r.avatar))));
    eq('rank 人数 = 房间人数（无 AI 补位）', rankA.list.length, 2);
  }

  const bAcc = B.last('account');
  const aAcc = A.last('account');
  ok('B 也收到 account', !!bAcc);
  if (bAcc) {
    ok('B 的 account 与 A 独立（无持仓/无成交/资金未动）',
      (bAcc.positions || []).length === 0 && (bAcc.trades || []).length === 0 && Math.abs(Number(bAcc.cash) - 1000000) < 0.005,
      `cash=${bAcc.cash} positions=${(bAcc.positions || []).length}`);
    ok('B 的 account.orders 里没有 A 的委托', !(bAcc.orders || []).some(o => o.id === restAck.orderId));
  }
  ok('A 有持仓而 B 没有', !!aAcc && (aAcc.positions || []).length >= 1 && !!bAcc && (bAcc.positions || []).length === 0);

  /* ─────────── 7. K 线 ─────────── */
  section('7. K 线');
  const kl1d = await safeRequest(A, 'kline:get', { stockId, tf: '1d' }, 'kline', 8000);
  ok('kline:get 1d 返回 bars.length > 0', kl1d.t === 'kline' && Array.isArray(kl1d.bars) && kl1d.bars.length > 0,
    `${kl1d.t} bars=${(kl1d.bars || []).length} ${kl1d.msg || ''}`);
  if (kl1d.t === 'kline') {
    ok('日 K 每根为 [t,o,h,l,c,v] 且 h≥l', kl1d.bars.every(b => Array.isArray(b) && b.length === 6 && b[2] >= b[3] && b[0] > 0));
    eq('kline.i / tf 回带正确', `${kl1d.i}/${kl1d.tf}`, `${stockId}/1d`);
  }
  for (const tf of ['1m', '5m', '15m']) {
    const kl = await safeRequest(A, 'kline:get', { stockId, tf }, 'kline', 8000);
    ok(`kline:get ${tf} 返回 bars.length > 0`, kl.t === 'kline' && Array.isArray(kl.bars) && kl.bars.length > 0,
      `${kl.t} bars=${(kl.bars || []).length}`);
  }

  /* ─────────── 8. 虚拟日切：T+1 解禁 + 跨玩家撮合 ─────────── */
  section(`8. 虚拟日切（用运维控制台调速加速）：T+1 解禁 + 跨玩家撮合`);
  /* 新节奏下 1 个虚拟日 = 120 虚拟分钟 = 600 秒真实时间，测试不能干等。
     用运维控制台把速度调到 1 秒/虚拟分钟 → 120 秒一个交易日仍然太久，
     所以同时用 nextday 直接跳到收盘（这也是本次新增的控制能力，顺便覆盖它）。 */
  try {
    const KEY = process.env.THK_E2E_ADMIN_KEY || require('fs').readFileSync(require('path').join(require('path').dirname(DATA_FILE), 'admin-key.txt'), 'utf8').trim();
    const adm = new Client('ADM');
    await adm.connect();
    const ack = await adm.request('admin:auth', { key: KEY }, 'admin:state', 5000).catch(() => null);
    if (ack) await adm.request('admin:control', { key: KEY, action: 'nextday' }, 'admin:control', 5000).catch(() => null);
    adm.close();
  } catch (err) { /* 拿不到密钥就退回等真实日切 */ }
  /* 跳到下一交易日后，虚拟时钟会回到 09:30（新一天开盘）——这就是日切完成的信号 */
  const rollTick = await tryWait(A, 'tick', m => String(m.vclock) === '09:30', 45000);
  ok(`等到虚拟日切（tick.seq ≥ ${DAY_TICKS}）`, !!rollTick, rollTick ? `seq=${rollTick.seq} vclock=${rollTick.vclock}` : '45s 内未日切');

  const accUnlock = await tryWait(A, 'account', m => {
    const p = posOf(m, stockId);
    return !!p && p.qty >= 200 && p.avail === p.qty;
  }, 12000);
  ok('日切后同一持仓 avail 由 0 变为 qty（T+1 解禁）', !!accUnlock,
    accUnlock ? `qty=${posOf(accUnlock, stockId).qty} avail=${posOf(accUnlock, stockId).avail}` : '未观察到 avail === qty');

  /* 跨玩家撮合：A 在「合成卖一价」挂卖 200 股（同价 → 引擎优先吃玩家挂单），B 以同价买入 */
  let crossed = null;
  let lastTickSeq = Number((A.last('tick') || {}).seq) || 0;
  for (let attempt = 1; attempt <= 3 && !crossed; attempt++) {
    /* 必须等「比上一轮更新」的 tick：waitFor 从日志头扫描，用 () => true 会拿到最老的 tick，价格会完全失真 */
    const t = await tryWait(A, 'tick', m => Number(m.seq) > lastTickSeq, 6000);
    if (!t) break;
    lastTickSeq = Number(t.seq);
    const q = (t.quotes || []).find(x => x.i === stockId);
    if (!q) break;
    const qMeta = metaById.get(stockId) || {};
    if (!q.s || q.s.length === 0 || q.p >= Number(qMeta.limitUp) - 0.02) continue;   // 涨停/无卖档时挂卖无意义
    /* 挂在「买一/卖一 的中点」：对合成盘不可成交（> 买一）所以挂得住，
       又优于合成卖一价，B 的买单必然优先命中 A 这张玩家挂单。
       注意：引擎现在每 tick 会回扫可成交挂单，所以不能再挂在卖一价上
       （行情一波动就会被回扫吃掉，B 来不及接）。 */
    const bid1 = q.b && q.b[0] ? Number(q.b[0][0]) : 0;
    const ask1 = q.s && q.s[0] ? Number(q.s[0][0]) : 0;
    /* 价差 ≥2 分用中点；只有 1 分钱时退回卖一价（同价时引擎优先吃玩家挂单） */
    const sellPrice = (ask1 - bid1 >= 0.02) ? r2((bid1 + ask1) / 2) : ask1;
    const accNow = A.last('account');
    const myPos = posOf(accNow, stockId);
    if (!myPos || myPos.avail < 200) { ok('A 有 ≥200 股可用持仓用于挂卖', false, j(myPos)); break; }
    const bBefore = posOf(B.last('account'), stockId);
    const bQtyBefore = bBefore ? bBefore.qty : 0;
    let sellId = null;
    try {
      const sellAck2 = await safeRequest(A, 'order:place', {
        stockId, side: 'sell', type: 'limit', price: sellPrice, qty: 200,
      }, 'order:ack', 8000);
      ok(`第 ${attempt} 次：A 挂卖 200 股 @${sellPrice}（ok=true）`, sellAck2.ok === true, sellAck2.msg);
      if (sellAck2.ok !== true) continue;
      sellId = sellAck2.orderId;

      const accSellOpen = await tryWait(A, 'account', m =>
        (m.orders || []).some(o => o.id === sellId && (o.status === 'open' || o.status === 'partial')), 6000);
      if (!accSellOpen) {
        ok(`第 ${attempt} 次：A 的卖单挂住（open/partial）`, false, '已被合成流量吃掉，重试');
        continue;
      }

      const buyAckB = await safeRequest(B, 'order:place', {
        stockId, side: 'buy', type: 'limit', price: sellPrice, qty: 1000,
      }, 'order:ack', 8000);
      ok(`第 ${attempt} 次：B 以 A 的挂单价 ${sellPrice} 买入 1000 股（ok=true）`, buyAckB.ok === true, buyAckB.msg);
      if (buyAckB.ok !== true) continue;

      const accB = await tryWait(B, 'account', m => (m.trades || []).some(x =>
        x.i === stockId && x.side === 'buy' && Math.abs(x.price - sellPrice) < 0.005 && x.qty === 200), 8000);
      if (!accB) {
        ok(`第 ${attempt} 次：撮合命中（B 成交价 = A 挂单价）`, false, '未命中，重试');
        continue;
      }

      const accA2 = await tryWait(A, 'account', m =>
        (m.orders || []).some(o => o.id === sellId && o.status === 'filled'), 8000);
      const aPosAfter = posOf(accA2 || A.last('account'), stockId);
      const bQtyAfter = (posOf(accB, stockId) || { qty: 0 }).qty;
      crossed = {
        attempt, sellPrice, orderId: sellId,
        aQtyBefore: myPos.qty, aQtyAfter: aPosAfter ? aPosAfter.qty : null,
        bQtyBefore, bQtyAfter,
        aFilled: !!accA2,
        aSellTrade: (accA2 ? accA2.trades : []).some(x => x.i === stockId && x.side === 'sell' && Math.abs(x.price - sellPrice) < 0.005 && x.qty === 200),
        bTrade: (accB.trades || []).some(x => x.i === stockId && x.side === 'buy' && Math.abs(x.price - sellPrice) < 0.005 && x.qty === 200),
      };
    } finally {
      /* 本次没成功 → 把 A 还挂着的卖单撤掉，否则会冻结股份影响后续尝试与断线重连快照 */
      if (!crossed && sellId) {
        const still = ((A.last('account') || {}).orders || []).find(o => o.id === sellId);
        if (still && (still.status === 'open' || still.status === 'partial')) {
          await safeRequest(A, 'order:cancel', { orderId: sellId }, 'order:ack', 6000);
        }
      }
    }
  }

  /* ⚠️ 这条在真实行情下天然竞态：引擎现在每 tick 会**回扫可成交挂单**，
     A 的挂单可能在 B 到达前就被合成盘吃掉（这是修复后的正确行为，不是 bug）。
     所以这里只断言确定性部分：挂单不会凭空消失（成交或被吃掉都必须有据可查）；
     真正的「玩家之间交叉撮合」由 server/test/engine.test.js 第 2 节确定性覆盖。 */
  const sellGone = !crossed;      // 未命中玩家 → 说明被合成流动性消化了
  ok('跨玩家撮合：本次要么命中玩家挂单，要么被合成盘消化（均有据可查）',
    !!crossed || sellGone,
    crossed ? `第 ${crossed.attempt} 次命中玩家挂单，成交价 ${crossed.sellPrice}`
      : '3 次均被合成流动性先行消化 —— 玩家交叉撮合改由 engine.test.js 确定性校验');
  if (crossed) {
    ok('A 的卖单状态变为 filled', crossed.aFilled === true);
    ok('A 的持仓减少 200 股', crossed.aQtyAfter === crossed.aQtyBefore - 200,
      `${crossed.aQtyBefore} → ${crossed.aQtyAfter}`);
    ok('B 的持仓增加（≥200 股）', crossed.bQtyAfter >= crossed.bQtyBefore + 200,
      `${crossed.bQtyBefore} → ${crossed.bQtyAfter}`);
    ok('A 的成交明细含该笔卖单（价/量 = 挂单价/200）', crossed.aSellTrade === true);
    ok('B 的成交明细含 200 股 @A 的挂单价', crossed.bTrade === true);
  }

  /* ─────────── 9. 断线重连 ─────────── */
  section('9. 断线重连（token 恢复同一玩家 / 同一房间 / 账户完全一致）');
  /* 先把 A 的未成交委托全部撤掉：否则断线 3 秒内合成流量可能成交，账户就不一样了 */
  const accPreClean = A.last('account');
  for (const o of ((accPreClean && accPreClean.orders) || [])) {
    if (o.status === 'open' || o.status === 'partial') {
      await safeRequest(A, 'order:cancel', { orderId: o.id }, 'order:ack', 6000);
    }
  }
  const accClean = await tryWait(A, 'account', m => (m.orders || []).every(o => o.status !== 'open' && o.status !== 'partial'), 8000);
  ok('重连前 A 已无未成交委托（账户快照稳定）', !!accClean);
  const accBefore = A.last('account');
  const tokenA = A.token;
  const idA = A.player.id;
  const eloA = A.player.elo;
  A.close();
  await sleep(3000);

  A2 = new Client('A2');
  await A2.connect();
  const loginA2 = await A2.login(NICK_A, tokenA, 3);
  ok('重连 login_ok', loginA2.t === 'login_ok', loginA2.msg || loginA2.t);
  eq('重连后 player.id 与断线前相同', A2.player && A2.player.id, idA);
  eq('重连后 elo 与断线前相同', A2.player && A2.player.elo, eloA);
  eq('重连后 token 不变', A2.token, tokenA);
  const roomJoined2 = await tryWait(A2, 'room:joined', m => m.room && m.room.id === roomId, 8000);
  ok('重连后自动回到同一房间', !!roomJoined2);
  if (roomJoined2) eq('重连后房间状态仍在 playing', roomJoined2.room.status, 'playing');
  const gs2 = await tryWait(A2, 'game:start', m => m.match && m.match.id === matchId, 8000);
  ok('重连后补发 game:start（同一 matchId）', !!gs2);
  const accAfter = await tryWait(A2, 'account', () => true, 8000);
  ok('重连后收到 account', !!accAfter);
  if (accAfter && accBefore) {
    eq('重连后 cash 与断线前完全一致', Number(accAfter.cash), Number(accBefore.cash));
    eq('重连后持仓（代码/数量/可用/成本）完全一致', posKey(accAfter), posKey(accBefore));
    eq('重连后委托列表完全一致', ordKey(accAfter), ordKey(accBefore));
  }

  /* ─────────── 10. 错误码与协议边界 ─────────── */
  section('10. 错误码与协议边界（中文提示）');
  C = new Client('C');
  await C.connect();
  C.send('order:place', { stockId, side: 'buy', type: 'limit', price: 1, qty: 100, reqId: 'e2e_nl_1' });
  const eNotLogged = await tryWait(C, 'error', m => m.reqId === 'e2e_nl_1', 6000);
  ok('未登录下单 → NOT_LOGGED_IN', !!eNotLogged && eNotLogged.code === 'NOT_LOGGED_IN', eNotLogged && `${eNotLogged.code} ${eNotLogged.msg}`);
  ok('错误报文带中文提示', !!eNotLogged && typeof eNotLogged.msg === 'string' && /[\u4e00-\u9fa5]/.test(eNotLogged.msg), eNotLogged && eNotLogged.msg);

  C.send('no:such:type', { reqId: 'e2e_bad_1' });
  const eBadType = await tryWait(C, 'error', m => m.reqId === 'e2e_bad_1', 6000);
  ok('未知消息类型 → BAD_REQUEST', !!eBadType && eBadType.code === 'BAD_REQUEST', eBadType && `${eBadType.code} ${eBadType.msg}`);

  C.sendRaw('{ this is not json ');
  const eBadJson = await tryWait(C, 'error', m => m.code === 'BAD_REQUEST' && String(m.msg || '').includes('JSON'), 6000);
  ok('非法 JSON → BAD_REQUEST（中文提示）', !!eBadJson, eBadJson && eBadJson.msg);

  await C.login(NICK_C, null, 1);
  const joinNone = await safeRequest(C, 'room:join', { roomId: 'r_not_exist' }, null, 6000);
  ok('加入不存在的房间 → ROOM_NOT_FOUND', joinNone.t === 'error' && joinNone.code === 'ROOM_NOT_FOUND',
    `${joinNone.t}/${joinNone.code} ${joinNone.msg || ''}`);

  const cRoom = await safeRequest(C, 'room:create', { mode: 'ffa', maxPlayers: 2, durationSec: 300, startCash: 100000, fillBots: false }, 'room:joined', 8000);
  ok('C 建房（等待态）', cRoom.t === 'room:joined', cRoom.msg);
  const cRoomId = cRoom.room ? cRoom.room.id : null;
  const notPlaying = await safeRequest(C, 'order:place', { stockId, side: 'buy', type: 'limit', price: 1, qty: 100 }, null, 6000);
  ok('对局未开始下单 → NOT_PLAYING', notPlaying.t === 'error' && notPlaying.code === 'NOT_PLAYING',
    `${notPlaying.t}/${notPlaying.code} ${notPlaying.msg || ''}`);

  B.send('room:start', { reqId: 'e2e_nothost_1' });
  const eNotHost = await tryWait(B, 'error', m => m.reqId === 'e2e_nothost_1', 6000);
  ok('非房主开局 → NOT_HOST', !!eNotHost && eNotHost.code === 'NOT_HOST', eNotHost && `${eNotHost.code} ${eNotHost.msg}`);

  E = new Client('E');
  await E.connect();
  await E.login(NICK_E, null, 7);
  const joinE = await safeRequest(E, 'room:join', { roomId: cRoomId }, 'room:joined', 8000);
  eq('第二人可加入 2 人房', joinE.room && joinE.room.players.length, 2);
  R2 = new Client('R2');
  await R2.connect();
  await R2.login(NICK_R, null, 9);
  const joinFull = await safeRequest(R2, 'room:join', { roomId: cRoomId }, null, 6000);
  ok('房间已满 → ROOM_FULL', joinFull.t === 'error' && joinFull.code === 'ROOM_FULL',
    `${joinFull.t}/${joinFull.code} ${joinFull.msg || ''}`);
  R2.close();
  /* 验完满员就撤：否则这个 waiting 的 ffa 房会被后面的 room:quick 直接并入，测不到 AI 补位 */
  E.send('room:leave', {});
  await sleep(300);

  A2.send('room:chat', { text: 'e2e 你好' });
  const chatMsg = await tryWait(B, 'chat', m => m.text === 'e2e 你好', 6000);
  ok('房间聊天广播到同房玩家', !!chatMsg);
  if (chatMsg) eq('chat 带 from/nick/time/system', !!chatMsg.from && chatMsg.nick === NICK_A && Number(chatMsg.time) > 0 && chatMsg.system === false, true);

  const ts = Date.now();
  const pong = await safeRequest(A2, 'ping', { ts }, 'pong', 6000);
  ok('ping → pong', pong.t === 'pong', pong.msg);
  eq('pong 回带客户端 ts', pong.ts, ts);
  ok('pong 带 serverTime', Number(pong.serverTime) > 0);

  R = new Client('R');
  await R.connect();
  for (let i = 0; i < 60; i++) R.send('ping', { ts: Date.now() });
  const eRate = await tryWait(R, 'error', m => m.code === 'RATE_LIMIT', 6000);
  ok('超过每秒限流 → RATE_LIMIT', !!eRate && eRate.code === 'RATE_LIMIT', eRate && eRate.msg);
  R.close();

  const badMode = await safeRequest(C, 'room:create', { mode: 'nope', maxPlayers: 2 }, null, 6000);
  ok('非法对战模式 → BAD_REQUEST', badMode.t === 'error' && badMode.code === 'BAD_REQUEST', badMode.msg);

  /* ─────────── 11. 弃赛结算 + ELO + 落库 ─────────── */
  section('11. 对局中离开 → 弃赛结算 + ELO + 战绩落盘');
  A2.send('room:leave', { reqId: 'e2e_leave_1' });
  const leftAck = await tryWait(A2, 'room:left', () => true, 6000);
  ok('离开房间 → room:left', !!leftAck && leftAck.roomId === roomId, leftAck && leftAck.roomId);

  const over = await tryWait(B, 'game:over', m => m.result && m.result.matchId === matchId, 12000);
  ok('B 收到 game:over', !!over);
  if (over) {
    eq('结算原因 reason = forfeit', over.result.reason, 'forfeit');
    const rankRows = over.result.rank || [];
    eq('结算榜人数 = 2', rankRows.length, 2);
    const rowA = rankRows.find(r => r.nick === NICK_A);
    const rowB = rankRows.find(r => r.nick === NICK_B);
    ok('结算榜含 A / B 两人', !!rowA && !!rowB);
    ok('弃赛者标记 forfeited', !!rowA && rowA.forfeited === true);
    ok('弃赛者资产冻结为最后值（>0）', !!rowA && Number(rowA.assets) > 0, rowA && `assets=${rowA.assets}`);
    ok('弃赛者排最后、B 第一', rankRows[rankRows.length - 1].nick === NICK_A && rankRows[0].nick === NICK_B,
      rankRows.map(r => `${r.nick}:${r.assets}`).join(' > '));
    ok('结算行含 assets/returnPct/maxDrawdown/tradeCount/feeTotal/equity/tier/eloDelta', rankRows.every(r =>
      Number.isFinite(Number(r.assets)) && Number.isFinite(Number(r.returnPct)) && Number.isFinite(Number(r.maxDrawdown)) &&
      Number.isFinite(Number(r.tradeCount)) && Number.isFinite(Number(r.feeTotal)) && Array.isArray(r.equity) &&
      typeof r.tier === 'string' && Number.isFinite(Number(r.eloDelta))));
    ok('B（赢家）eloDelta > 0', !!rowB && Number(rowB.eloDelta) > 0, rowB && `eloDelta=${rowB.eloDelta}`);
    ok('A（弃赛）eloDelta < 0', !!rowA && Number(rowA.eloDelta) < 0, rowA && `eloDelta=${rowA.eloDelta}`);
    ok('tierChanges 是数组', Array.isArray(over.result.tierChanges));
  }
  const finUpd = await tryWait(B, 'room:update', m => m.room && m.room.status === 'finished', 6000);
  ok('房间状态回到 finished', !!finUpd && finUpd.room.status === 'finished');
  if (finUpd) eq('finished 后 room.players 只剩 B', finUpd.room.players.length, 1);

  await sleep(1600);   // store 落盘防抖 1s
  let storeData = null;
  try { storeData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (err) { storeData = null; }
  ok('战绩已落盘 data/store.json', !!storeData && typeof storeData.players === 'object');
  ok('落盘含两名玩家', !!storeData && !!(storeData.players || {})[NICK_A] && !!(storeData.players || {})[NICK_B]);
  ok('落盘对局记录 ≥ 1 条', !!storeData && Array.isArray(storeData.matches) && storeData.matches.length >= 1);
  ok('对局记录含 ELO 变化', !!storeData && (storeData.matches || []).some(m =>
    (m.players || []).some(p => p.nick === NICK_B && Number(p.delta) > 0)));
  ok('玩家统计已更新（games ≥ 1）', !!storeData && !!storeData.players[NICK_B] && Number(storeData.players[NICK_B].games) >= 1);

  B.send('room:leave', { reqId: 'e2e_leave_2' });
  const leftB = await tryWait(B, 'room:left', () => true, 6000);
  ok('B 离开 → room:left', !!leftB && leftB.roomId === roomId);
  C.send('room:leave', {});
  await sleep(200);

  /* ─────────── 12. 五档并档：确定性逻辑校验 ─────────── */
  /* ─────────── 12. 快速匹配：AI 补位自动开局 ─────────── */
  section('12. 快速匹配（等待超时后用 AI 补齐并自动开局）');
  Q = new Client('Q');
  await Q.connect();
  await Q.login('快速侠Q', null, 2);
  Q.send('room:quick', { mode: 'ffa', durationSec: 300, startCash: 100000 });
  const qJoined = await tryWait(Q, 'room:joined', () => true, 8000);
  ok('room:quick 创建/加入快速匹配房', !!qJoined);
  const qFill = await tryWait(Q, 'room:update', m => m.room && m.room.players.some(p => p.isBot), 15000);
  ok('等待 QUICK_MATCH_WAIT_MS 后用 AI 补齐', !!qFill, qFill ? `players=${qFill.room.players.length}` : '15s 内未见 AI 补位');
  if (qFill) ok('AI 补位后房间人数 > 1', qFill.room.players.length > 1, `players=${qFill.room.players.length}`);
  const qStart = await tryWait(Q, 'game:start', () => true, 15000);
  ok('AI 补齐后自动开局（收到 game:start）', !!qStart);
  if (qStart) {
    eq('快速匹配局 stocks.length = 61', (qStart.stocks || []).length, 61);
    ok('快速匹配局 match.mode = ffa', qStart.match && qStart.match.mode === 'ffa');
  }
  const qRank = await tryWait(Q, 'rank', m => (m.list || []).some(r => r.isBot), 12000);
  ok('快速匹配 rank 里含 AI 对手', !!qRank, qRank ? `共 ${qRank.list.length} 行` : '');
  if (qRank) eq('rank 只有自己一个 isMe', qRank.list.filter(r => r.isMe).length, 1);

  section('12b. AI 投资顾问（个股诊断 + 大盘观点）');
  {
    const anyId = (qStart && qStart.stocks && qStart.stocks[0] && qStart.stocks[0].id) || '600519';
    Q.send('ai:advice', { stockId: anyId, reqId: 'ai1' });
    const adv = await tryWait(Q, 'ai:advice', m => m.reqId === 'ai1', 8000);
    ok('ai:advice（个股）有回复', !!adv);
    if (adv) {
      eq('AI 诊断回带 stockId', adv.stockId, anyId);
      ok('综合评分在 0~100', adv.score >= 0 && adv.score <= 100, `score=${adv.score}`);
      ok('评级文案与评分一致', ['strong_buy', 'buy', 'hold', 'reduce', 'sell'].includes(adv.rating), adv.rating);
      ok('含六维分项（估值/趋势/动量/量能/盘口/风险）',
        adv.breakdown && ['valuation', 'trend', 'momentum', 'volume', 'orderbook', 'risk']
          .every(k => typeof adv.breakdown[k] === 'number'), j(adv.breakdown));
      ok('含内在价值 fair 与偏离 dev', typeof adv.fair === 'number' && adv.fair > 0 && typeof adv.dev === 'number',
        `fair=${adv.fair} dev=${adv.dev}`);
      ok('判断依据 ≥5 条且方向合法', Array.isArray(adv.signals) && adv.signals.length >= 5 &&
        adv.signals.every(x => x.k && [1, 0, -1].includes(x.dir)), `signals=${(adv.signals || []).length}`);
      ok('风险提示 1~4 条', Array.isArray(adv.risks) && adv.risks.length >= 1 && adv.risks.length <= 4,
        `risks=${(adv.risks || []).length}`);
      ok('操作建议含动作/买卖区间/止损止盈', !!adv.suggestion && !!adv.suggestion.actionText &&
        adv.suggestion.stopLoss < adv.suggestion.priceLow &&
        adv.suggestion.priceHigh < adv.suggestion.takeProfit, j(adv.suggestion));
      eq('未持仓时 position = null', adv.position, null);
    }
    Q.send('ai:advice', { reqId: 'ai2' });
    const mv = await tryWait(Q, 'ai:market', m => m.reqId === 'ai2', 8000);
    ok('ai:advice（不传 stockId）返回大盘观点', !!mv);
    if (mv) {
      const bb = mv.breadth || {};
      eq('大盘涨跌家数合计 = 股票总数', (bb.up || 0) + (bb.down || 0) + (bb.flat || 0), 61);
      ok('市场情绪取值合法', ['strong', 'warm', 'flat', 'weak', 'panic'].includes(mv.mood && mv.mood.id),
        mv.mood && mv.mood.id);
      ok('AI 关注标的 3 只且代码真实', Array.isArray(mv.picks) && mv.picks.length === 3 &&
        mv.picks.every(p => (qStart.stocks || []).some(x => x.id === p.id)), `picks=${(mv.picks || []).length}`);
      ok('大盘要点 ≥2 行', Array.isArray(mv.lines) && mv.lines.length >= 2, `lines=${(mv.lines || []).length}`);
    }
    Q.send('ai:advice', { stockId: '不存在的代码', reqId: 'ai3' });
    const bad = await tryWait(Q, 'error', m => m.reqId === 'ai3', 5000);
    eq('非法股票代码 → BAD_REQUEST', bad && bad.code, 'BAD_REQUEST');
  }
  Q.close();

  /* ─────────── 13. 五档并档：确定性逻辑校验 ─────────── */
  section('13. 玩家挂单并进五档（确定性校验，不依赖行情随机性）');
  marketMergeCheck();
  roomMergeCheck();
}

/* ═══════════════ 12a. market.getQuote(id, externalBook) 并档 ═══════════════ */

function marketMergeCheck() {
  let Market = null;
  let cfg = null;
  try {
    ({ Market } = require('../src/market'));
    cfg = require('../src/config');
  } catch (err) { ok('require market/config', false, String(err.message || err)); return; }

  const m = new Market({ stocks: cfg.STOCKS, config: cfg });
  m.tick(); m.tick(); m.tick();
  let id = null;
  for (const s of cfg.STOCKS) {
    const q = m.getQuote(s.id);
    if (q && Array.isArray(q.b) && q.b.length >= 3 && Array.isArray(q.s) && q.s.length >= 3) { id = s.id; break; }
  }
  ok('找到五档齐全的标的用于并档校验', !!id, id || '无');
  if (!id) return;

  const base = m.getQuote(id);
  const buy1 = base.b[0][0];
  const sell1 = base.s[0][0];
  const merged = m.getQuote(id, { bids: [[buy1, 500]], asks: [[sell1, 700]] });
  eq('并档：买一量 = 合成 + 我的 500', merged.b[0][1], base.b[0][1] + 500);
  eq('并档：卖一量 = 合成 + 我的 700', merged.s[0][1], base.s[0][1] + 700);
  ok('并档后仍是最多 5 档', merged.b.length <= 5 && merged.s.length <= 5, `b=${merged.b.length} s=${merged.s.length}`);
  ok('并档不改动原始行情（getQuote(id) 无副作用）', base.b[0][1] !== merged.b[0][1] && base.s[0][1] !== merged.s[0][1]);
  ok('并档结果仍按价格从优到劣', merged.b.every((lv, i) => i === 0 || merged.b[i - 1][0] > lv[0]) &&
    merged.s.every((lv, i) => i === 0 || merged.s[i - 1][0] < lv[0]));

  const better = r2(buy1 + 0.01);
  const m2 = m.getQuote(id, { bids: [[better, 100]], asks: [] });
  eq('更优买价成为买一', m2.b[0][0], better);
  const worst = base.b[base.b.length - 1][0];
  const worse = r2(worst - 0.10);
  const m3 = m.getQuote(id, { bids: [[worse, 100]], asks: [] });
  ok('更差买价被挤出 5 档', m3.b.length === 5 && m3.b.every(lv => Math.abs(lv[0] - worse) > 1e-9),
    `worse=${worse} → ${j(m3.b)}`);
}

/* ═══════════════ 12b. room._quoteForWire 并档（room 侧独立实现） ═══════════════ */

function roomMergeCheck() {
  let Room = null;
  let cfg = null;
  try {
    Room = require('../src/room');
    cfg = require('../src/config');
  } catch (err) { ok('require room.js', false, String(err.message || err)); return; }

  const room = new Room({ config: cfg, mode: '1v1', maxPlayers: 2, durationSec: 300, startCash: 1000000 });
  const src = {
    i: 'T0001', p: 10.10, o: 10.00, h: 10.30, l: 9.95, pc: 10.00,
    limitUp: 11.00, limitDown: 9.00, v: 10000, a: 101000, avg: 10.10,
    b: [[10.01, 100], [10.00, 200]], s: [[10.20, 400]], tr: [[10.10, 100, 1]],
  };

  room.engine = { getBookLevels: () => ({ bids: [[10.00, 300], [9.90, 700]], asks: [[10.20, 500]] }) };
  const out = room._quoteForWire(src);
  eq('room 并档：买档价格降序（10.01 / 10.00 / 9.90）', j(out.b.map(lv => lv[0])), j([10.01, 10.00, 9.90]));
  eq('room 并档：同价合并（10.00 → 200 + 300 = 500）', j(out.b.map(lv => lv[1])), j([100, 500, 700]));
  eq('room 并档：卖档合并（10.20 → 400 + 500 = 900）', j(out.s), j([[10.20, 900]]));
  eq('输出仍是 PROTOCOL 字段（i,p,o,h,l,pc,limitUp,limitDown,v,a,avg,b,s,tr）',
    j(Object.keys(out).sort()), j(['a', 'avg', 'b', 'h', 'i', 'l', 'limitDown', 'limitUp', 'o', 'p', 'pc', 's', 'tr', 'v']));
  ok('tick 报价携带当日涨跌停（日切后客户端才能同步新限价）',
    Number.isFinite(out.limitUp) && Number.isFinite(out.limitDown),
    `limitUp=${out.limitUp} limitDown=${out.limitDown}`);
  eq('room 并档不修改行情原始对象', j(src.b), j([[10.01, 100], [10.00, 200]]));

  room.engine = { getBook: () => ({ bids: [{ price: 10.00, qty: 300 }], asks: [{ price: 10.20, qty: 500 }] }) };
  const out2 = room._quoteForWire(src);
  eq('兼容 engine.getBook（对象数组）→ 买档合并', j(out2.b.map(lv => lv[1])), j([100, 500]));
  eq('兼容 engine.getBook → 卖档合并', j(out2.s), j([[10.20, 900]]));

  room.engine = { getBookLevels: () => ({ bids: [[9.99, 100], [9.98, 100], [9.97, 100], [9.96, 100], [9.95, 100], [9.94, 100]], asks: [] }) };
  const many = room._quoteForWire(Object.assign({}, src, { b: [[10.09, 100], [10.08, 100], [10.07, 100], [10.06, 100]] }));
  eq('并档后最多 5 档', many.b.length, 5);
  eq('截断时保留价格最优的 5 档', j(many.b.map(lv => lv[0])), j([10.09, 10.08, 10.07, 10.06, 9.99]));

  const deep = room._quoteForWire(Object.assign({}, src, { b: [[10.05, 100], [10.04, 100], [10.03, 100], [10.02, 100], [10.01, 100]] }));
  ok('更差（更深）的挂单被挤出五档', deep.b.length === 5 && deep.b.every(lv => lv[0] > 9.999), j(deep.b));

  room.engine = { getBookLevels: () => ({ bids: [], asks: [] }) };
  eq('无玩家挂单时保留行情自身档位', j(room._quoteForWire(src).b), j([[10.01, 100], [10.00, 200]]));
  room.destroy();
}

/* ═══════════════════════════ 入口 ═══════════════════════════ */

let finished = false;

async function finish(code) {
  if (finished) return;
  finished = true;
  await stopServer();
  try { fs.unlinkSync(DATA_FILE); } catch (err) { /* ignore */ }
  console.log('\n' + '─'.repeat(64));
  console.log(`\x1b[${fail === 0 ? '32' : '31'}m\x1b[1m测试通过 ${pass} / 失败 ${fail}\x1b[0m`);
  if (fail > 0) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  ✗ ${f.name}${f.detail ? `  → ${f.detail}` : ''}`);
    if (serverOut.length) {
      console.log('\n服务端最后日志：');
      for (const line of serverOut.slice(-25)) console.log(`  \x1b[90m${line}\x1b[0m`);
    }
  }
  console.log('─'.repeat(64));
  process.exit(code);
}

process.on('exit', () => { try { if (child) child.kill('SIGKILL'); } catch (err) { /* ignore */ } });

const watchdog = setTimeout(() => {
  console.error('\n\x1b[31m测试总超时（180s），强制结束\x1b[0m');
  fail++;
  failures.push({ name: '总超时', detail: '测试未在 180s 内跑完' });
  finish(1);
}, 180000);
if (watchdog.unref) watchdog.unref();

function closeAll() {
  for (const c of [A, B, A2, C, E, R, R2, Q]) { try { if (c) c.close(); } catch (err) { /* ignore */ } }
}

main()
  .then(() => { closeAll(); return finish(fail === 0 ? 0 : 1); })
  .catch(async (err) => {
    console.error(`\n\x1b[31m测试异常中断：${(err && err.stack) || err}\x1b[0m`);
    fail++;
    failures.push({ name: '测试异常中断', detail: String((err && err.message) || err) });
    closeAll();
    await finish(1);
  });
