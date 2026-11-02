# 同花亏 (TongHuaKui) 通信协议 v1.0

> 本文件是**客户端与服务端之间唯一的接口契约**。任何一方改动字段都必须同步修改本文件。
> 传输层：WebSocket（RFC6455，文本帧，JSON UTF-8）。路径固定为 `/ws`。
> 生产环境建议部署在反向代理后并启用 `wss://`。

## 0. 约定

* 所有消息都是一个 JSON 对象，必有字段 `t`（string，消息类型）。
* 时间统一为 **毫秒时间戳**（真实时间，`Date.now()`）。
* 金额单位：**元**（number，服务端内部按分计算后四舍五入到 0.01）。
* 数量单位：**股**（number，A 股 1 手 = 100 股，必须是 100 的整数倍；卖出零股例外）。
* 价格单位：**元**，保留 2 位小数。
* 服务端是**唯一权威**（authoritative server）：客户端不做任何本地撮合/资金计算，只做展示与预测。
* 任何非法请求返回 `{t:'error', code, msg, reqId?}`，不得断开连接（除非协议级错误或心跳超时）。
* 客户端每条上行请求都可带 `reqId`（string），服务端在下行回复中原样回带 `reqId`。客户端为 `order:place` / `order:cancel` 一律带 `reqId` 以便对账。

错误码：

| code | 含义 |
|---|---|
| `BAD_REQUEST` | 报文格式错误 |
| `NOT_LOGGED_IN` | 未登录 |
| `NOT_IN_ROOM` | 不在房间 |
| `ROOM_FULL` / `ROOM_NOT_FOUND` / `ROOM_STARTED` | 房间相关 |
| `NOT_HOST` | 非房主 |
| `NOT_PLAYING` | 对局未开始 |
| `INSUFFICIENT_FUNDS` | 可用资金不足 |
| `INSUFFICIENT_POSITION` | 可用持仓不足（T+1） |
| `BAD_PRICE` | 价格超出涨跌停 / 非法价格 |
| `BAD_QTY` | 数量非 100 整数倍或为 0 |
| `ORDER_NOT_FOUND` | 撤单失败 |
| `RATE_LIMIT` | 频率限制 |
| `SERVER_ERROR` | 服务端异常 |

---

## 1. 客户端 → 服务端

| t | 字段 | 说明 |
|---|---|---|
| `login` | `nick`(string 1-12 字) `token`(string?) `avatar`(int 0-11?) | 首次登录或断线重连（带 token 恢复身份） |
| `lobby:list` | — | 请求房间列表 |
| `room:create` | `name?`(string) `mode`('1v1'\|'ffa'\|'team') `maxPlayers`(2-30) `durationSec`(300\|900\|1800) `startCash`(100000\|1000000\|5000000) `fillBots`(bool) | 创建房间并自动进入 |
| `room:join` | `roomId`(string) | 加入指定房间 |
| `room:quick` | `mode` `durationSec?` `startCash?` | 快速匹配：满员即开局，等待 5s 用 AI 补齐 |
| `room:leave` | — | 离开房间（对局中离开 = 认输弃赛） |
| `room:ready` | `ready`(bool) | 准备/取消准备 |
| `room:start` | — | 房主手动开局（人数 >= 2，或 `fillBots` 为真） |
| `room:kick` | `playerId`(string) | 房主移出成员（仅 `waiting` 状态可移出；非房主 → `NOT_HOST`） |
| `room:chat` | `text`(string <=120) | 房间聊天 |
| `kline:get` | `stockId` `tf`('1m'\|'5m'\|'15m'\|'1d') | 拉取历史 K 线（开局后可用） |
| `ai:advice` | `stockId`(string?) | **AI 投资顾问**：传 stockId 返回个股诊断，不传返回大盘观点 |
| `order:place` | `stockId` `side`('buy'\|'sell') `type`('limit'\|'market') `price`(number, market 时可省略) `qty`(int) | 下单 |
| `order:cancel` | `orderId`(string) | 撤单 |
| `ping` | `ts`(number) | 心跳，客户端每 15s 一次 |

## 2. 服务端 → 客户端

### 2.1 握手与登录

