/* ═══════════════════════════════════════════════════════════════
   同花亏 · views/lobby.js —— 对战大厅
   接口（DESIGN.md §4.4）：renderLobby(ctx) -> { destroy() }
   ═══════════════════════════════════════════════════════════════ */

import { el, clear, fmtMoney, fmtTime, escapeHtml, confirmBox, uid } from '../util.js';

const MODE_CARDS = [
  { id: '1v1', name: '1v1 单挑', icon: '⚔️', desc: '两人对决，技术与心态的正面碰撞', maxPlayers: 2 },
  { id: 'ffa', name: '多人混战', icon: '💥', desc: '最多 30 人同场竞技，最后赢家只有一个', maxPlayers: 30 },
  { id: 'team', name: '红蓝团战', icon: '🚩', desc: '红蓝两队对抗，最多 30 人，按队伍平均收益率结算', maxPlayers: 30 },
];
const DURATIONS = [{ sec: 300, name: '5 分钟' }, { sec: 900, name: '15 分钟' }, { sec: 1800, name: '30 分钟' }];
const CASHS = [{ v: 100000, n: '10 万' }, { v: 1000000, n: '100 万' }, { v: 5000000, n: '500 万' }];
const MODE_NAME = { '1v1': '1v1 单挑', ffa: '多人混战', team: '红蓝团战' };
/* 房间列表模式筛选（全部 / 三种模式） */
const MODE_FILTERS = [{ v: 'all', n: '全部模式' }, { v: '1v1', n: '1v1 单挑' }, { v: 'ffa', n: '多人混战' }, { v: 'team', n: '红蓝团战' }];
const STATUS_NAME = { waiting: '等待中', countdown: '倒计时', playing: '进行中', finished: '已结束' };
const TIERS = ['青铜', '白银', '黄金', '铂金', '钻石', '王者'];
const TIER_MIN = { 青铜: 0, 白银: 1000, 黄金: 1200, 铂金: 1400, 钻石: 1600, 王者: 1800 };
const AVATARS = ['🐂', '🐻', '🐷', '🐔', '🦆', '🐸', '🐵', '🐯', '🦊', '🐼', '🦄', '👽'];
const RULES = [
  '开局每人资金相同，规定时间内总资产最高者获胜。',
  'T+1：当日买入的股票当日不能卖出。',
  '费用：佣金万 2.5（最低 5 元）+ 印花税千 0.5（卖出）+ 过户费十万分之一。',
  '主板涨跌停 ±10%，创业板 / 科创板（30 / 68 开头）±20%。',
  '限价单先吃合成流动性，未成交部分挂单排队。',
  '大额主动成交会推动股价，滑点与冲击是真金白银的成本。',
];

const avatarOf = (i) => AVATARS[((Number(i) || 0) % 12 + 12) % 12];

