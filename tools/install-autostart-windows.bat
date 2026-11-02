@echo off
chcp 65001 >nul
title 同花亏 - 安装开机自启（任务计划程序）
cd /d "%~dp0.."
set "ROOT=%CD%"

net session >nul 2>nul
if errorlevel 1 (
  echo.
  echo  需要管理员权限才能创建"开机启动"任务。
  echo  请右键本文件 -^> 以管理员身份运行。
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org/
  pause
  exit /b 1
)
for /f "delims=" %%i in ('where node') do set "NODEEXE=%%i" & goto :gotnode
:gotnode
echo 使用 Node: %NODEEXE%
echo 项目目录 : %ROOT%

echo.
echo [1/2] 创建开机自启任务  TongHuaKuiServer ...
schtasks /Create /F /TN "TongHuaKuiServer" ^
  /TR "\"%NODEEXE%\" \"%ROOT%\server\server.js\" --host 0.0.0.0 --port 8899" ^
  /SC ONSTART /RU SYSTEM /RL HIGHEST
if errorlevel 1 (
  echo [失败] 任务创建失败。
  pause
  exit /b 1
)

echo.
echo [2/2] 放行防火墙端口 8899 ...
netsh advfirewall firewall show rule name="TongHuaKui 8899" >nul 2>nul
if errorlevel 1 (
  netsh advfirewall firewall add rule name="TongHuaKui 8899" dir=in action=allow protocol=TCP localport=8899
) else (
  echo 防火墙规则已存在，跳过。
)

echo.
echo ============================================================
echo  安装完成！
echo    立即启动 ： schtasks /Run    /TN "TongHuaKuiServer"
echo    停止服务 ： schtasks /End    /TN "TongHuaKuiServer"
echo    删除自启 ： schtasks /Delete /TN "TongHuaKuiServer" /F
echo    访问地址 ： http://本机IP:8899
echo ============================================================
pause
