# 同花亏 (TongHuaKui) 设计规范 v1.0

> 「同样的行情，不同的亏损。」—— 一个模仿同花顺 UI 的多人联网股票交易商业模拟对战游戏。
> 本文件冻结**目录结构、模块接口、UI 契约**。并行开发时不得擅自改动这里定义的跨模块接口；确需改动必须先改本文件。

---

## 1. 技术选型（不可更改）

* **服务端**：Node.js（>= 18，目标 Windows Server 2016+ / Node 20/22/24 LTS），**零第三方运行时依赖**（不装 npm 包，`npm install` 后无 node_modules 也能跑）。
  * WebSocket 自己实现 RFC6455（`server/src/ws.js`），静态文件自己实现（`server/src/static.js`）。这样在 Windows Server 上只需装 Node，不需要编译工具链。
* **客户端**：纯静态 Web 客户端（原生 ES Module + Canvas 2D），**无构建步骤**，由服务端直接托管。手机/桌面浏览器均可访问。
* **持久化**：`data/store.json`（原子写入：临时文件 + rename），无需数据库。
* **模块系统**：服务端 CommonJS（`require`）；客户端 ES Module（`import`，`<script type="module">`）。

## 2. 目录结构（谁写哪个文件是冻结的）

```
tonghuakui/
├── PROTOCOL.md              # 通信协议（唯一接口契约）
├── DESIGN.md                # 本文件
├── README.md                # 快速开始（根目录）
├── server/
│   ├── server.js            # 入口：http + static + ws + lobby + 优雅退出
│   └── src/
│       ├── config.js        # 全部可调参数 + 股票池（已提供，勿改接口）
│       ├── util.js          # 工具函数（已提供，勿改接口）
│       ├── ws.js            # 零依赖 RFC6455 服务端
│       ├── static.js        # 静态文件服务（.html/.js/.css/.svg/.png/.json）
│       ├── market.js        # 行情引擎
│       ├── news.js          # 新闻/事件引擎
│       ├── engine.js        # 撮合引擎（合成流动性 + 玩家订单簿）
│       ├── portfolio.js     # 账户/持仓/委托/成交
│       ├── elo.js           # ELO 与段位
│       ├── bot.js           # AI 机器人
│       ├── room.js          # 房间 = 一局对战
│       ├── lobby.js         # 大厅/匹配/房间管理/持久化接入
│       └── net.js           # 连接会话与消息路由
├── client/
│   ├── index.html           # 单页外壳，仅含 #app 与模块入口
│   ├── css/{theme.css,app.css,trade.css,chart.css}
│   └── js/
│       ├── main.js          # 引导 + 路由 + 全局消息处理
│       ├── net.js           # WebSocket 客户端（自动重连/心跳/请求应答）
│       ├── store.js         # 全局状态
│       ├── util.js          # 工具/格式化/DOM helper
│       ├── views/{login.js,lobby.js,trade.js,result.js}
│       └── components/{toast.js,chart.js,chart-panel.js,quote-list.js,depth.js,order-form.js,tables.js}
├── tools/                   # Windows 启停脚本 + 本地脚本
├── docs/                    # 部署文档、玩法说明、测试报告
└── data/                    # 运行时数据（store.json）
```

## 3. 服务端模块接口契约

### 3.1 `ws.js` —— 零依赖 WebSocket

```js
const { WebSocketServer } = require('./ws');
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
wss.on('connection', (conn) => { ... });        // conn: WSConn
wss.clients                                      // Set<WSConn>
wss.close(cb)
```

`WSConn`（EventEmitter）：

| 成员 | 说明 |
|---|---|
| `conn.id` | `'c_1'` 自增 id |
| `conn.remoteAddress` | 客户端 IP |
| `conn.isAlive` | 心跳标记，由 `wss.heartbeat()` 维护 |
| `conn.send(data)` | `data` 为对象则 `JSON.stringify`；字符串直接发。返回 bool |
| `conn.close(code = 1000, reason = '')` | 优雅关闭（发 close 帧） |
| `conn.terminate()` | 立即销毁 |
| `event 'message'` | `(text: string)` 文本消息（二进制帧忽略并计数） |
| `event 'close'` | `(code, reason)` |
| `event 'error'` | `(err)` |

