/* ═══════════════════════════════════════════════════════════════
   同花亏 · lobby.js —— 大厅 / 房间管理 / 匹配 / 断线重连 / 持久化接入
   （DESIGN.md §3.11）
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const EventEmitter = require('events');
const util = require('./util');
const eloApi = require('./elo');
const Room = require('./room');

const { WAITING, PLAYING, COUNTDOWN, FINISHED } = Room.STATUS;

const MAX_NICK = 12;

class Lobby extends EventEmitter {
  /**
   * @param {{config:object, store:object}} opts
   */
  constructor({ config, store } = {}) {
    super();
    this.config = config;
    this.store = store || null;

    /** Map<playerId, player> */
    this.players = new Map();
    /** Map<token, playerId> */
    this.tokens = new Map();
    /** Map<roomId, Room> */
    this.rooms = new Map();
    this.log = util.createLogger('lobby');
  }

  /* ═══════════════ 会话 ═══════════════ */

  get online() { return this.players.size; }

  _send(player, msg) {
    if (!player || !player.conn) return false;
    try { return !!player.conn.send(msg); } catch (err) { return false; }
  }

  sendTo(player, msg) { return this._send(player, msg); }

  _cleanNick(nick) {
    let s = String(nick == null ? '' : nick);
    s = s.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!s) return '';
    const chars = Array.from(s);
    if (chars.length > MAX_NICK) s = chars.slice(0, MAX_NICK).join('');
    return s;
  }

  /** 与在线玩家重名 → 自动加后缀，仍然 ≤ 12 字 */
  _uniqueNick(base) {
    const taken = new Set();
    for (const p of this.players.values()) taken.add(p.nick);
    if (!taken.has(base)) return base;
    const chars = Array.from(base);
    for (let i = 2; i < 200; i++) {
      const suffix = String(i);
      const head = chars.slice(0, Math.max(1, MAX_NICK - suffix.length)).join('');
      const name = head + suffix;
      if (!taken.has(name)) return name;
    }
    return chars.slice(0, MAX_NICK - 4).join('') + util.randInt(1000, 9999);
  }

  _makePlayer({ nick, avatar, elo, stored, token }) {
    const eloV = Math.round(Number.isFinite(Number(elo)) ? Number(elo) : (this.config.ELO_START || 1000));
    const player = {
      id: util.uid('p'),
      nick,
      avatar: Number.isFinite(Number(avatar)) ? ((Math.floor(Number(avatar)) % 12) + 12) % 12 : 0,
      token: token || util.uid('tk'),
      elo: eloV,
      tier: eloApi.tierOf(eloV),
      wins: stored ? Math.max(0, stored.wins | 0) : 0,
      losses: stored ? Math.max(0, stored.losses | 0) : 0,
      games: stored ? Math.max(0, stored.games | 0) : 0,
      conn: null,
      roomId: null,
      isBot: false,
      detachedAt: null,
      _detachTimer: null,
    };
    player.send = (msg) => this._send(player, msg);
    player.disconnect = () => this.detach(player);
    return player;
  }

  /**
   * 登录 / 断线重连（token 命中则恢复同一 player 与房间、持仓）
   * @returns {{ok:boolean, player?:object, resumed?:boolean, code?:string, msg?:string}}
   */
  login({ nick, token, avatar, conn } = {}) {
    const resumed = this._resume(token, conn);
    if (resumed) return { ok: true, player: resumed, resumed: true };

    const clean = this._cleanNick(nick);
    if (!clean) return { ok: false, code: 'BAD_REQUEST', msg: '昵称不能为空（1~12 个字）' };

    const finalNick = this._uniqueNick(clean);
    let stored = null;
    if (this.store) {
      try { stored = this.store.getPlayer(finalNick) || this.store.getPlayer(clean) || null; } catch (err) { stored = null; }
    }
    const player = this._makePlayer({
      nick: finalNick,
      avatar,
      elo: stored ? stored.elo : (this.config.ELO_START || 1000),
      stored,
      token: null,
    });
    this.players.set(player.id, player);
    this.tokens.set(player.token, player.id);
    this._attach(player, conn);
    this.log.info(`登录 ${player.nick}（${player.id}，ELO ${player.elo}${stored ? '，已读取存档' : '，新玩家'}）`);
    return { ok: true, player, resumed: false };
  }

  _resume(token, conn) {
    const tk = typeof token === 'string' && token ? token : null;
    if (!tk) return null;
    const pid = this.tokens.get(tk);
    const player = pid ? this.players.get(pid) : null;
    if (!player || player.isBot) return null;
    this._attach(player, conn);
    this.log.info(`断线重连 ${player.nick}（${player.id}）`);
    return player;
  }

  _attach(player, conn) {
    if (player._detachTimer) { clearTimeout(player._detachTimer); player._detachTimer = null; }
    player.detachedAt = null;
    if (player.conn && player.conn !== conn) {
      const old = player.conn;
      try { if (old._sess) old._sess.player = null; } catch (err) { /* ignore */ }
      try { old.close(4000, 'replaced'); } catch (err) { /* ignore */ }
    }
    player.conn = conn || null;
    if (conn) {
      conn._sess = conn._sess || {};
      conn._sess.player = player;
    }
  }

  /** 掉线：保留席位 RECONNECT_GRACE_MS，期间对局继续（AI 不接管） */
  detach(playerOrId) {
    const player = typeof playerOrId === 'string' ? this.players.get(playerOrId) : playerOrId;
    if (!player || player.isBot) return false;
    try { if (player.conn && player.conn._sess) player.conn._sess.player = null; } catch (err) { /* ignore */ }
    player.conn = null;
    player.detachedAt = Date.now();
    if (player._detachTimer) clearTimeout(player._detachTimer);
    player._detachTimer = setTimeout(() => {
      player._detachTimer = null;
      this._expire(player);
    }, Math.max(1000, Number(this.config.RECONNECT_GRACE_MS) || 90000));
    return true;
  }

  /** 宽限期结束仍未重连 → 真正离开 */
  _expire(player) {
    if (player.conn) return;                       // 已重连
    const room = this.getRoomOf(player);
    if (room) {
      try { this.leaveRoom(player); } catch (err) { /* ignore */ }
    }
    this.players.delete(player.id);
    this.tokens.delete(player.token);
    this.log.info(`席位过期：${player.nick}（${player.id}）`);
  }

  /* ═══════════════ 房间 ═══════════════ */

  getRoomOf(player) {
    if (!player || !player.roomId) return null;
    return this.rooms.get(player.roomId) || null;
  }

  getRoom(roomId) { return this.rooms.get(roomId) || null; }

  listRooms() {
    const out = [];
    for (const room of this.rooms.values()) {
      if (room.status !== WAITING) continue;
      if (room.isFull()) continue;
      out.push(room.toLobbyRow());
    }
    out.sort((a, b) => b.playerCount - a.playerCount || String(a.id).localeCompare(String(b.id)));
    return out;
  }

  /** 房间列表变化 → 向仍在大厅里的玩家广播 */
  broadcastRooms() {
    const rooms = this.listRooms();
    for (const p of this.players.values()) {
      if (!p.conn || p.roomId) continue;
      this._send(p, { t: 'lobby:rooms', rooms });
    }
    return rooms;
  }

  _wireRoom(room) {
    room.on('changed', () => { this.broadcastRooms(); });
    room.on('empty', () => { this._destroyRoom(room); });
  }

  _destroyRoom(room) {
    if (!room || !this.rooms.has(room.id)) return;
    this.rooms.delete(room.id);
    try { room.destroy(); } catch (err) { /* ignore */ }
    this.broadcastRooms();
  }

  /**
   * @param {object} player
   * @param {{mode?:string, maxPlayers?:number, durationSec?:number, startCash?:number,
   *          fillBots?:boolean, name?:string, quick?:boolean, reqId?:string}} opts
   */
  createRoom(player, opts = {}) {
    if (!player) return null;
    if (this.getRoomOf(player)) this.leaveRoom(player);
    const mode = this._modeOf(opts.mode);
    const hardMax = Math.min(Number(this.config.MAX_PLAYERS) || 30, mode.maxPlayers);
    const maxPlayers = Math.max(2, Math.min(hardMax, Math.round(Number(opts.maxPlayers) || mode.maxPlayers)));
    const room = new Room({
      id: util.uid('r'),
      name: String(opts.name || '').trim() || `${player.nick}的房`,
      mode: mode.id,
      maxPlayers,
      durationSec: this._durationOf(opts.durationSec),
      startCash: this._cashOf(opts.startCash),
      fillBots: opts.fillBots !== false,
      fillTo: Math.max(0, Math.round(Number(opts.fillTo) || 0)),
      quick: opts.quick === true,
      lobby: this,
      config: this.config,
    });
    this.rooms.set(room.id, room);
    this._wireRoom(room);
    this.joinRoom(player, room.id, { reqId: opts.reqId });
    this.broadcastRooms();
    this.log.info(`建房 ${room.id}（${room.mode} ${room.maxPlayers}人 ${room.durationSec}s ${room.startCash}元，房主 ${player.nick}）`);
    return room;
  }

  _modeOf(mode) {
    const list = this.config.MODES || [];
    const id = String(mode || 'ffa');
    return list.find(m => m.id === id) || list.find(m => m.id === 'ffa') ||
      { id: 'ffa', name: '多人混战', maxPlayers: Number(this.config.MAX_PLAYERS) || 30, minPlayers: 2 };
  }

  _durationOf(sec) {
    const list = this.config.DURATIONS || [];
    const n = Number(sec);
    return list.some(d => d.sec === n) ? n : (this.config.DEFAULT_DURATION_SEC || 900);
  }

  _cashOf(cash) {
    const list = this.config.START_CASH_OPTIONS || [];
    const n = Number(cash);
    return list.indexOf(n) >= 0 ? n : (this.config.DEFAULT_START_CASH || 1000000);
  }

  /**
   * @returns {{ok:boolean, room?:object, code?:string, msg?:string, already?:boolean}}
   */
  joinRoom(player, roomId, opts = {}) {
    if (!player) return { ok: false, code: 'NOT_LOGGED_IN', msg: '请先登录' };
    const room = this.rooms.get(String(roomId || ''));
    if (!room) return { ok: false, code: 'ROOM_NOT_FOUND', msg: '房间不存在或已解散' };
    const cur = this.getRoomOf(player);
    if (cur && cur !== room) this.leaveRoom(player);
    if (cur === room && room.seats.has(player.id)) {
      return { ok: true, room, already: true };
    }
    if (room.status === PLAYING || room.status === COUNTDOWN) {
      return { ok: false, code: 'ROOM_STARTED', msg: '该房间已开局' };
    }
    if (room.isFull()) return { ok: false, code: 'ROOM_FULL', msg: '房间已满' };
    if (!room.addPlayer(player)) return { ok: false, code: 'ROOM_FULL', msg: '房间已满' };

    const joined = { t: 'room:joined', room: room.toInfo(), you: { id: player.id } };
    if (opts.reqId) joined.reqId = opts.reqId;
    this._send(player, joined);
    room.broadcast({ t: 'room:update', room: room.toInfo() });
    this.broadcastRooms();

    /* 快速匹配：满员立即开局，否则等 QUICK_MATCH_WAIT_MS 用 AI 补齐 */
    if (room.quick) this._armQuick(room);
    return { ok: true, room };
  }

  /**
   * 快速匹配：优先加入等待中的同模式房间，否则新建（用 AI 补齐开局）
   */
  quickMatch(player, opts = {}) {
    const mode = this._modeOf(opts.mode);
    let room = null;
    for (const r of this.rooms.values()) {
      if (r.mode !== mode.id) continue;
      if (r.status !== WAITING) continue;
      if (r.isFull()) continue;
      room = r;
      break;
    }
    if (room) {
      room.quick = true;
      const res = this.joinRoom(player, room.id, { reqId: opts.reqId });
      if (!res.ok) return res;
    } else {
      /* 玩家显式给了人数上限就按他的来（以及按这个人数补齐 AI）；
         没给才用默认填充目标（QUICK_MATCH_FILL，避免一局塞 29 个机器人）。 */
      const asked = Math.round(Number(opts.maxPlayers) || 0);
      const wantMax = mode.id === '1v1' ? 2
        : (asked >= 2 ? Math.min(mode.maxPlayers, asked) : Math.min(mode.maxPlayers, Number(this.config.QUICK_MATCH_FILL) || 8));
      room = this.createRoom(player, {
        name: '快速匹配',
        mode: mode.id,
        maxPlayers: wantMax,
        fillTo: wantMax,
        durationSec: opts.durationSec,
        startCash: opts.startCash,
        fillBots: opts.fillBots !== false,
        quick: true,
        reqId: opts.reqId,
      });
      if (!room) return { ok: false, code: 'SERVER_ERROR', msg: '创建快速匹配房间失败' };
    }
    this._armQuick(room);
    return { ok: true, room };
  }

  _armQuick(room) {
    if (!room || room.quick !== true) return;
    if (room._quickTimer) { clearTimeout(room._quickTimer); room._quickTimer = null; }
    if (room.status !== WAITING) return;
    if (room.isFull()) { room.start(); return; }
    room._quickTimer = setTimeout(() => {
      room._quickTimer = null;
      if (room.status !== WAITING) return;
      if (room.canStart()) room.start();
      else if (!room.fillBots && room.seats.size >= 1) {
        /* 玩家主动关掉了「AI 补齐」→ 继续等真人，但要明确告知，不要静默卡住 */
        if (!room._waitNotice) {
          room._waitNotice = true;
          try {
            room.broadcast({
              t: 'chat', from: 'system', nick: '系统',
              text: '已关闭「AI 补齐」，正在等待真人玩家加入…（房主可随时点开始对局）',
              time: Date.now(), system: true,
            });
          } catch (e) { /* ignore */ }
        }
      } else if (room.seats.size === 0) this._destroyRoom(room);
    }, Math.max(1000, Number(this.config.QUICK_MATCH_WAIT_MS) || 5000));
  }

  /** 离开房间（对局中离开 = 认输弃赛） */
  /** 正在进行（含倒计时）的对局房间，供运维控制台投放事件 */
  playingRooms() {
    const out = [];
    for (const r of this.rooms.values()) {
      if (r && (r.status === PLAYING || r.status === COUNTDOWN)) out.push(r);
    }
    return out;
  }

  leaveRoom(player) {
    if (!player) return false;
    const room = this.getRoomOf(player);
    if (!room) { player.roomId = null; return false; }
    try { room.removePlayer(player.id); }
    catch (err) { this.log.warn('removePlayer 失败', err && err.message); }
    player.roomId = null;
    this._send(player, { t: 'room:left', roomId: room.id });
    if (room.isEmpty()) this._destroyRoom(room);
    else this.broadcastRooms();
    this.broadcastRooms();
    return true;
  }

  /* ═══════════════ 结算落库 ═══════════════ */

  /** ELO 已在 Room.finish 里算好；这里只负责持久化 */
  recordResult(room, result) {
    if (!this.store || !result) return null;
    const players = (result.rank || []).map(r => ({
      id: r.id,
      nick: r.nick,
      isBot: !!r.isBot,
      rank: r.rank,
      eloBefore: Math.round(Number(r.eloBefore) || 0),
      eloAfter: Math.round(Number(r.eloAfter) || 0),
      delta: Math.round(Number(r.eloDelta) || 0),
      returnPct: Number(r.returnPct) || 0,
      assets: Number(r.assets) || 0,
    }));
    let rec = null;
    try {
      rec = this.store.recordMatch({
        id: result.matchId,
        mode: room ? room.mode : 'ffa',
        endedAt: Date.now(),
        reason: result.reason,
        players,
      });
    } catch (err) {
      this.log.warn('recordMatch 失败', err && err.message);
    }
    /* upsertPlayer 写入绝对值（不是增量），与 recordMatch 结果一致，不会重复计数 */
    for (const r of players) {
      if (r.isBot || !r.nick) continue;
      const p = this._findPlayerByNick(r.nick);
      try {
        this.store.upsertPlayer({
          nick: r.nick,
          elo: p ? p.elo : r.eloAfter,
          tier: p ? p.tier : eloApi.tierOf(r.eloAfter),
          wins: p ? p.wins : undefined,
          losses: p ? p.losses : undefined,
          games: p ? p.games : undefined,
        });
      } catch (err) {
        this.log.warn('upsertPlayer 失败', err && err.message);
      }
    }
    return rec;
  }

  _findPlayerByNick(nick) {
    for (const p of this.players.values()) if (p.nick === nick) return p;
    return null;
  }

  /* ═══════════════ 关闭 ═══════════════ */

  closeAll() {
    for (const room of Array.from(this.rooms.values())) {
      try { room.destroy(); } catch (err) { /* ignore */ }
    }
    this.rooms.clear();
    for (const p of this.players.values()) {
      if (p._detachTimer) { clearTimeout(p._detachTimer); p._detachTimer = null; }
    }
    this.players.clear();
    this.tokens.clear();
  }
}

module.exports = Lobby;
module.exports.Lobby = Lobby;