export function renderLobby(ctx) {
  const root = ctx.root;
  clear(root);
  const S = ctx.state;
  const offs = [];
  let destroyed = false;

  let mode = 'ffa';
  let durationSec = 900;
  let startCash = 1000000;
  let fillBots = true;

  /* 房间列表筛选状态 */
  let roomFilterMode = 'all';         // all | 1v1 | ffa | team
  let onlyJoinable = true;            // 「只看可加入」默认勾选

  /* 请求在途标记：状态刷新重建 DOM 时必须保留，否则 300ms 内可重复点击 */
  let pendingJoinId = '';             // 正在加入的房间号
  let joinTimer = 0;
  let pendingCreateReq = '';          // 正在创建房间的 reqId（等 room:joined 才提示成功）
  let createTimer = 0;

  let roomSig = '';                   // 房间面板签名
  let roomsSig = '';                  // 房间列表签名
  let meSig = '';
  let chatLen = 0;

  /* ═════════ DOM 骨架 ═════════ */

  const wrap = el('div', { class: 'v-lobby' });
  const main = el('div', { class: 'v-lobby-main' });
  const side = el('div', { class: 'v-lobby-side' });
  wrap.appendChild(main);
  wrap.appendChild(side);
  root.appendChild(wrap);

  /* ── 顶部条 ── */
  const top = el('div', { class: 'v-lobby-top' });
  const topTitle = el('div', { class: 'v-lobby-title' });
  topTitle.appendChild(el('span', { class: 'v-lobby-ico', text: '🏛' }));
  topTitle.appendChild(el('b', { text: '对战大厅' }));
  topTitle.appendChild(el('span', { class: 'dim', id: 'v-lobby-online' }));
  top.appendChild(topTitle);
  const btnRefresh = el('button', { class: 'btn btn-sm', text: '↻ 刷新列表' });
  top.appendChild(btnRefresh);
  main.appendChild(top);

  /* ── 模式卡片 ── */
  const modeRow = el('div', { class: 'v-modes' });
  const modeCards = [];
  for (const m of MODE_CARDS) {
    const card = el('div', { class: 'v-mode', dataset: { mode: m.id } });
    card.appendChild(el('div', { class: 'v-mode-ico', text: m.icon }));
    const tx = el('div', { class: 'v-mode-tx' });
    tx.appendChild(el('div', { class: 'v-mode-name', text: m.name }));
    tx.appendChild(el('div', { class: 'v-mode-desc', text: m.desc }));
    card.appendChild(tx);
    card.appendChild(el('div', { class: 'v-mode-max', text: `最多 ${m.id === '1v1' ? 2 : ((S.config && S.config.maxPlayers) || 30)} 人` }));
    card.onclick = () => { mode = m.id; syncParams(); };
    modeCards.push(card);
    modeRow.appendChild(card);
  }
  main.appendChild(modeRow);

  /* ── 参数行 ── */
  const params = el('div', { class: 'v-params' });
  function seg(label, items, getCur, onPick) {
    const box = el('div', { class: 'v-segbox' });
    box.appendChild(el('span', { class: 'v-seg-lb', text: label }));
    const seg = el('div', { class: 'v-seg' });
    const btns = items.map((it) => {
      const b = el('button', { class: 'v-seg-btn', text: it.name, dataset: { v: String(it.v) } });
      b.onclick = () => { onPick(it.v); syncParams(); };
      seg.appendChild(b);
      return b;
    });
    box.appendChild(seg);
    return { box, btns, getCur };
  }

  const segDur = seg('对局时长', DURATIONS.map((d) => ({ v: d.sec, name: d.name })), () => durationSec, (v) => { durationSec = v; });
  const segCash = seg('初始资金', CASHS.map((c) => ({ v: c.v, name: c.n })), () => startCash, (v) => { startCash = v; });

  /* 人数上限（1v1 固定 2 人，其余模式 2~30 可选） */
  const COUNT_OPTS = (S.config && S.config.playerCountOptions) || [2, 4, 6, 8, 12, 16, 20, 24, 30];
  const MAX_CAP = (S.config && S.config.maxPlayers) || 30;
  let maxPlayers = MAX_CAP;
  const segCount = seg('人数上限', COUNT_OPTS.filter((v) => v <= MAX_CAP).map((v) => ({ v, name: v + ' 人' })),
    () => maxPlayers, (v) => { maxPlayers = v; });
  params.appendChild(segDur.box);
  params.appendChild(segCash.box);
  params.appendChild(segCount.box);

  const fillBox = el('label', { class: 'v-check' });
  const fillInput = el('input', { type: 'checkbox', checked: true, id: 'v-lobby-fill-bots' });
  fillInput.onchange = () => { fillBots = !!fillInput.checked; };
  fillBox.appendChild(fillInput);
  fillBox.appendChild(el('span', { text: '人数不足时用 AI 补齐对手' }));
  params.appendChild(fillBox);
  main.appendChild(params);

  /* ── 大按钮 ── */
  const actions = el('div', { class: 'v-lobby-actions' });
  const btnQuick = el('button', { class: 'btn btn-lg btn-primary v-big' });
  btnQuick.innerHTML = '<b>⚡ 快速匹配</b><span>立刻开始一局，AI 秒补位</span>';
  const btnCreate = el('button', { class: 'btn btn-lg v-big' });
  btnCreate.innerHTML = '<b>＋ 创建房间</b><span>当房主，等别人来挑战</span>';
  actions.appendChild(btnQuick);
  actions.appendChild(btnCreate);
  main.appendChild(actions);

  /* ── 房间区（房间面板 / 房间列表 二选一） ── */
  const roomHost = el('div', { class: 'v-room-host' });
  main.appendChild(roomHost);

  const roomPanel = el('div', { class: 'panel v-room-panel hidden' });
  const roomPanelHd = el('div', { class: 'panel-hd' });
  roomPanel.appendChild(roomPanelHd);
  const roomPanelBd = el('div', { class: 'panel-bd pad v-room-body' });
  roomPanel.appendChild(roomPanelBd);
  roomHost.appendChild(roomPanel);

  const listPanel = el('div', { class: 'panel v-rooms' });
  const listHd = el('div', { class: 'panel-hd' });
  listHd.appendChild(el('span', { text: '房间列表' }));
  /* 面板头轻量控件：只看可加入 + 模式筛选（复用 .panel-hd / .hd-right / .v-check / .select） */
  const listTools = el('span', { class: 'hd-right' });
  const onlyBox = el('label', { class: 'v-check', title: '只显示还能加入的房间' });
  const onlyInput = el('input', { type: 'checkbox', checked: true, id: 'v-room-only-joinable' });
  onlyInput.onchange = () => { onlyJoinable = !!onlyInput.checked; roomsSig = ''; updateRooms(); };
  onlyBox.appendChild(onlyInput);
  onlyBox.appendChild(el('span', { text: '只看可加入' }));
  const modeFilter = el('select', { class: 'select', id: 'v-room-filter-mode', title: '按模式筛选房间' });
  for (const f of MODE_FILTERS) modeFilter.appendChild(el('option', { value: f.v, text: f.n }));
  modeFilter.value = roomFilterMode;
  modeFilter.onchange = () => { roomFilterMode = modeFilter.value || 'all'; roomsSig = ''; updateRooms(); };
  const listCount = el('span', { class: 'dim', id: 'v-room-count' });
  listTools.appendChild(onlyBox);
  listTools.appendChild(modeFilter);
  listTools.appendChild(listCount);
  listHd.appendChild(listTools);
  listPanel.appendChild(listHd);
  const listBd = el('div', { class: 'panel-bd scroll' });
  listPanel.appendChild(listBd);
  roomHost.appendChild(listPanel);

  /* ── 右侧：我的战绩 ── */
  const mePanel = el('div', { class: 'panel v-me' });
  const meHd = el('div', { class: 'panel-hd' });
  meHd.appendChild(el('span', { text: '我的战绩' }));
  mePanel.appendChild(meHd);
  const meBd = el('div', { class: 'panel-bd pad v-me-bd' });
  mePanel.appendChild(meBd);
  side.appendChild(mePanel);

  /* ── 右侧：聊天 ── */
  const chatPanel = el('div', { class: 'panel v-chat' });
  const chatHd = el('div', { class: 'panel-hd' });
  chatHd.appendChild(el('span', { text: '房间聊天' }));
  chatHd.appendChild(el('span', { class: 'hd-right dim', text: 'Enter 发送' }));
  chatPanel.appendChild(chatHd);
  const chatBd = el('div', { class: 'panel-bd scroll v-chat-bd' });
  chatPanel.appendChild(chatBd);
  const chatFt = el('div', { class: 'v-chat-ft' });
  const chatInput = el('input', { class: 'input', type: 'text', maxlength: '120', placeholder: '说点什么…（如：冲！）' });
  const chatSend = el('button', { class: 'btn btn-sm', text: '发送' });
  chatFt.appendChild(chatInput);
  chatFt.appendChild(chatSend);
  chatPanel.appendChild(chatFt);
  side.appendChild(chatPanel);

  /* ── 右侧：规则 ── */
  const rulePanel = el('div', { class: 'panel v-rules' });
  const ruleHd = el('div', { class: 'panel-hd' });
  ruleHd.appendChild(el('span', { text: '玩法规则' }));
  rulePanel.appendChild(ruleHd);
  const ruleBd = el('div', { class: 'panel-bd pad' });
  const ol = el('ol', { class: 'v-rule-list' });
  for (const r of RULES) ol.appendChild(el('li', { text: r }));
  ruleBd.appendChild(ol);
  rulePanel.appendChild(ruleBd);
  side.appendChild(rulePanel);

  /* ═════════ 更新逻辑 ═════════ */

  function syncParams() {
    for (const c of modeCards) c.classList.toggle('sel', c.dataset.mode === mode);
    for (const b of segDur.btns) b.classList.toggle('sel', Number(b.dataset.v) === durationSec);
    for (const b of segCash.btns) b.classList.toggle('sel', Number(b.dataset.v) === startCash);
    for (const b of segCount.btns) b.classList.toggle('sel', Number(b.dataset.v) === maxPlayers);
    segCount.box.classList.toggle('hidden', mode === '1v1');   // 1v1 固定 2 人
    fillInput.checked = fillBots;
  }

  /** 本次下单实际生效的人数上限（1v1 固定 2 人） */
  function effectiveMaxPlayers() { return mode === '1v1' ? 2 : maxPlayers; }

  function clearPendingJoin() {
    pendingJoinId = '';
    if (joinTimer) { clearTimeout(joinTimer); joinTimer = 0; }
  }

  function updateMe() {
    const p = S.player;
    const online = Number.isFinite(Number(S.online)) ? Number(S.online) : 1;   // 0 也要如实显示
    const onlineEl = top.querySelector('#v-lobby-online');
    if (onlineEl) {
      /* 数据源以 ctx.state.source 为准（'real' | 'mock'），不能写死 */
      const isReal = S.source === 'real';
      onlineEl.textContent = `在线 ${online} 人 · 数据源：${isReal ? '真实服务端' : '本地 Mock'}`;
      onlineEl.dataset.source = isReal ? 'real' : 'mock';
    }
    if (!p) {
      meSig = '';
      clear(meBd);
      meBd.appendChild(el('div', { class: 'empty', html: '<div class="ico">👤</div><div>尚未登录</div>' }));
      return;
    }
    const sig = [p.nick, p.elo, p.tier, p.wins, p.losses, p.games, (S.rank || []).length].join('|');
    if (sig === meSig) return;
    meSig = sig;

    const tier = p.tier || '青铜';
    const idx = Math.max(0, TIERS.indexOf(tier));
    const next = TIERS[idx + 1];
    const lo = TIER_MIN[tier] || 0;
    const hi = next ? TIER_MIN[next] : 2000;
    const prog = Math.max(0, Math.min(1, (p.elo - lo) / Math.max(1, hi - lo)));
    const games = p.games || (p.wins + p.losses) || 0;
    const winRate = games ? (p.wins || 0) / games : 0;

    clear(meBd);
    const head = el('div', { class: 'v-me-head' });
    head.appendChild(el('div', { class: 'v-me-ava', text: avatarOf(p.avatar) }));
    const hi2 = el('div', { class: 'v-me-hi' });
    hi2.appendChild(el('div', { class: 'v-me-nick', text: p.nick }));
    const badges = el('div', { class: 'v-me-badges' });
    badges.appendChild(el('span', { class: 'tag tag-warn v-tier-' + tier, text: tier }));
    badges.appendChild(el('span', { class: 'tag', text: 'ELO ' + p.elo }));
    hi2.appendChild(badges);
    head.appendChild(hi2);
    meBd.appendChild(head);

    const bar = el('div', { class: 'v-prog' });
    const inner = el('div', { class: 'v-prog-in', style: { width: (prog * 100).toFixed(1) + '%' } });
    bar.appendChild(inner);
    meBd.appendChild(bar);
    meBd.appendChild(el('div', { class: 'v-prog-tx dim', text: next ? `${tier} → ${next}（还差 ${Math.max(0, hi - p.elo)} 分）` : '已是最高段位：王者' }));

    const stats = el('div', { class: 'v-me-stats' });
    const cell = (k, v, cls) => {
      const c = el('div', { class: 'v-cell' });
      c.appendChild(el('b', { class: cls || '', text: String(v) }));
      c.appendChild(el('span', { class: 'dim', text: k }));
      return c;
    };
    stats.appendChild(cell('胜', p.wins || 0, 'up'));
    stats.appendChild(cell('负', p.losses || 0, 'down'));
    stats.appendChild(cell('胜率', (winRate * 100).toFixed(0) + '%'));
    stats.appendChild(cell('场次', games));
    meBd.appendChild(stats);

    const top3 = (S.rank || []).slice(0, 3);
    if (top3.length) {
      meBd.appendChild(el('div', { class: 'subhd', text: '本局排行 TOP3' }));
      for (const [i, r] of top3.entries()) {
        const row = el('div', { class: 'kv v-rank-line' + (r.isMe ? ' me' : '') });
        row.appendChild(el('span', { class: 'k', text: `#${i + 1} ${r.nick}` }));
        row.appendChild(el('span', { class: 'v ' + ((r.returnPct || 0) >= 0 ? 'up' : 'down'), text: (r.returnPct >= 0 ? '+' : '') + ((r.returnPct || 0) * 100).toFixed(2) + '%' }));
        meBd.appendChild(row);
      }
    }
  }

  function updateChat() {
    const list = S.chat || [];
    if (list.length === chatLen) return;
    const stick = chatBd.scrollHeight - chatBd.scrollTop - chatBd.clientHeight < 30;
    if (list.length < chatLen) { clear(chatBd); chatLen = 0; }
    for (let i = chatLen; i < list.length; i++) {
      const m = list[i];
      const row = el('div', { class: 'v-chat-row' + (m.system ? ' sys' : '') });
      row.appendChild(el('span', { class: 'v-chat-t', text: fmtTime(m.time || Date.now()).slice(0, 5) }));
      row.appendChild(el('b', { class: 'v-chat-n', text: m.nick || '系统' }));
      row.appendChild(el('span', { class: 'v-chat-x', text: m.text || '' }));
      chatBd.appendChild(row);
    }
    chatLen = list.length;
    while (chatBd.childNodes.length > 200) chatBd.removeChild(chatBd.firstChild);
    if (stick) chatBd.scrollTop = chatBd.scrollHeight;
  }

  /* ── 房间列表：可加入判定 / 筛选 / 排序 ── */

  const isFull = (r) => Number(r && r.playerCount || 0) >= Number(r && r.maxPlayers || 0);
  const canJoin = (r) => !!r && r.status === 'waiting' && !isFull(r);

  /** 筛选 + 排序：可加入优先 → 人数多的优先 → 房间号 */
  function visibleRooms() {
    const all = (S.lobby && S.lobby.rooms) || [];
    const list = all.filter((r) => {
      if (onlyJoinable && !canJoin(r)) return false;
      if (roomFilterMode !== 'all' && r.mode !== roomFilterMode) return false;
      return true;
    });
    return list.slice().sort((a, b) => {
      const ca = canJoin(a) ? 0 : 1, cb = canJoin(b) ? 0 : 1;
      if (ca !== cb) return ca - cb;
      const pa = Number(a.playerCount || 0), pb = Number(b.playerCount || 0);
      if (pa !== pb) return pb - pa;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  /** 列表状态标签：进行中 / 倒计时 / 已满 都不可加入 */
  function roomStatusTag(r) {
    if (r.status === 'playing') return { text: '战斗中', cls: 'tag-warn' };
    if (r.status === 'countdown') return { text: '即将开始', cls: 'tag-warn' };
    if (r.status === 'finished') return { text: '已结束', cls: '' };
    if (isFull(r)) return { text: '已满', cls: 'tag-warn' };
    return { text: STATUS_NAME[r.status] || r.status || '等待中', cls: 'tag-blue' };
  }

  /** 不可加入时按钮文案 */
  function blockedText(r) {
    if (r.status === 'playing') return '战斗中';
    if (r.status === 'countdown') return '即将开始';
    if (r.status === 'finished') return '已结束';
    if (isFull(r)) return '已满';
    return '不可加入';
  }

  function blockedTitle(r) {
    if (r.status === 'playing') return '该房间已经开打，无法中途加入';
    if (r.status === 'countdown') return '该房间正在倒计时开局，无法加入';
    if (r.status === 'finished') return '该房间对局已结束';
    if (isFull(r)) return `房间已满（${r.playerCount}/${r.maxPlayers}），等下一局吧`;
    return '该房间当前不可加入';
  }

  function updateRooms() {
    const all = (S.lobby && S.lobby.rooms) || [];
    const rooms = visibleRooms();
    onlyInput.checked = onlyJoinable;
    modeFilter.value = roomFilterMode;

    const sig = [
      all.length, roomFilterMode, onlyJoinable ? 1 : 0, pendingJoinId,
      rooms.map((r) => [r.id, r.playerCount, r.maxPlayers, r.status, r.mode, r.durationSec, r.startCash, r.hostNick].join(',')).join(';'),
    ].join('|');
    if (sig === roomsSig) return;
    roomsSig = sig;

    listCount.textContent = all.length ? `${rooms.length}/${all.length} 个房间` : '';
    clear(listBd);

    if (!rooms.length) {
      const empty = el('div', { class: 'empty' });
      empty.innerHTML = all.length
        ? '<div class="ico">🔍</div><div>没有符合条件的房间</div><div class="dim">换个模式筛选，或取消勾选「只看可加入」</div>'
        : '<div class="ico">🛋</div><div>暂时没有可加入的房间</div><div class="dim">点「创建房间」当房主，或直接「快速匹配」</div>';
      listBd.appendChild(empty);
      return;
    }

    const table = el('table', { class: 'tbl striped v-room-tbl' });
    const thead = el('thead');
    const tr = el('tr');
    for (const [t, cls] of [['房间号', 'l'], ['房主', 'l'], ['模式', 'l'], ['人数', ''], ['状态', ''], ['时长', ''], ['初始资金', ''], ['操作', 'c']]) {
      const th = el('th', { class: cls, text: t });
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);

    const tb = el('tbody');
    for (const room of rooms) {
      const r = el('tr', { dataset: { roomId: room.id } });
      r.appendChild(el('td', { class: 'l code', text: room.id }));
      r.appendChild(el('td', { class: 'l', text: room.hostNick || '—' }));
      r.appendChild(el('td', { class: 'l', text: MODE_NAME[room.mode] || room.mode }));
      r.appendChild(el('td', { class: 'num', text: `${room.playerCount}/${room.maxPlayers}` }));
      const tag = roomStatusTag(room);
      const st = el('td', { class: 'c' });
      st.appendChild(el('span', { class: 'tag ' + tag.cls, text: tag.text }));
      r.appendChild(st);
      r.appendChild(el('td', { class: 'num', text: (room.durationSec / 60) + ' 分钟' }));
      r.appendChild(el('td', { class: 'num', text: fmtMoney(room.startCash) }));

      const op = el('td', { class: 'c' });
      const join = el('button', { class: 'btn btn-sm btn-primary', text: '加入' });
      join.dataset.roomId = room.id;
      if (!canJoin(room)) {
        /* 满员 / 进行中 → 置灰，不可点击 */
        join.disabled = true;
        join.classList.remove('btn-primary');
        join.textContent = blockedText(room);
        join.title = blockedTitle(room);
      } else if (pendingJoinId === room.id) {
        /* 在途请求：状态刷新重建后依然禁用 */
        join.disabled = true;
        join.textContent = '加入中…';
        join.title = '正在请求加入，请稍候…';
      } else {
        join.title = `加入房间 ${room.id}`;
        join.onclick = (e) => {
          e.stopPropagation();
          pendingJoinId = room.id;
          join.disabled = true;
          join.textContent = '加入中…';
          ctx.net.send('room:join', { roomId: room.id, reqId: uid('j') });
          roomsSig = '';                       // 立刻重建，让「加入中…」落地
          updateRooms();
          if (joinTimer) clearTimeout(joinTimer);
          joinTimer = setTimeout(() => {       // 兜底：8s 无应答则解除
            if (pendingJoinId === room.id) { clearPendingJoin(); roomsSig = ''; updateRooms(); }
          }, 8000);
        };
      }
      op.appendChild(join);
      r.appendChild(op);
      tb.appendChild(r);
    }
    table.appendChild(tb);
    listBd.appendChild(table);
  }

  function btn(text, cls, fn) {
    const b = el('button', { class: 'btn ' + (cls || ''), text });
    b.onclick = fn;
    return b;
  }

  function updateRoom() {
    const room = S.room;
    const has = !!room && room.status !== 'finished' && room.status !== 'playing';
    roomPanel.classList.toggle('hidden', !has);
    listPanel.classList.toggle('hidden', has);
    if (!has) { roomSig = ''; return; }

    const sig = [room.id, room.status, room.countdown, room.hostId, room.players.map((p) => p.id + (p.ready ? '1' : '0')).join('')].join('|');
    if (sig === roomSig) return;
    roomSig = sig;

    clear(roomPanelHd);
    roomPanelHd.appendChild(el('span', { text: `房间 ${room.id} · ${room.name || ''}` }));
    const right = el('span', { class: 'hd-right' });
    right.appendChild(el('span', { class: 'tag ' + (room.status === 'countdown' ? 'tag-warn' : 'tag-blue'), text: STATUS_NAME[room.status] || room.status }));
    roomPanelHd.appendChild(right);

    clear(roomPanelBd);

    if (room.status === 'countdown') {
      const cd = el('div', { class: 'v-countdown' });
      cd.appendChild(el('div', { class: 'v-cd-num', text: String(room.countdown || 1) }));
      cd.appendChild(el('div', { class: 'v-cd-tx', text: '对局即将开始，准备好你的第一笔委托…' }));
      roomPanelBd.appendChild(cd);
    }

    const meta = el('div', { class: 'v-room-meta' });
    const kv = (k, v) => {
      const d = el('div', { class: 'v-room-kv' });
      d.appendChild(el('span', { class: 'dim', text: k }));
      d.appendChild(el('b', { text: v }));
      return d;
    };
    meta.appendChild(kv('模式', MODE_NAME[room.mode] || room.mode));
    meta.appendChild(kv('时长', (room.durationSec / 60) + ' 分钟'));
    meta.appendChild(kv('初始资金', fmtMoney(room.startCash)));
    meta.appendChild(kv('人数', `${room.players.length}/${room.maxPlayers}`));
    meta.appendChild(kv('AI 补齐', room.fillBots ? '开' : '关'));
    roomPanelBd.appendChild(meta);

    const isHost = !!(room.hostId && S.player && room.hostId === S.player.id);
    const grid = el('div', { class: 'v-players' });
    for (const p of room.players) {
      const card = el('div', { class: 'v-player' + (p.isBot ? ' bot' : '') + (p.id === (S.player && S.player.id) ? ' me' : '') + (p.ready ? ' ready' : '') });
      card.appendChild(el('div', { class: 'v-pl-ava', text: avatarOf(p.avatar) }));
      const tx = el('div', { class: 'v-pl-tx' });
      const line = el('div', { class: 'v-pl-nick' });
      line.appendChild(el('span', { text: p.nick }));
      if (p.isHost) line.appendChild(el('span', { class: 'v-crown', text: '👑', title: '房主' }));
      if (p.isBot) line.appendChild(el('span', { class: 'tag', text: 'AI' }));
      tx.appendChild(line);
      tx.appendChild(el('div', { class: 'v-pl-sub dim', text: `${p.tier || '青铜'} · ${p.elo || 1000}` }));
      card.appendChild(tx);
      card.appendChild(el('div', { class: 'v-pl-ready ' + (p.ready ? 'on' : ''), text: p.ready ? '已准备' : '未准备' }));
      /* 房主可以把非房主成员移出房间（服务端需实现 room:kick） */
      if (isHost && !p.isHost) {
        const kick = el('button', { class: 'btn btn-sm v-kick', text: '移出', title: `把 ${p.nick} 移出房间` });
        kick.dataset.playerId = p.id;
        kick.onclick = async (ev) => {
          ev.stopPropagation();
          const ok = await confirmBox({
            title: '移出玩家',
            body: `确定把 <span class="hl">${escapeHtml(p.nick)}</span>${p.isBot ? '（AI）' : ''} 移出房间吗？`,
            okText: '移出',
            danger: true,
          });
          if (!ok) return;
          ctx.net.send('room:kick', { playerId: p.id, reqId: uid('k') });
        };
        card.appendChild(kick);
      }
      grid.appendChild(card);
    }
    roomPanelBd.appendChild(grid);

    const ops = el('div', { class: 'v-room-ops' });
    const me = room.players.find((p) => S.player && p.id === S.player.id);
    if (room.status === 'waiting') {
      ops.appendChild(btn(me && me.ready ? '取消准备' : '准备', 'v-ready-btn', () => ctx.net.send('room:ready', { ready: !(me && me.ready) })));
      if (isHost) ops.appendChild(btn('▶ 开始对局', 'btn-primary', () => ctx.net.send('room:start', {})));
      if (!isHost) ops.appendChild(el('span', { class: 'dim', text: '等待房主开始对局…' }));
    }
    ops.appendChild(btn('离开房间', '', () => ctx.net.send('room:leave', {})));
    roomPanelBd.appendChild(ops);
  }

  function updateAll() {
    if (destroyed) return;
    updateMe();
    updateChat();
    updateRooms();
    updateRoom();
  }

  /* ═════════ 事件 ═════════ */

  btnRefresh.onclick = () => ctx.net.send('lobby:list', {});

  /** 快速匹配：必须带上 UI 选中的 maxPlayers 与 fillBots（1v1 固定 2 人） */
  btnQuick.onclick = () => {
    const mp = effectiveMaxPlayers();
    const fill = !!fillBots;
    ctx.net.send('room:quick', { mode, durationSec, startCash, maxPlayers: mp, fillBots: fill });
    const bits = [
      MODE_NAME[mode] || mode,
      `${durationSec / 60} 分钟`,
      fmtMoney(startCash),
      `上限 ${mp} 人`,
      fill ? '人数不足用 AI 补齐' : '不用 AI 补齐，人数不足就继续等真人',
    ];
    ctx.toast(`正在快速匹配（${bits.join(' · ')}）…`, 'info');
  };

  /** 创建房间：先 info，等 room:joined 再报成功（失败由服务端 error 提示） */
  btnCreate.onclick = () => {
    const reqId = uid('c');
    pendingCreateReq = reqId;
    ctx.net.send('room:create', {
      name: `${(S.player && S.player.nick) || '我'}的房`,
      mode, maxPlayers: effectiveMaxPlayers(),
      durationSec, startCash, fillBots, reqId,
    });
    ctx.toast('正在创建房间…', 'info');
    if (createTimer) clearTimeout(createTimer);
    createTimer = setTimeout(() => { if (pendingCreateReq === reqId) pendingCreateReq = ''; }, 15000);
  };

  function sendChat() {
    const t = String(chatInput.value || '').trim();
    if (!t) return;
    chatInput.value = '';
    ctx.net.send('room:chat', { text: t });
  }
  chatSend.onclick = sendChat;
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });

  offs.push(ctx.on('lobby:rooms', () => { roomsSig = ''; updateRooms(); }));
  offs.push(ctx.on('login_ok', () => { meSig = ''; updateMe(); }));
  offs.push(ctx.on('welcome', () => { meSig = ''; updateMe(); }));
  offs.push(ctx.on('chat', () => updateChat()));
  offs.push(ctx.on('room:joined', (m) => {
    clearPendingJoin();                                  // 「加入中…」解除
    if (pendingCreateReq && (!m || !m.reqId || m.reqId === pendingCreateReq)) {
      pendingCreateReq = '';                             // 服务端确认后才提示创建成功
      if (createTimer) { clearTimeout(createTimer); createTimer = 0; }
      ctx.toast('房间已创建，等待对手加入…', 'success');
    }
    roomsSig = ''; roomSig = '';
    updateRoom(); updateRooms();
  }));
  offs.push(ctx.on('room:update', () => { roomSig = ''; updateRoom(); updateMe(); }));
  offs.push(ctx.on('room:left', () => { clearPendingJoin(); roomSig = ''; roomsSig = ''; updateRoom(); updateRooms(); ctx.net.send('lobby:list', {}); }));
  offs.push(ctx.on('error', (m) => {
    if (pendingCreateReq && (!m || !m.reqId || m.reqId === pendingCreateReq)) {
      pendingCreateReq = '';
      if (createTimer) { clearTimeout(createTimer); createTimer = 0; }
    }
    if (pendingJoinId) { clearPendingJoin(); roomsSig = ''; updateRooms(); }
  }));
  offs.push(ctx.on('rank', () => updateMe()));
  offs.push(ctx.onState(() => updateAll()));

  /* 首次进入主动拉一次房间列表 */
  if (!((S.lobby && S.lobby.rooms) || []).length) ctx.net.send('lobby:list', {});

  syncParams();
  updateAll();

  return {
    destroy() {
      destroyed = true;
      clearPendingJoin();
      if (createTimer) { clearTimeout(createTimer); createTimer = 0; }
      for (const off of offs) { try { off(); } catch (e) { /* ignore */ } }
      offs.length = 0;
      clear(root);
    },
  };
}

export default renderLobby;