必须支持：握手（`Sec-WebSocket-Accept`）、掩码解帧、payload 长度 126/127、分片续帧、ping/pong、close 握手、非法帧关闭（1002）。必须提供 `wss.heartbeat()`（每 30s 调用一次：ping 所有连接，两次无 pong 则 terminate）。**不得协商任何扩展（no permessage-deflate）**。

### 3.2 `static.js`

```js
const { createStaticHandler } = require('./static');
const handler = createStaticHandler(path.join(__dirname, '..', '..', 'client'));
const handled = await handler(req, res);   // 返回 false 表示未处理（404 由调用方决定）
```
要求：路径穿越防护（解析后必须仍在 root 内）、`index.html` 兜底（SPA 路由到 `/`）、正确 MIME（含 `.js → text/javascript; charset=utf-8`，UTF-8 中文不能乱码）、`Cache-Control: no-cache`、支持 HEAD、支持 HTTP Range 可选（不必须）。

### 3.3 `config.js`（已提供）

导出：`SERVER_NAME, VERSION, PORT, HOST, TICK_MS, VIRTUAL_DAY_TICKS, DURATIONS, START_CASH_OPTIONS, MODES, FEE, LOT_SIZE, LIMIT_PCT, LIMIT_PCT_20, SECTORS, STOCKS, BOT_NAMES, MAX_CHAT_LEN, MAX_ORDERS_PER_PLAYER, HEARTBEAT_MS, DATA_FILE`。
`STOCKS: [{ id, name, sector, prevClose, vol, drift, beta, floatShares, pe }]`，`vol/drift` 为每 tick 的对数收益率标准差/漂移。

#### `server/src/advisor.js` —— AI 投资顾问（同花顺「AI 诊股」）

```js
advise({ market, seat, room, stockId, config }) -> {
  score, rating, ratingText, summary, fair, dev, dayPct,
  breakdown: { valuation, trend, momentum, volume, orderbook, risk },   // 0~100
  signals: [{ k, v, dir }], risks: [string],
  position: { held, avail, avgCost, pnlPct, advice } | null,
  suggestion: { action, actionText, qtyPct, priceLow, priceHigh, stopLoss, takeProfit }
}
marketView({ market, room, config }) -> { summary, mood, index, breadth, sectors, lines, picks }

ratingOf(score) -> { id, text, emoji }     // >=78 strong_buy / >=64 buy / >=46 hold / >=33 reduce / else sell
```

**评分口径**：估值 30% + 趋势 25% + 动量 15% + 量能 10% + 盘口 10% + 风险 10%。
估值项使用 `st.fair`（内在价值，不受玩家买卖影响），因此建议无法被客户端伪造。

> ⚠️ 依赖 `market.getState()` 暴露 `fair` / `impact`；量能项用「最近 1 分钟 K 的量 ÷ 当日平均每 tick 量」，累计量取 `quote.v`（`getState()` 不含 `v`）。

### 3.4 `market.js`

```js
class Market {
  constructor({ stocks, config });         // config = require('./config')
  reset();                                  // 重新生成一天的历史 K 线（开局调用一次）
  get seq(); get vtime(); get vclock(); get dayIndex(); get minuteOfDay();
  getMeta();                                // 静态元数据数组（PROTOCOL game:start 的 stocks）
  getState(stockId);                        // 内部状态（撮合引擎需要 prevClose/limitUp/limitDown/price）
  getQuote(stockId);                        // 完整行情对象（服务端内部格式，见下）
  getQuote(stockId, externalBook);          // externalBook={bids:[[p,q]],asks:[[p,q]]}：把玩家挂单并进五档后再返回
  getIndices();                             // [{c,n,v,pc,pct,amt}] 虚拟大盘指数（同花综指/同花成指）
  tick();                                   // 推进 1 tick → { seq, vtime, vclock, idx:[...], quotes:[内部行情] }
  applyFlow(stockId, signedQty, side);      // 玩家成交的价格冲击
  recordTrade(stockId, price, qty);         // 把外部（玩家之间）成交计入 v/a/均价/K线/成交明细
  consumeLiquidity(stockId, side, qty, limitPrice) // 吃合成流动性（最多延续 10 档 / 偏离 touch 0.6%，不得无限续档）
        // → { fills:[{price, qty}], filledQty, avgPrice, notional }
  getBars(stockId, tf, limit);              // tf: '1m'|'5m'|'1d' → [[t,o,h,l,c,v], ...] 升序
  applyNewsImpact({ sector, stockId, dir, strength });  // dir: 1 利多 / -1 利空
  sectorOf(stockId);
}
```
内部行情对象（服务端 → tick 报文时转协议格式）：
```js
{ i, p, o, h, l, pc, v, a, avg, b:[[p,v]...5], s:[[p,v]...5], tr:[[p,v,dir]...], limitUp, limitDown }
```
`tick()` 内必须完成：板块因子演进 → 个股随机游走 + 均值回复 → 新闻冲击衰减 → 玩家冲击衰减 → 涨跌停夹断 → 五档挂单量与成交明细刷新 → 分钟/日 K 聚合。

