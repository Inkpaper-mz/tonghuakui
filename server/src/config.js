/* ═══════════════════════════════════════════════════════════════
   同花亏 · 服务端配置（唯一参数中心）
   注意：修改本文件不需要改动其它模块。
   ═══════════════════════════════════════════════════════════════ */

const path = require('path');

const SERVER_NAME = '同花亏';
const VERSION = '1.0.0';

/* ───────── 网络 ───────── */
const PORT = Number(process.env.THK_PORT || process.env.PORT || 8899);
const HOST = process.env.THK_HOST || '0.0.0.0';
const DATA_FILE = process.env.THK_DATA || path.join(__dirname, '..', '..', 'data', 'store.json');
/* 运维控制台密钥：留空则启动时随机生成一个并写进 data/admin-key.txt（见 server.js 启动横幅） */
const ADMIN_KEY = String(process.env.THK_ADMIN_KEY || '').trim();
const CLIENT_DIR = path.join(__dirname, '..', '..', 'client');

/* ───────── 行情时钟 ───────── */
const TICK_MS = 1000;              // 每个 tick 的真实毫秒数
/* ── 时间节奏 ──
   1 个虚拟分钟 = 5 个 tick = 5 秒真实时间（走慢一点，别让分时图一秒一分钟地飞）
   1 个虚拟交易日 = 120 虚拟分钟 = 上午盘 09:30-11:30 = 10 分钟真实时间
   每个交易日结束后有 1 分钟真实时间的「午间休市」，期间行情冻结、下一天开盘前可挂单排队 */
const SECONDS_PER_VIRTUAL_MINUTE = 5;   // 多少真实秒 = 1 个虚拟分钟（控制台可运行时调整）
const VIRTUAL_MINUTE_TICKS = 5;        // 由上面的秒数推导出的 tick 数（TICK_MS=1000 时等于 5）
const VIRTUAL_DAY_TICKS = 120;     // 一个虚拟交易日 = 120 虚拟分钟（09:30-11:30）
const BREAK_SEC = 60;              // 每个交易日结束后的中场休息（真实秒）
const OPEN_AUCTION_TICKS = 5;      // 开盘集合竞价（简化：前 5 个 tick 只撮合不放开涨跌幅）
const HISTORY_DAYS = 120;          // 开局预生成的历史日 K 根数

/* ───────── 对局 ───────── */
/* 一局时长：按新节奏（10 分钟一个交易日 + 1 分钟午休）重新标定，
   保证每档都至少跨过一个交易日，否则 T+1 会让买入的股票永远卖不掉 */
const DURATIONS = [
  { sec: 900, name: '标准 15 分钟（约 1.5 个交易日）' },
  { sec: 1800, name: '长线 30 分钟（约 2.7 个交易日）' },
  { sec: 2700, name: '马拉松 45 分钟（约 4 个交易日）' },
];
const START_CASH_OPTIONS = [100000, 1000000, 5000000];
const MAX_PLAYERS = 30;          // 单个房间人数硬上限
const QUICK_MATCH_FILL = 8;      // 快速匹配/AI 补齐的目标人数（避免一局塞 30 个 AI）
const PLAYER_COUNT_OPTIONS = [2, 4, 6, 8, 12, 16, 20, 24, 30];   // 客户端「人数上限」下拉项
const MODES = [
  { id: '1v1', name: '1v1 单挑', maxPlayers: 2, minPlayers: 2 },
  { id: 'ffa', name: '多人混战', maxPlayers: MAX_PLAYERS, minPlayers: 2 },
  { id: 'team', name: '红蓝团战', maxPlayers: MAX_PLAYERS, minPlayers: 4 },
];
const DEFAULT_START_CASH = 1000000;
const DEFAULT_DURATION_SEC = 900;
const COUNTDOWN_SEC = 3;
const QUICK_MATCH_WAIT_MS = 5000;   // 快速匹配等待真人，超时用 AI 补齐
const RECONNECT_GRACE_MS = 90000;   // 掉线保留席位时长
const ACCOUNT_PUSH_EVERY = 3;       // 无变化时每 N tick 推一次 account

