# 同花亏 · Windows Server 部署手册

> 目标：在一台 Windows Server（2016 / 2019 / 2022 / 2025 均可）上把「同花亏」跑成
> **开机自启的常驻服务**，供局域网或公网多人同时对战。
> 全流程**不需要安装任何 npm 包**（服务端零第三方依赖），只需要 Node.js 运行时。

---

## 1. 安装 Node.js

### 方式 A：官方 MSI（推荐，最简单）

1. 打开 <https://nodejs.org/en/download> ，下载 **Windows Installer (.msi) 64-bit** 的 **LTS** 版本（Node 20 / 22 / 24 均可，要求 ≥ 18）。
2. 安装时保持默认，**务必勾选 `Add to PATH`**。
3. 打开 `cmd`，验证：

```bat
node -v
:: 应输出 v20.x.x / v22.x.x / v24.x.x
```

### 方式 B：便携版（无管理员权限 / 不想写注册表）

1. 下载 `node-vXX-win-x64.zip`，解压到 `D:\nodejs`。
2. 把 `D:\nodejs` 加入系统 PATH（或在使用时用绝对路径调用 `D:\nodejs\node.exe`）。
3. 验证：`D:\nodejs\node.exe -v`。

> 如果服务器完全离线，可从任意联网机器下载安装包后拷贝过去。

---

## 2. 部署文件

把整个 `tonghuakui` 目录拷贝到服务器，例如 `D:\tonghuakui`。目录里应当有：

```
D:\tonghuakui\
├── server\server.js
├── server\src\...
├── client\index.html
├── client\js\...
├── tools\...
└── data\            ← 运行时自动生成 store.json（战绩/ELO）
```

---

## 3. 手动启动一次（先验证能跑）

```bat
cd /d D:\tonghuakui
node server\server.js --host 0.0.0.0 --port 8899
```

看到下面这样的输出就成功了：

```
[ths] 同花亏 服务端已启动  http://0.0.0.0:8899
[ths] 客户端目录 D:\tonghuakui\client
[ths] WebSocket  ws://0.0.0.0:8899/ws
```

在同网段的浏览器里访问 `http://<服务器IP>:8899` 即可看到登录界面（同花顺风格桌面）。

**放行防火墙**（若访问不通）：

```bat
netsh advfirewall firewall add rule name="TongHuaKui 8899" dir=in action=allow protocol=TCP localport=8899
```

也可以直接双击 `tools\start-windows.bat`，它会做同样的检查并给出友好提示。

---

## 4. 配置成常驻服务（三种方案，任选一种）

### 方案 A：任务计划程序 + 开机自启（**推荐，零额外软件**）

双击运行（需**管理员权限**）：

```
tools\install-autostart-windows.bat
```

它会：
1. 创建名为 `TongHuaKuiServer` 的计划任务（触发器：开机；以 SYSTEM 身份运行；最高权限）；
2. 自动添加防火墙入站规则（TCP 8899）。

常用命令：

```bat
schtasks /Run    /TN "TongHuaKuiServer"      :: 立即启动
schtasks /End    /TN "TongHuaKuiServer"      :: 停止
schtasks /Query  /TN "TongHuaKuiServer" /V   :: 查看状态
schtasks /Delete /TN "TongHuaKuiServer" /F   :: 卸载自启
```

> 想改端口：重新执行安装脚本前先编辑脚本里的 `--port 8899`。
> 日志默认打在任务计划的历史记录里；想看实时日志，用方案 C 或手动启动。

### 方案 B：NSSM（把它变成真正的 Windows 服务）

1. 下载 NSSM：<https://nssm.cc/download> ，解压出 `win64\nssm.exe`；
2. 管理员 `cmd`：

```bat
nssm install TongHuaKui "C:\Program Files\nodejs\node.exe" "D:\tonghuakui\server\server.js" --host 0.0.0.0 --port 8899
nssm set TongHuaKui AppDirectory D:\tonghuakui
nssm set TongHuaKui AppStdout D:\tonghuakui\logs\server.log
nssm set TongHuaKui AppStderr D:\tonghuakui\logs\server.err.log
nssm set TongHuaKui Start SERVICE_AUTO_START
mkdir D:\tonghuakui\logs
nssm start TongHuaKui
```

