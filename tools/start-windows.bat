@echo off
chcp 65001 >nul
title 同花亏 TongHuaKui - 服务端
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [错误] 未检测到 Node.js。
  echo  请先安装 Node.js 20 LTS 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo            同花亏 TongHuaKui  商业模拟对战平台
echo ============================================================
echo   本机访问 : http://127.0.0.1:8899
echo   局域网   : http://本机IP:8899
echo   停止服务 : 按 Ctrl + C
echo ============================================================
echo.

node "server\server.js" %*
echo.
echo 服务已停止。
pause
