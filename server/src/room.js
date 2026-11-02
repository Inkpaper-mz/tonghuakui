/* ═══════════════════════════════════════════════════════════════
   同花亏 · room.js —— 一个房间 = 一局对战（DESIGN.md §3.10）
   ─ 状态机：waiting → countdown → playing → finished
   ─ timer 循环：setTimeout 链式 + 累计误差修正（nextAt = startedAt + seq*TICK_MS）
   ─ 只 require 其它模块，绝不修改 market/engine/portfolio/bot/news/elo/store
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const EventEmitter = require('events');
const util = require('./util');

const { Market } = require('./market');
const MatchingEngine = require('./engine');
const { NewsEngine } = require('./news');
const Portfolio = require('./portfolio');
const BotBrain = require('./bot');
const eloApi = require('./elo');

const WAITING = 'waiting';
const COUNTDOWN = 'countdown';
const PLAYING = 'playing';
const FINISHED = 'finished';

const MAX_PLAYERS = 30;      // 与 config.MAX_PLAYERS 对齐

function r2(v) { return util.round2(v); }
function r6(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0; }

/**
 * 把玩家挂单并进行情五档：价格优先排序、同价合并、只保留 5 档。
 * @param {Array} base  行情自带的档位 [[price, qty], ...]
 * @param {Array} extra 撮合引擎里玩家挂单聚合档位 [[price, qty], ...]
 * @param {'bids'|'asks'} side
 */
function mergeSide(base, extra, side) {
  const m = new Map();
  const add = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const lv of arr) {
      if (!lv) continue;
      const p = Math.round(Number(lv[0]) * 100) / 100;
      const q = Number(lv[1]);
      if (!(p > 0) || !(q > 0)) continue;
      m.set(p, (m.get(p) || 0) + q);
    }
  };
  add(base);
  add(extra);
  const out = [];
  for (const [p, q] of m.entries()) out.push([p, Math.round(q)]);
  out.sort((a, b) => (side === 'bids' ? b[0] - a[0] : a[0] - b[0]));
  return out.slice(0, 5);
}

class Room extends EventEmitter {
  /**
   * @param {{id?:string, name?:string, mode?:string, maxPlayers?:number, durationSec?:number,
   *          startCash?:number, fillBots?:boolean, lobby?:object, config:object,
   *          market?:object, engine?:object, news?:object}} opts
   */
  constructor(opts = {}) {
    super();
    const cfg = opts.config;
    this.config = cfg;
    this.lobby = opts.lobby || null;

    this.id = opts.id || util.uid('r');
    this.name = String(opts.name || '对战房间').slice(0, 24);
    this.mode = opts.mode || 'ffa';
    const hardMax = Number(cfg.MAX_PLAYERS) > 0 ? Number(cfg.MAX_PLAYERS) : MAX_PLAYERS;
    this.maxPlayers = Math.max(2, Math.min(hardMax, Math.round(Number(opts.maxPlayers) || 2)));
    this.durationSec = Math.max(30, Math.round(Number(opts.durationSec) || cfg.DEFAULT_DURATION_SEC || 900));
    this.startCash = r2(Number(opts.startCash) || cfg.DEFAULT_START_CASH || 1000000);
    this.fillBots = opts.fillBots === true;
    this.fillTo = Math.max(0, Math.round(Number(opts.fillTo) || 0));   // 快速匹配：AI 补齐到多少人（0 = 用默认）
    /* 时间节奏：1 个虚拟分钟 = VIRTUAL_MINUTE_TICKS 个 tick（默认 5 → 5 秒一个虚拟分钟）
       每个虚拟交易日结束后进入 BREAK_SEC 秒的「午间休市」，期间行情冻结。 */
    /* 配速以「多少真实秒 = 1 个虚拟分钟」为准，再按 tickMs 换算成 tick 数，
       这样 --tick 改成 500 或 2000 都不会让时间变快变慢。 */
    this.secondsPerMinute = Math.max(1, Math.round(Number(cfg.SECONDS_PER_VIRTUAL_MINUTE) || 5));
    this.breakSec = Math.max(0, Math.round(Number(cfg.BREAK_SEC) || 0));
    this.breakUntil = 0;          // 休市结束时间戳（0 = 未在休市）
    this.breakDay = 0;            // 刚结束的那个交易日序号
    this.paused = false;          // 运维控制台暂停（行情与撮合全冻结，挂单排队）
    this.quick = opts.quick === true;
    this.tickMs = Math.max(50, Math.round(Number(cfg.TICK_MS) || 1000));
    /* ⚠️ 必须放在 tickMs 赋值之后再算：之前写在前面，this.tickMs 还是 undefined，
       算出来是 NaN，于是 seq % NaN 永远不等于 0 → 行情再也不推进（只剩第一 tick）。 */
    this.minuteTicks = Math.max(1, Math.round(this.secondsPerMinute * 1000 / this.tickMs));

    this.status = WAITING;
    this.countdown = 0;
    this.hostId = null;
    this.matchId = null;
    this.match = null;
    this.teams = null;
    this.result = null;

    this.createdAt = Date.now();
    this.startedAt = 0;
    this.endsAt = 0;
    this.seq = 0;
    this.vtime = 0;
    this.vclock = '09:30';
    this.dayIndex = 0;

    /** Map<playerId, seat>；seat = {player, ready, pf, bot, sig, forfeited, frozenAssets} */
    this.seats = new Map();
    /** 对局中离席（弃赛）的席位（资产冻结在离席时刻，仍参与结算排名） */
    this.retired = [];
    this.newsLog = [];

    this.market = opts.market || null;
    this.engine = opts.engine || null;
    this.news = opts.news || null;
    this._depsReady = false;

    this._tickTimer = null;
    this._countdownTimer = null;
    this._quickTimer = null;
    this._orderStatus = new Map();
    this._notified = new Set();
    this.log = util.createLogger('room:' + this.id);
  }

