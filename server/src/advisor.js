'use strict';
/* ═══════════════════════════════════════════════════════════════
   同花亏 · AI 投资顾问（服务端权威版）

   为什么放在服务端：
     只有服务端知道每只股票的「内在价值 fair」、玩家冲击水平、全场持仓与排行。
     客户端拿不到这些，本地算出来的建议只能是"看图说话"。

   输出两块：
     advise()     个股诊断：0~100 综合评分 + 评级 + 依据 + 风险 + 可执行建议
     marketView() 大盘观点：市场情绪 + 涨跌家数 + 领涨板块 + 关注标的
   ═══════════════════════════════════════════════════════════════ */

const util = require('./util');
const { clamp, round2 } = util;

const RATINGS = [
  { min: 78, id: 'strong_buy', text: '强烈买入', emoji: '🔥' },
  { min: 64, id: 'buy', text: '谨慎买入', emoji: '📈' },
  { min: 46, id: 'hold', text: '持有观望', emoji: '⏸' },
  { min: 33, id: 'reduce', text: '逢高减仓', emoji: '📉' },
  { min: -1, id: 'sell', text: '建议卖出', emoji: '🚨' },
];

function ratingOf(score) {
  for (const r of RATINGS) if (score >= r.min) return r;
  return RATINGS[RATINGS.length - 1];
}

function pctText(v) {
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
}

/* ───────── 均线 ───────── */
function ma(list, n) {
  if (!list || list.length < n) return null;
  let s = 0;
  for (let i = list.length - n; i < list.length; i++) s += list[i];
  return s / n;
}

