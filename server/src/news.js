/* ═══════════════════════════════════════════════════════════════
   同花亏 · 新闻 / 事件引擎（零依赖）
   ─ 开盘前 30 tick 内必有 1 条；之后大约每 40~90 tick 一条
   ─ 同一时刻最多 1 条；中文财经快讯风格 + 玩梗
   ─ 只产出 news（含 impact），由调用方（room.js）负责施加影响
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const util = require('./util');
const defaultConfig = require('./config');

const { rand, randInt, pick, round2 } = util;

/* ───────── 板块级模板（无个股 / 有板块）───────── */
const SECTOR_TPL = [
  {
    lv: 'hot', p: '利多', s: [0.55, 1],
    t: ['【政策】证监会宣布降低印花税，两市普涨', '【重磅】印花税减半落地，{sector}板块集体大涨', '【政策】降印花税利好兑现，{sector}领涨两市'],
    b: '财政部与税务总局联合公告，证券交易印花税实施减半征收。市场解读为重磅利好，{sector}板块放量拉升，资金抢筹明显。',
  },
  {
    lv: 'hot', p: '利多', s: [0.5, 0.9],
    t: ['【政策】央行宣布全面降准 0.5 个百分点，流动性宽松', '【宏观】降准落地，{sector}板块闻声起舞', '【政策】降准释放万亿资金，{sector}直线拉升'],
    b: '央行宣布下调金融机构存款准备金率 0.5 个百分点，释放长期资金约万亿元。{sector}板块受益于流动性宽松预期，成交显著放大。',
  },
  {
    lv: 'hot', p: '利空', s: [0.5, 0.95],
    t: ['【宏观】美联储意外加息，全球风险资产承压', '【外围】隔夜美股大跌，{sector}板块跟随调整', '【利空】海外流动性收紧，{sector}板块跳水'],
    b: '美联储议息会议意外释放鹰派信号，隔夜美股三大指数集体下挫。{sector}板块早盘承压，外资流出迹象明显。',
  },
  {
    lv: 'hot', p: '利多', s: [0.5, 0.9],
    t: ['【行情】北向资金净买入超百亿，{sector}获重点加仓', '【资金】外资爆买，{sector}板块午后异动', '【行情】北向资金大幅流入，{sector}成最大赢家'],
    b: '沪深港通数据显示，北向资金今日净买入超百亿元，{sector}板块多只个股获大幅加仓，机构认为估值修复行情有望延续。',
  },
  {
    lv: 'warn', p: '利空', s: [0.4, 0.8],
    t: ['【利空】传监管收紧再融资，{sector}板块承压', '【传闻】再融资政策收紧，{sector}午后跳水', '【监管】再融资审核趋严，{sector}板块走弱'],
    b: '据接近监管人士透露，再融资审核标准将有所提高。{sector}板块内多只个股闻讯回落，市场情绪转向谨慎。',
  },
  {
    lv: 'info', p: '中性', s: [0.15, 0.45],
    t: ['【盘中异动】{sector}板块冲高回落，多空分歧加大', '【异动】{sector}板块宽幅震荡，成交额居前', '【盘面】{sector}板块上下两难，资金观望情绪浓'],
    b: '{sector}板块今日振幅明显放大，多空双方在关键位置反复争夺。分析人士称，短期需关注量能能否持续。',
  },
  {
    lv: 'info', p: '利多', s: [0.35, 0.7],
    t: ['【机构观点】多家券商上调{sector}板块评级至"超配"', '【研报】{sector}景气度回升，机构集体看多', '【机构】{sector}迎来配置窗口，龙头有望受益'],
    b: '多家头部券商发布研报，认为{sector}行业景气度已见底回升，龙头公司盈利弹性更大，建议投资者逢低布局。',
  },
  {
    lv: 'warn', p: '利空', s: [0.4, 0.75],
    t: ['【机构观点】{sector}估值偏高，机构提示回调风险', '【风险】{sector}拥挤度过高，警惕踩踏', '【研报】{sector}短期涨幅过大，建议止盈'],
    b: '有机构指出，{sector}板块近期涨幅较大，交易拥挤度已处于历史高位，短期存在获利盘兑现压力，建议投资者控制仓位。',
  },
  {
    lv: 'info', p: '利多', s: [0.4, 0.75],
    t: ['【产业】{sector}行业数据超预期，需求端持续回暖', '【数据】{sector}景气指数创新高，订单排到明年', '【产业】{sector}产能利用率回升，价格企稳'],
    b: '最新公布的行业数据显示，{sector}需求端持续回暖，主要企业订单饱满，产品价格环比企稳，行业盈利有望改善。',
  },
  {
    lv: 'warn', p: '利空', s: [0.4, 0.8],
    t: ['【产业】{sector}价格战升级，行业利润率承压', '【利空】{sector}产能过剩警报拉响', '【产业】{sector}库存高企，厂商被迫降价去库'],
    b: '业内人士表示，{sector}行业新增产能集中释放，供需格局恶化，部分企业已开始降价促销，短期盈利承压。',
  },
  {
    lv: 'hot', p: '利多', s: [0.6, 1],
    t: ['【重磅】{sector}被写入国家五年规划重点方向', '【政策】{sector}获国家级产业基金千亿注资', '【重磅】{sector}纳入新一批重大工程清单'],
    b: '有关部门表示，{sector}被列为重点发展方向，将获得专项资金与政策支持。市场预期行业将迎来新一轮资本开支周期。',
  },
  {
    lv: 'warn', p: '利空', s: [0.45, 0.85],
    t: ['【利空】{sector}龙头遭机构下调评级', '【研报】{sector}盈利预测被集体下修', '【利空】{sector}龙头业绩暴雷，带崩板块'],
    b: '多家机构下调{sector}板块盈利预测，认为需求疲软与竞争加剧将压制利润率。板块内个股普遍走低。',
  },
  {
    lv: 'info', p: '中性', s: [0.15, 0.4],
    t: ['【盘面】{sector}板块量能萎缩，等待方向选择', '【异动】{sector}横盘蓄势，主力资金悄悄吸筹', '【盘面】{sector}板块缩量整理，观望气氛浓厚'],
    b: '{sector}板块今日成交较前一交易日明显萎缩，指数在窄幅区间内波动。技术面看，变盘窗口临近。',
  },
];

