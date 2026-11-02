'use strict';
/* ═══════════════════════════════════════════════════════════════
   同花亏 · AI 投资顾问单元测试（确定性·无网络）
   运行：node server/test/ai.test.js
   ═══════════════════════════════════════════════════════════════ */

const config = require('../src/config');
const { Market } = require('../src/market');
const advisor = require('../src/advisor');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  \x1b[90m→ ' + extra + '\x1b[0m' : ''}`); }
};
const eq = (name, got, want) => ok(got === want, name, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
const has = (obj, keys, label) => {
  const miss = keys.filter(k => obj == null || obj[k] === undefined);
  ok(miss.length === 0, `${label} 字段完整`, miss.length ? '缺少 ' + miss.join(',') : '');
};
const section = (t) => console.log(`\n\x1b[36m──── ${t} ────\x1b[0m`);

/* 构造一个已经跑了一段的行情的市场（固定随机种子 → 可复现） */
function buildMarket(participants = 1, ticks = 90) {
  const m = new Market({ stocks: config.STOCKS, config, participants });
  m.seed(20240918);
  m.reset();
  for (let i = 0; i < ticks; i++) m.tick();
  return m;
}

/* ═════════ 1. 评级边界 ═════════ */
section('1. 评级映射');
eq('90 分 → 强烈买入', advisor.ratingOf(90).id, 'strong_buy');
eq('78 分 → 强烈买入', advisor.ratingOf(78).id, 'strong_buy');
eq('77 分 → 谨慎买入', advisor.ratingOf(77).id, 'buy');
eq('64 分 → 谨慎买入', advisor.ratingOf(64).id, 'buy');
eq('63 分 → 持有观望', advisor.ratingOf(63).id, 'hold');
eq('46 分 → 持有观望', advisor.ratingOf(46).id, 'hold');
eq('45 分 → 逢高减仓', advisor.ratingOf(45).id, 'reduce');
eq('33 分 → 逢高减仓', advisor.ratingOf(33).id, 'reduce');
eq('32 分 → 建议卖出', advisor.ratingOf(32).id, 'sell');
eq('0 分 → 建议卖出', advisor.ratingOf(0).id, 'sell');

/* ═════════ 2. 个股诊断结构 ═════════ */
section('2. 个股诊断：结构完整性');
const m = buildMarket(1);
const a = advisor.advise({ market: m, seat: null, room: null, stockId: '600519', config });
has(a, ['t', 'stockId', 'name', 'ts', 'score', 'rating', 'ratingText', 'summary',
  'fair', 'dev', 'dayPct', 'breakdown', 'signals', 'risks', 'suggestion'], '诊断对象');
has(a.breakdown, ['valuation', 'trend', 'momentum', 'volume', 'orderbook', 'risk'], '六维分项');
has(a.suggestion, ['action', 'actionText', 'qtyPct', 'priceLow', 'priceHigh', 'stopLoss', 'takeProfit'], '操作建议');
eq('t = ai:advice', a.t, 'ai:advice');
eq('股票名正确', a.name, '贵州毛台');
ok(a.score >= 0 && a.score <= 100, `综合评分在 0~100（${a.score}）`);
ok(a.rating === advisor.ratingOf(a.score).id, 'rating 与 score 一致');
ok(a.signals.length >= 5, `判断依据 ≥5 条（${a.signals.length}）`);
ok(a.signals.every(s => s.k && s.v !== undefined && [1, 0, -1].includes(s.dir)), '依据条目含 k/v/dir');
ok(a.risks.length >= 1 && a.risks.length <= 4, `风险提示 1~4 条（${a.risks.length}）`);
ok(Object.values(a.breakdown).every(v => v >= 0 && v <= 100), '分项评分均在 0~100');
ok(a.suggestion.stopLoss < a.suggestion.priceLow && a.suggestion.priceHigh < a.suggestion.takeProfit,
  `止损 < 买区 < 止盈（${a.suggestion.stopLoss} < ${a.suggestion.priceLow}~${a.suggestion.priceHigh} < ${a.suggestion.takeProfit}）`);
ok(typeof a.fair === 'number' && a.fair > 0, `内在价值有效（${a.fair}）`);
eq('未持仓时 position = null', a.position, null);

/* ═════════ 3. 估值项：高估必须比低估分低 ═════════ */
section('3. 估值项方向性（核心：外部制衡的内在一价值）');
const st = m.S.get('600519');
const fair = st.fair;
const keep = { price: st.price, high: st.high, low: st.low };
st.price = Math.round(fair * 1.25 * 100) / 100;          // 高估 25%
const hi = advisor.advise({ market: m, seat: null, room: null, stockId: '600519', config });
st.price = Math.round(fair * 0.78 * 100) / 100;          // 低估 22%
const lo = advisor.advise({ market: m, seat: null, room: null, stockId: '600519', config });
ok(hi.breakdown.valuation < lo.breakdown.valuation,
  `高估时估值分更低（高估 ${hi.breakdown.valuation} < 低估 ${lo.breakdown.valuation}）`);
ok(lo.breakdown.valuation >= 80, `深度低估时估值分 ≥80（${lo.breakdown.valuation}）`);
ok(hi.breakdown.valuation <= 25, `深度高估时估值分 ≤25（${hi.breakdown.valuation}）`);
ok(hi.dev > 0.2 && lo.dev < -0.2, `dev 计算正确（高估 ${(hi.dev * 100).toFixed(1)}% / 低估 ${(lo.dev * 100).toFixed(1)}%）`);
ok(lo.signals[0].dir === 1 && hi.signals[0].dir === -1, '低估/高估时估值信号方向相反');
ok(hi.risks.some(r => r.includes('内在价值')), '高估时报出「高于内在价值」风险');
st.price = keep.price; st.high = keep.high; st.low = keep.low;

/* ═════════ 4. 持仓建议 ═════════ */
section('4. 持仓相关建议');
const price = st.price;
const fakePf = (qty, avgCost) => ({ getPosition: (id) => (id === '600519' ? { qty, avail: qty, avgCost } : null) });
const win = advisor.advise({ market: m, seat: { pf: fakePf(500, price * 0.9) }, room: null, stockId: '600519', config });
ok(win.position && win.position.held === 500, '持仓数量透出');
ok(Math.abs(win.position.pnlPct - 0.1111) < 0.02, `浮盈比例正确（${(win.position.pnlPct * 100).toFixed(1)}%）`);
ok(typeof win.position.advice === 'string' && win.position.advice.length > 4, `给出持仓操作建议（${win.position.advice}）`);
const lose = advisor.advise({ market: m, seat: { pf: fakePf(500, price * 1.3) }, room: null, stockId: '600519', config });
ok(lose.position.pnlPct < -0.2, `浮亏比例正确（${(lose.position.pnlPct * 100).toFixed(1)}%）`);
ok(lose.position.advice.includes('止损') || lose.position.advice.includes('减仓'), `深套时提示止损/减仓（${lose.position.advice}）`);
const noPos = advisor.advise({ market: m, seat: { pf: fakePf(0, 0) }, room: null, stockId: '600519', config });
eq('持仓为 0 时 position = null', noPos.position, null);

/* ═════════ 5. 边界与异常 ═════════ */
section('5. 边界与异常');
eq('不存在的代码 → null', advisor.advise({ market: m, seat: null, room: null, stockId: 'XXX', config }), null);
const allIds = config.STOCKS.map(s => s.id);
let allOk = true, badId = '';
for (const id of allIds) {
  const r = advisor.advise({ market: m, seat: null, room: null, stockId: id, config });
  if (!r || !(r.score >= 0 && r.score <= 100) || !r.rating || !r.suggestion) { allOk = false; badId = id; break; }
}
ok(allOk, `${allIds.length} 只股票全部可诊断且评分合法`, badId ? `失败于 ${badId}` : '');

/* ═════════ 6. 大盘观点 ═════════ */
section('6. 大盘 AI 观点');
const mv = advisor.marketView({ market: m, room: null, config });
has(mv, ['t', 'ts', 'summary', 'mood', 'index', 'breadth', 'sectors', 'lines', 'picks'], '大盘对象');
eq('t = ai:market', mv.t, 'ai:market');
const b = mv.breadth;
eq('涨 + 跌 + 平 = 股票总数', b.up + b.down + b.flat, config.STOCKS.length);
ok(b.limitUp >= 0 && b.limitDown >= 0, `涨跌停家数非负（${b.limitUp} / ${b.limitDown}）`);
ok(mv.summary.includes('同花综指'), '摘要含指数名');
ok(mv.lines.length >= 2, `要点 ≥2 行（${mv.lines.length}）`);
ok(mv.picks.length === 3, `关注标的 3 只（${mv.picks.length}）`);
ok(mv.picks.every(p => p.aiScore >= 0 && p.aiScore <= 100 && p.reason && p.id), '关注标的字段完整');
ok(mv.picks.every(p => config.STOCKS.some(s => s.id === p.id)), '关注标的均为真实股票代码');
ok(mv.picks[0].aiScore >= mv.picks[1].aiScore && mv.picks[1].aiScore >= mv.picks[2].aiScore, '关注标的按 AI 分降序');
const moods = ['strong', 'warm', 'flat', 'weak', 'panic'];
ok(moods.includes(mv.mood.id), `市场情绪取值合法（${mv.mood.id}）`);

/* ═════════ 7. 人数不改变诊断口径 ═════════ */
section('7. 不同人数下的稳定性');
const m30 = buildMarket(30);
const a30 = advisor.advise({ market: m30, seat: null, room: null, stockId: '600519', config });
ok(a30 && a30.score >= 0 && a30.score <= 100, `30 人局同样可诊断（${a30.score} 分 ${a30.ratingText}）`);
const mv30 = advisor.marketView({ market: m30, room: null, config });
eq('30 人局涨跌家数合计仍等于总数', mv30.breadth.up + mv30.breadth.down + mv30.breadth.flat, config.STOCKS.length);

console.log(`\n\x1b[36m────────────────────────────────────────────────────────────────\x1b[0m`);
console.log(fail === 0
  ? `\x1b[32m\x1b[1m测试通过 ${pass} / 失败 0\x1b[0m`
  : `\x1b[31m\x1b[1m测试通过 ${pass} / 失败 ${fail}\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
