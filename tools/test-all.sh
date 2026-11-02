#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  同花亏 · 一键完整验收
#    bash tools/test-all.sh
#  依次执行：
#   1) 行情引擎确定性单元测试（不起服务端）
#   2) 服务端端到端测试（自动起停服务端，2 个 WS 客户端）
#   3) 双人真实浏览器对战验收（需本机有 Chrome/Edge）
# ═══════════════════════════════════════════════════════════════
set -uo pipefail
cd "$(dirname "$0")/.."

NODE="${NODE:-}"
if [ -z "$NODE" ]; then
  if command -v node >/dev/null 2>&1; then NODE=node
  elif [ -x $HOME/.local/share/dsh/node/bin/node ]; then
    NODE=$HOME/.local/share/dsh/node/bin/node
  else echo "❌ 未找到 node"; exit 1; fi
fi

PORT="${THK_PORT:-8899}"
FAILED=0
line() { printf '\n\033[36m%s\033[0m\n' "════════ $1 ════════"; }

line "1/5 行情引擎单元测试"
"$NODE" server/test/market.test.js || FAILED=1

line "2/5 撮合引擎 / 资金持仓单元测试"
"$NODE" server/test/engine.test.js || FAILED=1

line "3/5 AI 投资顾问单元测试"
"$NODE" server/test/ai.test.js || FAILED=1

line "4/5 服务端端到端测试（WS 双客户端）"
"$NODE" server/test/e2e.js || FAILED=1

line "5/5 双人真实浏览器对战验收"
# 固定复用 8899 会踩到「上次遗留的旧服务端」导致假失败（tick 不一致），
# 这里优先用 THK_PORT，否则随机挑一个空闲端口，并总是启动全新服务端。
if [ -z "${THK_PORT:-}" ]; then
  for _ in $(seq 1 30); do
    CAND=$((8900 + RANDOM % 90))
    lsof -ti tcp:"$CAND" >/dev/null 2>&1 || { PORT=$CAND; break; }
  done
fi
echo "  使用全新服务端：端口 $PORT · tick 900ms"
"$NODE" server/server.js --port "$PORT" --tick 900 > /tmp/thk-test-server.log 2>&1 &
SRV=$!
for _ in $(seq 1 20); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/index.html" && break
  sleep 0.5
done
"$NODE" tools/duel.mjs --port "$PORT" || FAILED=1
kill $SRV 2>/dev/null
wait $SRV 2>/dev/null

echo
if [ "$FAILED" -eq 0 ]; then
  printf '\033[32m\033[1m全部验收通过 ✅\033[0m\n'
else
  printf '\033[31m\033[1m存在失败项 ❌\033[0m\n'
fi
exit "$FAILED"