/* ───────── 交易规则 ───────── */
const LOT_SIZE = 100;
const LIMIT_PCT = 0.10;            // 主板涨跌停
const LIMIT_PCT_20 = 0.20;         // 创业板(30)/科创板(68)
const FEE = {
  commissionRate: 0.00025,         // 佣金 万 2.5
  commissionMin: 5,                // 最低 5 元
  stampTax: 0.0005,                // 印花税（仅卖出）
  transferFee: 0.00001,            // 过户费（双向）
};
const MAX_ORDERS_PER_PLAYER = 200;
const MAX_TRADES_KEEP = 500;
const IMPACT_K = 0.9;              // 玩家成交的价格冲击系数
/* ── 价格制衡（防止多人同向交易把全市场顶到涨停）──
   1) 每只股票有不受玩家影响的「内在价值 fair」，价格被它持续拉回；
   2) 偏离越远拉得越狠（线性 + 二次项）；
   3) 偏离到一定程度会招来「外部盘」：机构调仓 / 大股东减持 / 北向资金反向成交；
   4) 参与人数越多，市场深度越深（同样的钱对价格的推动更小）。 */
const FAIR_VOL = 0.55;             // 内在价值自身波动 = 个股 vol × 该系数
const ANCHOR_K = 0.025;            // 价格向目标价收敛的速度（每 tick）
const FAIR_ANCHOR_QUAD = 0.30;     // 额外二次回拉（大幅偏离时更狠）
const EXTERNAL_FLOW_P = 0.08;      // 基础外部盘出现概率（偏离越大越高）
const EXTERNAL_FLOW_K = 0.9;       // 外部盘强度系数
const DEPTH_PER_PLAYER = 0.14;     // 每多一名参与者，市场深度增加比例
const DEPTH_MAX_MULT = 4.0;        // 深度放大上限
/* IMPACT 的语义是「玩家净买入把股价临时抬高的百分比」，不是每 tick 收益率：
   价格会被拉向 fair × exp(impact)，impact 自己慢慢衰减回 0（外部力量消化）。 */
const IMPACT_CLAMP = 0.06;         // 冲击水平上限 ±6%（离 ±10% 停板线留出安全边际）
const IMPACT_PER_CALL = 0.03;      // 单笔成交最多推动 3%
const IMPACT_DECAY = 0.94;         // 冲击水平每 tick 衰减

/* ───────── 段位 / ELO ───────── */
const ELO_START = 1000;
const ELO_K = 32;
const TIERS = [
  { min: 1800, name: '王者', color: '#d4a017' },
  { min: 1600, name: '钻石', color: '#7b61ff' },
  { min: 1400, name: '铂金', color: '#2fb3c9' },
  { min: 1200, name: '黄金', color: '#e8a33d' },
  { min: 1000, name: '白银', color: '#9aa7b4' },
  { min: -1e9, name: '青铜', color: '#b07d4a' },
];

const BOT_NAMES = [
  '涨停敢死队', '追高侠', '徐翔的小号', '满仓踏空哥', '关灯吃面',
  '抄底不成反被抄', '白酒永远的神', '一把梭哈', '韭菜收割机',
  '牛市来了别跑', 'T王之王', '价值投资老张', '龙虎榜常客', '北向资金',
];

const AVATARS = ['🐂', '🐻', '🐷', '🐔', '🦈', '🐺', '🐯', '🦊', '🐸', '🐵', '🦉', '🐧'];

/* ───────── 股票池（虚构，仅供娱乐）─────────
   vol    : 每 tick 对数收益率标准差
   drift  : 每 tick 对数收益率漂移
   beta   : 对板块因子的敏感度
   ai     : 是否 30/68 开头（±20% 涨跌停）
   pinyin : 供客户端搜索
   ─────────────────────────────────────────── */