  /* ═══════════════ 依赖（每个房间独立的一套行情/撮合/新闻） ═══════════════ */

  _ensureDeps() {
    if (this._depsReady) return;
    const cfg = this.config;
    if (!this.market) {
      /* 把参与人数传给行情引擎：人越多市场越深 + 外部制衡会按人数生效 */
      this.market = new Market({
        stocks: cfg.STOCKS,
        config: cfg,
        participants: Math.max(this.seats.size, this.maxPlayers),
      });
    }
    if (!this.engine) this.engine = new MatchingEngine({ market: this.market, config: cfg });
    if (!this.news) this.news = new NewsEngine({ market: this.market, config: cfg });
    if (this.engine && typeof this.engine.on === 'function') {
      this.engine.on('order', (ev) => this._onEngineOrder(ev));
    }
    this._depsReady = true;
  }

  /* ═══════════════ 席位 ═══════════════ */

  seatOf(playerId) { return this.seats.get(playerId) || null; }

  isFull() { return this.seats.size >= this.maxPlayers; }

  isEmpty() { return this.seats.size === 0; }

  playerCount() { return this.seats.size; }

  humanCount() {
    let n = 0;
    for (const e of this.seats.values()) if (!e.player.isBot) n += 1;
    return n;
  }

  hostNick() {
    const e = this.hostId ? this.seats.get(this.hostId) : null;
    return e ? e.player.nick : '—';
  }

  /**
   * @returns {boolean} 是否成功入座
   */
  addPlayer(player, opts = {}) {
    if (!player || !player.id) return false;
    if (this.seats.has(player.id)) return true;
    if (this.isFull()) return false;
    if (this.status !== WAITING && this.status !== FINISHED && this.status !== COUNTDOWN) return false;

    const seat = {
      player,
      ready: player.isBot ? true : opts.ready === true,
      pf: null,
      bot: null,
      sig: null,
      forfeited: false,
      frozenAssets: null,
    };
    this.seats.set(player.id, seat);
    player.roomId = this.id;
    if (!this.hostId || !this.seats.has(this.hostId)) this.hostId = player.id;

    if (opts.silent !== true) {
      this._event('join', player);
      this.broadcast({ t: 'room:update', room: this.toInfo() });
      this.emit('changed', this);
    }
    return true;
  }

  /**
   * 房主指定（用于房主离开后移交）
   */
  setHost(playerId) {
    if (!this.seats.has(playerId)) return false;
    this.hostId = playerId;
    this.broadcast({ t: 'room:update', room: this.toInfo() });
    this.emit('changed', this);
    return true;
  }

  setReady(playerId, ready) {
    const e = this.seats.get(playerId);
    if (!e || e.player.isBot) return false;
    e.ready = !!ready;
    this.broadcast({ t: 'room:update', room: this.toInfo() });
    this.emit('changed', this);
    return true;
  }

  /**
   * 离席。对局中离席 = 认输弃赛（资产冻结在最后值继续参与排名）。
   */
  removePlayer(playerId) {
    const e = this.seats.get(playerId);
    if (!e) return false;
    if (this.status === PLAYING) return this.forfeit(playerId);

    this.seats.delete(playerId);
    if (this.hostId === playerId) {
      const next = Array.from(this.seats.values()).find(s => !s.player.isBot);
      this.hostId = next ? next.player.id : null;
    }
    this._event('leave', e.player);

    if (this.seats.size === 0) {
      this._clearTimers();
      if (this.status === COUNTDOWN) this.status = WAITING;
      this.emit('changed', this);
      this.emit('empty', this);
      return true;
    }

    if (this.status === COUNTDOWN && !this.canStart()) {
      // 倒计时中人数不足 → 回到等待
      if (this._countdownTimer) { clearTimeout(this._countdownTimer); this._countdownTimer = null; }
      this.status = WAITING;
      this.countdown = 0;
    }
    this.emit('changed', this);
    this.broadcast({ t: 'room:update', room: this.toInfo() });
    return true;
  }

  /** 弃赛：冻结资产、移出座位、仍进入结算榜 */
  forfeit(playerId) {
    const e = this.seats.get(playerId);
    if (!e) return false;
    if (this.status !== PLAYING) return this.removePlayer(playerId);

    e.forfeited = true;
    e.frozenAssets = e.pf ? r2(e.pf.computeAssets().totalAssets) : this.startCash;
    this.seats.delete(playerId);
    this.retired.push(e);
    if (this.hostId === playerId) {
      const next = Array.from(this.seats.values()).find(s => !s.player.isBot);
      this.hostId = next ? next.player.id : null;
    }
    this._event('leave', e.player);
    this.emit('changed', this);
    this.broadcast({ t: 'room:update', room: this.toInfo() });

    const active = this.seats.size;
    if (active <= 1) this.finish('forfeit');
    return true;
  }

  /* ═══════════════ 开局 ═══════════════ */

  /** 人数是否满足开局（PROTOCOL §1：人数 >= 2，或 fillBots 为真） */
  canStart() {
    if (this.status !== WAITING && this.status !== FINISHED) return false;
    const humans = this.humanCount();
    const total = this.seats.size;
    if (total < 1) return false;
    if (this.mode === 'team' && total < 4 && !this.fillBots) return false;
    if (total >= 2) return true;
    return this.fillBots && humans >= 1;
  }

  _targetPlayers() {
    if (this.mode === '1v1') return 2;
    /* 快速匹配用 AI 补齐时，只补到 QUICK_MATCH_FILL（默认 8），
       否则 30 人房会瞬间塞进 29 个机器人，既慢又不好玩；
       房主手动开的房间则按房主设定的人数上限补满。 */
    if (this.fillTo > 0) return Math.min(this.maxPlayers, this.fillTo);
    if (this.quick) {
      const fill = Number(this.config.QUICK_MATCH_FILL) || 8;
      return Math.min(this.maxPlayers, fill);
    }
    return this.maxPlayers;
  }

