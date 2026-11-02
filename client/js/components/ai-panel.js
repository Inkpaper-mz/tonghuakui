/* ═══════════════════════════════════════════════════════════
   同花亏 · components/ai-panel.js —— AI 投资顾问面板（AI 诊股）
   接口：createAiPanel(host, ctx) → { update(), destroy() }

   数据全部来自服务端，客户端不做任何指标计算（PROTOCOL.md §2.5）：
     · 个股诊断  net.request('ai:advice', { stockId }, 'ai:advice', 8000)
                 → { t:'ai:advice', score, rating, ratingText, summary, fair, dev, dayPct,
                     breakdown{valuation,trend,momentum,volume,orderbook,risk},
                     signals[{k,v,dir}], risks[], position|null, suggestion }
     · 大盘观点  net.request('ai:advice', {}, 'ai:market', 8000)
                 → { t:'ai:market', summary, mood{id,text,desc}, index, breadth, sectors[], lines[], picks[] }

   要点：
   1. 骨架只建一次（行池预建），之后只改文本 / 宽度 / 类名 → 切标签页不闪。
   2. 打开「AI 诊股」页立即诊断一次；stockId 变化时自动重诊（比较上一次，不每 tick 请求）；
      面板可见时每 15s 自动刷新；destroy() 清掉定时器与全部订阅。
   3. 请求失败（不在对局中 / 超时 / 断线）→ 友好空态 + 重试按钮，不抛异常。
   ═══════════════════════════════════════════════════════════ */
import { el, clear, on, uid, clamp, fmtPrice, fmtPct, fmtTime, signClass } from '../util.js';
import { touch, patchUi, position } from '../store.js';

/* 六项分项评分（服务端字段名 → 中文名） */
const BREAKDOWN = [
  { k: 'valuation', t: '估值' },
  { k: 'trend',     t: '趋势' },
  { k: 'momentum',  t: '动量' },
  { k: 'volume',    t: '量能' },
  { k: 'orderbook', t: '盘口' },
  { k: 'risk',      t: '风险' },
];

/* 评级 → 评分环配色（A 股习惯：红=看多） */
const RING_CLS = { strong_buy: 'buy', buy: 'buy', hold: 'hold', reduce: 'weak', sell: 'weak' };
/* 评级 → 操作建议文字配色 */
const ACT_CLS = { strong_buy: 'up', buy: 'up', hold: 'hold', reduce: 'down', sell: 'down' };
/* 大盘情绪 → 徽章配色 */
const MOOD_CLS = { strong: 'up', warm: 'up', flat: 'flat', weak: 'down', panic: 'down' };
/* 涨跌方向 → 三角符号 */
const TRI = { 1: '▲', '-1': '▼', 0: '▸' };

/* 行池上限（超出部分服务端不会给，这里只是防御） */
const MAX_SIG = 8, MAX_RISK = 6, MAX_LINE = 6, MAX_SECTOR = 10, MAX_PICK = 6;

/* 服务端错误码 → 中文空态文案 */
const ERR_TEXT = {
  NOT_IN_ROOM: 'AI 诊股需要在对局中才能使用（当前不在房间）',
  NOT_PLAYING: 'AI 诊股需要在对局中才能使用（对局还没开始）',
  NOT_LOGGED_IN: 'AI 诊股需要先登录',
  BAD_REQUEST: '该标的暂时无法诊断，换一只有试试',
  RATE_LIMIT: '操作过于频繁，请稍后再试',
  SERVER_ERROR: 'AI 诊断失败，请稍后再试',
  OFFLINE: '网络未连接，请检查连接后重试',
};

function setText(node, s) {
  const t = (s === null || s === undefined) ? '' : String(s);
  if (node.textContent !== t) node.textContent = t;
}

/** 把任何失败（Error / 服务端 error 报文）转成一句人话 */
function friendly(err) {
  if (!err) return 'AI 服务暂不可用，请稍后重试';
  if (err.code) return ERR_TEXT[err.code] || err.msg || 'AI 服务返回错误，请稍后重试';
  const s = String(err.message || err);
  if (s.indexOf('超时') >= 0) return 'AI 服务响应超时，请重试';
  if (s.indexOf('断开') >= 0) return '网络连接已断开，重连后可重试';
  return s || 'AI 服务暂不可用，请稍后重试';
}

