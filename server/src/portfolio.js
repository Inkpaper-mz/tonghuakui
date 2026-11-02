/* ═══════════════════════════════════════════════════════════════
   同花亏 · 账户 / 持仓 / 委托 / 成交  （DESIGN.md §3.6, PROTOCOL.md §2.4）
   零第三方依赖；所有对外金额均为两位小数。
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const gconfig = require('./config');
const util = require('./util');

const EQUITY_MAX = 400;            // 资产曲线最多保留点数（超出按等间隔抽稀）
const SNAPSHOT_ORDERS_MAX = 200;   // account.orders 单次最多下发条数（最新在前）
const SNAPSHOT_TRADES_MAX = 200;   // account.trades 单次最多下发条数（最新在前）
const ORDERS_KEEP_MAX = 400;       // 内部委托历史保留上限（超出优先丢弃已结束的）

const ZERO_POS = { qty: 0, avail: 0, avgCost: 0 };

function r6(v) { return Math.round((Number(v) || 0) * 1e6) / 1e6; }

class Portfolio {
  /**
   * @param {{id?:string, startCash?:number, config?:object, market?:object}} opts
   */
  constructor({ id, startCash, config, market } = {}) {
    this.config = config || gconfig;
    this.market = market || null;
    this.id = id || util.uid('p');

    const sc = util.round2(startCash);
    this.startCash = sc > 0 ? sc : util.round2(this.config.DEFAULT_START_CASH || 1000000);

    /** 可用资金 */
    this.cash = this.startCash;
    /** 冻结资金（未成交买单占用） */
    this.frozen = 0;

    /** Map<stockId, {qty, avail, frozen, avgCost, lastBuyDay, lastPrice}> */
    this.positions = new Map();
    /** Map<orderId, order> */
    this.orders = new Map();
    /** 成交明细，最新在前，最多 MAX_TRADES_KEEP 条 */
    this.trades = [];
    /** 资产曲线采样点 [[vtime, totalAssets], ...] 最多 400 点 */
    this.equity = [];

    /* 统计 */
    this.tradeCount = 0;
    this.feeTotal = 0;
    this.realizedPnl = 0;
    this.winCount = 0;
    this.lossCount = 0;
    this.lastDay = -1;

    this._names = null;
  }

  /* ───────────── 内部工具 ───────────── */

  _name(stockId) {
    if (!this._names) {
      this._names = new Map();
      const list = this.config.STOCKS || [];
      for (let i = 0; i < list.length; i++) this._names.set(list[i].id, list[i].name);
    }
    const n = this._names.get(stockId);
    return n || stockId;
  }

  _pos(stockId, create) {
    let p = this.positions.get(stockId);
    if (!p && create) {
      p = { qty: 0, avail: 0, frozen: 0, avgCost: 0, lastBuyDay: -1, lastPrice: 0 };
      this.positions.set(stockId, p);
    }
    return p || null;
  }

  /** 最新价：优先行情，其次最近成交价，最后成本价 */
  _price(stockId) {
    try {
      if (this.market && typeof this.market.getQuote === 'function') {
        const q = this.market.getQuote(stockId);
        if (q) {
          const p = Number(q.p);
          if (Number.isFinite(p) && p > 0) return p;
        }
      }
    } catch (e) { /* 行情不可用时退回本地价 */ }
    const p = this.positions.get(stockId);
    if (p && p.qty > 0) {
      if (p.lastPrice > 0) return p.lastPrice;
      if (p.avgCost > 0) return p.avgCost;
    }
    return 0;
  }

  /** 佣金/印花税/过户费（PROTOCOL §3.3） */
  calcFee(amount, side) {
    const F = this.config.FEE || gconfig.FEE;
    const a = Number(amount) || 0;
    if (!(a > 0)) return 0;
    let fee = Math.max(a * F.commissionRate, F.commissionMin) + a * F.transferFee;
    if (side === 'sell') fee += a * F.stampTax;
    return util.round2(fee);
  }

  /* ───────────── 查询 ───────────── */

  getAvailableCash() { return util.round2(this.cash); }

  getPosition(stockId) {
    const p = this.positions.get(stockId);
    if (!p || p.qty <= 0) {
      if (!p) return { qty: 0, avail: 0, avgCost: 0 };
      return { qty: 0, avail: 0, avgCost: util.round2(p.avgCost) };
    }
    return { qty: p.qty, avail: p.avail, avgCost: util.round2(p.avgCost) };
  }

  /** @returns {{cash:number,frozen:number,marketValue:number,totalAssets:number,pnl:number,pnlPct:number}} */
  computeAssets() {
    let marketValue = 0;
    for (const [sid, p] of this.positions) {
      if (!p || p.qty <= 0) continue;
      const px = this._price(sid);
      if (px > 0) marketValue += p.qty * px;
      else marketValue += p.qty * (p.avgCost || 0);
    }
    marketValue = util.round2(marketValue);
    const cash = util.round2(this.cash);
    const frozen = util.round2(this.frozen);
    const totalAssets = util.round2(cash + frozen + marketValue);
    const pnl = util.round2(totalAssets - this.startCash);
    const pnlPct = this.startCash > 0 ? r6(pnl / this.startCash) : 0;
    return { cash, frozen, marketValue, totalAssets, pnl, pnlPct };
  }

  /** PROTOCOL §2.4 account 报文 */
  snapshot() {
    const a = this.computeAssets();

    const positions = [];
    for (const [sid, p] of this.positions) {
      if (!p || p.qty <= 0) continue;               // 数量为 0 的持仓过滤掉
      const price = this._price(sid) || p.avgCost || 0;
      const mv = util.round2(price * p.qty);
      const cost = util.round2((p.avgCost || 0) * p.qty);
      const pnl = util.round2(mv - cost);
      positions.push({
        i: sid,
        qty: p.qty,
        avail: p.avail,
        avgCost: util.round2(p.avgCost),
        price: util.round2(price),
        mv,
        pnl,
        pnlPct: cost > 0 ? r6(pnl / cost) : 0,
        name: this._name(sid),
      });
    }
    positions.sort((x, y) => y.mv - x.mv);

    const allOrders = Array.from(this.orders.values());
    allOrders.sort((x, y) => ((y.ts || 0) - (x.ts || 0)) || ((y.time || 0) - (x.time || 0)));
    const orders = allOrders.slice(0, SNAPSHOT_ORDERS_MAX).map((o) => {
      const frozenCash = o.side === 'buy' ? Math.max(0, Number(o.frozen) || 0) : 0;
      const frozenShares = o.side === 'sell' ? Math.max(0, Number(o.frozenShares) || 0) : 0;
      const frozenVal = o.side === 'buy'
        ? frozenCash
        : util.round2(frozenShares * (this._price(o.stockId) || o.price || 0));
      return {
        id: o.id,
        i: o.stockId,
        side: o.side,
        type: o.type,
        price: util.round2(o.price),
        qty: o.qty,
        filled: o.filled || 0,
        status: o.status,
        time: o.time || 0,
        frozen: util.round2(frozenVal),
        name: this._name(o.stockId),
      };
    });

    const trades = this.trades.slice(0, SNAPSHOT_TRADES_MAX).map((t) => ({
      id: t.id,
      i: t.i,
      side: t.side,
      price: util.round2(t.price),
      qty: t.qty,
      amount: util.round2(t.amount),
      fee: util.round2(t.fee),
      time: t.time || 0,
      pnl: (t.pnl === null || t.pnl === undefined) ? null : util.round2(t.pnl),
      name: t.name || this._name(t.i),
    }));

    return {
      t: 'account',
      cash: a.cash,
      frozen: a.frozen,
      available: a.cash,
      marketValue: a.marketValue,
      totalAssets: a.totalAssets,
      pnl: a.pnl,
      pnlPct: a.pnlPct,
      positions,
      orders,
      trades,
    };
  }

  /* ───────────── 冻结 / 解冻 ───────────── */

  freezeCash(amount) {
    const a = util.round2(amount);
    if (!(a > 0)) return false;
    if (a > this.cash + 1e-9) return false;
    this.cash = util.round2(this.cash - a);
    this.frozen = util.round2(this.frozen + a);
    return true;
  }

  unfreezeCash(amount) {
    const a = util.round2(amount);
    if (!(a > 0)) return false;
    const take = Math.min(a, this.frozen);
    this.frozen = util.round2(this.frozen - take);
    this.cash = util.round2(this.cash + take);
    return true;
  }

  freezeShares(stockId, qty) {
    const q = Math.floor(Number(qty) || 0);
    if (!(q > 0)) return false;
    const p = this._pos(stockId, true);
    if (p.avail + 1e-9 < q) return false;
    p.avail -= q;
    p.frozen = (p.frozen || 0) + q;
    return true;
  }

  unfreezeShares(stockId, qty) {
    const q = Math.floor(Number(qty) || 0);
    if (!(q > 0)) return false;
    const p = this._pos(stockId, true);
    const give = Math.min(q, p.frozen || 0);
    p.frozen = (p.frozen || 0) - give;
    p.avail += give;
    if (p.avail > p.qty) p.avail = p.qty;   // 安全阀：可用不得超过持仓
    return true;
  }

  /* ───────────── 记账 ───────────── */

  /**
   * 成交记账（引擎调用）。负责：加权成本、已实现盈亏、T+1、资金/股份解冻。
   * @returns {object|null} 成交记录（PROTOCOL trades 元素）
   */
  applyTrade({ stockId, side, price, qty, fee, orderId, vtime, dayIndex } = {}) {
    const q = Math.floor(Number(qty) || 0);
    const px = util.round2(price);
    if (!stockId || q <= 0 || !(px > 0)) return null;

    const amount = util.round2(px * q);
    const feeR = (fee === undefined || fee === null || !Number.isFinite(Number(fee)))
      ? this.calcFee(amount, side)
      : util.round2(Number(fee));

    const pos = this._pos(stockId, true);
    const order = (orderId && this.orders.get(orderId)) || null;
    let pnl = null;

    if (side === 'sell') {
      if (pos.qty < q) return null;   // 引擎已校验，这里是最后一道防线
      // 卖出：qty 减少、冻结股份释放（avail 在下单冻结时已扣减）
      pos.qty -= q;
      const relShares = Math.min(pos.frozen || 0, q);
      pos.frozen = (pos.frozen || 0) - relShares;
      if (order) order.frozenShares = Math.max(0, (Number(order.frozenShares) || 0) - relShares);

      pnl = util.round2((px - (pos.avgCost || 0)) * q - feeR);
      this.realizedPnl = util.round2(this.realizedPnl + pnl);
      this.cash = util.round2(this.cash + amount - feeR);
      if (pnl > 0) this.winCount++;
      else if (pnl < 0) this.lossCount++;
    } else {
      // 买入：qty 增加、avail 不变（T+1），加权平均成本含手续费
      const oldQty = pos.qty;
      const newQty = oldQty + q;
      pos.avgCost = util.round2((oldQty * (pos.avgCost || 0) + amount + feeR) / newQty);
      pos.qty = newQty;
      pos.lastBuyDay = Number.isFinite(Number(dayIndex)) ? Number(dayIndex) : pos.lastBuyDay;
      // 资金：优先从该委托的冻结额中划出，不足部分从可用资金补
      const cost = util.round2(amount + feeR);
      let fromFrozen = Math.min(this.frozen, cost);
      if (order) fromFrozen = Math.min(fromFrozen, Math.max(0, Number(order.frozen) || 0));
      fromFrozen = util.round2(Math.max(0, fromFrozen));
      this.frozen = util.round2(this.frozen - fromFrozen);
      if (order) order.frozen = util.round2(Math.max(0, (Number(order.frozen) || 0) - fromFrozen));
      const rest = util.round2(cost - fromFrozen);
      if (rest > 0) this.cash = util.round2(Math.max(0, this.cash - rest));
    }

    pos.lastPrice = px;
    this.feeTotal = util.round2(this.feeTotal + feeR);
    this.tradeCount += 1;

    const rec = {
      id: util.uid('t'),
      i: stockId,
      side: side === 'sell' ? 'sell' : 'buy',
      price: px,
      qty: q,
      amount,
      fee: feeR,
      time: (Number.isFinite(Number(vtime)) && Number(vtime) > 0) ? Number(vtime) : Date.now(),
      pnl,
      name: this._name(stockId),
      orderId: orderId || null,
    };
    this.trades.unshift(rec);
    const keep = this.config.MAX_TRADES_KEEP || 500;
    if (this.trades.length > keep) this.trades.length = keep;
    return rec;
  }

  /* ───────────── 委托簿 ───────────── */

  addOrder(order) {
    if (!order || !order.id) return null;
    if (!order.status) order.status = 'open';
    if (order.filled === undefined) order.filled = 0;
    this.orders.set(order.id, order);
    // 控制历史规模：超出上限时先丢最旧的已结束委托
    if (this.orders.size > ORDERS_KEEP_MAX) {
      const done = [];
      for (const o of this.orders.values()) {
        if (o.status === 'filled' || o.status === 'canceled' || o.status === 'rejected') done.push(o);
      }
      done.sort((a, b) => ((a.ts || 0) - (b.ts || 0)) || ((a.time || 0) - (b.time || 0)));
      let over = this.orders.size - ORDERS_KEEP_MAX;
      for (let i = 0; i < done.length && over > 0; i++, over--) this.orders.delete(done[i].id);
    }
    return order;
  }

  updateOrder(order) {
    if (!order || !order.id) return null;
    this.orders.set(order.id, order);
    return order;
  }

  removeOrder(orderId) {
    return this.orders.delete(orderId);
  }

  /* ───────────── 日切 / 采样 / 统计 ───────────── */

  /** T+1 解禁：avail = qty - 已冻结（挂单卖出中的股份仍然冻结） */
  settleDay(dayIndex) {
    if (Number.isFinite(Number(dayIndex))) this.lastDay = Number(dayIndex);
    for (const p of this.positions.values()) {
      if (!p) continue;
      const frozen = Math.max(0, p.frozen || 0);
      p.avail = Math.max(0, p.qty - frozen);
    }
    return this.lastDay;
  }

  /** 记录资产曲线采样点，最多 400 点（等间隔抽稀，保留首尾） */
  markToMarket(vtime) {
    const { totalAssets } = this.computeAssets();
    if (!Number.isFinite(totalAssets)) return null;
    const t = Number(vtime);
    const time = Number.isFinite(t) ? t : Date.now();
    const last = this.equity[this.equity.length - 1];
    if (last && last[0] === time) { last[1] = totalAssets; return last; }
    const pt = [time, totalAssets];
    this.equity.push(pt);
    if (this.equity.length > EQUITY_MAX) this._thinEquity();
    return pt;
  }

  _thinEquity() {
    const src = this.equity;
    const n = src.length;
    const out = new Array(EQUITY_MAX);
    for (let i = 0; i < EQUITY_MAX; i++) {
      out[i] = src[Math.round((i * (n - 1)) / (EQUITY_MAX - 1))];
    }
    this.equity = out;
  }

  /** 最大回撤，返回负数（无数据返回 0） */
  maxDrawdown() {
    const eq = this.equity;
    if (!eq || eq.length < 2) return 0;
    let peak = -Infinity;
    let mdd = 0;
    let has = false;
    for (let i = 0; i < eq.length; i++) {
      const v = Number(eq[i] && eq[i][1]);
      if (!Number.isFinite(v)) continue;
      has = true;
      if (v > peak) peak = v;
      if (peak > 0) {
        const dd = (v - peak) / peak;
        if (dd < mdd) mdd = dd;
      }
    }
    if (!has) return 0;
    return Math.min(0, r6(mdd));
  }

  /** @returns {{tradeCount:number,feeTotal:number,realizedPnl:number,winRate:number}} */
  tradeStats() {
    const closed = this.winCount + this.lossCount;
    return {
      tradeCount: this.tradeCount,
      feeTotal: util.round2(this.feeTotal),
      realizedPnl: util.round2(this.realizedPnl),
      winRate: closed > 0 ? r6(this.winCount / closed) : 0,
    };
  }
}

module.exports = Portfolio;
module.exports.Portfolio = Portfolio;
module.exports.EQUITY_MAX = EQUITY_MAX;
module.exports.ZERO_POS = ZERO_POS;