  /** AI 补位到目标人数 */
  _fillBots() {
    let i = 0;
    let guard = 0;
    while (this.seats.size < this._targetPlayers() && guard++ < 64) {
      const bot = this._makeBot(++i);
      if (!bot) break;
      if (!this.addPlayer(bot, { ready: true, silent: false })) break;
    }
  }

  _makeBot(seq) {
    const used = new Set();
    for (const e of this.seats.values()) used.add(e.player.nick);
    const names = this.config.BOT_NAMES || ['AI 机器人'];
    const base = names[(Math.abs(seq) - 1) % names.length];
    const nick = util.uniqueName(base, used);
    const eloV = 900 + Math.floor(Math.random() * 500);
    return {
      id: `${this.id}_b${seq}`,
      nick,
      avatar: Math.floor(Math.random() * (this.config.AVATARS ? this.config.AVATARS.length : 12)),
      elo: eloV,
      tier: eloApi.tierOf(eloV),
      isBot: true,
      roomId: this.id,
      conn: null,
      token: null,
      send() { return false; },
      disconnect() { },
    };
  }

  /** 房主点开始：先进入 countdown，倒计时结束才真正 reset + 开局 */
  start() {
    if (this.status !== WAITING || !this.canStart()) return false;
    if (this.fillBots) this._fillBots();
    this.status = COUNTDOWN;
    this.countdown = Math.max(1, Math.round(Number(this.config.COUNTDOWN_SEC) || 3));
    this.emit('changed', this);
    this.broadcast({ t: 'room:update', room: this.toInfo() });
    this._countdownStep();
    return true;
  }

  _countdownStep() {
    if (this.status !== COUNTDOWN) return;
    this._countdownTimer = setTimeout(() => {
      this._countdownTimer = null;
      if (this.status !== COUNTDOWN) return;
      this.countdown -= 1;
      if (this.countdown <= 0) { this._begin(); return; }
      this.broadcast({ t: 'room:update', room: this.toInfo() });
      this._countdownStep();
    }, 1000);
  }

  /** 真正开局：reset market/engine/news → 建 Portfolio/BotBrain → game:start → tick 循环 */
  _begin() {
    if (this.status !== COUNTDOWN) return;
    this._clearTimers();
    this.countdown = 0;
    this._ensureDeps();

    try { this.market.reset(); } catch (err) { this.log.warn('market.reset 失败', err && err.message); }
    try { this.engine.reset(); } catch (err) { this.log.warn('engine.reset 失败', err && err.message); }
    try { this.news.reset(); } catch (err) { this.log.warn('news.reset 失败', err && err.message); }

    const now = Date.now();
    this.matchId = util.uid('m');
    this.startedAt = now;
    this.endsAt = now + this.durationSec * 1000;
    this.match = {
      id: this.matchId,
      mode: this.mode,
      durationSec: this.durationSec,
      startedAt: now,
      endsAt: this.endsAt,
      startCash: this.startCash,
      tickMs: this.tickMs,
      virtualDayTicks: Math.round(Number(this.config.VIRTUAL_DAY_TICKS) || 240),
      sectors: (this.config.SECTORS || []).slice(),
    };

    this.seq = 0;
    this.vtime = this.market.vtime || now;
    this.vclock = this.market.vclock || '09:30';
    this.dayIndex = this.market.dayIndex || 0;
    this.retired = [];
    this.newsLog = [];
    this._orderStatus = new Map();
    this._notified = new Set();
    this.result = null;

    /* 团战分队：红蓝交替 */
    if (this.mode === 'team') {
      const order = util.shuffle(Array.from(this.seats.keys()));
      this.teams = {};
      order.forEach((pid, i) => { this.teams[pid] = i % 2 === 0 ? 'red' : 'blue'; });
    } else {
      this.teams = null;
    }

    /* 建账户 + AI */
    const stockIds = (this.config.STOCKS || []).map(s => s.id);
    for (const e of this.seats.values()) {
      e.forfeited = false;
      e.frozenAssets = null;
      e.sig = null;
      e.pf = new Portfolio({ id: e.player.id, startCash: this.startCash, config: this.config, market: this.market });
      try { this.engine.registerPortfolio(e.pf); } catch (err) { this.log.warn('registerPortfolio 失败', err && err.message); }
      if (e.player.isBot) {
        const diff = util.clamp((Number(e.player.elo) - 800) / 800, 0.15, 0.95);
        try {
          e.bot = new BotBrain({ portfolio: e.pf, market: this.market, engine: this.engine, config: this.config, stockIds, difficulty: diff });
        } catch (err) { e.bot = null; this.log.warn('BotBrain 创建失败', err && err.message); }
      } else {
        e.bot = null;
      }
    }

    this.status = PLAYING;
    this.emit('changed', this);
    this.broadcast({ t: 'game:start', match: this.match, stocks: this.market.getMeta(), teams: this.teams });
    this.broadcast({ t: 'room:update', room: this.toInfo() });
    this._pushAccounts(null, true);
    this._broadcastRank();
    this._scheduleTick();
    this.emit('start', this.match);
    this.log.ok(`开局 ${this.matchId} · ${this.mode} · ${this.seats.size} 人 · ${this.durationSec}s`);
  }

  /* ═══════════════ tick 循环（setTimeout 链式 + 误差修正） ═══════════════ */

  _scheduleTick() {
    if (this.status !== PLAYING) return;
    const seq = this.seq + 1;
    const nextAt = this.startedAt + seq * this.tickMs;
    this._tickTimer = setTimeout(() => {
      this._tickTimer = null;
      this._tick();
    }, Math.max(0, nextAt - Date.now()));
  }