### 3.5 `engine.js`

```js
class MatchingEngine {
  constructor({ market, config });
  reset();
  registerPortfolio(pf);
  placeOrder(pf, { stockId, side, type, price, qty, reqId })
      // → { ok:boolean, msg, order, trades:[...] }
  cancelOrder(pf, orderId) → { ok, msg, order }
  onTick({ vtime, dayIndex });   // 合成流量吃挂单、T+1 日切（调用 pf.settleDay）、超时处理
  getBook(stockId) → { bids:[{price,qty}], asks:[{price,qty}] };
  getBookLevels(stockId) → { bids:[[price,qty]], asks:[[price,qty]] };  // 纯数组，供并进五档盘口
  stats();
}
```
**撮合按「跨源价格优先」**：合成盘与玩家挂单中价格更优的一方先成交；同价时优先吃玩家挂单（那才是真实成交）。

**事件**：`MatchingEngine` 继承 `EventEmitter`，委托状态变化时 `emit('order', { playerId, order, trades, reason })`，`reason ∈ 'filled'|'partial'|'canceled'|'rejected'`；`order.expired === true` 表示超时自动撤单。room.js 据此给玩家推消息。

撮合规则见 `PROTOCOL.md` §3。`placeOrder` 必须在内部完成：校验 → 冻结 → 吃合成流动性 → 与对手玩家挂单撮合 → 剩余挂单入簿。
`pf` 必须实现的接口（由 `portfolio.js` 提供）：见 3.6。引擎**不直接改** `pf.cash/positions`，一律通过 `pf` 的方法。

### 3.6 `portfolio.js`

```js
class Portfolio {
  constructor({ id, startCash, config, market });   // market 用于 mark-to-market
  id; startCash;
  cash; frozen;                                     // 可用现金 = cash, 冻结 = frozen
  positions;   // Map<stockId, { qty, avail, avgCost, lastBuyDay }>
  orders;      // Map<orderId, order>
  trades;      // 数组，最新在前，最多 500 条
  equity;      // [[vtime, totalAssets], ...] 最多 400 点
  // 查询
  getAvailableCash();                                // = cash
  getPosition(stockId);                              // 不存在则返回 {qty:0, avail:0, avgCost:0}
  computeAssets();                                   // { cash, frozen, marketValue, totalAssets, pnl, pnlPct }
  snapshot();                                        // PROTOCOL §2.4 account 报文
  // 资金/持仓冻结（引擎调用）
  freezeCash(amount); unfreezeCash(amount);
  freezeShares(stockId, qty); unfreezeShares(stockId, qty);
  // 记账（引擎调用；负责成本价、已实现盈亏、可用股份的 T+1 逻辑）
  applyTrade({ stockId, side, price, qty, fee, orderId, vtime, dayIndex });
  addOrder(order); updateOrder(order); removeOrder(orderId);
  // 日切 / 采样
  settleDay(dayIndex);       // avail = qty（T+1 解禁）
  markToMarket(vtime);       // 记录 equity 点（按虚拟时间节流，最多 400 点）
  maxDrawdown();             // 返回负数，如 -0.083
  tradeStats();              // { tradeCount, feeTotal, realizedPnl, winRate }
}
```
T+1：**买入当日 `qty` 增加但 `avail` 不增加**；`settleDay` 时 `avail = qty`。

### 3.7 `news.js`

```js
class NewsEngine {
  constructor({ market, config });
  reset();
  maybeGenerate({ seq, vtime }) → news|null   // 内部概率：约每 40~90 tick 一条，开盘前 30 tick 必有 1 条
}
```
新闻必须调用 `market.applyNewsImpact` 或由调用方（`room.js`）根据 `news.impact` 施加影响。`news` 结构见 `PROTOCOL.md` §2.5，额外字段 `impact:{sector, stockId, dir, strength}`。

