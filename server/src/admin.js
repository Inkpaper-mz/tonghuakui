'use strict';
/* ═══════════════════════════════════════════════════════════════
   同花亏 · 运维控制台（人工宏观事件）

   给运营/房主一个「上帝之手」：随时往正在进行的一局里投放政策与突发事件，
   例如 政府补贴某企业、央行加息降息、国家队救市、监管处罚、临时停牌……

   设计要点：
     · 只在**对局进行中**生效（行情属于房间，没有房间就没有可施加的对象）
     · 两类效果分开：
         impact    即时情绪冲击（指数衰减，几分钟内被内在价值锚拉回）
         fairPct   内在价值**永久**变动（补贴/加息这类基本面事件必须改这个，
                   否则再大的利好也会在几分钟内被抹平，玩家会觉得"没用"）
     · 额外的行政手段：floorTicks 救市托底、haltTicks 临时停牌
     · 每个事件都会生成一条资讯广播给全场（复用 news 报文），玩家能看见"发生了什么"
   ═══════════════════════════════════════════════════════════════ */

const util = require('./util');
const { clamp } = util;

/* ───────── 事件目录（客户端控制台直接渲染这份）───────── */
const CATALOG = [
  /* ══ 宏观 / 全市场 ══ */
  { id: 'rateCut', name: '央行降息', scope: 'market', icon: '🏦', group: '宏观', dir: 1, impact: 0.85, fairPct: 0.015,
    desc: '下调政策利率，释放流动性；金融地产受益最明显' },
  { id: 'rateHike', name: '央行加息', scope: 'market', icon: '🏦', group: '宏观', dir: -1, impact: 0.85, fairPct: -0.015,
    desc: '上调政策利率，收紧流动性，高估值板块承压' },
  { id: 'rrrCut', name: '全面降准', scope: 'market', icon: '💧', group: '宏观', dir: 1, impact: 0.70, fairPct: 0.010,
    desc: '释放长期资金，银行可贷规模上升' },
  { id: 'rescue', name: '国家队救市', scope: 'market', icon: '🛡️', group: '宏观', dir: 1, impact: 1.00, fairPct: 0.008, floorTicks: 120,
    desc: '汇金/证金入场托底，托底期内指数不许跌破事件时刻价位' },
  { id: 'stimulus', name: '财政刺激', scope: 'market', icon: '💰', group: '宏观', dir: 1, impact: 0.80, fairPct: 0.012,
    desc: '大规模财政支出，总需求扩张' },
  { id: 'northIn', name: '北向资金流入', scope: 'market', icon: '🌏', group: '宏观', dir: 1, impact: 0.60,
    desc: '外资净买入，只影响情绪与资金面' },
  { id: 'northOut', name: '北向资金流出', scope: 'market', icon: '🌏', group: '宏观', dir: -1, impact: 0.60,
    desc: '外资净卖出，只影响情绪与资金面' },
  { id: 'blackSwan', name: '黑天鹅', scope: 'market', icon: '🦢', group: '宏观', dir: -1, impact: 1.00, fairPct: -0.020,
    desc: '系统性风险事件，全市场急跌' },
  { id: 'tighten', name: '监管收紧', scope: 'market', icon: '⚖️', group: '宏观', dir: -1, impact: 0.70, fairPct: -0.010,
    desc: '全行业合规成本上升' },

  /* ══ 板块 ══ */
  { id: 'policy', name: '产业政策利好', scope: 'sector', icon: '📜', group: '板块', dir: 1, impact: 0.85, fairPct: 0.040,
    desc: '定向扶持整个板块，基本面永久上修' },
  { id: 'sectorCold', name: '行业景气度下调', scope: 'sector', icon: '🧊', group: '板块', dir: -1, impact: 0.75, fairPct: -0.040,
    desc: '行业需求走弱，龙头也难以独善其身' },

  /* ══ 个股 ══ */
  { id: 'subsidy', name: '政府补贴', scope: 'stock', icon: '💵', group: '个股', dir: 1, impact: 0.90, fairPct: 0.060,
    desc: '收到政府专项补贴，直接增厚利润' },
  { id: 'earningsUp', name: '业绩超预期', scope: 'stock', icon: '📈', group: '个股', dir: 1, impact: 0.90, fairPct: 0.080,
    desc: '财报大幅好于预期，机构上调盈利预测' },
  { id: 'buyback', name: '回购 / 增持', scope: 'stock', icon: '🔁', group: '个股', dir: 1, impact: 0.80, fairPct: 0.030,
    desc: '公司公告回购或大股东增持' },
  { id: 'upgrade', name: '评级上调', scope: 'stock', icon: '⭐', group: '个股', dir: 1, impact: 0.60, fairPct: 0.010,
    desc: '券商上调评级与目标价' },
  { id: 'fine', name: '监管处罚', scope: 'stock', icon: '🚨', group: '个股', dir: -1, impact: 1.00, fairPct: -0.060,
    desc: '立案调查 / 巨额罚款' },
  { id: 'probe', name: '监管问询函', scope: 'stock', icon: '📮', group: '个股', dir: -1, impact: 0.70, fairPct: -0.020,
    desc: '交易所下发问询函，短期承压' },
  { id: 'reduce', name: '大股东减持', scope: 'stock', icon: '📉', group: '个股', dir: -1, impact: 0.80, fairPct: -0.030,
    desc: '大股东公告减持计划' },
  { id: 'earningsDown', name: '业绩暴雷', scope: 'stock', icon: '💥', group: '个股', dir: -1, impact: 1.00, fairPct: -0.090,
    desc: '利润大幅下滑，机构下调盈利预测' },
  { id: 'downgrade', name: '评级下调', scope: 'stock', icon: '⬇️', group: '个股', dir: -1, impact: 0.60, fairPct: -0.010,
    desc: '券商下调评级与目标价' },
  { id: 'rumor', name: '市场谣言', scope: 'stock', icon: '🗣️', group: '个股', dir: -1, impact: 0.95, fairPct: 0,
    desc: '只冲击情绪、不改基本面，几分钟后自然回落（适合制造假动作）' },

  /* ══ 行政手段 ══ */
  { id: 'halt', name: '临时停牌', scope: 'stock', icon: '⏸️', group: '行政', haltTicks: 60,
    desc: '价格冻结、暂停成交（默认 60 tick ≈ 一个交易小时）' },
  { id: 'resume', name: '复牌', scope: 'stock', icon: '▶️', group: '行政', clear: true,
    desc: '解除停牌，同时解除救市托底' },
];

