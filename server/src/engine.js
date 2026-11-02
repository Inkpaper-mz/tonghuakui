/* ═══════════════════════════════════════════════════════════════
   同花亏 · 撮合引擎（DESIGN.md §3.5, PROTOCOL.md §3）
   流程：校验 → 冻结 → 跨源价格优先撮合（合成流动性 / 玩家挂单）→ 余量入簿
   零第三方依赖（仅内置 events）；任何异常都不会抛出到调用方。
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const EventEmitter = require('events');
const gconfig = require('./config');
const util = require('./util');

const BOOK_LEVELS = 10;            // getBook/getBookLevels 返回的档位数
const FALLBACK_DAY_TICKS = 240;
const SYNTHETIC_HIT_P = 0.45;      // 每只股票每 tick 产生合成对手单的概率
/* 合成主动盘最多能"扫"到离当前对手价多远（与 market.js 的 MAX_WALK_PCT 对齐）：
   挂在这个范围之外的深档挂单是排队单，绝不能被合成流量按挂单价成交 */
const SYNTHETIC_MAX_SLIP = 0.006;

/* market.js 的 consumeLiquidity 内部已经调用过 applyFlow 施加价格冲击
   （见 market.js 中 `if (filled > 0) this.applyFlow(...)`），
   因此合成盘成交不再重复施加，避免 2 倍冲击；玩家之间的成交仍由引擎调用 applyFlow。
   若将来 market 侧不再自行施加，把这里改成 true 即可。 */
const APPLY_FLOW_FOR_SYNTHETIC = false;

function fail(msg) {
  return { ok: false, msg, order: null, trades: [] };
}

class MatchingEngine extends EventEmitter {
  /**
   * @param {{market:object, config?:object}} opts
   * 事件：'order' → { playerId, order, trades, reason, msg?, expired? }
   *       reason ∈ 'filled' | 'partial' | 'canceled' | 'rejected'
   */
  constructor({ market, config } = {}) {
    super();
    this.market = market || null;
    this.config = config || gconfig;
    this._metaMap = null;
    /** Map<playerId, portfolio> —— 跨玩家撮合所需；reset() 不清空已注册账户 */
    this.players = new Map();
    this.reset();
  }

  /* ───────────── 生命周期 ───────────── */

  /** 开新局：清空订单簿 / 订单索引 / 时钟状态（保留已注册账户） */
  reset() {
    this.book = new Map();               // Map<stockId, {bids:[], asks:[]}>
    this.orders = new Map();             // 活动委托：orderId -> order
    this.playersByOrderId = new Map();   // orderId -> playerId（跨玩家撮合索引）
    this.lastDay = null;
    this.tick = 0;
    this.seq = 0;
    this.vtime = 0;
    this.statsData = {
      orders: 0, fills: 0, qty: 0, notional: 0, fees: 0, canceled: 0, rejected: 0, expired: 0,
    };
    return this;
  }

  registerPortfolio(pf) {
    if (pf && pf.id) this.players.set(pf.id, pf);
    return pf;
  }

  /* ───────────── 小工具 ───────────── */

  _stockMeta(stockId) {
    if (!this._metaMap) {
      this._metaMap = new Map();
      const list = this.config.STOCKS || [];
      for (let i = 0; i < list.length; i++) this._metaMap.set(list[i].id, list[i]);
    }
    return this._metaMap.get(stockId) || null;
  }

  _state(stockId) {
    try {
      if (this.market && typeof this.market.getState === 'function') return this.market.getState(stockId) || null;
    } catch (e) { /* ignore */ }
    return null;
  }

  _quote(stockId) {
    try {
      if (this.market && typeof this.market.getQuote === 'function') return this.market.getQuote(stockId) || null;
    } catch (e) { /* ignore */ }
    return null;
  }

  /** 涨跌停价 */
  _limits(stockId, state, meta) {
    const st = state || this._state(stockId);
    if (st) {
      const up = Number(st.limitUp);
      const dn = Number(st.limitDown);
      if (Number.isFinite(up) && Number.isFinite(dn) && up > 0 && dn > 0) return { limitUp: up, limitDown: dn };
    }
    const m = meta || this._stockMeta(stockId);
    if (m && typeof this.config.limitPrices === 'function') {
      const l = this.config.limitPrices(m);
      if (l && l.limitUp > 0) return { limitUp: l.limitUp, limitDown: l.limitDown };
    }
    return null;
  }

  _calcFee(amount, side) {
    const F = this.config.FEE || gconfig.FEE;
    const a = Number(amount) || 0;
    if (!(a > 0)) return 0;
    let fee = Math.max(a * F.commissionRate, F.commissionMin) + a * F.transferFee;
    if (side === 'sell') fee += a * F.stampTax;
    return util.round2(fee);
  }

  _nowTime() {
    return this.vtime > 0 ? this.vtime : Date.now();
  }

