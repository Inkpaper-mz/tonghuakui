/* ═══════════════════════════════════════════════════════════════
   同花亏 · ELO 与段位（零依赖）
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const defaultConfig = require('./config');

const K_FACTOR = Number(defaultConfig.ELO_K) || 32;

/** 段位名（中文）。阈值取自 config.TIERS */
function tierOf(elo) {
  const E = Number(elo);
  const v = isFinite(E) ? E : Number(defaultConfig.ELO_START) || 1000;
  const tiers = defaultConfig.TIERS || [];
  for (const t of tiers) {
    if (v >= Number(t.min)) return t.name;
  }
  return tiers.length ? tiers[tiers.length - 1].name : '青铜';
}

/** 段位完整信息（含颜色） */
function tierInfo(elo) {
  const E = Number(elo);
  const v = isFinite(E) ? E : 1000;
  const tiers = defaultConfig.TIERS || [];
  for (const t of tiers) {
    if (v >= Number(t.min)) return { name: t.name, color: t.color, min: t.min };
  }
  return { name: '青铜', color: '#b07d4a', min: -1e9 };
}

/** 期望得分 */
function expectedScore(eloA, eloB) {
  const a = Number(eloA), b = Number(eloB);
  const ea = isFinite(a) ? a : 1000;
  const eb = isFinite(b) ? b : 1000;
  return 1 / (1 + Math.pow(10, (eb - ea) / 400));
}

/**
 * 单方分值变化（整数，K=32）
 * @param {number} eloA 本方 ELO
 * @param {number} eloB 对手 ELO
 * @param {number} scoreA 本方得分 1=胜 0.5=平 0=负
 * @returns {number} 本方 ELO 变化（整数，四舍五入）
 */
function eloDuel(eloA, eloB, scoreA) {
  const K = K_FACTOR;
  const s = Number(scoreA);
  const sA = !isFinite(s) ? 0.5 : s > 0.5 ? 1 : s < 0.5 ? 0 : 0.5;
  const e = expectedScore(eloA, eloB);
  const d = K * (sA - e);
  let r = Math.round(d);
  if (r === 0 && sA !== 0.5) r = d > 0 ? 1 : -1;   // 分出胜负时至少 ±1
  return r;
}

/**
 * 多人对局 ELO（两两配对求平均）
 * @param {Array<{id:string, elo:number, rank:number}>} results rank 从 1 开始
 * @returns {Map<string, number>} id → 整数分值变化
 */
function eloMulti(results) {
  const out = new Map();
  if (!Array.isArray(results) || !results.length) return out;
  const list = results.map(r => ({
    id: String(r && r.id),
    elo: isFinite(Number(r && r.elo)) ? Number(r.elo) : 1000,
    rank: Math.max(1, Math.round(Number(r && r.rank) || 1)),
  }));
  const n = list.length;
  if (n === 1) { out.set(list[0].id, 0); return out; }

  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const e = expectedScore(list[i].elo, list[j].elo);
      const s = list[i].rank < list[j].rank ? 1 : list[i].rank > list[j].rank ? 0 : 0.5;
      acc += s - e;
    }
    const delta = (K_FACTOR * acc) / (n - 1);
    // 非并列时避免 0 分变化（至少 ±1）
    const ri = list[i].rank;
    let d = Math.round(delta);
    if (d === 0) {
      const better = list.some(o => o.rank > ri);
      const worse = list.some(o => o.rank < ri);
      if (better && !worse) d = 1;
      else if (worse && !better) d = -1;
    }
    out.set(list[i].id, d);
  }
  return out;
}

module.exports = { tierOf, tierInfo, K_FACTOR, eloDuel, eloMulti, expectedScore };
module.exports.default = { tierOf, tierInfo, K_FACTOR, eloDuel, eloMulti, expectedScore };