/* ───────── 个股级模板 ───────── */
const STOCK_TPL = [
  {
    lv: 'hot', p: '利多', s: [0.5, 0.95],
    t: ['【盘中异动】{sector}板块直线拉升，{name}大涨 5%', '【异动】{name}放量涨停，{sector}板块集体跟涨', '【行情】{name}直线封板，带动{sector}走强'],
    b: '{name}今日高开后快速拉升，盘中一度触及涨停，带动{sector}板块整体走强。机构表示，估值修复行情启动。',
  },
  {
    lv: 'warn', p: '利空', s: [0.5, 0.95],
    t: ['【利空】某{sector}龙头被曝产能过剩，板块集体跳水', '【利空】{name}被曝订单大幅下滑，股价跳水', '【突发】{name}遭大客户砍单，{sector}板块跟跌'],
    b: '有媒体报道称，{name}所处行业产能过剩问题加剧，下游客户开始缩减订单。公司暂未回应，股价放量下挫。',
  },
  {
    lv: 'info', p: '利多', s: [0.4, 0.8],
    t: ['【公告】{name}发布业绩预告：净利润同比大增', '【公告】{name}三季度净利超预期，同比翻倍', '【公告】{name}业绩爆发，毛利率创历史新高'],
    b: '{name}晚间发布业绩预告，预计净利润同比大幅增长，主要得益于产品结构优化与费用管控。',
  },
  {
    lv: 'warn', p: '利空', s: [0.4, 0.8],
    t: ['【公告】{name}业绩预告变脸，净利润大幅下滑', '【利空】{name}计提大额减值，全年业绩承压', '【公告】{name}突然修正业绩预告，股价承压'],
    b: '{name}发布业绩修正公告，因计提资产减值准备，全年净利润预计同比大幅下滑，投资者需注意风险。',
  },
  {
    lv: 'hot', p: '利多', s: [0.55, 1],
    t: ['【传闻】{sector}板块午后异动，{name}冲击涨停', '【传闻】{name}获巨头战略入股，股价直线飙升', '【传闻】{name}拿下百亿大额订单，资金蜂拥抢筹'],
    b: '市场传闻{name}与行业巨头达成战略合作，涉及金额巨大。公司尚未公告，但资金已提前反应，成交急剧放大。',
  },
  {
    lv: 'warn', p: '利空', s: [0.45, 0.9],
    t: ['【传闻】{name}实控人被约谈，股价闪崩', '【突发】{name}遭立案调查，{sector}板块承压', '【传闻】{name}财务造假疑云，机构紧急撤离'],
    b: '有消息称，{name}或涉及信息披露违规。公司股价异动下挫，多只基金重仓产品净值受影响。',
  },
  {
    lv: 'info', p: '利多', s: [0.35, 0.7],
    t: ['【公告】{name}拟大手笔回购，金额不超 20 亿元', '【公告】{name}推出员工持股计划，彰显信心', '【公告】{name}控股股东承诺不减持并增持'],
    b: '{name}公告称，基于对公司未来发展的信心，拟以自有资金回购股份用于股权激励，并向市场传递积极信号。',
  },
  {
    lv: 'warn', p: '利空', s: [0.35, 0.7],
    t: ['【公告】{name}大股东拟减持不超 3% 股份', '【利空】{name}解禁洪峰将至，抛压显现', '【公告】{name}董监高集体减持，股价承压'],
    b: '{name}发布减持计划公告，股东拟在未来六个月内减持部分股份。市场担忧抛压，股价小幅走低。',
  },
  {
    lv: 'info', p: '利多', s: [0.4, 0.8],
    t: ['【公司】{name}新产品发布，订单排期已至明年', '【公司】{name}新产线投产，产能翻倍', '【公司】{name}技术突破，良率大幅提升'],
    b: '{name}宣布新产品正式量产，下游客户反馈积极，目前订单排期已至明年，产能利用率维持高位。',
  },
  {
    lv: 'info', p: '中性', s: [0.15, 0.45],
    t: ['【龙虎榜】{name}现机构专用席位博弈', '【龙虎榜】{name}上榜，游资与机构互道珍重', '【异动】{name}振幅居前，多空激烈交锋'],
    b: '交易所龙虎榜数据显示，{name}买卖席位出现多家知名游资与机构专用席位，短线资金博弈激烈。',
  },
  {
    lv: 'warn', p: '利空', s: [0.4, 0.8],
    t: ['【利空】{name}核心技术人员离职，市场担忧加剧', '【突发】{name}主要工厂停产检修，影响交付', '【利空】{name}遭海外客户索赔，或影响利润'],
    b: '{name}公告称，因不可抗力因素，短期生产经营受到一定影响，公司正积极采取措施降低影响。',
  },
  {
    lv: 'hot', p: '利多', s: [0.5, 0.9],
    t: ['【重磅】{name}中标国家级重大项目，金额创纪录', '【公告】{name}签订百亿框架协议，打开成长空间', '【重磅】{name}与央企达成深度合作'],
    b: '{name}公告中标国家级重大项目，合同金额创公司历史新高，预计将对未来数年业绩产生积极影响。',
  },
  {
    lv: 'info', p: '中性', s: [0.2, 0.5],
    t: ['【观点】{name}估值处于历史低位，分歧仍大', '【研报】{name}多空分歧明显，机构看法不一', '【观点】{name}基本面拐点未现，谨慎观望'],
    b: '对于{name}的后市表现，机构观点出现明显分歧。看多方认为估值已充分反映悲观预期，看空方则担忧需求持续疲软。',
  },
];