  /** 是否一字板（市价单在此无法成交） */
  _isLimitBoard(state, price, side, quote) {
    const up = Number(state.limitUp);
    const dn = Number(state.limitDown);
    const q = quote || {};
    if (side === 'buy') {
      if (!(price >= up - 1e-9)) return false;
      const asks = Array.isArray(q.s) ? q.s : (Array.isArray(state.s) ? state.s : []);
      if (!asks.length) return true;
      const best = Number(asks[0] && asks[0][0]);
      return !(Number.isFinite(best) && best < up - 1e-9);
    }
    if (!(price <= dn + 1e-9)) return false;
    const bids = Array.isArray(q.b) ? q.b : (Array.isArray(state.b) ? state.b : []);
    if (!bids.length) return true;
    const best = Number(bids[0] && bids[0][0]);
    return !(Number.isFinite(best) && best > dn + 1e-9);
  }

  _bookOf(stockId, create) {
    let b = this.book.get(stockId);
    if (!b && create) {
      b = { bids: [], asks: [] };
      this.book.set(stockId, b);
    }
    return b || null;
  }

  _sideOf(order) { return order.side === 'buy' ? 'bids' : 'asks'; }

  _cmp(side, a, b) {
    if (side === 'buy') {                       // 买盘：价高优先，同价先挂优先
      if (b.price !== a.price) return b.price - a.price;
      return (a.ts || 0) - (b.ts || 0);
    }
    if (a.price !== b.price) return a.price - b.price;   // 卖盘：价低优先
    return (a.ts || 0) - (b.ts || 0);
  }

  _addToBook(order) {
    const b = this._bookOf(order.stockId, true);
    const arr = b[this._sideOf(order)];
    if (arr.indexOf(order) < 0) arr.push(order);
    arr.sort((x, y) => this._cmp(order.side, x, y));
  }

  _removeFromBook(order) {
    const b = this.book.get(order.stockId);
    if (!b) return;
    const arr = b[this._sideOf(order)];
    const i = arr.indexOf(order);
    if (i >= 0) arr.splice(i, 1);
    if (!b.bids.length && !b.asks.length) this.book.delete(order.stockId);
  }

  _activeCount(pf) {
    let n = 0;
    if (pf && pf.orders && typeof pf.orders.forEach === 'function') {
      pf.orders.forEach((o) => { if (o && (o.status === 'open' || o.status === 'partial')) n++; });
    }
    return n;
  }

  _applyFlow(stockId, signedQty, side, notional, price) {
    try {
      if (this.market && typeof this.market.applyFlow === 'function') {
        this.market.applyFlow(stockId, signedQty, side, notional, price);
      }
    } catch (e) { /* 行情异常不能影响撮合记账 */ }
  }

  /** 玩家之间的成交计入行情（成交量/成交额/均价/K 线）；合成盘成交由 market 自己记账 */
  _recordTrade(stockId, price, qty) {
    try {
      if (this.market && typeof this.market.recordTrade === 'function') {
        this.market.recordTrade(stockId, price, qty);
      }
    } catch (e) { /* ignore */ }
  }

  /** 委托变更事件（room.js 据此给玩家推 toast）；监听者抛错不影响撮合 */
  _emitOrder(playerId, order, trades, reason, extra) {
    if (!this.listenerCount || this.listenerCount('order') === 0) return;
    try {
      const payload = { playerId: playerId || null, order: order || null, trades: trades || [], reason };
      if (extra) for (const k in extra) payload[k] = extra[k];
      this.emit('order', payload);
    } catch (e) { /* ignore */ }
  }

  /**
   * 玩家订单簿中最优对手挂单（顺带清理失效挂单）。
   * @param {string} stockId
   * @param {'buy'|'sell'} side 主动方向
   * @param {'limit'|'market'} type
   * @param {number|null} limitPrice 限价（市价传 null）
   * @param {string} excludePlayerId 不自成交
   * @returns {object|null} 最优对手委托
   */
  _bestOpponent(stockId, side, type, limitPrice, excludePlayerId) {
    const book = this.book.get(stockId);
    if (!book) return null;
    const opp = side === 'buy' ? book.asks : book.bids;
    for (let i = 0; i < opp.length; i++) {
      const restOrder = opp[i] ? this.orders.get(opp[i].id) : null;
      if (!opp[i] || !restOrder || restOrder.status === 'filled' || restOrder.status === 'canceled') {
        opp.splice(i, 1); i--; continue;
      }
      const left = restOrder.qty - (restOrder.filled || 0);
      if (left <= 0) {
        const rp = this.players.get(restOrder.playerId);
        if (rp) { restOrder.status = 'filled'; this._finalizeOrder(rp, restOrder); }
        else { opp.splice(i, 1); this.orders.delete(restOrder.id); this.playersByOrderId.delete(restOrder.id); }
        i--; continue;
      }
      if (excludePlayerId && restOrder.playerId === excludePlayerId) continue;   // 自己的挂单：跳过不成交，但不从簿上摘掉
      if (type === 'limit') {
        if (side === 'buy' && restOrder.price > limitPrice + 1e-9) return null;
        if (side === 'sell' && restOrder.price < limitPrice - 1e-9) return null;
      }
      return restOrder;
    }
    return null;
  }