const STOCKS = [
  // 白酒
  { id: '600519', name: '贵州毛台', sector: '白酒', prevClose: 1688.00, vol: 0.0022, drift: 0.00004, beta: 1.05, floatShares: 1.2e9, pe: 31.2, pinyin: 'gzmt' },
  { id: '000858', name: '五粮溢', sector: '白酒', prevClose: 148.60, vol: 0.0026, drift: 0.00003, beta: 1.10, floatShares: 3.9e9, pe: 22.4, pinyin: 'wly' },
  // 新能源
  { id: '300750', name: '宁德世贷', sector: '新能源', prevClose: 188.80, vol: 0.0036, drift: 0.00006, beta: 1.35, floatShares: 2.3e9, pe: 28.1, pinyin: 'ndsd', ai: true },
  { id: '002594', name: '比亚帝', sector: '新能源', prevClose: 256.40, vol: 0.0034, drift: 0.00005, beta: 1.28, floatShares: 1.1e9, pe: 24.7, pinyin: 'byd' },
  // 半导体
  { id: '688981', name: '中芯国记', sector: '半导体', prevClose: 88.35, vol: 0.0046, drift: 0.00008, beta: 1.55, floatShares: 5.6e9, pe: 96.5, pinyin: 'zxgj', ai: true },
  { id: '000725', name: '京东房', sector: '半导体', prevClose: 4.62, vol: 0.0038, drift: 0.00002, beta: 1.30, floatShares: 3.4e10, pe: 41.8, pinyin: 'jdf' },
  // 医药
  { id: '600276', name: '恒瑞医要', sector: '医药', prevClose: 46.90, vol: 0.0030, drift: 0.00003, beta: 1.12, floatShares: 6.4e9, pe: 55.3, pinyin: 'hryy' },
  { id: '300760', name: '迈瑞医辽', sector: '医药', prevClose: 288.60, vol: 0.0032, drift: 0.00004, beta: 1.15, floatShares: 1.2e9, pe: 34.6, pinyin: 'mryl', ai: true },
  // 地产
  { id: '000002', name: '万客A', sector: '地产', prevClose: 7.18, vol: 0.0040, drift: -0.00006, beta: 1.22, floatShares: 9.7e9, pe: 8.9, pinyin: 'wka' },
  // 金融
  { id: '600036', name: '招商银航', sector: '金融', prevClose: 38.75, vol: 0.0018, drift: 0.00002, beta: 0.85, floatShares: 2.1e10, pe: 6.2, pinyin: 'zsyh' },
  { id: '601318', name: '中国平鞍', sector: '金融', prevClose: 52.30, vol: 0.0022, drift: 0.00001, beta: 0.95, floatShares: 1.1e10, pe: 8.6, pinyin: 'zgpa' },
  { id: '600030', name: '中信证拳', sector: '金融', prevClose: 27.85, vol: 0.0034, drift: 0.00003, beta: 1.45, floatShares: 1.3e10, pe: 18.3, pinyin: 'zxzq' },
  // 光伏
  { id: '601012', name: '隆基绿熊', sector: '光伏', prevClose: 18.42, vol: 0.0042, drift: -0.00005, beta: 1.40, floatShares: 7.5e9, pe: 15.7, pinyin: 'ljlx' },
  { id: '300274', name: '阳光电原', sector: '光伏', prevClose: 92.15, vol: 0.0044, drift: 0.00002, beta: 1.42, floatShares: 1.9e9, pe: 17.2, pinyin: 'ygdy', ai: true },
  // 食品
  { id: '600887', name: '伊利股分', sector: '食品', prevClose: 28.66, vol: 0.0024, drift: 0.00002, beta: 0.92, floatShares: 6.3e9, pe: 17.4, pinyin: 'ylgf' },
  { id: '603288', name: '海天味液', sector: '食品', prevClose: 39.80, vol: 0.0026, drift: 0.00001, beta: 0.90, floatShares: 5.5e9, pe: 33.8, pinyin: 'htwy' },
  // 安防
  { id: '002415', name: '海康威仕', sector: '安防', prevClose: 32.14, vol: 0.0028, drift: 0.00002, beta: 1.08, floatShares: 9.2e9, pe: 21.5, pinyin: 'hkws' },
  // 军工
  { id: '600893', name: '中航神飞', sector: '军工', prevClose: 41.20, vol: 0.0036, drift: 0.00004, beta: 1.32, floatShares: 2.7e9, pe: 68.4, pinyin: 'zhsf' },
  // 人工智能
  { id: '002230', name: '科大迅飞', sector: '人工智能', prevClose: 45.60, vol: 0.0044, drift: 0.00007, beta: 1.58, floatShares: 2.2e9, pe: 112.6, pinyin: 'kdxf' },
  { id: '688256', name: '寒武记', sector: '人工智能', prevClose: 268.00, vol: 0.0056, drift: 0.00009, beta: 1.72, floatShares: 4.1e8, pe: -1, pinyin: 'hwj', ai: true },
  // 商业（妖股：波动大、上蹿下跳、容易涨停/跌停）
  { id: '600173', name: '卧龙商射', sector: '商业', prevClose: 12.88, vol: 0.0058, drift: 0.00012, beta: 1.60, floatShares: 1.6e9, pe: 88.8, pinyin: 'wlss' },

  /* ─────────── 纳斯达克板块（美股：无涨跌停制度，这里给 ±30% 的宽幅限制）─────────── */
  { id: 'NVDA', name: '英卫达', sector: '纳指芯片', market: 'us', limitPct: 0.30, prevClose: 128.60, vol: 0.0062, drift: 0.00016, beta: 1.85, floatShares: 2.4e10, pe: 62.4, pinyin: 'ywd nvda' },
  { id: 'AMD', name: '超威半导', sector: '纳指芯片', market: 'us', limitPct: 0.30, prevClose: 162.30, vol: 0.0056, drift: 0.00010, beta: 1.70, floatShares: 1.6e9, pe: 45.8, pinyin: 'cwbd amd' },
  { id: 'AAPL', name: '苹果梨', sector: '纳指科技', market: 'us', limitPct: 0.30, prevClose: 226.80, vol: 0.0030, drift: 0.00008, beta: 1.15, floatShares: 1.5e10, pe: 34.2, pinyin: 'pgl aapl' },
  { id: 'MSFT', name: '微硬', sector: '纳指科技', market: 'us', limitPct: 0.30, prevClose: 418.50, vol: 0.0028, drift: 0.00009, beta: 1.10, floatShares: 7.4e9, pe: 36.5, pinyin: 'wy msft' },
  { id: 'GOOGL', name: '谷哥', sector: '纳指科技', market: 'us', limitPct: 0.30, prevClose: 172.40, vol: 0.0034, drift: 0.00008, beta: 1.25, floatShares: 1.1e10, pe: 24.8, pinyin: 'gg googl' },
  { id: 'META', name: '元宝', sector: '纳指科技', market: 'us', limitPct: 0.30, prevClose: 512.70, vol: 0.0040, drift: 0.00012, beta: 1.40, floatShares: 2.5e9, pe: 27.6, pinyin: 'yb meta' },
  { id: 'TSLA', name: '特撕拉', sector: '纳指新势力', market: 'us', limitPct: 0.30, prevClose: 248.90, vol: 0.0070, drift: 0.00014, beta: 2.00, floatShares: 3.2e9, pe: 71.3, pinyin: 'tsl tsla' },
  { id: 'AMZN', name: '亚马孙', sector: '纳指新势力', market: 'us', limitPct: 0.30, prevClose: 186.20, vol: 0.0036, drift: 0.00010, beta: 1.30, floatShares: 1.0e10, pe: 38.9, pinyin: 'yms amzn' },
  { id: 'NFLX', name: '奈非', sector: '纳指新势力', market: 'us', limitPct: 0.30, prevClose: 682.40, vol: 0.0044, drift: 0.00012, beta: 1.45, floatShares: 4.3e8, pe: 42.1, pinyin: 'nf nflx' },
  { id: 'COIN', name: '币安所', sector: '纳指新势力', market: 'us', limitPct: 0.30, prevClose: 178.30, vol: 0.0090, drift: 0.00020, beta: 2.30, floatShares: 2.5e8, pe: 55.7, pinyin: 'bas coin' },

  /* ─────────── 社团概念股（30 只：文体传媒 / 体育 / 食品餐饮 / 商贸零售 / 时尚消费 / 文创服务 / 公共事业 / 航空 / 新材料）─────────── */
  { id: '300413', name: '推理社文化', sector: '文体传媒', prevClose: 26.80, vol: 0.0044, drift: 6e-05, beta: 1.45, floatShares: 1.2e+09, pe: 48.6, pinyin: 'tuilishe tls' },
  { id: '300251', name: '戏剧舞蹈文化', sector: '文体传媒', prevClose: 12.36, vol: 0.004, drift: 3e-05, beta: 1.3, floatShares: 1.8e+09, pe: 62.3, pinyin: 'xijuwudao xjwd' },
  { id: '002739', name: '星工坊传媒', sector: '文体传媒', prevClose: 18.90, vol: 0.0042, drift: 5e-05, beta: 1.35, floatShares: 1.5e+09, pe: 55.1, pinyin: 'xinggongfang xgf' },
  { id: '300661', name: '晓组织动漫', sector: '文体传媒', prevClose: 33.44, vol: 0.005, drift: 8e-05, beta: 1.55, floatShares: 9.0e+08, pe: 78.2, pinyin: 'xiaozuzhi xzz' },
  { id: '002174', name: '像素重构游戏', sector: '文体传媒', prevClose: 15.72, vol: 0.0048, drift: 7e-05, beta: 1.5, floatShares: 1.3e+09, pe: 41.7, pinyin: 'xiangsuzhonggou xszg' },
  { id: '300364', name: '虚拟真实传媒', sector: '文体传媒', prevClose: 21.05, vol: 0.0046, drift: 6e-05, beta: 1.42, floatShares: 1.1e+09, pe: 51.4, pinyin: 'xunizhenshi xnm' },
  { id: '002678', name: '足球社体育', sector: '体育产业', prevClose: 9.86, vol: 0.0038, drift: 2e-05, beta: 1.2, floatShares: 2.4e+09, pe: 33.5, pinyin: 'zuqiushe zqs' },
  { id: '605299', name: '乒羽联盟体育', sector: '体育产业', prevClose: 14.28, vol: 0.0036, drift: 3e-05, beta: 1.18, floatShares: 1.6e+09, pe: 29.8, pinyin: 'pingyulianmeng pylm' },
  { id: '300005', name: '健身社健康', sector: '体育产业', prevClose: 7.45, vol: 0.004, drift: 2e-05, beta: 1.25, floatShares: 2.8e+09, pe: 44.2, pinyin: 'jianshenshe jss' },
  { id: '002878', name: '健将起航体育', sector: '体育产业', prevClose: 11.63, vol: 0.0039, drift: 3e-05, beta: 1.22, floatShares: 2.0e+09, pe: 36.9, pinyin: 'jianjiangqihang jjqh' },
  { id: '603886', name: '苹果派食品', sector: '食品餐饮', prevClose: 17.55, vol: 0.0034, drift: 4e-05, beta: 1.1, floatShares: 1.4e+09, pe: 27.6, pinyin: 'pingguopai pgp' },
  { id: '605337', name: '烘焙社食品', sector: '食品餐饮', prevClose: 22.19, vol: 0.0036, drift: 5e-05, beta: 1.15, floatShares: 8.5e+08, pe: 31.2, pinyin: 'hongbeishe hbs' },
  { id: '605108', name: '食艺阁餐饮', sector: '食品餐饮', prevClose: 28.70, vol: 0.0037, drift: 4e-05, beta: 1.12, floatShares: 7.2e+08, pe: 39.4, pinyin: 'shiyige syg' },
  { id: '603711', name: '茶艺社茶业', sector: '食品餐饮', prevClose: 13.44, vol: 0.0033, drift: 3e-05, beta: 1.05, floatShares: 1.9e+09, pe: 24.8, pinyin: 'chayishe cys' },
  { id: '601828', name: '解忧杂货零售', sector: '商贸零售', prevClose: 6.35, vol: 0.0035, drift: 1e-05, beta: 1.08, floatShares: 4.2e+09, pe: 19.7, pinyin: 'jieyouzahuopu jyzhp' },
  { id: '600704', name: '泰坦商社控股', sector: '商贸零售', prevClose: 8.92, vol: 0.0033, drift: 2e-05, beta: 1.16, floatShares: 3.1e+09, pe: 14.3, pinyin: 'taitanshangshe tts' },
  { id: '600612', name: '青玉案珠宝', sector: '时尚消费', prevClose: 42.66, vol: 0.0042, drift: 6e-05, beta: 1.3, floatShares: 6.8e+08, pe: 46.8, pinyin: 'qingyuan qya' },
  { id: '603983', name: '多元彩韵美妆', sector: '时尚消费', prevClose: 35.18, vol: 0.0044, drift: 7e-05, beta: 1.38, floatShares: 5.4e+08, pe: 52.9, pinyin: 'duoyuancaiyun dycy' },
  { id: '600626', name: '不织布新材', sector: '时尚消费', prevClose: 5.88, vol: 0.004, drift: 2e-05, beta: 1.2, floatShares: 2.6e+09, pe: 28.4, pinyin: 'buzhibu bzb' },
  { id: '000726', name: '编织社纺织', sector: '时尚消费', prevClose: 4.72, vol: 0.0036, drift: 1e-05, beta: 1.05, floatShares: 3.5e+09, pe: 16.2, pinyin: 'bianzhishe bzs' },
  { id: '300888', name: '安妮潮玩', sector: '时尚消费', prevClose: 58.30, vol: 0.0056, drift: 0.00012, beta: 1.62, floatShares: 4.6e+08, pe: 88.5, pinyin: 'annichaowan acw' },
  { id: '603136', name: '星空手作文创', sector: '文创服务', prevClose: 24.15, vol: 0.004, drift: 4e-05, beta: 1.22, floatShares: 9.6e+08, pe: 43.6, pinyin: 'xingkongshouzuo xksz' },
  { id: '002137', name: '梦想家影像', sector: '文创服务', prevClose: 16.88, vol: 0.0041, drift: 5e-05, beta: 1.28, floatShares: 1.2e+09, pe: 58.7, pinyin: 'mengxiangjia mxy' },
  { id: '000888', name: '平行人生文旅', sector: '文创服务', prevClose: 19.62, vol: 0.0043, drift: 6e-05, beta: 1.32, floatShares: 1.4e+09, pe: 61.4, pinyin: 'pingxingrensheng pxrs' },
  { id: '600661', name: '法语社教育', sector: '文创服务', prevClose: 12.90, vol: 0.0039, drift: 2e-05, beta: 1.15, floatShares: 1.7e+09, pe: 47.2, pinyin: 'fayushe fys' },
  { id: '003032', name: 'STEM教育', sector: '文创服务', prevClose: 27.35, vol: 0.0046, drift: 7e-05, beta: 1.4, floatShares: 8.0e+08, pe: 66.8, pinyin: 'stemjiaoyu stem' },
  { id: '300070', name: '灯塔环保', sector: '公共事业', prevClose: 6.88, vol: 0.0034, drift: 1e-05, beta: 1.02, floatShares: 3.3e+09, pe: 21.5, pinyin: 'dengtahuanbao dthb' },
  { id: '600763', name: '红十字医疗', sector: '公共事业', prevClose: 44.20, vol: 0.0038, drift: 4e-05, beta: 1.18, floatShares: 1.1e+09, pe: 37.9, pinyin: 'hongshizi hsz' },
  { id: '600760', name: '心向蓝天航空', sector: '航空制造', prevClose: 38.75, vol: 0.0042, drift: 5e-05, beta: 1.35, floatShares: 1.3e+09, pe: 49.3, pinyin: 'xinxianglantian xxlt' },
  { id: '600160', name: '化世界新材', sector: '新材料', prevClose: 10.55, vol: 0.004, drift: 3e-05, beta: 1.24, floatShares: 2.2e+09, pe: 25.6, pinyin: 'huashijie hsj' },
];