  _tick() {
    if (this.status !== PLAYING) return;
    this.seq += 1;
    try {
      const now = Date.now();

      /* ── 运维控制台「暂停」：行情与撮合全部冻结，只保留心跳与账户推送 ── */
      if (this.paused) {
        this.broadcast({ t: 'break', paused: true, leftSec: 0, totalSec: 0, dayIndex: this.dayIndex, vclock: this.vclock, endsAt: this.endsAt });
        this._detectOrderChanges();
        this._pushAccounts(null, false);
        if (Date.now() >= this.endsAt) { this.finish('timeup'); return; }
        this._scheduleTick();
        return;
      }

      /* ── 午间休市：行情冻结，但撮合/账户/心跳照常（挂单会排队等开盘）── */
      if (this.breakUntil && now < this.breakUntil) {
        this.breakLeftSec = Math.max(0, Math.ceil((this.breakUntil - now) / 1000));
        this._broadcastBreak();
        try { this.engine.onTick({ vtime: this.vtime, dayIndex: this.dayIndex }); }
        catch (err) { /* ignore */ }
        this._detectOrderChanges();
        this._pushAccounts(null, false);
        if (Date.now() >= this.endsAt) { this.finish('timeup'); return; }
        this._scheduleTick();
        return;
      }
      if (this.breakUntil && now >= this.breakUntil) {
        /* 休市结束 → 新交易日开盘 */
        this.breakUntil = 0;
        this.breakLeftSec = 0;
        this.broadcast({ t: 'break', over: true, vclock: this.vclock, dayIndex: this.dayIndex });
      }

      /* ── 每 minuteTicks 个 tick 推进 1 个虚拟分钟（其余 tick 只做撮合与心跳）── */
      const advance = (this.seq % this.minuteTicks) === 0;
      let tk = this._lastTk;
      if (advance) {
        const prevDay = this.dayIndex;
        tk = this.market.tick();
        this._lastTk = tk;
        this.vtime = tk.vtime;
        this.vclock = tk.vclock;
        this.dayIndex = tk.dayIndex;
        /* 日切（上午收盘）→ 进入午间休市 */
        if (this.dayIndex !== prevDay && this.breakSec > 0) {
          this.breakUntil = Date.now() + this.breakSec * 1000;
          this.breakLeftSec = this.breakSec;
          this.breakDay = this.dayIndex;
          this.log.info(`第 ${this.dayIndex} 个交易日收盘，午间休市 ${this.breakSec}s`);
        }
      } else if (!tk) {
        tk = this.market.tick();
        this._lastTk = tk;
        this.vtime = tk.vtime;
        this.vclock = tk.vclock;
        this.dayIndex = tk.dayIndex;
      } else {
        this.vtime = this.market.vtime;
        this.vclock = this.market.vclock;
      }

      try { this.engine.onTick({ vtime: this.vtime, dayIndex: this.dayIndex }); }
      catch (err) { this.log.warn('engine.onTick 异常', err && err.message); }

      for (const e of this.seats.values()) {
        if (e.bot) { try { e.bot.step({ seq: tk.seq, vtime: tk.vtime }); } catch (err) { /* AI 不能影响对局 */ } }
      }
      /* 资产曲线的横轴语义是「对局进度」（客户端按 m:ss 从 0:00 画到整局时长），
         所以必须传**距开局的真实毫秒数**，不能传虚拟行情时间 vtime：
         一局会跨好几个虚拟交易日，用 vtime 会让时间跨度变成 24 小时以上，
         横轴刻度就会变成 362:15 这种鬼数字（曲线还会被挤出可视区）。 */
      const eqT = Math.max(0, Date.now() - (this.startedAt || Date.now()));
      for (const e of this.seats.values()) {
        if (e.pf) { try { e.pf.markToMarket(eqT); } catch (err) { /* ignore */ } }
      }

      if (advance) this._maybeNews(tk);
      this._broadcastTick(tk);
      this._detectOrderChanges();
      if (this.seq % 3 === 0) this._broadcastRank();
      this._pushAccounts(tk, false);

      if (Date.now() >= this.endsAt) { this.finish('timeup'); return; }
    } catch (err) {
      this.log.error('tick 异常', err && err.stack ? err.stack : err);
    }
    this._scheduleTick();
  }

  /**
   * 运维控制台运行时控制：暂停/继续、调速、强制休市、跳到下一交易日。
   * @param {'pause'|'resume'|'speed'|'break'|'endbreak'|'nextday'} action
   * @param {{seconds?:number, minuteTicks?:number}} opts
   */
  adminControl(action, opts = {}) {
    const sys = (text) => this.broadcast({ t: 'chat', from: 'system', nick: '系统', system: true, time: Date.now(), text });
    switch (String(action)) {
      case 'pause':
        this.paused = true;
        this.broadcast({ t: 'break', paused: true, leftSec: 0, totalSec: 0, dayIndex: this.dayIndex, vclock: this.vclock, endsAt: this.endsAt });
        sys('⏸ 管理员暂停了本局，等待继续…');
        return { ok: true, action, paused: true };
      case 'resume':
        this.paused = false;
        this.breakUntil = 0;
        this.broadcast({ t: 'break', over: true, paused: false, dayIndex: this.dayIndex, vclock: this.vclock });
        sys('▶ 管理员继续了本局');
        return { ok: true, action, paused: false };
      case 'speed': {
        /* 优先按「秒/虚拟分钟」；兼容旧参数 minuteTicks */
        const sec = opts.secondsPerMinute != null
          ? Math.max(1, Math.min(60, Math.round(Number(opts.secondsPerMinute) || 5)))
          : Math.max(1, Math.min(60, Math.round((Number(opts.minuteTicks) || this.minuteTicks) * this.tickMs / 1000)));
        this.secondsPerMinute = sec;
        this.minuteTicks = Math.max(1, Math.round(sec * 1000 / Math.max(50, this.tickMs)));
        sys(`⏱ 管理员把时间速度调为：1 个虚拟分钟 = ${sec} 秒`);
        return { ok: true, action, secondsPerMinute: sec, minuteTicks: this.minuteTicks };
      }
      case 'break': {
        const sec = Math.max(1, Math.min(600, Math.round(Number(opts.seconds) || this.breakSec || 60)));
        this.breakSec = sec;
        this.breakUntil = Date.now() + sec * 1000;
        this.breakLeftSec = sec;
        sys(`☕ 管理员开启午间休市 ${sec} 秒`);
        return { ok: true, action, seconds: sec };
      }
      case 'endbreak':
        this.breakUntil = 0;
        this.broadcast({ t: 'break', over: true, dayIndex: this.dayIndex, vclock: this.vclock });
        return { ok: true, action };
      case 'nextday': {
        const r = this.market && typeof this.market.forceNextDay === 'function' ? this.market.forceNextDay() : null;
        sys('⏭ 管理员跳到了下一个交易日');
        return { ok: true, action, seq: r && r.seq };
      }
      default:
        return { ok: false, msg: `未知控制指令：${action}` };
    }
  }

