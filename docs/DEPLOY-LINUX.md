# 同花亏 · Linux 部署手册（域名 `your-domain.com`）

> 目标：把 `dist/tonghuakui-server-1.0.0.tar.gz` 部署到一台公网 Linux 服务器，
> 通过 **https://your-domain.com** 让任何人打开就能玩（WebSocket 自动走 `wss://`）。
>
> 服务端**零依赖**，不需要 `npm install`，只需要 Node.js 18+。

---

## 0. 部署总览

```
玩家浏览器 ──https/wss──▶ nginx (443) ──http/ws──▶ 同花亏 node 服务端 (127.0.0.1:8899)
   your-domain.com         证书/反代                只监听本机，不暴露公网
```

要点：
1. Node 服务端只监听 `127.0.0.1`，公网只开 80/443，**不要把 8899 暴露出去**；
2. nginx 必须给 `/ws` 加 WebSocket 升级头，否则行情连不上（页面会一直"连接断开"）；
3. 客户端会自动把 `location.origin` 的 `http→ws`、`https→wss`，所以**不需要改任何前端代码**。

---

## 1. DNS 解析

在域名服务商处加一条 A 记录：

| 主机记录 | 类型 | 值 |
|---|---|---|
| `play` | A | 你服务器的公网 IP |

验证：

```bash
dig +short your-domain.com        # 应返回你的服务器 IP
```

---

## 2. 安装 Node.js 18+

```bash
# Debian / Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 或者用 nvm（不需要 root）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc && nvm install 20

node -v      # 需要 v18 或更高
```

---

## 3. 上传并解压

```bash
# 建一个专用账号（不要用 root 跑）
sudo useradd -r -m -d /opt/tonghuakui -s /usr/sbin/nologin thk

# 上传（在你本地机器执行）
scp dist/tonghuakui-server-1.0.0.tar.gz user@your-domain.com:/tmp/

# 服务器上解压
sudo tar -xzf /tmp/tonghuakui-server-1.0.0.tar.gz -C /opt/
sudo mv /opt/tonghuakui-server-1.0.0 /opt/tonghuakui
sudo chown -R thk:thk /opt/tonghuakui
sudo mkdir -p /opt/tonghuakui/data && sudo chown -R thk:thk /opt/tonghuakui/data
```

---

## 4. 先手动跑一次（确认能起来）

```bash
sudo -u thk bash -lc 'cd /opt/tonghuakui && THK_HOST=127.0.0.1 THK_PORT=8899 ./deploy/scripts/start.sh'
```

看到类似输出即成功：

```
== 同花亏服务端 ==
  监听      : 127.0.0.1:8899
  运控控制台 : 密钥已写入 /opt/tonghuakui/data/admin-key.txt
  运维控制台 : http://127.0.0.1:8899/admin.html
```

另开一个终端验证：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8899/            # 200
cat /opt/tonghuakui/data/admin-key.txt                                     # 记下这个密钥
```

按 `Ctrl+C` 停掉，接着配常驻服务。

---

## 5. 配置成 systemd 常驻服务

```bash
sudo cp /opt/tonghuakui/deploy/systemd/tonghuakui.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tonghuakui
sudo systemctl status tonghuakui --no-pager
```

> 如果你的 node 不在 `/usr/bin/node`（用 nvm 装的），把 service 文件里的
> `ExecStart=/usr/bin/node` 改成 `which node` 的实际路径；用 nvm 的话建议改用系统 node，
> 否则升级 nvm 版本后服务会起不来。

日志与排错：

```bash
journalctl -u tonghuakui -f            # 实时日志
journalctl -u tonghuakui --since '10 min ago'
sudo systemctl restart tonghuakui
```

---

## 6. nginx 反向代理 + HTTPS

### 6.1 安装 nginx 与 certbot

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

### 6.2 放入站点配置

```bash
sudo mkdir -p /var/www/certbot
sudo cp /opt/tonghuakui/deploy/nginx/your-domain.com.conf /etc/nginx/conf.d/
sudo nginx -t && sudo systemctl reload nginx
```

> 首次申请证书前，nginx 配置里引用的证书文件还不存在，`nginx -t` 可能报错。
> 若报错，先临时把 `listen 443 ssl;` 那段的 `ssl_certificate*` 两行注释掉，
> 申请完证书再取消注释（或直接用下面的 certbot `--nginx` 自动改）。

### 6.3 申请证书

```bash
sudo certbot --nginx -d your-domain.com --agree-tos -m 你的邮箱@example.com --redirect
sudo systemctl reload nginx
```

certbot 会自动续期（`systemctl list-timers | grep certbot` 可确认）。

### 6.4 防火墙

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
# 8899 千万不要放行
```

