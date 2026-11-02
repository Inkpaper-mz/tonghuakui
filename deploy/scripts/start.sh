#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# 同花亏 · Linux/macOS 启动脚本
#   用法： ./scripts/start.sh [--port 8899] [--host 127.0.0.1] [--tick 1000]
#   环境变量：THK_PORT / THK_HOST / THK_DATA / THK_TICK
# ═══════════════════════════════════════════════════════════════
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then NODE_BIN="$(command -v node)"
  elif [ -x "$ROOT/runtime/node/bin/node" ]; then NODE_BIN="$ROOT/runtime/node/bin/node"   # 便携版 Node
  elif [ -x "$ROOT/node/bin/node" ]; then NODE_BIN="$ROOT/node/bin/node"
  elif [ -x /usr/local/bin/node ]; then NODE_BIN=/usr/local/bin/node
  elif [ -x /usr/bin/node ]; then NODE_BIN=/usr/bin/node
  else echo "❌ 找不到 node，请先安装 Node.js 18+（https://nodejs.org）" >&2; exit 1; fi
fi

MAJOR="$("$NODE_BIN" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "$MAJOR" -lt 16 ]; then
  echo "❌ Node 版本过低（当前 $("$NODE_BIN" -v)），需要 18 或更高" >&2; exit 1
fi

mkdir -p "$ROOT/data"
export THK_HOST="${THK_HOST:-127.0.0.1}"      # 公网部署请保持 127.0.0.1，由 nginx 反代
export THK_PORT="${THK_PORT:-8899}"
export THK_DATA="${THK_DATA:-$ROOT/data/store.json}"

echo "== 同花亏服务端 =="
echo "  node      : $NODE_BIN ($("$NODE_BIN" -v))"
echo "  目录      : $ROOT"
echo "  监听      : $THK_HOST:$THK_PORT"
echo "  数据文件  : $THK_DATA"
echo

exec "$NODE_BIN" server/server.js "$@"