  /** 午间休市广播（每秒一次，带倒计时） */
  _broadcastBreak() {
    this.broadcast({
      t: 'break',
      active: true,
      leftSec: this.breakLeftSec || 0,
      totalSec: this.breakSec,
      dayIndex: this.dayIndex,
      vclock: this.vclock,
      nextOpen: '09:30',
      endsAt: this.endsAt,
    });
  }

  _broadcastTick(tk) {
    const quotes = [];
    for (const q of (tk.quotes || [])) {
      const wire = this._quoteForWire(q);
      if (wire) quotes.push(wire);
    }
    this.broadcast({
      t: 'tick',
      /* seq 用**房间心跳序号**（每个 tick 都 +1，严格递增）；
         market 的序号每 VIRTUAL_MINUTE_TICKS 个 tick 才推进一次，会重复，不能当协议里的 seq。 */
      seq: this.seq,
      marketSeq: tk.seq,
      vtime: tk.vtime,
      vclock: tk.vclock,
      serverTime: Date.now(),
      idx: tk.idx || [],
      quotes,
    });
  }

  /** 内部行情 → PROTOCOL tick.quotes 元素（玩家挂单并进五档） */
  _quoteForWire(q) {
    if (!q) return null;
    let lv = null;
    try {
      if (this.engine && typeof this.engine.getBookLevels === 'function') lv = this.engine.getBookLevels(q.i);
      else if (this.engine && typeof this.engine.getBook === 'function') {
        const bk = this.engine.getBook(q.i) || {};
        lv = {
          bids: (bk.bids || []).map(x => [x.price, x.qty]),
          asks: (bk.asks || []).map(x => [x.price, x.qty]),
        };
      }
    } catch (err) { lv = null; }
    const bids = lv && Array.isArray(lv.bids) ? lv.bids : [];
    const asks = lv && Array.isArray(lv.asks) ? lv.asks : [];
    return {
      i: q.i,
      p: q.p,
      o: q.o,
      h: q.h,
      l: q.l,
      pc: q.pc,
      /* 涨跌停必须每 tick 下发：虚拟日切后涨跌停会按新昨收重算，
         客户端若一直用开局快照，价格涨过旧涨停后就会误判「超过涨停价」而拒绝委托。 */
      limitUp: q.limitUp != null ? q.limitUp : q.lu,
      limitDown: q.limitDown != null ? q.limitDown : q.ld,
      v: q.v,
      a: q.a,
      avg: q.avg,
      b: mergeSide(q.b, bids, 'bids'),
      s: mergeSide(q.s, asks, 'asks'),
      tr: Array.isArray(q.tr) ? q.tr.slice(0, 10) : [],
    };
  }

  _maybeNews(tk) {
    let news = null;
    try { news = this.news.maybeGenerate({ seq: tk.seq, vtime: tk.vtime }); }
    catch (err) { news = null; }
    if (!news) return;
    try { if (news.impact) this.market.applyNewsImpact(news.impact); }
    catch (err) { this.log.warn('applyNewsImpact 失败', err && err.message); }
    this.newsLog.unshift(news);
    if (this.newsLog.length > 60) this.newsLog.length = 60;
    this.broadcast({
      t: 'news',
      news: {
        id: news.id,
        time: news.time,
        title: news.title,
        body: news.body,
        level: news.level,
        sector: news.sector,
        stockId: news.stockId,
        predict: news.predict,
      },
    });
  }

  /* ═══════════════ 排行 / 账户 ═══════════════ */