export function createAiPanel(host, ctx) {
  const state = ctx.state;
  const offs = [];
  clear(host);
  host.classList.add('ai-host');

  /* ───────── 组件内部状态 ───────── */
  let destroyed = false;
  let advice = null;            // 个股诊断原文（服务端权威）
  let market = null;            // 大盘观点原文
  let adviceErr = '', marketErr = '';
  let adviceTs = 0, marketTs = 0;
  let loadingA = false, loadingM = false;
  let lastStockId = null;
  let lastVisible = false;
  const pendingReq = new Map(); // reqId → 'advice' | 'market'
  const preErr = new Map();     // reqId → 服务端 error 报文转出的友好文案
  let reqA = null, reqM = null;

  /* ═══════════════════ 骨架（只建一次） ═══════════════════ */
  const wrap = el('div', { class: 'ai-wrap' });
  host.appendChild(wrap);

  const sub = (t) => el('div', { class: 'subhd ai-sub', text: t });
  const mkBtn = (t, cls) => el('button', { class: cls || 'btn btn-sm', type: 'button', text: t });
  function mkKv(k) {
    const v = el('span', { class: 'v num', text: '--' });
    return { v, el: el('div', { class: 'kv ai-stat' }, el('span', { class: 'k', text: k }), v) };
  }

  /* ───────── 左卡片：个股诊断 ───────── */
  const aName = el('b', { class: 'ai-name', text: '--' });
  const aCode = el('span', { class: 'ai-code dim', text: '' });
  const aTime = el('span', { class: 'ai-time dim', text: '尚未诊断' });
  const aReload = mkBtn('↻ 重新诊断');
  aReload.classList.add('ai-refresh');
  const aBd = el('div', { class: 'panel-bd pad ai-bd' });
  const cardA = el('div', { class: 'panel ai-card' },
    el('div', { class: 'panel-hd' },
      el('span', { class: 'ai-hd-t', text: 'AI 诊股 · 个股诊断' }), aName, aCode,
      el('span', { class: 'hd-right' }, aTime, aReload)),
    aBd);

  /* 状态条 / 空态 / 内容 */
  const aSpin = el('span', { class: 'ai-spin' });
  const aStTx = el('span', { class: 'ai-status-tx' });
  const aStRetry = mkBtn('重试');
  const aStatus = el('div', { class: 'ai-status hidden' }, aSpin, aStTx, aStRetry);

  const aEmTx = el('div', { class: 'ai-empty-tx', text: 'AI 诊股需要在对局中才能使用' });
  const aEmRetry = mkBtn('重试');
  const aEmpty = el('div', { class: 'empty ai-empty hidden' },
    el('span', { class: 'ico', text: '🤖' }), aEmTx, aEmRetry);

  const aContent = el('div', { class: 'ai-content' });
  aBd.appendChild(aStatus);
  aBd.appendChild(aEmpty);
  aBd.appendChild(aContent);

  /* ① 评分环 */
  const ringNum = el('div', { class: 'ai-ring-num', text: '--' });
  const ringRating = el('div', { class: 'ai-ring-rating', text: '--' });
  const ring = el('div', { class: 'ai-ring' }, el('div', { class: 'ai-ring-in' }, ringNum, ringRating));

  /* ② 一句话结论 + ③ 关键数据 */
  const aSummary = el('div', { class: 'ai-summary', text: '' });
  const stFair = mkKv('内在价值 fair');
  const stDev = mkKv('偏离 dev');
  const stDay = mkKv('当日 dayPct');
  const aDiag = el('div', { class: 'ai-diag' }, ring,
    el('div', { class: 'ai-diag-main' }, aSummary,
      el('div', { class: 'ai-stats' }, stFair.el, stDev.el, stDay.el)));

  /* ④ 六项分项评分 */
  const bks = BREAKDOWN.map((b) => {
    const fill = el('i');
    const bar = el('div', { class: 'ai-bar' }, fill);
    const val = el('span', { class: 'ai-bk-v num', text: '--' });
    return {
      k: b.k, fill, val,
      row: el('div', { class: 'ai-bk' },
        el('span', { class: 'ai-bk-k', text: b.t }), bar, val),
    };
  });
  const aBks = el('div', { class: 'ai-bks' }, bks.map((b) => b.row));

  /* ⑤ 判断依据（行池） */
  const sigs = [];
  for (let i = 0; i < MAX_SIG; i++) {
    const tri = el('span', { class: 'ai-tri' });
    const k = el('span', { class: 'ai-sig-k' });
    const v = el('span', { class: 'ai-sig-v' });
    sigs.push({ tri, k, v, row: el('div', { class: 'ai-sig hidden' }, tri, k, v) });
  }
  const aSigs = el('div', { class: 'ai-sigs' }, sigs.map((s) => s.row));

  /* ⑥ 风险提示（行池） */
  const risks = [];
  for (let i = 0; i < MAX_RISK; i++) {
    const t = el('span', { class: 'ai-risk-t' });
    risks.push({ t, row: el('div', { class: 'ai-risk hidden' }, el('span', { class: 'ai-risk-i', text: '⚠' }), t) });
  }
  const aRisks = el('div', { class: 'ai-risks' }, risks.map((r) => r.row));

  /* ⑦ 持仓建议 */
  const pHeld = mkKv('持仓'), pAvail = mkKv('可用'), pCost = mkKv('成本价'), pPnl = mkKv('浮动盈亏');
  const aPosGrid = el('div', { class: 'ai-pos-grid' }, pHeld.el, pAvail.el, pCost.el, pPnl.el);
  const aPosAdvice = el('div', { class: 'ai-pos-advice', text: '' });
  const aPosNone = el('div', { class: 'ai-pos-none dim', text: '当前未持有' });
  const aPos = el('div', { class: 'ai-pos' }, aPosGrid, aPosAdvice, aPosNone);

  /* ⑧ 操作建议 */
  const aActTx = el('div', { class: 'ai-act-text', text: '--' });
  const aActRange = el('div', { class: 'ai-act-line', text: '' });
  const aActSL = el('span', { class: 'ai-act-sl num', text: '--' });
  const aActTP = el('span', { class: 'ai-act-tp num', text: '--' });
  const aFill = el('button', { class: 'btn btn-sm btn-primary ai-fill', type: 'button', text: '按建议填单' });
  const aAct = el('div', { class: 'ai-act' }, aActTx, aActRange,
    el('div', { class: 'ai-act-row' }, aActSL, aActTP, aFill));

  /* 左卡片内容分栏：宽屏两列，窄屏一列（section 不得跨行拆开）
     排版：[评分环 + 结论] 独占一行 → [六项分项 | 依据+风险] → [持仓建议 | 操作建议] */
  const sec = (...kids) => el('div', { class: 'ai-sec' }, kids);
  aContent.className = 'ai-content ai-content-a';
  aContent.appendChild(el('div', { class: 'ai-sec ai-sec-wide' }, aDiag));
  aContent.appendChild(sec(sub('六项分项评分'), aBks));
  aContent.appendChild(sec(sub('判断依据'), aSigs, sub('风险提示'), aRisks));
  aContent.appendChild(sec(sub('持仓建议'), aPos));
  aContent.appendChild(sec(sub('操作建议'), aAct));

  /* ───────── 右卡片：大盘观点 ───────── */
  const mTime = el('span', { class: 'ai-time dim', text: '尚未刷新' });
  const mReload = el('button', { class: 'btn btn-sm ai-refresh', type: 'button', text: '↻ 刷新' });
  const mBd = el('div', { class: 'panel-bd pad ai-bd' });
  const cardM = el('div', { class: 'panel ai-card' },
    el('div', { class: 'panel-hd' },
      el('span', { class: 'ai-hd-t', text: 'AI 大盘观点' }),
      el('span', { class: 'hd-right' }, mTime, mReload)),
    mBd);

  const mSpin = el('span', { class: 'ai-spin' });
  const mStTx = el('span', { class: 'ai-status-tx' });
  const mStRetry = mkBtn('重试');
  const mStatus = el('div', { class: 'ai-status hidden' }, mSpin, mStTx, mStRetry);

  const mEmTx = el('div', { class: 'ai-empty-tx', text: 'AI 大盘观点需要在对局中才能使用' });
  const mEmRetry = mkBtn('重试');
  const mEmpty = el('div', { class: 'empty ai-empty hidden' },
    el('span', { class: 'ico', text: '📉' }), mEmTx, mEmRetry);

  const mContent = el('div', { class: 'ai-content' });
  mBd.appendChild(mStatus);
  mBd.appendChild(mEmpty);
  mBd.appendChild(mContent);

  /* ① 情绪徽章 */
  const moodText = el('div', { class: 'ai-mood-text', text: '--' });
  const moodDesc = el('div', { class: 'ai-mood-desc', text: '' });
  const mMood = el('div', { class: 'ai-mood' }, moodText, moodDesc);

  /* ② 摘要 */
  const mSummary = el('div', { class: 'ai-mkt-summary', text: '' });

  /* ③ 涨跌家数 */
  const bdItems = [['上涨', 'up'], ['下跌', 'down'], ['平盘', 'flat'], ['涨停', 'up'], ['跌停', 'down']]
    .map(([label, cls]) => {
      const v = el('span', { class: 'v num ' + cls, text: '--' });
      const row = el('div', { class: 'ai-bd-item' },
        el('span', { class: 'ai-sq ' + cls }), el('span', { class: 'k', text: label }), v);
      return { row, v };
    });
  const mBreadth = el('div', { class: 'ai-breadth' }, bdItems.map((b) => b.row));

  /* ④ 逐条观点（行池） */
  const lines = [];
  for (let i = 0; i < MAX_LINE; i++) {
    const t = el('span', { class: 'ai-line-t' });
    lines.push({ t, row: el('div', { class: 'ai-line hidden' }, el('span', { class: 'ai-line-i', text: '·' }), t) });
  }
  const mLines = el('div', { class: 'ai-lines' }, lines.map((l) => l.row));

  /* ⑤ 板块标签（标签池） */
  const sectorTags = [];
  for (let i = 0; i < MAX_SECTOR; i++) sectorTags.push(el('span', { class: 'tag hidden' }));
  const mSectors = el('div', { class: 'ai-sectors' }, sectorTags);

  /* ⑥ AI 关注标的（行池 + 事件委托） */
  const pickCols = [
    { t: '名称', cls: 'l' }, { t: '代码', cls: 'c' }, { t: '现价', cls: 'num' },
    { t: '涨跌', cls: 'num' }, { t: 'AI 分', cls: 'num' }, { t: '理由', cls: 'l' },
  ];
  const pickHead = el('tr', {}, pickCols.map((c) => el('th', { class: c.cls, text: c.t })));
  const pickBody = el('tbody');
  const picks = [];
  for (let i = 0; i < MAX_PICK; i++) {
    const cells = pickCols.map((c) => el('td', { class: c.cls }));
    const row = el('tr', { class: 'ai-pick hidden' }, cells);
    picks.push({ row, cells });
    pickBody.appendChild(row);
  }
  const picksTable = el('table', { class: 'tbl ai-picks' }, el('thead', {}, pickHead), pickBody);
  const picksBox = el('div', { class: 'ai-picks-box' }, picksTable);

  mContent.appendChild(mMood);
  mContent.appendChild(mSummary);
  mContent.appendChild(sub('涨跌家数'));
  mContent.appendChild(mBreadth);
  mContent.appendChild(sub('AI 观点'));
  mContent.appendChild(mLines);
  mContent.appendChild(sub('板块表现'));
  mContent.appendChild(mSectors);
  mContent.appendChild(sub('AI 关注标的（点击行切换标的）'));
  mContent.appendChild(picksBox);

  wrap.appendChild(cardA);
  wrap.appendChild(cardM);

  /* ═══════════════════ 渲染（只改文本 / 宽度 / 类名） ═══════════════════ */
  function renderAdvice() {
    const has = !!advice;
    aContent.classList.toggle('hidden', !has);
    aEmpty.classList.toggle('hidden', !(!has && !!adviceErr));
    if (!has) {
      if (adviceErr) setText(aEmTx, adviceErr);
      setText(aName, '--');
      setText(aCode, '');
      setText(aTime, '尚未诊断');
      aFill.disabled = true;
      return;
    }
    const a = advice;
    aFill.disabled = !a.suggestion;
    setText(aName, a.name || a.stockId || '--');
    setText(aCode, a.stockId || '');
    setText(aTime, adviceTs ? '更新于 ' + fmtTime(adviceTs) : '');

    /* ① 评分环 */
    const score = clamp(Math.round(Number(a.score) || 0), 0, 100);
    const ringCls = 'ai-ring ' + (RING_CLS[a.rating] || 'hold');
    if (ring.className !== ringCls) ring.className = ringCls;
    ring.style.setProperty('--ai-score', String(score));
    setText(ringNum, String(score));
    setText(ringRating, a.ratingText || a.rating || '--');

    /* ② 结论 + ③ 关键数据 */
    setText(aSummary, a.summary || '');
    setText(stFair.v, fmtPrice(a.fair));
    setText(stDev.v, fmtPct(a.dev));
    stDev.v.className = 'v num ' + signClass(a.dev);
    setText(stDay.v, fmtPct(a.dayPct));
    stDay.v.className = 'v num ' + signClass(a.dayPct);

    /* ④ 分项评分 */
    const bd = a.breakdown || {};
    for (const b of bks) {
      const v = clamp(Math.round(Number(bd[b.k]) || 0), 0, 100);
      const w = v + '%';
      if (b.fill.style.width !== w) b.fill.style.width = w;
      const cls = 'ai-bk ' + (v >= 60 ? 'hi' : v <= 40 ? 'lo' : 'mid');
      if (b.row.className !== cls) b.row.className = cls;
      setText(b.val, String(v));
    }

    /* ⑤ 判断依据 */
    const list = Array.isArray(a.signals) ? a.signals : [];
    sigs.forEach((s, i) => {
      const it = list[i];
      if (!it) { s.row.className = 'ai-sig hidden'; return; }
      const d = Number(it.dir) || 0;
      const cls = 'ai-sig ' + (d > 0 ? 'up' : d < 0 ? 'down' : 'flat');
      if (s.row.className !== cls) s.row.className = cls;
      setText(s.tri, TRI[String(d)] || TRI['0']);
      setText(s.k, it.k || '');
      setText(s.v, it.v || '');
    });

    /* ⑥ 风险提示 */
    const rk = Array.isArray(a.risks) ? a.risks : [];
    risks.forEach((r, i) => {
      const t = rk[i];
      if (t === null || t === undefined) { r.row.className = 'ai-risk hidden'; return; }
      if (r.row.className !== 'ai-risk') r.row.className = 'ai-risk';
      setText(r.t, t);
    });

    /* ⑦ 持仓建议 */
    const p = a.position;
    aPosNone.classList.toggle('hidden', !!p);
    aPosGrid.classList.toggle('hidden', !p);
    aPosAdvice.classList.toggle('hidden', !p);
    if (p) {
      setText(pHeld.v, (Number(p.held) || 0) + ' 股');
      setText(pAvail.v, (Number(p.avail) || 0) + ' 股');
      setText(pCost.v, fmtPrice(p.avgCost));
      setText(pPnl.v, fmtPct(p.pnlPct));
      pPnl.v.className = 'v num ' + signClass(p.pnlPct);
      setText(aPosAdvice, p.advice || '');
    }

    /* ⑧ 操作建议 */
    const s = a.suggestion || {};
    setText(aActTx, s.actionText || '--');
    const actCls = 'ai-act-text ' + (ACT_CLS[a.rating] || '');
    if (aActTx.className !== actCls) aActTx.className = actCls;
    setText(aActRange, '参考买入区间 ' + fmtPrice(s.priceLow) + ' ~ ' + fmtPrice(s.priceHigh)
      + (s.qtyPct > 0 ? '　建议仓位 ' + Math.round(s.qtyPct * 100) + '%' : ''));
    setText(aActSL, '止损 ' + fmtPrice(s.stopLoss));
    setText(aActTP, '止盈 ' + fmtPrice(s.takeProfit));
  }

  function renderMarket() {
    const has = !!market;
    mContent.classList.toggle('hidden', !has);
    mEmpty.classList.toggle('hidden', !(!has && !!marketErr));
    if (!has) {
      if (marketErr) setText(mEmTx, marketErr);
      setText(mTime, '尚未刷新');
      return;
    }
    const m = market;
    setText(mTime, marketTs ? '更新于 ' + fmtTime(marketTs) : '');

    /* ① 情绪徽章 */
    const mood = m.mood || {};
    setText(moodText, mood.text || '--');
    const moodCls = 'ai-mood-text ' + (MOOD_CLS[mood.id] || 'flat');
    if (moodText.className !== moodCls) moodText.className = moodCls;
    setText(moodDesc, mood.desc || '');

    /* ② 摘要 */
    setText(mSummary, m.summary || '');

    /* ③ 涨跌家数 */
    const b = m.breadth || {};
    const vals = [b.up, b.down, b.flat, b.limitUp, b.limitDown];
    bdItems.forEach((it, i) => setText(it.v, vals[i] === undefined || vals[i] === null ? '--' : String(vals[i])));

    /* ④ 观点逐条 */
    const ls = Array.isArray(m.lines) ? m.lines : [];
    lines.forEach((l, i) => {
      const t = ls[i];
      if (t === null || t === undefined) { l.row.className = 'ai-line hidden'; return; }
      if (l.row.className !== 'ai-line') l.row.className = 'ai-line';
      setText(l.t, t);
    });

    /* ⑤ 板块标签（涨红跌绿） */
    const secs = Array.isArray(m.sectors) ? m.sectors : [];
    sectorTags.forEach((tag, i) => {
      const s = secs[i];
      if (!s) { tag.className = 'tag hidden'; return; }
      const pct = Number(s.pct) || 0;
      const cls = 'tag ' + (pct > 0 ? 'tag-up' : pct < 0 ? 'tag-down' : '');
      if (tag.className !== cls) tag.className = cls;
      setText(tag, (s.sector || '--') + ' ' + fmtPct(pct));
    });

    /* ⑥ AI 关注标的 */
    const ps = Array.isArray(m.picks) ? m.picks : [];
    picks.forEach((p, i) => {
      const it = ps[i];
      if (!it) { p.row.className = 'ai-pick hidden'; return; }
      if (p.row.className !== 'ai-pick') p.row.className = 'ai-pick';
      p.row.dataset.id = it.id || '';
      p.row.title = '点击切换到 ' + (it.name || it.id || '');
      const c = p.cells;
      setText(c[0], it.name || it.id || '--');
      setText(c[1], it.id || '--');
      setText(c[2], fmtPrice(it.price));
      setText(c[3], fmtPct(it.chg));
      c[3].className = 'num ' + signClass(it.chg);
      setText(c[4], it.aiScore === undefined || it.aiScore === null ? '--' : String(it.aiScore));
      setText(c[5], it.reason || '');
      c[5].title = it.reason || '';
    });
  }

  function renderStatus() {
    /* 左：请求中 / 有旧数据时刷新失败 */
    const showA = loadingA || (!!adviceErr && !!advice);
    aStatus.classList.toggle('hidden', !showA);
    aStatus.classList.toggle('err', !loadingA && !!adviceErr);
    aSpin.classList.toggle('hidden', !loadingA);
    aStRetry.classList.toggle('hidden', loadingA);
    setText(aStTx, loadingA ? 'AI 正在分析…' : adviceErr);

    /* 右：同理 */
    const showM = loadingM || (!!marketErr && !!market);
    mStatus.classList.toggle('hidden', !showM);
    mStatus.classList.toggle('err', !loadingM && !!marketErr);
    mSpin.classList.toggle('hidden', !loadingM);
    mStRetry.classList.toggle('hidden', loadingM);
    setText(mStTx, loadingM ? 'AI 正在分析…' : marketErr);
  }

  function render() {
    renderAdvice();
    renderMarket();
    renderStatus();
  }

  /* ═══════════════════ 请求 ═══════════════════ */
  function canRequest() {
    return !destroyed && ctx.net && typeof ctx.net.request === 'function';
  }

  function fetchAdvice(stockId) {
    if (!canRequest() || !stockId) return;
    const reqId = uid('ai');
    if (reqA) pendingReq.delete(reqA);
    reqA = reqId;
    pendingReq.set(reqId, 'advice');
    loadingA = true;
    adviceErr = '';
    render();
    ctx.net.request('ai:advice', { stockId, reqId }, 'ai:advice', 8000)
      .then((msg) => {
        if (destroyed || reqA !== reqId) return;
        advice = msg;
        adviceTs = Number(msg && msg.ts) || Date.now();
        adviceErr = '';
      })
      .catch((err) => {
        if (destroyed || reqA !== reqId) return;
        adviceErr = preErr.get(reqId) || friendly(err);
      })
      .then(() => {
        pendingReq.delete(reqId);
        preErr.delete(reqId);
        if (destroyed || reqA !== reqId) return;
        loadingA = false;
        render();
      });
  }

  function fetchMarket() {
    if (!canRequest()) return;
    const reqId = uid('ai');
    if (reqM) pendingReq.delete(reqM);
    reqM = reqId;
    pendingReq.set(reqId, 'market');
    loadingM = true;
    marketErr = '';
    render();
    ctx.net.request('ai:advice', { reqId }, 'ai:market', 8000)
      .then((msg) => {
        if (destroyed || reqM !== reqId) return;
        market = msg;
        marketTs = Number(msg && msg.ts) || Date.now();
        marketErr = '';
      })
      .catch((err) => {
        if (destroyed || reqM !== reqId) return;
        marketErr = preErr.get(reqId) || friendly(err);
      })
      .then(() => {
        pendingReq.delete(reqId);
        preErr.delete(reqId);
        if (destroyed || reqM !== reqId) return;
        loadingM = false;
        render();
      });
  }

  function reloadAdvice() {
    const id = state.ui.stockId;
    if (!id) { ctx.toast('请先在行情列表里选择一只股票', 'warn'); return; }
    lastStockId = id;
    fetchAdvice(id);
  }
  function reloadMarket() { fetchMarket(); }

  /* ═══════════════════ 交互 ═══════════════════ */

  /* 「按建议填单」：把 priceLow 与 qtyPct 交给下单面板（tr:ai-fill 事件，派发到 #view） */
  function bridgeQty(side, price, pct) {
    /* 兼容桥只做「手数估算」，最终价格/数量/校验仍以下单面板与服务端为准 */
    if (!(pct > 0) || !(price > 0)) return 0;
    if (side === 'sell') {
      const p = state.ui.stockId ? position(state.ui.stockId) : null;
      const av = p ? Number(p.avail) || 0 : 0;
      return Math.floor((av * pct) / 100) * 100;
    }
    const acc = state.account;
    const cash = acc ? Number(acc.available != null ? acc.available : acc.cash) || 0 : 0;
    const lots = Math.floor(cash / (price * 100 * 1.0005));
    return Math.max(0, Math.floor(lots * pct)) * 100;
  }

  function onFill() {
    const a = advice;
    if (!a || !a.suggestion) { ctx.toast('还没有可用的 AI 建议', 'warn'); return; }
    const s = a.suggestion;
    const side = (a.rating === 'reduce' || a.rating === 'sell'
      || s.action === 'reduce' || s.action === 'sell') ? 'sell' : 'buy';
    const price = Number(s.priceLow) > 0 ? Number(s.priceLow) : 0;
    const pct = Number(s.qtyPct) || 0;

    patchUi({ orderSide: side });   // 只切方向，标的不动（建议就是针对当前标的的）

    /* 契约事件：priceLow + qtyPct 交给下单面板（派发到 #view，bubbles 以便面板在
       自己宿主/文档上监听；面板调用 preventDefault() 表示已接管） */
    const ev = new CustomEvent('tr:ai-fill', {
      detail: { side, price, pct }, bubbles: true, cancelable: true,
    });
    ctx.root.dispatchEvent(ev);

    let qty = 0;
    if (!ev.defaultPrevented) {
      /* 兼容桥：若下单面板没接管 tr:ai-fill，就退回到它现有的 tr:fill-order（按股数） */
      qty = bridgeQty(side, price, pct);
      const detail = { stockId: a.stockId, side, price };
      if (qty > 0) detail.qty = qty;
      ctx.root.dispatchEvent(new CustomEvent('tr:fill-order', { detail, bubbles: true }));
    }
    ctx.toast('已按 AI 建议填单：' + (side === 'buy' ? '买入' : '卖出')
      + (qty > 0 ? ' ' + qty + ' 股' : '') + ' @' + fmtPrice(price), 'success');
  }

  /* 关注标的点击 → 切换当前股票（图表 / 诊断一起切过去） */
  function onPickClick(e) {
    const tr = e.target && e.target.closest ? e.target.closest('tr[data-id]') : null;
    if (!tr || !tr.dataset.id) return;
    const id = tr.dataset.id;
    if (!state.stocks.has(id)) { ctx.toast('该标的当前不可交易：' + id, 'warn'); return; }
    state.ui.stockId = id;
    touch();
  }

  aReload.onclick = reloadAdvice;
  aStRetry.onclick = reloadAdvice;
  aEmRetry.onclick = reloadAdvice;
  mReload.onclick = reloadMarket;
  mStRetry.onclick = reloadMarket;
  mEmRetry.onclick = reloadMarket;
  aFill.onclick = onFill;
  offs.push(on(pickBody, 'click', onPickClick));

  /* 服务端 error 报文（reqId 匹配）→ 立刻给出友好错误态，不必等 8s 超时 */
  if (typeof ctx.on === 'function') {
    offs.push(ctx.on('error', (m) => {
      if (!m || !m.reqId) return;
      const kind = pendingReq.get(m.reqId);
      if (!kind) return;
      const txt = friendly(m);
      preErr.set(m.reqId, txt);
      if (kind === 'advice') { adviceErr = txt; loadingA = false; }
      else { marketErr = txt; loadingM = false; }
      render();
    }));
  }

  /* 面板可见时每 15s 自动刷新一次 */
  const timer = setInterval(() => {
    if (destroyed || state.ui.bottomTab !== 'ai') return;
    const id = state.ui.stockId;
    if (id) { lastStockId = id; fetchAdvice(id); }
    fetchMarket();
  }, 15000);

  /* ═══════════════════ 对外接口 ═══════════════════ */
  function update() {
    const id = state.ui.stockId || null;
    const visible = state.ui.bottomTab === 'ai';
    const justOpened = visible && !lastVisible;
    lastVisible = visible;

    if (justOpened) {
      /* 打开「AI 诊股」页：立即诊断一次（个股 + 大盘） */
      if (id) { lastStockId = id; fetchAdvice(id); }
      fetchMarket();
    } else if (visible && id && id !== lastStockId) {
      /* 当前股票变了：只重诊这一只，不每 tick 请求 */
      lastStockId = id;
      fetchAdvice(id);
    }
    render();
  }

  render();

  return {
    update,
    destroy() {
      destroyed = true;
      clearInterval(timer);
      for (const off of offs) { try { off(); } catch (e) { /* ignore */ } }
      offs.length = 0;
      pendingReq.clear();
      preErr.clear();
      advice = null;
      market = null;
      clear(host);
    },
  };
}
