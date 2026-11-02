#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   同花亏 · server.js —— 进程入口
   ─ HTTP 静态托管（client/）+ WebSocket（/ws）+ 大厅/房间
   ─ CLI/环境变量：--port / --host / --open / --tick
   ─ 优雅退出：SIGINT / SIGTERM → 停房间 → store.close() → 关 ws → 退出
   ─ 跨平台：路径全部 path.join，不依赖任何 shell 命令
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const util = require('./src/util');
const config = require('./src/config');
const { createStaticHandler } = require('./src/static');
const { WebSocketServer } = require('./src/ws');
const { Store } = require('./src/store');
const Lobby = require('./src/lobby');
const Net = require('./src/net');

const log = util.createLogger('server');

const USAGE = `
同花亏 TongHuaKui 服务端

用法： node server/server.js [选项]

选项：
  --port <n>    监听端口（默认 ${config.PORT}，也可用环境变量 THK_PORT / PORT）
  --host <ip>   监听地址（默认 ${config.HOST}，也可用环境变量 THK_HOST）
  --tick <ms>   行情 tick 毫秒（默认 ${config.TICK_MS}）
  --open        启动后自动打开浏览器
  --no-open     不打开浏览器
  -h, --help    显示本帮助
`;

/** 解析命令行参数 */
function parseArgs(argv) {
  const out = {};
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i]);
    const take = (prefix) => a.slice(prefix.length);
    if (a === '--port' || a === '-p') out.port = Number(list[++i]);
    else if (a.indexOf('--port=') === 0) out.port = Number(take('--port='));
    else if (a === '--host') out.host = String(list[++i] || '');
    else if (a.indexOf('--host=') === 0) out.host = take('--host=');
    else if (a === '--tick') out.tick = Number(list[++i]);
    else if (a.indexOf('--tick=') === 0) out.tick = Number(take('--tick='));
    else if (a === '--open') out.open = true;
    else if (a === '--no-open') out.open = false;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/** 局域网 IPv4（供启动日志展示） */
function lanAddresses() {
  const out = [];
  try {
    const ifaces = os.networkInterfaces() || {};
    for (const name of Object.keys(ifaces)) {
      for (const info of (ifaces[name] || [])) {
        if (!info || info.internal) continue;
        const family = typeof info.family === 'string' ? info.family : (info.family === 4 ? 'IPv4' : '');
        if (family !== 'IPv4') continue;
        out.push(info.address);
      }
    }
  } catch (err) { /* ignore */ }
  return out;
}

/** 跨平台打开浏览器（失败静默） */
function openBrowser(url) {
  try {
    let cmd = null;
    let args = [];
    if (process.platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    if (child && typeof child.unref === 'function') child.unref();
    child.on && child.on('error', () => { /* 打不开就算了 */ });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * 创建并启动服务
 * @param {{port?:number, host?:string, tick?:number, open?:boolean, silent?:boolean}} opts
 * @returns {Promise<{server:object, wss:object, lobby:object, store:object, url:string, port:number, host:string, close:Function}>}
 */
async function start(opts = {}) {
  const port = Number.isFinite(Number(opts.port)) ? Number(opts.port) : config.PORT;
  const host = opts.host || config.HOST;
  if (Number.isFinite(Number(opts.tick)) && Number(opts.tick) > 0) {
    config.TICK_MS = Math.max(20, Math.round(Number(opts.tick)));
  }

  const store = new Store(config.DATA_FILE);
  const lobby = new Lobby({ config, store });
  const net = new Net({ lobby, config, store });

  const staticHandler = createStaticHandler(config.CLIENT_DIR);
  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(() => staticHandler(req, res))
      .then((handled) => {
        if (handled) return;
        try {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end('404 Not Found');
        } catch (err) { /* ignore */ }
      })
      .catch((err) => {
        log.warn('静态请求处理异常', err && err.message);
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('500 Internal Server Error');
          } else {
            res.end();
          }
        } catch (err2) { /* ignore */ }
      });
  });
  server.on('clientError', (err, socket) => {
    try { socket.destroy(); } catch (e) { /* ignore */ }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (conn) => {
    try { net.handle(conn); }
    catch (err) { log.error('WebSocket 连接初始化异常', err && err.stack ? err.stack : err); }
  });
  wss.on('error', (err) => log.warn('WebSocket 错误', err && err.message));

  const heartbeat = setInterval(() => {
    try { wss.heartbeat(); } catch (err) { /* ignore */ }
  }, Math.max(5000, Number(config.HEARTBEAT_MS) || 30000));
  if (heartbeat.unref) heartbeat.unref();

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const actualPort = (server.address() && server.address().port) || port;
  const localHost = (host === '0.0.0.0' || host === '::' || host === '') ? '127.0.0.1' : host;
  const url = `http://${localHost}:${actualPort}`;

  let closed = false;
  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    try { clearInterval(heartbeat); } catch (err) { /* ignore */ }
    try { lobby.closeAll(); } catch (err) { /* ignore */ }
    try { store.close(); } catch (err) { /* ignore */ }
    try { wss.close(); } catch (err) { /* ignore */ }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try { server.close(finish); } catch (err) { finish(); }
      const t = setTimeout(finish, 600);
      if (t.unref) t.unref();
    });
  }

  if (opts.silent !== true) {
    const stocks = (config.STOCKS || []).length;
    const lan = lanAddresses();
    console.log('');
    log.ok(`${config.SERVER_NAME} 服务端 v${config.VERSION} 已启动`);
    log.info(`  本机访问   : ${url}`);
    if (lan.length) {
      for (const ip of lan) log.info(`  局域网访问 : http://${ip}:${actualPort}`);
    } else {
      log.info('  局域网访问 : 未检测到可用的局域网 IPv4 地址');
    }
    log.info(`  WebSocket  : ws://${localHost}:${actualPort}/ws`);
    log.info(`  静态目录   : ${config.CLIENT_DIR}`);
    log.info(`  数据文件   : ${config.DATA_FILE}`);
    if (config.ADMIN_KEY) {
      log.info(`  运维控制台 : ${url.replace(/\/$/, '')}/admin.html  （密钥见 data/admin-key.txt 或 THK_ADMIN_KEY）`);
    } else {
      log.info('  运维控制台 : 已关闭（未设置 THK_ADMIN_KEY，且无法写入密钥文件）');
    }
    log.info(`  行情 tick  : ${config.TICK_MS}ms · 虚拟交易日 ${config.VIRTUAL_DAY_TICKS} tick · 股票 ${stocks} 只`);
    log.info('  停止服务   : Ctrl + C');
    console.log('');
  }

  if (opts.open) openBrowser(url);

  return { server, wss, lobby, net, store, url, port: actualPort, host, close };
}

