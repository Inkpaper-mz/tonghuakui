/* ═══════════════════════════════════════════════════════════════
   同花亏 · views/login.js —— 登录窗（Windows 对话框风格）
   接口（DESIGN.md §4.4）：renderLogin(ctx) -> { destroy() }
   ═══════════════════════════════════════════════════════════════ */

import { el, clear } from '../util.js';

const AVATARS = ['🐂', '🐻', '🐷', '🐔', '🦆', '🐸', '🐵', '🐯', '🦊', '🐼', '🦄', '👽'];
const AVATAR_TIP = ['多头牛', '空头熊', '猪队友', '追高鸡', '接盘鸭', '井底蛙', '猴子派来的', '猛虎下山', '老狐狸', '国宝熊猫', '独角兽', '外星人'];
const NICK_KEY = 'thk.nick';
const AVA_KEY = 'thk.avatar';
const VERSION = 'v1.0.0';

function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

/** 股票池数量从数据源动态取（MockNet 暴露 market；真实服务端则看 state.stocks） */
function poolText(ctx) {
  const S = (ctx && ctx.state) || {};
  const net = (ctx && ctx.net) || {};
  const n = (net.market && net.market.size) || (S.stocks && S.stocks.size) || 0;
  return n ? `${n} 只虚拟个股` : '20+ 只虚拟个股';
}

function featuresOf(ctx) {
  return [
    ['📈', '实时行情', `${poolText(ctx)}，五档盘口 / 分时 / K 线一应俱全`],
    ['⚔️', '多人对战', '1v1 单挑 · 多人混战 · 红蓝团战，三种模式'],
    ['🧾', '仿真撮合', '限价挂单排队、市价吃五档、滑点与价格冲击'],
    ['🏆', 'ELO 排位', '青铜到王者六大段位，实时排行榜互相追赶'],
    ['🤖', 'AI 诊股', '内在价值估值 + 六维评分 + 风险提示 + 买卖区间，同花顺式智能投顾'],
  ];
}