卸载：`nssm remove TongHuaKui confirm`

### 方案 C：IIS + 反向代理（需要域名 / HTTPS 时）

1. 安装 IIS 与 **URL Rewrite**、**Application Request Routing (ARR)**；
2. 站点绑定你的域名，反向代理到 `http://127.0.0.1:8899`；
3. **必须为 WebSocket 放行**：ARR 代理默认支持 `Upgrade`，若不通，在 `web.config` 中加：

```xml
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="ths" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:8899/{R:1}" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_PROTO" value="https" />
          </serverVariables>
        </rule>
      </rules>
    </rewrite>
    <webSocket enabled="true" />
  </system.webServer>
</configuration>
```

4. 站点用 HTTPS 后，客户端会自动用 `wss://` 连接同源 `/ws`（客户端已实现：`location.origin` 替换协议）。

---

## 5. 端口与多开

```bat
:: 一台机器跑多个实例（不同端口、不同数据文件）
set THK_PORT=8899
set THK_DATA=D:\tonghuakui\data\store-a.json
node server\server.js

set THK_PORT=8900
set THK_DATA=D:\tonghuakui\data\store-b.json
node server\server.js
```

支持的环境变量：

| 变量 | 说明 | 默认 |
|---|---|---|
| `THK_PORT` | 监听端口（也可用 `--port`） | `8899` |
| `THK_HOST` | 监听地址（也可用 `--host`） | `0.0.0.0` |
| `THK_DATA` | 战绩数据文件路径 | `data/store.json` |
| `THK_TICK` | 行情 tick 毫秒（**调大可以降低服务器压力**） | `1000` |

---

## 6. 运维

### 日志

服务端把连接、开局、结算、异常都打到标准输出（带时间戳）。
用 NSSM 时会写进 `logs\server.log`；用计划任务时可用 `schtasks /Query /V` 查看，或改为：

```bat
schtasks /Change /TN "TongHuaKuiServer" /TR "cmd /c \"cd /d D:\tonghuakui && node server\server.js >> logs\server.log 2>&1\""
```

### 数据备份

战绩与 ELO 全部在 `data\store.json`，**原子写入**（先写临时文件再 rename），断电不会写坏。
直接复制该文件即可备份；定期任务示例：

```bat
copy /Y D:\tonghuakui\data\store.json D:\backup\store-%date:~0,4%%date:~5,2%%date:~8,2%.json
```

### 性能参考

* 单个 8 人房间：每 tick 约 2 KB/人 的行情推送，CPU 占用极低；
* 一台 2 核 4G 的云服务器可稳定支撑 **数十个并发房间**；
* 若玩家很多，把 `THK_TICK` 调成 1500~2000（行情刷新慢一点，压力线性下降）。

### 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 浏览器打不开页面 | 防火墙未放行 8899；或 `--host` 绑成了 `127.0.0.1`（只能本机访问） |
| 页面打开但一直"连接断开" | 反向代理没放行 WebSocket `Upgrade` 头；或 HTTPS 页面连了 `ws://`（必须用 `wss://`，客户端已按同源自动处理） |
| 中文乱码 | 服务端已强制 `charset=utf-8`；若是 `cmd` 窗口乱码，执行 `chcp 65001` |
| `node` 不是内部或外部命令 | Node 未加入 PATH，重启 cmd；或改用绝对路径 `"C:\Program Files\nodejs\node.exe"` |
| 开机后服务没起 | `schtasks /Query /TN "TongHuaKuiServer" /V` 看上次结果码；确认 Node 路径没变 |
| 玩家断线后重新进入丢进度 | 客户端会自动重连并携带 token 恢复席位（服务端保留 90 秒） |

---

## 7. 升级

1. 停止服务（`schtasks /End /TN "TongHuaKuiServer"` 或 `nssm stop TongHuaKui`）；
2. 备份 `data\store.json`；
3. 覆盖 `server\` 与 `client\` 目录（**不要删 `data\`**）；
4. 重新启动。客户端是静态文件，用户刷新页面即可拿到新版本。
