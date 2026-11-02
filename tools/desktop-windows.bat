@echo off
chcp 65001 >nul
title 同花亏 TongHuaKui
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org/
  pause
  exit /b 1
)

REM 1) 后台启动服务端（窗口最小化）
start "同花亏服务端" /min cmd /c "node server\server.js"

REM 2) 等待端口就绪
set /a tries=0
:waitloop
timeout /t 1 >nul
set /a tries+=1
powershell -NoProfile -Command "try{ $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',8899); $c.Close(); exit 0 }catch{ exit 1 }" >nul 2>nul
if errorlevel 1 if %tries% lss 15 goto waitloop

REM 3) 用 Edge / Chrome 的 --app 模式打开（无地址栏，像桌面客户端）
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=http://127.0.0.1:8899/index.html?real=1 --window-size=1600,1000
  exit /b 0
)

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" --app=http://127.0.0.1:8899/index.html?real=1 --window-size=1600,1000
  exit /b 0
)

REM 4) 兜底：默认浏览器
start "" http://127.0.0.1:8899/index.html?real=1
exit /b 0