  /**
   * 合成盘「对手最优价」（本方视角），只读、无副作用；没有对手档返回 null。
   * 优先用 market.getBestOpposite(stockId, side)（权威且与 consumeLiquidity 同源，
   * 不会把玩家挂单合并进来）；老实现回退到纯合成行情快照 getQuote(id) 的卖一/买一。
   * 注意：绝不能传 externalBook 给 getQuote —— 那会把玩家挂单混进合成盘。
   */
  _synthTouch(stockId, side) {
    try {
      if (this.market && typeof this.market.getBestOpposite === 'function') {
        const bo = this.market.getBestOpposite(stockId, side);
        if (!bo) return null;                       // 明确无对手档（如一字涨停买不到 / 一字跌停卖不出）
        const bp = Number(bo.price);
        return Number.isFinite(bp) && bp > 0 ? bp : null;
      }
    } catch (e) { /* 回退到行情快照 */ }
    const q = this._quote(stockId);
    if (!q) return null;
    const lv = side === 'buy' ? q.s : q.b;          // 买方看合成卖一，卖方看合成买一
    if (!Array.isArray(lv) || !lv.length) return null;
    const p = Number(lv[0] && lv[0][0]);
    return Number.isFinite(p) && p > 0 ? p : null;
  }

  /** 向市场索取合成流动性，返回从优到劣的档位队列 [{price, qty}] */
  _fetchSynthetic(stockId, side, type, limitPrice, effLimit, qty) {
    const out = [];
    try {
      if (this.market && typeof this.market.consumeLiquidity === 'function') {
        const liq = this.market.consumeLiquidity(stockId, side, qty, effLimit);
        const fills = (liq && Array.isArray(liq.fills)) ? liq.fills : [];
        for (let i = 0; i < fills.length; i++) {
          const f = fills[i];
          const fp = util.round2(Number(f && f.price));
          const fq = Math.floor(Number(f && f.qty) || 0);
          if (!(fp > 0) || !(fq > 0)) continue;
          if (type === 'limit') {
            if (side === 'buy' && fp > limitPrice + 1e-9) continue;   // 不能吃比限价更差的价
            if (side === 'sell' && fp < limitPrice - 1e-9) continue;
          }
          out.push({ price: fp, qty: fq });
        }
      }
    } catch (e) { out.length = 0; }
    // 防御：市场实现若不保证从优到劣，这里再排一次
    out.sort((x, y) => (side === 'buy' ? x.price - y.price : y.price - x.price));
    return out;
  }

  /**
   * 主动方与玩家挂单成交一笔。
   * @returns {number|null} 成交股数（0 = 该挂单已失效并被清理，可继续）；null = 应中止撮合
   */
  _matchPlayer(pf, order, restOrder, side, trades) {
    const restPf = this.players.get(restOrder.playerId);
    if (!restPf) {
      this.orders.delete(restOrder.id);
      this.playersByOrderId.delete(restOrder.id);
      this._removeFromBook(restOrder);
      return 0;
    }
    const left = restOrder.qty - (restOrder.filled || 0);
    if (!(left > 0)) {
      restOrder.status = 'filled';
      this._finalizeOrder(restPf, restOrder);
      return 0;
    }
    const remainQty = order.qty - (order.filled || 0);
    const q = Math.min(remainQty, left);
    if (!(q > 0)) return 0;
    const px = restOrder.price;    // 成交价取先挂单方
    const t1 = this._execute(pf, order, px, q, this._nowTime());
    if (!t1) return null;
    const t2 = this._execute(restPf, restOrder, px, q, this._nowTime());
    trades.push(t1);               // 返回值只含本委托自己的成交（被动方成交走 'order' 事件）
    this._recordTrade(order.stockId, px, q);                   // 玩家成交计入行情
    this._applyFlow(order.stockId, side === 'buy' ? q : -q, side, util.round2(px * q), px);
    if (restOrder.filled >= restOrder.qty) {
      restOrder.status = 'filled';
      this._finalizeOrder(restPf, restOrder);
      this._emitOrder(restPf.id, restOrder, t2 ? [t2] : [], 'filled');
    } else {
      restOrder.status = 'partial';
      try { restPf.updateOrder(restOrder); } catch (e) { /* ignore */ }
      this._emitOrder(restPf.id, restOrder, t2 ? [t2] : [], 'partial');
    }
    return q;
  }