### 3.8 `elo.js`

```js
module.exports = { tierOf(elo), K_FACTOR, eloDuel(eloA, eloB, scoreA), eloMulti(results) };
// eloMulti(results: [{id, elo, rank}]) → Map<id, delta>
```

### 3.9 `bot.js`

```js
class BotBrain {
  constructor({ portfolio, market, engine, config, stockIds, difficulty });
  step({ seq, vtime });   // 每 tick 调用；内部自行决定是否下单（参考：动量/均值回归/追涨杀跌/随机）
}
```

### 3.10 `room.js`

```js
class Room extends EventEmitter {
  constructor({ id, name, mode, maxPlayers, durationSec, startCash, fillBots, lobby, config });
  // 玩家对象由 lobby 提供，结构见 3.11
  addPlayer(player); removePlayer(playerId);
  setReady(playerId, bool); setHost(playerId);
  canStart(); start();              // 开局：reset market/engine/portfolio/news → loop()
  finish(reason);                   // 'timeup'|'forfeit'|'host_end'
  sendTo(playerId, msg); broadcast(msg, filterFn)
  toInfo();                         // room:update 报文的 room 字段
  isFull(); isEmpty(); status;      // 'waiting'|'countdown'|'playing'|'finished'
}
```
`loop()` 使用 `setInterval(TICK_MS)`（**必须用 `setTimeout` 链式 + 累计误差修正**，避免长时间漂移）。每 tick 顺序：
`market.tick()` → `engine.onTick()` → 每个 `BotBrain.step()` → 每个 `portfolio.markToMarket()` → 每 tick 广播 `tick` → 每 3 tick 广播 `rank` → 每个玩家私发 `account`（成交/委托变化时立即发，否则每 3 tick 一次）→ 结束判定（`Date.now() >= endsAt`）。
结算产出 `game:over` 报文所需结构（含每人 `equity`、`maxDrawdown`、`tradeCount`、`feeTotal`、`eloDelta`、`tierChanges`）。

### 3.11 `lobby.js` / `net.js`

```js
class Lobby extends EventEmitter {
  constructor({ config, store });
  listRooms(); createRoom(player, opts); joinRoom(player, roomId); quickMatch(player, opts);
  leaveRoom(player); getRoomOf(player); rm; players: Map<id, player>;
  recordResult(room, result);      // ELO + 持久化
}
```
`player`（服务端内部会话对象）：
```js
{ id, nick, avatar, token, elo, tier, wins, losses, games, conn, roomId, isBot,
  send(msg), disconnect() }
```
`net.js`：`class Net { constructor({lobby, config}); handle(conn) }`，负责解析报文、限流（每连接每秒 ≤ 30 条）、心跳、断线重连（`token` 恢复身份并在对局中继续）、把 `PROTOCOL` 中的 C2S 消息分发到 `lobby`/`room`/`engine`。

### 3.12 `store.js`

```js
class Store {
  constructor(file); load(); save();                       // 原子写 + 防抖 1s
  getPlayer(nick); upsertPlayer({nick, elo, tier, wins, losses, games});
  recordMatch(record); leaderboard(n = 50);
  close();
}
```

## 4. 客户端契约（并行开发必须遵守）

### 4.1 `ctx`（所有视图/组件收到的上下文对象）

```js
ctx = {
  net,                        // NetClient 实例
  state,                      // store.js 导出的 State 单例
  root,                       // 当前视图挂载的 DOM 容器
  go(view, params),           // 'login' | 'lobby' | 'trade' | 'result'
  toast(msg, level),          // level: 'info'|'success'|'warn'|'error'
  on(type, fn),               // 订阅服务端消息，返回 off()
  onState(fn),                // 订阅状态变更，返回 off()
}
```

### 4.2 `state` 结构（冻结）