```jsonc
// 连接建立后服务端立即推送
{"t":"welcome","server":"同花亏","version":"1.0.0","serverTime":1730000000000,"tickMs":1000,"online":3}

// login 成功
{"t":"login_ok","token":"...","serverTime":..., 
 "player":{"id":"p_xxx","nick":"韭菜甲","avatar":3,"elo":982,"tier":"青铜","wins":1,"losses":4,"games":5},
 "config":{
   "tickMs":1000,"virtualDayTicks":240,
   "modes":[{"id":"1v1","name":"1v1 单挑","maxPlayers":2},{"id":"ffa","name":"多人混战","maxPlayers":30},{"id":"team","name":"红蓝团战","maxPlayers":30}],
   "maxPlayers":30,"playerCountOptions":[2,4,6,8,12,16,20,24,30],
   "durations":[{"sec":300,"name":"快打 5 分钟"},{"sec":900,"name":"标准 15 分钟"},{"sec":1800,"name":"长线 30 分钟"}],
   "startCashOptions":[100000,1000000,5000000],
   "fee":{"commissionRate":0.00025,"commissionMin":5,"stampTax":0.0005,"transferFee":0.00001},
   "lotSize":100,"limitPct":0.10,"limitPct20":0.20
 }}
```

### 2.1a 时间模型（v1.1 起）

| 概念 | 值 |
|---|---|
| 行情 tick | 1 秒（`TICK_MS`，可由 `--tick` 调整） |
| 虚拟分钟推进 | **每 5 个 tick 推进 1 个虚拟分钟**（`SECONDS_PER_VIRTUAL_MINUTE = 5`，运维控制台可运行时改 1~60 秒） |
| 虚拟交易日 | **120 虚拟分钟 = 上午盘 09:30–11:30**（`VIRTUAL_DAY_TICKS = 120`） |
| 交易日间隔 | **午间休市 60 秒**（`BREAK_SEC`），期间行情冻结、挂单排队，之后进入下一交易日 |
| 对局时长 | 15 / 30 / 45 分钟（`DURATIONS`） |

> ⚠️ `tick.seq` 是**房间心跳序号**（每个 tick 严格 +1）；行情自身的分钟序号在 `marketSeq` 字段里（每 5 个 tick 才 +1）。

**午间休市报文**（休市期间每秒广播一次；恢复开盘/被暂停时各发一次）：

```jsonc
{"t":"break","active":true,"leftSec":42,"totalSec":60,"dayIndex":1,"vclock":"11:30","nextOpen":"09:30","endsAt":...}
{"t":"break","over":true,"dayIndex":1,"vclock":"09:30"}                    // 新交易日开盘
{"t":"break","paused":true,"leftSec":0,"totalSec":0,"dayIndex":0,"vclock":"10:12","endsAt":...}  // 被控制台暂停
```

### 2.2 大厅与房间

```jsonc
{"t":"lobby:rooms","rooms":[{"id":"r_ab12","name":"韭菜甲的房","mode":"ffa","maxPlayers":4,
  "playerCount":2,"status":"waiting","durationSec":900,"startCash":1000000,"hostNick":"韭菜甲"}]}

{"t":"room:joined","room":{...}, "you":{"id":"p_xxx"}}
{"t":"room:left","roomId":"r_ab12"}

// 房间状态变化（准备、加入、离开、倒计时、开局）都会推送完整状态
{"t":"room:update","room":{
  "id":"r_ab12","name":"韭菜甲的房","mode":"ffa","maxPlayers":4,"hostId":"p_xxx",
  "status":"waiting"|"countdown"|"playing"|"finished",
  "countdown":3,                       // status=countdown 时有效
  "durationSec":900,"startCash":1000000,"fillBots":true,
  "matchId":null,
  "teams":null,                        // mode=team 时 {p_xxx:"red", ...}
  "players":[{"id":"p_xxx","nick":"韭菜甲","avatar":3,"ready":true,"isBot":false,
              "isHost":true,"tier":"黄金","elo":1500}]}}

{"t":"chat","from":"p_xxx","nick":"韭菜甲","text":"冲","time":1730000000000,"system":false}
{"t":"player:event","action":"join"|"leave","roomId":"r_ab12","player":{...}}
```

### 2.3 开局与行情

