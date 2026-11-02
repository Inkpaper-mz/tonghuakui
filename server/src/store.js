/* ═══════════════════════════════════════════════════════════════
   同花亏 · 持久化（零依赖）
   ─ data/store.json：{ version, players:{}, matches:[] }
   ─ 原子写 + 防抖 1s（unref）；close() 强制落盘
   ─ 文件损坏时回落空数据，绝不崩
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const util = require('./util');
const { tierOf } = require('./elo');
const defaultConfig = require('./config');

const VERSION = 1;
const MAX_MATCHES = 200;
const SAVE_DEBOUNCE_MS = 1000;

function emptyData() {
  return { version: VERSION, players: {}, matches: [] };
}

function num(v, fallback = 0) {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

function normalizePlayer(p, nick) {
  const src = (p && typeof p === 'object') ? p : {};
  const name = String(nick || src.nick || '').slice(0, 24);
  const elo = Math.round(num(src.elo, num(defaultConfig.ELO_START, 1000)));
  return {
    nick: name,
    elo,
    tier: String(src.tier || tierOf(elo)),
    wins: Math.max(0, Math.round(num(src.wins, 0))),
    losses: Math.max(0, Math.round(num(src.losses, 0))),
    games: Math.max(0, Math.round(num(src.games, 0))),
    best: Math.round(num(src.best, elo)),
    lastSeen: Math.round(num(src.lastSeen, Date.now())),
  };
}

class Store {
  /**
   * @param {string} file data/store.json 的绝对路径
   */
  constructor(file) {
    this.file = file;
    this.data = emptyData();
    this._timer = null;
    this._closed = false;
    this._dirty = false;
    this.load();
  }

  /* ───────── 读写 ───────── */

  load() {
    let raw = null;
    try {
      raw = util.readJsonSync(this.file, null);
    } catch {
      raw = null;
    }
    if (!raw || typeof raw !== 'object') {
      this.data = emptyData();
      return this.data;
    }
    try {
      const players = {};
      const src = (raw.players && typeof raw.players === 'object') ? raw.players : {};
      for (const nick of Object.keys(src)) {
        if (!nick) continue;
        const p = normalizePlayer(src[nick], nick);
        p.nick = String(src[nick] && src[nick].nick || nick).slice(0, 24);
        players[p.nick] = p;
      }
      const matches = Array.isArray(raw.matches) ? raw.matches.filter(m => m && typeof m === 'object').slice(-MAX_MATCHES) : [];
      this.data = { version: num(raw.version, VERSION), players, matches };
    } catch {
      this.data = emptyData();
    }
    return this.data;
  }

  /** 立即落盘（同步、原子写） */
  saveNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._dirty = false;
    try {
      util.atomicWriteSync(this.file, JSON.stringify(this.data, null, 2));
      return true;
    } catch {
      return false;
    }
  }

  /** 防抖 1s 落盘 */
  save() {
    if (this._closed) return;
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._closed) return;
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
    if (this._timer.unref) this._timer.unref();
  }

  /** 强制落盘并停止定时器 */
  close() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._dirty) this.saveNow();
    this._closed = true;
    return true;
  }

  /* ───────── 玩家 ───────── */

  getPlayer(nick) {
    const key = String(nick || '').slice(0, 24);
    if (!key) return null;
    const p = this.data.players[key];
    return p ? { ...p } : null;
  }

  /**
   * 创建或更新玩家
   * @param {{nick:string, elo?:number, tier?:string, wins?:number, losses?:number, games?:number, best?:number, lastSeen?:number, touch?:boolean}} input
   */
  upsertPlayer(input = {}) {
    const nick = String(input.nick || '').slice(0, 24);
    if (!nick) return null;
    const cur = this.data.players[nick];
    const base = cur ? { ...cur } : {
      nick,
      elo: num(defaultConfig.ELO_START, 1000),
      tier: tierOf(num(defaultConfig.ELO_START, 1000)),
      wins: 0,
      losses: 0,
      games: 0,
      best: num(defaultConfig.ELO_START, 1000),
      lastSeen: Date.now(),
    };
    if (input.elo !== undefined) base.elo = Math.round(num(input.elo, base.elo));
    if (input.wins !== undefined) base.wins = Math.max(0, Math.round(num(input.wins, base.wins)));
    if (input.losses !== undefined) base.losses = Math.max(0, Math.round(num(input.losses, base.losses)));
    if (input.games !== undefined) base.games = Math.max(0, Math.round(num(input.games, base.games)));
    if (input.tier !== undefined && input.tier !== null && input.tier !== '') base.tier = String(input.tier);
    // 段位必须跟随 elo 变化（除非调用方显式指定）
    if (input.tier === undefined || input.tier === null || input.tier === '') base.tier = tierOf(base.elo);
    base.best = Math.round(num(input.best !== undefined ? input.best : base.best, base.elo));
    if (base.elo > base.best) base.best = base.elo;
    base.lastSeen = Math.round(num(input.lastSeen, Date.now()));
    base.nick = nick;
    // 保持游戏数 = 胜 + 负（若调用方没有显式给出）
    if (input.games === undefined && base.games < base.wins + base.losses) base.games = base.wins + base.losses;
    this.data.players[nick] = base;
    this.save();
    return { ...base };
  }

  /** 记录一场对局（并更新参与玩家的统计） */
  recordMatch(record = {}) {
    const rec = {
      id: String(record.id || record.matchId || ('m_' + Date.now())),
      mode: String(record.mode || 'ffa'),
      endedAt: Math.round(num(record.endedAt, Date.now())),
      reason: String(record.reason || 'timeup'),
      players: Array.isArray(record.players) ? record.players.map(p => ({
        id: p && p.id != null ? String(p.id) : '',
        nick: String(p && p.nick || ''),
        isBot: !!(p && p.isBot),
        rank: Math.round(num(p && p.rank, 0)),
        eloBefore: Math.round(num(p && p.eloBefore, 0)),
        eloAfter: Math.round(num(p && p.eloAfter, 0)),
        delta: Math.round(num(p && p.delta, 0)),
        returnPct: num(p && p.returnPct, 0),
        assets: num(p && p.assets, 0),
      })) : [],
    };
    this.data.matches.push(rec);
    if (this.data.matches.length > MAX_MATCHES) {
      this.data.matches.splice(0, this.data.matches.length - MAX_MATCHES);
    }

    for (const p of rec.players) {
      if (!p.nick || p.isBot) continue;
      const cur = this.data.players[p.nick];
      const elo = p.eloAfter > 0 ? p.eloAfter : (cur ? cur.elo : num(defaultConfig.ELO_START, 1000));
      const wins = (cur ? cur.wins : 0) + (p.rank === 1 ? 1 : 0);
      const losses = (cur ? cur.losses : 0) + (p.rank === 1 ? 0 : 1);
      const base = cur ? { ...cur } : { nick: p.nick, elo, tier: tierOf(elo), wins: 0, losses: 0, games: 0, best: elo, lastSeen: Date.now() };
      base.elo = elo;
      base.tier = tierOf(elo);
      base.wins = wins;
      base.losses = losses;
      base.games = (cur ? cur.games : 0) + 1;
      if (base.games < wins + losses) base.games = wins + losses;
      base.best = Math.max(num(base.best, elo), elo);
      base.lastSeen = Date.now();
      this.data.players[p.nick] = base;
    }
    this.save();
    return rec;
  }

  /* ───────── 排行 ───────── */

  leaderboard(n = 50) {
    const list = Object.values(this.data.players).map(p => {
      const games = Math.max(0, p.games || 0);
      const wins = Math.max(0, p.wins || 0);
      return {
        nick: p.nick,
        elo: Math.round(num(p.elo, 1000)),
        tier: p.tier || tierOf(p.elo),
        wins,
        losses: Math.max(0, p.losses || 0),
        games,
        best: Math.round(num(p.best, p.elo)),
        winRate: games > 0 ? Math.round((wins / games) * 1e4) / 1e4 : 0,
      };
    });
    list.sort((a, b) => b.elo - a.elo || b.wins - a.wins || a.nick.localeCompare(b.nick));
    const limit = Math.max(1, Math.min(500, Math.round(num(n, 50)) || 50));
    return list.slice(0, limit);
  }

  /** 最近对局（调试 / 结算页用） */
  recentMatches(n = 20) {
    const limit = Math.max(1, Math.min(MAX_MATCHES, Math.round(num(n, 20)) || 20));
    return this.data.matches.slice(-limit).map(m => ({ ...m }));
  }

  stats() {
    return {
      file: this.file,
      players: Object.keys(this.data.players).length,
      matches: this.data.matches.length,
      dirty: !!this._dirty,
    };
  }
}

module.exports = { Store, VERSION, MAX_MATCHES };
module.exports.default = Store;