  /** 记一笔成交（写入 portfolio + 更新委托） */
  _execute(pf, order, price, qty, vtime) {
    if (!pf || !order || !(qty > 0)) return null;
    const px = util.round2(price);
    const amount = util.round2(px * qty);
    const fee = this._calcFee(amount, order.side);
    let tr = null;
    try {
      tr = pf.applyTrade({
        stockId: order.stockId,
        side: order.side,
        price: px,
        qty,
        fee,
        orderId: order.id,
        vtime,
        dayIndex: this.lastDay == null ? 0 : this.lastDay,
      });
    } catch (e) { tr = null; }
    if (!tr) return null;
    const prev = order.filled || 0;
    order.filled = prev + qty;
    order.avgPrice = util.round2(((order.avgPrice || 0) * prev + px * qty) / order.filled);
    this.statsData.fills += 1;
    this.statsData.qty += qty;
    this.statsData.notional = util.round2(this.statsData.notional + amount);
    this.statsData.fees = util.round2(this.statsData.fees + fee);
    return tr;
  }

  /** 委托终结：解冻余量、移出簿与索引 */
  _finalizeOrder(pf, order) {
    if (!order) return;
    if (order.side === 'buy' && Number(order.frozen) > 0) {
      try { pf.unfreezeCash(order.frozen); } catch (e) { /* ignore */ }
      order.frozen = 0;
    }
    if (order.side === 'sell' && Number(order.frozenShares) > 0) {
      try { pf.unfreezeShares(order.stockId, order.frozenShares); } catch (e) { /* ignore */ }
      order.frozenShares = 0;
    }
    this._removeFromBook(order);
    this.orders.delete(order.id);
    this.playersByOrderId.delete(order.id);
    try { pf.updateOrder(order); } catch (e) { /* ignore */ }
  }

  /* ───────────── 下单 ───────────── */

