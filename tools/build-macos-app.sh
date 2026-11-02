#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  同花亏 · macOS .app 构建脚本
#
#    bash tools/build-macos-app.sh
#
#  产物： dist/同花亏.app
#  特性： 原生 WKWebView 窗口（不依赖 Chrome/Electron）
#         内嵌 Node 运行时（BUNDLE_NODE=0 可跳过，改用系统 Node）
#         自动生成图标、Info.plist、临时签名
#
#  可选环境变量：
#    BUNDLE_NODE=0      不内嵌 node（体积小，但目标机器要装 Node 20+）
#    UNIVERSAL=1        尝试编译 arm64 + x86_64 通用二进制（内嵌 node 仍是本机架构）
#    NODE=/path/to/node 指定要内嵌的 node
# ═══════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

APP_NAME="同花亏"
BUNDLE_ID="com.tonghuakui.app"
VERSION="1.0.0"
DIST="$ROOT/dist"
APP="$DIST/$APP_NAME.app"
MACOS_DIR="$APP/Contents/MacOS"
RES_DIR="$APP/Contents/Resources"
APP_RES="$RES_DIR/app"
BUILD_TMP="$(mktemp -d)"
trap 'rm -rf "$BUILD_TMP"' EXIT

echo "════════════════════════════════════════════"
echo "  构建 $APP_NAME.app"
echo "  项目根目录：$ROOT"
echo "════════════════════════════════════════════"

# ── 0. 工具检查 ──
command -v swiftc >/dev/null 2>&1 || { echo "❌ 需要 Xcode Command Line Tools：xcode-select --install"; exit 1; }
command -v iconutil >/dev/null 2>&1 || { echo "❌ 需要 iconutil（macOS 自带）"; exit 1; }

NODE_BIN="${NODE:-}"
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then NODE_BIN="$(command -v node)"
  elif [ -x $HOME/.local/share/dsh/node/bin/node ]; then
    NODE_BIN=$HOME/.local/share/dsh/node/bin/node
  fi
fi
echo "  Node       ：${NODE_BIN:-（无，将只用系统 Node）}  $([ -n "$NODE_BIN" ] && "$NODE_BIN" -v || true)"

PY=""
for c in python3 /usr/bin/python3 $HOME/.local/share/dsh/python/bin/python3; do
  if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then
    if "$c" -c 'import PIL' >/dev/null 2>&1; then PY="$c"; break; fi
  fi
done
echo "  图标工具   ：${PY:-（无 Pillow，将跳过图标）}"

# ── 1. 目录骨架 ──
rm -rf "$APP"
mkdir -p "$MACOS_DIR" "$APP_RES"

# ── 2. 拷贝运行时资源（服务端 + 客户端 + 文档 + 工具）──
echo "  → 拷贝 server / client / docs / tools"
for d in server client; do
  rsync -a --exclude '.DS_Store' "$ROOT/$d" "$APP_RES/"
