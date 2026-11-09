# 交易完整性修复

- 同一委托的手续费按累计成交额计算差额；不足额成交拒绝且不修改账户。
- 休市和暂停期间拒绝新单、允许撤单；停牌旧挂单不成交。
- 委托在交易日切换时失效，避免混用真实秒与虚拟分钟。
- 合成盘口预览与成交确认分离，只有实际成交才计入成交量和价格冲击。
- 每轮行情保留有限盘口深度；吃完后等待下一轮行情，不自动续出无限数量。
- 允许一次性卖出包含零股尾数的全部可用持仓。
- 内部保留持仓成本精度，对外展示时四舍五入。
- 保留桌面版本已有的冲击去重、隔夜跳空修正。

验证命令：

    node server/test/trading-fairness.test.js
    node server/test/trading-integrity.test.js
    node server/test/engine.test.js
    node server/test/market.test.js
    node server/test/e2e.js