const BY_ID = new Map(CATALOG.map(e => [e.id, e]));

/** 目录（附带默认强度），供控制台渲染 */
function catalog() {
  return CATALOG.map(e => ({
    id: e.id, name: e.name, scope: e.scope, icon: e.icon, group: e.group,
    dir: e.dir || 0, impact: e.impact || 0, fairPct: e.fairPct || 0,
    floorTicks: e.floorTicks || 0, haltTicks: e.haltTicks || 0,
    clear: !!e.clear, desc: e.desc || '',
  }));
}

/** 生成给玩家看的资讯文案 */
function buildNews(ev, ctx) {
  const { stockName, sector, strength, ticks } = ctx;
  const tone = ev.dir >= 0 ? '利多' : '利空';
  const s = Math.round((strength || 1) * 100);
  const T = {
    subsidy: [`【政策】${stockName}获政府专项补贴，机构测算增厚利润`, `有关部门向${stockName}下达专项补贴，用于产能与技术升级。市场人士认为此举对其业绩形成直接支撑，但补贴持续性仍需观察。`],
    rateCut: ['【宏观】央行宣布降息，市场流动性预期改善', '央行下调政策利率，资金成本下降。分析师普遍认为对金融、地产等利率敏感板块构成利好，成长股估值亦有支撑。'],
    rateHike: ['【宏观】央行宣布加息，估值端承压', '央行上调政策利率以抑制通胀预期，无风险利率上行。高估值板块面临杀估值压力，需警惕资金面收紧。'],
    rrrCut: ['【宏观】央行全面降准，释放长期资金', '本次降准释放长期低成本资金，银行可贷规模提升，市场风险偏好有望修复。'],
    rescue: ['【重磅】国家队入场托底，明确表态维护市场稳定', '汇金等机构宣布增持并承诺继续买入。有交易员表示，托底期间指数下行空间被封住，但反弹高度仍取决于增量资金。'],
    stimulus: ['【宏观】财政刺激方案落地，总需求预期扩张', '大规模财政支出计划公布，基建与消费链条有望受益，市场对盈利修复的预期升温。'],
    northIn: ['【资金】北向资金大幅净流入', '外资今日净买入明显放大，主要流向权重与景气赛道。'],
    northOut: ['【资金】北向资金大幅净流出', '外资今日净卖出明显放大，权重股承压。'],
    blackSwan: ['【突发】黑天鹅事件冲击全球风险资产', '突发事件引发避险情绪飙升，风险资产遭无差别抛售，请系好安全带。'],
    tighten: ['【监管】行业监管收紧，合规成本上升', '监管部门发布新规，行业整体合规成本上升，短期盈利预期下修。'],
    policy: [`【政策】${sector}板块迎来定向扶持政策`, `有关部门出台支持${sector}产业发展的政策文件，明确给予财税与融资支持，板块内个股集体异动。`],
    sectorCold: [`【行业】${sector}景气度下调，需求走弱`, `${sector}行业最新数据显示需求不及预期，机构下调全年增速预测。`],
    earningsUp: [`【财报】${stockName}业绩大幅超预期`, `${stockName}发布财报，营收与净利均显著高于市场预期，机构连夜上调盈利预测与目标价。`],
    earningsDown: [`【财报】${stockName}业绩暴雷`, `${stockName}财报大幅低于预期，计提大额减值，机构下调评级。`],
    buyback: [`【公告】${stockName}公告回购 / 大股东增持`, `${stockName}拟以自有资金回购股份并注销，同时大股东计划增持，彰显对长期价值的信心。`],
    upgrade: [`【评级】券商上调${stockName}评级与目标价`, `多家券商发布报告上调${stockName}评级，认为其估值具备吸引力。`],
    downgrade: [`【评级】券商下调${stockName}评级`, `券商下调${stockName}评级，提示短期业绩与估值风险。`],
    fine: [`【监管】${stockName}遭立案调查 / 巨额处罚`, `${stockName}公告收到监管处罚决定，市场对其治理与后续经营表示担忧。`],
    probe: [`【监管】${stockName}收到交易所问询函`, `交易所就${stockName}相关事项下发问询函，要求说明并披露。`],
    reduce: [`【公告】${stockName}大股东拟减持`, `${stockName}公告大股东减持计划，短期抛压上升。`],
    rumor: [`【传闻】市场流传${stockName}不利传闻`, `关于${stockName}的传闻在盘面发酵，公司尚未回应。请注意：传闻未证实，情绪性抛售往往随后修复。`],
    halt: [`【停牌】${stockName}临时停牌`, `${stockName}因故临时停牌，停牌期间不产生成交（约 ${ticks} tick 后自动复牌）。`],
    resume: [`【复牌】${stockName}恢复交易`, `${stockName}结束停牌恢复交易，请关注复牌后的资金博弈。`],
  }[ev.id] || [`【公告】${ev.name}`, `${ev.name}已生效（强度 ${s}%）。`];
  return {
    title: T[0],
    body: T[1],
    level: Math.abs(ev.impact || 0) >= 0.9 ? 'hot' : ev.dir >= 0 ? 'good' : 'bad',
    predict: tone === '利多' ? '利多' : '利空',
  };
}

