#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  同花亏 TongHuaKui · macOS 桌面启动器
#  双击运行（首次需在「访达 → 右键 → 打开」授权，或先执行：
#     chmod +x "tools/desktop-macos.command"  ）
# ═══════════════════════════════════════════════════════════════
cd "$(dirname "$0")/.." || exit 1

PORT="${THK_PORT:-8899}"

if ! command -v node >/dev/null 2>&1; then
  # 尝试常见安装位置
  for p in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
    if [ -x "$p" ]; then export PATH="$(dirname "$p"):$PATH"; break; fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未检测到 Node.js，请先安装：brew install node  或  https://nodejs.org/"
  read -r -p "按回车键退出…" _
  exit 1
fi

echo "════════════════════════════════════════════"
echo "   同花亏 TongHuaKui  商业模拟对战平台"
echo "   本地地址： http://127.0.0.1:$PORT"
echo "   停止服务： 关闭本终端窗口，或按 Ctrl+C"
echo "════════════════════════════════════════════"

# 后台启动服务端，日志写进 logs/
mkdir -p logs
node server/server.js > "logs/server-$(date +%Y%m%d).log" 2>&1 &
SERVER_PID=$!
echo "服务端 PID = $SERVER_PID"

# 等端口就绪
for _ in $(seq 1 20); do
  if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then break; fi
  sleep 0.5
done

URL="http://127.0.0.1:$PORT/index.html?real=1"   # real=1：连真实服务端，不用前端演示数据

# 优先用 Chrome / Edge 的 --app 模式（无地址栏，像桌面软件）
open_app() {
  local app="$1"
  if [ -d "/Applications/$app" ]; then
    open -na "$app" --args --app="$URL" --window-size=1600,1000
    return 0
  fi
  return 1
}
open_app "Google Chrome.app" || open_app "Microsoft Edge.app" || open "$URL"

echo
echo "已打开客户端。关闭本窗口即停止服务端。"
# 前台等待，Ctrl+C 时同时结束子进程
trap 'kill $SERVER_PID 2>/dev/null' INT TERM
wait $SERVER_PID