/** 个股 AI 诊断 */
function advise({ market, seat, room, stockId, config }) {
  const st = market.getState(stockId);
  if (!st) return null;
  const q = market.getQuote(stockId);
  const stock = (config.STOCKS || []).find(s => s.id === stockId) || {};
  const price = Number(st.price) || 0;
  const fair = Number(st.fair) > 0 ? Number(st.fair) : price;
  const dev = fair > 0 ? price / fair - 1 : 0;                  // >0 高于内在价值
  const prevClose = Number(st.prevClose) || price;
  const dayPct = prevClose > 0 ? price / prevClose - 1 : 0;
  const limitUp = Number(st.limitUp) || price * 1.1;
  const limitDown = Number(st.limitDown) || price * 0.9;

  /* ── 1. 估值（30%）── */
  const valScore = clamp(55 - dev * 350, 0, 100);

  /* ── 2. 趋势（25%）：用当前虚拟交易日的 1 分钟 K ── */
  let bars = [];
  try { bars = market.getBars(stockId, '1m', 120) || []; } catch (e) { bars = []; }
  const closes = bars.map(b => b[4]);
  const m5 = ma(closes, 5), m10 = ma(closes, 10), m20 = ma(closes, 20);
  let trendScore = 50, trendText = '均线缠绕，方向不明';
  if (m5 != null && m10 != null && m20 != null) {
    const up = (price > m5 ? 1 : 0) + (m5 > m10 ? 1 : 0) + (m10 > m20 ? 1 : 0);
    trendScore = 18 + up * 26;
    if (up === 3) trendText = '多头排列，趋势向上';
    else if (up === 0) trendText = '空头排列，趋势向下';
    else if (up === 2) trendText = '均线偏多，趋势温和向上';
    else trendText = '均线偏空，反弹力度有限';
  } else if (closes.length >= 6) {
    const r = price / closes[closes.length - 6] - 1;
    trendScore = clamp(50 + r * 500, 0, 100);
    trendText = r > 0.005 ? '短线上行' : r < -0.005 ? '短线走弱' : '窄幅震荡';
  }

  /* ── 3. 动量（15%）：近 20 分钟涨速 ── */
  const back = closes.length > 20 ? closes[closes.length - 21] : (closes[0] || price);
  const mom = back > 0 ? price / back - 1 : 0;
  const momScore = clamp(50 + mom * 600, 0, 100);

  /* ── 4. 量能（10%）：本 tick 量 ÷ 当日平均每 tick 量（自校准的"量比"）── */
  const minutes = Math.max(1, market.minuteOfDay + 1);
  /* 最近一根 1 分钟 K 的量 = 本 tick（1 tick = 1 虚拟分钟）的真实成交量 */
  const curVol = bars.length ? (Number(bars[bars.length - 1][5]) || 0) : 0;
  const avgTickVol = Math.max(1, (Number(q && q.v) || 0) / minutes);   // 行情里的 v 是当日累计量
  const vr = curVol / avgTickVol;
  const volScore = clamp(38 + (vr - 1) * 42, 0, 100);
  const volText = vr > 1.8 ? '显著放量' : vr > 1.2 ? '温和放量' : vr > 0.75 ? '量能正常' : '缩量';

  /* ── 5. 盘口（10%）：委比 ── */
  let wb = 0;
  try {
    const bids = (q && q.b) || [], asks = (q && q.s) || [];
    let bv = 0, av = 0;
    for (const l of bids) bv += l[1];
    for (const l of asks) av += l[1];
    wb = (bv + av) > 0 ? (bv - av) / (bv + av) : 0;
  } catch (e) { wb = 0; }
  const bookScore = clamp(50 + wb * 120, 0, 100);

  /* ── 6. 风险（作为加分项：越安全分越高）── */
  const toUp = (limitUp - price) / Math.max(0.01, price);
  const toDown = (price - limitDown) / Math.max(0.01, price);
  const risk = [];
  let riskScore = 70;
  if (price >= limitUp - 0.005) { riskScore -= 35; risk.push('已封涨停板，追高需等回封确认，谨防炸板'); }
  else if (toUp < 0.015) { riskScore -= 18; risk.push(`距涨停仅 ${(toUp * 100).toFixed(1)}%，上行空间有限`); }
  if (price <= limitDown + 0.005) { riskScore -= 30; risk.push('已封跌停板，流动性枯竭，不要盲目抄底'); }
  else if (toDown < 0.015) { riskScore -= 8; risk.push(`距跌停仅 ${(toDown * 100).toFixed(1)}%，注意下行风险`); }
  const vol0 = Number(stock.vol) || 0.0025;
  if (vol0 >= 0.0055) { riskScore -= 12; risk.push('该股波动率显著高于市场平均，仓位要控制'); }
  if (dev > 0.12) { riskScore -= 12; risk.push(`股价已高出内在价值 ${(dev * 100).toFixed(1)}%，外部资金随时可能反向出货`); }
  if (dev < -0.15) { riskScore -= 6; risk.push('深度低于内在价值，可能隐含未反映的利空'); }
  if (vr < 0.5) { riskScore -= 6; risk.push('成交极度萎缩，进出场滑点会变大'); }
  if (!risk.length) risk.push('暂未发现明显异常风险');
  riskScore = clamp(riskScore, 0, 100);

  /* ── 综合评分 ── */
  const score = Math.round(clamp(
    valScore * 0.30 + trendScore * 0.25 + momScore * 0.15 + volScore * 0.10 +
    bookScore * 0.10 + riskScore * 0.10, 0, 100));
  const rating = ratingOf(score);

  /* ── 持仓相关建议 ── */
  const pf = seat && seat.pf;
  const pos = pf ? pf.getPosition(stockId) : null;
  const held = pos ? Number(pos.qty) || 0 : 0;
  const avgCost = pos ? Number(pos.avgCost) || 0 : 0;
  const pnlPct = held > 0 && avgCost > 0 ? price / avgCost - 1 : 0;
  let positionBlock = null;
  if (held > 0) {
    positionBlock = {
      held,
      avail: pos.avail || 0,
      avgCost: round2(avgCost),
      pnlPct: Math.round(pnlPct * 1e4) / 1e4,
      advice: rating.id === 'sell' || rating.id === 'reduce'
        ? (pnlPct >= 0 ? `已浮盈 ${pctText(pnlPct)}，建议分批止盈，先卖一半` : `已浮亏 ${pctText(pnlPct)}，反弹到成本价附近减仓`)
        : (pnlPct < -0.08 ? `浮亏 ${pctText(pnlPct)}，若跌破 ${round2(price * 0.95)} 坚决止损` : `继续持有，跌破 ${round2(price * 0.96)} 止盈保护`),
    };
  }

  /* ── 可执行建议 ── */
  const qtyPct = rating.id === 'strong_buy' ? 0.4 : rating.id === 'buy' ? 0.25
    : rating.id === 'hold' ? 0 : rating.id === 'reduce' ? 0.5 : 1;
  const stopLoss = round2(price * (1 - clamp(vol0 * 6 + 0.02, 0.025, 0.09)));
  const takeProfit = round2(price * (1 + clamp(vol0 * 8 + 0.04, 0.05, 0.18)));
  const suggestion = {
    action: rating.id,
    actionText: rating.id === 'strong_buy' ? '可分批建仓（首仓 4 成）'
      : rating.id === 'buy' ? '可轻仓试错（2~3 成）'
        : rating.id === 'hold' ? (held > 0 ? '持有不动，等待方向选择' : '暂不参与，等放量突破')
          : rating.id === 'reduce' ? '逢高减掉一半仓位'
            : '清仓离场，不要摊平成本',
    qtyPct,
    priceLow: round2(price * 0.997),
    priceHigh: round2(price * 1.003),
    stopLoss,
    takeProfit,
  };

  /* ── 依据与结论 ── */
  const signals = [
    { k: '估值', v: dev <= -0.03 ? `低于内在价值 ${(Math.abs(dev) * 100).toFixed(1)}%` : dev >= 0.03 ? `高于内在价值 ${(dev * 100).toFixed(1)}%` : '与内在价值基本持平', dir: dev <= -0.03 ? 1 : dev >= 0.03 ? -1 : 0 },
    { k: '趋势', v: trendText, dir: trendScore >= 62 ? 1 : trendScore <= 38 ? -1 : 0 },
    { k: '动量', v: `近 20 分钟 ${pctText(mom)}`, dir: momScore >= 60 ? 1 : momScore <= 40 ? -1 : 0 },
    { k: '量能', v: `${volText}（${vr.toFixed(2)} 倍）`, dir: vr > 1.6 ? 1 : vr < 0.6 ? -1 : 0 },
    { k: '盘口', v: wb > 0.12 ? '买盘明显强于卖盘' : wb < -0.12 ? '卖压偏重' : '买卖力量均衡', dir: wb > 0.12 ? 1 : wb < -0.12 ? -1 : 0 },
    { k: '当日', v: `${pctText(dayPct)}（昨收 ${round2(prevClose)}）`, dir: dayPct > 0.005 ? 1 : dayPct < -0.005 ? -1 : 0 },
  ];

  const lead = [];
  if (dev <= -0.05) lead.push(`当前股价低于内在价值 ${(Math.abs(dev) * 100).toFixed(1)}%，具备安全边际`);
  if (dev >= 0.08) lead.push(`当前股价已高于内在价值 ${(dev * 100).toFixed(1)}%，外部资金有反向出货动机`);
  if (trendScore >= 74) lead.push('均线多头排列，趋势站在买方一边');
  if (trendScore <= 26) lead.push('均线空头排列，反弹到均线附近易遇抛压');
  if (vr > 1.6 && mom > 0) lead.push('放量上攻，资金关注度明显提升');
  if (vr < 0.6) lead.push('成交低迷，缺乏增量资金推动');
  if (Math.abs(st.impact || 0) > 0.03) lead.push(`近期玩家大额${(st.impact || 0) > 0 ? '买入' : '卖出'}已使股价偏离合理区间 ${(Math.abs(st.impact) * 100).toFixed(1)}%`);
  if (!lead.length) lead.push('各项指标中性，缺乏明确的方向性驱动');

  const summary = `${rating.emoji} ${rating.text}（综合 ${score} 分）。${lead.slice(0, 2).join('；')}。`;

  return {
    t: 'ai:advice',
    stockId,
    name: stock.name || st.name || stockId,
    ts: Date.now(),
    score,
    rating: rating.id,
    ratingText: rating.text,
    summary,
    fair: round2(fair),
    dev: Math.round(dev * 1e4) / 1e4,
    dayPct: Math.round(dayPct * 1e4) / 1e4,
    breakdown: {
      valuation: Math.round(valScore), trend: Math.round(trendScore), momentum: Math.round(momScore),
      volume: Math.round(volScore), orderbook: Math.round(bookScore), risk: Math.round(riskScore),
    },
    signals,
    risks: risk.slice(0, 4),
    position: positionBlock,
    suggestion,
  };
}

