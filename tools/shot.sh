#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  同花亏 · 无头浏览器截图工具（仅开发/验收用，不影响运行时）
#  用法： bash tools/shot.sh <输出png> [查询串] [宽] [高] [等待ms]
#  例：   bash tools/shot.sh /tmp/trade.png "view=trade&auto=1" 1600 1000 4000
# ═══════════════════════════════════════════════════════════════
set -euo pipefail
OUT="${1:-/tmp/ths.png}"
QUERY="${2:-}"
W="${3:-1600}"
H="${4:-1000}"
WAIT="${5:-4000}"
PORT="${THK_PORT:-8899}"
URL="http://127.0.0.1:${PORT}/index.html"
[ -n "$QUERY" ] && URL="${URL}?${QUERY}"

CHROME=""
for c in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  "$(command -v google-chrome || true)" \
  "$(command -v chromium || true)" ; do
  [ -n "$c" ] && [ -x "$c" ] && CHROME="$c" && break
done
if [ -z "$CHROME" ]; then echo "❌ 未找到 Chrome/Edge，无法截图"; exit 1; fi

"$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --force-device-scale-factor=1 \
  --window-size="${W},${H}" --virtual-time-budget="${WAIT}" \
  --screenshot="$OUT" "$URL" 2>/dev/null | tail -1

echo "✅ $OUT  ($(wc -c < "$OUT" | tr -d ' ') bytes)  <- $URL"
