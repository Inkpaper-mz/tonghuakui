/* ═══════════════════════════════════════════════════════════════
   同花亏 · AI 机器人（DESIGN.md §3.9）
   四种性格：追涨杀跌 / 低吸高抛 / 韭菜 / 稳健网格
   difficulty(0~1) 越高越理性；step() 永不抛异常。
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const gconfig = require('./config');
const util = require('./util');

const PERSONALITIES = ['momentum', 'reversion', 'noob', 'grid'];
const CN = { momentum: '追涨杀跌', reversion: '低吸高抛', noob: '韭菜', grid: '稳健网格' };

/** difficulty → 性格权重（低水平更容易出韭菜） */
function weightsOf(d) {
  if (d < 0.34) return { noob: 0.50, momentum: 0.25, reversion: 0.15, grid: 0.10 };
  if (d < 0.67) return { noob: 0.20, momentum: 0.32, reversion: 0.28, grid: 0.20 };
  return { noob: 0.05, momentum: 0.28, reversion: 0.34, grid: 0.33 };
}

class BotBrain {
  /**
   * @param {{portfolio:object, market:object, engine:object, config?:object,
   *          stockIds?:string[], difficulty?:number}} opts
   */
  constructor({ portfolio, market, engine, config, stockIds, difficulty } = {}) {
    this.pf = portfolio || null;
    this.market = market || null;
    this.engine = engine || null;
    this.config = config || gconfig;
    this.stockIds = (Array.isArray(stockIds) && stockIds.length)
      ? stockIds.slice()
      : (this.config.STOCKS || []).map((s) => s.id);

    let d = Number(difficulty);
    if (!Number.isFinite(d)) d = 0.5;
    this.difficulty = util.clamp(d, 0, 1);
    this.personality = this._pickPersonality();
    this.personalityName = CN[this.personality] || this.personality;

    this.nextAt = new Map();      // stockId -> 下次可动用的 seq（10~40 tick）
    this.nextGlobalAt = 0;        // 全局节流，避免同一 tick 连续下单
    this.gridRef = new Map();     // 网格基准价
    this.hist = new Map();        // stockId -> 最近价格（动量用）
    this.rejectCooldownUntil = 0; // 连续废单后的冷静期
    this.seq = 0;
    this.stats = { orders: 0, rejected: 0, buys: 0, sells: 0 };
    this._rankSeq = -1;
    this._rankList = [];
  }

  _pickPersonality() {
    const w = weightsOf(this.difficulty);
    let r = Math.random();
    for (let i = 0; i < PERSONALITIES.length; i++) {
      const p = PERSONALITIES[i];
      r -= w[p] || 0;
      if (r <= 0) return p;
    }
    return 'reversion';
  }

  /* ───────────── 每 tick ───────────── */

  step({ seq, vtime } = {}) {
    try {
      const s = Number.isFinite(Number(seq)) ? Number(seq) : (this.seq + 1);
      this.seq = s;
      if (!this.pf || !this.engine) return;

      for (let i = 0; i < this.stockIds.length; i++) {
        const id = this.stockIds[i];
        const next = this.nextAt.get(id);
        if (next === undefined) { this.nextAt.set(id, s + util.randInt(1, 30)); continue; }
        if (s < next) continue;
        this.nextAt.set(id, s + util.randInt(10, 40));   // 单只股票 10~40 tick 才动一次
        if (s < this.nextGlobalAt) continue;
        if (s < this.rejectCooldownUntil) continue;
        this._act(id, s, vtime);
      }
    } catch (e) { /* 机器人绝不能影响对局 */ }
  }

  /* ───────────── 行情/账户访问 ───────────── */

  _quote(id) {
    try {
      const q = this.market && typeof this.market.getQuote === 'function' ? this.market.getQuote(id) : null;
      if (q && Number(q.p) > 0) return q;
    } catch (e) { /* ignore */ }
    return null;
  }

