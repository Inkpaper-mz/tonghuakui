#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  同花亏 TongHuaKui · macOS / Linux 服务端启动脚本
#  用法： bash tools/start.sh [--port 8899] [--open]
# ═══════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  for p in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
    if [ -x "$p" ]; then export PATH="$(dirname "$p"):$PATH"; break; fi
  done
fi
command -v node >/dev/null 2>&1 || { echo "❌ 未安装 Node.js（需要 >= 18，推荐 20/22 LTS）"; exit 1; }

echo "Node $(node -v) · 同花亏启动中…"
exec node server/server.js "$@"