  /**
   * @returns {{ok:boolean, msg:string, order:object|null, trades:object[]}}
   */
  placeOrder(pf, req = {}) {
    const trades = [];
    try {
      if (!pf || typeof pf.applyTrade !== 'function' || typeof pf.getPosition !== 'function') {
        return fail('账户状态异常');
      }
      const reject = (msg) => this._reject(msg, pf.id);   // 拒单同时派发 'rejected' 事件
      const stockId = req.stockId;
      const side = req.side;
      const type = req.type === 'market' ? 'market' : 'limit';
      let price = Number(req.price);
      const qty = Math.floor(Number(req.qty));
      const lot = this.config.LOT_SIZE || gconfig.LOT_SIZE || 100;

      if (side !== 'buy' && side !== 'sell') return reject('非法的买卖方向');
      if (!stockId) return reject('标的不存在');

      const meta = this._stockMeta(stockId);
      const state = this._state(stockId);
      const quote = this._quote(stockId);
      if (!meta || !state || !quote) return reject('标的不存在');
      if (state.halted === true || state.suspended === true) return reject('当前标的已停牌');

      const curPrice = Number(quote.p) || Number(state.p) || 0;
      if (!(curPrice > 0)) return reject('当前标的已停牌');

      const limits = this._limits(stockId, state, meta);
      if (!limits) return reject('标的不存在');
      const limitUp = limits.limitUp;
      const limitDown = limits.limitDown;

      /* 数量 */
      if (!Number.isFinite(qty) || qty <= 0) return reject('委托数量必须大于 0');
      if (qty % lot !== 0) {
        const pos = pf.getPosition(stockId);
        const oddAll = side === 'sell' && qty < lot && pos.avail > 0 && qty === pos.avail;
        if (!oddAll) return reject(`委托数量必须是 ${lot} 股的整数倍`);
      }

      /* 价格 */
      if (type === 'limit') {
        if (!Number.isFinite(price) || price <= 0) return reject('委托价格必须大于 0');
        price = util.round2(price);
        if (price > limitUp + 1e-9) return reject(`委托价格超出涨停价 ${limitUp.toFixed(2)}`);
        if (price < limitDown - 1e-9) return reject(`委托价格超出跌停价 ${limitDown.toFixed(2)}`);
      } else {
        price = 0;
        if (this._isLimitBoard(state, curPrice, side, quote)) {
          return reject(side === 'buy' ? '当前已封涨停，市价买入无法成交' : '当前已封跌停，市价卖出无法成交');
        }
      }

      /* 委托数上限 */
      const maxOrders = this.config.MAX_ORDERS_PER_PLAYER || gconfig.MAX_ORDERS_PER_PLAYER || 200;
      if (this._activeCount(pf) >= maxOrders) return reject('未成交委托过多，请先撤单');

      /* 资金 / 持仓校验 */
      let need = 0;
      if (side === 'buy') {
        const refPrice = type === 'market' ? limitUp : price;   // 市价单按涨停价预估冻结，确保足额
        const est = util.round2(refPrice * qty);
        need = util.round2(est + this._calcFee(est, 'buy'));
        const avail = Number(pf.getAvailableCash()) || 0;
        if (avail + 1e-9 < need) return reject('可用资金不足');
      } else {
        const pos = pf.getPosition(stockId);
        if (!(pos.qty > 0)) return reject('可用持仓不足（T+1）');
        if (pos.qty < qty) return reject(`持仓不足，可用 ${pos.avail} 股（T+1）`);
        if (pos.avail + 1e-9 < qty) return reject('可用持仓不足（T+1）');
      }

      /* 建单 + 冻结 */
      const order = {
        id: util.uid('o'),
        playerId: pf.id,
        stockId,
        side,
        type,
        price: type === 'limit' ? price : 0,
        qty,
        filled: 0,
        avgPrice: 0,
        status: 'open',
        time: this._nowTime(),
        ts: ++this.seq,
        placedAtTick: this.tick,
        frozen: 0,
        frozenShares: 0,
        reqId: req.reqId || null,
      };
      order.orderId = order.id;   // 订单簿元素按 DESIGN §3.5 使用 orderId 字段

      if (side === 'buy') {
        if (!pf.freezeCash(need)) return reject('可用资金不足');
        order.frozen = need;
      } else {
        if (!pf.freezeShares(stockId, qty)) {
          return reject(pf.getPosition(stockId).qty >= qty ? '可用持仓不足（T+1）' : '持仓不足');
        }
        order.frozenShares = qty;
      }

      pf.addOrder(order);
      this.orders.set(order.id, order);
      this.playersByOrderId.set(order.id, pf.id);
      this.statsData.orders += 1;

      /* 撮合：跨「合成盘 / 玩家挂单」单循环按价格优先择优，同价优先吃玩家挂单（真实成交）。
         · 合成流动性「按需索取」：只要玩家挂单价不劣于合成盘 touch，就先吃玩家挂单；
           只有当玩家盘更差（或没有玩家挂单）时才向 market.consumeLiquidity 要一次流动性。
           这样玩家完全吃得下时不会白要合成流动性，避免虚增冲击与浪费市场 tick 预算。
         · consumeLiquidity 不扣减自身盘口，所以每笔委托最多索取一次，逐笔从队列里取。
         · 成交价：合成盘用其档位价；玩家盘用先挂单方价格。被动方不调 applyFlow / recordTrade。 */
      const effLimit = type === 'market' ? (side === 'buy' ? limitUp : limitDown) : price;
      const synthTouch = this._synthTouch(stockId, side);
      const betterThan = (a, b) => (side === 'buy' ? a < b - 1e-9 : a > b + 1e-9);   // a 是否比 b 更优
      let synthQueue = null;
      let synthIdx = 0;
      let guard = 0;
      while ((order.filled || 0) < order.qty && guard++ < 8000) {
        const remainQty = order.qty - (order.filled || 0);
        const playerBest = this._bestOpponent(stockId, side, type, type === 'limit' ? price : null, pf.id);

        if (synthQueue === null) {
          if (playerBest && (synthTouch === null || !betterThan(synthTouch, playerBest.price))) {
            if (this._matchPlayer(pf, order, playerBest, side, trades) === null) break;
            continue;
          }
          synthQueue = this._fetchSynthetic(stockId, side, type, price, effLimit, remainQty);
          synthIdx = 0;
          if (!synthQueue.length) {
            if (playerBest) {
              if (this._matchPlayer(pf, order, playerBest, side, trades) === null) break;
              continue;
            }
            break;
          }
          continue;                                   // 拿到队列后重新按价格优先决策
        }

        const synth = synthIdx < synthQueue.length ? synthQueue[synthIdx] : null;
        if (!synth && !playerBest) break;
        let takeSynth;
        if (!playerBest) takeSynth = true;
        else if (!synth) takeSynth = false;
        else takeSynth = betterThan(synth.price, playerBest.price);

        if (takeSynth) {
          if (!(synth.qty > 0)) { synthIdx += 1; continue; }
          const q = Math.min(synth.qty, remainQty);
          const tr = this._execute(pf, order, synth.price, q, this._nowTime());
          if (!tr) break;
          trades.push(tr);
          synth.qty -= q;
          if (synth.qty <= 0) synthIdx += 1;
          if (APPLY_FLOW_FOR_SYNTHETIC) {
            this._applyFlow(stockId, side === 'buy' ? q : -q, side, util.round2(synth.price * q), synth.price);
          }
        } else if (this._matchPlayer(pf, order, playerBest, side, trades) === null) {
          break;
        }
      }

      /* ③ 余量处理 */
      const filledAll = (order.filled || 0) >= order.qty;
      if (filledAll) {
        order.status = 'filled';
        this._finalizeOrder(pf, order);
        this._emitOrder(pf.id, order, trades, 'filled');
      } else if (type === 'market') {
        order.status = 'canceled';                       // 市价单剩余自动撤销
        order.autoCanceled = true;
        this._finalizeOrder(pf, order);
        this.statsData.canceled += 1;
        this._emitOrder(pf.id, order, trades, 'canceled', { autoCanceled: true });
      } else {
        order.status = (order.filled || 0) > 0 ? 'partial' : 'open';
        this._addToBook(order);
        try { pf.updateOrder(order); } catch (e) { /* ignore */ }
        if (order.status === 'partial') this._emitOrder(pf.id, order, trades, 'partial');
      }

      /* 回执 */
      const name = meta.name || stockId;
      const sideCn = side === 'buy' ? '买入' : '卖出';
      const pText = type === 'limit'
        ? order.price.toFixed(2)
        : ((order.filled || 0) > 0 ? (order.avgPrice || curPrice).toFixed(2) : '市价');
      let msg;
      if (filledAll) {
        msg = `已成交 ${sideCn} ${name} ${order.qty}股 @${pText}`;
      } else if (type === 'market' && (order.filled || 0) > 0) {
        msg = `已成交 ${sideCn} ${name} ${order.filled}股 @${pText}，剩余 ${order.qty - order.filled}股 已自动撤单`;
      } else {
        msg = `已委托 ${sideCn} ${name} ${order.qty}股 @${pText}`;
      }
      return { ok: true, msg, order, trades };
    } catch (e) {
      try { this.statsData.rejected += 1; } catch (e2) { /* ignore */ }
      return fail('系统繁忙，请稍后重试');
    }
  }