export function renderLogin(ctx) {
  const root = ctx.root;
  clear(root);

  const S = ctx.state;
  const offs = [];
  let destroyed = false;
  let pending = false;
  let guest = false;

  let nick = lsGet(NICK_KEY, '');
  let avatar = Number(lsGet(AVA_KEY, '-1'));
  if (!(avatar >= 0 && avatar < 12)) avatar = Math.floor(Math.random() * 12);

  /* ───────── DOM ───────── */

  const wrap = el('div', { class: 'v-login' });
  const win = el('div', { class: 'v-win v-login-win' });

  /* 标题栏 */
  const hd = el('div', { class: 'v-win-hd' });
  hd.appendChild(el('span', { class: 'v-win-ico', text: '亏' }));
  hd.appendChild(el('span', { class: 'v-win-title', text: '同花亏 — 用户登录' }));
  const hdX = el('button', { class: 'v-win-x', text: '✕', title: '不登录，先看看（Mock 数据已就绪）' });
  hdX.onclick = () => ctx.toast('当前是本地演示版本（Mock 数据），直接登录即可开玩', 'info');
  hd.appendChild(hdX);
  win.appendChild(hd);

  /* 主体 */
  const body = el('div', { class: 'v-login-body' });

  const side = el('div', { class: 'v-login-side' });
  side.appendChild(el('div', { class: 'v-logo', html: '<span class="v-logo-mark">亏</span><span class="v-logo-text">同花亏</span>' }));
  side.appendChild(el('div', { class: 'v-slogan', text: '同样的行情，不同的亏损。' }));
  const feat = el('div', { class: 'v-feats' });
  for (const [ico, t, d] of featuresOf(ctx)) {
    const row = el('div', { class: 'v-feat' });
    row.appendChild(el('span', { class: 'v-feat-ico', text: ico }));
    const tx = el('div', { class: 'v-feat-tx' });
    tx.appendChild(el('b', { text: t }));
    tx.appendChild(el('span', { class: 'dim', text: d }));
    row.appendChild(tx);
    feat.appendChild(row);
  }
  side.appendChild(feat);
  body.appendChild(side);

  const form = el('div', { class: 'v-login-form' });

  /* 昵称 */
  const rowNick = el('div', { class: 'v-fld' });
  rowNick.appendChild(el('label', { class: 'v-lb', text: '昵称' }));
  const nickInput = el('input', {
    class: 'input v-nick', type: 'text', maxlength: '12', value: nick,
    placeholder: '请输入昵称（1-12 个字）', autocomplete: 'off', spellcheck: 'false',
  });
  rowNick.appendChild(nickInput);
  rowNick.appendChild(el('span', { class: 'v-fld-tip', text: '对手会看到这个名字' }));
  form.appendChild(rowNick);

  /* 头像 */
  const rowAva = el('div', { class: 'v-fld' });
  rowAva.appendChild(el('label', { class: 'v-lb', text: '头像' }));
  const avaGrid = el('div', { class: 'v-avatars' });
  const avaBtns = [];
  for (let i = 0; i < AVATARS.length; i++) {
    const b = el('button', {
      class: 'v-ava' + (i === avatar ? ' sel' : ''), type: 'button',
      title: AVATAR_TIP[i] + '（头像 ' + i + '）', text: AVATARS[i],
    });
    b.onclick = () => {
      avatar = i;
      avaBtns.forEach((x, k) => x.classList.toggle('sel', k === i));
      lsSet(AVA_KEY, String(i));
    };
    avaBtns.push(b);
    avaGrid.appendChild(b);
  }
  rowAva.appendChild(avaGrid);
  form.appendChild(rowAva);

  /* 提示 */
  const tip = el('div', { class: 'v-login-tip' });
  tip.appendChild(el('span', { class: 'v-kbd', text: 'Enter' }));
  tip.appendChild(el('span', { class: 'dim', text: `快速登录　·　无需注册，昵称即身份　·　数据来源：${(ctx.state && ctx.state.source === 'real') ? '真实服务端' : '本地 Mock'}` }));
  form.appendChild(tip);

  /* 按钮 */
  const btns = el('div', { class: 'v-login-btns' });
  const btnEnter = el('button', { class: 'btn btn-lg btn-primary v-enter', text: '进入平台' });
  const btnGuest = el('button', { class: 'btn v-guest', text: '游客快速体验（AI 演示）' });
  btns.appendChild(btnEnter);
  btns.appendChild(btnGuest);
  form.appendChild(btns);

  body.appendChild(form);
  win.appendChild(body);

  /* 底栏 */
  const foot = el('div', { class: 'v-login-foot' });
  foot.appendChild(el('span', { class: 'v-ver', text: '同花亏 商业模拟对战平台 ' + VERSION }));
  const status = el('span', { class: 'v-status' });
  const dot = el('i', { class: 'dot ' + (S.connected ? 'dot-green' : 'dot-yellow') });
  status.appendChild(dot);
  const statusTx = el('span', { text: S.connected ? '服务正常' : ((S.source === 'real') ? '正在连接服务端…' : '正在连接本地 Mock 服务…') });
  status.appendChild(statusTx);
  foot.appendChild(status);
  win.appendChild(foot);

  wrap.appendChild(win);
  root.appendChild(wrap);

  /* ───────── 行为 ───────── */

  function refreshStatus() {
    if (destroyed) return;
    const online = Number.isFinite(Number(S.online)) ? Number(S.online) : 1;   // 0 也要如实显示
    const lat = S.latency || 0;
    dot.className = 'dot ' + (S.connected ? 'dot-green' : 'dot-yellow');
    statusTx.textContent = S.connected
      ? `服务正常 · 在线 ${online} 人 · 延迟 ${lat || 12}ms`
      : '正在连接本地 Mock 服务…';
  }

  function submit(asGuest) {
    if (pending || destroyed) return;
    const n = String(nickInput.value || '').trim();
    if (!n) { ctx.toast('请输入昵称（1-12 个字）', 'warn'); nickInput.focus(); return; }
    if (n.length > 12) { ctx.toast('昵称最多 12 个字', 'warn'); nickInput.focus(); return; }

    nick = n;
    guest = !!asGuest;
    pending = true;
    lsSet(NICK_KEY, n);
    btnEnter.disabled = true;
    btnGuest.disabled = true;
    btnEnter.textContent = asGuest ? '准备中…' : '登录中…';
    statusTx.textContent = '正在登录…';
    ctx.net.send('login', { nick: n, avatar });
  }

  nickInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(false); }
  });
  btnEnter.onclick = () => submit(false);
  btnGuest.onclick = () => {
    if (!String(nickInput.value || '').trim()) nickInput.value = '游客' + (1000 + Math.floor(Math.random() * 9000));
    /* 标记「游客演示」意图：真正的 room:quick 由 main.js 在 go('lobby') 之后补发，
       因为本视图的 login_ok 监听会在 go('lobby') 的同步 destroy() 里被移除。 */
    if (ctx.state && ctx.state.ui) ctx.state.ui.guestDemo = true;
    submit(true);
  };
  nickInput.addEventListener('input', () => { guest = false; });

  offs.push(ctx.on('login_ok', (m) => {
    if (destroyed) return;
    pending = false;
    refreshStatus();
    if (guest) {
      ctx.toast('已为你开启 AI 演示对局，倒计时后开盘', 'info');
      ctx.net.send('room:quick', { mode: 'ffa', durationSec: 900, startCash: 1000000 });
    } else {
      const p = m && m.player;
      ctx.toast(p ? `登录成功：${p.nick} · ${p.tier} ${p.elo}` : '登录成功', 'success');
    }
  }));

  offs.push(ctx.on('error', () => {
    if (destroyed) return;
    pending = false;
    btnEnter.disabled = false;
    btnGuest.disabled = false;
    btnEnter.textContent = '进入平台';
    refreshStatus();
  }));

  offs.push(ctx.on('welcome', () => refreshStatus()));

  offs.push(ctx.onState(() => refreshStatus()));

  setTimeout(() => { if (!destroyed && !pending) nickInput.focus(); }, 60);
  refreshStatus();

  return {
    destroy() {
      destroyed = true;
      for (const off of offs) { try { off(); } catch (e) { /* ignore */ } }
      offs.length = 0;
      clear(root);
    },
  };
}

export default renderLogin;