```jsonc
{"t":"game:start","match":{
   "id":"m_xyz","mode":"ffa","durationSec":900,"startedAt":...,"endsAt":...,
   "startCash":1000000,"tickMs":1000,"virtualDayTicks":240,
   "sectors":["白酒","半导体"]},
 "stocks":[{"id":"600519","name":"贵州毛台","sector":"白酒","market":"cn","prevClose":1680.00,
            "limitUp":1848.00,"limitDown":1512.00,"lotSize":100,"pe":31.2,"floatMv":2.1e12},
           {"id":"NVDA","name":"英卫达","sector":"纳指芯片","market":"us","prevClose":128.60,
            "limitUp":167.18,"limitDown":90.02,"lotSize":100,"pe":62.4,"floatMv":3.1e12}],
 "teams":null}
```

行情 tick（每 `tickMs` 一次，全市场一起推）：

```jsonc
{"t":"tick","seq":128,"vtime":1730000128000,"vclock":"10:32","serverTime":1730000128000,
 "idx":[{"c":"THKZ","n":"同花综指","v":1234.56,"pc":1200.00,"pct":0.0288,"amt":3.2e9},
        {"c":"THKC","n":"同花成指","v":2456.78,"pc":2480.00,"pct":-0.0094,"amt":1.8e9},
        {"c":"IXIC","n":"纳斯达克综指","v":18750.20,"pc":18542.60,"pct":0.0112,"amt":2.4e10},
        {"c":"NDX","n":"纳斯达克100","v":20411.90,"pc":20188.40,"pct":0.0111,"amt":1.6e10}],
 "quotes":[{
   "i":"600519",        // 股票 id
   "p":1691.20,         // 现价
   "o":1680.00,"h":1702.00,"l":1675.00,"pc":1680.00,
   "limitUp":1848.00,"limitDown":1512.00,
                        // 当日涨跌停价。**必须每 tick 下发**：虚拟日切后涨跌停会按新昨收重算，
                        // 客户端若一直用开局快照，价格涨过旧涨停后会误判「超过涨停价」而拒绝委托。
   "v":128300,          // 累计成交量(股)
   "a":2.17e8,          // 累计成交额(元)
   "avg":1691.43,       // 当日均价 = a/v（无量时等于 p）
   "b":[[1691.00,1200],[1690.50,800],[1690.00,3400],[1689.50,600],[1689.00,2100]], // 买五 [价,量(股)]
   "s":[[1691.20,900],[1691.50,1500],[1692.00,2600],[1692.50,1100],[1693.00,4000]], // 卖五
   "tr":[[1691.20,300,1],[1691.00,200,-1]]   // 本 tick 成交明细，dir 1=外盘(主动买) -1=内盘
 }]}
```

`idx` 是虚拟大盘指数（客户端状态栏 / 指数条显示），每 tick 必须携带。

K 线（`kline:get` 回复，或开局后服务端主动推送一次 `1d`）：

```jsonc
{"t":"kline","i":"600519","tf":"1d","bars":[[1730000000000,1680.0,1702.0,1675.0,1691.2,128300], ...]} // [t,o,h,l,c,v]
```

### 2.4 账户与交易

```jsonc
{"t":"account",
 "cash":1000000.00,"frozen":12000.00,"available":988000.00,
 "marketValue":132000.00,"totalAssets":1120000.00,"pnl":120000.00,"pnlPct":0.12,
 "positions":[{"i":"600519","qty":100,"avail":0,"avgCost":1680.00,"price":1691.20,
               "mv":169120.00,"pnl":1120.00,"pnlPct":0.0067,"name":"贵州毛台"}],
 "orders":[{"id":"o_1","i":"600519","side":"buy","type":"limit","price":1680.00,
            "qty":200,"filled":100,"status":"partial"|"open"|"filled"|"canceled"|"rejected",
            "time":...,"frozen":168000.00}],
 "trades":[{"id":"t_1","i":"600519","side":"buy","price":1691.20,"qty":100,
            "amount":169120.00,"fee":47.28,"time":...,"pnl":null,"name":"贵州毛台"}]}

// 下单回执（先回执后账户推送）
{"t":"order:ack","reqId":"c_7","ok":true,"orderId":"o_2","msg":"已委托 买入 600519 200股 @1680.00"}
{"t":"order:ack","reqId":"c_8","ok":false,"msg":"可用资金不足"}
```