/**
 * 对一批房间施加事件。
 * @param {Array} rooms 进行中的房间列表（room 需有 market / startCash / broadcast）
 * @param {string} eventId
 * @param {{stockId?:string, sector?:string, strength?:number, ticks?:number}} opts
 * @returns {{ok:boolean, code?:string, msg?:string, applied?:object[], news?:object}}
 */
function apply(rooms, eventId, opts = {}) {
  const ev = BY_ID.get(String(eventId || ''));
  if (!ev) return { ok: false, code: 'BAD_REQUEST', msg: `未知事件：${eventId}` };
  if (!Array.isArray(rooms) || !rooms.length) return { ok: false, code: 'NO_MATCH', msg: '当前没有进行中的对局' };

  const strength = clamp(Number(opts.strength) || 1, 0.1, 1.5);
  const ticks = Math.max(0, Math.round(Number(opts.ticks) || 0));
  const stockId = opts.stockId ? String(opts.stockId) : null;
  const sector = opts.sector ? String(opts.sector) : null;

  /* 作用域校验 */
  if (ev.scope === 'stock' && !stockId) return { ok: false, code: 'BAD_REQUEST', msg: '该事件需要指定个股' };
  if (ev.scope === 'sector' && !sector) return { ok: false, code: 'BAD_REQUEST', msg: '该事件需要指定板块' };

  const applied = [];
  let sampleStock = null;
  for (const room of rooms) {
    const mk = room && room.market;
    if (!mk || typeof mk.applyPolicy !== 'function') continue;
    let res;
    if (ev.clear) {
      res = mk.clearPolicy({ stockId, sector, all: ev.scope === 'market', halt: true, floor: true });
      res.scope = ev.scope; res.targets = res.targets || 0;
    } else {
      res = mk.applyPolicy({
        stockId: ev.scope === 'stock' ? stockId : null,
        sector: ev.scope === 'sector' ? sector : null,
        all: ev.scope === 'market',
        dir: ev.dir || 1,
        strength: (ev.impact || 0) * strength,
        fairPct: (ev.fairPct || 0) * (ev.clear ? 0 : strength),
        floorTicks: ticks > 0 && ev.id === 'rescue' ? ticks : (ev.floorTicks || 0),
        haltTicks: ev.haltTicks ? (ticks > 0 ? ticks : ev.haltTicks) : 0,
      });
    }
    if (stockId && mk.getState(stockId)) sampleStock = mk.getState(stockId);
    applied.push(Object.assign({ roomId: room.id }, res));
  }
  if (!applied.length) return { ok: false, code: 'NO_MATCH', msg: '没有可施加事件的进行中对局' };

  /* 组装给玩家看的资讯 */
  let stockName = stockId || '';
  if (stockId) {
    const first = rooms.find(r => r && r.market && r.market.getState(stockId));
    if (first) {
      const stk = (first.market.stocks || []).find(s => s.id === stockId);
      if (stk) stockName = `${stk.name}（${stockId}）`;
    }
  }
  const news = Object.assign({
    id: 'adm_' + Date.now().toString(36),
    time: Date.now(),
    sector: sector || null,
    stockId: stockId || null,
    admin: true,
    eventId: ev.id,
    eventName: ev.name,
    strength,
  }, buildNews(ev, { stockName, sector, strength, ticks: ticks || ev.haltTicks || ev.floorTicks || 0 }));

  return { ok: true, event: { id: ev.id, name: ev.name, scope: ev.scope }, applied, news };
}

module.exports = { CATALOG, catalog, apply, BY_ID };