  /** 完整排行行（含内部字段，供 game:over 使用） */
  _rankRows() {
    const rows = [];
    const all = Array.from(this.seats.values()).concat(this.retired);
    for (const e of all) {
      const pf = e.pf;
      let assets = this.startCash;
      if (pf) { try { assets = pf.computeAssets().totalAssets; } catch (err) { assets = this.startCash; } }
      if (e.forfeited && e.frozenAssets != null) assets = e.frozenAssets;
      const stats = pf ? (() => { try { return pf.tradeStats(); } catch (err) { return { tradeCount: 0, feeTotal: 0 }; } })() : { tradeCount: 0, feeTotal: 0 };
      let mdd = 0;
      if (pf) { try { mdd = pf.maxDrawdown(); } catch (err) { mdd = 0; } }
      rows.push({
        id: e.player.id,
        nick: e.player.nick,
        avatar: e.player.avatar || 0,
        isBot: !!e.player.isBot,
        assets: r2(assets),
        returnPct: this.startCash > 0 ? r6((assets - this.startCash) / this.startCash) : 0,
        todayPnl: r2(assets - this.startCash),
        maxDrawdown: r6(mdd),
        tradeCount: stats.tradeCount || 0,
        feeTotal: r2(stats.feeTotal || 0),
        equity: (pf && Array.isArray(pf.equity)) ? pf.equity : [],
        tier: e.player.tier || eloApi.tierOf(e.player.elo),
        team: this.teams ? (this.teams[e.player.id] || null) : null,
        forfeited: !!e.forfeited,
      });
    }

    /* 团战：按队伍平均收益率排名 */
    let teamAvg = null;
    if (this.mode === 'team' && this.teams) {
      const agg = { red: { sum: 0, n: 0 }, blue: { sum: 0, n: 0 } };
      for (const r of rows) {
        const t = r.team;
        if (!t || !agg[t]) continue;
        agg[t].sum += r.returnPct;
        agg[t].n += 1;
      }
      teamAvg = {
        red: agg.red.n ? agg.red.sum / agg.red.n : -Infinity,
        blue: agg.blue.n ? agg.blue.sum / agg.blue.n : -Infinity,
      };
    }

    const scoreOf = (r) => {
      if (r.forfeited) return -Infinity;
      if (teamAvg) {
        const v = teamAvg[r.team];
        return Number.isFinite(v) ? v : -Infinity;
      }
      return r.assets;
    };
    rows.sort((a, b) => {
      const sa = scoreOf(a);
      const sb = scoreOf(b);
      if (sa !== sb) return sb - sa;
      if (a.assets !== b.assets) return b.assets - a.assets;
      return String(a.id).localeCompare(String(b.id));
    });
    return rows;
  }

  /**
   * rank 报文：每个接收者一份（isMe 不同）。
   * 只包含「还在房间里」的玩家：中途弃赛/离席者不再出现在实时排行榜里
   * （他们仍会以 forfeited 身份进入 game:over 的最终名次）。
   */
  _broadcastRank() {
    if (this.status !== PLAYING) return;
    const rows = this._rankRows().filter(r => !r.forfeited);
    const base = rows.map(r => ({
      id: r.id,
      nick: r.nick,
      avatar: r.avatar,
      assets: r.assets,
      returnPct: r.returnPct,
      isBot: r.isBot,
      tier: r.tier,
      team: r.team,
      todayPnl: r.todayPnl,
    }));
    for (const e of this.seats.values()) {
      const p = e.player;
      if (!p || p.isBot || !p.conn) continue;
      const list = base.map(r => Object.assign({}, r, { isMe: r.id === p.id }));
      p.send({ t: 'rank', endsAt: this.endsAt, vclock: this.vclock, list });
    }
  }

  _sendRank(player) {
    if (!player || player.isBot) return;
    const rows = this._rankRows().filter(r => !r.forfeited);
    const list = rows.map(r => ({
      id: r.id, nick: r.nick, avatar: r.avatar, assets: r.assets, returnPct: r.returnPct,
      isBot: r.isBot, isMe: r.id === player.id, tier: r.tier, team: r.team, todayPnl: r.todayPnl,
    }));
    player.send({ t: 'rank', endsAt: this.endsAt, vclock: this.vclock, list });
  }

  _accountSig(pf) {
    let s = `${pf.trades ? pf.trades.length : 0}|${Math.round((pf.cash || 0) * 100)}|${Math.round((pf.frozen || 0) * 100)}|`;
    /* 持仓（数量/可用）也要计入签名：日切 T+1 解禁、成交改仓都要立刻推 account */
    if (pf.positions && typeof pf.positions.forEach === 'function') {
      const pos = [];
      pf.positions.forEach((p, sid) => { pos.push(`${sid}:${p ? p.qty : 0}:${p ? p.avail : 0}`); });
      pos.sort();
      s += pos.join(',') + '|';
    }
    if (pf.orders && typeof pf.orders.forEach === 'function') {
      const parts = [];
      pf.orders.forEach((o) => { parts.push(`${o.id}:${o.status}:${o.filled || 0}`); });
      parts.sort();
      s += parts.join(',');
    }
    return s;
  }

  /** 私发 account（有变化立即发，否则每 ACCOUNT_PUSH_EVERY tick 一次） */
  _pushAccounts(tk, force) {
    const every = Math.max(1, Math.round(Number(this.config.ACCOUNT_PUSH_EVERY) || 3));
    const due = force || (tk && tk.seq % every === 0);
    for (const e of this.seats.values()) {
      const p = e.player;
      if (!p || p.isBot || !p.conn || !e.pf) continue;
      let sig;
      try { sig = this._accountSig(e.pf); } catch (err) { continue; }
      if (!due && sig === e.sig) continue;
      e.sig = sig;
      this._sendAccount(e, true);
    }
  }

  /** 单个玩家立即推账户（下单/撤单后调用） */
  pushAccount(playerId, force) {
    const e = this.seats.get(playerId);
    if (!e || !e.pf || !e.player || e.player.isBot) return false;
    if (force) { try { e.sig = this._accountSig(e.pf); } catch (err) { /* ignore */ } }
    this._sendAccount(e, true);
    return true;
  }

  _sendAccount(seat, force) {
    if (!seat || !seat.pf || !seat.player || seat.player.isBot || !seat.player.conn) return false;
    if (force) { try { seat.sig = this._accountSig(seat.pf); } catch (err) { /* ignore */ } }
    let snap = null;
    try { snap = seat.pf.snapshot(); } catch (err) { snap = null; }
    if (!snap) return false;
    seat.player.send(snap);
    return true;
  }

  /** 断线重连后补齐一次性状态（game:start + account + rank + room:update） */
  resync(playerId) {
    const e = this.seats.get(playerId);
    if (!e || !e.player || e.player.isBot) return false;
    e.player.send({ t: 'room:update', room: this.toInfo() });
    if (this.status === PLAYING || this.status === FINISHED) {
      if (this.match) e.player.send({ t: 'game:start', match: this.match, stocks: this.market.getMeta(), teams: this.teams });
      this._sendAccount(e, true);
      if (this.status === PLAYING) this._sendRank(e.player);
      if (this.status === FINISHED && this.result) e.player.send({ t: 'game:over', result: this.result.result, teams: this.result.teams });
    }
    return true;
  }