/** 进程入口：起服务 + 信号处理 */
async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return null;
  }

  /* 未捕获异常：只记日志，绝不退出 */
  process.on('uncaughtException', (err) => {
    log.error('未捕获异常（进程继续运行）', err && err.stack ? err.stack : err);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 拒绝（进程继续运行）', reason && reason.stack ? reason.stack : reason);
  });

  /* 运维控制台密钥：THK_ADMIN_KEY 优先；否则自动生成一个并落盘到 data/admin-key.txt，
     这样「图形控制台」开箱可用，又不会用一个人人可猜的默认口令。 */
  if (!config.ADMIN_KEY) {
    try {
      const keyFile = path.join(path.dirname(config.DATA_FILE), 'admin-key.txt');
      let key = '';
      try { key = String(require('fs').readFileSync(keyFile, 'utf8') || '').trim(); } catch (e) { key = ''; }
      if (!/^[A-Za-z0-9_-]{8,}$/.test(key)) {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
        key = Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        require('fs').mkdirSync(path.dirname(keyFile), { recursive: true });
        require('fs').writeFileSync(keyFile, key + '\n', 'utf8');
      }
      config.ADMIN_KEY = key;
      log.info(`  运维控制台 : 密钥已写入 ${keyFile}`);
    } catch (err) {
      log.warn('  运维控制台 : 生成密钥失败（控制台将不可用）', err && err.message);
    }
  }

  let app = null;
  try {
    app = await start({
      port: args.port,
      host: args.host,
      tick: args.tick,
      open: args.open === true,
    });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      log.error(`端口 ${args.port || config.PORT} 已被占用，请换一个端口：node server/server.js --port 8900`);
    } else if (err && err.code === 'EACCES') {
      log.error(`没有权限监听 ${args.port || config.PORT} 端口，请改用 1024 以上的端口`);
    } else {
      log.error('服务启动失败', err && err.stack ? err.stack : err);
    }
    process.exit(1);
    return null;
  }

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`收到 ${signal}，正在优雅退出…`);
    process.on('exit', (code) => {
      if (code === 0) log.ok('已退出。');
    });
    Promise.resolve()
      .then(() => app.close())
      .catch((err) => log.warn('关闭过程异常', err && err.message))
      .then(() => process.exit(0));
    const force = setTimeout(() => process.exit(0), 1500);
    if (force.unref) force.unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown('SIGBREAK'));

  return app;
}

module.exports = { start, main, parseArgs, openBrowser, lanAddresses, USAGE };

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    log.error('启动失败', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