/** 代码是否适用 ±20% 涨跌停 */
function isWideLimit(id) {
  return id.startsWith('30') || id.startsWith('68');
}

/** 涨跌停价（四舍五入到分） */
function limitPrices(stock) {
  const pct = Number(stock.limitPct) > 0 ? Number(stock.limitPct)
    : isWideLimit(stock.id) ? LIMIT_PCT_20 : LIMIT_PCT;
  const up = Math.round(stock.prevClose * (1 + pct) * 100) / 100;
  const down = Math.round(stock.prevClose * (1 - pct) * 100) / 100;
  return { limitUp: up, limitDown: down, limitPct: pct };
}

const SECTORS = Array.from(new Set(STOCKS.map(s => s.sector)));

/** 指数成分（同花综指 = 全部；同花成指 = 权重前 8） */
const A_SHARE_IDS = STOCKS.filter(s => s.market !== 'us').map(s => s.id);
const US_IDS = STOCKS.filter(s => s.market === 'us').map(s => s.id);
const US_TOP_IDS = ['NVDA', 'MSFT', 'AAPL', 'AMZN', 'META'];   // 纳指100 权重股
const INDICES = [
  { code: 'THKZ', name: '同花综指', base: 1200.00, members: A_SHARE_IDS },
  { code: 'THKC', name: '同花成指', base: 2480.00, members: A_SHARE_IDS.slice(0, 8) },
  { code: 'IXIC', name: '纳斯达克综指', base: 18542.60, members: US_IDS },
  { code: 'NDX', name: '纳斯达克100', base: 20188.40, members: US_TOP_IDS.filter(id => US_IDS.includes(id)) },
];

