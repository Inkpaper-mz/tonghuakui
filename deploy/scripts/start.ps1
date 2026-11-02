# ═══════════════════════════════════════════════════════════════
#  同花亏 · Windows PowerShell 启动脚本
#  用法： powershell -ExecutionPolicy Bypass -File scripts\start.ps1
#         powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -Background
# ═══════════════════════════════════════════════════════════════
param(
  [int]$Port = 8899,
  [string]$BindHost = "0.0.0.0",
  [int]$Tick = 1000,
  [switch]$Background
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $fallback = Join-Path $env:ProgramFiles "nodejs\node.exe"
  if (Test-Path $fallback) { $node = $fallback } else { Write-Error "找不到 node.exe，请先安装 Node.js 18+"; exit 1 }
}
$major = [int](& $node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if ($major -lt 16) { Write-Error "Node 版本过低（$(& $node -v)），需要 18+"; exit 1 }

New-Item -ItemType Directory -Force -Path (Join-Path $Root "data") | Out-Null
$env:THK_HOST = $BindHost
$env:THK_PORT = "$Port"
if (-not $env:THK_DATA) { $env:THK_DATA = Join-Path $Root "data\store.json" }

Write-Host "== 同花亏服务端 ==" -ForegroundColor Cyan
Write-Host "  node     : $node ($(& $node -v))"
Write-Host "  监听     : $BindHost`:$Port"
Write-Host "  数据文件 : $env:THK_DATA"
Write-Host ""

if ($Background) {
  $log = Join-Path $Root "data\server.log"
  Start-Process -FilePath $node -ArgumentList "server/server.js", "--port", $Port, "--host", $BindHost, "--tick", $Tick `
    -WorkingDirectory $Root -RedirectStandardOutput $log -RedirectStandardError "$log.err" -WindowStyle Hidden
  Write-Host "已在后台启动，日志：$log" -ForegroundColor Green
} else {
  & $node server/server.js --port $Port --host $BindHost --tick $Tick
}