  _limits(id) {
    try {
      const st = this.market && typeof this.market.getState === 'function' ? this.market.getState(id) : null;
      if (st) {
        const up = Number(st.limitUp);
        const dn = Number(st.limitDown);
        if (Number.isFinite(up) && Number.isFinite(dn) && up > 0 && dn > 0) return { up, down: dn };
      }
    } catch (e) { /* ignore */ }
    const meta = (this.config.STOCKS || []).find((x) => x.id === id);
    if (meta && typeof this.config.limitPrices === 'function') {
      const l = this.config.limitPrices(meta);
      if (l && l.limitUp > 0) return { up: l.limitUp, down: l.limitDown };
    }
    return null;
  }

  _pos(id) {
    try {
      const p = this.pf.getPosition(id);
      if (p) return p;
    } catch (e) { /* ignore */ }
    return { qty: 0, avail: 0, avgCost: 0 };
  }

  _cash() {
    try { const c = Number(this.pf.getAvailableCash()); return Number.isFinite(c) ? c : 0; } catch (e) { return 0; }
  }

  _assets() {
    try { const a = this.pf.computeAssets(); if (a && Number.isFinite(a.totalAssets)) return a; } catch (e) { /* ignore */ }
    return { totalAssets: this._cash(), marketValue: 0, cash: this._cash(), pnl: 0, pnlPct: 0 };
  }

  /** 掉期用的涨幅榜（同一 seq 只算一次） */
  _rank(id) {
    if (this._rankSeq !== this.seq) {
      const list = [];
      for (let i = 0; i < this.stockIds.length; i++) {
        const sid = this.stockIds[i];
        const q = this._quote(sid);
        if (!q) continue;
        const pc = Number(q.pc) || 0;
        const chg = pc > 0 ? (Number(q.p) - pc) / pc : 0;
        list.push({ id: sid, chg });
      }
      list.sort((a, b) => b.chg - a.chg);
      this._rankList = list;
      this._rankSeq = this.seq;
    }
    for (let i = 0; i < this._rankList.length; i++) if (this._rankList[i].id === id) return i + 1;
    return this._rankList.length + 1;
  }

  _trend(id, price) {
    let arr = this.hist.get(id);
    if (!arr) { arr = []; this.hist.set(id, arr); }
    arr.push(price);
    if (arr.length > 12) arr.shift();
    if (arr.length < 4) return 0;
    return (price - arr[0]) / (arr[0] || price);
  }

  /* ───────────── 下单封装（前置校验，避免废单刷屏） ───────────── */

  _buy(id, qty, aggressive) {
    try {
      const lot = this.config.LOT_SIZE || 100;
      const q = this._quote(id);
      const l = this._limits(id);
      if (!q || !l) return false;
      let n = Math.floor(qty / lot) * lot;
      if (n <= 0) return false;
      const F = this.config.FEE || gconfig.FEE;
      const ref = Number(q.p);
      const need = (px, k) => {
        const a = util.round2(px * k);
        return util.round2(a + Math.max(a * F.commissionRate, F.commissionMin) + a * F.transferFee);
      };
      const bestAsk = (Array.isArray(q.s) && q.s[0] && Number(q.s[0][0]) > 0) ? Number(q.s[0][0]) : ref * 1.002;
      const bestBid = (Array.isArray(q.b) && q.b[0] && Number(q.b[0][0]) > 0) ? Number(q.b[0][0]) : ref * 0.998;
      // 约 35% 概率做被动报价（挂在盘口内侧），制造真实订单簿与玩家间成交；
      // 其余为主动报价（直接吃对手价），保证机器人有成交。
      const passive = Math.random() < 0.35;
      const px = util.round2(util.clamp(
        passive ? Math.min(bestBid + 0.01, ref) : (aggressive ? Math.max(ref, bestAsk) : ref * 1.002),
        l.down, l.up,
      ));
      if (ref >= l.up - 1e-9) return false;              // 已封涨停，买了也排不上
      const cash = this._cash();
      while (n >= lot && need(px, n) > cash + 1e-9) n -= lot;
      if (n < lot) return false;
      const r = this.engine.placeOrder(this.pf, { stockId: id, side: 'buy', type: 'limit', price: px, qty: n });
      this._after(r);
      return !!(r && r.ok);
    } catch (e) { return false; }
  }