/* ───────── 组合器 ───────── */

function buildPool() {
  const pool = [];
  for (const tpl of SECTOR_TPL) for (const t of tpl.t) for (const b of tpl.b ? [tpl.b] : ['']) pool.push({ ...tpl, t, b });
  for (const tpl of STOCK_TPL) for (const t of tpl.t) for (const b of tpl.b ? [tpl.b] : ['']) pool.push({ ...tpl, t, b });
  return pool;
}
const POOL = buildPool();

class NewsEngine {
  /**
   * @param {{market:object, config?:object}} opts
   */
  constructor(opts = {}) {
    this.market = opts.market;
    this.config = opts.config || defaultConfig;
    this.reset();
  }

  reset() {
    this._n = 0;
    this._nextAt = randInt(1, 12);   // 开盘前 30 tick 内必定生成
    this._lastSeq = null;            // 关键：新一局从 seq=1 重新计数
    this._lastTitle = '';
    this._lastSector = null;
    this._recent = [];
  }

  /**
   * 由 room.js 每 tick 调用。同一时刻最多返回 1 条。
   * @param {{seq:number, vtime:number}} ctx
   * @returns {object|null}
   */
  maybeGenerate(ctx = {}) {
    const seq = Number(ctx.seq) || 0;
    if (seq < this._nextAt) return null;
    if (this._lastSeq != null && seq - this._lastSeq < 6) return null;   // 同刻最多 1 条

    const sectors = this._sectors();
    if (!sectors.length) return null;

    const news = this._make(ctx, sectors);
    this._n += 1;
    this._lastSeq = seq;
    this._nextAt = seq + randInt(40, 90);
    this._lastTitle = news.title;
    this._lastSector = news.sector || null;
    this._recent.push(news);
    if (this._recent.length > 60) this._recent.shift();
    return news;
  }

