/* ═══════════════════════════════════════════════════════════
   同花亏 · order-form.js —— 下单面板（买入/卖出、价格/数量、仓位快捷）
   接口：createOrderForm(host, ctx) → { update(), destroy() }
   约定：
   · 方向与 state.ui.orderSide 双向同步（点击页签 / B/S 键 / ctx.root 事件）
   · 只做本地校验与预估，不做撮合；提交走 ctx.net.send('order:place', …)
   · 键盘监听、custom event 监听全部在 destroy() 中移除
   ═══════════════════════════════════════════════════════════ */
import { el, clear, on, uid, round2, escapeHtml, confirmBox,
         fmtNum, fmtPrice } from '../util.js';
import { patchUi, position, derived } from '../store.js';

export function createOrderForm(host, ctx) {
  const state = ctx.state;
  const offs = [];
  clear(host);
  host.classList.add('panel', 'tr-form');

  /* ── 状态 ── */
  let autoPrice = true;      // 价格是否仍为"对手价"自动值
  let lastFocusAt = 0;       // 已消费的 focusOrderAt 标记
  let lastStock = null;
  let lastSide = null;

  /* ── DOM 骨架（只建一次） ── */
  const hdCode = el('span', { class: 'hd-right dim', text: '--' });
  const hd = el('div', { class: 'panel-hd' }, '下单', hdCode);

  const btnBuy = el('button', { class: 'tr-side-btn buy active', type: 'button', text: '买入' });
  const btnSell = el('button', { class: 'tr-side-btn sell', type: 'button', text: '卖出' });
  const sideBar = el('div', { class: 'tr-side' }, btnBuy, btnSell);

  const vCash = el('span', { class: 'v', text: '--' });
  const vAssets = el('span', { class: 'v', text: '--' });
  const vMv = el('span', { class: 'v', text: '--' });
  const vPos = el('span', { class: 'v', text: '--' });
  const fr = (k, v) => el('div', { class: 'tr-fr' }, el('span', { class: 'k', text: k }), v);

  const codeIn = el('input', { class: 'input', type: 'text', readonly: true, tabindex: '-1' });
  const lblPrice = el('span', { class: 'lbl', text: '买入价格' });
  const priceIn = el('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off' });
  const pMinus = el('button', { type: 'button', text: '−', title: '-0.01' });
  const pPlus = el('button', { type: 'button', text: '＋', title: '+0.01' });
  const priceStep = el('div', { class: 'stepper' }, pMinus, priceIn, pPlus);

  const lblQty = el('span', { class: 'lbl', text: '买入数量' });
  const qtyIn = el('input', { class: 'input', type: 'text', inputmode: 'numeric', autocomplete: 'off' });
  const qMinus = el('button', { type: 'button', text: '−', title: '-100 股' });
  const qPlus = el('button', { type: 'button', text: '＋', title: '+100 股' });
  const qtyStep = el('div', { class: 'stepper tr-step-qty' }, qMinus, qtyIn, qPlus);
  const hint = el('span', { class: 'tr-hint', text: '' });

  const qUp = el('button', { class: 'btn btn-sm', type: 'button', text: '涨停' });
  const qDown = el('button', { class: 'btn btn-sm', type: 'button', text: '跌停' });
  const qBid = el('button', { class: 'btn btn-sm', type: 'button', text: '买一' });
  const qAsk = el('button', { class: 'btn btn-sm', type: 'button', text: '卖一' });
  const quick = el('div', { class: 'tr-quick' }, qUp, qDown, qBid, qAsk);

  const pickBtns = [['1/4', 0.25], ['1/3', 1 / 3], ['1/2', 0.5], ['全仓', 1]].map(([t, f]) => {
    const b = el('button', { class: 'btn btn-sm', type: 'button', text: t, title: '按可用资金/可卖持仓取整手' });
    b.onclick = () => pickPosition(f);
    return b;
  });
  const picks = el('div', { class: 'tr-picks' }, pickBtns);

  const errEl = el('div', { class: 'tr-err', text: '' });
  const submitBtn = el('button', { class: 'btn btn-lg btn-buy tr-submit', type: 'button', text: '买入' });

  const funds = el('div', { class: 'tr-form-funds' },
    fr('可用资金', vCash), fr('总资产', vAssets), fr('持仓市值', vMv), fr('总持仓/可用', vPos));

  const btnRow = el('div', { class: 'tr-btnrow' }, quick, picks);

  const bd = el('div', { class: 'panel-bd tr-form-bd' },
    funds,
    el('div', { class: 'tr-field' }, el('span', { class: 'lbl', text: '证券代码' }), codeIn),
    el('div', { class: 'tr-field' }, lblPrice, priceStep),
    btnRow,
    el('div', { class: 'tr-field' }, lblQty, qtyStep, hint),
    errEl,
    submitBtn);

  host.appendChild(hd);
  host.appendChild(sideBar);
  host.appendChild(bd);

  /* ═══════════ 基础计算（仅本地预估，绝不代替服务端） ═══════════ */
  function feeCfg() {
    const f = (state.config && state.config.fee) || {};
    return {
      commissionRate: f.commissionRate != null ? f.commissionRate : 0.00025,
      commissionMin: f.commissionMin != null ? f.commissionMin : 5,
      stampTax: f.stampTax != null ? f.stampTax : 0.0005,
      transferFee: f.transferFee != null ? f.transferFee : 0.00001,
    };
  }
  function available() {
    const a = state.account;
    if (!a) return 0;
    return Number(a.available != null ? a.available : a.cash) || 0;
  }
  function buyCost(price, qty) {
    const f = feeCfg();
    const amount = price * qty;
    return amount + Math.max(amount * f.commissionRate, f.commissionMin) + amount * f.transferFee;
  }
  function sellNet(price, qty) {
    const f = feeCfg();
    const amount = price * qty;
    return amount - Math.max(amount * f.commissionRate, f.commissionMin)
      - amount * f.stampTax - amount * f.transferFee;
  }
  function maxBuyQty(price) {
    const avail = available();
    if (!(price > 0) || avail <= 0) return 0;
    let lots = Math.floor(avail / (price * 100));
    while (lots > 0 && buyCost(price, lots * 100) > avail) lots -= 1;
    return Math.max(0, lots) * 100;
  }
  function cur() {
    const id = state.ui.stockId;
    return { id, meta: id ? state.stocks.get(id) : null, d: id ? derived(id) : null };
  }
  function curSide() { return state.ui.orderSide === 'sell' ? 'sell' : 'buy'; }
  function limits(meta, d) {
    /* d 来自实时行情（derived 展开 tick 报价），优先用它：
       日切后 meta 里的值可能还没同步到，用它会误判超涨停而拒绝委托 */
    let up = d && d.limitUp != null ? Number(d.limitUp)
      : meta && meta.limitUp != null ? Number(meta.limitUp) : null;
    let down = d && d.limitDown != null ? Number(d.limitDown)
      : meta && meta.limitDown != null ? Number(meta.limitDown) : null;
    if (up == null || down == null) {
      const pc = (d && d.prevClose) || (meta && meta.prevClose) || 0;
      const cfg = state.config || {};
      const code = String((meta && meta.id) || '');
      const pct = (code.indexOf('30') === 0 || code.indexOf('68') === 0)
        ? (cfg.limitPct20 != null ? cfg.limitPct20 : 0.2)
        : (cfg.limitPct != null ? cfg.limitPct : 0.1);
      if (pc > 0) { up = round2(pc * (1 + pct)); down = round2(pc * (1 - pct)); }
    }
    return { up, down };
  }
  function counterPrice(side, d) {
    if (!d) return 0;
    if (side === 'buy') return (d.s && d.s[0] && d.s[0][0]) || d.p || 0;
    return (d.b && d.b[0] && d.b[0][0]) || d.p || 0;
  }
  function readPrice() {
    const v = parseFloat(priceIn.value);
    return Number.isFinite(v) ? round2(v) : NaN;
  }
  function readQty() {
    const v = parseInt(String(qtyIn.value).replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(v) ? v : NaN;
  }

  /* ═══════════ 本地校验（即时红字提示） ═══════════ */
  function validate() {
    const { id, meta, d } = cur();
    if (!id || !meta) return '请先在左侧行情列表中选择股票';
    const side = curSide();
    const price = readPrice();
    const qty = readQty();
    const { up, down } = limits(meta, d);
    if (!Number.isFinite(price) || price <= 0) return '请输入有效的委托价格';
    if (up != null && price > up + 1e-6) return '委托价高于涨停价 ' + fmtPrice(up) + '，将被拒单';
    if (down != null && price < down - 1e-6) return '委托价低于跌停价 ' + fmtPrice(down) + '，将被拒单';
    if (!Number.isFinite(qty) || qty <= 0) return '请输入委托数量';
    if (qty % 100 !== 0) return '委托数量必须是 100 股（1 手）的整数倍';
    if (side === 'buy') {
      const cost = buyCost(price, qty);
      if (cost > available() + 1e-6) {
        const mx = maxBuyQty(price);
        return '可用资金不足：需 ' + fmtNum(cost, 2) + ' 元，最多可买 ' + mx + ' 股 / ' + (mx / 100) + ' 手';
      }
    } else {
      const p = position(id);
      const av = p ? Number(p.avail) || 0 : 0;
      if (qty > av) return '可用持仓不足（T+1）：当前可卖 ' + av + ' 股 / ' + (av / 100) + ' 手';
    }
    return '';
  }

  function setText(node, s) { if (node.textContent !== s) node.textContent = s; }
  function refreshErr() { setText(errEl, validate()); }

  /* ═══════════ 方向同步 ═══════════ */
  function syncSide(side) {
    btnBuy.className = 'tr-side-btn buy' + (side === 'buy' ? ' active' : '');
    btnSell.className = 'tr-side-btn sell' + (side === 'sell' ? ' active' : '');
    lblPrice.textContent = side === 'buy' ? '买入价格' : '卖出价格';
    lblQty.textContent = side === 'buy' ? '买入数量' : '卖出数量';
    submitBtn.className = 'btn btn-lg tr-submit ' + (side === 'buy' ? 'btn-buy' : 'btn-sell');
    submitBtn.textContent = side === 'buy' ? '买入' : '卖出';
    submitBtn.title = side === 'buy' ? '买入（Enter）' : '卖出（Enter）';
  }
  function switchSide(side) {
    if (state.ui.orderSide === side) return;
    patchUi({ orderSide: side });
    update();
  }

  /* ═══════════ 更新（每秒 1 次 tick 调用，只改文本，不碰焦点） ═══════════ */
  function update() {
    const { id, meta, d } = cur();
    const side = curSide();
    const p = id ? position(id) : null;
    const acc = state.account;

    syncSide(side);
    setText(hdCode, id ? (id + ' ' + ((meta && meta.name) || '')) : '--');
    setText(vCash, acc ? fmtNum(acc.available != null ? acc.available : acc.cash, 2) : '--');
    setText(vAssets, acc ? fmtNum(acc.totalAssets, 2) : '--');
    setText(vMv, acc ? fmtNum(acc.marketValue, 2) : '--');
    setText(vPos, p ? (p.qty + ' / ' + p.avail) : '0 / 0');

    if (codeIn.value !== (id || '')) codeIn.value = id || '';

    /* 工具栏/菜单点「买入/卖出」时（main.js 写 focusOrderAt）把焦点落到价格输入框，
       让用户可以直接敲价格——以前这里什么都没有，点了没有任何可见反馈。 */
    if (state.ui.focusOrderAt && state.ui.focusOrderAt !== lastFocusAt) {
      lastFocusAt = state.ui.focusOrderAt;
      setTimeout(() => {
        try {
          if (document.activeElement !== priceIn) { priceIn.focus(); priceIn.select(); }
        } catch (e) { /* ignore */ }
      }, 0);
    }

    /* 切换股票：重置价格（对手价）与数量；切换方向：仅刷新对手价 */
    if (id !== lastStock) {
      lastStock = id; lastSide = side; autoPrice = true;
      const cp = counterPrice(side, d);
      if (cp > 0 && document.activeElement !== priceIn) priceIn.value = fmtPrice(cp);
      qtyIn.value = '100';
    } else if (side !== lastSide) {
      lastSide = side;
      if (autoPrice) {
        const cp = counterPrice(side, d);
        if (cp > 0 && document.activeElement !== priceIn) priceIn.value = fmtPrice(cp);
      }
    }
    /* 首次渲染可能早于行情到达：行情一到就把空的委托价补成对手价 */
    if (!priceIn.value.trim() && document.activeElement !== priceIn) {
      const cp2 = counterPrice(side, d);
      if (cp2 > 0) priceIn.value = fmtPrice(cp2);
    }

    /* 最多可买/可卖 */
    if (side === 'buy') {
      const mx = maxBuyQty(readPrice());
      setText(hint, '最多可买 ' + mx + ' 股 / ' + (mx / 100) + ' 手');
    } else {
      const av = p ? Number(p.avail) || 0 : 0;
      setText(hint, '最多可卖 ' + av + ' 股 / ' + (av / 100) + ' 手');
    }

    refreshErr();
  }

  /* ═══════════ 提交 ═══════════ */
  async function submit() {
    const msg = validate();
    if (msg) { setText(errEl, msg); ctx.toast(msg, 'warn'); return; }
    const { id, meta } = cur();
    const side = curSide();
    const price = readPrice();
    const qty = readQty();
    if (state.ui.confirmOrder) {
      const f = feeCfg();
      const amount = price * qty;
      const comm = Math.max(amount * f.commissionRate, f.commissionMin);
      const tax = side === 'sell' ? amount * f.stampTax : 0;
      const transfer = amount * f.transferFee;
      const net = side === 'buy' ? amount + comm + transfer : sellNet(price, qty);
      const kv = (k, v) => '<div class="kv"><span class="k">' + escapeHtml(k) +
        '</span><span class="v">' + escapeHtml(v) + '</span></div>';
      const body = '<div class="tr-cf">' +
        kv('证券', id + ' ' + ((meta && meta.name) || '')) +
        kv('方向', side === 'buy' ? '买入' : '卖出') +
        kv('委托价', fmtPrice(price) + ' 元') +
        kv('委托量', qty + ' 股（' + (qty / 100) + ' 手）') +
        kv('成交金额', fmtNum(amount, 2) + ' 元') +
        kv('预估费用', fmtNum(comm + tax + transfer, 2) + ' 元') +
        kv(side === 'buy' ? '预计支出' : '预计收入', fmtNum(net, 2) + ' 元') +
        '</div>';
      const ok = await confirmBox({
        title: '委托确认', body,
        okText: side === 'buy' ? '确认买入' : '确认卖出',
        cancelText: '取消', danger: side,
      });
      if (!ok) return;
    }
    ctx.net.send('order:place', {
      stockId: id, side, type: 'limit', price, qty, reqId: uid('o'),
    });
  }

  /* ═══════════ AI 诊股「按建议填单」接管 ═══════════
     AI 面板把 side/price/pct 通过 CustomEvent('tr:ai-fill') 派发到 #view，
     这里 preventDefault() 表示已被接管（面板据此不再自行处理）。 */
  function applyAiFill(detail) {
    const d = detail || {};
    const wantSide = d.side === 'sell' ? 'sell' : 'buy';
    const px = Number(d.price) || 0;
    if (px > 0) { autoPrice = false; priceIn.value = fmtPrice(px); }
    if (state.ui.orderSide !== wantSide) patchUi({ orderSide: wantSide });
    update();                                  // 立即按新方向刷新（可买/可卖提示）
    const f = Math.min(1, Math.max(0.05, Number(d.pct) > 0 ? Number(d.pct) : 0.25));
    pickPosition(f);                           // 按建议仓位取整手填数量
    const q = Number(qtyIn.value) || 0;
    if (q <= 0) {
      ctx.toast(wantSide === 'buy' ? '可用资金不足，无法按建议建仓' : '没有可卖持仓', 'warn');
      return;
    }
    ctx.toast(`已按 AI 建议填入：${wantSide === 'buy' ? '买入' : '卖出'} ${q} 股 @ ${priceIn.value}`, 'success');
  }
  {
    const evtHost = host.ownerDocument || document;
    const onAiFill = (e) => { if (!e || !e.detail) return; e.preventDefault(); applyAiFill(e.detail); };
    evtHost.addEventListener('tr:ai-fill', onAiFill);
    offs.push(() => evtHost.removeEventListener('tr:ai-fill', onAiFill));
  }

  /* ═══════════ 仓位快捷 ═══════════ */
  function pickPosition(frac) {
    const { id, d } = cur();
    const side = curSide();
    let qty = 0;
    if (side === 'buy') {
      const price = readPrice();
      if (!(price > 0)) { const cp = counterPrice(side, d); if (cp > 0) priceIn.value = fmtPrice(cp); }
      qty = maxBuyQty(readPrice() || 0);
    } else {
      const p = id ? position(id) : null;
      qty = p ? Number(p.avail) || 0 : 0;
    }
    qty = Math.floor((qty * frac) / 100) * 100;
    qtyIn.value = String(qty);
    refreshErr();
  }

  function stepPrice(delta) {
    const { meta, d } = cur();
    const side = curSide();
    const { up, down } = limits(meta, d);
    let p = readPrice();
    if (!Number.isFinite(p) || p <= 0) p = counterPrice(side, d) || 0;
    p = round2(p + delta);
    if (up != null) p = Math.min(p, up);
    if (down != null) p = Math.max(p, down);
    if (p < 0.01) p = 0.01;
    priceIn.value = fmtPrice(p);
    autoPrice = false;
    refreshErr();
  }

  function stepQty(delta) {
    let q = readQty();
    if (!Number.isFinite(q)) q = 0;
    q = Math.max(100, q + delta * 100);
    const p = state.ui.stockId ? position(state.ui.stockId) : null;
    if (curSide() === 'sell' && p) q = Math.min(q, Number(p.avail) || 0);
    qtyIn.value = String(q);
    refreshErr();
  }

  function setPrice(v) {
    if (!(v > 0)) return;
    priceIn.value = fmtPrice(v);
    autoPrice = false;
    refreshErr();
  }

  /* ═══════════ 事件绑定 ═══════════ */
  btnBuy.onclick = () => switchSide('buy');
  btnSell.onclick = () => switchSide('sell');
  submitBtn.onclick = () => submit();
  pMinus.onclick = () => stepPrice(-0.01);
  pPlus.onclick = () => stepPrice(0.01);
  qMinus.onclick = () => stepQty(-1);
  qPlus.onclick = () => stepQty(1);

  qUp.onclick = () => { const { meta, d } = cur(); setPrice(limits(meta, d).up); };
  qDown.onclick = () => { const { meta, d } = cur(); setPrice(limits(meta, d).down); };
  qBid.onclick = () => { const { d } = cur(); setPrice(d && d.b && d.b[0] ? d.b[0][0] : 0); };
  qAsk.onclick = () => { const { d } = cur(); setPrice(d && d.s && d.s[0] ? d.s[0][0] : 0); };

  offs.push(on(priceIn, 'input', () => { autoPrice = false; refreshErr(); }));
  offs.push(on(qtyIn, 'input', () => { refreshErr(); }));
  offs.push(on(priceIn, 'keydown', (e) => { if (e.key === 'ArrowUp') { e.preventDefault(); stepPrice(0.01); } else if (e.key === 'ArrowDown') { e.preventDefault(); stepPrice(-0.01); } }));
  offs.push(on(qtyIn, 'keydown', (e) => { if (e.key === 'ArrowUp') { e.preventDefault(); stepQty(1); } else if (e.key === 'ArrowDown') { e.preventDefault(); stepQty(-1); } }));

  /* 盘口点击 → 填价（由 depth 在 ctx.root 上派发） */
  offs.push(on(ctx.root, 'tr:pick-price', (e) => {
    const det = (e && e.detail) || {};
    if (det.side && det.side !== state.ui.orderSide) { patchUi({ orderSide: det.side }); lastSide = det.side; }
    if (det.price > 0) { priceIn.value = fmtPrice(det.price); autoPrice = false; }
    syncSide(curSide());
    refreshErr();
  }));

  /* 持仓表「卖出」/右键菜单 → 填入本面板 */
  offs.push(on(ctx.root, 'tr:fill-order', (e) => {
    const det = (e && e.detail) || {};
    if (!det.stockId) return;
    const side = det.side === 'sell' ? 'sell' : 'buy';
    patchUi({ stockId: det.stockId, orderSide: side });
    lastStock = det.stockId; lastSide = side;
    const d = derived(det.stockId);
    if (det.qty != null) qtyIn.value = String(det.qty);
    const cp = det.price != null ? det.price : counterPrice(side, d);
    if (cp > 0) priceIn.value = fmtPrice(cp);
    autoPrice = false;
    update();
  }));

  /* 全键盘：Enter 提交、B/S 切方向（输入框内不抢 B/S） */
  const isEditable = (t) => {
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
  };
  const onKey = (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (document.querySelector('.modal-mask')) return;     // 弹窗自己处理 Enter/Esc
    const t = e.target;
    if (e.key === 'Enter') {
      /* 以前「焦点不在输入框」就在交易页任意位置提交委托，极易误操作（正在看 K 线也会下单）。
         现在只认两种：焦点在本下单面板内，或焦点在 body（没有任何焦点）。 */
      const inForm = host.contains(t);
      const noFocus = !t || t === document.body || t === document.documentElement;
      if (inForm || noFocus) { e.preventDefault(); submit(); }
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (isEditable(t)) return;
    const k = String(e.key || '').toLowerCase();
    if (k === 'b') switchSide('buy');
    else if (k === 's') switchSide('sell');
  };
  offs.push(on(document, 'keydown', onKey));

  update();
  return {
    update,
    destroy() {
      for (const off of offs) { try { off(); } catch (e) { /* ignore */ } }
      offs.length = 0;
      clear(host);
    },
  };
}