  _reject(msg, pfId) {
    this.statsData.rejected += 1;
    this._emitOrder(pfId || null, null, [], 'rejected', { msg });
    return { ok: false, msg, order: null, trades: [] };
  }

  /* ───────────── 撤单 ───────────── */

  cancelOrder(pf, orderId) {
    try {
      if (!pf) return { ok: false, msg: '账户状态异常', order: null };
      const live = this.orders.get(orderId) || null;
      const mine = (pf.orders && typeof pf.orders.get === 'function') ? pf.orders.get(orderId) : null;
      const order = live || mine;
      if (!order) return { ok: false, msg: '委托不存在', order: null };
      if (order.playerId && pf.id && order.playerId !== pf.id) return { ok: false, msg: '无权操作该委托', order: null };
      if (order.status !== 'open' && order.status !== 'partial') {
        return { ok: false, msg: '该委托已结束，无法撤销', order };
      }
      const name = this._stockName(order.stockId);
      const left = order.qty - (order.filled || 0);
      order.status = 'canceled';
      order.manualCanceled = true;
      this._finalizeOrder(pf, order);
      this.statsData.canceled += 1;
      const msg = `已撤单 ${order.side === 'buy' ? '买入' : '卖出'} ${name} ${left}股`;
      this._emitOrder(pf.id, order, [], 'canceled', { manualCanceled: true, msg });
      return { ok: true, msg, order };
    } catch (e) {
      return { ok: false, msg: '系统繁忙，请稍后重试', order: null };
    }
  }

  _stockName(stockId) {
    const m = this._stockMeta(stockId);
    return (m && m.name) || stockId;
  }

  /* ───────────── 每 tick ───────────── */

  onTick({ vtime, dayIndex } = {}) {
    try {
      this.tick += 1;
      if (Number.isFinite(Number(vtime)) && Number(vtime) > 0) this.vtime = Number(vtime);
      else this.vtime = this.vtime > 0 ? this.vtime + (this.config.TICK_MS || 1000) : Date.now();

      const dayTicks = this.config.VIRTUAL_DAY_TICKS || FALLBACK_DAY_TICKS;
      const day = Number.isFinite(Number(dayIndex))
        ? Number(dayIndex)
        : Math.floor((this.tick - 1) / dayTicks);

      if (this.lastDay !== day) {
        this.lastDay = day;
        for (const pf of this.players.values()) {
          try { if (typeof pf.settleDay === 'function') pf.settleDay(day); } catch (e) { /* ignore */ }
        }
      }

      this._syntheticFlow();
      this._expireOrders();
      this._sweepMarketable();
    } catch (e) { /* 引擎任何异常都不能让进程崩溃 */ }
  }