```js
state = {
  connected: false, view: 'login', online: 0, serverTime: 0,
  player: null,               // login_ok 的 player
  token: null,
  config: null,               // login_ok 的 config
  lobby: { rooms: [] },
  room: null,                 // room:update 的 room
  chat: [],
  match: null,                // game:start 的 match
  stocks: new Map(),          // id -> meta，保持服务端顺序
  quotes: new Map(),          // id -> { i,p,o,h,l,pc,v,a,b,s,tr, 以及客户端算出的 change/changePct }
  klines: new Map(),          // `${id}:${tf}` -> bars
  account: null,              // account 报文
  rank: [], news: [], result: null,
  ui: { stockId: null, tf: '1d', dark: false, orderSide: 'buy',
        bottomTab: 'positions', boardTab: 'quote', logTab: 'all', search: '' },
}
state.quote(id)   // 可能为 undefined
state.stock(id)   // meta
state.stockList() // 按服务端顺序的 meta 数组
```

### 4.3 `net.js`

```js
class NetClient extends EventTarget {
  connect(url);                 // 自动重连（指数退避 1s→8s），重连后自动重新 login
  send(t, fields = {});         // 立即发送，未连接则入队（仅入队 login/lobby:list）
  on(type, fn);                 // 返回 off()
  request(t, fields, matchType, timeoutMs = 5000);  // 返回 Promise，按 reqId 匹配应答
  close();
}
```

### 4.4 组件接口（跨模块 seam，冻结）

| 文件 | 导出 | 说明 |
|---|---|---|
| `components/toast.js` | `createToast(root)` → `{ show(msg, level), destroy() }` | 右下角浮层通知 |
| `components/chart.js` | `class Chart { constructor(canvas); setData(data); resize(); render(); destroy(); }` | 纯 Canvas 绘图，不访问 state |
| `components/chart-panel.js` | `createChartPanel(host, ctx)` → `{ setStock(id), refresh(), destroy() }` | 含 分时/1分/5分/日K 切换、指标(MA/MACD/成交量)、十字光标 |
| `components/quote-list.js` | `createQuoteList(host, ctx)` → `{ update(), destroy() }` | 左侧自选/行情列表，点击切换 `state.ui.stockId` |
| `components/depth.js` | `createDepth(host, ctx)` → `{ update(), destroy() }` | 五档盘口 + 分时明细 |
| `components/order-form.js` | `createOrderForm(host, ctx)` → `{ update(), destroy() }` | 买入/卖出、价格/数量、仓位快捷、可买可卖 |
| `components/tables.js` | `createTables(host, ctx)` → `{ update(), destroy() }` | 持仓/委托/成交/资金 四个表 |
| `views/trade.js` | `renderTrade(ctx)` | 组装上面全部组件（`ctx.root` 内） |
| `views/login.js` | `renderLogin(ctx)` | |
| `views/lobby.js` | `renderLobby(ctx)` | |
| `views/result.js` | `renderResult(ctx)` | 结算页（含资产曲线 canvas） |

`Chart.setData(data)` 的 `data`：
```js
{ type:'timeshare'|'candle', title, code, prevClose, bars:[[t,o,h,l,c,v]...],
  avgLine:[price...] /* 仅分时 */, tf, showMA:true, showMACD:true, dark:false }
```

### 4.5 UI 规范：**Windows 完全版同花顺的桌面客户端风格**（macOS / Windows 表现一致）

整体必须是「桌面客户端」而不是「网页」：无大圆角、无大留白、无卡片化阴影风；采用 Windows 经典控件质感（1px 实边框、浅灰渐变工具条、紧凑 12px 字号、密集表格、立体按钮）。

**页面骨架（从上到下，高度固定）**

```
┌ 标题栏 32px ── 深蓝渐变 #1b4f8a→#123a68，白字 ──────────────────────────┐
│ [同花亏]  系统 功能 报价 分析 交易 资讯 工具 帮助      🔍搜索    ─ □ ✕ │
├ 工具栏 36px ── #eef1f4→#dfe5ea 渐变，1px 下边框，分组按钮 ─────────────┤
│ [买入F1][卖出F2][撤单F3] │ [持仓F4][委托F5][成交F6] │ [分时][K线][排行] │
├ 标签栏 30px ── MDI 多标签：自选股 / 分时图 / K线图 / 交易 / 排行 / 资讯 ┤
├ 主工作区 flex:1（含可拖拽分隔条）──────────────────────────────────────┤
├ 状态栏 26px ── ●已连接 127.0.0.1:8899 │ 同花综指 1234.56 +2.88% ▲ │      │
│                虚拟时钟 10:32 │ 延迟 12ms │ 在线 5 │ 韭菜甲〔青铜〕    │
└──────────────────────────────────────────────────────────────────────┘
```