  _sell(id, qty, aggressive) {
    try {
      const lot = this.config.LOT_SIZE || 100;
      const pos = this._pos(id);
      if (!(pos.avail > 0)) return false;
      let n = Math.min(Math.floor(qty), pos.avail);
      if (n <= 0) return false;
      if (n % lot !== 0) {
        if (n === pos.avail && pos.avail < lot) { /* 零股一次性卖出 */ }
        else n = Math.floor(n / lot) * lot;
      }
      if (n <= 0) return false;
      const q = this._quote(id);
      const l = this._limits(id);
      if (!q || !l) return false;
      if (Number(q.p) <= l.down + 1e-9) return false;    // 已封跌停，卖不掉
      const bestBid = (Array.isArray(q.b) && q.b[0] && Number(q.b[0][0]) > 0) ? Number(q.b[0][0]) : Number(q.p) * 0.998;
      const bestAsk = (Array.isArray(q.s) && q.s[0] && Number(q.s[0][0]) > 0) ? Number(q.s[0][0]) : Number(q.p) * 1.002;
      const passive = Math.random() < 0.35;              // 被动报价挂盘口内侧，等别人来吃
      const px = util.round2(util.clamp(
        passive ? Math.max(bestAsk - 0.01, Number(q.p)) : (aggressive ? Math.min(Number(q.p), bestBid) : Number(q.p) * 0.998),
        l.down, l.up,
      ));
      const r = this.engine.placeOrder(this.pf, { stockId: id, side: 'sell', type: 'limit', price: px, qty: n });
      this._after(r);
      return !!(r && r.ok);
    } catch (e) { return false; }
  }

  _after(r) {
    if (r && r.ok) {
      this.stats.orders += 1;
      if (r.order && r.order.side === 'buy') this.stats.buys += 1;
      else this.stats.sells += 1;
      this.nextGlobalAt = this.seq + util.randInt(1, 4);
    } else {
      this.stats.rejected += 1;
      this.rejectCooldownUntil = this.seq + util.randInt(3, 12);   // 废单后冷静，别刷屏
    }
  }

  _budgetQty(id, px, fraction) {
    const lot = this.config.LOT_SIZE || 100;
    const assets = this._assets();
    const cash = this._cash();
    const budget = Math.min(cash, Math.max(0, assets.totalAssets * fraction));
    const q = util.floorTo(budget / (px * 1.002), lot);
    return q;
  }

  /* ───────────── 性格派发 ───────────── */

  _act(id, s, vtime) {
    try {
      switch (this.personality) {
        case 'momentum': this._momentum(id); break;
        case 'reversion': this._reversion(id); break;
        case 'noob': this._noob(id); break;
        default: this._grid(id); break;
      }
    } catch (e) { /* ignore */ }
  }

  /** 追涨杀跌 */
  _momentum(id) {
    const q = this._quote(id);
    if (!q) return;
    const p = Number(q.p);
    const pc = Number(q.pc) || p;
    const chg = pc > 0 ? (p - pc) / pc : 0;
    const trend = this._trend(id, p);
    const pos = this._pos(id);
    const lvl = 0.004 + (1 - this.difficulty) * 0.012;
    const rank = this._rank(id);

    if (pos.avail > 0 && (chg < -lvl || (chg < 0 && trend < -lvl * 0.8))) {
      this._sell(id, pos.avail, true);                      // 跌得狠就割
      return;
    }
    if (pos.qty > 0) return;                                // 已有仓位不追
    if (chg > lvl && rank <= 3 && trend > 0) {
      const px = Number(q.s && q.s[0] && q.s[0][0]) || p;
      const frac = (0.18 + this.difficulty * 0.22) * (rank === 1 ? 1.2 : 1);
      const n = this._budgetQty(id, px, frac);
      if (n > 0) this._buy(id, n, true);
    }
  }

  /**
   * 当日均价参考线：
   * ① 行情提供的 avg（VWAP）；② 成交额/成交量；③ 回退到当日典型价 (h+l+p)/3。
   * 这样即使行情实现里成交额缺失（a=0），均值回归策略依然可用。
   */
  _avgRef(q) {
    const p = Number(q.p) || 0;
    let ref = Number(q.avg);
    if (!(ref > 0)) {
      const v = Number(q.v) || 0;
      const a = Number(q.a) || 0;
      ref = v > 0 && a > 0 ? a / v : 0;
    }
    if (!(ref > 0)) {
      const h = Number(q.h) || p;
      const l = Number(q.l) || p;
      ref = (h + l + p) / 3;
    }
    return ref > 0 ? ref : p;
  }