  /**
   * 每 tick 回扫挂单：行情已经走到挂单价之内（可成交）的委托必须立即成交。
   *
   * 之前只在「下单那一刻」吃一次合成流动性，之后再不回扫，于是：
   *   · 玩家挂在偏离现价的限价单永远不会成交（真实交易所会立即成交）；
   *   · 盘口会出现「买一 ≥ 卖一」的交叉（挂单价被后来的行情反超）。
   * 这里对最优价那一端的挂单做一次可成交性检查，价格序保证一旦不可成交即可跳出。
   */
  _sweepMarketable() {
    if (!this.book || !this.book.size) return;
    for (const stockId of Array.from(this.book.keys())) {
      const b = this.book.get(stockId);
      if (!b) continue;
      const q = this._quote(stockId);
      if (!q) continue;
      const ask = (q.s && q.s[0] && q.s[0][0]) || 0;
      const bid = (q.b && q.b[0] && q.b[0][0]) || 0;

      for (const side of ['buy', 'sell']) {
        const touch = side === 'buy' ? ask : bid;          // 买单看卖一，卖单看买一
        if (!(touch > 0)) continue;
        const arr = b[side === 'buy' ? 'bids' : 'asks'];
        if (!arr || !arr.length) continue;
        let guard = 0;
        while (arr.length && guard++ < 80) {
          const order = arr[0];
          if (!order) { arr.shift(); continue; }
          if (order.status !== 'open' && order.status !== 'partial') { this._removeFromBook(order); continue; }
          const marketable = side === 'buy' ? order.price >= touch - 1e-9 : order.price <= touch + 1e-9;
          if (!marketable) break;                          // 队列按价格排序，后面的更不可能成交
          const pf = this.players.get(order.playerId);
          if (!pf) { this._removeFromBook(order); this.orders.delete(order.id); this.playersByOrderId.delete(order.id); continue; }
          const remain = order.qty - (order.filled || 0);
          if (!(remain > 0)) { order.status = 'filled'; this._finalizeOrder(pf, order); continue; }

          const fills = this._fetchSynthetic(stockId, side, 'limit', order.price, order.price, remain);
          if (!fills.length) break;                        // 本 tick 流动性已用尽 → 下个 tick 再试
          const trades = [];
          let done = 0;
          for (const f of fills) {
            const take = Math.min(f.qty, remain - done);
            if (!(take > 0)) break;
            const tr = this._execute(pf, order, f.price, take, this._nowTime());
            if (!tr) break;
            trades.push(tr); done += take;
            if (APPLY_FLOW_FOR_SYNTHETIC) {
              this._applyFlow(stockId, side === 'buy' ? take : -take, side, util.round2(f.price * take), f.price);
            }
            if ((order.filled || 0) >= order.qty) break;
          }
          if (!done) break;

          if ((order.filled || 0) >= order.qty) {
            order.status = 'filled';
            this._finalizeOrder(pf, order);                // 解冻余量 + 移出盘口
            this._emitOrder(pf.id, order, trades, 'filled');
          } else {
            order.status = 'partial';
            try { pf.updateOrder(order); } catch (e) { /* ignore */ }
            this._emitOrder(pf.id, order, trades, 'partial');
          }
          if (arr.indexOf(order) === 0 && order.status === 'open') break;   // 防御：没进展就跳出
        }
      }
    }
  }

  /**
   * 取合成主动盘可成交的锚价（即当前市场对手价）。
   * side='buy' → 市场卖一；side='sell' → 市场买一。无副作用、只读。
   */
  _synthTouchPrice(stockId, side) {
    try {
      const m = this.market;
      if (m && typeof m.getBestOpposite === 'function') {
        const bo = m.getBestOpposite(stockId, side);
        if (bo && bo.price > 0) return bo.price;
      }
      const q = m && m.getQuote(stockId);
      if (!q) return 0;
      const lv = side === 'buy' ? q.s : q.b;
      if (lv && lv.length && lv[0][0] > 0) return lv[0][0];
      return q.p > 0 ? q.p : 0;
    } catch (e) { return 0; }
  }

  /** 合成主动买/卖盘吃玩家挂单（每只股票每 tick 45% 概率） */
  _syntheticFlow() {
    if (!this.book.size) return;
    const lot = this.config.LOT_SIZE || gconfig.LOT_SIZE || 100;
    const stockIds = Array.from(this.book.keys());
    for (let i = 0; i < stockIds.length; i++) {
      if (Math.random() >= SYNTHETIC_HIT_P) continue;
      const stockId = stockIds[i];
      const book = this.book.get(stockId);
      if (!book) continue;
      const hasBids = book.bids.length > 0;
      const hasAsks = book.asks.length > 0;
      if (!hasBids && !hasAsks) continue;
      const hitAsks = hasAsks && (!hasBids || Math.random() < 0.5);
      const side = hitAsks ? 'buy' : 'sell';
      const levels = hitAsks ? book.asks : book.bids;

      /* 合成盘能吃到的最差价：买盘最高 = 卖一 ×1.006，卖盘最低 = 买一 ×0.994。
         超出即停（levels 已按价格优先排序），否则玩家挂在跌停价附近的深档单
         会在 1 个 tick 内被"按自己的挂单价"凭空成交。 */
      const touch = this._synthTouchPrice(stockId, side);
      if (!(touch > 0)) continue;
      const worst = hitAsks ? touch * (1 + SYNTHETIC_MAX_SLIP) : touch * (1 - SYNTHETIC_MAX_SLIP);

      let remain = util.randInt(1, 20) * lot;
      let guard = 0;
      while (remain > 0 && levels.length && guard++ < 200) {
        const rest = levels[0];
        if (!rest) break;
        if (hitAsks ? rest.price > worst : rest.price < worst) break;   // 深档排队单，成交不到
        const restOrder = this.orders.get(rest.id);
        if (!restOrder || restOrder.status === 'filled' || restOrder.status === 'canceled') {
          levels.shift();
          continue;
        }
        const restPf = this.players.get(restOrder.playerId);
        const restRemain = restOrder.qty - (restOrder.filled || 0);
        if (!restPf || restRemain <= 0) {
          if (restPf) this._finalizeOrder(restPf, restOrder);
          else { levels.shift(); this.orders.delete(restOrder.id); this.playersByOrderId.delete(restOrder.id); }
          continue;
        }
        const q = Math.min(remain, restRemain);
        const tr = this._execute(restPf, restOrder, restOrder.price, q, this._nowTime());
        if (!tr) break;
        remain -= q;
        this._applyFlow(stockId, side === 'buy' ? q : -q, side, util.round2(restOrder.price * q), restOrder.price);
        if (restOrder.filled >= restOrder.qty) {
          restOrder.status = 'filled';
          this._finalizeOrder(restPf, restOrder);
          this._emitOrder(restPf.id, restOrder, [tr], 'filled');
        } else {
          restOrder.status = 'partial';
          try { restPf.updateOrder(restOrder); } catch (e) { /* ignore */ }
          this._emitOrder(restPf.id, restOrder, [tr], 'partial');
        }
      }
    }
  }

