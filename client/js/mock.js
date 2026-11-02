/* ═══════════════════════════════════════════════════════════════════════════
   同花亏 · mock.js —— 前端假服务端 MockNet
   ───────────────────────────────────────────────────────────────────────────
   真实服务端还没写，本文件在浏览器里扮演「完全遵守 PROTOCOL.md v1.0」的服务端：
   行情引擎 / 撮合引擎 / 账户 / 排行 / 新闻 / 房间 / 结算 全部本地实现。
   切换真实服务端时，main.js 只需把 `new MockNet(...)` 换成 `new NetClient(...)`。

   对外接口与 NetClient 完全一致（DESIGN.md §4.3 / §4.7）：
     constructor(state, options) / connect(url) / send(t, fields)
     on(type, fn) -> off() / request(t, fields, matchType, timeoutMs)
     close() / get connected()
   ═══════════════════════════════════════════════════════════════════════════ */

import { uid } from './util.js';
import { touch } from './store.js';

/* ═══════════════ 0. 常量（与 PROTOCOL.md / config 对齐） ═══════════════ */

const SERVER = '同花亏';
const VERSION = '1.0.0';
const BASE_TICK_MS = 1000;
/* ── 时间节奏（与 server/src/config.js 对齐）──
   1 个虚拟分钟 = VIRTUAL_MINUTE_TICKS 个 tick = 5 秒真实时间；
   1 个虚拟交易日 = 120 个虚拟分钟 = 上午盘 09:30-11:30（10 分钟真实时间）；
   每个交易日结束后 BREAK_SEC 秒「午间休市」（行情冻结，下一天 09:30 开盘）。 */
const VIRTUAL_DAY_TICKS = 120;          // 一个虚拟交易日 = 120 个虚拟分钟
const VIRTUAL_MINUTE_TICKS = 5;         // 每 5 个 tick 推进 1 个虚拟分钟
const BREAK_SEC = 60;                   // 日切后的午间休市（真实秒）
const LOT_SIZE = 100;
const DAY_MS = 86400000;
const MORNING_OPEN = 570;               // 09:30（开盘）
                        // 收盘 = MORNING_OPEN + VIRTUAL_DAY_TICKS = 11:30
const MAX_NEWS = 50;
const MAX_EQUITY = 400;

const FEE = {
  commissionRate: 0.00025,
  commissionMin: 5,
  stampTax: 0.0005,
  transferFee: 0.00001,
};

const MODES = [
  { id: '1v1', name: '1v1 单挑', maxPlayers: 2 },
  { id: 'ffa', name: '多人混战', maxPlayers: 30 },
  { id: 'team', name: '红蓝团战', maxPlayers: 30 },
];

const DURATIONS = [
  { sec: 900, name: '标准 15 分钟（约 1.5 个交易日）' },
  { sec: 1800, name: '长线 30 分钟（约 2.7 个交易日）' },
  { sec: 2700, name: '马拉松 45 分钟（约 4 个交易日）' },
];

const START_CASH_OPTIONS = [100000, 1000000, 5000000];

const AVATARS = ['🐂', '🐻', '🐷', '🐔', '🦆', '🐸', '🐵', '🐯', '🦊', '🐼', '🦄', '👽'];

/* 20 只虚构股票：A 股风格假代码 + 搞笑仿名 + 板块 + 拼音（搜索用） */
const STOCK_DEFS = [
  { id: '600519', name: '贵州毛台', sector: '白酒', base: 1680.00, pe: 31.2, floatMv: 2.10e12, vpm: 38000, py: 'guizhoumaotai gzmt' },
  { id: '000858', name: '五粮溢', sector: '白酒', base: 142.50, pe: 18.4, floatMv: 5.53e11, vpm: 210000, py: 'wuliangyi wly' },
  { id: '300750', name: '宁德世贷', sector: '新能源', base: 268.60, pe: 24.6, floatMv: 1.18e12, vpm: 180000, py: 'ningdeshidai ndsd' },
  { id: '002594', name: '比亚帝', sector: '新能源', base: 245.80, pe: 21.3, floatMv: 7.10e11, vpm: 150000, py: 'biyadi byd' },
  { id: '688981', name: '中芯国记', sector: '半导体', base: 88.60, pe: 88.2, floatMv: 4.60e11, vpm: 260000, py: 'zhongxinguoji zxgj' },
  { id: '000725', name: '京东房', sector: '半导体', base: 9.80, pe: 42.0, floatMv: 3.70e11, vpm: 1800000, py: 'jingdongfang jdf' },
  { id: '600276', name: '恒瑞医要', sector: '医药', base: 46.20, pe: 55.1, floatMv: 2.95e11, vpm: 220000, py: 'hengruiyiyao hryy' },
  { id: '300760', name: '迈瑞医辽', sector: '医药', base: 288.50, pe: 38.9, floatMv: 2.40e11, vpm: 45000, py: 'mairuiyiliao mryl' },
  { id: '000002', name: '万客A', sector: '地产', base: 8.65, pe: 6.8, floatMv: 1.02e11, vpm: 1500000, py: 'wankeA wk' },
  { id: '600036', name: '招商银航', sector: '金融', base: 36.40, pe: 6.2, floatMv: 9.20e11, vpm: 420000, py: 'zhaoshangyinhang zsyh' },
  { id: '601318', name: '中国平鞍', sector: '金融', base: 48.70, pe: 8.9, floatMv: 8.90e11, vpm: 380000, py: 'zhongguopingan zgpa' },
  { id: '600030', name: '中信证拳', sector: '金融', base: 22.60, pe: 15.4, floatMv: 3.30e11, vpm: 600000, py: 'zhongxinzhengquan zxzq' },
  { id: '601012', name: '隆基绿熊', sector: '光伏', base: 21.30, pe: 19.8, floatMv: 1.60e11, vpm: 700000, py: 'longjilvxiong ljlx' },
  { id: '300274', name: '阳光电原', sector: '光伏', base: 92.40, pe: 22.1, floatMv: 1.40e11, vpm: 180000, py: 'yangguangdianyuan ygdy' },
  { id: '600887', name: '伊利股分', sector: '食品', base: 28.90, pe: 17.6, floatMv: 1.80e11, vpm: 400000, py: 'yiligufen ylgf' },
  { id: '603288', name: '海天味液', sector: '食品', base: 38.50, pe: 34.2, floatMv: 2.10e11, vpm: 120000, py: 'haitianweiye htwy' },
  { id: '002415', name: '海康威仕', sector: '安防', base: 31.70, pe: 20.5, floatMv: 3.10e11, vpm: 300000, py: 'haikangweishi hkws' },
  { id: '600893', name: '中航神飞', sector: '军工', base: 45.80, pe: 62.3, floatMv: 1.20e11, vpm: 160000, py: 'zhonghangshenfei zhsf' },
  { id: '002230', name: '科大迅飞', sector: '人工智能', base: 47.60, pe: 78.4, floatMv: 1.10e11, vpm: 280000, py: 'kedaxunfei kdxf' },
  { id: '688256', name: '寒武记', sector: '人工智能', base: 218.00, pe: 320.5, floatMv: 9.10e10, vpm: 60000, py: 'hanwuji hwj' },
  /* 妖股：商业板块独苗，波动大、上蹿下跳、容易涨停/跌停 */
  { id: '600173', name: '卧龙商射', sector: '商业', base: 12.88, prevClose: 12.88,
    pe: 88.8, floatMv: 2.06e10, vpm: 900000, py: 'wolongshangshe wlss',
    sigma: 0.0055, drift: 0.00012, beta: 1.6, surgeP: 0.006, surgeMag: 1.7 },

  /* ───── 纳斯达克板块（美股：宽幅 ±30%，波动更大）───── */
  { id: 'NVDA', name: '英卫达', sector: '纳指芯片', market: 'us', limitPct: 0.30, base: 128.60, pe: 62.4, floatMv: 3.09e12, vpm: 420000, py: 'yingweida nvda', sigma: 0.0062, drift: 0.00016, beta: 1.85, surgeP: 0.004 },
  { id: 'AMD', name: '超威半导', sector: '纳指芯片', market: 'us', limitPct: 0.30, base: 162.30, pe: 45.8, floatMv: 2.60e11, vpm: 260000, py: 'chaoweibandao amd', sigma: 0.0056, drift: 0.00010, beta: 1.70 },
  { id: 'AAPL', name: '苹果梨', sector: '纳指科技', market: 'us', limitPct: 0.30, base: 226.80, pe: 34.2, floatMv: 3.40e12, vpm: 300000, py: 'pingguoli aapl', sigma: 0.0030, drift: 0.00008, beta: 1.15 },
  { id: 'MSFT', name: '微硬', sector: '纳指科技', market: 'us', limitPct: 0.30, base: 418.50, pe: 36.5, floatMv: 3.10e12, vpm: 180000, py: 'weiying msft', sigma: 0.0028, drift: 0.00009, beta: 1.10 },
  { id: 'GOOGL', name: '谷哥', sector: '纳指科技', market: 'us', limitPct: 0.30, base: 172.40, pe: 24.8, floatMv: 1.90e12, vpm: 220000, py: 'guge googl', sigma: 0.0034, drift: 0.00008, beta: 1.25 },
  { id: 'META', name: '元宝', sector: '纳指科技', market: 'us', limitPct: 0.30, base: 512.70, pe: 27.6, floatMv: 1.28e12, vpm: 140000, py: 'yuanbao meta', sigma: 0.0040, drift: 0.00012, beta: 1.40 },
  { id: 'TSLA', name: '特撕拉', sector: '纳指新势力', market: 'us', limitPct: 0.30, base: 248.90, pe: 71.3, floatMv: 7.96e11, vpm: 340000, py: 'tesila tsla', sigma: 0.0070, drift: 0.00014, beta: 2.00, surgeP: 0.005 },
  { id: 'AMZN', name: '亚马孙', sector: '纳指新势力', market: 'us', limitPct: 0.30, base: 186.20, pe: 38.9, floatMv: 1.86e12, vpm: 240000, py: 'yamasun amzn', sigma: 0.0036, drift: 0.00010, beta: 1.30 },
  { id: 'NFLX', name: '奈非', sector: '纳指新势力', market: 'us', limitPct: 0.30, base: 682.40, pe: 42.1, floatMv: 2.93e11, vpm: 90000, py: 'naifei nflx', sigma: 0.0044, drift: 0.00012, beta: 1.45 },
  { id: 'COIN', name: '币安所', sector: '纳指新势力', market: 'us', limitPct: 0.30, base: 178.30, pe: 55.7, floatMv: 4.46e10, vpm: 160000, py: 'biansuo coin', sigma: 0.0090, drift: 0.00020, beta: 2.30, surgeP: 0.006, surgeMag: 1.8 },

  /* ───── 社团概念股（30 只）───── */
  { id: '300413', name: '推理社文化', sector: '文体传媒', base: 26.80, pe: 48.6, floatMv: 3.22e+10, vpm: 36000, py: 'tuilishe tls', sigma: 0.0044, drift: 6e-05, beta: 1.45 },
  { id: '300251', name: '戏剧舞蹈文化', sector: '文体传媒', base: 12.36, pe: 62.3, floatMv: 2.22e+10, vpm: 54000, py: 'xijuwudao xjwd', sigma: 0.004, drift: 3e-05, beta: 1.3 },
  { id: '002739', name: '星工坊传媒', sector: '文体传媒', base: 18.90, pe: 55.1, floatMv: 2.83e+10, vpm: 45000, py: 'xinggongfang xgf', sigma: 0.0042, drift: 5e-05, beta: 1.35 },
  { id: '300661', name: '晓组织动漫', sector: '文体传媒', base: 33.44, pe: 78.2, floatMv: 3.01e+10, vpm: 27000, py: 'xiaozuzhi xzz', sigma: 0.005, drift: 8e-05, beta: 1.55 },
  { id: '002174', name: '像素重构游戏', sector: '文体传媒', base: 15.72, pe: 41.7, floatMv: 2.04e+10, vpm: 39000, py: 'xiangsuzhonggou xszg', sigma: 0.0048, drift: 7e-05, beta: 1.5 },
  { id: '300364', name: '虚拟真实传媒', sector: '文体传媒', base: 21.05, pe: 51.4, floatMv: 2.32e+10, vpm: 33000, py: 'xunizhenshi xnm', sigma: 0.0046, drift: 6e-05, beta: 1.42 },
  { id: '002678', name: '足球社体育', sector: '体育产业', base: 9.86, pe: 33.5, floatMv: 2.37e+10, vpm: 72000, py: 'zuqiushe zqs', sigma: 0.0038, drift: 2e-05, beta: 1.2 },
  { id: '605299', name: '乒羽联盟体育', sector: '体育产业', base: 14.28, pe: 29.8, floatMv: 2.28e+10, vpm: 48000, py: 'pingyulianmeng pylm', sigma: 0.0036, drift: 3e-05, beta: 1.18 },
  { id: '300005', name: '健身社健康', sector: '体育产业', base: 7.45, pe: 44.2, floatMv: 2.09e+10, vpm: 84000, py: 'jianshenshe jss', sigma: 0.004, drift: 2e-05, beta: 1.25 },
  { id: '002878', name: '健将起航体育', sector: '体育产业', base: 11.63, pe: 36.9, floatMv: 2.33e+10, vpm: 60000, py: 'jianjiangqihang jjqh', sigma: 0.0039, drift: 3e-05, beta: 1.22 },
  { id: '603886', name: '苹果派食品', sector: '食品餐饮', base: 17.55, pe: 27.6, floatMv: 2.46e+10, vpm: 42000, py: 'pingguopai pgp', sigma: 0.0034, drift: 4e-05, beta: 1.1 },
  { id: '605337', name: '烘焙社食品', sector: '食品餐饮', base: 22.19, pe: 31.2, floatMv: 1.89e+10, vpm: 26000, py: 'hongbeishe hbs', sigma: 0.0036, drift: 5e-05, beta: 1.15 },
  { id: '605108', name: '食艺阁餐饮', sector: '食品餐饮', base: 28.70, pe: 39.4, floatMv: 2.07e+10, vpm: 22000, py: 'shiyige syg', sigma: 0.0037, drift: 4e-05, beta: 1.12 },
  { id: '603711', name: '茶艺社茶业', sector: '食品餐饮', base: 13.44, pe: 24.8, floatMv: 2.55e+10, vpm: 57000, py: 'chayishe cys', sigma: 0.0033, drift: 3e-05, beta: 1.05 },
  { id: '601828', name: '解忧杂货零售', sector: '商贸零售', base: 6.35, pe: 19.7, floatMv: 2.67e+10, vpm: 126000, py: 'jieyouzahuopu jyzhp', sigma: 0.0035, drift: 1e-05, beta: 1.08 },
  { id: '600704', name: '泰坦商社控股', sector: '商贸零售', base: 8.92, pe: 14.3, floatMv: 2.77e+10, vpm: 93000, py: 'taitanshangshe tts', sigma: 0.0033, drift: 2e-05, beta: 1.16 },
  { id: '600612', name: '青玉案珠宝', sector: '时尚消费', base: 42.66, pe: 46.8, floatMv: 2.90e+10, vpm: 20000, py: 'qingyuan qya', sigma: 0.0042, drift: 6e-05, beta: 1.3 },
  { id: '603983', name: '多元彩韵美妆', sector: '时尚消费', base: 35.18, pe: 52.9, floatMv: 1.90e+10, vpm: 20000, py: 'duoyuancaiyun dycy', sigma: 0.0044, drift: 7e-05, beta: 1.38 },
  { id: '600626', name: '不织布新材', sector: '时尚消费', base: 5.88, pe: 28.4, floatMv: 1.53e+10, vpm: 78000, py: 'buzhibu bzb', sigma: 0.004, drift: 2e-05, beta: 1.2 },
  { id: '000726', name: '编织社纺织', sector: '时尚消费', base: 4.72, pe: 16.2, floatMv: 1.65e+10, vpm: 105000, py: 'bianzhishe bzs', sigma: 0.0036, drift: 1e-05, beta: 1.05 },
  { id: '300888', name: '安妮潮玩', sector: '时尚消费', base: 58.30, pe: 88.5, floatMv: 2.68e+10, vpm: 20000, py: 'annichaowan acw', sigma: 0.0056, drift: 0.00012, beta: 1.62 },
  { id: '603136', name: '星空手作文创', sector: '文创服务', base: 24.15, pe: 43.6, floatMv: 2.32e+10, vpm: 29000, py: 'xingkongshouzuo xksz', sigma: 0.004, drift: 4e-05, beta: 1.22 },
  { id: '002137', name: '梦想家影像', sector: '文创服务', base: 16.88, pe: 58.7, floatMv: 2.03e+10, vpm: 36000, py: 'mengxiangjia mxy', sigma: 0.0041, drift: 5e-05, beta: 1.28 },
  { id: '000888', name: '平行人生文旅', sector: '文创服务', base: 19.62, pe: 61.4, floatMv: 2.75e+10, vpm: 42000, py: 'pingxingrensheng pxrs', sigma: 0.0043, drift: 6e-05, beta: 1.32 },
  { id: '600661', name: '法语社教育', sector: '文创服务', base: 12.90, pe: 47.2, floatMv: 2.19e+10, vpm: 51000, py: 'fayushe fys', sigma: 0.0039, drift: 2e-05, beta: 1.15 },
  { id: '003032', name: 'STEM教育', sector: '文创服务', base: 27.35, pe: 66.8, floatMv: 2.19e+10, vpm: 24000, py: 'stemjiaoyu stem', sigma: 0.0046, drift: 7e-05, beta: 1.4 },
  { id: '300070', name: '灯塔环保', sector: '公共事业', base: 6.88, pe: 21.5, floatMv: 2.27e+10, vpm: 99000, py: 'dengtahuanbao dthb', sigma: 0.0034, drift: 1e-05, beta: 1.02 },
  { id: '600763', name: '红十字医疗', sector: '公共事业', base: 44.20, pe: 37.9, floatMv: 4.86e+10, vpm: 33000, py: 'hongshizi hsz', sigma: 0.0038, drift: 4e-05, beta: 1.18 },
  { id: '600760', name: '心向蓝天航空', sector: '航空制造', base: 38.75, pe: 49.3, floatMv: 5.04e+10, vpm: 39000, py: 'xinxianglantian xxlt', sigma: 0.0042, drift: 5e-05, beta: 1.35 },
  { id: '600160', name: '化世界新材', sector: '新材料', base: 10.55, pe: 25.6, floatMv: 2.32e+10, vpm: 66000, py: 'huashijie hsj', sigma: 0.004, drift: 3e-05, beta: 1.24 },
];

