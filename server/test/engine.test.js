'use strict';
/* ═══════════════════════════════════════════════════════════════
   同花亏 · 撮合引擎 / 资金持仓 单元测试（确定性·无网络）
   运行：node server/test/engine.test.js

   覆盖以下曾经出过问题或容易退化的不变量：
     1. 冻结守恒：挂单 / 撤单 / 成交前后 cash + frozen 不变
     2. 玩家交叉撮合
     3. 费用口径：佣金 max(额×0.025%, 5) + 印花税(卖) + 过户费(双向)
     4. 未成交委托数上限
     5. T+1：当日买入不可卖，次交易日可卖
     6. 资产自洽：totalAssets = cash + frozen + 持仓市值
     7. 【回归】每 tick 回扫可成交挂单（曾经挂单被行情反超后永远不成交，
        盘口还会出现「买一 ≥ 卖一」的交叉）
   ═══════════════════════════════════════════════════════════════ */

const config = require('../src/config');
const { Market } = require('../src/market');
const { MatchingEngine } = require('../src/engine');
const Portfolio = require('../src/portfolio');

let pass = 0, fail = 0;
const ok = (c, name, extra) => {
  if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  \x1b[90m→ ' + extra + '\x1b[0m' : ''}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.011 : tol);
const section = (t) => console.log(`\n\x1b[36m──── ${t} ────\x1b[0m`);

function freshMarket(seed, participants = 2) {
  const m = new Market({ stocks: config.STOCKS, config, participants });
  m.seed(seed); m.reset(); m.tick(); m.tick();
  return m;
}
function pair(seed) {
  const m = freshMarket(seed);
  const eng = new MatchingEngine({ market: m, config });
  const A = new Portfolio({ id: 'A', startCash: 1000000, config, market: m });
  const B = new Portfolio({ id: 'B', startCash: 1000000, config, market: m });
  eng.registerPortfolio(A); eng.registerPortfolio(B);
  return { m, eng, A, B };
}
const rest = { seat: { player: { id: 'A' } } };

/* ═════════ 1. 冻结守恒 ═════════ */
section('1. 冻结守恒（挂单 / 撤单 / 成交）');
{
  const { m, eng, A } = pair(3);
  const ID = '600519';
  const q = m.getQuote(ID);
  const before = A.cash + A.frozen;
  const r = eng.placeOrder(A, { stockId: ID, side: 'buy', type: 'limit', price: Math.round((q.b[0][0] - 1) * 100) / 100, qty: 100 }, rest);
  ok(r.ok === true, '限价买单可下', r.msg);
  ok(near(A.cash + A.frozen, before, 0.011), '挂单前后 cash+frozen 守恒', `${before.toFixed(2)} → ${(A.cash + A.frozen).toFixed(2)}`);
  ok(A.frozen > 0, '买单冻结了资金', `frozen=${A.frozen.toFixed(2)}`);
  const oid = r.order.id;
  eng.cancelOrder(A, oid);
  ok(near(A.cash + A.frozen, before, 0.011), '撤单后 cash+frozen 回到原值', `${(A.cash + A.frozen).toFixed(2)} vs ${before.toFixed(2)}`);
  ok(A.frozen === 0, '撤单后冻结清零', `frozen=${A.frozen}`);
}

/* ═════════ 2. 玩家交叉撮合 ═════════ */
section('2. 玩家之间交叉撮合');
{
  const { m, eng, A, B } = pair(3);
  const ID = '600519';
  A.applyTrade({ stockId: ID, side: 'buy', price: 1000, qty: 100, fee: 0 });
  A.settleDay(1);                                   // 次交易日 → T+1 解冻
  const pa = A.getPosition(ID);
  ok(pa && pa.qty === 100 && pa.avail === 100, '准备：卖方持有 100 股且可卖', JSON.stringify({ qty: pa && pa.qty, avail: pa && pa.avail }));
  const q = m.getQuote(ID);
  const bid = Math.round((q.b[0][0] + 0.5) * 100) / 100;   // 买方出高价
  const ask = Math.round((q.b[0][0] - 0.5) * 100) / 100;   // 卖方出低价
  eng.placeOrder(B, { stockId: ID, side: 'buy', type: 'limit', price: bid, qty: 100 }, { seat: { player: { id: 'B' } } });
  eng.placeOrder(A, { stockId: ID, side: 'sell', type: 'limit', price: ask, qty: 100 }, rest);
  const pA = A.getPosition(ID), pB = B.getPosition(ID);
  ok(!pA || pA.qty === 0, '卖方持仓被买方接走', JSON.stringify(pA && { qty: pA.qty }));
  ok(pB && pB.qty === 100, '买方持仓 100 股', JSON.stringify(pB && { qty: pB.qty }));
  ok(A.trades.length >= 1, '卖方有成交记录', `trades=${A.trades.length}`);
}

/* ═════════ 3. 费用口径 ═════════ */
section('3. 费用口径（精确到分）');
{
  const { m, eng } = pair(3);
  const ID = '000858';
  const pf = new Portfolio({ id: 'S', startCash: 1000000, config, market: m });
  eng.registerPortfolio(pf);
  // 真实买入建仓 → 次日才可卖
  eng.placeOrder(pf, { stockId: ID, side: 'buy', type: 'market', qty: 100 }, { seat: { player: { id: 'S' } } });
  pf.settleDay(1);
  const pos = pf.getPosition(ID);
  ok(pos && pos.avail === 100, '准备：次日可卖 100 股', JSON.stringify(pos && { qty: pos.qty, avail: pos.avail }));

  const cash0 = pf.cash, trades0 = pf.trades.length;
  const q = m.getQuote(ID);
  eng.placeOrder(pf, { stockId: ID, side: 'sell', type: 'market', qty: 100 }, { seat: { player: { id: 'S' } } });
  ok(pf.trades.length > trades0, '卖出生成了新成交', `trades ${trades0} → ${pf.trades.length}`);
  /* 注意：pf.trades 是「最新在前」，不能取最后一个元素当本次成交 */
  const fills = pf.trades.slice(0, pf.trades.length - trades0).filter(t => t.side === 'sell');
  if (fills.length) {
    const amt = fills.reduce((a, t) => a + t.price * t.qty, 0);
    /* 分笔成交时每笔各自计费（最低佣金按笔），所以按笔累加期望费用 */
    const expFee = fills.reduce((a, t) => {
      const x = t.price * t.qty;
      return a + Math.max(x * 0.00025, 5) + x * 0.0005 + x * 0.00001;
    }, 0);
    ok(near(pf.cash - cash0, amt - expFee, 0.03),
      '卖出净收入 = Σ各笔(成交额 − 佣金 − 印花税 − 过户费)',
      `${fills.length} 笔 共 ${amt.toFixed(2)}；现金 +${(pf.cash - cash0).toFixed(2)}，期望 +${(amt - expFee).toFixed(2)}（费用 ${expFee.toFixed(2)}）`);
    ok(pf.frozen === 0, '卖出成交后无残留冻结', `frozen=${pf.frozen}`);
  } else ok(false, '卖出产生了成交');
  // 直接核对 calcFee 口径
  const amt2 = 20000;
  const exp2 = Math.max(amt2 * 0.00025, 5) + amt2 * 0.0005 + amt2 * 0.00001;
  ok(near(pf.calcFee(amt2, 'sell'), exp2, 0.011), 'calcFee(卖出 2 万元) 口径正确', `${pf.calcFee(amt2, 'sell')} vs ${exp2.toFixed(2)}`);
  const exp3 = Math.max(amt2 * 0.00025, 5) + amt2 * 0.00001;
  ok(near(pf.calcFee(amt2, 'buy'), exp3, 0.011), 'calcFee(买入 2 万元) 不含印花税', `${pf.calcFee(amt2, 'buy')} vs ${exp3.toFixed(2)}`);
  ok(near(pf.calcFee(1000, 'buy'), 5 + 0.01, 0.011), '小额买入触发 5 元最低佣金', `${pf.calcFee(1000, 'buy')}`);
}

/* ═════════ 4. 未成交委托数上限 ═════════ */
section('4. 未成交委托数上限');
{
  const { m, eng } = pair(3);
  const C = new Portfolio({ id: 'C', startCash: 1000000, config, market: m });
  eng.registerPortfolio(C);
  const cheap = config.STOCKS.filter(s => s.prevClose < 15).sort((a, b) => a.prevClose - b.prevClose)[0];
  const maxOrders = config.MAX_ORDERS_PER_PLAYER || 200;
  let placed = 0, rejected = null;
  for (let i = 0; i < maxOrders + 30; i++) {
    const rr = eng.placeOrder(C, { stockId: cheap.id, side: 'buy', type: 'limit', price: Math.round(cheap.prevClose * 0.9 * 100) / 100, qty: 100 }, { seat: { player: { id: 'C' } } });
    if (rr.ok === false) { rejected = rr.msg; break; }
    placed++;
  }
  ok(rejected != null && /过多|上限/.test(rejected), `未成交委托达到 ${maxOrders} 笔后被拒`, `挂成 ${placed} 笔，文案：${rejected}`);
}

/* ═════════ 5. T+1 ═════════ */
section('5. T+1（当日买入不可卖）');
{
  const { m, eng } = pair(8);
  const ID = '600519';
  const C = new Portfolio({ id: 'C', startCash: 1000000, config, market: m });
  eng.registerPortfolio(C);
  eng.placeOrder(C, { stockId: ID, side: 'buy', type: 'market', qty: 100 }, { seat: { player: { id: 'C' } } });
  const p = C.getPosition(ID);
  ok(p && p.qty > 0 && p.avail === 0, '当日买入 avail = 0', JSON.stringify(p && { qty: p.qty, avail: p.avail }));
  const r = eng.placeOrder(C, { stockId: ID, side: 'sell', type: 'limit', price: m.getQuote(ID).b[0][0], qty: 100 }, { seat: { player: { id: 'C' } } });
  ok(r.ok === false, '当日卖出被拒', r.msg);
  C.settleDay(1);
  const p2 = C.getPosition(ID);
  ok(p2 && p2.avail === p2.qty && p2.qty > 0, '次交易日全部变为可卖', JSON.stringify(p2 && { qty: p2.qty, avail: p2.avail }));
}

/* ═════════ 6. 资产自洽 ═════════ */
section('6. 资产自洽');
{
  const { m, eng, A, B } = pair(11);
  const q = m.getQuote('600519');
  eng.placeOrder(A, { stockId: '600519', side: 'buy', type: 'limit', price: Math.round((q.s[0][0]) * 100) / 100, qty: 100 }, rest);
  eng.placeOrder(B, { stockId: '000858', side: 'buy', type: 'limit', price: 100, qty: 100 }, { seat: { player: { id: 'B' } } });
  for (const [n, pf] of [['A', A], ['B', B]]) {
    const acc = pf.computeAssets();
    ok(near(acc.cash + acc.frozen + acc.marketValue, acc.totalAssets, 1), `${n}：totalAssets = cash + frozen + 持仓市值`,
      `${(acc.cash + acc.frozen + acc.marketValue).toFixed(2)} vs ${acc.totalAssets.toFixed(2)}`);
  }
}

/* ═════════ 7.【回归】每 tick 回扫可成交挂单 ═════════ */
section('7.【回归】挂单被行情反超后必须自动成交');
{
  // 买单：挂在买一下方，随后行情暴跌穿过挂单价
  const m = freshMarket(21, 1);
  const eng = new MatchingEngine({ market: m, config });
  const P = new Portfolio({ id: 'P', startCash: 1000000, config, market: m });
  eng.registerPortfolio(P);
  const ID = '600519';
  let q = m.getQuote(ID);
  const px = Math.round((q.b[0][0] - 2) * 100) / 100;
  eng.placeOrder(P, { stockId: ID, side: 'buy', type: 'limit', price: px, qty: 100 }, { seat: { player: { id: 'P' } } });
  for (let i = 0; i < 12; i++) {
    m.tick();
    const qq = m.getQuote(ID);
    m.applyFlow(ID, -Math.max(100, Math.round(3000000 / qq.p / 100) * 100), 'sell', 3000000, qq.p);
    eng.onTick({ vtime: m.vtime, dayIndex: m.dayIndex });
  }
  q = m.getQuote(ID);
  const pos = P.getPosition(ID);
  ok(pos && pos.qty === 100, `买单被反超后自动成交（挂 ${px}，市价 ${q.p.toFixed(2)}）`, `持仓 ${(pos && pos.qty) || 0}`);
  ok(P.frozen === 0, '成交后冻结清零', `frozen=${P.frozen.toFixed(2)}`);
  const bk = eng.book.get(ID);
  ok(!bk || !bk.bids.length || bk.bids[0].price < q.s[0][0], '盘口不再出现「买一 ≥ 卖一」交叉');
  ok(P.trades.every(t => t.price <= px + 1e-9), '成交价严格不高于买入限价', JSON.stringify(P.trades.map(t => t.price)));
}
{
  // 卖单：挂在卖一上方，随后行情暴涨穿过挂单价
  const m = freshMarket(5, 1);
  const eng = new MatchingEngine({ market: m, config });
  const P = new Portfolio({ id: 'Q', startCash: 1000000, config, market: m });
  eng.registerPortfolio(P);
  P.applyTrade({ stockId: '000858', side: 'buy', price: 100, qty: 100, fee: 0 });
  P.settleDay(1);
  const ID = '000858';
  let q = m.getQuote(ID);
  const px = Math.round((q.s[0][0] + 2) * 100) / 100;
  eng.placeOrder(P, { stockId: ID, side: 'sell', type: 'limit', price: px, qty: 100 }, { seat: { player: { id: 'Q' } } });
  for (let i = 0; i < 12; i++) {
    m.tick();
    const qq = m.getQuote(ID);
    m.applyFlow(ID, Math.max(100, Math.round(3000000 / qq.p / 100) * 100), 'buy', 3000000, qq.p);
    eng.onTick({ vtime: m.vtime, dayIndex: m.dayIndex });
  }
  const pos = P.getPosition(ID);
  ok(!pos || pos.qty === 0, '卖单被反超后自动成交', `剩余 ${(pos && pos.qty) || 0}`);
  ok(P.trades.every(t => t.side !== 'sell' || t.price >= px - 1e-9), '成交价严格不低于卖出限价');
}
{
  // 价格没到的挂单不许被误成交
  const m = freshMarket(9, 1);
  const eng = new MatchingEngine({ market: m, config });
  const P = new Portfolio({ id: 'R', startCash: 1000000, config, market: m });
  eng.registerPortfolio(P);
  const ID = '600519';
  const q = m.getQuote(ID);
  const st0 = m.getState(ID);
  const px = Math.round((st0.limitDown + 0.01) * 100) / 100;  // 贴近跌停（合法但远不可成交）
  eng.placeOrder(P, { stockId: ID, side: 'buy', type: 'limit', price: px, qty: 100 }, { seat: { player: { id: 'R' } } });
  for (let i = 0; i < 10; i++) { m.tick(); eng.onTick({ vtime: m.vtime, dayIndex: m.dayIndex }); }
  const ord = Array.from(P.orders.values())[0] || (Array.isArray(P.orders) ? P.orders[0] : null);
  const lastPx = m.getQuote(ID).b[0][0];
  ok(!!ord && ord.status === 'open' && !((P.getPosition(ID) || {}).qty), '价格未到的挂单保持 open（不被误成交）',
    `委托数 ${P.orders && P.orders.size}，状态 ${ord && ord.status}，现价买一 ${lastPx}，挂单价 ${px}`);
}

console.log(`\n\x1b[36m────────────────────────────────────────────────────────────────\x1b[0m`);
console.log(fail === 0
  ? `\x1b[32m\x1b[1m测试通过 ${pass} / 失败 0\x1b[0m`
  : `\x1b[31m\x1b[1m测试通过 ${pass} / 失败 ${fail}\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