### 2.4a 运维控制台（人工宏观事件）

> 需要 `THK_ADMIN_KEY`（未设置时服务端启动会自动生成并写入 `data/admin-key.txt`，控制台入口 `/admin.html`）。
> 这些消息**不需要登录**，但必须携带正确密钥；只在有进行中对局时生效。

| 消息 | 字段 | 说明 |
|---|---|---|
| `admin:auth` | `key` | 鉴权并返回事件目录 + 实时快照 |
| `admin:event` | `key` `eventId` `stockId?` `sector?` `strength?`(0.1~1.5) `ticks?` | 投放事件（政府补贴/央行加息/国家队救市/停牌…共 23 种） |
| `admin:control` | `key` `action` `secondsPerMinute?` `seconds?` `roomId?` | 运行时控制：`pause` `resume` `speed` `break` `endbreak` `nextday` |
| `admin:state` | `key` | 只拉实时快照（控制台轮询用） |

`admin:event` / `admin:control` 的回复 = 操作结果 + **完整快照**：

```jsonc
{"t":"admin:control","reqId":"c1","ok":true,"action":"pause",
 "results":[{"roomId":"r_1rr06","ok":true,"action":"pause","paused":true}],
 "catalog":[...23 项...],
 "rooms":[{"id":"r_1rr06","mode":"ffa","status":"playing","players":2,"maxPlayers":2,
           "endsInSec":820,"vclock":"10:32","paused":false,
           "secondsPerMinute":5,"minuteTicks":5,"breakLeftSec":0,"dayIndex":0}],
 "indices":[{"c":"THKZ","n":"同花综指","v":1203.2,"pct":0.0031}],
 "movers":{"up":[...8 条...],"down":[...8 条...]},
 "special":[{"id":"600519","name":"贵州毛台","halted":true,"floor":false,"p":1691,"chg":0.02,"fair":1689,"sector":"白酒"}]}
```

事件的**两类效果**（这是设计要点）：
- `impact` 即时情绪冲击（指数衰减，几分钟内被内在价值锚拉回）
- `fairPct` **内在价值永久变动**（政府补贴/加息这类基本面事件必须改这个，否则再大的利好也会被抹平）

以及三种行政手段：`floorTicks` 救市托底、`haltTicks` 临时停牌、`clear` 复牌。

### 2.5 AI 投资顾问

客户端发 `{t:'ai:advice', stockId, reqId}`。带 `stockId` 回个股诊断，不带回大盘观点。

```jsonc
// 个股诊断
{"t":"ai:advice","reqId":"a1","stockId":"600519","name":"贵州毛台","ts":1730000000000,
 "score":57,                       // 0~100 综合评分
 "rating":"hold",                  // strong_buy|buy|hold|reduce|sell
 "ratingText":"持有观望","summary":"⏸ 持有观望（综合 57 分）。均线偏多…",
 "fair":1725.37,"dev":-0.0022,"dayPct":0.0199,   // 内在价值 / 偏离 / 当日涨跌
 "breakdown":{"valuation":56,"trend":44,"momentum":50,"volume":41,"orderbook":44,"risk":70},
 "signals":[{"k":"估值","v":"与内在价值基本持平","dir":0},   // dir: 1 利好 0 中性 -1 利空
            {"k":"趋势","v":"均线偏多，趋势温和向上","dir":0},
            {"k":"动量","v":"近 20 分钟 +0.08%","dir":0},
            {"k":"量能","v":"量能正常（1.07 倍）","dir":0},
            {"k":"盘口","v":"买卖力量均衡","dir":0}],
 "risks":["距涨停仅 1.2%，上行空间有限"],
 "position":{"held":200,"avail":200,"avgCost":1650.00,"pnlPct":0.031,
             "advice":"继续持有，跌破 1657.53 止盈保护"},     // 未持仓时为 null
 "suggestion":{"action":"hold","actionText":"持有不动，等待方向选择","qtyPct":0,
               "priceLow":1682.30,"priceHigh":1692.42,"stopLoss":1628.67,"takeProfit":1781.63}}

// 大盘观点
{"t":"ai:market","reqId":"a2","ts":...,
 "summary":"同花综指 1195.96（-0.33%），全市场 27 涨 / 30 跌 / 4 平，涨停 0 家、跌停 0 家 —— 多空胶着。",
 "mood":{"id":"flat","text":"多空胶着","desc":"方向不明，控制仓位、少动多看"},
 "index":{"name":"同花综指","v":1195.96,"pct":-0.0033},
 "breadth":{"up":27,"down":30,"flat":4,"limitUp":0,"limitDown":0},
 "sectors":[{"sector":"商业","pct":0.0458},{"sector":"纳指科技","pct":0.0211}],
 "lines":["领涨板块：商业（+4.58%）","领跌板块：新能源（-3.67%）","纳斯达克综指 18891.84（+1.81%）"],
 "picks":[{"id":"002230","name":"科大迅飞","price":46.72,"chg":0.011,"dev":-0.02,
           "aiScore":60,"reason":"估值与动量均衡，适合跟踪"}]}
```

