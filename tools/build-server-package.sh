#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# 同花亏 · 服务端打包脚本
#   产出：dist/tonghuakui-server-<版本>.tar.gz（Linux/macOS）
#         dist/tonghuakui-server-<版本>.zip    （Windows Server）
#   用法： bash tools/build-server-package.sh
#   特点：零依赖（不需要 npm install），解压即可 node server/server.js
# ═══════════════════════════════════════════════════════════════
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -e "process.stdout.write(require('./server/src/config').VERSION)" 2>/dev/null || echo 1.0.0)"
NAME="tonghuakui-server-${VERSION}"
STAGE="$ROOT/dist/.stage/$NAME"

echo "== 打包同花亏服务端 v$VERSION =="

# ── 1. 清理并搭建目录 ──
rm -rf "$ROOT/dist/.stage"
mkdir -p "$STAGE"/{server,client,docs,deploy,data}

# ── 2. 拷贝服务端（只带运行必需的）──
cp server/server.js "$STAGE/server/"
cp -R server/src "$STAGE/server/src"

# ── 3. 拷贝客户端静态资源 ──
cp -R client/. "$STAGE/client/"

# ── 4. 文档与部署件 ──
cp README.md README.en.md README.ja.md PROTOCOL.md DESIGN.md LICENSE NOTICE.md "$STAGE/"
cp -R deploy/. "$STAGE/deploy/"
cp docs/DEPLOY-LINUX.md docs/DEPLOY-WINDOWS.md docs/USER-GUIDE.md "$STAGE/docs/" 2>/dev/null || true
if [ -d docs/screenshots ]; then
  mkdir -p "$STAGE/docs/screenshots"
  cp docs/screenshots/*.png "$STAGE/docs/screenshots/" 2>/dev/null || true
fi

# ── 5. 运行时占位（绝不打包开发机的存档！）──
cat > "$STAGE/data/README.txt" <<'EOF'
本目录用于存放运行时数据：
  store.json      玩家战绩 / ELO / 对局记录（首次启动自动创建）
  admin-key.txt   运维控制台密钥（首次启动自动生成，请妥善保管）

备份：直接备份整个 data 目录即可。
升级：覆盖代码时不要删除本目录。
EOF

# ── 6. 版本与安装说明 ──
echo "$VERSION" > "$STAGE/VERSION"
cat > "$STAGE/INSTALL.txt" <<EOF
同花亏 服务端 v$VERSION  —— 解压即用（零依赖，只需 Node.js 18+）

【没有装 Node？】把官方便携版 Node 解压到本目录下的 runtime/node/ 即可（Windows 用 node.exe 的 zip 版）
【Windows Server】双击 deploy\\scripts\\start.bat
                  常驻服务见 docs\\DEPLOY-WINDOWS.md
【Linux】         chmod +x deploy/scripts/start.sh && ./deploy/scripts/start.sh
                  用域名 + HTTPS 部署见 docs/DEPLOY-LINUX.md（含 your-domain.com 逐步示例）

启动后：
  游戏主页    http://<本机IP>:8899/
  运维控制台  http://<本机IP>:8899/admin.html   （密钥见 data/admin-key.txt）
  局域网联机  把上面的地址发给同事/同学即可加入

常用环境变量：
  THK_PORT   监听端口（默认 8899）
  THK_HOST   监听地址（默认 0.0.0.0；公网部署建议 127.0.0.1 交给 nginx）
  THK_DATA   数据文件路径（默认 <根目录>/data/store.json）
  THK_ADMIN_KEY  运维控制台密钥（留空则自动生成并写入 data/admin-key.txt）
EOF

# ── 7. 打包 ──
mkdir -p "$ROOT/dist"
TAR="$ROOT/dist/${NAME}.tar.gz"
ZIP="$ROOT/dist/${NAME}.zip"
( cd "$ROOT/dist/.stage" && tar -czf "$TAR" "$NAME" )
( cd "$ROOT/dist/.stage" && zip -qr "$ZIP" "$NAME" )
rm -rf "$ROOT/dist/.stage"

echo
echo "  ✅ $TAR"
echo "  ✅ $ZIP"
echo
echo "  体积：$(du -h "$TAR" | cut -f1) / $(du -h "$ZIP" | cut -f1)"
echo "  文件数：$(tar -tzf "$TAR" | grep -vc '/$')"
echo "  sha256：$(shasum -a 256 "$TAR" | cut -c1-32)…"
echo
echo "  包内结构："
tar -tzf "$TAR" | sed 's|^[^/]*/||' | grep -v '^$' | awk -F/ '{print $1"/"$2}' | sort -u | head -14 | sed 's/^/    /'