---

## 7. 验证

```bash
# 静态页面
curl -sI https://your-domain.com/ | head -3                 # 200 OK

# WebSocket 握手（重点：必须返回 101 Switching Protocols）
curl -sI -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
     https://your-domain.com/ws | head -3
```

浏览器打开 `https://your-domain.com`：
- 底部状态栏应显示 **已连接 your-domain.com**
- 打开 `https://your-domain.com/admin.html` 输入 `data/admin-key.txt` 里的密钥，进入运维控制台

---

## 8. 日常运维

| 事项 | 命令 / 做法 |
|---|---|
| 看日志 | `journalctl -u tonghuakui -f` |
| 重启 | `sudo systemctl restart tonghuakui` |
| 备份数据 | `sudo cp /opt/tonghuakui/data/store.json /backup/store-$(date +%F).json`（建议加 cron） |
| 改端口/密钥 | 编辑 `/etc/systemd/system/tonghuakui.service` 的 `Environment=` 后 `daemon-reload && restart` |
| 升级 | 解压新版本到 `/opt/tonghuakui-new` → 把旧 `data/` 拷过去 → 停服 → 替换目录 → 起服（`data/` 必须保留） |
| 回滚 | 保留上一版目录，改 systemd 的 `WorkingDirectory` 指回去即可 |

**数据备份建议**（每天 4 点）：

```bash
sudo crontab -u thk -e
0 4 * * * cp /opt/tonghuakui/data/store.json /opt/tonghuakui/data/backup-$(date +\%F).json
```

---

## 9. 常见故障

| 现象 | 原因 / 处理 |
|---|---|
| 页面能开，但一直「连接断开」 | nginx 没给 `/ws` 加 `Upgrade`/`Connection` 头，或漏了 `proxy_http_version 1.1`。用第 7 节的 curl 自检，必须 101 |
| 打开就 502 | 后端没起来：`systemctl status tonghuakui`，看是不是 node 路径写错 |
| `EADDRINUSE` | 8899 被占用：`sudo lsof -i:8899` 杀掉旧进程，或改 `THK_PORT` |
| 对局中人一多就卡 | 看 `journalctl` 有没有异常刷屏；单局 30 人、61 只股票时每 tick 约 0.1ms，正常机器毫无压力 |
| 证书续期失败 | `sudo certbot renew --dry-run` 排查；确认 80 端口没被别的服务占用 |
| 时间不对/延迟显示异常 | 服务器装 `chrony` 或 `systemd-timesyncd` 保持对时 |
| 控制台提示 `ADMIN_DISABLED` | 没设 `THK_ADMIN_KEY` 且密钥文件写不进去（检查 `/opt/tonghuakui/data` 权限） |

---

## 10. 多开 / 局域网

- 同一台机器想跑多局？**不需要多开进程**：一个服务端可以同时承载多个房间（大厅里创建即可）。
- 想在局域网给同事玩：`THK_HOST=0.0.0.0`，然后访问 `http://<内网IP>:8899`。
- 公网部署请务必保持 `THK_HOST=127.0.0.1` + nginx 反代。
