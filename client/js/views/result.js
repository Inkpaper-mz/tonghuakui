/* ═══════════════════════════════════════════════════════════════
   同花亏 · views/result.js —— 对局结算页（含 Canvas 资产曲线对比图）
   接口（DESIGN.md §4.4）：renderResult(ctx) -> { destroy() }
   数据来源：state.result（main.js 存的是整条 game:over 报文）
   ═══════════════════════════════════════════════════════════════ */

import { el, clear, fmtMoney, fmtNum, fmtPct, signClass } from '../util.js';

const AVATARS = ['🐂', '🐻', '🐷', '🐔', '🦆', '🐸', '🐵', '🐯', '🦊', '🐼', '🦄', '👽'];
/* 「我」固定用这个红（见 drawEquity），所以它不能出现在别人的配色里 */
const ME_COLOR = '#e5343d';
/**
 * 第 i 条线的颜色：黄金角撒色相，30 人也不会撞色。
 * 以前是 8 色循环，30 人局里每 8 个人就重色一次，且 0 号色与「我」的红完全相同。
 */
function lineColor(i) {
  let hue = (i * 137.508) % 360;
  if (hue < 18 || hue > 342) hue = (hue + 40) % 360;   // 避开红色区，红留给「我」
  return `hsl(${hue.toFixed(0)},${52 + (i % 3) * 9}%,${44 + (i % 2) * 11}%)`;
}
const MEDALS = ['🥇', '🥈', '🥉'];

const raf = (typeof requestAnimationFrame === 'function')
  ? requestAnimationFrame
  : (fn) => setTimeout(fn, 16);

const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

/** 秒 → 'm:ss'（如 900 → '15:00'，225 → '3:45'），用于资产曲线的对局进度轴 */
function fmtClock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + pad2(s % 60);
}

const avatarOf = (i) => AVATARS[((Number(i) || 0) % 12 + 12) % 12];