const BOT_NAMES = ['追高侠', '涨停敢死队', '徐翔的小号', '满仓踏空哥', '关灯吃面', '抄底の王', '杠上开花', '梭哈艺术家'];

const BOT_CHAT = ['冲！', '稳住，别慌', '我梭哈了', '这也能跌？', '别追高，会死的', '跟着主力走', '割了割了', '加仓！加仓！', 'T+1 真难受', '明天就回本', '主力在洗盘', '我闻到牛市的味道了'];

/* 新闻模板（标题要有梗、要像真快讯） */
const NEWS_TPL = [
  { level: 'hot', predict: '利多', scope: 'sector',
    title: (d) => `【板块异动】${d.sector}板块集体拉升，${d.stock}涨幅扩大至 ${d.n1}%`,
    body: (d) => `${d.clock} 讯，${d.sector}板块盘中直线走强，资金持续净流入，${d.stock}放量上攻带动板块内多只个股跟涨。有市场人士表示，短线情绪明显回暖，但需警惕高位分歧。` },
  { level: 'hot', predict: '利空', scope: 'sector',
    title: (d) => `【突发】${d.sector}板块集体跳水，${d.stock}一度跌停`,
    body: (d) => `${d.clock} 讯，${d.sector}板块突然放量下挫，${d.stock}盘中一度触及跌停板，板块内超半数个股翻绿。消息面上暂未有明确利空，市场猜测与机构调仓有关。` },
  { level: 'info', predict: '利多', scope: 'stock',
    title: (d) => `【公司公告】${d.stock}拟回购不超过 10 亿元股份用于员工持股计划`,
    body: (d) => `${d.clock} 讯，${d.stock}发布公告称，基于对公司未来发展的信心，拟以自有资金回购公司股份，回购价格不超过董事会决议前 30 个交易日均价的 150%。` },
  { level: 'info', predict: '利多', scope: 'stock',
    title: (d) => `【业绩预告】${d.stock}预计上半年净利润同比增长 180%~220%`,
    body: (d) => `${d.clock} 讯，${d.stock}披露业绩预告，报告期内主营业务收入大幅增长，毛利率同比提升，预计实现归母净利润同比翻倍以上。` },
  { level: 'warn', predict: '利空', scope: 'stock',
    title: (d) => `【风险提示】${d.stock}连续三日涨幅偏离值累计超 20%，交易所下发关注函`,
    body: (d) => `${d.clock} 讯，${d.stock}因近期股价涨幅较大，收到交易所关注函，要求公司说明是否存在应披露而未披露的重大事项，并提示投资者注意二级市场交易风险。` },
  { level: 'info', predict: '利多', scope: 'sector',
    title: (d) => `【政策速递】国家大基金三期加码${d.sector}，产业链公司集体异动`,
    body: (d) => `${d.clock} 讯，多地出台产业扶持细则，重点支持${d.sector}关键环节国产化替代，产业链上市公司订单能见度提升。` },
  { level: 'info', predict: 'neutral', scope: 'market',
    title: (d) => `【宏观快讯】央行开展 5000 亿元 MLF 操作，市场流动性保持宽松`,
    body: (d) => `${d.clock} 讯，央行公告称，为维护银行体系流动性合理充裕，当日开展中期借贷便利操作，中标利率维持不变。` },
  { level: 'hot', predict: '利多', scope: 'stock',
    title: (d) => `【资金流向】北向资金大幅净买入${d.sector}龙头${d.stock}`,
    body: (d) => `${d.clock} 讯，沪深港通数据显示，${d.stock}获北向资金净买入居前，近 5 个交易日累计净买入持续放大，机构席位亦出现在龙虎榜买方前列。` },
  { level: 'warn', predict: '利空', scope: 'stock',
    title: (d) => `【市场传闻】${d.stock}遭大股东减持 2% 股份，套现约 ${d.n2} 亿元`,
    body: (d) => `${d.clock} 讯，${d.stock}公告显示，持股 5% 以上股东通过大宗交易方式减持公司股份，减持计划尚未实施完毕。` },
  { level: 'info', predict: 'neutral', scope: 'market',
    title: (d) => `【海外市场】隔夜纳指收涨 2.3%，${d.sector}板块开盘走强`,
    body: (d) => `${d.clock} 讯，隔夜美股三大指数集体收涨，科技股领涨。受此影响，A 股${d.sector}板块早盘高开。` },
  { level: 'hot', predict: '利多', scope: 'stock',
    title: (d) => `【吃瓜】${d.stock}董事长业绩会怒斥空头：你们根本不懂${d.sector}`,
    body: (d) => `${d.clock} 讯，在昨日举行的业绩说明会上，${d.stock}董事长回应股价质疑时情绪激动，称公司基本面没有任何问题，并当场宣布增持计划。` },
  { level: 'info', predict: 'neutral', scope: 'market',
    title: (d) => `【午间播报】三大指数集体翻红，${d.sector}领涨，韭菜情绪回暖`,
    body: (d) => `${d.clock} 讯，截至午间收盘，两市合计成交额较昨日放量明显，${d.sector}板块涨幅居前，市场赚钱效应有所恢复。` },
  { level: 'warn', predict: '利空', scope: 'sector',
    title: (d) => `【监管动态】${d.sector}板块多家公司收到问询函，注意炒作风险`,
    body: (d) => `${d.clock} 讯，监管部门就近期${d.sector}板块股价异动情况向多家公司下发问询函，要求说明业绩与股价的匹配性。` },
  { level: 'info', predict: '利多', scope: 'stock',
    title: (d) => `【机构调研】${d.stock}接待 87 家机构调研，称在手订单饱满`,
    body: (d) => `${d.clock} 讯，${d.stock}披露投资者关系活动记录表，公司表示当前产能利用率维持高位，新增订单同比大幅增长。` },
  { level: 'info', predict: 'neutral', scope: 'market',
    title: (d) => `【数据速览】${d.sector}行业景气度回升，8 月出货量同比 +37%`,
    body: (d) => `${d.clock} 讯，第三方机构发布最新行业数据，${d.sector}产业链整体出货量同比明显改善，价格企稳回升。` },
  /* —— 妖股「卧龙商射」专属快讯（weight 更低，偶尔点名） —— */
  { level: 'hot', predict: '利多', scope: 'named', stockId: '600173', weight: 1,
    title: (d) => `【龙虎榜】${d.stock}获知名游资买入 1.2 亿，股价直线封板`,
    body: (d) => `${d.clock} 讯，盘后龙虎榜数据显示，知名游资席位大举买入${d.stock}，买入金额达 1.2 亿元。该股今日放量涨停，换手率显著放大，市场情绪亢奋。` },
  { level: 'warn', predict: '利空', scope: 'named', stockId: '600173', weight: 1,
    title: (d) => `【风险提示】${d.stock}连续三日大涨，公司称不存在应披露未披露事项`,
    body: (d) => `${d.clock} 讯，${d.stock}发布股票交易异常波动公告，称公司目前生产经营正常，不存在应披露而未披露的重大事项，敬请投资者注意二级市场炒作风险。` },
];

/* ═══════════════ 1. 小工具 ═══════════════ */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const round4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

/* Node 18 环境没有全局 CustomEvent，做一次兜底（浏览器永远走原生分支） */
const CustomEv = (typeof CustomEvent !== 'undefined')
  ? CustomEvent
  : class CustomEventPolyfill extends Event {
    constructor(type, init) { super(type); this.detail = init && init.detail; }
  };

function mulberry32(a) {
  let s = a >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ELO → 段位（PROTOCOL §3.8） */
function tierOf(elo) {
  const e = Number(elo) || 0;
  if (e >= 1800) return '王者';
  if (e >= 1600) return '钻石';
  if (e >= 1400) return '铂金';
  if (e >= 1200) return '黄金';
  if (e >= 1000) return '白银';
  return '青铜';
}

/** 虚拟分钟序号 → 当天交易时钟的分钟数（09:30 起算；新节奏只有上午盘 09:30-11:30） */
function clockMinutes(m) {
  return MORNING_OPEN + clamp(Math.floor(Number(m) || 0), 0, VIRTUAL_DAY_TICKS - 1);
}
function hhmm(minutes) { return pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60); }

