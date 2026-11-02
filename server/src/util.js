/* ═══════════════════════════════════════════════════════════════
   同花亏 · 服务端通用工具（无第三方依赖）
   ═══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

/* ───────── id ───────── */
const counters = new Map();
function uid(prefix = 'x') {
  const n = (counters.get(prefix) || 0) + 1;
  counters.set(prefix, n);
  return prefix + '_' + n.toString(36) + Date.now().toString(36).slice(-4);
}

/* ───────── 随机 ───────── */
function rand(a = 0, b = 1) { return a + Math.random() * (b - a); }
function randInt(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
/** 标准正态分布（Box-Muller） */
let _spare = null;
function randn() {
  if (_spare !== null) { const v = _spare; _spare = null; return v; }
  let u = 0, v = 0, s = 0;
  do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
  const mul = Math.sqrt(-2 * Math.log(s) / s);
  _spare = v * mul;
  return u * mul;
}

/* ───────── 数值 ───────── */
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function roundTo(v, unit) { return Math.round((Number(v) || 0) / unit) * unit; }
/** 向下取整到 unit 的倍数 */
function floorTo(v, unit) { return Math.floor((Number(v) || 0) / unit) * unit; }
function sum(arr, f = (x) => x) { let s = 0; for (const x of arr) s += f(x) || 0; return s; }

/* ───────── 时间 ───────── */
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
/** 虚拟分钟序号 → 'HH:MM'（09:30-11:30, 13:00-15:00） */
/**
 * 分钟序号 → 「当日交易时钟」的分钟数（09:30 起算，跳过 11:30~13:00 午休）。
 * 时间戳必须用这个而不是 minuteOfDay 线性相加：
 * 线性相加得到的是 00:00 起的时间戳，客户端按交易时段换算分时横轴时会全部落到 slot 0。
 */
const SESSION_MORNING_OPEN = 9 * 60 + 30;      // 09:30
function sessionMinutes(minute) {
  /* 一个虚拟交易日 = 上午盘 09:30-11:30（120 个虚拟分钟） */
  const m = clamp(Math.floor(Number(minute) || 0), 0, 119);
  return SESSION_MORNING_OPEN + m;
}

function vclockOf(minute) {
  const m = clamp(Math.floor(Number(minute) || 0), 0, 119);
  if (m >= 119) return '11:30';          // 最后一个 tick = 上午收盘
  const t = SESSION_MORNING_OPEN + m;
  return pad2(Math.floor(t / 60)) + ':' + pad2(t % 60);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ───────── 日志 ───────── */
const COLORS = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', ok: '\x1b[32m', dim: '\x1b[90m' };
function createLogger(scope = 'ths') {
  const tag = `${COLORS.dim}[${scope}]${COLORS.info}`;
  const write = (level, args) => {
    const t = new Date();
    const stamp = `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
    const c = COLORS[level] || COLORS.info;
    // eslint-disable-next-line no-console
    console.log(`${COLORS.dim}${stamp}${COLORS.info} ${tag} ${c}${args.join(' ')}\x1b[0m`);
  };
  return {
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    ok: (...a) => write('ok', a),
    dim: (...a) => write('dim', a),
  };
}

/* ───────── JSON / 文件 ───────── */
function safeJson(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

/** 原子写：先写临时文件再 rename，避免半截文件 */
function atomicWriteSync(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}
function readJsonSync(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/* ───────── 其它 ───────── */
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
function nowMs() { return Date.now(); }

/** 生成一个不容易撞的昵称（AI 用） */
function uniqueName(base, used) {
  let name = base, i = 1;
  while (used.has(name)) { name = base + '·' + (++i); }
  used.add(name);
  return name;
}

/** 简单滑动窗口限流器 */
class RateLimiter {
  constructor(perSec) { this.perSec = perSec; this.hits = []; }
  allow() {
    const now = Date.now();
    this.hits = this.hits.filter(t => now - t < 1000);
    if (this.hits.length >= this.perSec) return false;
    this.hits.push(now);
    return true;
  }
}

module.exports = {
  uid, rand, randInt, randn, pick, shuffle,
  clamp, round2, roundTo, floorTo, sum,
  pad2, vclockOf, sessionMinutes, sleep,
  createLogger, safeJson, atomicWriteSync, readJsonSync,
  deepClone, nowMs, uniqueName, RateLimiter,
};
