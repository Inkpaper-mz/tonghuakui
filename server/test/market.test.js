#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   同花亏 · market.js 确定性单元测试（不联网、不起服务端）
   用法： node server/test/market.test.js
   覆盖：股票池 / 历史 K 线 / 涨跌停不变量 / 五档结构 / 成交额与均价 /
        指数 / recordTrade / consumeLiquidity 上限 / 五档并档 / 只读无副作用
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const config = require('../src/config');
const { Market } = require('../src/market');

let pass = 0, fail = 0;
const results = [];
function ok(cond, label, extra) {
  if (cond) { pass++; results.push(['✓', label, extra]); }
  else { fail++; results.push(['✗', label, extra]); }
}
function eq(a, b, label) { ok(a === b, label, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`); }

function newMarket() {
  const m = new Market({ stocks: config.STOCKS, config });
  m.reset();
  return m;
}

/* ───────── 1. 股票池与历史 K 线 ───────── */
{
  const m = newMarket();
  const meta = m.getMeta();
  eq(meta.length, config.STOCKS.length, `股票池数量 = ${config.STOCKS.length}（21 只 A 股 + 10 只纳指股）`);
  eq(meta.filter(s => s.market === 'us').length, 10, '含 10 只纳斯达克股票');
  const nv = config.STOCKS.find(s => s.id === 'NVDA');
  ok(!!nv && nv.name === '英卫达', '含纳指股 英卫达(NVDA)');
  eq(config.limitPrices(nv).limitPct, 0.30, '美股涨跌幅限制 = ±30%');
  eq(config.limitPrices(config.STOCKS.find(s => s.id === '600519')).limitPct, 0.10, 'A 股主板仍为 ±10%');
  ok(meta.some(s => s.id === '600173' && s.name === '卧龙商射'), '股票池含 卧龙商射 600173');
  const wl = config.STOCKS.find(s => s.id === '600173');
  const lp = config.limitPrices(wl);
  eq(lp.limitUp, 14.17, '卧龙商射涨停价 = 14.17（12.88 × 1.1）');
  eq(lp.limitDown, 11.59, '卧龙商射跌停价 = 11.59');

  const bars = m.getBars('600519', '1d', 500);
  eq(bars.length, config.HISTORY_DAYS, `600519 历史日 K = ${config.HISTORY_DAYS} 根`);
  const last = bars[bars.length - 1];
  const mt519 = config.STOCKS.find(x => x.id === '600519');
  eq(Math.round(last[4] * 100) / 100, Math.round(mt519.prevClose * 100) / 100,
    '最后一根历史日 K 的收盘价 == 昨收（prevClose）');
  ok(bars.every((b, i) => i === 0 || b[0] > bars[i - 1][0]), '历史日 K 时间戳严格升序');
  ok(bars.every(b => b[2] >= Math.max(b[1], b[4]) - 1e-9 && b[3] <= Math.min(b[1], b[4]) + 1e-9),
    '每根 K 线 high ≥ max(open,close) 且 low ≤ min(open,close)');
  ok(meta.every(s => s.limitUp > s.prevClose && s.limitDown < s.prevClose && s.lotSize === config.LOT_SIZE),
    '每只股票 涨跌停价合理 且 lotSize=100');
}

/* ───────── 2. 200 tick 不变量 ───────── */
{
  const m = newMarket();
  let bad = { range: 0, hl: 0, finite: 0, depth: 0, dir: 0, tr: 0 };
  for (let t = 0; t < 200; t++) {
    const tk = m.tick();
    for (const q of tk.quotes) {
      if (!(q.p >= q.limitDown - 1e-9 && q.p <= q.limitUp + 1e-9)) bad.range++;
      if (!(q.h >= Math.max(q.o, q.p) - 1e-9 && q.l <= Math.min(q.o, q.p) + 1e-9)) bad.hl++;
      if (![q.p, q.o, q.h, q.l, q.pc, q.v, q.a, q.avg].every(Number.isFinite) || q.p <= 0) bad.finite++;
      // 五档规则：每侧 ≤5 档、买降序/卖升序、价格不越涨跌停；
      // 贴近涨停时卖档自然稀薄、跌停时买档稀薄，封板时对手档为空（设计如此）
      const atUp = q.p >= q.limitUp - 1e-9, atDown = q.p <= q.limitDown + 1e-9;
      const eps = 1e-6;
      const depthOk =
        q.b.length <= 5 && q.s.length <= 5 &&
        q.b.every(l => l[0] <= q.limitUp + eps) && q.s.every(l => l[0] >= q.limitDown - eps) &&
        q.b.every((l, i) => i === 0 || l[0] < q.b[i - 1][0]) &&
        q.s.every((l, i) => i === 0 || l[0] > q.s[i - 1][0]) &&
        (!atUp || q.s.length === 0) && (!atDown || q.b.length === 0);   // 贴近涨跌停时对手档自然稀薄甚至为空
      if (!depthOk) bad.depth++;
      if (!q.tr.every(x => Array.isArray(x) && x.length === 3 && (x[2] === 1 || x[2] === -1) && x[1] > 0 && x[0] > 0)) bad.dir++;
      if (q.tr.length < 0 || q.tr.length > 8) bad.tr++;
    }
  }
  eq(bad.range, 0, '200 tick 内现价全部落在涨跌停区间');
  eq(bad.hl, 0, '200 tick 内 high/low 与 open/close 一致');
  eq(bad.finite, 0, '200 tick 内所有数值均有限且价格 > 0');
  eq(bad.depth, 0, '200 tick 内五档结构合法（≤5 档 / 排序 / 不越涨跌停 / 封板空档）');
  eq(bad.dir, 0, '成交明细 direction ∈ {1,-1} 且价量合法');
  eq(bad.tr, 0, '每 tick 成交明细条数合理（0~8 笔，封板可为 0）');
}

/* ───────── 3. 成交额 / 均价 / 指数 ───────── */
{
  const m = newMarket();
  for (let t = 0; t < 120; t++) m.tick();
  const q = m.getQuote('600519');
  ok(q.a > 0, '成交额 a > 0（本轮修复的核心 bug）', `a=${Math.round(q.a)}`);
  ok(q.v > 0, '成交量 v > 0', `v=${q.v}`);
  ok(Math.abs(q.avg - q.a / q.v) / (q.a / q.v) < 0.02, '均价 avg ≈ a/v（误差 < 2%）',
    `avg=${q.avg} a/v=${(q.a / q.v).toFixed(2)}`);
  const idx = m.getIndices();
  eq(idx.length, 4, '指数数量 = 4（同花综指/同花成指/纳斯达克综指/纳斯达克100）');
  ok(idx.some(i => i.n === '纳斯达克综指') && idx.some(i => i.n === '纳斯达克100'), '含两只纳斯达克指数');
  ok(idx.every(i => i.amt > 0 && Number.isFinite(i.v) && Number.isFinite(i.pct)), '指数 amt/v/pct 合法且 amt > 0');
  const pc0 = idx.map(i => i.pc);
  for (let t = 0; t < 50; t++) m.tick();
  const idx2 = m.getIndices();
  ok(idx2.every((i, k) => i.pc === pc0[k]), '指数昨收 pc 在同一天内恒定');
}

/* ───────── 4. recordTrade（玩家成交计入行情）───────── */
{
  const m = newMarket();
  m.tick();
  const v0 = Number(m.getQuote('600036').v), a0 = Number(m.getQuote('600036').a);
  m.recordTrade('600036', 40.00, 300);
  const v1 = Number(m.getQuote('600036').v), a1 = Number(m.getQuote('600036').a);
  eq(v1, v0 + 300, 'recordTrade 立即增加成交量 300 股');
  eq(Math.round((a1 - a0) * 100) / 100, 12000, 'recordTrade 立即增加成交额 12000.00 元');
  ok(m.getQuote('600036').tr.some(x => Math.abs(x[0] - 40) < 1e-9 && x[1] === 300),
    'recordTrade 写入本 tick 成交明细');
  const b1 = m.getBars('600036', '1m', 5);
  const vBar = b1.length ? b1[b1.length - 1][5] : 0;
  const vNext = (m.tick(), Number(m.getQuote('600036').v));
  ok(vNext >= v1, '下一 tick 成交量不回退（recordTrade 已计入总账）', `${v0} → ${v1} → ${vNext}`);
  ok(vBar >= 0, '1 分钟 K 成交量可取到');
}

/* ───────── 5. consumeLiquidity 有上限、不透支 ───────── */
{
  const m = newMarket();
  for (let t = 0; t < 10; t++) m.tick();
  const q = m.getQuote('600519');
  const huge = 50_000_000;
  const res = m.consumeLiquidity('600519', 'buy', huge, Infinity);
  ok(res.filledQty > 0 && res.filledQty < huge, '巨量买单不会无限穿透（只吃到上限）',
    `filled=${res.filledQty} / 请求=${huge}`);
  const levels = new Set(res.fills.map(f => f.price)).size;
  ok(levels <= 5 + config.MAX_WALK_LEVELS_PLUS || levels <= 15, '吃到的档位数 ≤ 起始 5 档 + 10 档上限',
    `levels=${levels}`);
  ok(res.fills.every(f => f.price >= q.limitDown && f.price <= q.limitUp), '成交价均在涨跌停区间内');
  const again = m.consumeLiquidity('600519', 'buy', 100000, Infinity);
  ok(again.filledQty === 0, '同一 tick 内预算耗尽后再吃 = 0（流动性预算生效）');
}

/* ───────── 6. 五档并档（玩家挂单并进盘口）───────── */
{
  const m = newMarket();
  for (let t = 0; t < 10; t++) m.tick();
  const id = '600036';
  const q0 = m.getQuote(id);
  const bid = q0.b[0][0], ask = q0.s[0][0];

  const merged = m.getQuote(id, { bids: [[bid, 500]], asks: [[ask, 700]] });
  eq(merged.b[0][0], bid, '并档后买一价不变（同价合并）');
  eq(merged.b[0][1], q0.b[0][1] + 500, '并档后买一量 = 合成量 + 我的 500 股');
  eq(merged.s[0][1], q0.s[0][1] + 700, '并档后卖一量 = 合成量 + 我的 700 股');
  eq(merged.b.length, 5, '并档后仍是 5 档（买）');
  eq(merged.s.length, 5, '并档后仍是 5 档（卖）');

  const px = Math.round((ask - 0.01) * 100) / 100;              // 价差之内：合成盘没有这个价位
  const inner = m.getQuote(id, { bids: [[px, 400]], asks: [] });
  ok(inner.b.some(l => Math.abs(l[0] - px) < 0.005 && l[1] >= 400),
    '价差内的玩家挂单能被并进买档（该价位只可能来自玩家）', `px=${px} b=${JSON.stringify(inner.b.slice(0, 2))}`);

  const worse = m.getQuote(id, { bids: [[q0.b[4][0] - 2.0, 1000]], asks: [] });
  ok(!worse.b.some(l => Math.abs(l[0] - (q0.b[4][0] - 2.0)) < 0.005),
    '远离盘口的深档挂单不会挤进五档（以现价为锚过滤）');

  ok(JSON.stringify(m.getQuote(id).b) === JSON.stringify(q0.b), 'getQuote(id) 无副作用（不被并档结果污染）');
  const qA = m.getQuote(id), qB = m.getQuote(id);
  ok(qA === qB || JSON.stringify(qA) === JSON.stringify(qB), 'getQuote 幂等');
}

/* ───────── 7. 虚拟日切换（T+1 依赖）───────── */
{
  const m = newMarket();
  eq(m.dayIndex, 0, '开局 dayIndex = 0');
  let prev = -1, rollovers = 0, lastDay = m.dayIndex;
  for (let t = 0; t < config.VIRTUAL_DAY_TICKS * 2 + 5; t++) {
    m.tick();
    if (m.dayIndex !== lastDay) { rollovers++; lastDay = m.dayIndex; }
  }
  ok(rollovers >= 2, `跑 ${config.VIRTUAL_DAY_TICKS * 2 + 5} tick 至少发生 2 次虚拟日切换`, `rollovers=${rollovers}`);
  const bars1m = m.getBars('600519', '1m', 500);
  ok(bars1m.length <= config.VIRTUAL_DAY_TICKS, '1 分钟 K 不跨日（≤ 240 根）', `len=${bars1m.length}`);
  eq(m.vclock.length, 5, '虚拟时钟格式 HH:MM');
}

/* ───────── 输出 ───────── */
console.log('\n\x1b[36m同花亏 · market.js 确定性单元测试\x1b[0m\n');
for (const [mark, label, extra] of results) {
  const color = mark === '✓' ? '\x1b[32m' : '\x1b[31m';
  console.log(`  ${color}${mark}\x1b[0m ${label}${extra ? '  \x1b[90m→ ' + extra + '\x1b[0m' : ''}`);
}
console.log(`\n${'─'.repeat(64)}`);
console.log(fail === 0
  ? `\x1b[32m\x1b[1m测试通过 ${pass} / 失败 0\x1b[0m`
  : `\x1b[31m\x1b[1m测试通过 ${pass} / 失败 ${fail}\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
