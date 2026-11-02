/* ═══════════════════════════════════════════════════════════════
   同花亏 · 行情引擎（零依赖）
   ─ 板块共振（OU 过程）+ 个股随机游走 + 均值回复
   ─ 玩家冲击 / 新闻冲击（指数衰减）
   ─ 涨跌停夹断 + 封板量能衰减
   ─ 合成五档盘口 / 成交明细 / 1m·5m·15m·1d K 线 / 虚拟指数
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// 价格冲击约定：合成盘成交的冲击由本文件 consumeLiquidity 内部施加；
//            玩家之间的成交冲击由 engine.js 调用 applyFlow 施加。两边都不得重复计。
// 只读约定：getQuote()/getBestOpposite()/getState()/getBars() 无副作用，
//          可被撮合引擎高频调用；只有 tick()/consumeLiquidity()/recordTrade()/applyFlow()
//          /applyNewsImpact() 才允许改变行情状态。

const util = require('./util');
const defaultConfig = require('./config');

const { clamp, round2 } = util;

const MIN_PRICE = 0.01;
const MAX_MIN_BARS = 1000;        // 1 分钟 K 最多保留多少根（防内存增长）
const MAX_DAY_BARS = 400;         // 日 K 最多保留多少根
const MAX_WALK_LEVELS = 10;       // 合成流动性最多延续到 touch 之外 10 档
const MAX_WALK_PCT = 0.006;       // 或偏离 touch 超过 0.6%（两者先到为准）
const FLOW_BUDGET_TICKS = 6;      // 单 tick 同一只股票最多被吃掉「每 tick 流动性 × 6」

/* ───────── 小工具 ───────── */

function safePrice(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return MIN_PRICE;
  return Math.round(n * 100) / 100;
}

/** 按 0.01 吸附到网格 */
function snap(v) {
  const n = Math.round(Number(v) * 100) / 100;
  return isFinite(n) ? n : MIN_PRICE;
}

/** 价格上浮下浮单位数（防负数） */
function shift(v, units) {
  const p = snap(v) + units * 0.01;
  return p < MIN_PRICE ? MIN_PRICE : Math.round(p * 100) / 100;
}

/* ───────── 随机源（默认系统随机；seed() 后完全可复现） ─────────
   注意：util.randn 内部有 Box-Muller 缓存，多个 Market 实例并存时会互相污染，
   因此这里自持一份 per-market 的单正态发生器与 spare 缓存。 */

function makeRandn(rand01) {
  let spare = null;
  return function randnLocal() {
    if (spare !== null) { const t = spare; spare = null; return t; }
    let u = 0, v = 0, s2 = 0;
    do {
      u = rand01() * 2 - 1;
      v = rand01() * 2 - 1;
      s2 = u * u + v * v;
    } while (s2 === 0 || s2 >= 1);
    const mul = Math.sqrt(-2 * Math.log(s2) / s2);
    spare = v * mul;
    return u * mul;
  };
}

