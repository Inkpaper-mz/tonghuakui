/* ═══════════════════════════════════════════════════════════════
   同花亏 · net.js —— 连接会话与消息路由（DESIGN.md §3.11, PROTOCOL.md §1）
   ─ 报文解析 / 限流 / 心跳 / 断线重连
   ─ 任何 handler 抛异常都被捕获（SERVER_ERROR），绝不让进程崩溃
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const util = require('./util');
const advisor = require('./advisor');
const adminApi = require('./admin');
const Room = require('./room');

const { WAITING, COUNTDOWN, PLAYING } = Room.STATUS;
const MAX_CHAT_LEN = 120;

class Net {
  /**
   * @param {{lobby:object, config:object, store?:object}} opts
   */
  constructor({ lobby, config, store } = {}) {
    this.lobby = lobby;
    this.config = config;
    this.store = store || (lobby && lobby.store) || null;
    this.log = util.createLogger('net');
    this.routes = this._buildRoutes();
  }

  /* ═══════════════ 连接 ═══════════════ */

  handle(conn) {
    const sess = {
      conn,
      player: null,
      limiter: new util.RateLimiter(Math.max(5, Number(this.config.RATE_LIMIT_PER_SEC) || 30)),
      closed: false,
    };
    conn._sess = sess;
    conn.on('error', () => { /* ws.js 已经把 socket 异常兜住了，这里避免 EventEmitter 抛错 */ });
    conn.on('message', (text) => {
      try { this._onMessage(sess, text); }
      catch (err) {
        this.log.error('消息处理异常', err && err.stack ? err.stack : err);
        this._error(conn, 'SERVER_ERROR', '服务端处理异常，请稍后再试');
      }
    });
    conn.on('close', () => {
      if (sess.closed) return;
      sess.closed = true;
      try { this._onClose(sess); } catch (err) { /* ignore */ }
    });

    this._send(conn, {
      t: 'welcome',
      server: this.config.SERVER_NAME,
      version: this.config.VERSION,
      serverTime: Date.now(),
      tickMs: this.config.TICK_MS,
      online: this.lobby ? this.lobby.players.size : 0,
    });
  }

  _onClose(sess) {
    const player = sess.player;
    sess.player = null;
    if (player && this.lobby) {
      try { this.lobby.detach(player); } catch (err) { /* ignore */ }
    }
  }

  /* ═══════════════ 收发小工具 ═══════════════ */

  _send(conn, msg) {
    try { return !!conn.send(msg); } catch (err) { return false; }
  }

  _reply(conn, reqId, msg) {
    if (reqId) msg.reqId = reqId;
    return this._send(conn, msg);
  }

  _error(conn, code, msg, reqId) {
    if (conn && conn.readyState === 'closed') return false;
    const out = { t: 'error', code, msg };
    if (reqId) out.reqId = reqId;
    return this._send(conn, out);
  }

  _needLogin(sess, reqId) {
    if (sess.player) return sess.player;
    this._error(sess.conn, 'NOT_LOGGED_IN', '请先登录', reqId);
    return null;
  }

  _needRoom(sess, reqId) {
    const player = this._needLogin(sess, reqId);
    if (!player) return null;
    const room = this.lobby.getRoomOf(player);
    if (!room) { this._error(sess.conn, 'NOT_IN_ROOM', '你当前不在任何房间', reqId); return null; }
    return room;
  }

  _needPlaying(sess, reqId) {
    const room = this._needRoom(sess, reqId);
    if (!room) return null;
    if (room.status !== PLAYING) { this._error(sess.conn, 'NOT_PLAYING', '对局尚未开始', reqId); return null; }
    const seat = room.seatOf(sess.player.id);
    if (!seat || !seat.pf) { this._error(sess.conn, 'NOT_PLAYING', '你不在本局对战名单中', reqId); return null; }
    return { room, seat };
  }

  /** 控制台用的实时快照：房间、指数、涨跌榜、停牌与托底中的股票 */
  _adminState(now) {
    const rooms = this.lobby.playingRooms();
    const out = { t: 'admin:state', serverTime: now, catalog: adminApi.catalog(),
      online: this.lobby.playerCount ? this.lobby.playerCount() : 0,
      rooms: [], indices: [], movers: { up: [], down: [] }, special: [], stocks: [] };
    const seen = new Set();
    for (const room of rooms) {
      const mk = room.market;
      if (!mk) continue;
      out.rooms.push({
        id: room.id, mode: room.mode, status: room.status,
        players: room.playerCount ? room.playerCount() : (room.seats ? room.seats.size : 0),
        maxPlayers: room.maxPlayers,
        endsInSec: room.endsAt ? Math.max(0, Math.round((room.endsAt - now) / 1000)) : 0,
        vclock: room.vclock || '',
        /* 运行时控制状态（控制台据此显示暂停/调速/休市） */
        paused: !!room.paused,
        minuteTicks: room.minuteTicks || 1,
        secondsPerMinute: room.secondsPerMinute || 5,
        breakLeftSec: room.breakUntil && room.breakUntil > now ? Math.ceil((room.breakUntil - now) / 1000) : 0,
        dayIndex: room.dayIndex || 0,
      });
      if (seen.has(room.id)) continue;
      seen.add(room.id);
      if (!out.indices.length && typeof mk.getIndices === 'function') {
        out.indices = (mk.getIndices() || []).map(i => ({ c: i.c, n: i.n, v: i.v, pct: i.pct }));
      }
      if (!out.movers.up.length && typeof mk.getQuote === 'function') {
        const rows = [];
        for (const s of (mk.stocks || [])) {
          const q = mk.getQuote(s.id); const st = mk.getState(s.id);
          if (!q || !st) continue;
          const chg = st.prevClose > 0 ? q.p / st.prevClose - 1 : 0;
          /* ⚠️ getState() 返回的是**快照副本**，上面没有 haltedUntil/floorUntil，
             只有已算好的 halted / floored 布尔与 *TicksLeft。之前读 haltedUntil
             导致控制台里 halted/floor 恒为 false、special 永远空列表。 */
          rows.push({ id: s.id, name: s.name, sector: s.sector, p: q.p, chg, fair: st.fair,
            halted: !!st.halted,
            floor: !!st.floored,
            haltTicksLeft: Number(st.haltTicksLeft) || 0,
            floorTicksLeft: Number(st.floorTicksLeft) || 0,
            floorPrice: Number(st.floorPrice) || 0 });
        }
        rows.sort((a, b) => b.chg - a.chg);
        out.movers.up = rows.slice(0, 8);
        out.movers.down = rows.slice(-8).reverse();
        out.special = rows.filter(r => r.halted || r.floor);
        /* 全量股票清单（61 只，含板块与拼音）：控制台的选股器要靠它才能选中任意一只，
           否则只能在涨跌榜那 16 只里挑。 */
        if (typeof mk.getMeta === 'function') {
          out.stocks = (mk.getMeta() || []).map(m => ({
            id: m.id, name: m.name, sector: m.sector, pinyin: m.pinyin || '', market: m.market || 'cn',
          }));
        }
      }
    }
    return out;
  }

  _configPayload() {
    const c = this.config;
    return {
      tickMs: c.TICK_MS,
      virtualDayTicks: c.VIRTUAL_DAY_TICKS,
      secondsPerVirtualMinute: c.SECONDS_PER_VIRTUAL_MINUTE,
      breakSec: c.BREAK_SEC,
      modes: (c.MODES || []).map(m => ({ id: m.id, name: m.name, maxPlayers: m.maxPlayers })),
      maxPlayers: Number(c.MAX_PLAYERS) || 30,
      playerCountOptions: c.PLAYER_COUNT_OPTIONS || [2, 4, 6, 8, 12, 16, 20, 24, 30],
      durations: (c.DURATIONS || []).map(d => ({ sec: d.sec, name: d.name })),
      startCashOptions: (c.START_CASH_OPTIONS || []).slice(),
      fee: Object.assign({}, c.FEE),
      lotSize: c.LOT_SIZE,
      limitPct: c.LIMIT_PCT,
      limitPct20: c.LIMIT_PCT_20,
    };
  }

  /* ═══════════════ 报文解析 + 分发 ═══════════════ */

  _onMessage(sess, text) {
    const conn = sess.conn;
    let msg = null;
    try { msg = JSON.parse(text); } catch (err) { msg = null; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return this._error(conn, 'BAD_REQUEST', '报文不是合法的 JSON 对象');
    }
    const t = typeof msg.t === 'string' ? msg.t : '';
    const reqId = typeof msg.reqId === 'string' ? msg.reqId : undefined;

    if (!sess.limiter.allow()) {
      return this._error(conn, 'RATE_LIMIT', `操作过于频繁（每秒最多 ${this.config.RATE_LIMIT_PER_SEC} 条），请稍后再试`, reqId);
    }

    const handler = this.routes[t];
    if (!handler) return this._error(conn, 'BAD_REQUEST', `未知消息类型：${t || '(空)'}`, reqId);

    try {
      handler(sess, msg, reqId);
    } catch (err) {
      this.log.error(`处理 ${t} 异常`, err && err.stack ? err.stack : err);
      this._error(conn, 'SERVER_ERROR', '服务端处理异常，请稍后再试', reqId);
    }
  }

  _buildRoutes() {
    const R = {};

    /* ───── 登录 / 断线重连 ───── */
    R['login'] = (sess, msg, reqId) => {
      const conn = sess.conn;
      const res = this.lobby.login({ nick: msg.nick, token: msg.token, avatar: msg.avatar, conn });
      if (!res.ok) return this._error(conn, res.code || 'BAD_REQUEST', res.msg || '登录失败', reqId);
      const p = res.player;
      this._reply(conn, reqId, {
        t: 'login_ok',
        token: p.token,
        serverTime: Date.now(),
        player: {
          id: p.id, nick: p.nick, avatar: p.avatar, elo: p.elo,
          tier: p.tier, wins: p.wins, losses: p.losses, games: p.games,
        },
        config: this._configPayload(),
      });
      const room = this.lobby.getRoomOf(p);
      if (room) {
        this.lobby.sendTo(p, { t: 'room:joined', room: room.toInfo(), you: { id: p.id } });
        room.resync(p.id);
      }
      this.lobby.broadcastRooms();
    };

    /* ───── 大厅 ───── */
    R['lobby:list'] = (sess, msg, reqId) => {
      this._reply(sess.conn, reqId, { t: 'lobby:rooms', rooms: this.lobby.listRooms() });
    };

    /* ───── 建房 ───── */
    R['room:create'] = (sess, msg, reqId) => {
      const p = this._needLogin(sess, reqId);
      if (!p) return;
      const modes = this.config.MODES || [];
      const mode = modes.find(m => m.id === msg.mode);
      if (!mode) return this._error(sess.conn, 'BAD_REQUEST', '非法的对战模式，可选：1v1 / ffa / team', reqId);
      const hardMax = Math.min(Number(this.config.MAX_PLAYERS) || 30, mode.maxPlayers);
      const maxPlayers = util.clamp(Math.round(Number(msg.maxPlayers) || mode.maxPlayers), 2, hardMax);
      const durationSec = (this.config.DURATIONS || []).some(d => d.sec === Number(msg.durationSec))
        ? Number(msg.durationSec) : this.config.DEFAULT_DURATION_SEC;
      const startCash = (this.config.START_CASH_OPTIONS || []).indexOf(Number(msg.startCash)) >= 0
        ? Number(msg.startCash) : this.config.DEFAULT_START_CASH;
      const room = this.lobby.createRoom(p, {
        mode: mode.id,
        name: typeof msg.name === 'string' ? msg.name : '',
        maxPlayers,
        durationSec,
        startCash,
        fillBots: msg.fillBots !== false,
        reqId,
      });
      if (!room) return this._error(sess.conn, 'SERVER_ERROR', '创建房间失败，请稍后再试', reqId);
    };

    /* ───── 加入房间 ───── */
    R['room:join'] = (sess, msg, reqId) => {
      const p = this._needLogin(sess, reqId);
      if (!p) return;
      const roomId = msg.roomId;
      if (!roomId) return this._error(sess.conn, 'BAD_REQUEST', '缺少房间号 roomId', reqId);
      const res = this.lobby.joinRoom(p, roomId, { reqId });
      if (!res.ok) return this._error(sess.conn, res.code, res.msg, reqId);
    };

    /* ───── 快速匹配 ───── */
    R['room:quick'] = (sess, msg, reqId) => {
      const p = this._needLogin(sess, reqId);
      if (!p) return;
      const modes = this.config.MODES || [];
      const mode = modes.find(m => m.id === msg.mode);
      if (!mode) return this._error(sess.conn, 'BAD_REQUEST', '非法的对战模式，可选：1v1 / ffa / team', reqId);
      /* 人数上限与「AI 补齐」必须透传：以前这里只传模式/时长/资金，
         玩家在大厅选的 30 人 + 关掉 AI 补齐 对快速匹配完全无效。 */
      const hardMax = Math.min(Number(this.config.MAX_PLAYERS) || 30, mode.maxPlayers);
      const wantMax = msg.maxPlayers != null && msg.maxPlayers !== ''
        ? util.clamp(Math.round(Number(msg.maxPlayers) || mode.maxPlayers), 2, hardMax)
        : 0;
      const res = this.lobby.quickMatch(p, {
        mode: mode.id,
        maxPlayers: wantMax,
        fillBots: msg.fillBots !== false,
        durationSec: msg.durationSec,
        startCash: msg.startCash,
        reqId,
      });
      if (!res.ok) return this._error(sess.conn, res.code || 'SERVER_ERROR', res.msg || '匹配失败', reqId);
    };

    /* ───── 离开房间 ───── */
    R['room:leave'] = (sess, msg, reqId) => {
      const p = this._needLogin(sess, reqId);
      if (!p) return;
      const room = this.lobby.getRoomOf(p);
      if (!room) return this._error(sess.conn, 'NOT_IN_ROOM', '你当前不在任何房间', reqId);
      this.lobby.leaveRoom(p);
      if (reqId) this._reply(sess.conn, reqId, { t: 'room:left', roomId: room.id });
    };

    /* ───── 准备 ───── */
    R['room:ready'] = (sess, msg, reqId) => {
      const room = this._needRoom(sess, reqId);
      if (!room) return;
      if (room.status !== WAITING) return this._error(sess.conn, 'ROOM_STARTED', '对局已开始，无法修改准备状态', reqId);
      room.setReady(sess.player.id, msg.ready !== false);
    };

    /* ───── 房主开局 ───── */
    /* ───── 房主移出成员 ───── */
    R['room:kick'] = (sess, msg, reqId) => {
      const room = this._needRoom(sess, reqId);
      if (!room) return;
      if (room.hostId !== sess.player.id) return this._error(sess.conn, 'NOT_HOST', '只有房主可以移出成员', reqId);
      const targetId = String(msg.playerId || '');
      if (!targetId || targetId === sess.player.id) {
        return this._error(sess.conn, 'BAD_REQUEST', '不能移出房主自己', reqId);
      }
      const seat = room.seatOf(targetId);
      if (!seat) return this._error(sess.conn, 'BAD_REQUEST', '该玩家不在本房间内', reqId);
      if (room.status !== WAITING) {
        return this._error(sess.conn, 'BAD_REQUEST', '对局已经开始，无法移出成员', reqId);
      }
      const target = seat.player;
      const nick = target.nick;
      try {
        this.lobby.leaveRoom(target);          // 内部会推 room:left + room:update + 房间列表
        if (typeof target.send === 'function') {
          target.send({ t: 'room:left', roomId: room.id, kicked: true, msg: `你已被房主移出房间（${room.name || room.id}）` });
        }
      } catch (err) {
        this.log && this.log.warn && this.log.warn('room:kick 异常', err && err.message);
        return this._error(sess.conn, 'SERVER_ERROR', '移出成员失败，请稍后再试', reqId);
      }
      this.log && this.log.info && this.log.info(`${sess.player.nick} 把 ${nick} 移出房间 ${room.id}`);
      this._reply(sess.conn, reqId, { t: 'room:kick', ok: true, playerId: targetId, nick });
    };

    R['room:start'] = (sess, msg, reqId) => {
      const room = this._needRoom(sess, reqId);
      if (!room) return;
      if (room.hostId !== sess.player.id) return this._error(sess.conn, 'NOT_HOST', '只有房主可以开始对局', reqId);
      if (room.status === COUNTDOWN || room.status === PLAYING) {
        return this._error(sess.conn, 'ROOM_STARTED', '对局已经开始了', reqId);
      }
      if (!room.canStart()) {
        return this._error(sess.conn, 'BAD_REQUEST', `人数不足，无法开局（当前 ${room.playerCount()} 人${room.fillBots ? '' : '，可开启 AI 补位'}）`, reqId);
      }
      if (!room.start()) return this._error(sess.conn, 'SERVER_ERROR', '开局失败，请稍后再试', reqId);
    };

    /* ───── 聊天 ───── */
    R['room:chat'] = (sess, msg, reqId) => {
      const room = this._needRoom(sess, reqId);
      if (!room) return;
      const text = String(msg.text == null ? '' : msg.text).trim().slice(0, MAX_CHAT_LEN);
      if (!text) return this._error(sess.conn, 'BAD_REQUEST', '消息内容不能为空', reqId);
      room.broadcast({
        t: 'chat',
        from: sess.player.id,
        nick: sess.player.nick,
        text,
        time: Date.now(),
        system: false,
      });
    };

    /* ───── K 线 ───── */
    R['kline:get'] = (sess, msg, reqId) => {
      const ctx = this._needPlaying(sess, reqId);
      if (!ctx) return;
      const { room } = ctx;
      const tf = ['1m', '5m', '15m', '1d'].indexOf(String(msg.tf)) >= 0 ? String(msg.tf) : '1d';
      const stockId = String(msg.stockId || '');
      if (!stockId) return this._error(sess.conn, 'BAD_REQUEST', '缺少股票代码 stockId', reqId);
      let bars = [];
      try { bars = room.market.getBars(stockId, tf, 240) || []; } catch (err) { bars = []; }
      if (!bars.length && !(this.config.STOCKS || []).some(s => s.id === stockId)) {
        return this._error(sess.conn, 'BAD_REQUEST', `股票代码不存在：${stockId}`, reqId);
      }
      this._reply(sess.conn, reqId, { t: 'kline', i: stockId, tf, bars });
    };

    /* ═════════ 运维控制台（人工宏观事件）═════════
       鉴权：THK_ADMIN_KEY（未设置时由 server.js 随机生成并写进 data/admin-key.txt）
       注意：这些消息**不需要登录**，也不需要加入房间——运营在控制台里就能投放；
       但必须持有密钥，且只在有进行中对局时生效。 */
    const adminKeyOk = (msg) => {
      const want = String(this.config.ADMIN_KEY || '');
      if (!want) return { ok: false, code: 'ADMIN_DISABLED', msg: '服务端未启用运维控制台（未设置 THK_ADMIN_KEY）' };
      const got = String((msg && msg.key) || '');
      if (got.length !== want.length) return { ok: false, code: 'ADMIN_DENIED', msg: '管理密钥不正确' };
      let diff = 0;
      for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
      return diff === 0 ? { ok: true } : { ok: false, code: 'ADMIN_DENIED', msg: '管理密钥不正确' };
    };

    /* 鉴权 + 拉取目录与实时快照 */
    R['admin:auth'] = (sess, msg, reqId) => {
      const a = adminKeyOk(msg);
      if (!a.ok) return this._error(sess.conn, a.code, a.msg, reqId);
      this._reply(sess.conn, reqId, this._adminState(Date.now()));
    };

    /* 投放事件 */
    R['admin:event'] = (sess, msg, reqId) => {
      const a = adminKeyOk(msg);
      if (!a.ok) return this._error(sess.conn, a.code, a.msg, reqId);
      /* 限流：同一个连接 1.5 秒内只能投一次，防手滑连点把盘面打爆 */
      const now = Date.now();
      if (sess._lastAdminAt && now - sess._lastAdminAt < 1500) {
        return this._error(sess.conn, 'RATE_LIMITED', '操作太快了，请稍后再试', reqId);
      }
      const rooms = this.lobby.playingRooms();
      const res = adminApi.apply(rooms, msg.eventId, {
        stockId: msg.stockId, sector: msg.sector, strength: msg.strength, ticks: msg.ticks,
      });
      if (!res.ok) return this._error(sess.conn, res.code || 'BAD_REQUEST', res.msg || '事件投放失败', reqId);
      sess._lastAdminAt = now;

      /* 广播给所有玩家：进资讯流 + 一条系统聊天（对局内的人立刻能看到） */
      const news = res.news;
      for (const room of rooms) {
        try {
          if (room.newsLog) { room.newsLog.unshift(news); if (room.newsLog.length > 60) room.newsLog.length = 60; }
          room.broadcast({ t: 'news', news });
          room.broadcast({ t: 'chat', from: 'system', nick: '系统', system: true, time: Date.now(),
            text: `${res.event.icon || '📢'}【${res.event.name}】${news.title}` });
        } catch (err) { /* 单个房间失败不影响其它 */ }
      }
      this.log && this.log.info && this.log.info(`[控制台] 投放「${res.event.name}」${msg.stockId || msg.sector || '全市场'} 影响 ${res.applied.length} 局`);
      /* 注意顺序：快照对象自带 t:'admin:state'，必须放在前面，否则会把消息类型覆盖掉 */
      this._reply(sess.conn, reqId, Object.assign({}, this._adminState(Date.now()), res, { t: 'admin:event' }));
    };

    /* 运行时控制：暂停/继续、调速、强制休市、跳到下一交易日 */
    R['admin:control'] = (sess, msg, reqId) => {
      const a = adminKeyOk(msg);
      if (!a.ok) return this._error(sess.conn, a.code, a.msg, reqId);
      let rooms = this.lobby.playingRooms();
      if (msg.roomId) {
        const one = this.lobby.rooms && this.lobby.rooms.get ? this.lobby.rooms.get(String(msg.roomId)) : null;
        rooms = one ? [one] : [];
      }
      if (!rooms.length) return this._error(sess.conn, 'NO_MATCH', '当前没有进行中的对局', reqId);
      const results = [];
      for (const room of rooms) {
        if (!room || typeof room.adminControl !== 'function') continue;
        let r;
        try { r = room.adminControl(String(msg.action || ''), { seconds: msg.seconds, minuteTicks: msg.minuteTicks, secondsPerMinute: msg.secondsPerMinute }); }
        catch (err) { r = { ok: false, msg: (err && err.message) || '控制失败' }; }
        if (r && r.ok === false) return this._error(sess.conn, 'BAD_REQUEST', r.msg || '控制失败', reqId);
        results.push(Object.assign({ roomId: room.id }, r));
      }
      this.log && this.log.info && this.log.info(`[控制台] 控制 ${msg.action} → ${results.length} 局`);
      this._reply(sess.conn, reqId, Object.assign({}, this._adminState(Date.now()), { t: 'admin:control', ok: true, action: msg.action, results }));
    };

    /* 只拉状态（控制台轮询） */
    R['admin:state'] = (sess, msg, reqId) => {
      const a = adminKeyOk(msg);
      if (!a.ok) return this._error(sess.conn, a.code, a.msg, reqId);
      this._reply(sess.conn, reqId, this._adminState(Date.now()));
    };

    /* ───── AI 投资顾问（服务端权威：能拿到内在价值/冲击/全场持仓）───── */
    R['ai:advice'] = (sess, msg, reqId) => {
      const ctx = this._needPlaying(sess, reqId);
      if (!ctx) return;
      const { room, seat } = ctx;
      const stockId = String(msg.stockId || '');
      try {
        if (!stockId) {
          return this._reply(sess.conn, reqId, advisor.marketView({ market: room.market, room, config: this.config }));
        }
        if (!(this.config.STOCKS || []).some(x => x.id === stockId)) {
          return this._error(sess.conn, 'BAD_REQUEST', `股票代码不存在：${stockId}`, reqId);
        }
        const a = advisor.advise({ market: room.market, seat, room, stockId, config: this.config });
        if (!a) return this._error(sess.conn, 'BAD_REQUEST', '无法诊断该标的', reqId);
        this._reply(sess.conn, reqId, a);
      } catch (err) {
        this.log && this.log.warn && this.log.warn('ai:advice 异常', err && err.message);
        this._error(sess.conn, 'SERVER_ERROR', 'AI 诊断失败，请稍后再试', reqId);
      }
    };

    /* ───── 下单 ───── */
    R['order:place'] = (sess, msg, reqId) => {
      const ctx = this._needPlaying(sess, reqId);
      if (!ctx) return;
      const { room, seat } = ctx;
      let r = null;
      try {
        r = room.engine.placeOrder(seat.pf, {
          stockId: msg.stockId,
          side: msg.side,
          type: msg.type,
          price: msg.price,
          qty: msg.qty,
          reqId: reqId || null,
        });
      } catch (err) {
        this.log.error('placeOrder 异常', err && err.stack ? err.stack : err);
        r = null;
      }
      if (!r) r = { ok: false, msg: '下单失败，请稍后再试', order: null };
      this._reply(sess.conn, reqId, {
        t: 'order:ack',
        ok: !!r.ok,
        orderId: (r.order && r.order.id) || null,
        msg: r.msg || (r.ok ? '委托已提交' : '委托被拒绝'),
      });
      if (r.ok) room.pushAccount(sess.player.id, true);
    };

    /* ───── 撤单 ───── */
    R['order:cancel'] = (sess, msg, reqId) => {
      const ctx = this._needPlaying(sess, reqId);
      if (!ctx) return;
      const { room, seat } = ctx;
      const orderId = String(msg.orderId || '');
      if (!orderId) return this._error(sess.conn, 'BAD_REQUEST', '缺少委托编号 orderId', reqId);
      let r = null;
      try { r = room.engine.cancelOrder(seat.pf, orderId); }
      catch (err) {
        this.log.error('cancelOrder 异常', err && err.stack ? err.stack : err);
        r = null;
      }
      if (!r) r = { ok: false, msg: '撤单失败，请稍后再试' };
      /* 约定（与 placeOrder 对称）：撤单成功/失败一律回 order:ack，不再回 error。
         客户端（tables.js / trade.js）只监听 order:ack 弹提示。 */
      if (!r.ok) {
        return this._reply(sess.conn, reqId, {
          t: 'order:ack',
          ok: false,
          orderId: (r.order && r.order.id) || orderId,
          msg: r.msg || '撤单失败：委托不存在或已结束',
        });
      }
      this._reply(sess.conn, reqId, { t: 'order:ack', ok: true, orderId, msg: r.msg || '已撤单' });
      room.pushAccount(sess.player.id, true);
    };

    /* ───── 心跳（回带 reqId，便于客户端 request('ping') 对账） ───── */
    R['ping'] = (sess, msg, reqId) => {
      const ts = Number(msg.ts);
      this._reply(sess.conn, reqId, {
        t: 'pong',
        ts: Number.isFinite(ts) ? ts : Date.now(),
        serverTime: Date.now(),
        rtt: 0,
      });
    };

    return R;
  }
}

module.exports = Net;
module.exports.Net = Net;