  /** 清理超过 1 个虚拟日未成交的挂单（自动撤单并解冻） */
  _expireOrders() {
    if (!this.orders.size) return;
    const maxAge = this.config.VIRTUAL_DAY_TICKS || FALLBACK_DAY_TICKS;
    const dead = [];
    for (const order of this.orders.values()) {
      const born = Number.isFinite(order.placedAtTick) ? order.placedAtTick : 0;
      if (this.tick - born > maxAge) dead.push(order);
    }
    for (let i = 0; i < dead.length; i++) {
      const order = dead[i];
      const pf = this.players.get(order.playerId);
      order.status = 'canceled';
      order.expired = true;
      if (pf) this._finalizeOrder(pf, order);
      else {
        this._removeFromBook(order);
        this.orders.delete(order.id);
        this.playersByOrderId.delete(order.id);
      }
      this.statsData.expired += 1;
      const left = order.qty - (order.filled || 0);
      this._emitOrder(order.playerId, order, [], 'canceled', {
        expired: true,
        msg: `委托超时未成交，已自动撤单（${this._stockName(order.stockId)} ${left}股）`,
      });
    }
  }

  /* ───────────── 查询 ───────────── */

  /** 玩家挂单盘口（对象数组形式，纯数据可直接 JSON 序列化） */
  getBook(stockId) {
    const lv = this.getBookLevels(stockId);
    return {
      bids: lv.bids.map(([price, qty]) => ({ price, qty })),
      asks: lv.asks.map(([price, qty]) => ({ price, qty })),
    };
  }

  /** 玩家挂单盘口（[价, 量] 上聚合形式，按价格从优到劣，可直接并进五档下发） */
  getBookLevels(stockId) {
    const b = this.book.get(stockId);
    const agg = (arr, desc) => {
      if (!arr || !arr.length) return [];
      const m = new Map();
      for (const o of arr) {
        const left = (o.qty || 0) - (o.filled || 0);
        if (left <= 0) continue;
        m.set(o.price, (m.get(o.price) || 0) + left);
      }
      return Array.from(m.entries())
        .map(([price, qty]) => [util.round2(price), qty])
        .sort((x, y) => (desc ? y[0] - x[0] : x[0] - y[0]))
        .slice(0, BOOK_LEVELS);
    };
    return { bids: agg(b && b.bids, true), asks: agg(b && b.asks, false) };
  }

  stats() {
    let restingBuy = 0;
    let restingSell = 0;
    for (const b of this.book.values()) {
      for (const o of b.bids) restingBuy += Math.max(0, (o.qty || 0) - (o.filled || 0));
      for (const o of b.asks) restingSell += Math.max(0, (o.qty || 0) - (o.filled || 0));
    }
    return {
      tick: this.tick,
      seq: this.seq,
      vtime: this.vtime,
      dayIndex: this.lastDay,
      players: this.players.size,
      stocks: this.book.size,
      activeOrders: this.orders.size,
      restingBuyQty: restingBuy,
      restingSellQty: restingSell,
      orders: this.statsData.orders,
      fills: this.statsData.fills,
      filledQty: this.statsData.qty,
      notional: util.round2(this.statsData.notional),
      fees: util.round2(this.statsData.fees),
      canceled: this.statsData.canceled,
      expired: this.statsData.expired,
      rejected: this.statsData.rejected,
    };
  }
}

module.exports = MatchingEngine;
module.exports.MatchingEngine = MatchingEngine;