  /* ═══════════════ 委托变动 → toast ═══════════════ */

  _onEngineOrder(ev) {
    try {
      if (!ev || !ev.order) return;
      const order = ev.order;
      const playerId = ev.playerId || order.playerId;
      const reason = ev.reason || this._reasonOf(order);
      this._notifyOrder(playerId, order, reason);
      /* 引擎在 placeOrder/cancelOrder 内部同步 emit，若这里同步推 account 会抢在
         order:ack 前面（PROTOCOL §2.4 要求「先回执后账户推送」）。用微任务延后一档：
         调用方（net.js）的 order:ack 会在当前同步块内先发出，微任务随后才跑。 */
      queueMicrotask(() => {
        try { this.pushAccount(playerId, true); } catch (err) { /* ignore */ }
      });
    } catch (err) { /* ignore */ }
  }

  _reasonOf(order) {
    if (!order) return 'open';
    if (order.status === 'filled') return 'filled';
    if (order.status === 'partial') return 'partial';
    if (order.status === 'rejected') return 'rejected';
    if (order.status === 'canceled') return 'canceled';
    return 'open';
  }

  /** 兜底：引擎若未 emit('order')，用状态 diff 产生同样的 toast */
  _detectOrderChanges() {
    for (const e of this.seats.values()) {
      const pf = e.pf;
      if (!pf || !pf.orders || typeof pf.orders.forEach !== 'function') continue;
      pf.orders.forEach((o) => {
        if (!o || !o.id) return;
        const key = `${o.status}:${o.filled || 0}`;
        const prev = this._orderStatus.get(o.id);
        if (prev === key) return;
        this._orderStatus.set(o.id, key);
        if (prev === undefined && o.status === 'open') return;   // 新挂单：order:ack 已提示
        if (o.status === 'open') return;
        this._notifyOrder(e.player.id, o, this._reasonOf(o));
      });
    }
  }

  _notifyOrder(playerId, order, reason) {
    if (!playerId || !order) return;
    const key = `${order.id}:${order.status}:${order.filled || 0}:${reason}`;
    if (this._notified.has(key)) return;
    this._notified.add(key);
    if (this._notified.size > 4000) this._notified.clear();

    const sideCn = order.side === 'buy' ? '买入' : '卖出';
    const name = this._stockName(order.stockId);
    const qty = order.qty || 0;
    const filled = order.filled || 0;
    const px = util.round2(order.avgPrice || order.price || 0);
    let level = 'info';
    let msg;
    switch (reason) {
      case 'filled':
        level = 'success';
        msg = `你的委托已全部成交：${sideCn} ${name} ${qty}股 @${px.toFixed(2)}`;
        break;
      case 'partial':
        msg = `部分成交：${sideCn} ${name} ${filled}/${qty}股 @${px.toFixed(2)}`;
        break;
      case 'canceled':
        level = 'warn';
        msg = order.expired
          ? `委托超时已自动撤单：${sideCn} ${name} ${qty - filled}股`
          : `已撤单：${sideCn} ${name} ${qty - filled}股`;
        break;
      case 'rejected':
        level = 'error';
        msg = `委托被拒：${order.side === 'buy' ? '买入' : '卖出'} ${name} ${qty}股`;
        break;
      default:
        return;
    }
    this.sendTo(playerId, { t: 'toast', level, msg });
  }

  _stockName(stockId) {
    const list = this.config.STOCKS || [];
    for (let i = 0; i < list.length; i++) if (list[i].id === stockId) return list[i].name;
    return stockId || '—';
  }

  /* ═══════════════ 结算 ═══════════════ */

  /**
   * @param {'timeup'|'forfeit'|'host_end'} reason
   */
  finish(reason = 'timeup') {
    if (this.status !== PLAYING) return null;
    this._clearTimers();
    this.status = FINISHED;

    const rows = this._rankRows();
    rows.forEach((row, i) => { row.rank = i + 1; });

    /* ELO：只对真人计算（AI 不参与） */
    const humans = rows.filter(r => !r.isBot);
    let deltas = new Map();
    try { deltas = eloApi.eloMulti(humans.map(r => ({ id: r.id, elo: this._playerElo(r.id), rank: r.rank }))) || new Map(); }
    catch (err) { this.log.warn('eloMulti 失败', err && err.message); }

    const tierChanges = [];
    for (const row of humans) {
      const delta = Math.round(Number(deltas.get(row.id)) || 0);
      const seat = this.seats.get(row.id) || this.retired.find(e => e.player.id === row.id) || null;
      const player = seat ? seat.player : null;
      const before = player ? Number(player.elo) : this._playerElo(row.id);
      const after = Math.max(100, Math.round(before + delta));
      const fromTier = eloApi.tierOf(before);
      const toTier = eloApi.tierOf(after);
      row.eloDelta = delta;
      row.eloAfter = after;
      row.tier = toTier;
      row.eloBefore = before;
      if (player) {
        player.elo = after;
        player.tier = toTier;
        player.games = (player.games || 0) + 1;
        if (row.rank === 1) player.wins = (player.wins || 0) + 1;
        else player.losses = (player.losses || 0) + 1;
      }
      if (fromTier !== toTier) tierChanges.push({ id: row.id, from: fromTier, to: toTier, elo: after });
    }

    const rank = rows.map(r => {
      const out = {
        id: r.id,
        nick: r.nick,
        avatar: r.avatar,
        isBot: r.isBot,
        assets: r.assets,
        returnPct: r.returnPct,
        maxDrawdown: r.maxDrawdown,
        tradeCount: r.tradeCount,
        feeTotal: r.feeTotal,
        equity: r.equity,
        tier: r.tier,
        eloDelta: r.isBot ? 0 : r.eloDelta,
      };
      if (r.team) out.team = r.team;
      if (r.forfeited) out.forfeited = true;
      return out;
    });

    /* 团战结算 */
    let teams = null;
    if (this.mode === 'team' && this.teams) {
      const agg = { red: { sum: 0, n: 0 }, blue: { sum: 0, n: 0 } };
      for (const r of rows) {
        const t = r.team;
        if (!t || !agg[t]) continue;
        agg[t].sum += r.returnPct;
        agg[t].n += 1;
      }
      const redPct = agg.red.n ? agg.red.sum / agg.red.n : 0;
      const bluePct = agg.blue.n ? agg.blue.sum / agg.blue.n : 0;
      teams = {
        red: { returnPct: r6(redPct), score: redPct > bluePct ? 1 : 0 },
        blue: { returnPct: r6(bluePct), score: bluePct > redPct ? 1 : 0 },
      };
    }

    const result = { matchId: this.matchId, reason, rank, tierChanges };
    this.result = { result, teams };
    this.emit('changed', this);
    this.broadcast({ t: 'game:over', result, teams });
    this.broadcast({ t: 'room:update', room: this.toInfo() });
    this.log.ok(`结算 ${this.matchId} · ${reason} · 冠军 ${rank[0] ? rank[0].nick : '—'}（${rank[0] ? rank[0].returnPct : 0}）`);

    if (this.lobby && typeof this.lobby.recordResult === 'function') {
      try { this.lobby.recordResult(this, result); } catch (err) { this.log.warn('recordResult 失败', err && err.message); }
    }
    this.emit('finished', result);
    return result;
  }