done
mkdir -p "$APP_RES/data"
for f in README.md PROTOCOL.md DESIGN.md; do
  [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$APP_RES/"
done
for d in docs tools; do
  [ -d "$ROOT/$d" ] && rsync -a --exclude '.DS_Store' "$ROOT/$d" "$APP_RES/"
done

# ── 3. 内嵌 Node ──
if [ "${BUNDLE_NODE:-1}" = "1" ] && [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
  echo "  → 内嵌 Node 运行时（$(du -h "$NODE_BIN" | cut -f1)）"
  cp "$NODE_BIN" "$RES_DIR/node"
  chmod +x "$RES_DIR/node"
else
  echo "  → 跳过内嵌 Node（将使用目标机器已安装的 Node）"
fi

# ── 4. 图标 ──
if [ -n "$PY" ]; then
  echo "  → 生成图标"
  "$PY" "$ROOT/tools/macos-app/make-icon.py" "$BUILD_TMP/icon-1024.png" >/dev/null
  ICONSET="$BUILD_TMP/icon.iconset"
  mkdir -p "$ICONSET"
  for sz in 16 32 128 256 512; do
    sips -z $sz $sz          "$BUILD_TMP/icon-1024.png" --out "$ICONSET/icon_${sz}x${sz}.png"      >/dev/null
    sips -z $((sz*2)) $((sz*2)) "$BUILD_TMP/icon-1024.png" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null
  done
  cp "$BUILD_TMP/icon-1024.png" "$ICONSET/icon_512x512@2x.png"
  iconutil -c icns "$ICONSET" -o "$RES_DIR/icon.icns"
  cp "$BUILD_TMP/icon-1024.png" "$ROOT/docs/screenshots/app-icon.png" 2>/dev/null || true
fi

# ── 5. 编译 Swift 外壳 ──
echo "  → 编译原生外壳（WKWebView）"
SWIFT_SRC="$ROOT/tools/macos-app/main.swift"
TARGET_ARCH="$(uname -m)"
compile() { # $1=target triple  $2=输出
  swiftc -O -swift-version 5 -target "$1" \
    -framework Cocoa -framework WebKit \
    "$SWIFT_SRC" -o "$2"
}
if [ "${UNIVERSAL:-0}" = "1" ] && [ "$TARGET_ARCH" = "arm64" ]; then
  if compile "arm64-apple-macos11.0"  "$BUILD_TMP/ths-arm64" \
     && compile "x86_64-apple-macos11.0" "$BUILD_TMP/ths-x64"; then
    lipo -create "$BUILD_TMP/ths-arm64" "$BUILD_TMP/ths-x64" -output "$MACOS_DIR/$APP_NAME"
    echo "     通用二进制（arm64 + x86_64）"
  else
    echo "     x86_64 编译失败，回退单架构"
    compile "arm64-apple-macos11.0" "$MACOS_DIR/$APP_NAME"
  fi
else
  compile "${TARGET_ARCH}-apple-macos11.0" "$MACOS_DIR/$APP_NAME"
fi
chmod +x "$MACOS_DIR/$APP_NAME"

# ── 6. Info.plist ──
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>$APP_NAME</string>
	<key>CFBundleDisplayName</key><string>$APP_NAME</string>
	<key>CFBundleExecutable</key><string>$APP_NAME</string>
	<key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
	<key>CFBundleVersion</key><string>$VERSION</string>
	<key>CFBundleShortVersionString</key><string>$VERSION</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleSignature</key><string>????</string>
	<key>CFBundleIconFile</key><string>icon</string>
	<key>LSMinimumSystemVersion</key><string>11.0</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSHumanReadableCopyright</key><string>同花亏 TongHuaKui $VERSION · 虚构行情，仅供娱乐</string>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsArbitraryLoads</key><true/>
		<key>NSAllowsLocalNetworking</key><true/>
	</dict>
</dict>
</plist>
PLIST

printf 'APPL????' > "$APP/Contents/PkgInfo"

# ── 7. 临时签名（本机可直接双击运行）──
echo "  → 临时签名"
xattr -cr "$APP" 2>/dev/null || true          # 必须先清扩展属性，否则报 detritus
codesign --force --sign - "$APP/Contents/Resources/node" >/dev/null 2>&1 || true
codesign --force --sign - "$MACOS_DIR/$APP_NAME" >/dev/null 2>&1 || true
if codesign --force --sign - "$APP" >/dev/null 2>&1; then
  echo "     已签名（ad-hoc）"
else
  echo "     签名失败（不影响本机运行）"
fi
xattr -cr "$APP" 2>/dev/null || true

# ── 8. 报告 ──
SIZE="$(du -sh "$APP" | cut -f1)"
echo
echo "════════════════════════════════════════════"
echo "  ✅ 构建完成：$APP"
echo "     体积    ：$SIZE"
echo "     架构    ：$(lipo -archs "$MACOS_DIR/$APP_NAME" 2>/dev/null || echo "$TARGET_ARCH")"
echo "     内嵌Node：$([ -f "$RES_DIR/node" ] && echo 是 || echo 否)"
echo
echo "  双击运行，或：open \"$APP\""
echo "  首次打开如被 Gatekeeper 拦：右键 → 打开；或执行"
echo "     xattr -dr com.apple.quarantine \"$APP\""
echo "════════════════════════════════════════════"