  /** 低吸高抛（均值回归） */
  _reversion(id) {
    const q = this._quote(id);
    if (!q) return;
    const p = Number(q.p);
    const avgRef = this._avgRef(q);
    const pos = this._pos(id);
    const dev = avgRef > 0 ? (p - avgRef) / avgRef : 0;
    const buyLvl = 0.004 + this.difficulty * 0.010;
    const takeLvl = 0.006 + this.difficulty * 0.014;

    if (pos.avail > 0 && pos.avgCost > 0 && p > pos.avgCost * (1 + takeLvl)) {
      this._sell(id, pos.avail, true);                      // 反弹到成本上方就走
      return;
    }
    if (pos.qty === 0 && dev < -buyLvl) {
      const px = Number(q.s && q.s[0] && q.s[0][0]) || p;
      const frac = 0.12 + this.difficulty * 0.18;
      const n = this._budgetQty(id, px, frac);
      if (n > 0) this._buy(id, n, true);
    }
  }

  /** 韭菜：随机频繁交易，偶尔梭哈 */
  _noob(id) {
    const q = this._quote(id);
    if (!q) return;
    const p = Number(q.p);
    const pos = this._pos(id);
    const r = Math.random();
    const allInP = 0.10 + (1 - this.difficulty) * 0.12;

    if (r < 0.55) {
      const px = Number(q.s && q.s[0] && q.s[0][0]) || p;
      let n;
      if (Math.random() < allInP) {
        n = this._budgetQty(id, px, 1.0);                   // 梭哈
      } else {
        n = this._budgetQty(id, px, util.rand(0.08, 0.35));
      }
      if (n > 0) this._buy(id, n, Math.random() < 0.6);
    } else if (pos.avail > 0) {
      // 频繁割肉，但偶尔拿住
      const part = Math.random() < 0.5 ? pos.avail : Math.floor(pos.avail * util.rand(0.3, 1));
      this._sell(id, part, Math.random() < 0.5);
    }
  }

  /** 稳健网格：小幅高抛低吸，持仓分散 */
  _grid(id) {
    const q = this._quote(id);
    if (!q) return;
    const p = Number(q.p);
    const pos = this._pos(id);
    const step = 0.005 + (1 - this.difficulty) * 0.008;

    let ref = this.gridRef.get(id);
    if (!(ref > 0)) { ref = p; this.gridRef.set(id, ref); }

    if (pos.qty === 0) {
      if (Math.abs(p - ref) / ref < step * 0.6) {           // 贴近基准建底仓
        const px = Number(q.s && q.s[0] && q.s[0][0]) || p;
        const n = this._budgetQty(id, px, 0.15);
        if (n > 0) this._buy(id, n, false);
      } else {
        this.gridRef.set(id, p);
      }
      return;
    }

    if (p <= ref * (1 - step)) {                            // 跌一格买
      const px = Number(q.s && q.s[0] && q.s[0][0]) || p;
      const n = this._budgetQty(id, px, 0.08);
      if (n > 0) {
        this._buy(id, n, true);
        this.gridRef.set(id, p);
      }
      return;
    }
    if (p >= ref * (1 + step) && pos.avail > 0) {           // 涨一格卖
      const keep = Math.floor(pos.qty * 0.35 / (this.config.LOT_SIZE || 100)) * (this.config.LOT_SIZE || 100);
      const sellable = Math.max(0, Math.min(pos.avail, pos.qty - keep));
      if (sellable > 0) { this._sell(id, sellable, true); this.gridRef.set(id, p); return; }
      this.gridRef.set(id, p);
    }
    // 网格基准随价格缓慢漂移，避免脱离行情
    this.gridRef.set(id, ref * 0.98 + p * 0.02);
  }
}

module.exports = BotBrain;
module.exports.BotBrain = BotBrain;
module.exports.PERSONALITIES = PERSONALITIES;
module.exports.PERSONALITY_CN = CN;
