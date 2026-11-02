/* ═══════════════════════════════════════════════════════════════
   同花亏 · 开发验收工具：无头浏览器远程探针（CDP）
   用途：自动化验证 UI 交互（下单 / 撤单 / 结算 / 切换标签）并截图。

   用法：
     node tools/probe.mjs "view=trade&auto=1" --script "window.__ths.handleCmd('buy')" --shot out.png
     node tools/probe.mjs "view=trade&auto=1" --eval-file /tmp/test.js --shot out.png

   仅用于开发/验收，不参与运行时。Node >= 22（内置 WebSocket / fetch）。
   ═══════════════════════════════════════════════════════════════ */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  process.env.CHROME_PATH || '',
];

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (c && existsSync(c)) return c;
  throw new Error('未找到 Chrome / Edge，可用 CHROME_PATH 环境变量指定');
}

const args = process.argv.slice(2);
function flag(name, def = null) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const query = (args[0] && !args[0].startsWith('--')) ? args[0] : '';
const PORT = Number(flag('port', 8899));
/* CDP 端口：本机可能残留大量旧 headless Chrome。以前默认随机 9000~9899，
   撞上别人的实例时新 Chrome 绑不上端口，fetch /json/list 会**静默返回旧页面**，
   于是验收数据完全失真（实测被坑过）。现在：① 先确保端口真空闲 ② 连上后校验目标 URL。 */
async function pickFreePort(a, b) {
  const net = await import('node:net');
  for (let i = 0; i < 40; i++) {
    const p = a + Math.floor(Math.random() * (b - a));
    const free = await new Promise((res) => {
      const srv = net.createServer();
      srv.once('error', () => res(false));
      srv.once('listening', () => srv.close(() => res(true)));
      srv.listen(p, '127.0.0.1');
    });
    if (free) return p;
  }
  return a;
}
const CDP_PORT = Number(flag('cdp', 0)) || await pickFreePort(9000, 9900);
const SHOT = flag('shot', '/tmp/probe.png');
const WAIT = Number(flag('wait', 2500));
const W = Number(flag('width', 1600));
const H = Number(flag('height', 1000));
const CDP_TIMEOUT = Number(flag('timeout', 30000));   // 单条 CDP 命令超时（长脚本可调大）
const evalFile = flag('eval-file');
const script = evalFile ? readFileSync(evalFile, 'utf8') : flag('script');

const url = `http://127.0.0.1:${PORT}/index.html${query ? '?' + query : ''}`;
const profile = mkdtempSync(join(tmpdir(), 'ths-chrome-'));

const chrome = spawn(findChrome(), [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${CDP_PORT}`,
  `--window-size=${W},${H}`,
  url,
], { stdio: ['ignore', 'ignore', 'pipe'] });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await r.json();
      const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
      /* 必须是我们自己打开的那个页面（防止连到残留实例的旧页面） */
      const mine = pages.find(t => String(t.url || '').includes(`127.0.0.1:${PORT}/`));
      if (mine) return mine;
      if (pages.length && i > 25) {
        throw new Error(`CDP 端口 ${CDP_PORT} 上有别的页面（${pages.map(t => t.url).join(', ')}）——`
          + '多半是残留的 headless Chrome 占用了端口，请加 --cdp <空闲端口> 重试');
      }
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('等待 Chrome 调试端口超时');
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const waiting = new Map();
ws.onmessage = (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && waiting.has(m.id)) {
    const { resolve, reject } = waiting.get(m.id);
    waiting.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
};
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (waiting.has(id)) { waiting.delete(id); reject(new Error('CDP 超时: ' + method)); }
    }, CDP_TIMEOUT);
  });
}

await send('Page.enable');
await send('Runtime.enable');
await sleep(WAIT);

const results = [];
const log = (label, value) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  results.push(`${label}: ${s}`);
  console.log(`  ${label} → ${s}`);
};

// 页面错误收集
await send('Runtime.evaluate', {
  expression: `window.__errs=[]; addEventListener('error', e=>window.__errs.push(String(e.message))); 
               addEventListener('unhandledrejection', e=>window.__errs.push('reject:'+String(e.reason)));`,
});

if (script) {
  const r = await send('Runtime.evaluate', {
    expression: `(async()=>{ ${script} })()`,
    awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) {
    log('脚本异常', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  } else {
    log('脚本结果', r.result?.value === undefined ? 'ok' : r.result.value);
  }
  await sleep(1200);
}

const errs = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__errs||[])', returnByValue: true });
log('页面错误', errs.result.value);

const state = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
     view: window.__ths?.state.view,
     stocks: window.__ths?.state.stocks.size,
     quotes: window.__ths?.state.quotes.size,
     klines: window.__ths?.state.klines.size,
     timeshare: window.__ths?.state.timeshare?.size,
     bottomTab: window.__ths?.state.ui.bottomTab,
     orders: window.__ths?.state.account?.orders?.length ?? null,
     positions: window.__ths?.state.account?.positions?.length ?? null,
     trades: window.__ths?.state.account?.trades?.length ?? null,
     cash: window.__ths?.state.account?.cash,
     assets: window.__ths?.state.account?.totalAssets,
     rank: window.__ths?.state.rank?.length,
     news: window.__ths?.state.news?.length
   })`, returnByValue: true,
});
log('状态', state.result.value);

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
log('截图', SHOT);

ws.close();
chrome.kill('SIGKILL');
console.log('\n'.concat(results.join('\n')));
process.exit(0);