const MAX_CHAT_LEN = 120;
const HEARTBEAT_MS = 30000;
const RATE_LIMIT_PER_SEC = 30;

module.exports = {
  SERVER_NAME, VERSION,
  PORT, HOST, DATA_FILE, CLIENT_DIR, ADMIN_KEY,
  TICK_MS, SECONDS_PER_VIRTUAL_MINUTE, VIRTUAL_MINUTE_TICKS, VIRTUAL_DAY_TICKS, BREAK_SEC, OPEN_AUCTION_TICKS, HISTORY_DAYS,
  DURATIONS, START_CASH_OPTIONS, MODES,
  MAX_PLAYERS, QUICK_MATCH_FILL, PLAYER_COUNT_OPTIONS,
  DEFAULT_START_CASH, DEFAULT_DURATION_SEC,
  COUNTDOWN_SEC, QUICK_MATCH_WAIT_MS, RECONNECT_GRACE_MS, ACCOUNT_PUSH_EVERY,
  LOT_SIZE, LIMIT_PCT, LIMIT_PCT_20, FEE,
  MAX_ORDERS_PER_PLAYER, MAX_TRADES_KEEP, IMPACT_K,
  FAIR_VOL, ANCHOR_K, FAIR_ANCHOR_QUAD, EXTERNAL_FLOW_P, EXTERNAL_FLOW_K,
  DEPTH_PER_PLAYER, DEPTH_MAX_MULT, IMPACT_CLAMP, IMPACT_PER_CALL, IMPACT_DECAY,
  ELO_START, ELO_K, TIERS, BOT_NAMES, AVATARS,
  STOCKS, SECTORS, INDICES, isWideLimit, limitPrices,
  MAX_CHAT_LEN, HEARTBEAT_MS, RATE_LIMIT_PER_SEC,
};