  _sectors() {
    const m = this.market;
    if (!m) return [];
    if (Array.isArray(m.stocks) && m.stocks.length) {
      const out = [];
      const seen = new Set();
      for (const s of m.stocks) {
        if (!s || !s.sector || seen.has(s.sector)) continue;
        seen.add(s.sector);
        out.push(s.sector);
      }
      return out;
    }
    return (this.config.SECTORS || []).slice();
  }

  _stockList(sector) {
    const m = this.market;
    if (!m || !Array.isArray(m.stocks)) return [];
    return m.stocks.filter(s => s && s.sector === sector);
  }

  _make(ctx, sectors) {
    const id = 'n_' + (this._n + 1);
    const vtime = Number(ctx.vtime) || (this.market && this.market.vtime) || Date.now();

    let sector = pick(sectors);
    if (sector === this._lastSector && sectors.length > 1 && Math.random() < 0.7) {
      sector = pick(sectors.filter(s => s !== sector));
    }

    const tpl = pick(POOL);
    // 模板里含 {name} → 必须落到具体个股；否则为板块级快讯
    const needStock = String(tpl.t).indexOf('{name}') >= 0 || String(tpl.b || '').indexOf('{name}') >= 0;
    let list = this._stockList(sector);
    if (needStock && !list.length) {
      const alt = sectors.find(s => this._stockList(s).length > 0);
      if (alt) { sector = alt; list = this._stockList(alt); }
    }
    const stock = needStock && list.length ? pick(list) : null;
    const name = stock ? stock.name : '';

    const fill = (str) => String(str)
      .split('{sector}').join(sector)
      .split('{name}').join(name || (this._stockList(sector)[0] || {}).name || '该股');

    const title = fill(tpl.t);
    const body = fill(tpl.b || '');
    const level = tpl.lv || 'info';
    const predict = tpl.p || '中性';
    const [s0, s1] = tpl.s || [0.3, 0.7];
    const S = clamp01(round2(rand(s0, s1)));
    const dir = predict === '利多' ? 1 : predict === '利空' ? -1 : 0;

    const impact = {
      sector,
      stockId: stock ? stock.id : null,
      dir,
      strength: dir === 0 ? round2(S * 0.35) : S,
    };

    return {
      id,
      time: vtime,
      title,
      body: body || title,
      level,
      sector,
      stockId: stock ? stock.id : null,
      predict,
      impact,
    };
  }
}

function clamp01(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0.5;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

module.exports = { NewsEngine, SECTOR_TPL, STOCK_TPL };
module.exports.default = NewsEngine;