* **标题栏**：菜单可点击展开**真实下拉菜单**（`系统/功能/报价/分析/交易/资讯/工具/帮助`），菜单项有快捷键提示与分隔线；`✕`=退出登录，`□`=全屏切换，`─`=最小化面板。
* **工具栏**：Windows 经典立体按钮（上高光、下阴影、按下内凹），竖线分组，**全部有实际功能**。
* **标签栏**：可关闭的多标签页，选中页白底 + 顶部 2px 红色高亮条。
* **状态栏**：左=连接状态圆点（绿/黄/红）+ 服务器地址；中=大盘指数滚动条；右=虚拟时钟、WebSocket 延迟、在线人数、昵称与段位。

**配色（CSS 变量定义在 `theme.css`，其他文件只准引用变量）**

```css
/* 浅色 = 同花顺经典皮肤（默认） */
--chrome:#1b4f8a; --chrome-2:#2a6bb0; --chrome-3:#123a68;  /* 标题栏渐变 */
--toolbar:#eef1f4; --toolbar-2:#dfe5ea;
--bg:#eef1f4; --panel:#ffffff; --panel-2:#f7f9fb;
--border:#c3ccd6; --border-2:#dfe4ea; --sel:#dceafd;        /* 选中行浅蓝 */
--text:#1a1a1a; --text-2:#4a4a4a; --text-3:#8a8a8a;
--up:#f5333f; --down:#12b886; --flat:#7a7a7a;               /* 红涨绿跌 */
--accent:#1b4f8a; --link:#0b5fbf; --warn:#e8a33d;
/* 夜间模式 body.dark 覆盖以上变量（#12161c / #1a2029 / 边框 #2a3341） */
```

* **字体**：`"Microsoft YaHei","PingFang SC","Hiragino Sans GB","Segoe UI",sans-serif`；基准 `12px`，表格 `12px`，面板标题 `13px`；**所有数字 `font-variant-numeric: tabular-nums` 且右对齐**。
* **行情报价表列（必须齐全）**：`代码 名称 涨幅% 现价 涨跌 买价 卖价 总量 现手 涨速% 换手% 量比 振幅% 均价 市盈 最高 最低 今开 昨收 委比%`；表头浅灰渐变 + 1px 边框；行 hover `--sel`；选中行深蓝底白字；涨停价红色加粗、跌停价绿色加粗；点击列头可排序。
* **交易页布局**：左 280px 行情列表（含搜索框 + 板块筛选）+ 中 flex 图表区 + 右 320px（五档盘口 / 分时明细 / 下单面板 竖排）；底部 240px 标签表格（持仓 / 委托 / 成交 / 资金 / 排行 / 资讯），可折叠、可拖拽调高。
* **五档盘口**：卖五在上、买五在下，中间现价大字（红/绿/灰），每档带量柱与价格色。
* **下单面板**：买入/卖出切换（买入红、卖出绿）、价格与数量步进器（±0.01 / ±100）、涨跌停快捷价、可买可卖股数与最大手数、仓位快捷键 `1/4 1/3 1/2 全仓`、大号 `买入`（红）/`卖出`（绿）按钮、二次确认弹窗（可在「系统→设置」关闭）。
* **图表区**：分时图（白底 + 蓝色价格线 + 黄色均价线 + 昨收虚线 + 下方量柱）、K 线图（红涨绿跌蜡烛 + MA5/10/20/60 + 成交量 + MACD 副图）、十字光标 + 左上浮动数据框、右键菜单（切指标/周期）。
* **快捷键**：`F1` 买入、`F2` 卖出、`F3` 撤单、`F4` 持仓、`F5` 委托、`F6` 成交、`↑/↓` 切换股票、`Enter` 提交、`Esc` 关闭弹窗、`B`/`S` 切方向。
* **响应式（次要）**：宽度 < 1180px 右侧面板折叠为抽屉；< 900px 单栏 + 底部 tab。

**共享 CSS 原子类（由 `theme.css` 提供，各组件必须复用，不得重复造）**：
`.win .win-title .menubar .menu-item .menu-pop .toolbar .tb-btn .tb-sep .tb-group .tabstrip .tab .tab.active .statusbar .sb-item .dot .panel .panel-hd .panel-bd .tbl .num .up .down .flat .btn .btn-buy .btn-sell .btn-default .btn-sm .input .select .stepper .tag .badge .split .scroll .kv .empty`