/** 大盘 AI 观点 */
function marketView({ market, room, config }) {
  const stocks = (config.STOCKS || []);
  let up = 0, down = 0, flat = 0, limitUp = 0, limitDown = 0;
  const secAgg = new Map();
  const rows = [];
  for (const s of stocks) {
    const st = market.getState(s.id);
    const q = market.getQuote(s.id);
    if (!st || !q) continue;
    const pc = Number(st.prevClose) || st.price;
    const chg = pc > 0 ? st.price / pc - 1 : 0;
    if (chg > 0.002) up++; else if (chg < -0.002) down++; else flat++;
    if (st.price >= st.limitUp - 0.005) limitUp++;
    if (st.price <= st.limitDown + 0.005) limitDown++;
    const cur = secAgg.get(s.sector) || { sector: s.sector, sum: 0, n: 0 };
    cur.sum += chg; cur.n++; secAgg.set(s.sector, cur);
    const dev = Number(st.fair) > 0 ? st.price / st.fair - 1 : 0;
    rows.push({ id: s.id, name: s.name, chg, dev, price: st.price, vol: Number(s.vol) || 0.0025 });
  }
  const idx = market.getIndices();
  const aIdx = idx.find(i => i.c === 'THKZ') || idx[0] || { v: 0, pct: 0, n: '同花综指' };
  const usIdx = idx.find(i => i.c === 'IXIC');

  const secs = Array.from(secAgg.values())
    .map(x => ({ sector: x.sector, pct: x.sum / Math.max(1, x.n) }))
    .sort((a, b) => b.pct - a.pct);

  const mood = aIdx.pct >= 0.02 ? { id: 'strong', text: '普涨格局', desc: '资金全面做多，注意情绪过热后的回踩' }
    : aIdx.pct >= 0.005 ? { id: 'warm', text: '偏暖震荡', desc: '赚钱效应尚可，可轻仓参与强势股' }
      : aIdx.pct > -0.005 ? { id: 'flat', text: '多空胶着', desc: '方向不明，控制仓位、少动多看' }
        : aIdx.pct > -0.02 ? { id: 'weak', text: '偏弱调整', desc: '反弹是减仓机会，不宜追涨' }
          : { id: 'panic', text: '恐慌杀跌', desc: '空仓等待企稳，不要在下跌中接飞刀' };

  /* 关注标的：低估 + 动量向上 + 流动性尚可 */
  const picks = rows
    .map(r => {
      const val = clamp(55 - r.dev * 350, 0, 100);
      const mom = clamp(50 + r.chg * 400, 0, 100);
      const riskPen = r.vol >= 0.006 ? 12 : r.vol >= 0.005 ? 6 : 0;
      return { ...r, aiScore: Math.round(clamp(val * 0.5 + mom * 0.3 + 60 * 0.2 - riskPen, 0, 100)) };
    })
    .sort((a, b) => b.aiScore - a.aiScore)
    .slice(0, 3);

  const hotSector = secs[0], coldSector = secs[secs.length - 1];
  const summary = `${aIdx.n} ${round2(aIdx.v)}（${pctText(aIdx.pct)}），全市场 ${up} 涨 / ${down} 跌 / ${flat} 平，涨停 ${limitUp} 家、跌停 ${limitDown} 家 —— ${mood.text}。${mood.desc}。`;

  const lines = [
    `领涨板块：${hotSector ? `${hotSector.sector}（${pctText(hotSector.pct)}）` : '—'}`,
    `领跌板块：${coldSector ? `${coldSector.sector}（${pctText(coldSector.pct)}）` : '—'}`,
  ];
  if (usIdx) lines.push(`纳斯达克综指 ${round2(usIdx.v)}（${pctText(usIdx.pct)}）`);
  if (limitUp >= 5) lines.push(`涨停家数达 ${limitUp} 家，情绪偏热，注意次日分化`);
  if (limitDown >= 5) lines.push(`跌停家数达 ${limitDown} 家，注意规避补跌风险`);

  return {
    t: 'ai:market',
    ts: Date.now(),
    summary,
    mood,
    index: { name: aIdx.n, v: round2(aIdx.v), pct: Math.round(aIdx.pct * 1e4) / 1e4 },
    breadth: { up, down, flat, limitUp, limitDown },
    sectors: secs.slice(0, 3).concat(secs.slice(-2)).map(x => ({ sector: x.sector, pct: Math.round(x.pct * 1e4) / 1e4 })),
    lines,
    picks: picks.map(p => ({
      id: p.id, name: p.name, price: round2(p.price),
      chg: Math.round(p.chg * 1e4) / 1e4, dev: Math.round(p.dev * 1e4) / 1e4, aiScore: p.aiScore,
      reason: p.dev <= -0.04 ? '低于内在价值，安全边际较高'
        : p.chg > 0.01 ? '短线动量强，资金关注度高'
          : '估值与动量均衡，适合跟踪',
    })),
  };
}

module.exports = { advise, marketView, ratingOf, RATINGS };