/** 手续费：佣金 max(额×0.00025, 5) + 印花税（卖）+ 过户费（双向） */
function feeOf(side, amount) {
  const amt = Math.max(0, Number(amount) || 0);
  let f = Math.max(amt * FEE.commissionRate, FEE.commissionMin) + amt * FEE.transferFee;
  if (side === 'sell') f += amt * FEE.stampTax;
  return round2(f);
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function parseQuery() {
  const out = {};
  try {
    const search = (typeof location !== 'undefined' && location.search) ? location.search : '';
    new URLSearchParams(search).forEach((v, k) => { out[k] = v; });
  } catch (e) { /* ignore */ }
  return out;
}

/* ═══════════════ 2. MockNet ═══════════════ */

export class MockNet extends EventTarget {
  /**
   * @param {object} state   store.js 的 state 单例
   * @param {object} options { nick, avatar, auto, bootView, seed, tickMs, speed }
   */
  constructor(state, options = {}) {
    super();
    this.state = state || {};
    this.options = options || {};
    const q = parseQuery();
    this.params = q;

    /* ── 运行参数 ── */
    this.seed = Number(q.seed || this.options.seed || 20240924) || 20240924;
    this.rnd = mulberry32(this.seed);
    this.baseTickMs = BASE_TICK_MS;
    this.speedX = clamp(Number(q.speed || this.options.speed || 1) || 1, 0.01, 60);
    this.tickMs = clamp(Number(this.options.tickMs) || Math.round(BASE_TICK_MS / this.speedX), 30, 3600000);
    this.countdownMs = 1000;

    /* ── 连接 / 会话 ── */
    this.connectedFlag = true;
    this.loggedIn = false;
    this.player = null;
    this.token = null;
    this.avatar = Number(this.options.avatar || q.avatar || 3) || 3;
    this.nick = this.options.nick || q.nick || '韭菜甲';

    /* ── 时间 / 行情 ── */
    this.seq = 0;
    this.dayIndex = 0;
    this.minuteOfDay = 59;                 // 开盘前已有 60 根历史（00..59）
    this.baseDay = startOfToday();         // “今天” 00:00
    this.histDay0 = this.baseDay - 5 * DAY_MS;

    /* ── 对局 / 房间 ── */
    this.match = null;
    this.playing = false;
    this.room = null;
    this.rooms = new Map();
    this.bots = [];
    this.endsAt = 0;
    this.breakUntil = 0;                   // 午间休市结束时间戳（0 = 不在休市）
    this.breakLeftSec = 0;                 // 休市剩余秒数（每秒广播一次）

    /* ── 账户 ── */
    this.startCash = 1000000;
    this.acct = null;

    /* ── 计时器 ── */
    this._timers = new Set();
    this._interval = null;
    this._orderSeq = 0;
    this._tradeSeq = 0;
    this._newsSeq = 0;
    this._nextNewsSeq = 9;
    this._forceFillsThisTick = false;
    this._quiet = false;
    this._chatSeq = 0;

    /* 自动行为：bootView=trade/lobby/result 或 auto=1 时自动登录 */
    const boot = this.options.bootView || q.view || null;
    this.bootView = boot;
    this.wantAuto = !!(this.options.auto || q.auto === '1');
    this.autoLogin = this.wantAuto || boot === 'trade' || boot === 'lobby' || boot === 'result';

    /* 构建世界（同步，很快） */
    this._initState();
    this._buildMarket();
    this._buildHistory();
    this._buildAccount(this.startCash);
    this._initLobbyRooms();

    /* 调试接口 */
    if (typeof window !== 'undefined') window.__mock = this;
  }

  /** 兜底：保证 state 里协议要用到的容器都存在（main.js 也用的是同一个 store 单例） */
  _initState() {
    const S = this.state;
    if (!S.lobby) S.lobby = { rooms: [] };
    if (!(S.stocks instanceof Map)) S.stocks = new Map();
    if (!(S.quotes instanceof Map)) S.quotes = new Map();
    if (!(S.klines instanceof Map)) S.klines = new Map();
    if (!(S.timeshare instanceof Map)) S.timeshare = new Map();
    if (!Array.isArray(S.chat)) S.chat = [];
    if (!Array.isArray(S.news)) S.news = [];
    if (!Array.isArray(S.rank)) S.rank = [];
    if (!Array.isArray(S.indices)) S.indices = [];
    if (!S.ui) S.ui = { stockId: null, tf: '1d', dark: false, orderSide: 'buy', bottomTab: 'positions', boardTab: 'quote', topTab: 'trade', search: '' };
    if (!S.vclock) S.vclock = '--:--';
  }

  /* ══════════════ 2.1 对外契约（与 NetClient 完全一致） ══════════════ */

  connect(url) {
    this.url = url || this.url;
    this.connectedFlag = true;
    this._later(() => {
      if (!this.connectedFlag) return;
      this.emit('welcome', {
        t: 'welcome', server: SERVER, version: VERSION,
        serverTime: Date.now(), tickMs: this.tickMs, online: this._online(),
      });
      this._syncState({ connected: true, online: this._online() });
      if (this.autoLogin && !this.loggedIn) {
        this.send('login', { nick: this.nick, avatar: this.avatar });
      }
    }, 0);
    return this;
  }

  get connected() { return this.connectedFlag; }

  close() {
    this.connectedFlag = false;
    this.playing = false;
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    try { this.dispatchEvent(new CustomEv('close', { detail: { code: 1000, reason: 'client close' } })); } catch (e) { /* ignore */ }
  }

  /** 派发一条服务端消息（真实报文对象，含 t 字段） */
  emit(type, payload) {
    if (this._quiet && type !== 'game:start' && type !== 'game:over') return;
    if (type !== 'welcome' && payload && payload.t !== type) payload.t = type;
    try { this.dispatchEvent(new CustomEv(type, { detail: payload })); } catch (e) { console.error('[mock] dispatch', type, e); }
    try { this.dispatchEvent(new CustomEv('*', { detail: payload })); } catch (e) { /* ignore */ }
  }

  on(type, fn) {
    const wrapped = (ev) => fn(ev.detail);
    this.addEventListener(type, wrapped);
    return () => this.removeEventListener(type, wrapped);
  }

  request(t, fields = {}, matchType = null, timeoutMs = 5000) {
    const reqId = fields.reqId || uid('c');
    return new Promise((resolve, reject) => {
      const offs = [];
      const cleanup = () => { clearTimeout(timer); for (const off of offs) off(); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('请求超时：' + t)); }, timeoutMs);
      offs.push(this.on('*', (msg) => {
        if (!msg || msg.reqId !== reqId) return;
        if (matchType && msg.t !== matchType) return;
        cleanup();
        resolve(msg);
      }));
      this.send(t, Object.assign({}, fields, { reqId }));
    });
  }

  /* ══════════════ 2.2 上行消息分发（PROTOCOL §1 全部） ══════════════ */

  send(t, fields = {}) {
    const f = fields || {};
    switch (t) {
      case 'login': return this._onLogin(f);
      case 'lobby:list': return this._onLobbyList(f);
      case 'room:create': return this._onRoomCreate(f);
      case 'room:join': return this._onRoomJoin(f);
      case 'room:quick': return this._onRoomQuick(f);
      case 'room:leave': return this._onRoomLeave();
      case 'room:ready': return this._onRoomReady(f);
      case 'room:start': return this._onRoomStart();
      case 'room:chat': return this._onChat(f);
      case 'kline:get': return this._onKlineGet(f);
      case 'ai:advice': return this._onAiAdvice(f);
      case 'room:kick': return this._onRoomKick(f);
      case 'order:place': return this._onOrderPlace(f);
      case 'order:cancel': return this._onOrderCancel(f);
      case 'ping': return this._onPing(f);
      default:
        this._err('BAD_REQUEST', `未知消息类型：${t}`, f.reqId);
    }
  }

  /* ══════════════ 2.3 股票池 / 历史数据 ══════════════ */

  _buildMarket() {
    this.market = new Map();
    this.secF = new Map();
    this.limitPctOf = new Map();
    for (const d of STOCK_DEFS) {
      this.secF.set(d.sector, 0);
      const limitPct = Number.isFinite(d.limitPct) ? d.limitPct
        : (d.id.startsWith('30') || d.id.startsWith('68')) ? 0.20 : 0.10;
      this.limitPctOf.set(d.id, limitPct);
      const sigma = Number.isFinite(d.sigma) ? d.sigma : clamp(0.0009 + 0.021 / Math.sqrt(d.base), 0.0009, 0.0038);
      const pc = round2(d.base);
      this.market.set(d.id, {
        id: d.id, name: d.name, sector: d.sector, pinyin: d.py,
        pe: d.pe, floatMv: d.floatMv, lotSize: LOT_SIZE, vpm: d.vpm,
        base: d.base, limitPct, sigma,
        beta: Number.isFinite(d.beta) ? d.beta : 0.60 + this.rnd() * 0.90,
        drift: Number.isFinite(d.drift) ? d.drift : (this.rnd() - 0.5) * 0.00012,
        mr: 0.0008 + this.rnd() * 0.0018,
        surgeP: Number.isFinite(d.surgeP) ? d.surgeP : 0.0016,
        surgeMag: Number.isFinite(d.surgeMag) ? d.surgeMag : 1,
        prevCloseFixed: Number.isFinite(d.prevClose) ? Number(d.prevClose) : null,
        fair: d.base,
        prevClose: pc, p: round2(d.base),
        limitUp: round2(pc * (1 + limitPct)),
        limitDown: round2(pc * (1 - limitPct)),
        shock: 0, surge: 0, impact: 0,
        b: [], s: [], tr: [],
        day: { o: pc, h: pc, l: pc, v: 0, a: 0 },
        dayInit: null,
        lastMinuteClose: round2(d.base),
        hist: null,
      });
    }
    this.stockIds = Array.from(this.market.keys());
    this.sectors = Array.from(new Set(STOCK_DEFS.map((d) => d.sector)));
    this.metaList = this.stockIds.map((id) => this.metaOf(id));
  }

  metaOf(id) {
    const st = this.market.get(id);
    return {
      id: st.id, name: st.name, sector: st.sector, pinyin: st.pinyin,
      prevClose: st.prevClose, limitUp: st.limitUp, limitDown: st.limitDown,
      lotSize: st.lotSize, pe: st.pe, floatMv: st.floatMv,
    };
  }

  _tickTs(overallIndex) {
    const d = Math.floor(overallIndex / VIRTUAL_DAY_TICKS);
    const m = overallIndex % VIRTUAL_DAY_TICKS;
    return this.histDay0 + d * DAY_MS + clockMinutes(m) * 60000;
  }

  /** 预生成历史：1d(120 根) / 1m / 5m / 15m + 分时 60 个历史点 */
  _buildHistory() {
    const TOTAL = VIRTUAL_DAY_TICKS * 5 + 60;   // 5 个整日 + 今日 60 分钟
    for (const st of this.market.values()) {
      /* —— 分钟价格路径（终点 = base，保证与当前价连续） —— */
      const rets = new Float64Array(TOTAL);
      let f = 1;
      const cum = new Float64Array(TOTAL);
      for (let i = 0; i < TOTAL; i++) {
        let r = this._randn() * st.sigma * 0.92 + st.drift;
        if (i % VIRTUAL_DAY_TICKS === 0) r += this._randn() * st.sigma * 2.2;   // 隔夜跳空
        rets[i] = r;
        f *= (1 + r);
        cum[i] = f;
      }
      const scale0 = st.base / f;
      let scale = scale0;
      /* 若股票定义了固定昨收（如卧龙商射 12.88），整体缩放使「昨日最后一分钟收盘」精确等于它 */
      if (st.prevCloseFixed) {
        const pathPrev = cum[TOTAL - 61] * scale0;
        if (pathPrev > 0) scale = scale0 * (st.prevCloseFixed / pathPrev);
      }
      const px = (i) => Math.max(0.01, cum[i] * scale);
      /* 用真实价格重算收益率（缩放后） */
      const bars1m = [];
      for (let i = 0; i < TOTAL; i++) {
        const c = px(i);
        const o = i === 0 ? c : px(i - 1);
        const hi = Math.max(o, c) * (1 + Math.abs(this._randn()) * st.sigma * 0.55);
        const lo = Math.min(o, c) * (1 - Math.abs(this._randn()) * st.sigma * 0.55);
        const vol = Math.max(100, Math.round(st.vpm * (0.45 + this.rnd() * 1.35) / 100) * 100);
        bars1m.push([this._tickTs(i), round2(o), round2(Math.max(hi, o, c)), round2(Math.min(lo, o, c)), round2(c), vol]);
      }
      const prevCloseIdx = TOTAL - 61;         // 昨日最后一分钟
      st.base = round2(px(TOTAL - 1));         // 缩放后当前价（可能被固定昨收平移）
      st.fair = st.base;
      st.prevClose = round2(px(prevCloseIdx));
      st.limitUp = round2(st.prevClose * (1 + st.limitPct));
      st.limitDown = round2(st.prevClose * (1 - st.limitPct));
      st.p = round2(st.base);
      st.lastMinuteClose = st.p;
      /* 今日（已过去的 60 分钟）日线聚合 */
      const today = { o: 0, h: 0, l: 0, v: 0, a: 0 };
      for (let i = TOTAL - 60; i < TOTAL; i++) {
        const b = bars1m[i];
        if (!today.o) today.o = b[1];
        today.h = Math.max(today.h || b[4], b[2], b[4]);
        today.l = today.l ? Math.min(today.l, b[3], b[4]) : Math.min(b[3], b[4]);
        today.v += b[5];
        today.a += b[4] * b[5];
      }
      today.o = today.o || st.p;
      today.h = Math.max(today.h || st.p, st.p);
      today.l = Math.min(today.l || st.p, st.p);
      st.day = { o: round2(today.o), h: round2(today.h), l: round2(today.l), v: today.v, a: round2(today.a) };
      st.dayInit = { ...st.day };

      /* —— 聚合 5m / 15m —— */
      const agg = (n) => {
        const out = [];
        let cur = null;
        for (let i = 0; i < bars1m.length; i++) {
          const b = bars1m[i];
          if (i % n === 0) {
            cur = [b[0], b[1], b[2], b[3], b[4], b[5]];
            out.push(cur);
          } else {
            cur[2] = Math.max(cur[2], b[2]);
            cur[3] = Math.min(cur[3], b[3]);
            cur[4] = b[4];
            cur[5] += b[5];
          }
        }
        return out;
      };
      const m5 = agg(5), m15 = agg(15);

      /* —— 120 根日 K（倒数第二根收在 prevClose，最后一根是今日） —— */
      const daily = [];
      const DC = 119;
      const df = new Float64Array(DC);
      let g = 1;
      for (let i = 0; i < DC; i++) { g *= 1 + this._randn() * st.sigma * Math.sqrt(240) * 0.85; df[i] = g; }
      const dscale = st.prevClose / df[DC - 1];
      let prevC = round2(st.prevClose * (0.88 + this.rnd() * 0.1));
      for (let i = 0; i < DC; i++) {
        const c = Math.max(0.5, df[i] * dscale);
        const o = i === 0 ? prevC : round2(df[i - 1] * dscale);
        const hi = Math.max(o, c) * (1 + Math.abs(this._randn()) * st.sigma * Math.sqrt(240) * 0.6);
        const lo = Math.min(o, c) * (1 - Math.abs(this._randn()) * st.sigma * Math.sqrt(240) * 0.6);
        const vol = Math.max(1000, Math.round(st.vpm * 240 * (0.55 + this.rnd() * 1.1) / 100) * 100);
        daily.push([this.baseDay - (DC - i) * DAY_MS, round2(o), round2(Math.max(hi, o, c)), round2(Math.min(lo, o, c)), round2(c), vol]);
        prevC = round2(c);
      }
      daily.push([this.baseDay, st.day.o, st.day.h, st.day.l, st.p, st.day.v]);

      st.hist = {
        k1m: bars1m.slice(-240),
        k5: m5.slice(-240),
        k15: m15.slice(-240),
        k1d: daily.slice(-120),
      };
      st.minuteOpen = st.lastMinuteClose;
    }
    /* 分时（今日 60 个历史点） */
    this._timeshare = new Map();
    for (const st of this.market.values()) {
      const pts = [];
      let cv = 0, ca = 0;
      for (let i = 0; i < 60; i++) {
        const b = st.hist.k1m[st.hist.k1m.length - 60 + i];
        if (!b) continue;
        cv += b[5]; ca += b[4] * b[5];
        pts.push([b[0], b[4], round2(ca / Math.max(1, cv)), b[5]]);
      }
      this._timeshare.set(st.id, { prevClose: st.prevClose, points: pts });
    }
  }

  _bars(st, tf) {
    const h = st.hist;
    if (tf === '1m') return h.k1m;
    if (tf === '5m') return h.k5;
    if (tf === '15m') return h.k15;
    return h.k1d;
  }

  /* ══════════════ 2.4 行情 tick ══════════════ */

  _randn() {
    let u = 0, v = 0;
    while (u === 0) u = this.rnd();
    while (v === 0) v = this.rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  _vts() { return this.baseDay + this.dayIndex * DAY_MS + clockMinutes(this.minuteOfDay) * 60000; }

  /** 虚拟时钟：最后一个虚拟分钟（119）显示 11:30 上午收盘，与 util.vclockOf 一致 */
  _vclock() {
    const m = clamp(Math.floor(this.minuteOfDay || 0), 0, VIRTUAL_DAY_TICKS - 1);
    if (m >= VIRTUAL_DAY_TICKS - 1) return '11:30';
    return hhmm(clockMinutes(m));
  }

  /** 每 VIRTUAL_MINUTE_TICKS 个 tick 推进 1 个虚拟分钟；日切后进入午间休市 */
  _advanceClock() {
    this.minuteOfDay++;
    if (this.minuteOfDay >= VIRTUAL_DAY_TICKS) {
      this.minuteOfDay = 0;
      this.dayIndex++;
      this._onNewDay();
      /* 上午收盘 → 午间休市：行情冻结 BREAK_SEC 秒，下一天 09:30 开盘 */
      if (BREAK_SEC > 0) {
        this.breakUntil = Date.now() + BREAK_SEC * 1000;
        this.breakLeftSec = BREAK_SEC;
      }
    }
  }

  /** 午间休市广播（每秒一次，带倒计时）—— 报文结构与真实服务端 _broadcastBreak 完全一致 */
  _broadcastBreak() {
    this.emit('break', {
      t: 'break',
      active: true,
      leftSec: this.breakLeftSec || 0,
      totalSec: BREAK_SEC,
      dayIndex: this.dayIndex,
      vclock: this._vclock(),
      nextOpen: '09:30',
      endsAt: this.endsAt,
    });
  }

  /** 虚拟日切换：昨收更新、涨跌停重算、T+1 解禁、分时重置 */
  _onNewDay() {
    for (const st of this.market.values()) {
      st.prevClose = st.p;
      st.limitUp = round2(st.prevClose * (1 + st.limitPct));
      st.limitDown = round2(st.prevClose * (1 - st.limitPct));
      st.lastMinuteClose = st.p;
      st.minuteOpen = st.p;
      st.day = { o: st.p, h: st.p, l: st.p, v: 0, a: 0 };
      st.shock = 0;
    }
    if (this.acct) {
      for (const p of this.acct.positions.values()) p.avail = p.qty;   // T+1 解禁
    }
    for (const id of this.market.keys()) {
      const st = this.market.get(id);
      this._timeshare.set(id, { prevClose: st.prevClose, points: [] });
    }
    this.emit('toast', { t: 'toast', level: 'info', msg: '虚拟交易日切换，T+1 持仓已解禁' });
    if (this.acct) this._pushAccount();
  }

  _stepSectors() {
    for (const [k, v] of this.secF) {
      const nv = clamp(v * 0.93 + this._randn() * 0.0014, -0.05, 0.05);
      this.secF.set(k, nv);
    }
  }

  _stepStock(st) {
    const secF = this.secF.get(st.sector) || 0;
    let ret = st.drift + st.beta * secF * 0.40;
    ret += this._randn() * st.sigma;
    ret += -st.mr * ((st.p - st.fair) / Math.max(1e-6, st.fair));      // 均值回复
    if (this.rnd() < st.surgeP) {                                       // 异动：直线拉升 / 跳水
      st.surge = (this.rnd() < 0.5 ? 1 : -1) * (0.004 + this.rnd() * 0.010) * (st.surgeMag || 1);
    }
    ret += st.surge;
    st.surge *= 0.72;
    if (Math.abs(st.surge) < 0.0002) st.surge = 0;
    ret += st.shock;                                                    // 新闻冲击
    st.shock *= 0.90;
    ret += st.impact;                                                   // 玩家成交冲击
    st.impact *= 0.86;

    const np = clamp(st.p * Math.exp(ret), st.limitDown, st.limitUp);
    st.p = round2(np);
    if (st.p > st.day.h) st.day.h = st.p;
    if (st.p < st.day.l) st.day.l = st.p;

    /* 本 tick 成交明细 + 累计量额 */
    const n = 1 + Math.floor(this.rnd() * 3);
    const bias = (st.p - st.minuteOpen) >= 0 ? 0.12 : -0.12;
    const tr = [];
    let tv = 0, ta = 0;
    for (let i = 0; i < n; i++) {
      let qty = Math.round((st.vpm / 3) * (0.3 + this.rnd() * 1.8) / 100) * 100;
      qty = Math.max(LOT_SIZE, qty);
      const px = round2(clamp(st.p * (1 + (this.rnd() - 0.5) * 0.0025), st.limitDown, st.limitUp));
      const dir = this.rnd() < 0.5 + bias ? 1 : -1;
      tr.push([px, qty, dir]);
      tv += qty; ta += px * qty;
    }
    st.tr = tr;
    st.day.v += tv;
    st.day.a += ta;
  }

  _lvQty(st, k) {
    const base = st.vpm / 8;
    const q = base * (0.35 + this.rnd() * 1.9) * (1 + k * 0.32);
    return Math.max(LOT_SIZE, Math.round(q / 100) * 100);
  }

  _buildBook(st) {
    const p = st.p;
    /* A 股最小变动价位是按价位分档的：0.01 / 0.02 / 0.05 / 0.10，
       不能按百分比放价差（否则 1675 元的股票买一卖一要差 2 元）。 */
    const step = p >= 500 ? 0.10 : p >= 100 ? 0.05 : p >= 20 ? 0.02 : 0.01;
    const b = [], s = [];
    for (let k = 0; k < 5; k++) {
      const bp = round2(Math.max(st.limitDown, p - step * (k + 1)));
      const sp = round2(Math.min(st.limitUp, p + step * (k + 1)));
      b.push([bp, this._lvQty(st, k)]);
      s.push([sp, this._lvQty(st, k)]);
    }
    if (p >= st.limitUp - 1e-9) {                 // 涨停：卖盘枯竭、买盘排队
      for (let k = 0; k < 5; k++) { b[k] = [st.limitUp, this._lvQty(st, k) * 4]; s[k] = [st.limitUp, LOT_SIZE]; }
    } else if (p <= st.limitDown + 1e-9) {        // 跌停：买盘枯竭、卖盘排队
      for (let k = 0; k < 5; k++) { s[k] = [st.limitDown, this._lvQty(st, k) * 4]; b[k] = [st.limitDown, LOT_SIZE]; }
    }
    st.b = b; st.s = s;
  }

  _quoteOf(st) {
    return {
      i: st.id, p: st.p, o: st.day.o, h: st.day.h, l: st.day.l, pc: st.prevClose,
      v: Math.round(st.day.v), a: round2(st.day.a),
      b: st.b.map((x) => [x[0], x[1]]), s: st.s.map((x) => [x[0], x[1]]),
      tr: st.tr.map((x) => [x[0], x[1], x[2]]),
      limitUp: st.limitUp, limitDown: st.limitDown,
    };
  }

  _computeIndices() {
    if (!this._idxBase) {
      this._idxBase = {
        z: round2(1200 + this.rnd() * 40), c: round2(2480 + this.rnd() * 60),
        ix: round2(18542 + this.rnd() * 120), nd: round2(20188 + this.rnd() * 160),
      };
    }
    const calc = (list, pcBase) => {
      let w = 0, acc = 0, amt = 0;
      for (const st of list) {
        const pc = st.prevClose || st.p;
        w += st.floatMv;
        acc += ((st.p - pc) / pc) * st.floatMv;
        amt += st.day.a;
      }
      const pct = w ? acc / w : 0;
      return { v: round2(pcBase * (1 + pct)), pc: round2(pcBase), pct: round4(pct), amt: round2(amt) };
    };
    const all = Array.from(this.market.values());
    const aShares = all.filter((x) => x.market !== 'us');
    const us = all.filter((x) => x.market === 'us');
    const aTop = aShares.slice().sort((a, b) => b.floatMv - a.floatMv).slice(0, 10);
    const usTop = us.slice().sort((a, b) => b.floatMv - a.floatMv).slice(0, 5);
    const A = calc(aShares, this._idxBase.z);
    const C = calc(aTop, this._idxBase.c);
    const IX = calc(us, this._idxBase.ix);
    const ND = calc(usTop, this._idxBase.nd);
    return [
      { c: 'THKZ', n: '同花综指', v: A.v, pc: A.pc, pct: A.pct, amt: A.amt },
      { c: 'THKC', n: '同花成指', v: C.v, pc: C.pc, pct: C.pct, amt: C.amt },
      { c: 'IXIC', n: '纳斯达克综指', v: IX.v, pc: IX.pc, pct: IX.pct, amt: IX.amt },
      { c: 'NDX', n: '纳斯达克100', v: ND.v, pc: ND.pc, pct: ND.pct, amt: ND.amt },
    ];
  }

  /** 追加一根 1 分钟 K（1 tick = 1 虚拟分钟） */
  _appendMinute(st) {
    const ts = this._vts();
    const o = st.lastMinuteClose;
    const c = st.p;
    const v = st.tr.reduce((s, x) => s + x[1], 0);
    const h = round2(Math.max(o, c) * (1 + this.rnd() * 0.0004));
    const l = round2(Math.min(o, c) * (1 - this.rnd() * 0.0004));
    const bar = [ts, o, Math.max(h, o, c), Math.min(l, o, c), c, v];
    st.lastMinuteClose = c;
    st.minuteOpen = c;

    const push = (arr, cap, nb) => {
      arr.push(nb);
      if (arr.length > cap) arr.shift();
    };
    push(st.hist.k1m, 240, bar);

    const aggPush = (arr, minuteIdx) => {
      if (minuteIdx % (arr === st.hist.k5 ? 5 : 15) === 0) {
        arr.push([ts, o, bar[2], bar[3], c, v]);
        if (arr.length > 240) arr.shift();
      } else {
        const last = arr[arr.length - 1];
        if (last) {
          last[2] = Math.max(last[2], bar[2]);
          last[3] = Math.min(last[3], bar[3]);
          last[4] = c;
          last[5] += v;
        }
      }
    };
    aggPush(st.hist.k5, this.minuteOfDay);
    aggPush(st.hist.k15, this.minuteOfDay);

    /* 日 K：分钟 0 开新的一根 */
    if (this.minuteOfDay === 0) {
      st.hist.k1d.push([this.baseDay + this.dayIndex * DAY_MS, o, bar[2], bar[3], c, v]);
      if (st.hist.k1d.length > 120) st.hist.k1d.shift();
    } else {
      const dbar = st.hist.k1d[st.hist.k1d.length - 1];
      if (dbar) {
        dbar[2] = Math.max(dbar[2], bar[2]);
        dbar[3] = Math.min(dbar[3], bar[3]);
        dbar[4] = c;
        dbar[5] += v;
      }
    }

    /* 分时 */
    let ts2 = this._timeshare.get(st.id);
    if (!ts2 || ts2.prevClose !== st.prevClose) {
      ts2 = { prevClose: st.prevClose, points: [] };
      this._timeshare.set(st.id, ts2);
    }
    const avg = round2(st.day.a / Math.max(1, st.day.v));
    ts2.points.push([ts, c, avg, v]);
    if (ts2.points.length > 240) ts2.points.shift();
  }

  _tick() {
    if (!this.match) return;
    if (Date.now() >= this.endsAt) { this.endMatch('timeup'); return; }
    this.seq++;

    /* ── 午间休市：行情冻结（不推进虚拟分钟），每秒广播一次带倒计时的 break 报文；
         挂单/账户/排行照常处理，排队等下一交易日 09:30 开盘（与真实服务端一致） ── */
    if (this.breakUntil) {
      const now = Date.now();
      if (now < this.breakUntil) {
        this.breakLeftSec = Math.max(0, Math.ceil((this.breakUntil - now) / 1000));
        this._broadcastBreak();
        this._tickOrders();
        if (this.seq % 3 === 0) { this._pushRank(); this._pushAccount(); }
        return;
      }
      /* 休市结束 → 恢复开盘 */
      this.breakUntil = 0;
      this.breakLeftSec = 0;
      this.emit('break', { t: 'break', over: true, dayIndex: this.dayIndex, vclock: this._vclock() });
    }

    /* 每 VIRTUAL_MINUTE_TICKS 个 tick 推进 1 个虚拟分钟（1 虚拟分钟 = 5 秒真实时间） */
    const advance = (this.seq % VIRTUAL_MINUTE_TICKS) === 0;
    if (advance) this._advanceClock();
    this._stepSectors();

    const vtime = this._vts();
    const quotes = [];
    for (const st of this.market.values()) {
      this._stepStock(st);
      this._buildBook(st);
      /* 只有虚拟分钟推进时才落一根分钟 K / 一个分时点（否则同一分钟会重复落点） */
      if (advance) this._appendMinute(st);
      quotes.push(this._quoteOf(st));
    }
    const payload = {
      t: 'tick', seq: this.seq, vtime, vclock: this._vclock(),
      serverTime: Date.now(), idx: this._computeIndices(), quotes,
    };
    this.emit('tick', payload);
    this._syncTickState(payload);

    this._stepBots();
    this._tickOrders();
    this._recordEquity();
    if (this.seq % 3 === 0) { this._pushRank(); this._pushAccount(); }
    this._maybeNews();
  }

  _syncTickState(p) {
    const S = this.state;
    S.indices = p.idx;
    S.vclock = p.vclock;
    S.serverTime = p.serverTime;
    if (!S.quotes) S.quotes = new Map();
    for (const q of p.quotes) {
      const pc = q.pc || q.p;
      S.quotes.set(q.i, Object.assign({}, q, {
        change: round2(q.p - pc),
        changePct: pc ? (q.p - pc) / pc : 0,
      }));
    }
    for (const [id] of this.market) S.timeshare.set(id, this._timeshare.get(id));
    this._touch();
  }

  /* ══════════════ 2.5 账户 / 撮合 ══════════════ */

  _buildAccount(cash) {
    this.startCash = cash;
    this.acct = {
      cash, frozen: 0, startCash: cash,
      positions: new Map(), orders: new Map(), trades: [],
      equity: [], feeTotal: 0, tradeCount: 0, realizedPnl: 0,
    };
    this.metaList = this.stockIds.map((id) => this.metaOf(id));
  }

  _newOrderId() { return 'o_' + (++this._orderSeq); }
  _newTradeId() { return 't_' + (++this._tradeSeq); }

  _computeAssets() {
    let mv = 0;
    for (const [id, p] of this.acct.positions) {
      const st = this.market.get(id);
      mv += (st ? st.p : p.avgCost) * p.qty;
    }
    const total = this.acct.cash + this.acct.frozen + mv;
    return {
      marketValue: round2(mv),
      totalAssets: round2(total),
      pnl: round2(total - this.acct.startCash),
      pnlPct: this.acct.startCash ? (total - this.acct.startCash) / this.acct.startCash : 0,
    };
  }

  _accountMsg() {
    const a = this.acct;
    const t = this._computeAssets();
    const positions = Array.from(a.positions.entries()).map(([id, p]) => {
      const st = this.market.get(id);
      const price = st ? st.p : p.avgCost;
      return {
        i: id, qty: p.qty, avail: p.avail, avgCost: round2(p.avgCost), price,
        mv: round2(price * p.qty),
        pnl: round2((price - p.avgCost) * p.qty),
        pnlPct: p.avgCost ? (price - p.avgCost) / p.avgCost : 0,
        name: st ? st.name : id,
      };
    }).sort((x, y) => y.mv - x.mv);
    const orders = Array.from(a.orders.values())
      .sort((x, y) => y.time - x.time)
      .map((o) => ({
        id: o.id, i: o.i, side: o.side, type: o.type, price: round2(o.price || 0),
        qty: o.qty, filled: o.filled, status: o.status, time: o.time, frozen: round2(o.frozen || 0),
      }));
    const trades = a.trades.slice(0, 200).map((tr) => Object.assign({}, tr));
    return {
      t: 'account',
      cash: round2(a.cash), frozen: round2(a.frozen), available: round2(a.cash),
      marketValue: t.marketValue, totalAssets: t.totalAssets, pnl: t.pnl, pnlPct: round4(t.pnlPct),
      positions, orders, trades,
    };
  }

  _pushAccount() {
    if (!this.acct) return;
    const msg = this._accountMsg();
    this.state.account = msg;
    this.emit('account', msg);
    this._touch();
  }

  _freezeOrderCash(order, amount) {
    this.acct.cash = round2(this.acct.cash - amount);
    this.acct.frozen = round2(this.acct.frozen + amount);
    order.frozen = round2((order.frozen || 0) + amount);
  }

  _releaseOrderCash(order) {
    const f = order.frozen || 0;
    this.acct.frozen = round2(this.acct.frozen - f);
    this.acct.cash = round2(this.acct.cash + f);
    order.frozen = 0;
  }

  _needCash(price, qty) { return round2(price * qty + feeOf('buy', price * qty)); }

  _err(code, msg, reqId) {
    const m = { t: 'error', code, msg };
    if (reqId) m.reqId = reqId;
    this.emit('error', m);
    return m;
  }

  _ack(reqId, ok, orderId, msg) {
    const m = { t: 'order:ack', reqId, ok: !!ok, msg };
    if (orderId) m.orderId = orderId;
    else if (ok) m.orderId = null;
    this.emit('order:ack', m);
    return m;
  }

  _onOrderPlace(f) {
    const reqId = f.reqId;
    if (!this.loggedIn) { this._ack(reqId, false, null, '请先登录'); this._err('NOT_LOGGED_IN', '请先登录', reqId); return; }
    if (!this.match) { this._ack(reqId, false, null, '对局尚未开始'); this._err('NOT_PLAYING', '对局尚未开始', reqId); return; }

    const side = f.side === 'sell' ? 'sell' : 'buy';
    const type = f.type === 'market' ? 'market' : 'limit';
    const st = this.market.get(f.stockId);
    const qty = Math.floor(Number(f.qty) || 0);
    if (!st) { this._ack(reqId, false, null, '股票代码不存在'); this._err('BAD_REQUEST', '股票代码不存在', reqId); return; }

    const name = st.name;
    const sideCn = side === 'buy' ? '买入' : '卖出';

    /* 1) 数量校验 */
    if (!Number.isFinite(qty) || qty <= 0 || qty % LOT_SIZE !== 0) {
      this._ack(reqId, false, null, '委托数量必须是100股的整数倍');
      this._err('BAD_QTY', '委托数量必须是100股的整数倍', reqId);
      return;
    }
    /* 2) 价格校验 */
    let price = null;
    const q = this._quoteOf(st);
    if (type === 'limit') {
      price = round2(Number(f.price));
      if (!Number.isFinite(price) || price <= 0) {
        this._ack(reqId, false, null, '委托价格非法');
        this._err('BAD_PRICE', '委托价格非法', reqId);
        return;
      }
      if (price > st.limitUp + 1e-9 || price < st.limitDown - 1e-9) {
        this._ack(reqId, false, null, '价格超出涨跌停');
        this._err('BAD_PRICE', '价格超出涨跌停', reqId);
        return;
      }
    } else {
      price = side === 'buy' ? q.s[4][0] : q.b[4][0];   // 市价单：按最差一档估价，保证冻结足够
    }
    /* 3) 资金 / 持仓校验 */
    if (side === 'buy') {
      const need = this._needCash(price, qty);
      if (this.acct.cash < need - 1e-6) {
        this._ack(reqId, false, null, '可用资金不足');
        this._err('INSUFFICIENT_FUNDS', '可用资金不足', reqId);
        return;
      }
    } else {
      const pos = this.acct.positions.get(st.id);
      const avail = pos ? pos.avail : 0;
      if (avail < qty) {
        const msg = avail > 0 ? '可用持仓不足(T+1)' : '可用持仓不足(T+1)';
        this._ack(reqId, false, null, msg);
        this._err('INSUFFICIENT_POSITION', msg, reqId);
        return;
      }
    }

    /* 4) 建单 + 冻结 + 回执 */
    const order = {
      id: this._newOrderId(), i: st.id, side, type,
      price: round2(price), qty, filled: 0, status: 'open',
      time: Date.now(), frozen: 0, reqId,
    };
    this.acct.orders.set(order.id, order);

    let freezeAmount = 0;
    if (side === 'buy') {
      freezeAmount = this._needCash(order.price, qty);
      this._freezeOrderCash(order, freezeAmount);
    } else {
      const pos = this.acct.positions.get(st.id);
      pos.avail -= qty;                      // 冻结可卖股份
      order.frozenQty = qty;
    }

    const pxText = type === 'market' ? '市价' : order.price.toFixed(2);
    this._ack(reqId, true, order.id, `已委托 ${sideCn} ${name} ${qty}股 @${pxText}`);
    this._pushAccount();

    /* 5) 立即撮合 */
    this._tryFillOrder(order, true);
    this._pushAccount();
    return order;
  }

  _onOrderCancel(f) {
    const reqId = f.reqId;
    if (!this.loggedIn) { this._err('NOT_LOGGED_IN', '请先登录', reqId); return; }
    const order = this.acct && this.acct.orders.get(f.orderId);
    if (!order || (order.status !== 'open' && order.status !== 'partial')) {
      this._err('ORDER_NOT_FOUND', '撤单失败：委托不存在或已结束', reqId);
      return;
    }
    this._cancelOrder(order);
    this._pushAccount();
  }

  _cancelOrder(order) {
    const remain = order.qty - order.filled;
    order.status = 'canceled';
    if (order.side === 'buy') {
      this._releaseOrderCash(order);
    } else if (remain > 0) {
      const pos = this.acct.positions.get(order.i);
      if (pos) pos.avail += remain;
      order.frozenQty = 0;
    }
    if (remain > 0 && order.filled > 0) order.status = 'canceled';
    return order;
  }

  /** 立即撮合：限价单吃对手价，市价单吃五档后余量自动撤单 */
  _tryFillOrder(order, immediate) {
    const st = this.market.get(order.i);
    if (!st) return;
    const q = this._quoteOf(st);
    const remain0 = order.qty - order.filled;
    if (remain0 <= 0) return;

    if (order.side === 'buy') {
      if (order.type === 'market') {
        let remain = remain0;
        for (const [px, vol] of q.s) {
          if (remain <= 0) break;
          const take = Math.min(remain, Math.max(LOT_SIZE, Math.floor(vol / 100) * 100));
          if (take <= 0) continue;
          this._fill(order, round2(Math.max(px, st.limitDown)), take);
          remain -= take;
        }
        if (remain > 0) {                       // 市价单吃不完 → 自动撤单
          this._releaseOrderCash(order);
          order.status = 'canceled';
          this.emit('toast', { t: 'toast', level: 'warn', msg: `市价单剩余 ${remain} 股未成交，已自动撤单` });
        }
      } else if (order.price >= q.s[0][0] - 1e-9) {
        let remain = remain0;
        for (const [px, vol] of q.s) {
          if (remain <= 0) break;
          if (px > order.price + 1e-9) break;
          const take = Math.min(remain, Math.max(LOT_SIZE, Math.floor(vol / 100) * 100));
          if (take <= 0) continue;
          this._fill(order, px, take);
          remain -= take;
        }
      }
    } else {
      if (order.type === 'market') {
        let remain = remain0;
        for (const [px, vol] of q.b) {
          if (remain <= 0) break;
          const take = Math.min(remain, Math.max(LOT_SIZE, Math.floor(vol / 100) * 100));
          if (take <= 0) continue;
          this._fill(order, round2(Math.min(px, st.limitUp)), take);
          remain -= take;
        }
        if (remain > 0) {
          const pos = this.acct.positions.get(order.i);
          if (pos) pos.avail += remain;
          order.frozenQty = 0;
          order.status = 'canceled';
          this.emit('toast', { t: 'toast', level: 'warn', msg: `市价单剩余 ${remain} 股未成交，已自动撤单` });
        }
      } else if (order.price <= q.b[0][0] + 1e-9) {
        let remain = remain0;
        for (const [px, vol] of q.b) {
          if (remain <= 0) break;
          if (px < order.price - 1e-9) break;
          const take = Math.min(remain, Math.max(LOT_SIZE, Math.floor(vol / 100) * 100));
          if (take <= 0) continue;
          this._fill(order, px, take);
          remain -= take;
        }
      }
    }
  }

  /** 一笔成交：记账 + T+1 + 成本价 + 手续费 + 价格冲击 */
  _fill(order, price, qty) {
    const st = this.market.get(order.i);
    const a = this.acct;
    const amount = round2(price * qty);
    const fee = feeOf(order.side, amount);

    if (order.side === 'buy') {
      /* 解冻（按原冻结重建），再扣实际成交 */
      this._releaseOrderCash(order);
      a.cash = round2(a.cash - amount - fee);
      const pos = a.positions.get(order.i) || { qty: 0, avail: 0, avgCost: 0, lastBuyDay: this.dayIndex };
      const newQty = pos.qty + qty;
      pos.avgCost = newQty > 0 ? round2((pos.avgCost * pos.qty + amount + fee) / newQty) : 0;
      pos.qty = newQty;
      pos.lastBuyDay = this.dayIndex;              // T+1：当日买入不计入 avail
      a.positions.set(order.i, pos);
      const remainAfter = order.qty - order.filled - qty;
      if (remainAfter > 0) this._freezeOrderCash(order, this._needCash(order.price, remainAfter));
      st.impact = clamp(st.impact + (amount / Math.max(1, st.floatMv)) * 220, -0.02, 0.02);
    } else {
      const pos = a.positions.get(order.i) || { qty: 0, avail: 0, avgCost: 0 };
      const realized = round2((price - pos.avgCost) * qty - fee);
      pos.qty -= qty;
      pos.avgCost = pos.qty > 0 ? pos.avgCost : 0;
      if (pos.qty <= 0) a.positions.delete(order.i);
      else a.positions.set(order.i, pos);
      a.cash = round2(a.cash + amount - fee);
      a.realizedPnl = round2(a.realizedPnl + realized);
      st.impact = clamp(st.impact - (amount / Math.max(1, st.floatMv)) * 220, -0.02, 0.02);
      order._realized = realized;
    }

    order.filled += qty;
    order.status = order.filled >= order.qty ? 'filled' : 'partial';

    a.feeTotal = round2(a.feeTotal + fee);
    a.tradeCount += 1;
    a.trades.unshift({
      id: this._newTradeId(), i: order.i, side: order.side, price: round2(price), qty,
      amount, fee, time: Date.now(), pnl: order.side === 'sell' ? (order._realized || 0) : null,
      name: st.name,
    });
    if (a.trades.length > 500) a.trades.length = 500;
    this._touch();
    return { price, qty, fee, amount };
  }

  /** 每 tick：挂单排队撮合 */
  _tickOrders() {
    let changed = false;
    for (const order of Array.from(this.acct.orders.values())) {
      if (order.status !== 'open' && order.status !== 'partial') continue;
      const st = this.market.get(order.i);
      if (!st) continue;
      const remain = order.qty - order.filled;
      if (remain <= 0) continue;
      const q = this._quoteOf(st);
      if (order.side === 'buy') {
        const hit = q.p <= order.price + 1e-9 || q.s[0][0] <= order.price + 1e-9;
        if (!hit) continue;
        const px = round2(Math.min(order.price, q.s[0][0]));
        let take = Math.round(remain * (0.25 + this.rnd() * 0.85) / 100) * 100;
        take = clamp(take, LOT_SIZE, remain);
        this._fill(order, px, take);
        changed = true;
      } else {
        const hit = q.p >= order.price - 1e-9 || q.b[0][0] >= order.price - 1e-9;
        if (!hit) continue;
        const px = round2(Math.max(order.price, q.b[0][0]));
        let take = Math.round(remain * (0.25 + this.rnd() * 0.85) / 100) * 100;
        take = clamp(take, LOT_SIZE, remain);
        this._fill(order, px, take);
        changed = true;
      }
    }
    if (changed) this._pushAccount();
  }

  /* ══════════════ 2.6 排行 / 新闻 ══════════════ */

  _online() { return 1 + (this.bots ? this.bots.length : 0) + 2; }

  _stepBots() {
    for (const b of this.bots) {
      /* 收益率会互相追赶：alpha 做随机游走（有的越战越勇，有的越亏越急），偶尔来一次大波动 */
      b.alpha += (this.rnd() - 0.5) * 0.00016;
      b.alpha = clamp(b.alpha * 0.995, -0.0011, 0.0011);
      let r = b.alpha + this._randn() * b.vol;
      if (this.rnd() < 0.004) r += (this.rnd() < 0.5 ? -1 : 1) * (0.004 + this.rnd() * 0.02);
      b.assets = Math.max(1000, b.assets * (1 + r));
      if (this.seq % 10 === 0) b.equity.push([Date.now() - (this.match ? this.match.startedAt : Date.now()), round2(b.assets)]);
    }
  }

  _rankList() {
    const t = this._computeAssets();
    const me = {
      id: this.player.id, nick: this.player.nick, avatar: this.player.avatar,
      assets: t.totalAssets, returnPct: round4(t.pnlPct), isBot: false, isMe: true,
      tier: this.player.tier, team: this.teamOf(this.player.id),
      todayPnl: round2(t.totalAssets - this.startCash),
    };
    const others = this.bots.map((b) => ({
      id: b.id, nick: b.nick, avatar: b.avatar, assets: round2(b.assets),
      returnPct: round4((b.assets - this.startCash) / this.startCash), isBot: true, isMe: false,
      tier: b.tier, team: this.teamOf(b.id), todayPnl: round2(b.assets - this.startCash),
    }));
    return [me, ...others].sort((x, y) => y.assets - x.assets);
  }

  _pushRank() {
    if (!this.match) return;
    const list = this._rankList();
    this.state.rank = list;
    this.emit('rank', {
      t: 'rank', endsAt: this.endsAt, vclock: this._vclock(), list,
    });
    this._touch();
  }

  _maybeNews() {
    if (this.seq < this._nextNewsSeq) return;
    this._nextNewsSeq = this.seq + 20 + Math.floor(this.rnd() * 21);
    const news = this._makeNews();
    this.state.news.unshift(news);
    if (this.state.news.length > MAX_NEWS) this.state.news.length = MAX_NEWS;
    this.emit('news', { t: 'news', news });
    this._touch();
  }

  _makeNews() {
    /* 模板权重池：默认权重 2，专属/稀有模板可给更小的 weight */
    if (!this._newsPool) {
      this._newsPool = [];
      for (const t of NEWS_TPL) {
        const w = Number.isFinite(t.weight) ? t.weight : 2;
        for (let i = 0; i < w; i++) this._newsPool.push(t);
      }
    }
    const tpl = this._newsPool[Math.floor(this.rnd() * this._newsPool.length)];
    const named = tpl.stockId ? this.market.get(tpl.stockId) : null;
    const useSector = tpl.scope === 'sector' || (tpl.scope === 'market' && this.rnd() < 0.5);
    let sec;
    let st;
    if (named) {
      st = named;
      sec = named.sector;
    } else {
      sec = useSector
        ? this.sectors[Math.floor(this.rnd() * this.sectors.length)]
        : (tpl.sector || this.sectors[Math.floor(this.rnd() * this.sectors.length)]);
      const inSec = this.stockIds.filter((id) => this.market.get(id).sector === sec);
      const pickId = inSec.length ? inSec[Math.floor(this.rnd() * inSec.length)] : this.stockIds[Math.floor(this.rnd() * this.stockIds.length)];
      st = this.market.get(pickId);
      sec = st.sector;
    }
    const d = {
      sector: sec, stock: st.name, time: hhmm(clockMinutes(this.minuteOfDay)),
      clock: hhmm(clockMinutes(this.minuteOfDay)),
      n1: (2 + this.rnd() * 6).toFixed(1), n2: (1 + this.rnd() * 8).toFixed(1),
    };
    const id = 'n_' + (++this._newsSeq);
    const news = {
      id, time: Date.now(),
      title: tpl.title(d), body: tpl.body(d),
      level: tpl.level, sector: sec,
      stockId: (named || tpl.scope === 'stock') ? st.id : null,
      predict: tpl.predict,
    };
    /* 价格冲击：让行情确实跟着新闻动 */
    const dir = news.predict === '利多' ? 1 : news.predict === '利空' ? -1 : 0;
    const strength = (0.0016 + this.rnd() * 0.0032) * (news.level === 'hot' ? 1.7 : 1);
    if (dir) {
      if (news.stockId) {
        st.shock += dir * strength;
        const f = this.secF.get(st.sector) || 0;
        this.secF.set(st.sector, clamp(f + dir * strength * 0.25, -0.05, 0.05));
      } else {
        const f = this.secF.get(news.sector) || 0;
        this.secF.set(news.sector, clamp(f + dir * strength, -0.05, 0.05));
        for (const sid of this.stockIds) {
          const s2 = this.market.get(sid);
          if (s2.sector === news.sector) s2.shock += dir * strength * 0.35;
        }
      }
    }
    return news;
  }

  /* ══════════════ 2.7 大厅 / 房间 ══════════════ */

  _initLobbyRooms() {
    const n = 5 + Math.floor(this.rnd() * 3);
    for (let i = 0; i < n; i++) {
      const mode = ['ffa', 'ffa', 'team', '1v1'][Math.floor(this.rnd() * 4)];
      const maxPlayers = mode === '1v1' ? 2 : (6 + Math.floor(this.rnd() * 4) * 2);   // 演示房间 2~12 人
      const r = {
        id: 'r_' + Math.floor(this.rnd() * 0xffff).toString(36).padStart(4, '0'),
        name: `${BOT_NAMES[i % BOT_NAMES.length]}的房`,
        mode, maxPlayers,
        playerCount: 1 + Math.floor(this.rnd() * (maxPlayers - 1)),
        status: 'waiting',
        durationSec: DURATIONS[Math.floor(this.rnd() * DURATIONS.length)].sec,
        startCash: START_CASH_OPTIONS[Math.floor(this.rnd() * START_CASH_OPTIONS.length)],
        hostNick: BOT_NAMES[i % BOT_NAMES.length],
        players: [],
        fake: true,
      };
      r.players.push(this._makePlayerEntry(BOT_NAMES[i % BOT_NAMES.length], true, true));
      while (r.players.length < r.playerCount) {
        const nm = BOT_NAMES[Math.floor(this.rnd() * BOT_NAMES.length)];
        r.players.push(this._makePlayerEntry(nm, true, false));
      }
      this.rooms.set(r.id, r);
    }
  }

  _makePlayerEntry(nick, isBot, isHost) {
    const elo = 900 + Math.floor(this.rnd() * 900);
    return {
      id: (isBot ? 'b_' : 'p_') + Math.floor(this.rnd() * 100000).toString(36),
      nick, avatar: Math.floor(this.rnd() * 12), ready: isBot, isBot: !!isBot,
      isHost: !!isHost, tier: tierOf(elo), elo,
      alpha: (this.rnd() - 0.35) * 0.0004, vol: 0.0012 + this.rnd() * 0.0022,
      assets: 0, equity: [],
    };
  }

  _roomInfo(r) {
    return {
      id: r.id, name: r.name, mode: r.mode, maxPlayers: r.maxPlayers,
      hostId: r.hostId || (r.players.find((p) => p.isHost) || {}).id || null,
      status: r.status, countdown: r.countdown || 0,
      durationSec: r.durationSec, startCash: r.startCash, fillBots: !!r.fillBots,
      matchId: r.matchId || null, teams: r.teams || null,
      players: r.players.map((p) => ({
        id: p.id, nick: p.nick, avatar: p.avatar, ready: !!p.ready,
        isBot: !!p.isBot, isHost: !!(p.isHost || p.id === r.hostId), tier: p.tier, elo: p.elo,
      })),
    };
  }

  _lobbyRoomRow(r) {
    return {
      id: r.id, name: r.name, mode: r.mode, maxPlayers: r.maxPlayers,
      playerCount: r.players.length, status: r.status, durationSec: r.durationSec,
      startCash: r.startCash, hostNick: (r.players.find((p) => p.isHost) || {}).nick || r.hostNick || '—',
    };
  }

  _onLobbyList(f) {
    const rooms = Array.from(this.rooms.values())
      .filter((r) => r.status === 'waiting' && r.players.length < r.maxPlayers)
      .map((r) => this._lobbyRoomRow(r));
    this.state.lobby = this.state.lobby || { rooms: [] };
    this.state.lobby.rooms = rooms;
    const msg = { t: 'lobby:rooms', rooms };
    if (f && f.reqId) msg.reqId = f.reqId;
    this.emit('lobby:rooms', msg);
    this._touch();
  }

  _roomCreate(f) {
    const mode = MODES.some((m) => m.id === f.mode) ? f.mode : 'ffa';
    const maxPlayers = clamp(Math.floor(Number(f.maxPlayers) || (mode === '1v1' ? 2 : 8)), 2, 30);
    const durationSec = DURATIONS.some((d) => d.sec === Number(f.durationSec)) ? Number(f.durationSec) : 900;
    const startCash = START_CASH_OPTIONS.includes(Number(f.startCash)) ? Number(f.startCash) : 1000000;
    const r = {
      id: 'r_' + Math.floor(this.rnd() * 0xffff).toString(36).padStart(4, '0'),
      name: f.name || `${this.player.nick}的房`,
      mode, maxPlayers, durationSec, startCash,
      fillBots: f.fillBots !== false,
      status: 'waiting', countdown: 0, hostId: this.player.id,
      players: [], teams: null, matchId: null,
    };
    const me = this._makePlayerEntry(this.player.nick, false, true);
    me.id = this.player.id; me.avatar = this.player.avatar; me.elo = this.player.elo;
    me.tier = this.player.tier; me.ready = true;
    r.players.push(me);
    this.rooms.set(r.id, r);
    return r;
  }

  _onRoomCreate(f) {
    if (!this.loggedIn) { this._err('NOT_LOGGED_IN', '请先登录', f.reqId); return; }
    const r = this._roomCreate(f);
    this.room = r;
    this.state.room = this._roomInfo(r);
    this.emit('room:joined', { t: 'room:joined', room: this._roomInfo(r), you: { id: this.player.id } });
    this.emit('room:update', { t: 'room:update', room: this._roomInfo(r) });
    this._onLobbyList();
    this._touch();
  }

  _onRoomJoin(f) {
    if (!this.loggedIn) { this._err('NOT_LOGGED_IN', '请先登录', f.reqId); return; }
    const r = this.rooms.get(f.roomId);
    if (!r) { this._err('ROOM_NOT_FOUND', '房间不存在或已解散', f.reqId); return; }
    if (r.status === 'playing' || r.status === 'countdown') { this._err('ROOM_STARTED', '该房间已开局', f.reqId); return; }
    if (r.players.length >= r.maxPlayers) { this._err('ROOM_FULL', '房间已满', f.reqId); return; }
    const me = this._makePlayerEntry(this.player.nick, false, false);
    me.id = this.player.id; me.avatar = this.player.avatar; me.elo = this.player.elo;
    me.tier = this.player.tier; me.ready = true;
    r.players.push(me);
    this.room = r;
    this.state.room = this._roomInfo(r);
    this.emit('room:joined', { t: 'room:joined', room: this._roomInfo(r), you: { id: this.player.id } });
    this.emit('player:event', { t: 'player:event', action: 'join', roomId: r.id, player: { id: me.id, nick: me.nick, avatar: me.avatar } });
    this._broadcastRoom(r);
    this._onLobbyList();
  }

  _onRoomQuick(f) {
    if (!this.loggedIn) { this._err('NOT_LOGGED_IN', '请先登录', f.reqId); return; }
    const mode = MODES.some((m) => m.id === f.mode) ? f.mode : 'ffa';
    const r = this._roomCreate({
      name: '快速匹配',
      mode,
      maxPlayers: mode === '1v1' ? 2 : 8,
      durationSec: f.durationSec || 900,
      startCash: f.startCash || 1000000,
      fillBots: true,
    });
    r.quick = true;
    this.room = r;
    this.state.room = this._roomInfo(r);
    this.emit('room:joined', { t: 'room:joined', room: this._roomInfo(r), you: { id: this.player.id } });
    this._broadcastRoom(r);

    const wait = this.wantAuto ? 260 : 5000;      // 快速匹配：满员即开局，否则等 5s 用 AI 补齐
    this._later(() => {
      if (this.room !== r || r.status !== 'waiting') return;
      this._fillBots(r);
      this._broadcastRoom(r);
      this._countdown(r);
    }, wait);
  }

  _fillBots(r) {
    const names = BOT_NAMES.slice();
    let i = 0;
    while (r.players.length < r.maxPlayers && names.length) {
      const nm = names.splice(Math.floor(this.rnd() * names.length), 1)[0];
      const b = this._makePlayerEntry(nm, true, false);
      r.players.push(b);
      this.emit('player:event', { t: 'player:event', action: 'join', roomId: r.id, player: { id: b.id, nick: b.nick, avatar: b.avatar } });
      i++;
      if (i > 8) break;
    }
    if (r.mode === 'team') {
      const teams = {};
      r.players.forEach((p, idx) => { teams[p.id] = idx % 2 === 0 ? 'red' : 'blue'; });
      r.teams = teams;
    }
    for (const p of r.players) p.ready = true;
  }

  _broadcastRoom(r) {
    this.state.room = this._roomInfo(r);
    this.emit('room:update', { t: 'room:update', room: this.state.room });
    this._touch();
  }

  _onRoomLeave() {
    if (!this.room) { this._err('NOT_IN_ROOM', '你不在任何房间', null); return; }
    const r = this.room;
    r.players = r.players.filter((p) => p.id !== this.player.id);
    const roomId = r.id;
    if (r.status === 'playing') this.endMatch('forfeit');
    if (!r.players.some((p) => !p.isBot)) this.rooms.delete(r.id);
    this.room = null;
    this.state.room = null;
    this.emit('room:left', { t: 'room:left', roomId });
    this._onLobbyList();
  }

  _onRoomReady(f) {
    if (!this.room) { this._err('NOT_IN_ROOM', '你不在任何房间', f.reqId); return; }
    const me = this.room.players.find((p) => p.id === this.player.id);
    if (me) me.ready = f.ready !== false;
    this._broadcastRoom(this.room);
  }

  _onRoomStart() {
    if (!this.room) { this._err('NOT_IN_ROOM', '你不在任何房间', null); return; }
    const r = this.room;
    if (r.hostId !== this.player.id) { this._err('NOT_HOST', '只有房主可以开始对局', null); return; }
    if (r.status !== 'waiting') { this._err('ROOM_STARTED', '对局已经开始', null); return; }
    if (r.players.length < 2 && !r.fillBots) { this._err('BAD_REQUEST', '至少需要 2 名玩家才能开始', null); return; }
    this._fillBots(r);
    this._broadcastRoom(r);
    this._countdown(r);
  }

  _countdown(r) {
    if (!r || r.status !== 'waiting') return;
    r.status = 'countdown';
    let n = 3;
    r.countdown = n;
    this._broadcastRoom(r);
    const step = () => {
      if (this.room !== r || r.status !== 'countdown') return;
      n--;
      if (n <= 0) { this._beginMatch(r); return; }
      r.countdown = n;
      this._broadcastRoom(r);
      this._later(step, this.countdownMs);
    };
    this._later(step, this.countdownMs);
  }

  _onChat(f) {
    const text = String(f.text || '').slice(0, 120);
    if (!text) return;
    const msg = {
      t: 'chat', from: this.player ? this.player.id : 'p_me',
      nick: this.player ? this.player.nick : '我', text, time: Date.now(), system: false,
    };
    this.state.chat.push(msg);
    if (this.state.chat.length > 200) this.state.chat.shift();
    this.emit('chat', msg);
    this._touch();
    /* AI 偶尔回一句 */
    const bots = this.bots.length ? this.bots : (this.room ? this.room.players.filter((p) => p.isBot) : []);
    if (bots.length && this.rnd() < 0.75) {
      const b = bots[Math.floor(this.rnd() * bots.length)];
      this._later(() => {
        const rep = {
          t: 'chat', from: b.id, nick: b.nick,
          text: BOT_CHAT[Math.floor(this.rnd() * BOT_CHAT.length)],
          time: Date.now(), system: false,
        };
        this.state.chat.push(rep);
        if (this.state.chat.length > 200) this.state.chat.shift();
        this.emit('chat', rep);
        this._touch();
      }, 500 + this.rnd() * 2200);
    }
  }

  _onKlineGet(f) {
    const st = this.market.get(f.stockId);
    if (!st) { this._err('BAD_REQUEST', '股票代码不存在', f.reqId); return; }
    const tf = ['1m', '5m', '15m', '1d'].includes(f.tf) ? f.tf : '1d';
    const bars = this._bars(st, tf).map((b) => b.slice());
    const msg = { t: 'kline', i: st.id, tf, bars };
    if (f.reqId) msg.reqId = f.reqId;
    this.emit('kline', msg);
  }

  /* ══════════════ AI 投资顾问（与服务端 advisor.js 同口径，供演示模式使用）══════════════ */

  _aiMa(list, n) {
    if (!list || list.length < n) return null;
    let s = 0;
    for (let i = list.length - n; i < list.length; i++) s += list[i];
    return s / n;
  }

  _onAiAdvice(f) {
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const r2 = (v) => Math.round(v * 100) / 100;
    const r4 = (v) => Math.round(v * 1e4) / 1e4;
    const pct = (v) => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
    const RATINGS = [[78, 'strong_buy', '强烈买入', '🔥'], [64, 'buy', '谨慎买入', '📈'],
      [46, 'hold', '持有观望', '⏸'], [33, 'reduce', '逢高减仓', '📉'], [-1, 'sell', '建议卖出', '🚨']];

    /* 大盘观点 */
    if (!f.stockId) {
      let up = 0, down = 0, flat = 0, limitUp = 0, limitDown = 0;
      const secAgg = new Map(); const rows = [];
      for (const st of this.market.values()) {
        const chg = st.prevClose > 0 ? st.p / st.prevClose - 1 : 0;
        if (chg > 0.002) up++; else if (chg < -0.002) down++; else flat++;
        if (st.p >= st.limitUp - 0.005) limitUp++;
        if (st.p <= st.limitDown + 0.005) limitDown++;
        const cur = secAgg.get(st.sector) || { sector: st.sector, sum: 0, n: 0 };
        cur.sum += chg; cur.n++; secAgg.set(st.sector, cur);
        rows.push({ id: st.id, name: st.name, chg, price: st.p, dev: (st.fair > 0 ? st.p / st.fair - 1 : 0), vol: st.sigma || 0.0025 });
      }
      const ix = (this.state.indices && this.state.indices[0]) || { n: '同花综指', v: 1200, pct: 0 };
      const mood = ix.pct >= 0.02 ? { id: 'strong', text: '普涨格局', desc: '资金全面做多，注意情绪过热后的回踩' }
        : ix.pct >= 0.005 ? { id: 'warm', text: '偏暖震荡', desc: '赚钱效应尚可，可轻仓参与强势股' }
          : ix.pct > -0.005 ? { id: 'flat', text: '多空胶着', desc: '方向不明，控制仓位、少动多看' }
            : ix.pct > -0.02 ? { id: 'weak', text: '偏弱调整', desc: '反弹是减仓机会，不宜追涨' }
              : { id: 'panic', text: '恐慌杀跌', desc: '空仓等待企稳，不要在下跌中接飞刀' };
      const secs = Array.from(secAgg.values()).map((x) => ({ sector: x.sector, pct: x.sum / Math.max(1, x.n) }))
        .sort((a, b) => b.pct - a.pct);
      const picks = rows.map((r) => {
        const val = clamp(55 - r.dev * 350, 0, 100), mom = clamp(50 + r.chg * 400, 0, 100);
        const pen = r.vol >= 0.006 ? 12 : r.vol >= 0.005 ? 6 : 0;
        return { ...r, aiScore: Math.round(clamp(val * 0.5 + mom * 0.3 + 12 - pen, 0, 100)) };
      }).sort((a, b) => b.aiScore - a.aiScore).slice(0, 3);
      const msg = {
        t: 'ai:market', reqId: f.reqId, ts: Date.now(),
        summary: `${ix.n} ${r2(ix.v)}（${pct(ix.pct)}），全市场 ${up} 涨 / ${down} 跌 / ${flat} 平，涨停 ${limitUp} 家、跌停 ${limitDown} 家 —— ${mood.text}。${mood.desc}。`,
        mood,
        index: { name: ix.n, v: r2(ix.v), pct: r4(ix.pct) },
        breadth: { up, down, flat, limitUp, limitDown },
        sectors: secs.slice(0, 3).concat(secs.slice(-2)).map((x) => ({ sector: x.sector, pct: r4(x.pct) })),
        lines: [
          `领涨板块：${secs[0] ? `${secs[0].sector}（${pct(secs[0].pct)}）` : '—'}`,
          `领跌板块：${secs[secs.length - 1] ? `${secs[secs.length - 1].sector}（${pct(secs[secs.length - 1].pct)}）` : '—'}`,
        ],
        picks: picks.map((p) => ({
          id: p.id, name: p.name, price: r2(p.price), chg: r4(p.chg), dev: r4(p.dev), aiScore: p.aiScore,
          reason: p.dev <= -0.04 ? '低于内在价值，安全边际较高' : p.chg > 0.01 ? '短线动量强，资金关注度高' : '估值与动量均衡，适合跟踪',
        })),
      };
      this.emit('ai:market', msg);
      return;
    }

    /* 个股诊断 */
    const st = this.market.get(f.stockId);
    if (!st) { this._err('BAD_REQUEST', '股票代码不存在', f.reqId); return; }
    const price = st.p, fair = st.fair > 0 ? st.fair : price;
    const dev = fair > 0 ? price / fair - 1 : 0;
    const prevClose = st.prevClose || price;
    const dayPct = prevClose > 0 ? price / prevClose - 1 : 0;
    const bars = this._bars(st, '1m');
    const closes = bars.map((b) => b[4]);
    const m5 = this._aiMa(closes, 5), m10 = this._aiMa(closes, 10), m20 = this._aiMa(closes, 20);
    const valScore = clamp(55 - dev * 350, 0, 100);
    let trendScore = 50, trendText = '均线缠绕，方向不明';
    if (m5 != null && m10 != null && m20 != null) {
      const up = (price > m5 ? 1 : 0) + (m5 > m10 ? 1 : 0) + (m10 > m20 ? 1 : 0);
      trendScore = 18 + up * 26;
      trendText = up === 3 ? '多头排列，趋势向上' : up === 0 ? '空头排列，趋势向下'
        : up === 2 ? '均线偏多，趋势温和向上' : '均线偏空，反弹力度有限';
    }
    const back = closes.length > 20 ? closes[closes.length - 21] : (closes[0] || price);
    const mom = back > 0 ? price / back - 1 : 0;
    const momScore = clamp(50 + mom * 600, 0, 100);
    const curVol = bars.length ? (bars[bars.length - 1][5] || 0) : 0;
    const minutes = Math.max(1, bars.length);
    let cum = 0; for (const b of bars) cum += b[5] || 0;
    const avgV = Math.max(1, cum / minutes);
    const vr = curVol > 0 ? curVol / avgV : 0;
    const volScore = curVol > 0 ? clamp(38 + (vr - 1) * 42, 0, 100) : 45;
    const volText = curVol <= 0 ? '本分钟无成交' : vr > 1.8 ? '显著放量' : vr > 1.2 ? '温和放量' : vr > 0.75 ? '量能正常' : '缩量';
    let bv = 0, av = 0;
    for (const l of (st.b || [])) bv += l[1];
    for (const l of (st.s || [])) av += l[1];
    const wb = (bv + av) > 0 ? (bv - av) / (bv + av) : 0;
    const bookScore = clamp(50 + wb * 120, 0, 100);
    const toUp = (st.limitUp - price) / Math.max(0.01, price);
    const toDown = (price - st.limitDown) / Math.max(0.01, price);
    const risk = []; let riskScore = 70;
    if (price >= st.limitUp - 0.005) { riskScore -= 35; risk.push('已封涨停板，追高需等回封确认，谨防炸板'); }
    else if (toUp < 0.015) { riskScore -= 18; risk.push(`距涨停仅 ${(toUp * 100).toFixed(1)}%，上行空间有限`); }
    if (price <= st.limitDown + 0.005) { riskScore -= 30; risk.push('已封跌停板，流动性枯竭，不要盲目抄底'); }
    else if (toDown < 0.015) { riskScore -= 8; risk.push(`距跌停仅 ${(toDown * 100).toFixed(1)}%，注意下行风险`); }
    const vol0 = st.sigma || 0.0025;
    if (vol0 >= 0.0055) { riskScore -= 12; risk.push('该股波动率显著高于市场平均，仓位要控制'); }
    if (dev > 0.12) { riskScore -= 12; risk.push(`股价已高出内在价值 ${(dev * 100).toFixed(1)}%，外部资金随时可能反向出货`); }
    if (!risk.length) risk.push('暂未发现明显异常风险');
    riskScore = clamp(riskScore, 0, 100);

    const score = Math.round(clamp(valScore * 0.30 + trendScore * 0.25 + momScore * 0.15 +
      volScore * 0.10 + bookScore * 0.10 + riskScore * 0.10, 0, 100));
    const R = RATINGS.find((x) => score >= x[0]) || RATINGS[RATINGS.length - 1];
    const pos = (this.state.account && (this.state.account.positions || []).find((p) => p.i === st.id)) || null;
    const held = pos ? Number(pos.qty) || 0 : 0;
    const avgCost = pos ? Number(pos.avgCost) || 0 : 0;
    const pnlPct = held > 0 && avgCost > 0 ? price / avgCost - 1 : 0;
    const position = held > 0 ? {
      held, avail: pos.avail || 0, avgCost: r2(avgCost), pnlPct: r4(pnlPct),
      advice: (R[1] === 'sell' || R[1] === 'reduce')
        ? (pnlPct >= 0 ? `已浮盈 ${pct(pnlPct)}，建议分批止盈，先卖一半` : `已浮亏 ${pct(pnlPct)}，反弹到成本价附近减仓`)
        : (pnlPct < -0.08 ? `浮亏 ${pct(pnlPct)}，若跌破 ${r2(price * 0.95)} 坚决止损` : `继续持有，跌破 ${r2(price * 0.96)} 止盈保护`),
    } : null;
    const qtyPct = R[1] === 'strong_buy' ? 0.4 : R[1] === 'buy' ? 0.25 : R[1] === 'hold' ? 0 : R[1] === 'reduce' ? 0.5 : 1;
    const lead = [];
    if (dev <= -0.05) lead.push(`当前股价低于内在价值 ${(Math.abs(dev) * 100).toFixed(1)}%，具备安全边际`);
    if (dev >= 0.08) lead.push(`当前股价已高于内在价值 ${(dev * 100).toFixed(1)}%，外部资金有反向出货动机`);
    if (trendScore >= 74) lead.push('均线多头排列，趋势站在买方一边');
    if (trendScore <= 26) lead.push('均线空头排列，反弹到均线附近易遇抛压');
    if (vr > 1.6 && mom > 0) lead.push('放量上攻，资金关注度明显提升');
    if (vr > 0 && vr < 0.6) lead.push('成交低迷，缺乏增量资金推动');
    if (!lead.length) lead.push('各项指标中性，缺乏明确的方向性驱动');

    this.emit('ai:advice', {
      t: 'ai:advice', reqId: f.reqId, stockId: st.id, name: st.name, ts: Date.now(),
      score, rating: R[1], ratingText: R[2],
      summary: `${R[3]} ${R[2]}（综合 ${score} 分）。${lead.slice(0, 2).join('；')}。`,
      fair: r2(fair), dev: r4(dev), dayPct: r4(dayPct),
      breakdown: {
        valuation: Math.round(valScore), trend: Math.round(trendScore), momentum: Math.round(momScore),
        volume: Math.round(volScore), orderbook: Math.round(bookScore), risk: Math.round(riskScore),
      },
      signals: [
        { k: '估值', v: dev <= -0.03 ? `低于内在价值 ${(Math.abs(dev) * 100).toFixed(1)}%` : dev >= 0.03 ? `高于内在价值 ${(dev * 100).toFixed(1)}%` : '与内在价值基本持平', dir: dev <= -0.03 ? 1 : dev >= 0.03 ? -1 : 0 },
        { k: '趋势', v: trendText, dir: trendScore >= 62 ? 1 : trendScore <= 38 ? -1 : 0 },
        { k: '动量', v: `近 20 分钟 ${pct(mom)}`, dir: momScore >= 60 ? 1 : momScore <= 40 ? -1 : 0 },
        { k: '量能', v: `${volText}${vr > 0 ? `（${vr.toFixed(2)} 倍）` : ''}`, dir: vr > 1.6 ? 1 : vr > 0 && vr < 0.6 ? -1 : 0 },
        { k: '盘口', v: wb > 0.12 ? '买盘明显强于卖盘' : wb < -0.12 ? '卖压偏重' : '买卖力量均衡', dir: wb > 0.12 ? 1 : wb < -0.12 ? -1 : 0 },
        { k: '当日', v: `${pct(dayPct)}（昨收 ${r2(prevClose)}）`, dir: dayPct > 0.005 ? 1 : dayPct < -0.005 ? -1 : 0 },
      ],
      risks: risk.slice(0, 4),
      position,
      suggestion: {
        action: R[1],
        actionText: R[1] === 'strong_buy' ? '可分批建仓（首仓 4 成）' : R[1] === 'buy' ? '可轻仓试错（2~3 成）'
          : R[1] === 'hold' ? (held > 0 ? '持有不动，等待方向选择' : '暂不参与，等放量突破')
            : R[1] === 'reduce' ? '逢高减掉一半仓位' : '清仓离场，不要摊平成本',
        qtyPct,
        priceLow: r2(price * 0.997), priceHigh: r2(price * 1.003),
        stopLoss: r2(price * (1 - clamp(vol0 * 6 + 0.02, 0.025, 0.09))),
        takeProfit: r2(price * (1 + clamp(vol0 * 8 + 0.04, 0.05, 0.18))),
      },
    });
  }

  /** 房主移出成员（Mock 版，行为与服务端一致） */
  _onRoomKick(f) {
    const r = this.room;
    if (!r) { this._err('NOT_IN_ROOM', '你当前不在任何房间', f.reqId); return; }
    if (r.hostId !== (this.player && this.player.id)) { this._err('NOT_HOST', '只有房主可以移出成员', f.reqId); return; }
    const id = String(f.playerId || '');
    if (!id || id === r.hostId) { this._err('BAD_REQUEST', '不能移出房主自己', f.reqId); return; }
    const idx = (r.players || []).findIndex((p) => p.id === id);
    if (idx < 0) { this._err('BAD_REQUEST', '该玩家不在本房间内', f.reqId); return; }
    if (r.status !== 'waiting') { this._err('BAD_REQUEST', '对局已经开始，无法移出成员', f.reqId); return; }
    const [gone] = r.players.splice(idx, 1);
    this.emit('room:update', { t: 'room:update', room: r, reqId: f.reqId });
    this.emit('chat', { t: 'chat', from: 'system', nick: '系统', system: true,
      text: `${gone.nick} 已被房主移出房间`, time: Date.now() });
    if (f.reqId) this.emit('room:kick', { t: 'room:kick', ok: true, playerId: id, nick: gone.nick, reqId: f.reqId });
  }

  _onPing(f) {
    const ts = Number(f.ts) || Date.now();
    this.emit('pong', { t: 'pong', ts, serverTime: Date.now(), rtt: 8 + Math.floor(this.rnd() * 26) });
  }

  /* ══════════════ 2.8 登录 / 对局生命周期 ══════════════ */

  _onLogin(f) {
    if (this.loggedIn) {
      /* 断线重连：返回同一个身份 */
      this.emit('login_ok', this._loginOkMsg());
      return;
    }
    const nick = String(f.nick || this.options.nick || '韭菜甲').slice(0, 12) || '韭菜甲';
    this.nick = nick;
    if (Number.isFinite(Number(f.avatar))) this.avatar = clamp(Math.floor(Number(f.avatar)), 0, 11);
    const elo = 900 + Math.floor(this.rnd() * 260);
    this.player = {
      id: 'p_me', nick, avatar: this.avatar, elo,
      tier: tierOf(elo), wins: 1 + Math.floor(this.rnd() * 5), losses: 1 + Math.floor(this.rnd() * 6), games: 0,
    };
    this.player.games = this.player.wins + this.player.losses;
    this.token = 'tk_' + Math.floor(this.rnd() * 1e12).toString(36);
    this.loggedIn = true;
    this.state.player = this.player;
    this.state.token = this.token;
    this.state.config = this._config();
    this.state.online = this._online();

    this.emit('login_ok', this._loginOkMsg());

    /* bootView / auto 参数：自动进入对应状态，保证界面立刻有完整数据 */
    const boot = this.bootView;
    if (this.wantAuto) {
      this.countdownMs = 220;
      this._later(() => this._onRoomQuick({ mode: this.params.mode || 'ffa', durationSec: Number(this.params.durationSec || this.params.duration) || 900, startCash: Number(this.params.startCash || this.params.cash) || 1000000 }), 20);
    } else if (boot === 'trade') {
      this._startMatchNow('ffa');
    } else if (boot === 'result') {
      this._demoResult();
    }
  }

  _loginOkMsg() {
    return {
      t: 'login_ok', token: this.token, serverTime: Date.now(),
      player: this.player, config: this._config(),
    };
  }

  _config() {
    return {
      tickMs: this.tickMs,
      virtualDayTicks: VIRTUAL_DAY_TICKS,
      modes: MODES.map((m) => ({ id: m.id, name: m.name, maxPlayers: m.maxPlayers })),
      maxPlayers: 30,
      playerCountOptions: [2, 4, 6, 8, 12, 16, 20, 24, 30],
      durations: DURATIONS.map((d) => ({ sec: d.sec, name: d.name })),
      startCashOptions: START_CASH_OPTIONS.slice(),
      fee: { ...FEE },
      lotSize: LOT_SIZE,
      limitPct: 0.10,
      limitPct20: 0.20,
    };
  }

  /** 直接开局（不做房间流程），供 view=trade / auto 使用 */
  _startMatchNow(mode) {
    const r = this._roomCreate({
      name: '演示对局', mode, maxPlayers: mode === '1v1' ? 2 : 6,
      durationSec: Number(this.params.durationSec || this.params.duration) || 900,
      startCash: Number(this.params.startCash || this.params.cash) || 1000000,
      fillBots: true,
    });
    this._fillBots(r);
    if (r.mode === 'team') {
      const teams = {};
      r.players.forEach((p, idx) => { teams[p.id] = idx % 2 === 0 ? 'red' : 'blue'; });
      r.teams = teams;
    }
    this.room = r;
    this.state.room = this._roomInfo(r);
    this._beginMatch(r);
  }

  _beginMatch(r) {
    const startCash = r.startCash || 1000000;
    const now = Date.now();
    r.status = 'playing';
    r.countdown = 0;
    const mode = r.mode || 'ffa';
    const match = {
      id: 'm_' + Math.floor(this.rnd() * 0xfffff).toString(36),
      mode, durationSec: r.durationSec, startedAt: now,
      endsAt: now + r.durationSec * 1000,
      startCash, tickMs: this.tickMs, virtualDayTicks: VIRTUAL_DAY_TICKS,
      sectors: this.sectors.slice(),
    };
    r.matchId = match.id;

    /* 选手 → rank 机器人 */
    const botEntries = r.players.filter((p) => p.isBot);
    this.bots = botEntries.map((p) => ({
      id: p.id, nick: p.nick, avatar: p.avatar, tier: p.tier, elo: p.elo,
      alpha: (this.rnd() - 0.35) * 0.0004, vol: 0.0012 + this.rnd() * 0.0025,
      assets: startCash, equity: [[0, startCash]],
    }));
    this.teams = r.teams || null;

    /* 重置行情/账户到开盘状态 */
    this._resetSession(startCash);
    this.seq = 0;
    this.match = match;
    this.endsAt = match.endsAt;
    this.playing = true;
    this.breakUntil = 0;              // 上一局若在午间休市里结束，别把休市带给新一局
    this.breakLeftSec = 0;
    this._nextNewsSeq = 8 + Math.floor(this.rnd() * 6);

    /* 广播开局 */
    this.emit('game:start', {
      t: 'game:start', match,
      stocks: this.stockIds.map((id) => this.metaOf(id)),
      teams: this.teams,
    });
    this._broadcastRoom(r);
    this.state.match = match;
    this.state.stocks = new Map(this.stockIds.map((id) => [id, this.metaOf(id)]));
    this.state.quotes = new Map();
    this.state.klines = new Map();
    this.state.timeshare = new Map();
    this.state.news = [];
    this.state.rank = [];
    this.state.result = null;
    this.state.online = this._online();
    this._syncKlinesToState();
    for (const [id, ts] of this._timeshare) this.state.timeshare.set(id, ts);

    /* 立刻推一条 tick + 账户 + 排行，保证界面马上有数据 */
    this._tick();
    this._pushAccount();
    this._pushRank();
    if (!this.state.news.length) {
      const n = this._makeNews();
      this.state.news.unshift(n);
      this.emit('news', { t: 'news', news: n });
    }

    /* 行情循环 */
    if (this._interval) clearInterval(this._interval);
    this._interval = setInterval(() => { if (this.playing) this._tick(); }, this.tickMs);
    this._touch();
  }

  _syncKlinesToState() {
    for (const st of this.market.values()) {
      this.state.klines.set(st.id + ':1m', st.hist.k1m);
      this.state.klines.set(st.id + ':5m', st.hist.k5);
      this.state.klines.set(st.id + ':15m', st.hist.k15);
      this.state.klines.set(st.id + ':1d', st.hist.k1d);
    }
  }

  _resetSession(startCash) {
    for (const st of this.market.values()) {
      st.shock = 0; st.surge = 0; st.impact = 0;
      st.p = round2(st.base);
      st.lastMinuteClose = st.p;
      st.minuteOpen = st.p;
      if (this.dayIndex === 0 && st.dayInit) {
        st.day = { ...st.dayInit };
      } else {
        st.day = { o: st.p, h: st.p, l: st.p, v: 0, a: 0 };
      }
      this._buildBook(st);
      st.tr = [];
    }
    this._buildAccount(startCash);
    this.acct.equity.push([0, startCash]);
    this.state.account = this._accountMsg();
  }

  _recordEquity() {
    if (!this.match) return;
    const t = this._computeAssets();
    const eq = this.acct.equity;
    /* 资产曲线的时间轴：正常对局用真实耗时；?view=result 的同步演示用合成时钟铺满整局 */
    const ms = (this._synthT !== null && this._synthT !== undefined)
      ? this._synthT
      : (Date.now() - this.match.startedAt);
    eq.push([Math.max(0, Math.round(ms)), t.totalAssets]);
    if (eq.length > MAX_EQUITY) {
      const thinned = [];
      for (let i = 0; i < eq.length; i += 2) thinned.push(eq[i]);
      const last = eq[eq.length - 1];
      if (thinned[thinned.length - 1] !== last) thinned.push(last);
      this.acct.equity = thinned;
    }
  }

  /* ══════════════ 2.9 结算 ══════════════ */

  endMatch(reason = 'host_end') {
    if (!this.match || !this.playing) return null;
    this.playing = false;
    if (this._interval) { clearInterval(this._interval); this._interval = null; }

    const match = this.match;
    const t = this._computeAssets();
    const eq = this._padEquity(
      this.acct.equity.concat([[Date.now() - match.startedAt, t.totalAssets]]).filter((x, i, arr) => i === 0 || x[0] > arr[i - 1][0]),
      60
    );
    const meRow = {
      id: this.player.id, nick: this.player.nick, avatar: this.player.avatar, isBot: false,
      assets: t.totalAssets, returnPct: round4(t.pnlPct),
      maxDrawdown: this._maxDrawdown(eq),
      tradeCount: this.acct.tradeCount, feeTotal: this.acct.feeTotal,
      equity: eq, tier: this.player.tier, eloDelta: 0,
    };
    const botRows = this.bots.map((b) => {
      const beq = this._padEquity(b.equity.concat([[Date.now() - match.startedAt, round2(b.assets)]]), 60);
      return {
        id: b.id, nick: b.nick, avatar: b.avatar, isBot: true,
        assets: round2(b.assets), returnPct: round4((b.assets - match.startCash) / match.startCash),
        maxDrawdown: this._maxDrawdown(beq),
        tradeCount: 4 + Math.floor(this.rnd() * 30),
        feeTotal: round2(200 + this.rnd() * 4000),
        equity: beq, tier: b.tier, eloDelta: 0,
      };
    });
    const list = [meRow, ...botRows].sort((x, y) => y.assets - x.assets);
    const n = list.length;
    list.forEach((row, idx) => {
      const score = n > 1 ? 1 - idx / (n - 1) : 0.5;
      row.rank = idx + 1;
      row.eloDelta = Math.round(clamp(30 * (score - 0.5) * 2, -38, 38) + (this.rnd() - 0.5) * 6);
      if (row.isBot) row.tier = tierOf(row.eloDelta + 1300);
    });
    /* 自己的段位变化 */
    const oldTier = this.player.tier;
    const newElo = Math.max(100, this.player.elo + meRow.eloDelta);
    const newTier = tierOf(newElo);
    this.player.elo = newElo;
    this.player.tier = newTier;
    this.player.games += 1;
    if (meRow.rank === 1) this.player.wins += 1; else this.player.losses += 1;
    this.state.player = this.player;
    const tierChanges = [];
    if (newTier !== oldTier) tierChanges.push({ id: this.player.id, from: oldTier, to: newTier, elo: newElo });

    let teams = null;
    if (this.teams) {
      const agg = { red: { sum: 0, n: 0 }, blue: { sum: 0, n: 0 } };
      for (const row of list) {
        const team = this.teams[row.id];
        if (!team || !agg[team]) continue;
        agg[team].sum += row.returnPct; agg[team].n += 1;
      }
      const redPct = agg.red.n ? agg.red.sum / agg.red.n : 0;
      const bluePct = agg.blue.n ? agg.blue.sum / agg.blue.n : 0;
      teams = {
        red: { returnPct: round4(redPct), score: redPct > bluePct ? 1 : 0 },
        blue: { returnPct: round4(bluePct), score: bluePct > redPct ? 1 : 0 },
      };
    }

    const result = { matchId: match.id, reason, rank: list, tierChanges };
    if (this.room) { this.room.status = 'finished'; this._broadcastRoom(this.room); }
    this.playing = false;
    this.emit('game:over', { t: 'game:over', result, teams });
    this.state.result = { t: 'game:over', result, teams };
    this.state.rank = list.map((r) => ({
      id: r.id, nick: r.nick, avatar: r.avatar, assets: r.assets, returnPct: r.returnPct,
      isBot: r.isBot, isMe: !r.isBot, tier: r.tier, team: this.teams ? this.teams[r.id] : null,
      todayPnl: round2(r.assets - match.startCash),
    }));
    this._touch();
    return result;
  }

  _maxDrawdown(eq) {
    let peak = -Infinity, mdd = 0;
    for (const [, v] of eq) {
      if (v > peak) peak = v;
      const dd = (v - peak) / (peak || 1);
      if (dd < mdd) mdd = dd;
    }
    return round4(mdd);
  }

  _padEquity(eq, min = 60) {
    const src = (eq && eq.length) ? eq.slice() : [[0, this.startCash]];
    if (src.length < min) {
      const out = [];
      const n = src.length;
      for (let i = 0; i < min; i++) {
        const f = n > 1 ? (i / (min - 1)) * (n - 1) : 0;
        const i0 = Math.floor(f);
        const i1 = Math.min(n - 1, i0 + 1);
        const k = f - i0;
        const t = src[i0][0] + (src[i1][0] - src[i0][0]) * k;
        const v = src[i0][1] + (src[i1][1] - src[i0][1]) * k;
        out.push([Math.round(t), round2(v)]);
      }
      return out;
    }
    return src.map((p) => [Math.round(p[0]), round2(p[1])]);
  }

  /* ══════════════ 2.10 调试接口 / 杂项 ══════════════ */

  forceTick() { this._tick(); return this.seq; }

  speed(x) {
    this.speedX = clamp(Number(x) || 1, 0.01, 60);
    this.tickMs = Math.round(BASE_TICK_MS / this.speedX);
    if (this.match) this.match.tickMs = this.tickMs;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = setInterval(() => { if (this.playing) this._tick(); }, this.tickMs);
    }
    return this.tickMs;
  }

  setStock(id) {
    if (!this.market.has(id)) return false;
    this.state.ui.stockId = id;
    this._touch();
    return true;
  }

  /** ?view=result：跑一段无声对局并立刻结算，保证结算页有完整数据 */
  _demoResult() {
    this._quiet = true;
    this._startMatchNow(this.params.mode || 'ffa');
    const ticks = 150;
    const durMs = (this.match ? this.match.durationSec : 900) * 1000;
    for (let i = 0; i < ticks; i++) {
      this._synthT = Math.round(((i + 1) / ticks) * durMs);   // 合成时钟：曲线铺满整局
      this._tick();
      if (i % 17 === 0) this._demoTrade();
    }
    this._synthT = undefined;
    this._quiet = false;
    this.endMatch('timeup');
  }

  _demoTrade() {
    const ids = this.stockIds.filter((id) => this.rnd() < 0.35);
    if (!ids.length) return;
    const id = ids[Math.floor(this.rnd() * ids.length)];
    const st = this.market.get(id);
    const q = this._quoteOf(st);
    if (this.rnd() < 0.6) {
      const lots = 1 + Math.floor(this.rnd() * 5);
      const qty = lots * LOT_SIZE;
      const price = round2(clamp(q.s[0][0], st.limitDown, st.limitUp));
      if (this.acct.cash > this._needCash(price, qty)) {
        const order = {
          id: this._newOrderId(), i: id, side: 'buy', type: 'limit', price, qty,
          filled: 0, status: 'open', time: Date.now(), frozen: 0,
        };
        this.acct.orders.set(order.id, order);
        this._freezeOrderCash(order, this._needCash(price, qty));
        this._tryFillOrder(order, true);
      }
    } else {
      const pos = this.acct.positions.get(id);
      if (pos && pos.avail >= LOT_SIZE) {
        const qty = Math.min(pos.avail, (1 + Math.floor(this.rnd() * 3)) * LOT_SIZE);
        const price = round2(clamp(q.b[0][0], st.limitDown, st.limitUp));
        const order = {
          id: this._newOrderId(), i: id, side: 'sell', type: 'limit', price, qty,
          filled: 0, status: 'open', time: Date.now(), frozen: 0,
        };
        this.acct.orders.set(order.id, order);
        pos.avail -= qty;
        this._tryFillOrder(order, true);
      }
    }
  }

  teamOf(id) { return this.teams ? (this.teams[id] || null) : null; }

  _later(fn, ms) {
    const id = setTimeout(() => { this._timers.delete(id); fn(); }, ms);
    this._timers.add(id);
    return id;
  }

  _syncState(patch) { Object.assign(this.state, patch); this._touch(); }

  _touch() {
    try { if (typeof touch === 'function') touch(); } catch (e) { /* ignore */ }
  }
}

export default MockNet;