  _playerElo(playerId) {
    const seat = this.seats.get(playerId) || this.retired.find(e => e.player.id === playerId);
    if (seat && seat.player && Number.isFinite(Number(seat.player.elo))) return Number(seat.player.elo);
    const p = this.lobby && this.lobby.players ? this.lobby.players.get(playerId) : null;
    return p && Number.isFinite(Number(p.elo)) ? Number(p.elo) : (this.config.ELO_START || 1000);
  }

  /** 再来一局：清空账户与状态，回到 waiting */
  rematch() {
    if (this.status !== FINISHED) return false;
    this._clearTimers();
    for (const e of this.seats.values()) {
      e.pf = null;
      e.bot = null;
      e.sig = null;
      e.forfeited = false;
      e.frozenAssets = null;
      if (!e.player.isBot) e.ready = false;
    }
    for (const e of this.retired) e.pf = null;
    this.retired = [];
    this.result = null;
    this.match = null;
    this.matchId = null;
    this.teams = null;
    this.status = WAITING;
    this.countdown = 0;
    if (!this.hostId || !this.seats.has(this.hostId)) {
      const next = Array.from(this.seats.values()).find(s => !s.player.isBot);
      this.hostId = next ? next.player.id : null;
    }
    this.emit('changed', this);
    this.broadcast({ t: 'room:update', room: this.toInfo() });
    return true;
  }

  /** 停止所有定时器（服务端退出 / 房间销毁） */
  _clearTimers() {
    if (this._tickTimer) { clearTimeout(this._tickTimer); this._tickTimer = null; }
    if (this._countdownTimer) { clearTimeout(this._countdownTimer); this._countdownTimer = null; }
    if (this._quickTimer) { clearTimeout(this._quickTimer); this._quickTimer = null; }
  }

  destroy() {
    this._clearTimers();
    this.removeAllListeners();
  }

  /* ═══════════════ 报文 ═══════════════ */

  /** PROTOCOL room:update.room */
  toInfo() {
    const players = [];
    for (const e of this.seats.values()) {
      players.push({
        id: e.player.id,
        nick: e.player.nick,
        avatar: e.player.avatar || 0,
        ready: !!e.ready,
        isBot: !!e.player.isBot,
        isHost: e.player.id === this.hostId,
        tier: e.player.tier || eloApi.tierOf(e.player.elo),
        elo: Math.round(Number(e.player.elo) || 0),
      });
    }
    return {
      id: this.id,
      name: this.name,
      mode: this.mode,
      maxPlayers: this.maxPlayers,
      hostId: this.hostId,
      status: this.status,
      countdown: this.status === COUNTDOWN ? this.countdown : 0,
      durationSec: this.durationSec,
      startCash: this.startCash,
      fillBots: !!this.fillBots,
      matchId: this.matchId || null,
      teams: this.teams || null,
      players,
    };
  }

  /** 大厅房间列表行 */
  toLobbyRow() {
    return {
      id: this.id,
      name: this.name,
      mode: this.mode,
      maxPlayers: this.maxPlayers,
      playerCount: this.seats.size,
      status: this.status,
      durationSec: this.durationSec,
      startCash: this.startCash,
      hostNick: this.hostNick(),
    };
  }

  sendTo(playerId, msg) {
    const e = this.seats.get(playerId);
    if (!e || !e.player || !e.player.conn) return false;
    try { return !!e.player.send(msg); } catch (err) { return false; }
  }

  broadcast(msg, filterFn) {
    let n = 0;
    for (const e of this.seats.values()) {
      const p = e.player;
      if (!p || p.isBot || !p.conn) continue;
      if (typeof filterFn === 'function' && !filterFn(p, e)) continue;
      try { if (p.send(msg)) n += 1; } catch (err) { /* 单连接异常不影响其它连接 */ }
    }
    return n;
  }

  _event(action, player) {
    this.broadcast({
      t: 'player:event',
      action,
      roomId: this.id,
      player: { id: player.id, nick: player.nick, avatar: player.avatar || 0 },
    }, (p) => p.id !== player.id);
  }
}

module.exports = Room;
module.exports.Room = Room;
module.exports.STATUS = { WAITING, COUNTDOWN, PLAYING, FINISHED };