function makeMulberry32(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 把玩家挂单并进合成五档：同价位量相加，最终取最优 5 档。
 * 过滤以「现价」为锚：买档不得高于 max(现价, 合成买一)，卖档不得低于 min(现价, 合成卖一)，
 * 否则玩家一张远月低价买单会被当成"最好的买一"顶到盘口最上方，误导客户端与撮合。
 * 同时仍受涨跌停约束。
 * @param {Array<[number,number]>} base 合成档位（已从优到劣）
 * @param {Array<[number,number]>} external 玩家挂单（[[price,qty]...]，任意顺序）
 * @param {'b'|'s'} side
 * @param {number} refPrice 该股现价
 * @param {number} limit 该侧涨跌停边界
 */
function mergeBook(base, external, side, refPrice, limit) {
  const map = new Map();
  const put = (p, q) => {
    const price = snap(p);
    const qty = Math.max(0, Math.round(Number(q) || 0));
    if (qty <= 0 || !isFinite(price) || price <= 0) return;
    map.set(price, (map.get(price) || 0) + qty);
  };
  for (const lv of (base || [])) put(lv[0], lv[1]);
  for (const lv of (external || [])) {
    if (!lv) continue;
    const p = Array.isArray(lv) ? lv[0] : lv.price;
    const q = Array.isArray(lv) ? lv[1] : lv.qty;
    put(p, q);
  }
  const baseBest = (base && base.length) ? Number(base[0][0]) : NaN;
  const ref = Number(refPrice);
  let list = Array.from(map.entries());
  if (side === 'b') {
    const cap = Math.max(isFinite(ref) ? ref : -Infinity, isFinite(baseBest) ? baseBest : -Infinity);
    if (isFinite(cap)) list = list.filter(([p]) => p <= cap + 1e-9);
    if (isFinite(limit)) list = list.filter(([p]) => p <= limit + 1e-9);
    list.sort((a, b) => b[0] - a[0]);
  } else {
    const cap = Math.min(isFinite(ref) ? ref : Infinity, isFinite(baseBest) ? baseBest : Infinity);
    if (isFinite(cap)) list = list.filter(([p]) => p >= cap - 1e-9);
    if (isFinite(limit)) list = list.filter(([p]) => p >= limit - 1e-9);
    list.sort((a, b) => a[0] - b[0]);
  }
  return list.slice(0, 5).map(([p, q]) => [snap(p), q]);
}

/** 累计 [[t,o,h,l,c,v]] 聚合成 n 分钟一根 */
function aggregateBars(bars, n) {
  if (n <= 1) return bars.slice();
  const out = [];
  for (const b of bars) {
    const bucket = Math.floor(b[0] / (n * 60000)) * n * 60000;
    const last = out[out.length - 1];
    if (last && last[0] === bucket) {
      if (b[2] > last[2]) last[2] = b[2];
      if (b[3] < last[3]) last[3] = b[3];
      last[4] = b[4];
      last[5] += b[5];
    } else {
      out.push([bucket, b[1], b[2], b[3], b[4], b[5]]);
    }
  }
  return out;
}

function round(q, f) {
  const v = q[f];
  return typeof v === 'number' ? round2(v) : v;
}

class Market {
  /**
   * @param {{stocks?:Array, config?:object}} opts
   */
  constructor(opts = {}) {
    const cfg = opts.config || defaultConfig;
    this.config = cfg;

    // 随机源：默认系统随机；调用 seed(n) 后换成实例级可复现随机
    this._seeded = false;
    this._seed = 0;
    this._initialized = false;      // 是否已经 tick() 过（决定 getQuote 能否重建快照）
    this._rand = () => Math.random();
    this._randn = makeRandn(() => Math.random());

    /* 参与人数 → 市场深度倍数（人越多，同样的钱推动价格越少） */
    const participants = Math.max(1, Math.round(Number(opts.participants) || 1));
    const perPlayer = Number(cfg.DEPTH_PER_PLAYER) || 0.14;
    const depthCap = Number(cfg.DEPTH_MAX_MULT) || 4;
    this.participants = participants;
    this.depthMult = Math.min(depthCap, Math.max(1, 1 + perPlayer * (participants - 1)));

    this.stocks = (opts.stocks && opts.stocks.length ? opts.stocks : (cfg.STOCKS || [])).slice();
    this.byId = new Map();
    this.order = [];
    for (const s of this.stocks) {
      this.byId.set(s.id, s);
      this.order.push(s.id);
    }

    this.dayTicks = Math.max(1, cfg.VIRTUAL_DAY_TICKS || 240);
    this.historyDays = Math.max(1, cfg.HISTORY_DAYS || 120);

    // 指数成员权重（默认等权）
    this._indices = (cfg.INDICES || []).map(ix => {
      const members = (ix.members || []).filter(id => this.byId.has(id));
      const w = members.length ? 1 / members.length : 0;
      return { code: ix.code, name: ix.name, base: ix.base, members, weights: members.map(() => w) };
    });

    this._seq = 0;
    this._minuteOfDay = 0;
    this._dayIndex = 0;
    this._baseDay = null;
    this._dayBase = 0;
    this._dayCount = 0;
    this._adjusted = false;

    this._sectorState = new Map();
    this.S = new Map();        // 个股运行时状态
    this._minBars = new Map(); // id -> [[t,o,h,l,c,v]]（当前虚拟日）
    this._hist = new Map();    // id -> 日 K 历史（含最后一根 = 昨日）
    this._prevCloses = new Map();
    this._idxCache = null;
    this._idxPrev = new Map();

    this.reset();
  }

  /* ═════════ 生命周期 ═════════ */

  /**
   * 调试 / 测试用：开启种子随机（此后 tick 完全可复现）。生产不要调用。
   * @param {number} seed
   */
  seed(seed) {
    this._seed = (Number(seed) >>> 0) || 1;
    this._seeded = true;
    const base = makeMulberry32(this._seed);
    this._rand = () => base();
    this._randn = makeRandn(this._rand);      // per-market spare，完全可复现
    this.reset();
    return this;
  }

  reset() {
    try {
    const now = new Date();
    this._baseDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    this._dayBase = this._baseDay.getTime();
    this._dayCount = 0;
    this._seq = 0;
    this._minuteOfDay = 0;
    this._dayIndex = 0;
    this._adjusted = false;
    this._initialized = false;
    this._idxCache = null;
    this._idxPrev = new Map();
    this._sectorState = new Map();
    this.S = new Map();
    this._prevCloses = new Map();
    this._minBars = new Map();
    this._hist = new Map();

    for (const s of this.stocks) {
      const prevClose = safePrice(s.prevClose);
      this._prevCloses.set(s.id, prevClose);
      const lp = this.config.limitPrices
        ? this.config.limitPrices({ ...s, prevClose })
        : {
          limitUp: round2(prevClose * 1.1),
          limitDown: round2(prevClose * 0.9),
          limitPct: 0.1,
        };
      const limitUp = safePrice(lp.limitUp);
      const limitDown = Math.min(safePrice(lp.limitDown), round2(prevClose - 0.01));
      const floatShares = Number(s.floatShares) > 0 ? Number(s.floatShares) : 1e9;
      const baseLiq = Math.max(500, Math.round(floatShares * 0.000045));
      const liquid = s.pinyin === 'jdf' || s.id === '000725' ? 4 : 1; // 低价股手数天然更大
      /* 参与人数越多 → 市场越深：同样的资金对价格的推动越小 */
      const depthMult = this.depthMult || 1;
      const liqPerTick = Math.max(500, Math.round(baseLiq * liquid * depthMult));
      this.S.set(s.id, {
        id: s.id,
        name: s.name,
        sector: s.sector,
        price: prevClose,
        prevClose,
        open: prevClose,
        high: prevClose,
        low: prevClose,
        rounded: prevClose,
        v: 0,
        a: 0,
        limitUp,
        limitDown,
        limitPct: lp.limitPct || 0.1,
        floatShares,
        liqPerTick,
        liqBase: liqPerTick,
        fair: prevClose,                       // 内在价值（不受玩家买卖影响，自行演化）
        flowScale: 1 / Math.max(1, liqPerTick),
        impact: 0,
        newsImpact: 0,
        newsStock: 0,
        volMod: 1,
        lastV: 0,
        lastA: 0,
        extTr: [],
        flowBudget: liqPerTick * FLOW_BUDGET_TICKS,
      });
      const h = this._generateHistory(s, prevClose);
      this._hist.set(s.id, h);
      this._minBars.set(s.id, []);
    }

    this._buildDaySectors();
    this._snapshotDayOpen();
    this._idxCache = null;
    } catch (err) {
      this._idxCache = null;
      throw err;
    }
  }

  /* ───────── 历史日 K ───────── */

  _sectorList() {
    const out = [];
    const seen = new Set();
    for (const s of this.stocks) {
      if (!seen.has(s.sector)) { seen.add(s.sector); out.push(s.sector); }
    }
    return out;
  }

  /** 生成 HISTORY_DAYS 根日 K，最后一根收盘价恰好等于 prevClose（= 昨收） */
  _generateHistory(stock, prevClose) {
    const n = this.historyDays;
    const s = this.S.get(stock.id);
    const dailyVol = Math.max(0.004, (Number(stock.vol) || 0.003) * Math.sqrt(this.dayTicks));
    const dailyDrift = (Number(stock.drift) || 0) * this.dayTicks;
    const beta = Number(stock.beta) || 1;
    const wick = Math.min(0.05, dailyVol * 0.9 + 0.004);
    const gap = Math.min(0.03, dailyVol * 0.35);
    const turn = 0.006 + dailyVol * 0.3;

    const raw = new Array(n);
    let c = prevClose;
    for (let i = n - 1; i >= 0; i--) {
      const sectorR = s ? (this._sectorState.get(stock.sector) || { drift: 0, ou: 0 }).drift : 0;
      const r = sectorR * beta + dailyDrift + dailyVol * this._randn();
      const close = c;
      const open = close / Math.exp(clamp(r, -0.28, 0.28));
      const hi = Math.max(close, open) * (1 + Math.abs(this._randn()) * wick);
      const lo = Math.min(close, open) * (1 - Math.abs(this._randn()) * wick);
      const v = Math.max(100, Math.round(s.floatShares * (turn * (0.55 + Math.abs(r) * 10 + this._rand() * 0.9)) / 100) * 100);
      raw[i] = {
        // 最后一根历史日 K 的日期 = 开局前一天（即「昨天」，其收盘 == prevClose）
        t: this._dayBase - 86400000 - (n - 1 - i) * 86400000,
        o: open,
        h: Math.max(hi, open, close),
        l: Math.min(lo, open, close),
        c: close,
        v,
      };
      c = c / Math.exp(clamp(r, -0.28, 0.28));   // 更早一天的收盘
    }

    // 归一化：最后一根收盘价 == prevClose
    const last = raw[n - 1];
    const k = last && last.c > 0 ? prevClose / last.c : 1;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const b = raw[i];
      out[i] = [
        b.t,
        safePrice(b.o * k),
        safePrice(b.h * k),
        safePrice(b.l * k),
        safePrice(b.c * k),
        b.v,
      ];
    }
    const lastBar = out[n - 1];
    lastBar[4] = prevClose;
    lastBar[2] = Math.max(lastBar[2], prevClose, lastBar[1]);
    lastBar[3] = Math.min(lastBar[3], prevClose, lastBar[1]);
    return out;
  }

  /* ───────── 板块 / 日切 ───────── */

  _buildDaySectors() {
    const sectors = this._sectorList();
    const base = 0.0016;
    const dv = Math.max(0.0012, base * (0.6 + 8 / Math.max(3, sectors.length + 5)));
    /* ⚠️ 量纲：dv 是「每个虚拟交易日的板块漂移」（约 ±0.2%），
       而 sectorTerm 是每 tick 加进对数收益率的，必须除以一天多少 tick，
       否则 0.2%/tick × 240 tick ≈ 单日 +48%，整个市场会单边暴走、满屏涨停。 */
    const perTick = 1 / Math.max(30, this.dayTicks || 240);
    for (const name of sectors) {
      const st = this._sectorState.get(name) || { name, drift: 0, ou: 0 };
      st.drift = dv * this._randn() * perTick * 6;   // 日漂移 ±0.2% → 每 tick 量级
      st.ou = 0;
      st.dayVol = dv;
      st.ouVol = Math.max(0.00025, dv * 0.30);       // OU 波动（板块联动的主要来源）
      this._sectorState.set(name, st);
    }
  }

  _snapshotDayOpen() {
    // 当前进行中的交易日 = 开局日 + dayCount（dayCount=0 即开局当天），与 tick() 的 vtime 完全一致
    const ts = this._dayBase + this._dayCount * 86400000 + util.sessionMinutes(this._minuteOfDay) * 60000;
    for (const s of this.stocks) {
      const st = this.S.get(s.id);
      st.open = st.prevClose;
      st.high = st.prevClose;
      st.low = st.prevClose;
      st.rounded = st.prevClose;
      st.price = st.prevClose;
      st.v = 0;
      st.a = 0;
      st.lastV = 0;
      st.lastA = 0;
      st.impact = 0;
      st.newsImpact = 0;
      st.newsStock = 0;
      st.volMod = 1;
      st._bar = null;                              // 关键：清掉上一日的 bar 引用
      this._minBars.set(s.id, []);
    }
    // 新交易日的首根 1 分钟 K
    for (const s of this.stocks) {
      const st = this.S.get(s.id);
      st._bar = [ts, st.prevClose, st.prevClose, st.prevClose, st.prevClose, 0];
      this._minBars.get(s.id).push(st._bar);
    }
  }

  /** 日切：结算昨日、开新的一天。返回是否发生了日切 */
  _rollDay() {
    const dayTs = this._dayBase + this._dayCount * 86400000;   // 刚走完的那个交易日（当天 00:00）
    this._dayIndex += 1;
    this._dayCount += 1;
    const adjust = this._adjusted === true;
    this._adjusted = true;

    for (const s of this.stocks) {
      const st = this.S.get(s.id);
      const hArr = this._hist.get(s.id);
      const frozen = adjust && st.v === 0 && st.high === st.low;      // 停牌式一字板
      const last = hArr.length ? hArr[hArr.length - 1] : null;
      // 该交易日的日 K 由 _updateDayBar 在每 tick 维护：能就地收口就收口，避免重复插入
      if (last && last[0] === dayTs) {
        last[1] = safePrice(st.open);
        last[2] = safePrice(st.high);
        last[3] = safePrice(st.low);
        last[4] = frozen ? last[1] : safePrice(st.price);
        last[5] = Math.round(st.v);
      } else {
        hArr.push([dayTs, safePrice(st.open), safePrice(st.high), safePrice(st.low), frozen ? safePrice(st.open) : safePrice(st.price), Math.round(st.v)]);
      }
      if (hArr.length > MAX_DAY_BARS) hArr.splice(0, hArr.length - MAX_DAY_BARS);

      // 新的一天：昨收 = 昨日收盘
      st.prevClose = safePrice(st.price);
      const lp = this.config.limitPrices
        ? this.config.limitPrices({ ...s, prevClose: st.prevClose })
        : { limitUp: round2(st.prevClose * 1.1), limitDown: round2(st.prevClose * 0.9) };
      st.limitUp = safePrice(lp.limitUp);
      st.limitDown = Math.min(safePrice(lp.limitDown), round2(st.prevClose - 0.01));
      st.price = st.prevClose;

      /* 隔夜跳空：把跳空当作外生冲击放进 impact 项（开盘后自然衰减）。
         以前只有显式配了 overnight 的股票才有跳空，而 61 只都没配 → 「今开」永远等于「昨收」。
         现在按个股波动率给一个默认跳空幅度（约 0.35×日波动），真实 A 股多数股票每天都会有跳空。 */
      const ovBase = Number(s.overnight) > 0 ? Number(s.overnight) : (Number(s.vol) || 0.0025) * 0.9;
      const ov = ovBase * this._randn();
      st.impact = clamp(ov || 0, -0.06, 0.06);
    }
    this._buildDaySectors();
    this._snapshotDayOpen();
    this._idxCache = null;
    return true;
  }

  /* ═════════ tick ═════════ */

  tick() {
    try {
    // 分钟序号 0..dayTicks-1；走完 dayTicks 分钟后回到 0 并触发日切
    this._minuteOfDay = this._seq % this.dayTicks;
    if (this._minuteOfDay === 0 && this._seq > 0) this._rollDay();
    this._seq += 1;
    const vtime = this._dayBase + this._dayCount * 86400000 + util.sessionMinutes(this._minuteOfDay) * 60000;

    // 新 tick：清空上一 tick 的玩家成交明细，并重置本 tick 合成流动性预算
    for (const s of this.stocks) {
      const st = this.S.get(s.id);
      st.extTr = [];
      st.flowBudget = st.liqPerTick * FLOW_BUDGET_TICKS;
    }

    this._initialized = true;

    this._evolveSectors();
    for (const s of this.stocks) this._evolveStock(s, vtime);

    this._idxCache = null;
    for (const s of this.stocks) this._buildQuote(s);

    const quotes = this.order.map(id => this._qcache(id));
    const idx = this.getIndices();
    return {
      seq: this._seq,
      vtime,
      vclock: util.vclockOf(this._minuteOfDay),
      dayIndex: this._dayIndex,
      idx,
      quotes,
    };
    } finally {
      /* 无副作用收尾（随机源已是实例级，无需恢复全局） */
    }
  }

  _evolveSectors() {
    for (const st of this._sectorState.values()) {
      st.ou = st.ou * (1 - 0.14) + st.ouVol * this._randn();
      st.ou = clamp(st.ou, -0.008, 0.008);   // 单 tick 板块冲击上限（beta 放大后仍可控）
    }
  }

  _evolveStock(s, vtime) {
    const st = this.S.get(s.id);
    const sec = this._sectorState.get(s.sector);
    const beta = Number(s.beta) || 1;
    const vol0 = Math.max(0.00005, Number(s.vol) || 0.0025);
    const drift = Number(s.drift) || 0;

    /* 管理端「临时停牌」：停牌期间价格冻结、不产生成交（复牌后继续演化） */
    if (st.haltedUntil && this._seq < st.haltedUntil) {
      st.rounded = safePrice(st.price);
      st.volMod = 0;
      st.decay = 1;
      return;
    }

    // 冲击衰减（每 tick ×0.85）
    st.impact *= (Number(this.config.IMPACT_DECAY) || 0.94);   // 水平衰减（外部力量慢慢消化）
    if (Math.abs(st.impact) < 1e-7) st.impact = 0;
    st.newsImpact *= 0.9;
    if (Math.abs(st.newsImpact) < 1e-7) st.newsImpact = 0;
    st.newsStock *= 0.88;
    if (Math.abs(st.newsStock) < 1e-7) st.newsStock = 0;

    const nearLimit =
      st.price >= st.limitUp - 0.005 ? 1 :
        st.price <= st.limitDown + 0.005 ? -1 : 0;
    if (nearLimit === 0) {
      st.volMod = Math.min(1, st.volMod + 0.08);
      st.decay = 1;
    } else {
      // 封板：量能与新冲击急速衰减（封板不易打开）
      st.volMod = Math.max(0.05, st.volMod * 0.5);
      st.decay = Math.max(0, (st.decay || 1) - 1);
    }

    const sectorTerm = sec ? (sec.drift + sec.ou) * beta : 0;
    const noise = vol0 * st.volMod * this._randn() * 1.15;
    const macro = 0.00006 * this._randn();                       // 全市场共同项

    /* ── 外部基本面：内在价值自己慢慢走，完全不受玩家买卖影响 ── */
    const fairVol = vol0 * (Number(this.config.FAIR_VOL) || 0.55);
    if (!(st.fair > 0)) st.fair = st.price;
    st.fair *= Math.exp(drift * 1.2 + sectorTerm * 0.35 + fairVol * this._randn() * 0.6);
    if (!isFinite(st.fair) || st.fair <= 0) st.fair = st.price;

    /* ── 目标价 = 内在价值 × exp(玩家冲击水平) ──
       玩家净买入只是把「当前的合理价」临时抬高几个百分点，冲击衰减后价格自然回落；
       这样再多的钱也只会把价格顶在 fair×(1+IMPACT_CLAMP) 附近，而不是无限推高。 */
    const anchorK = Number(this.config.ANCHOR_K) || 0.025;
    const k2 = Number(this.config.FAIR_ANCHOR_QUAD) || 0.30;
    const target = st.fair * Math.exp(st.impact);
    const dev = Math.log(st.price / target);                     // >0 = 高于合理价
    const anchor = -anchorK * dev - k2 * dev * Math.abs(dev);

    /* ── 外部制衡 2：过热/超跌会招来外部盘（机构调仓·大股东减持·北向资金）──
         方向与偏离相反，并作为真实成交打进成交明细，玩家能看见"谁在卖" */
    const clampImp = Number(this.config.IMPACT_CLAMP) || 0.15;
    const absDev = Math.abs(dev);
    if (absDev > 0.02 && st.price > 0) {
      const baseP = Number(this.config.EXTERNAL_FLOW_P) || 0.08;
      const prob = Math.min(0.55, baseP * (1 + absDev * 9));
      if (this._rand() < prob) {
        /* 外部资金站在偏离的反面：把玩家堆出来的冲击直接吃掉一部分 */
        const dir = dev > 0 ? -1 : 1;
        const eat = Math.min(Math.abs(st.impact), absDev * (Number(this.config.EXTERNAL_FLOW_K) || 0.9) * 1.2);
        if (eat > 0) st.impact = clamp(st.impact + dir * eat, -clampImp, clampImp);
        const qty = Math.max(100, Math.round((st.liqPerTick * (0.02 + this._rand() * 0.10)) / 100) * 100);
        this.recordTrade(s.id, st.price, qty);
      }
    }

    const revert = 0;   // 已被「内在价值锚」取代（见上）
    const logret0 = sectorTerm + macro + noise + drift + revert + anchor + st.impact + st.newsImpact + st.newsStock;

    // 涨跌停边界阻尼：越接近停板越难继续朝该方向走（避免大面积锁死在一字板）
    let lp = logret0;
    const band = Math.max(1e-6, (st.limitUp - st.limitDown) / (st.prevClose || st.price));
    if (lp > 0) {
      const gap = Math.max(0, (st.limitUp - st.price) / (st.prevClose || st.price));
      lp *= Math.min(1, Math.pow(Math.min(1, gap / band), 0.55));
    } else if (lp < 0) {
      const gap = Math.max(0, (st.price - st.limitDown) / (st.prevClose || st.price));
      lp *= Math.min(1, Math.pow(Math.min(1, gap / band), 0.55));
    }
    const logret = clamp(lp, -0.4, 0.4);

    let np = st.price * Math.exp(logret);
    if (!isFinite(np) || np <= 0) np = st.price;
    /* 管理端「救市托底」：托底期内不许跌破托底价（国家队接盘） */
    if (st.floorUntil && this._seq < st.floorUntil && st.floorPrice > 0 && np < st.floorPrice) {
      np = st.floorPrice;
    } else if (st.floorUntil && this._seq >= st.floorUntil) {
      st.floorUntil = 0; st.floorPrice = 0;
    }
    np = clamp(np, st.limitDown, st.limitUp);
    st.price = np;

    const rp = safePrice(np);
    st.rounded = rp;
    /* 当日第一分钟的真实成交价才是「今开」（含隔夜跳空）；
       以前 open 在日切时被写成昨收后再不更新，导致 61 只股票的今开永远等于昨收。 */
    if (this._minuteOfDay === 0) st.open = rp;
    if (rp > st.high) st.high = rp;
    if (rp < st.low) st.low = rp;
    /* 防御：极端情况下（外部冲击叠加）高低温不得越过涨跌停 */
    if (st.high > st.limitUp) st.high = st.limitUp;
    if (st.low < st.limitDown) st.low = st.limitDown;

    // 封板（涨/跌停）时几乎无量；其余情况成交量随波动放大（1 手 = 100 股）
    const limitLock = st.price >= st.limitUp - 0.005 || st.price <= st.limitDown + 0.005;
    let tickV = 0;
    if (!limitLock || this._rand() < 0.25) {
      const chg = Math.abs(np / (st.prevClose || np) - 1);
      const mvRate = 0.00006;
      const act = 0.45 + chg * 55 + this._rand() * 0.9;
      tickV = Math.round(st.floatShares * mvRate * act / 100) * 100;
      if (st.volMod < 0.5) tickV = Math.round(tickV * st.volMod / 100) * 100;
      if (this._rand() < 0.03) tickV = 0;                      // 偶发零成交分钟
      tickV = Math.max(0, tickV);
    }
    // 合成成交：量额计入 st.v / st.a（并即时同步快照与今日日 K）
    if (tickV > 0) this._applyVolume(st, rp, tickV, vtime);

    // 1 分钟 K：同一虚拟分钟就地刷新，跨分钟追加一根
    const arr = this._minBars.get(s.id);
    let bar = arr.length ? arr[arr.length - 1] : null;
    if (!bar || bar[0] !== vtime) {
      bar = [vtime, rp, rp, rp, rp, tickV];
      arr.push(bar);
      if (arr.length > MAX_MIN_BARS) arr.splice(0, arr.length - MAX_MIN_BARS);
    } else {
      bar[4] = rp;
      if (st.high > bar[2]) bar[2] = st.high;
      if (st.low < bar[3]) bar[3] = st.low;
      bar[5] += tickV;
    }
    st._bar = bar;
  }

  /**
   * 成交落账：累计成交量/额，并把 p/h/l/v/a/avg 同步进当前快照与今日日 K。
   * 无论合成成交、合成流动性成交还是玩家成交，都走这里。
   */
  _applyVolume(stock, price, qty, vtime) {
    const st = (stock && stock.id && this.S.get(stock.id)) || null;
    if (!st) return;
    const q = Math.max(0, Math.round(Number(qty) || 0));
    if (q > 0) {
      const px = Number(price) > 0 ? Number(price) : st.price;
      st.v += q;
      st.a += px * q;
      if (!isFinite(st.a) || st.a < 0) st.a = 0;
    }
    this._syncSnapshot(st);
  }

  /** 把当前价格/量额同步进缓存快照（不重建五档，避免递归） */
  _syncSnapshot(st) {
    const q = st.q;
    if (!q) return;
    q.p = round2(st.rounded);
    q.o = round2(st.open);
    q.h = round2(st.high);
    q.l = round2(st.low);
    q.pc = round2(st.prevClose);
    q.v = Math.round(st.v);
    q.a = round2(st.a);
    q.avg = round2(this._avgPrice(st));
  }

  /**
   * 记录一笔外部（玩家撮合）成交：计入量额、追加到本 tick 的成交明细。
   * engine.js 在玩家之间成交时调用。
   * @returns {boolean}
   */
  recordTrade(stockId, price, qty) {
    const st = this.S.get(stockId);
    if (!st) return false;
    const q = Math.max(0, Math.round(Number(qty) || 0));
    const px = Number(price) > 0 ? Number(price) : st.price;
    if (q <= 0) return false;
    // 这是一次写操作：确保本 tick 快照存在，玩家成交才能立刻反映到 tr/五档
    if (!st.q) { const stock = this.byId.get(stockId); if (stock) this._buildQuote(stock); }
    this._applyVolume(st, px, q);            // 量额 + 快照 v/a/avg 同步
    const detail = [snap(px), q, px >= st.rounded ? 1 : -1];
    if (!st.extTr) st.extTr = [];
    st.extTr.push(detail);                   // 跨快照重建保留
    if (st.extTr.length > 24) st.extTr.splice(0, st.extTr.length - 24);
    if (st.q && st.q.tr.indexOf(detail) < 0) {
      st.q.tr.push(detail);
      if (st.q.tr.length > 12) st.q.tr.splice(0, st.q.tr.length - 12);
    }
    this._invalidate(stockId);
    return true;
  }

  /* ═════════ 盘口 / 成交明细 ═════════ */

  _levelQty(st) {
    const base = Math.max(200, st.liqPerTick * 0.22);
    const r = 0.55 + this._rand() * 1.5;
    const aligned = Math.round((base * r) / 100) * 100;
    return Math.max(100, aligned);
  }

  _makeLevels(st, side, mid, count) {
    const out = [];
    for (let k = 1; k <= count; k++) {
      const p = side === 'b' ? mid - 0.01 * k : mid + 0.01 * k;
      if (p < MIN_PRICE) break;
      if (side === 'b' && p < st.limitDown) break;
      if (side === 's' && p > st.limitUp) break;
      let q = this._levelQty(st);
      if (p <= st.limitDown + 0.005) q = Math.round(q * 3.2 / 100) * 100;   // 跌停封单
      if (p >= st.limitUp - 0.005) q = Math.round(q * 3.2 / 100) * 100;     // 涨停封单
      out.push([snap(p), q]);
    }
    return out;
  }

  _makeTrades(st, p) {
    const tr = [];
    if (p <= 0) return tr;
    const mid = st.rounded;
    const atUp = mid >= st.limitUp - 0.005;
    const atDown = mid <= st.limitDown + 0.005;
    if (atDown) return tr;                                       // 跌停：买不到
    // 本 tick 成交量太小时不出明细
    const tickVol = Math.max(0, st.v - st.lastV);
    if (tickVol < st.liqPerTick * 0.02) return tr;

    const n = Math.floor(this._rand() * 6) + 1;
    let left = tickVol;
    for (let i = 0; i < n && left >= 100; i++) {
      const buy = atUp ? false : this._rand() < 0.5;             // 涨停时只有主动卖
      let price;
      if (buy) {
        price = snap(this._rand() < 0.65 ? mid : mid + 0.01);
      } else {
        price = snap(this._rand() < 0.65 ? mid : mid - 0.01);
      }
      if (price < st.limitDown) price = st.limitDown;
      if (price > st.limitUp) price = st.limitUp;
      let q = Math.round((st.liqPerTick * (0.08 + this._rand() * 0.4)) / 100) * 100;
      q = Math.max(100, Math.min(q, Math.floor(left / 100) * 100));
      if (q < 100) break;
      tr.push([price, q, buy ? 1 : -1]);
      left -= q;
    }
    return tr;
  }

  /* ═════════ 行情快照 ═════════ */

  _avgPrice(st) {
    return st.v > 0 ? st.a / st.v : st.rounded;
  }

  _buildQuote(stock) {
    const st = this.S.get(stock.id);
    const id = stock.id;
    const price = st.rounded;

    // 今日日 K 在此收口，保证「日 K 最后一根收盘 == 现价」永不脱节
    this._updateDayBar(st, price);

    const atLimitUp = st.limitUp > 0 && price >= st.limitUp - 0.005;
    const atLimitDown = st.limitDown > 0 && price <= st.limitDown + 0.005;

    const b = atLimitDown ? [] : this._makeLevels(st, 'b', price, 5);
    const s = atLimitUp ? [] : this._makeLevels(st, 's', price, 5);
    // 合成明细 + 本 tick 已发生的玩家成交明细（recordTrade 写入，跨重建保留）
    const tr = this._makeTrades(st, price).concat(st.extTr || []);
    if (tr.length > 12) tr.splice(0, tr.length - 12);

    st.lastV = st.v;
    st.lastA = st.a;

    const out = {
      i: id,
      p: round2(price),
      o: round2(st.open),
      h: round2(st.high),
      l: round2(st.low),
      pc: round2(st.prevClose),
      v: Math.round(st.v),
      a: round2(st.a),
      b,
      s,
      tr,
      limitUp: round2(st.limitUp),
      limitDown: round2(st.limitDown),
      avg: round2(this._avgPrice(st)),
    };
    st.q = out;
    return out;
  }

  /** 把当前状态写进「今日进行中」的那根日 K */
  _updateDayBar(st, price) {
    const hArr = this._hist.get(st.id);
    if (!hArr || !hArr.length) return;
    const ts = this._dayBase + this._dayCount * 86400000;
    let bar = hArr[hArr.length - 1];
    if (!bar || bar[0] !== ts) {
      bar = [ts, safePrice(st.open), safePrice(st.high), safePrice(st.low), price, Math.round(st.v)];
      hArr.push(bar);
      if (hArr.length > MAX_DAY_BARS) hArr.splice(0, hArr.length - MAX_DAY_BARS);
      return;
    }
    bar[2] = safePrice(st.high);
    bar[3] = safePrice(st.low);
    bar[4] = price;
    bar[5] = Math.round(st.v);
  }

  /**
   * 只读取「合成基准快照」。**无副作用**（不会因调用而改变量额/预算/随机数）：
   * - 本 tick 已有快照 → 直接返回（幂等）
   * - 快照被成交/冲击失效 → 用当前状态重建一次（把本 tick 的玩家成交明细并回去）
   * - 尚未 tick() 过 → 从状态直读的轻量对象（盘口为空，不消耗随机数）
   * 注意：绝不返回合并了玩家挂单的 st.qx，保证 getQuote(id) 与 getQuote(id, lv) 互不污染。
   */
  _qcache(id) {
    const st = this.S.get(id);
    if (!st) return null;
    if (st.q) return st.q;
    if (this._initialized) {
      const stock = this.byId.get(id);
      if (stock) return this._buildQuote(stock);
    }
    return this._rawQuote(id, st);
  }

  /** tick() 之前 / 从未开盘时的兜底快照（纯状态直读，无随机、无副作用） */
  _rawQuote(id, st) {
    return {
      i: id,
      p: round2(st.rounded),
      o: round2(st.open),
      h: round2(st.high),
      l: round2(st.low),
      pc: round2(st.prevClose),
      v: Math.round(st.v),
      a: round2(st.a),
      b: [],
      s: [],
      tr: [],
      limitUp: round2(st.limitUp),
      limitDown: round2(st.limitDown),
      avg: round2(this._avgPrice(st)),
    };
  }

  /**
   * 只读取「对手最优价与量」，供撮合引擎做价格比较。
   * **无副作用**：不刷新盘口、不消耗流动性、不产生随机数。
   * @param {string} stockId
   * @param {'buy'|'sell'} side 本方方向（buy → 对手是卖档）
   * @returns {{price:number, qty:number}|null}
   */
  getBestOpposite(stockId, side) {
    const st = this.S.get(stockId);
    if (!st) return null;
    const buy = side === 'buy' ? true : side === 'sell' ? false : null;
    if (buy === null) return null;
    const levels = st.q ? (buy ? st.q.s : st.q.b) : null;
    if (levels && levels.length) return { price: levels[0][0], qty: levels[0][1] };
    // 快照未生成 / 停板无档
    if (buy) {
      if (st.rounded >= st.limitUp - 0.005) return null;
      return { price: snap(st.rounded + 0.01), qty: 0 };
    }
    if (st.rounded <= st.limitDown + 0.005) return null;
    return { price: snap(st.rounded - 0.01), qty: 0 };
  }

  _invalidate(stockId) {
    const st = this.S.get(stockId);
    if (st) { st.q = null; st.qx = null; }
  }

  /* ═════════ 公开查询 ═════════ */

  get seq() { return this._seq; }
  get vtime() { return this._dayBase + this._dayCount * 86400000 + util.sessionMinutes(this._minuteOfDay) * 60000; }
  get vclock() { return util.vclockOf(this._minuteOfDay); }
  get dayIndex() { return this._dayIndex; }
  get minuteOfDay() { return this._minuteOfDay; }

  sectorOf(stockId) {
    const s = this.byId.get(stockId);
    return s ? s.sector : null;
  }

  /** PROTOCOL game:start.stocks 的静态字段 */
  getMeta() {
    return this.stocks.map(s => {
      const st = this.S.get(s.id);
      const prevClose = round2(st ? st.prevClose : s.prevClose);
      return {
        id: s.id,
        name: s.name,
        sector: s.sector,
        market: s.market === 'us' ? 'us' : 'cn',   // 市场归属（客户端可显示"美"标记）
        pinyin: s.pinyin || '',
        prevClose,
        limitUp: round2(st ? st.limitUp : prevClose * 1.1),
        limitDown: round2(st ? st.limitDown : prevClose * 0.9),
        lotSize: this.config.LOT_SIZE || 100,
        pe: typeof s.pe === 'number' ? s.pe : 0,
        floatMv: Math.round((st ? st.floatShares : Number(s.floatShares) || 0) * prevClose),
      };
    });
  }

  /** 撮合 / 账户需要的内部状态 */
  getState(stockId) {
    const st = this.S.get(stockId);
    if (!st) return null;
    return {
      id: stockId,
      name: (this.byId.get(stockId) || {}).name,
      sector: this.sectorOf(stockId),
      price: round2(st.price),
      raw: st.price,
      prevClose: round2(st.prevClose),
      open: round2(st.open),
      high: round2(st.high),
      low: round2(st.low),
      limitUp: round2(st.limitUp),
      limitDown: round2(st.limitDown),
      limitPct: st.limitPct,
      floatShares: st.floatShares,
      lotSize: this.config.LOT_SIZE || 100,
      volume: Math.round(st.v),
      amount: round2(st.a),
      avgPrice: round2(this._avgPrice(st)),
      fair: isFinite(st.fair) && st.fair > 0 ? st.fair : st.price,   // 内在价值（对外只读，便于诊断/展示）
      /* 运维控制台施加的行政状态（停牌 / 救市托底），供控制台与客户端展示 */
      halted: !!(st.haltedUntil && this._seq < st.haltedUntil),
      haltTicksLeft: st.haltedUntil ? Math.max(0, st.haltedUntil - this._seq) : 0,
      floored: !!(st.floorUntil && this._seq < st.floorUntil),
      floorPrice: st.floorUntil && this._seq < st.floorUntil ? round2(st.floorPrice) : 0,
      floorTicksLeft: st.floorUntil ? Math.max(0, st.floorUntil - this._seq) : 0,
      impact: Number(st.impact) || 0,                              // 玩家冲击水平（价格偏移）
      liqPerTick: st.liqPerTick,
      flowBudget: isFinite(st.flowBudget) ? Math.round(st.flowBudget) : st.liqPerTick * FLOW_BUDGET_TICKS,
      bid0: st.q && st.q.b[0] ? st.q.b[0][0] : round2(st.price - 0.01),
      ask0: st.q && st.q.s[0] ? st.q.s[0][0] : round2(st.price + 0.01),
    };
  }

  /**
   * 完整内部行情（同一 tick 内幂等）。
   * @param {string} stockId
   * @param {{bids?:Array, asks?:Array}} [externalBook] 玩家挂单（engine.getBook），
   *        合并进五档：同价位量相加；玩家价优于合成价时该档显示玩家价；仍返回 5 档。
   */
  getQuote(stockId, externalBook) {
    const base = this._qcache(stockId);
    if (!base || !externalBook) return base;
    const bids = Array.isArray(externalBook.bids) ? externalBook.bids : [];
    const asks = Array.isArray(externalBook.asks) ? externalBook.asks : [];
    if (!bids.length && !asks.length) return base;
    const st = this.S.get(stockId);
    if (!st) return base;
    if (!st.qx) {
      st.qx = {
        i: base.i,
        p: base.p,
        o: base.o,
        h: base.h,
        l: base.l,
        pc: base.pc,
        v: base.v,
        a: base.a,
        avg: base.avg,
        limitUp: base.limitUp,
        limitDown: base.limitDown,
        tr: base.tr,
        b: base.b,
        s: base.s,
      };
    }
    /* 每次并档都要把基础行情字段同步一遍，否则 o/h/l/pc/涨跌停会冻结在
       首次并档那一刻（客户端会看到错误的最低价/昨收/涨跌停） */
    st.qx.p = base.p;
    st.qx.o = base.o;
    st.qx.h = base.h;
    st.qx.l = base.l;
    st.qx.pc = base.pc;
    st.qx.limitUp = base.limitUp;
    st.qx.limitDown = base.limitDown;
    st.qx.v = base.v;
    st.qx.a = base.a;
    st.qx.avg = base.avg;
    st.qx.tr = base.tr;
    /* 并档锚价用「对手方最优价」而不是最新成交价：
       - 买档只要不越过卖一，就是合法的排队单，应当显示在盘口里
         （最新成交价可能落在买一上，用它当锚会把合法买单一律藏掉）
       - 跨过对手价的单在真实市场会立刻成交，不会静止在簿上，故仍需过滤 */
    const ask0 = (base.s && base.s.length) ? base.s[0][0] : NaN;
    const bid0 = (base.b && base.b.length) ? base.b[0][0] : NaN;
    /* 买档上限 = 卖一 - 1 个最小变动价位；卖档下限 = 买一 + 1 个价位
       （等于对手价即属可成交，不该静止显示在盘口上） */
    const tickSz = 0.01;
    st.qx.b = mergeBook(base.b, bids, 'b', isFinite(ask0) ? ask0 - tickSz : st.rounded, st.limitUp);
    st.qx.s = mergeBook(base.s, asks, 's', isFinite(bid0) ? bid0 + tickSz : st.rounded, st.limitDown);
    return st.qx;
  }

  getIndices() {
    if (this._idxCache) return this._idxCache;
    const out = this._indices.map(ix => {
      let sum = 0;
      let amt = 0;
      for (let k = 0; k < ix.members.length; k++) {
        const st = this.S.get(ix.members[k]);
        if (!st) continue;
        const pc = st.prevClose || st.price || 1;
        sum += ix.weights[k] * (st.price / pc - 1);
        amt += this._avgPrice(st) * st.v;
      }
      const v = ix.base * (1 + sum);
      const pc = this._idxPrev.has(ix.code) ? this._idxPrev.get(ix.code) : v;
      if (!this._idxPrev.has(ix.code)) this._idxPrev.set(ix.code, v);
      return {
        c: ix.code,
        n: ix.name,
        v: isFinite(v) ? round2(v) : round2(ix.base),
        pc: round2(pc),
        pct: pc > 0 ? Math.round((v / pc - 1) * 1e6) / 1e6 : 0,
        amt: Math.round(amt),
      };
    });
    this._idxCache = out;
    return out;
  }

  /* ═════════ K 线 ═════════ */

  getBars(stockId, tf = '1d', limit) {
    const n = Math.max(1, Math.min(2000, Math.round(Number(limit) || 240)));
    const kind = String(tf || '1d').toLowerCase();
    if (!this.S.has(stockId)) return [];

    if (kind === '1d' || kind === 'd' || kind === 'day') {
      const h = this._hist.get(stockId) || [];
      return h.slice(Math.max(0, h.length - n)).map(b => b.slice());
    }

    const min = this._minBars.get(stockId) || [];
    if (kind === '1m') return min.slice(Math.max(0, min.length - n)).map(b => b.slice());

    const ratio = kind === '5m' ? 5 : kind === '15m' ? 15 : 0;
    if (!ratio) {
      // 未知周期 → 当作日 K
      const h = this._hist.get(stockId) || [];
      return h.slice(Math.max(0, h.length - n)).map(b => b.slice());
    }
    const agg = aggregateBars(min, ratio);
    return agg.slice(Math.max(0, agg.length - n)).map(b => b.slice());
  }

  /* ═════════ 冲击 / 流动性 ═════════ */

  /** 玩家成交的价格冲击：k * 净成交额 / 每 tick 流动性 */
  applyFlow(stockId, signedQty, side, notional, price) {
    const st = this.S.get(stockId);
    if (!st) return 0;
    const q = Number(signedQty) || 0;
    if (!q) return 0;
    const px = Number(price) > 0 ? Number(price) : st.price;
    const amount = isFinite(Number(notional)) && Number(notional) !== 0 ? Math.abs(Number(notional)) : Math.abs(q) * px;
    const k = Number(this.config.IMPACT_K) || 0.9;
    /* ⚠️ 方向必须取自 signedQty（买入为正、卖出为负）：
       之前用 Math.abs(notional) 算出来恒为正，导致「买卖都推高股价」，
       多人同时交易时全市场只会单边暴涨。 */
    const dir = q > 0 ? 1 : -1;
    const impact = dir * k * amount / (st.liqPerTick * Math.max(0.05, st.price));
    const perCall = Number(this.config.IMPACT_PER_CALL) || 0.03;
    const cap = Number(this.config.IMPACT_CLAMP) || 0.08;
    const clamped = clamp(impact, -perCall, perCall);
    st.impact = clamp(st.impact + clamped, -cap, cap);
    this._invalidate(stockId);
    return clamped;
  }

  /**
   * 吃合成流动性：从对手 touch 逐档成交，最多延续到 touch 之外 MAX_WALK_LEVELS 档
   * 或偏离 touch 超过 MAX_WALK_PCT；单 tick 同一只股票还有总预算上限
   * （每 tick 流动性 × FLOW_BUDGET_TICKS）。吃不完的部分由引擎去挂单排队。
   * 涨停无卖档 / 跌停无买档的行为保持不变。
   * @returns {{fills:Array<{price:number,qty:number}>, filledQty:number, avgPrice:number, notional:number, exhausted:boolean}}
   */
  consumeLiquidity(stockId, side, qty, limitPrice) {
    const st = this.S.get(stockId);
    const wanted0 = Math.max(0, Math.round(Number(qty) || 0));
    const empty = { fills: [], filledQty: 0, avgPrice: 0, notional: 0, exhausted: false };
    if (!st || wanted0 === 0) return empty;

    const buy = side === 'buy' ? true : side === 'sell' ? false : null;
    if (buy === null) return empty;

    const price = st.rounded;
    const bookSide = buy ? st.q && st.q.s : st.q && st.q.b;
    // 涨停无卖档 / 跌停无买档 → 吃不到
    if (buy && bookSide && bookSide.length === 0) return empty;
    if (!buy && bookSide && bookSide.length === 0) return empty;

    const lim = Number(limitPrice) > 0 ? Number(limitPrice) : null;
    const levels = [];
    if (bookSide && bookSide.length) {
      for (const lv of bookSide) levels.push([Number(lv[0]), Math.max(0, Number(lv[1]) || 0)]);
    } else {
      const seedP = buy ? price + 0.01 : price - 0.01;
      if (buy && seedP > st.limitUp) return empty;
      if (!buy && seedP < st.limitDown) return empty;
      levels.push([snap(seedP), this._levelQty(st)]);
    }

    // 基准 touch = 起始档位里最优的价（买一 / 卖一）
    const touch = levels[0][0];

    // 本 tick 剩余可吃预算
    if (!isFinite(st.flowBudget)) st.flowBudget = st.liqPerTick * FLOW_BUDGET_TICKS;
    let budget = Math.max(0, Math.round(st.flowBudget));
    const want = Math.min(wanted0, budget);
    if (want <= 0) return empty;

    const fills = [];
    let remain = want;
    let notional = 0;
    let filledQty = 0;
    let lastP = touch;

    const walkOk = (p) => {
      // 价格偏离 touch 的幅度上限
      const dev = Math.abs(p / touch - 1);
      return dev <= MAX_WALK_PCT + 1e-9;
    };
    const allowed = (p) => {
      if (buy && p > st.limitUp) return false;
      if (!buy && p < st.limitDown) return false;
      if (lim !== null && (buy ? p > lim + 1e-9 : p < lim - 1e-9)) return false;
      return true;
    };

    // 1) 先吃对手挂着的档位（合成五档）
    for (let i = 0; i < levels.length && remain > 0; i++) {
      const [p, bookQty] = levels[i];
      if (!allowed(p)) break;
      if (!walkOk(p)) break;
      const take = Math.min(remain, bookQty);
      if (take <= 0) continue;
      const t = Math.round(take);
      if (t <= 0) continue;
      fills.push({ price: p, qty: t });
      notional += p * t;
      filledQty += t;
      remain -= t;
      lastP = p;
    }

    // 2) 档位吃完 → 沿不利方向续档（模拟滑点），严格限定档数与偏离幅度
    let walked = 0;
    while (remain > 0 && walked < MAX_WALK_LEVELS) {
      let np = buy ? snap(lastP + 0.01) : snap(lastP - 0.01);
      if (buy && np <= lastP) np = snap(lastP + 0.01);
      if (!buy && np >= lastP) np = snap(lastP - 0.01);
      if (!allowed(np)) break;
      if (np > st.limitUp) np = st.limitUp;
      if (np < st.limitDown) np = st.limitDown;
      if (!walkOk(np)) break;
      const t = Math.round(remain);
      if (t <= 0) break;
      fills.push({ price: np, qty: t });
      notional += np * t;
      filledQty += t;
      remain = 0;
      lastP = np;
      walked++;
    }

    if (filledQty <= 0) return empty;

    st.flowBudget = Math.max(0, budget - filledQty);
    const avgPrice = round2(notional / filledQty);

    // 合成盘成交也要计入行情量额与成交明细（否则玩家买到的量在行情里看不到）
    this._applyVolume(st, avgPrice, filledQty);
    if (!st.extTr) st.extTr = [];
    for (const f of fills) st.extTr.push([snap(f.price), f.qty, buy ? 1 : -1]);
    if (st.extTr.length > 24) st.extTr.splice(0, st.extTr.length - 24);

    this.applyFlow(stockId, buy ? filledQty : -filledQty, side, notional, avgPrice);
    this._invalidate(stockId);
    return {
      fills,
      filledQty,
      avgPrice,
      notional: round2(notional),
      exhausted: filledQty < wanted0,
    };
  }

  /* ═══════════ 管理端政策事件（只由 server/src/admin.js 调用）═══════════ */

  /**
   * 一次性施加一整套政策效果。参数都是可选组合：
   *   stockId / sector / all   作用域（all 优先级最高）
   *   dir, strength            即时冲击（走 applyNewsImpact，指数衰减）
   *   fairPct                  内在价值**永久**变动比例（补贴/加息这类基本面事件，
   *                            不这么改的话会被内在价值锚在几分钟内抹平）
   *   floorTicks               托底时长（tick）：期间价格不得跌破事件时刻的 99.5%（救市）
   *   haltTicks                停牌时长（tick）：期间价格冻结、几乎无成交
   * @returns {{scope:string, targets:number, fairPct:number, floorTicks:number, haltTicks:number}}
   */
  applyPolicy(opts = {}) {
    const dir = Number(opts.dir) >= 0 ? 1 : -1;
    const strength = clamp(Number(opts.strength) || 0, 0, 1);
    const fairPct = clamp(Number(opts.fairPct) || 0, -0.25, 0.25);
    const floorTicks = Math.max(0, Math.round(Number(opts.floorTicks) || 0));
    const haltTicks = Math.max(0, Math.round(Number(opts.haltTicks) || 0));

    const targets = [];
    if (opts.all) {
      for (const s of this.stocks) targets.push(s.id);
    } else if (opts.sector) {
      for (const s of this.stocks) if (s.sector === opts.sector) targets.push(s.id);
    } else if (opts.stockId) {
      if (this.S.has(opts.stockId)) targets.push(opts.stockId);
    }
    if (!targets.length) {
      return { scope: 'none', targets: 0, fairPct, floorTicks, haltTicks };
    }

    if (strength > 0) {
      this.applyNewsImpact({
        all: !!opts.all, sector: opts.all ? null : opts.sector, stockId: opts.stockId,
        dir, strength,
      });
    }

    for (const id of targets) {
      const st = this.S.get(id);
      if (!st) continue;
      if (fairPct) {
        /* 金融/地产对利率更敏感 */
        const s = this.byId.get(id);
        const beta = (s && /金融|地产/.test(s.sector)) ? 1.35 : 1;
        const f = st.fair > 0 ? st.fair : st.price;
        st.fair = clamp(f * (1 + fairPct * beta), f * 0.5, f * 2);
      }
      if (floorTicks > 0) {
        st.floorPrice = safePrice(st.price * 0.995);
        st.floorUntil = this._seq + floorTicks;
      }
      if (haltTicks > 0) {
        st.haltedUntil = this._seq + haltTicks;
      }
    }
    for (const id of targets) this._invalidate(id);
    return {
      scope: opts.all ? 'market' : opts.sector ? 'sector' : 'stock',
      targets: targets.length, fairPct, floorTicks, haltTicks,
    };
  }

  /** 解除停牌 / 解除托底（复牌用） */
  clearPolicy({ stockId, sector, all, halt = true, floor = true } = {}) {
    const targets = [];
    /* ⚠️ 这里必须写大括号：写成
         if (all) for (...) push; else if (sector) for (...) if (...) push; else if (stockId) push;
       会触发经典的 dangling-else —— 最后的 else 绑到**内层 if** 上，
       于是整段都被包进 if (all)，传 stockId 时（all 为假）什么都不执行。 */
    if (all) {
      for (const s of this.stocks) targets.push(s.id);
    } else if (sector) {
      for (const s of this.stocks) if (s.sector === sector) targets.push(s.id);
    } else if (stockId) {
      targets.push(stockId);
    }
    for (const id of targets) {
      const st = this.S.get(id);
      if (!st) continue;
      if (halt) st.haltedUntil = 0;
      if (floor) { st.floorUntil = 0; st.floorPrice = 0; }
      this._invalidate(id);
    }
    return { targets: targets.length };
  }

  /** 新闻冲击：个股 > 板块。strength 0~1，越大冲击越猛（指数衰减回到基本面） */
  /** 运维控制台：强制把当前交易日推进到收盘（下一个 tick 会日切并进入午间休市） */
  forceNextDay() {
    const d = Math.max(1, this.dayTicks || 240);
    this._seq = Math.ceil((this._seq + 1) / d) * d;
    this._minuteOfDay = 0;
    return { seq: this._seq, dayTicks: d };
  }

  applyNewsImpact({ sector, stockId, dir, strength, all } = {}) {
    const s0 = clamp(Number(strength) || 0, 0, 1);
    const d = Number(dir) >= 0 ? 1 : -1;
    /* all=true → 全市场（央行/救市这类宏观事件） */
    if (all) {
      for (const s of this.stocks) {
        const st = this.S.get(s.id);
        if (!st) continue;
        /* 金融/地产对利率最敏感，科技成长股次之 —— 给一点行业差异，观感更像真实市场 */
        const beta = /金融|地产/.test(s.sector) ? 1.35 : /纳指|人工智能|半导体/.test(s.sector) ? 1.15 : 1;
        st.newsImpact = clamp(st.newsImpact + d * 0.004 * (0.3 + s0) * beta, -0.15, 0.15);
        this._invalidate(s.id);
      }
    }
    if (stockId) {
      const st = this.S.get(stockId);
      if (st) {
        st.newsStock = clamp(st.newsStock + d * 0.008 * (0.3 + s0), -0.18, 0.18);
        this._invalidate(stockId);
      }
    }
    if (sector) {
      for (const s of this.stocks) {
        if (s.sector !== sector) continue;
        const st = this.S.get(s.id);
        if (!st) continue;
        st.newsImpact = clamp(st.newsImpact + d * 0.004 * (0.3 + s0), -0.15, 0.15);
        this._invalidate(s.id);
      }
    }
  }

  /** 调试 / 测试：直接注入冲击 */
  _injectImpact(stockId, value) {
    const st = this.S.get(stockId);
    if (st) { st.impact = clamp(st.impact + Number(value) || 0, -0.3, 0.3); this._invalidate(stockId); }
  }

  /** 该股当前每 tick 参考流动性（股） */
  liquidityOf(stockId) {
    const st = this.S.get(stockId);
    return st ? st.liqPerTick : 0;
  }

  /** 调试 / 测试：把价格强制推到涨停(dir=1)/跌停(dir=-1)，并刷新五档 */
  forceLimit(stockId, dir = 1) {
    const st = this.S.get(stockId);
    const stock = this.byId.get(stockId);
    if (!st || !stock) return null;
    st.price = Number(dir) >= 0 ? st.limitUp : st.limitDown;
    st.rounded = safePrice(st.price);
    if (st.rounded > st.high) st.high = st.rounded;
    if (st.rounded < st.low) st.low = st.rounded;
    this._buildQuote(stock);
    return st.q;
  }
}

module.exports = { Market, aggregateBars, safePrice, snap };
module.exports.default = Market;
