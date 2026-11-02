@echo off
REM ═══════════════════════════════════════════════════════════════
REM  同花亏 · Windows 启动脚本（双击即可）
REM  可用参数： --port 8899 --host 127.0.0.1 --tick 1000
REM ═══════════════════════════════════════════════════════════════
setlocal
cd /d "%~dp0.."

if exist "%~dp0..\runtime\node\node.exe" (
  set "NODE_BIN=%~dp0..\runtime\node\node.exe"
  goto :havenode
)
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
  ) else (
    echo [错误] 找不到 node.exe，请先安装 Node.js 18+ ^(https://nodejs.org^)
    pause
    exit /b 1
  )
) else (
  set "NODE_BIN=node"
)

if not exist "data" mkdir data
if "%THK_HOST%"=="" set "THK_HOST=0.0.0.0"
if "%THK_PORT%"=="" set "THK_PORT=8899"
if "%THK_DATA%"=="" set "THK_DATA=%CD%\data\store.json"

echo == 同花亏服务端 ==
echo   监听     : %THK_HOST%:%THK_PORT%
echo   数据文件 : %THK_DATA%
echo   局域网访问: 手机/同事用 http://本机IP:%THK_PORT% 即可加入
echo   停止服务 : 直接关闭本窗口或按 Ctrl+C
echo.

"%NODE_BIN%" server\server.js %*
pause