### 4.6 桌面化与跨平台（macOS + Windows 都要能用）

* 客户端是纯静态页面，两种系统界面完全一致（同一套 CSS 变量 + 相同字体回退链）。
* 桌面应用体验：Chromium `--app=` 无地址栏窗口，**不需要 Electron、不需要任何 npm 包**。
  * `tools/同花亏-Windows.bat`：探测 Edge/Chrome → 启动 `node server/server.js` → `msedge --app=http://127.0.0.1:8899`（找不到则退回默认浏览器）。
  * `tools/同花亏-macOS.command`：双击运行，优先 `Google Chrome --app=`，退回 `open http://127.0.0.1:8899`。
  * 服务端 `--open` 参数自动开浏览器（win32 `cmd /c start`；darwin `open`；linux `xdg-open`）。
* `server/server.js` 必须三平台零改动运行（路径全部 `path.join`，不写死 `/`，不依赖 shell 命令）。

### 4.7 UI 先行：Mock 数据源（当前阶段用这个）

在没有服务端的情况下，客户端用 `client/js/mock.js` 提供的 **MockNet** 驱动，它 **完全遵守 `PROTOCOL.md`**，因此之后切换真实服务端只需把 `main.js` 里的一行换掉。

```js
// client/js/mock.js
export class MockNet extends EventTarget {
  constructor(state, options);
  connect(url);                       // 立即触发 welcome / login_ok
  send(t, fields = {});               // 接受 PROTOCOL §1 全部上行消息
  on(type, fn);                       // 返回 off()，与 NetClient 完全一致
  request(t, fields, matchType, timeoutMs); // Promise
  close();
  get connected();                    // true
}
```
MockNet 必须做到：
1. 生成 `config`（同 `login_ok`）、20 只虚拟股票、板块、`idx` 两只指数。
2. 每 `tickMs`（1000ms）推一条符合协议的 `tick`：`idx` + `quotes`（含五档、`tr` 成交明细），价格做**随机游走 + 板块共振 + 偶尔新闻冲击**，让 UI 看起来在真实跳动。
3. 维护 `account`（资金/持仓/委托/成交）并实现**本地假撮合**：收到 `order:place` 后先回 `order:ack`，能立即成交则改 `account` 并推 `account`，否则挂单并在后续 tick 逐步成交；`order:cancel` 同理。
4. 推 `rank`（自己 + 5 个 AI 对手，收益率互相追赶）、`news`（每 20~40 秒一条）、`lobby:rooms`、`room:update`。
5. 60 秒后（或点"结束对局"）推 `game:over`，含 `equity` 资产曲线。
6. 预生成历史 K 线：`1d` 120 根、`1m`/`5m` 各若干，并随 tick 追加。
7. 提供 `mock.forceTick()`、`mock.endMatch()`、`mock.setStock(id)` 等调试方法（挂在 `window.__mock`）。

`main.js` 数据源选择：URL 带 `?mock=1` 或 `?real=1`（默认 mock，直到服务端接入完成）。

### 4.8 DOM 骨架 id（`index.html` 冻结，由 `main.js` 组装）

```
#app
 ├ header#titlebar   (logo / nav#menubar / #global-search / #win-btns)
 ├ div#toolbar
 ├ div#tabstrip
 ├ main#workspace    (视图容器，ctx.root = #view)
 │   └ div#view      ← 各视图渲染到这里
 ├ footer#statusbar  (#conn-state #idx-bar #clock #latency #online #me-badge)
 └ div#toast-host
```

## 5. 验收标准

1. `node server/server.js` 一条命令启动；`http://localhost:8899` 打开即用。
2. 两个浏览器窗口可分别登录（不同昵称）→ 建房/加入 → 准备 → 开局 → 各自独立交易，互相能看到对方挂单被吃掉、排行榜实时变化。
3. 行情每 tick 刷新，K 线/分时图正确绘制，五档与成交明细与价格一致。
4. 买卖校验完整：可用资金不足、T+1 可用持仓不足、涨跌停越界、非 100 股整数倍都会给出明确中文提示。
5. 断线重连后继续对局，账户状态不丢。
6. 结算页显示排名、收益率、最大回撤、成交次数、手续费、资产曲线、ELO 变化。
7. 服务端零 npm 依赖，可在 Windows Server 上用 `tools/start-windows.bat` 直接跑起来。