export function renderResult(ctx) {
  const root = ctx.root;
  clear(root);
  const S = ctx.state;
  const offs = [];
  let destroyed = false;

  const wrap = el('div', { class: 'v-result' });
  root.appendChild(wrap);

  /* ───────── 数据解析（兼容 state.result = 报文 或 报文.result） ───────── */
  function readData() {
    const raw = S.result;
    if (!raw) return { R: null, teams: null, list: [] };
    const R = raw.result && Array.isArray(raw.result.rank) ? raw.result
      : (Array.isArray(raw.rank) ? raw : null);
    const teams = (raw && raw.teams) || (R && R.teams) || null;
    const list = (R && Array.isArray(R.rank)) ? R.rank.slice() : [];
    return { R, teams, list };
  }

  /* ───────── 绘制资产曲线 ───────── */
  function drawEquity(canvas, list, match) {
    const g = canvas.getContext && canvas.getContext('2d');
    if (!g) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const W = Math.max(320, canvas.clientWidth || 640);
    const H = Math.max(160, canvas.clientHeight || 240);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const meId = (S.player && S.player.id) || null;
    const series = list.map((r, i) => ({
      name: r.nick,
      /* 只有「我」这一条是红粗线：以前用 !r.isBot，多个真人会同时被当成自己 */
      isMe: meId ? r.id === meId : false,
      color: lineColor(i),
      pts: (r.equity || []).filter((p) => Array.isArray(p) && Number.isFinite(Number(p[1]))),
      assets: r.assets,
    })).filter((s) => s.pts.length > 1);
    if (!series.length) {
      g.fillStyle = '#8a8a8a';
      g.font = '12px sans-serif';
      g.fillText('暂无资产曲线数据', 12, 20);
      return;
    }

    const padL = 62, padR = 12, padT = 26, padB = 26;
    const pw = W - padL - padR, ph = H - padT - padB;

    /* ⚠️ 时间基归一化：服务端 equity 的 t 是**绝对毫秒时间戳**（vtime，形如 1792201140000），
       而演示数据是「距开局毫秒数」。以前直接用 t / maxT 当横坐标，绝对时间戳下
       所有点都会落到横轴最右端的极小一段里 —— 30 人局的资产曲线就是这么变成一条贴右边的竖线的。
       这里统一减掉最小时间戳，两种时间基都能正确铺满横轴。 */
    let min = Infinity, max = -Infinity, minT = Infinity, maxT = -Infinity;
    for (const s of series) {
      for (const p of s.pts) {
        const v = Number(p[1]);
        if (v < min) min = v;
        if (v > max) max = v;
        const t = Number(p[0]);
        if (Number.isFinite(t)) {
          if (t < minT) minT = t;
          if (t > maxT) maxT = t;
        }
      }
    }
    if (!Number.isFinite(minT) || !Number.isFinite(maxT)) { minT = 0; maxT = 1; }
    const tSpan = Math.max(1, maxT - minT);
    const start = (series[0] && series[0].pts[0] && Number(series[0].pts[0][1])) || min;
    min = Math.min(min, start); max = Math.max(max, start);
    const span = Math.max(1, max - min);
    min -= span * 0.08; max += span * 0.08;

    const X = (t) => padL + (Math.min(tSpan, Math.max(0, (Number(t) || minT) - minT)) / tSpan) * pw;
    const Y = (v) => padT + (1 - (v - min) / (max - min)) * ph;

    /* 背景 + 网格 */
    g.fillStyle = S.ui && S.ui.dark ? '#1a2029' : '#ffffff';
    g.fillRect(padL, padT, pw, ph);
    g.strokeStyle = S.ui && S.ui.dark ? '#2a3341' : '#e3e8ee';
    g.lineWidth = 1;
    g.font = '11px "Microsoft YaHei",sans-serif';
    g.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = min + ((max - min) * i) / 4;
      const y = Math.round(Y(v)) + 0.5;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + pw, y); g.stroke();
      g.fillStyle = S.ui && S.ui.dark ? '#a9b0bc' : '#8a8a8a';
      g.textAlign = 'right';
      g.fillText(fmtMoney(v), padL - 6, y);
    }
    /* X 轴 = 对局进度（0:00 → 整局时长），不是被四舍五入截断的秒数 */
    const elapsedSec = Math.max(1, Math.round(tSpan / 1000));
    const durSec = (match && Number(match.durationSec)) || 0;
    const axisSec = (durSec && Math.abs(elapsedSec - durSec) <= Math.max(2, durSec * 0.02)) ? durSec : elapsedSec;
    for (let i = 0; i <= 4; i++) {
      const x = Math.round(padL + (pw * i) / 4) + 0.5;
      g.beginPath(); g.moveTo(x, padT); g.lineTo(x, padT + ph); g.stroke();
      g.fillStyle = S.ui && S.ui.dark ? '#a9b0bc' : '#8a8a8a';
      g.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
      g.fillText(fmtClock((axisSec * i) / 4), x, padT + ph + 12);
    }
    g.textAlign = 'right';
    g.fillStyle = S.ui && S.ui.dark ? '#6b7480' : '#9aa5b1';
    g.fillText('对局进度', padL + pw, padT + ph + 24);
    /* 边框 */
    g.strokeStyle = S.ui && S.ui.dark ? '#2a3341' : '#c3ccd6';
    g.strokeRect(padL + 0.5, padT + 0.5, pw - 1, ph - 1);

    /* 初始资金基线 */
    g.save();
    g.setLineDash([4, 4]);
    g.strokeStyle = '#9aa5b1';
    g.beginPath(); g.moveTo(padL, Y(start)); g.lineTo(padL + pw, Y(start)); g.stroke();
    g.restore();

    /* 先画别人（细线），自己的最后画（红色粗线） */
    const ordered = series.filter((s) => !s.isMe).concat(series.filter((s) => s.isMe));
    for (const s of ordered) {
      g.beginPath();
      s.pts.forEach((p, i) => {
        const x = X(p[0]), y = Y(Number(p[1]));
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.strokeStyle = s.isMe ? ME_COLOR : s.color;
      g.lineWidth = s.isMe ? 2.4 : 1.2;
      g.globalAlpha = s.isMe ? 1 : 0.85;
      g.stroke();
      g.globalAlpha = 1;
      const last = s.pts[s.pts.length - 1];
      g.fillStyle = s.isMe ? ME_COLOR : s.color;
      g.beginPath(); g.arc(X(last[0]), Y(Number(last[1])), s.isMe ? 3.2 : 2, 0, Math.PI * 2); g.fill();
    }

    /* 图例 */
    let lx = padL + 2;
    g.textAlign = 'left';
    /* 图例必须包含「我」（以前只取前 6 名，30 人局里自己排第 10 就完全找不到自己的线） */
    const legend = series.filter((s) => s.isMe)
      .concat(series.filter((s) => !s.isMe))
      .slice(0, 6);
    const LX = padL + pw - 4;
    for (const s of legend) {
      const label = (s.isMe ? '★ ' : '') + s.name;
      const w = g.measureText(label).width;
      if (lx + 18 + w > LX) break;                     // 放不下就不画，避免溢出到画布外
      g.fillStyle = s.isMe ? ME_COLOR : s.color;
      g.fillRect(lx, 10, 14, 3);
      g.fillStyle = S.ui && S.ui.dark ? '#e5e6eb' : '#1a1a1a';
      g.fillText(label, lx + 18, 12);
      lx += 18 + w + 16;
    }
  }

  /* ───────── 渲染 ───────── */
  function render() {
    if (destroyed) return;
    clear(wrap);
    const { R, teams, list } = readData();

    if (!list.length) {
      const empty = el('div', { class: 'v-result-empty' });
      empty.appendChild(el('div', { class: 'ico', text: '📭' }));
      empty.appendChild(el('div', { text: '还没有对局结算数据' }));
      empty.appendChild(el('div', { class: 'dim', text: '先在大厅开一局，或点下面的按钮直接开始' }));
      const b = el('button', { class: 'btn btn-lg btn-primary', text: '⚡ 快速匹配一局' });
      b.onclick = () => { ctx.net.send('room:quick', { mode: 'ffa', durationSec: 900, startCash: 1000000 }); ctx.go('lobby'); };
      empty.appendChild(b);
      wrap.appendChild(empty);
      return;
    }

    const me = list.find((r) => !r.isBot) || list[0];
    const champion = list[0];
    const myRank = list.indexOf(me) + 1;
    const championIsMe = champion === me;
    const match = S.match || {};

    /* ── 头部 ── */
    const hd = el('div', { class: 'v-res-hd' + (championIsMe ? ' champ' : '') });
    const hdL = el('div', { class: 'v-res-hd-l' });
    hdL.appendChild(el('div', { class: 'v-res-cup', text: championIsMe ? '🏆' : (MEDALS[myRank - 1] || '🎯') }));
    const hdTx = el('div', {});
    hdTx.appendChild(el('div', { class: 'v-res-title', text: championIsMe ? '恭喜夺冠！' : `本局第 ${myRank} 名` }));
    hdTx.appendChild(el('div', { class: 'v-res-sub dim', text: `${(R.reason === 'timeup' ? '时间到，自动结算' : R.reason === 'forfeit' ? '有人弃赛' : '房主结束了对局')}　·　冠军：${champion.nick}（${fmtPct(champion.returnPct)}）` }));
    hdL.appendChild(hdTx);
    hd.appendChild(hdL);

    const hdR = el('div', { class: 'v-res-hd-r' });
    const chip = (k, v, cls) => {
      const c = el('div', { class: 'v-res-chip' });
      c.appendChild(el('b', { class: cls || '', text: v }));
      c.appendChild(el('span', { class: 'dim', text: k }));
      return c;
    };
    hdR.appendChild(chip('对局模式', { '1v1': '1v1 单挑', ffa: '多人混战', team: '红蓝团战' }[match.mode || R.mode] || '多人混战'));
    hdR.appendChild(chip('时长', ((match.durationSec || 900) / 60) + ' 分钟'));
    hdR.appendChild(chip('初始资金', fmtMoney(match.startCash || 1000000)));
    hd.appendChild(hdR);
    wrap.appendChild(hd);

    /* ── 团队结果 ── */
    if (teams) {
      const t = el('div', { class: 'v-teams' });
      for (const key of ['red', 'blue']) {
        const d = teams[key];
        if (!d) continue;
        const box = el('div', { class: 'v-team v-team-' + key + (d.score ? ' win' : '') });
        box.appendChild(el('span', { class: 'v-team-name', text: key === 'red' ? '🔴 红队' : '🔵 蓝队' }));
        box.appendChild(el('b', { class: signClass(d.returnPct), text: fmtPct(d.returnPct) }));
        box.appendChild(el('span', { class: 'dim', text: d.score ? '胜' : '负' }));
        t.appendChild(box);
      }
      wrap.appendChild(t);
    }

    /* ── 我的指标大卡片 ── */
    const cards = el('div', { class: 'v-mycards' });
    const bigCard = (label, value, cls, sub) => {
      const c = el('div', { class: 'v-mycard' });
      c.appendChild(el('div', { class: 'v-mycard-lb dim', text: label }));
      c.appendChild(el('div', { class: 'v-mycard-v ' + (cls || ''), text: value }));
      if (sub) c.appendChild(el('div', { class: 'v-mycard-sub dim', text: sub }));
      return c;
    };
    cards.appendChild(bigCard('最终总资产', fmtMoney(me.assets), '', '元'));
    cards.appendChild(bigCard('收益率', fmtPct(me.returnPct), signClass(me.returnPct), '相对初始资金'));
    cards.appendChild(bigCard('最大回撤', fmtPct(me.maxDrawdown || 0), 'down', '峰值到谷底'));
    cards.appendChild(bigCard('成交次数', String(me.tradeCount || 0), '', '笔'));
    cards.appendChild(bigCard('累计手续费', fmtNum(me.feeTotal || 0, 2), '', '元'));
    cards.appendChild(bigCard('ELO 变化', (me.eloDelta > 0 ? '+' : '') + (me.eloDelta || 0), signClass(me.eloDelta), `当前 ${(S.player && S.player.elo) || '—'}`));
    wrap.appendChild(cards);

    /* ── 主体：名次榜 + 曲线 ── */
    const grid = el('div', { class: 'v-res-grid' });

    const tblPanel = el('div', { class: 'panel v-res-tbl' });
    const tblHd = el('div', { class: 'panel-hd' });
    tblHd.appendChild(el('span', { text: '最终名次' }));
    tblHd.appendChild(el('span', { class: 'hd-right dim', text: `共 ${list.length} 位选手` }));
    tblPanel.appendChild(tblHd);
    const tblBd = el('div', { class: 'panel-bd scroll' });
    const table = el('table', { class: 'tbl striped' });
    const thead = el('thead');
    const tr = el('tr');
    for (const [t, c] of [['名次', 'c'], ['选手', 'l'], ['段位', 'c'], ['最终资产', ''], ['收益率', ''], ['最大回撤', ''], ['成交', ''], ['手续费', ''], ['ELO', '']]) {
      tr.appendChild(el('th', { class: c, text: t }));
    }
    thead.appendChild(tr);
    table.appendChild(thead);
    const tb = el('tbody');
    list.forEach((r, i) => {
      const row = el('tr', { class: (r.isBot ? '' : 'sel') + (i === 0 ? ' champ-row' : '') });
      const cRank = el('td', { class: 'c' });
      cRank.appendChild(el('span', { class: 'v-medal' + (i === 0 ? ' gold' : ''), text: MEDALS[i] || String(i + 1) }));
      row.appendChild(cRank);
      const cName = el('td', { class: 'l' });
      cName.appendChild(el('span', { class: 'v-res-ava', text: avatarOf(r.avatar) }));
      cName.appendChild(el('span', { class: 'v-res-nick', text: r.nick }));
      if (!r.isBot) cName.appendChild(el('span', { class: 'tag tag-blue', text: '我' }));
      if (r.isBot) cName.appendChild(el('span', { class: 'tag', text: 'AI' }));
      row.appendChild(cName);
      row.appendChild(el('td', { class: 'c', text: r.tier || '—' }));
      row.appendChild(el('td', { class: 'num', text: fmtNum(r.assets, 2) }));
      row.appendChild(el('td', { class: 'num ' + signClass(r.returnPct), text: fmtPct(r.returnPct) }));
      row.appendChild(el('td', { class: 'num down', text: fmtPct(r.maxDrawdown || 0) }));
      row.appendChild(el('td', { class: 'num', text: String(r.tradeCount || 0) }));
      row.appendChild(el('td', { class: 'num', text: fmtNum(r.feeTotal || 0, 2) }));
      const d = el('td', { class: 'num ' + signClass(r.eloDelta) });
      d.textContent = (r.eloDelta > 0 ? '+' : '') + (r.eloDelta || 0);
      row.appendChild(d);
      tb.appendChild(row);
    });
    table.appendChild(tb);
    tblBd.appendChild(table);
    tblPanel.appendChild(tblBd);
    grid.appendChild(tblPanel);

    const chartPanel = el('div', { class: 'panel v-res-chart' });
    const chartHd = el('div', { class: 'panel-hd' });
    chartHd.appendChild(el('span', { text: '资产曲线对比' }));
    const lg = el('span', { class: 'hd-right v-lg' });
    lg.appendChild(el('i', { class: 'v-lg-line me' }));
    lg.appendChild(el('span', { class: 'dim', text: '自己（红色粗线）' }));
    lg.appendChild(el('i', { class: 'v-lg-line other' }));
    lg.appendChild(el('span', { class: 'dim', text: '其他选手' }));
    chartHd.appendChild(lg);
    chartPanel.appendChild(chartHd);
    const chartBd = el('div', { class: 'panel-bd v-chart-bd' });
    const canvas = el('canvas', { class: 'v-canvas' });
    chartBd.appendChild(canvas);
    chartPanel.appendChild(chartBd);
    grid.appendChild(chartPanel);

    wrap.appendChild(grid);

    /* ── 段位变化 ── */
    if (Array.isArray(R.tierChanges) && R.tierChanges.length) {
      const tc = el('div', { class: 'v-tierchanges' });
      for (const c of R.tierChanges) {
        tc.appendChild(el('span', { class: 'v-tierchange', text: `${c.id === me.id ? '你' : c.id}：${c.from} → ${c.to}（ELO ${c.elo}）` }));
      }
      wrap.appendChild(tc);
    }

    /* ── 底部按钮 ── */
    const ft = el('div', { class: 'v-res-ft' });
    const bAgain = el('button', { class: 'btn btn-lg btn-primary', text: '⚡ 再来一局' });
    bAgain.onclick = () => {
      ctx.net.send('room:quick', {
        mode: match.mode || 'ffa',
        durationSec: match.durationSec || 900,
        startCash: match.startCash || 1000000,
      });
      ctx.toast('正在重新匹配…', 'info');
    };
    const bLobby = el('button', { class: 'btn btn-lg', text: '🏛 返回大厅' });
    bLobby.onclick = () => ctx.go('lobby');
    const bHint = el('span', { class: 'dim v-res-hint', text: `结算数据已写入${(S.source === 'real') ? '服务端' : '本地状态'}，刷新页面不会丢失` });
    ft.appendChild(bAgain);
    ft.appendChild(bLobby);
    ft.appendChild(bHint);
    wrap.appendChild(ft);

    /* ── 画曲线（等布局完成） ── */
    raf(() => { if (!destroyed) drawEquity(canvas, list, match); });
  }

  /* 窗口尺寸变化时重画 */
  const onResize = () => {
    const c = wrap.querySelector ? wrap.querySelector('canvas') : null;
    const { list } = readData();
    if (c && list.length) drawEquity(c, list, S.match);
  };
  if (typeof window !== 'undefined') window.addEventListener('resize', onResize);

  const resultSig = () => (S.result && S.result.result && S.result.result.matchId) || (S.result && S.result.matchId) || '';
  let lastSig = resultSig();

  offs.push(ctx.on('game:over', () => { lastSig = resultSig(); render(); }));
  offs.push(ctx.onState(() => {
    /* 结算数据后到（例如 ?view=result 直接进入）时补渲染 */
    const sig = resultSig();
    if (sig !== lastSig) { lastSig = sig; render(); }
  }));

  render();

  return {
    destroy() {
      destroyed = true;
      if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
      for (const off of offs) { try { off(); } catch (e) { /* ignore */ } }
      offs.length = 0;
      clear(root);
    },
  };
}

export default renderResult;