> 评分口径（服务端权威）：估值 30% + 趋势 25% + 动量 15% + 量能 10% + 盘口 10% + 风险 10%。
> 其中「估值」用**内在价值 fair**（不受玩家买卖影响的基本面线）计算，客户端无法伪造。

### 2.6 排行 / 资讯 / 结算

```jsonc
{"t":"rank","endsAt":...,"vclock":"10:32","list":[
  {"id":"p_xxx","nick":"韭菜甲","avatar":3,"assets":1120000,"returnPct":0.12,
   "isBot":false,"isMe":true,"tier":"黄金","team":"red","todayPnl":20000}]}

{"t":"news","news":{"id":"n_1","time":...,"title":"白酒板块突发利好：某龙头提价",
  "body":"...","level":"info"|"warn"|"hot","sector":"白酒","stockId":null,
  "predict":"利多"|"利空"|"中性"}}

{"t":"game:over","result":{
  "matchId":"m_xyz","reason":"timeup"|"forfeit"|"host_end",
  "rank":[{"id":"p_xxx","nick":"韭菜甲","avatar":3,"isBot":false,"assets":1120000,
           "returnPct":0.12,"maxDrawdown":-0.043,"tradeCount":17,"feeTotal":820.5,
           "equity":[[0,1000000],[10000,1005000],...],"tier":"黄金","eloDelta":18}],
  "tierChanges":[{"id":"p_xxx","from":"青铜","to":"白银","elo":1012}]},
 "teams":{"red":{"returnPct":0.08,"score":1},"blue":{"returnPct":-0.02,"score":0}}}
```

### 2.7 其他

```jsonc
{"t":"toast","level":"info"|"success"|"warn"|"error","msg":"你的委托已全部成交"}
{"t":"pong","ts":...,"serverTime":...,"rtt":12}
{"t":"error","code":"INSUFFICIENT_FUNDS","msg":"可用资金不足","reqId":"c_7"}
```

---

## 3. 交易规则（服务端实现，客户端同步展示）

1. **T+1**：当日买入股票当日不可卖出（`avail` 字段）；当日卖出所得资金可继续买入。
2. **涨跌停**：主板 ±10%，创业板/科创板（代码 `30`/`68` 开头）±20%。委托价超出范围直接拒单。
3. **费用**：佣金 `max(amount*0.00025, 5)`；卖出印花税 `amount*0.0005`；过户费 `amount*0.00001`（双向）。
4. **撮合**：限价单先吃**合成流动性**（对手价逐档成交，有滑点），再与**其他玩家挂单**按价格优先、时间优先成交，剩余挂单排队；市价单立即吃对手五档，吃不完的部分自动撤单。
5. **价格冲击**：玩家主动成交会推动股价（`impact = k * 净成交额 / 流动性`），滑点与冲击是大单的真实成本。
6. **虚拟时钟**：`tickMs`（默认 1000ms）推进一个虚拟分钟；`virtualDayTicks=240` 个 tick 为一个虚拟交易日（09:30-11:30、13:00-15:00 压缩）。
7. **胜负**：结算按 `totalAssets` 降序，收益率 = `(totalAssets - startCash)/startCash`。团队模式按队伍平均收益率。
8. **ELO**：1v1 用标准 ELO（K=32）；多人混战用两两配对平均；团战按队伍胜负。段位：青铜(<1000) 白银(1000-1199) 黄金(1200-1399) 铂金(1400-1599) 钻石(1600-1799) 王者(>=1800)。
