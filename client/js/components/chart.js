/* ═══════════════════════════════════════════════════════════════════════════
   同花亏 · components/chart.js —— 纯 Canvas 行情绘图内核
   ───────────────────────────────────────────────────────────────────────────
   契约（DESIGN.md §4.4，冻结）：
     class Chart { constructor(canvas); setData(data); resize(); render(); destroy(); }
   · 不访问全局 state，不碰 DOM 结构，只画在自己的 canvas 上；
   · 颜色透过 CSS 变量（getComputedStyle）读取，取不到时退回内置常量；
   · devicePixelRatio 缩放保证文字锐利；requestAnimationFrame 合并重绘。

   setData(data)：
     { type:'timeshare'|'candle', title, code, tf, prevClose,
       bars:[[t,o,h,l,c,v],...], timesharePoints:[[t,price,avgPrice,vol],...],
       showMA, showMACD, showVOL, dark, limitUp, limitDown }
   ═══════════════════════════════════════════════════════════════════════════ */

/* 内置回退色（仅当 CSS 变量缺失/为空时使用；均为装饰色，不是红涨绿跌语义色） */
const FALLBACK = {
  light: {
    page: '#ffffff',
    grid: '#eef1f5',
    gridDash: '#b9c2cd',
    text: '#8a8a8a',
    text2: '#4a4a4a',
    up: '#f5333f',
    down: '#12b886',
    flat: '#7a7a7a',
    line: '#3b8fd4',
    lineSoft: '#a8ccec',
    avg: '#e8a33d',
    ma5: '#d98e12',
    ma10: '#2f9ee0',
    ma20: '#c94fd0',
    ma60: '#2e9e63',
    cursor: '#5a6470',
    boxBg: 'rgba(255,255,255,.95)',
    boxBd: 'rgba(0,0,0,.25)',
    boxTxt: '#1a1a1a',
  },
  dark: {
    page: '#1a2029',
    grid: '#222b36',
    gridDash: '#46546a',
    text: '#6b7480',
    text2: '#a9b0bc',
    up: '#ff4d5a',
    down: '#1fd39a',
    flat: '#8b93a1',
    line: '#5fa8e8',
    lineSoft: '#2c4a6b',
    avg: '#e8a33d',
    ma5: '#e8b13c',
    ma10: '#63b8f0',
    ma20: '#dd77e4',
    ma60: '#4ecb87',
    cursor: '#aab4c2',
    boxBg: 'rgba(22,27,35,.94)',
    boxBd: 'rgba(255,255,255,.22)',
    boxTxt: '#e5e6eb',
  },
};

const DEFAULT_FONT = '"Microsoft YaHei","PingFang SC","Segoe UI",Arial,sans-serif';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fmt2 = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '--');
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

function normBars(src) {
  const out = [];
  if (!Array.isArray(src)) return out;
  for (const b of src) {
    if (!Array.isArray(b) || b.length < 5) continue;
    const t = Number(b[0]);
    const c = Number(b[4]);
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    out.push([t, Number(b[1]), Number(b[2]), Number(b[3]), c, Number(b[5]) || 0]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

function normPoints(src) {
  const out = [];
  if (!Array.isArray(src)) return out;
  for (const p of src) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const price = Number(p[1]);
    if (!Number.isFinite(price)) continue;
    const avg = Number(p[2]);
    const vol = Number(p[3]);
    out.push([Number(p[0]) || 0, price, Number.isFinite(avg) ? avg : price, Number.isFinite(vol) ? vol : 0]);
  }
  return out;
}

/** 指数加权移动平均（首值播种） */
function emaDense(values, n) {
  const out = new Array(values.length).fill(null);
  if (!values.length) return out;
  const k = 2 / (n + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** 简单移动平均（收盘价），index < n-1 为 null */
function smaOfBars(bars, n) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i][4];
    if (i >= n) sum -= bars[i - n][4];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** 友好坐标轴步长 */
function niceStep(range, count) {
  const raw = Math.abs(range) / Math.max(1, count);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return mult * mag;
}

/** 量：股 → 手（千分位） */
function lots(v) {
  if (!Number.isFinite(Number(v))) return '--';
  return Math.round(Number(v) / 100).toLocaleString('en-US');
}

/** 量：万 / 亿 紧凑文本 */
function volText(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (a >= 1e4) return (n / 1e4).toFixed(2) + '万';
  return String(Math.round(n));
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/* ── 分时图时间轴 ──
   服务端时间模型：一个虚拟交易日 = 120 个虚拟分钟 = 上午盘 09:30-11:30
   （config.VIRTUAL_DAY_TICKS = 120），不再有下午盘 / 午休压缩。
   横轴固定 TS_SLOTS 格；若数据源带了 virtualDayTicks（data.virtualDayTicks）则优先用它，
   以便同一份代码兼容其它节奏。刻度 5 个（TS_LABELS），按 TS_SLOTS/4 均匀分布。 */
const TS_SLOTS = 120;
const TS_LABELS = ['09:30', '10:00', '10:30', '11:00', '11:30'];
const TS_TICKS = TS_LABELS.length - 1;      // 4 段 → 每段 TS_SLOTS/4 格

export class Chart {
  constructor(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new Error('[Chart] 需要一个 canvas 元素');
    }
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = null;
    this.hover = null;
    this.emptyText = '暂无行情数据';

    this._raf = 0;
    this._w = 0;
    this._h = 0;
    this._dpr = 1;
    this._L = null;        // 当前布局
    this._indic = null;    // 指标缓存
    this._indicKey = '';
    this._font = '';       // 字体族（从 canvas 计算样式读取）
    this._srcKey = '';
    this._vis = null;      // 可见根数
    this._offs = 0;        // 距最新根的偏移
    this._drag = null;
    this._unbinds = [];
    this._bind();
  }

  /* ═════════════ 数据 ═════════════ */
  setData(data) {
    this.data = data || null;
    const d = this.data;
    if (!d) {
      this._srcKey = '';
      this._indic = null;
      this._indicKey = '';
      this._vis = null;
      this._offs = 0;
    } else {
      const key = String(d.type || '') + '|' + String(d.code || d.title || '');
      if (key !== this._srcKey) {
        this._srcKey = key;
        this._vis = null;
        this._offs = 0;
        this._indic = null;
        this._indicKey = '';
      }
    }
    return this.render();
  }

  /* ═════════════ 尺寸 ═════════════ */
  size() {
    const c = this.canvas;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const w = Math.max(1, c.clientWidth || 300);
    const h = Math.max(1, c.clientHeight || 180);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (c.width !== bw || c.height !== bh) {
      c.width = bw;
      c.height = bh;
    }
    this._w = w;
    this._h = h;
    this._dpr = dpr;
    return { w, h };
  }

  resize() {
    this.size();
    this._L = null;
    this._font = '';
    return this.render();
  }

  /* ═════════════ 主题 ═════════════ */
  _styles() {
    let cs = null;
    try { cs = getComputedStyle(this.canvas); } catch (e) { cs = null; }
    if (cs && !this._font) {
      const fam = String(cs.fontFamily || '').trim();
      if (fam && fam !== 'initial') this._font = fam;
    }
    return cs;
  }

  _fontFam() {
    if (!this._font) {
      this._styles();
      if (!this._font) this._font = DEFAULT_FONT;
    }
    return this._font;
  }

  _isDark() {
    const d = this.data;
    if (d && (d.dark === true || d.dark === 1 || d.dark === 'dark')) return true;
    if (d && (d.dark === false || d.dark === 0 || d.dark === 'light')) return false;
    let node = this.canvas;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const cl = node.classList;
      if (cl && (cl.contains('dark') || cl.contains('theme-dark'))) return true;
      node = node.parentNode;
    }
    const b = document.body;
    if (b && b.classList && b.classList.contains('dark')) return true;
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) { return false; }
  }

  /** 读取主题色：优先 CSS 变量，缺失时用内置回退 */
  colors() {
    const dark = this._isDark();
    const cs = this._styles();
    const get = (name, fb) => {
      let raw = '';
      try { raw = cs ? String(cs.getPropertyValue(name) || '').trim() : ''; } catch (e) { raw = ''; }
      return raw || fb;
    };
    const map = dark ? FALLBACK.dark : FALLBACK.light;
    return {
      dark,
      page: get('--chart-bg', get('--panel', map.page)),
      grid: get('--chart-grid', get('--border-2', map.grid)),
      gridDash: map.gridDash,
      text: get('--text-3', map.text),
      text2: get('--text-2', map.text2),
      up: get('--up', map.up),
      down: get('--down', map.down),
      flat: get('--flat', map.flat),
      line: get('--chart-line', map.line),
      lineSoft: get('--chart-line-2', map.lineSoft),
      avg: get('--chart-avg', map.avg),
      ma5: get('--chart-ma5', map.ma5),
      ma10: get('--chart-ma10', map.ma10),
      ma20: get('--chart-ma20', map.ma20),
      ma60: get('--chart-ma60', map.ma60),
      cursor: get('--chart-cursor', map.cursor),
      boxBg: get('--chart-box-bg', map.boxBg),
      boxBd: get('--border', map.boxBd),
      boxTxt: map.boxTxt,
    };
  }

  /* ═════════════ 绘制入口 ═════════════ */
  render() {
    if (this._raf) {
      const caf = window.cancelAnimationFrame || clearTimeout;
      try { caf(this._raf); } catch (e) { /* ignore */ }
      this._raf = 0;
    }
    const ctx = this.ctx;
    if (!ctx) return this;
    const C = this.colors();
    this.size();
    const dpr = this._dpr;
    const w = this._w;
    const h = this._h;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = C.page;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (w < 40 || h < 40) return this;

    ctx.textBaseline = 'middle';
    ctx.font = '11px ' + this._fontFam();

    const L = this._layout(w, h);
    this._L = L;
    const d = this.data;

    if (!d || !d.type) {
      this._empty(L, C);
      return this;
    }
    if (d.type === 'timeshare') {
      const pts = normPoints(d.timesharePoints);
      if (!pts.length) { this._empty(L, C); return this; }
      this._drawTimeshare(L, C, pts);
    } else {
      const bars = normBars(d.bars);
      if (!bars.length) { this._empty(L, C); return this; }
      this._drawCandles(L, C, bars);
      if (L.hasMACD && d.showMACD !== false) this._drawMACD(L, C, bars);
    }
    this._crosshair(L, C);
    return this;
  }

  /* ═════════════ 布局 ═════════════ */
  _layout(w, h) {
    const d = this.data || {};
    const isTS = d.type === 'timeshare';
    const GAP = 8;
    const top = 12;
    const bottomAxis = 15;
    // 高度预算：空间不足时按 VOL → MACD 的顺序停用副图，保证主图永远有位
    const budget = Math.max(0, h - bottomAxis - top);
    const wantVOL = isTS ? true : d.showVOL !== false;
    const wantMACD = !isTS && d.showMACD !== false;
    const showVOL = wantVOL && (isTS ? budget >= 60 : budget >= 80);
    const showMACD = wantMACD && budget >= 130;

    const loW = isTS ? 46 : 50;
    const roW = isTS ? 52 : 50;
    const padL = 3;
    const x = padL + loW;
    const pw = Math.max(20, w - roW - x - 4);
    const plotBottom = h - bottomAxis;
    const ph = Math.max(30, plotBottom - top);

    const L = {
      w, h, isTS, top, padL, loW, roW, x, pw, plotBottom,
      main: { x, y: top, w: pw, h: ph },
      vol: null,
      macd: null,
      hasMACD: false,
    };

    if (isTS) {
      if (showVOL) {
        const usable = Math.max(24, ph - GAP);
        const vh = Math.max(22, Math.round(usable * 0.3));
        L.main.h = Math.max(18, usable - vh);
        L.vol = { x, y: L.main.y + L.main.h + GAP, w: pw, h: vh };
      } else {
        L.main.h = Math.max(18, ph);
      }
      return L;
    }

    const usable = Math.max(20, ph - GAP * ((showMACD ? 1 : 0) + (showVOL ? 1 : 0)));
    let volH = 0;
    let macdH = 0;
    if (showMACD && showVOL) {
      volH = Math.max(22, Math.round(usable * 0.2));
      macdH = Math.max(30, Math.round(usable * 0.28));
    } else if (showMACD) {
      macdH = Math.max(30, Math.round(usable * 0.34));
    } else if (showVOL) {
      volH = Math.max(22, Math.round(usable * 0.26));
    }
    L.main.h = Math.max(20, usable - volH - macdH);
    let y = L.main.y + L.main.h + GAP;
    if (showVOL && volH > 0) {
      L.vol = { x, y, w: pw, h: volH };
      if (showMACD) y += volH + GAP;
    }
    if (showMACD && macdH > 0) {
      L.macd = { x, y, w: pw, h: macdH };
      L.hasMACD = true;
    }
    return L;
  }

  /* ═════════════ 空态 ═════════════ */
  _empty(L, C) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(L.main.x + 0.5, L.main.y + 0.5, L.main.w - 1, L.main.h - 1);
    ctx.fillStyle = C.text;
    ctx.font = '12px ' + this._fontFam();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.emptyText, L.main.x + L.main.w / 2, L.main.y + L.main.h / 2);
    ctx.restore();
  }

  /* ═════════════ 分时图 ═════════════ */
  _drawTimeshare(L, C, pts) {
    const PC = this._pc();
    let lo = PC > 0 ? PC : Infinity;
    let hi = PC > 0 ? PC : -Infinity;
    for (const p of pts) {
      if (p[1] < lo) lo = p[1];
      if (p[1] > hi) hi = p[1];
      if (p[2] < lo) lo = p[2];
      if (p[2] > hi) hi = p[2];
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
    if (hi <= lo) { const m = ((hi + lo) / 2) || 1; lo = m * 0.98; hi = m * 1.02; }
    if (PC > 0) {
      const a = Math.max(PC - lo, hi - PC, PC * 0.002);
      const pad = a * 0.12;
      lo = PC - a - pad;
      hi = PC + a + pad;
    } else {
      const pad = (hi - lo) * 0.08;
      lo -= pad; hi += pad;
    }
    const sy = this._scaleY(lo, hi, L.main);

    this._axesTS(L, C, sy, lo, hi, PC);
    this._frame(C, L.main);
    if (L.vol) this._frame(C, L.vol);
    this._label(C, 3, L.main.y + 4, fmt2(hi), C.text, 'left', 'top');
    this._label(C, 3, L.main.y + L.main.h - 4, fmt2(lo), C.text, 'left', 'bottom');

    const xOf = this._baseX(L, pts.length);
    const price = [{ x: L.x, y: sy(pts[0][1]) }];
    const avg = [{ x: L.x, y: sy(pts[0][2]) }];
    for (let i = 0; i < pts.length; i++) {
      price.push({ x: xOf(i), y: sy(pts[i][1]) });
      avg.push({ x: xOf(i), y: sy(pts[i][2]) });
    }
    /* 不再把最后一个点硬拉到右边缘：分时线应停在「当前时刻」，
       否则刚开盘就有一条横线铺到 15:00，看起来像一整天已经走完了。 */

    // 相对昨收的红/绿参考填充（同花顺风格）
    if (PC > 0) {
      const yPC = sy(PC);
      const gu = this.ctx.createLinearGradient(0, L.main.y, 0, yPC);
      gu.addColorStop(0, this._rgba(C.up, 0.26));
      gu.addColorStop(1, this._rgba(C.up, 0.03));
      const gd = this.ctx.createLinearGradient(0, yPC, 0, L.main.y + L.main.h);
      gd.addColorStop(0, this._rgba(C.down, 0.03));
      gd.addColorStop(1, this._rgba(C.down, 0.26));
      this._fillBand(price, yPC, gu, true);
      this._fillBand(price, yPC, gd, false);
    }

    // 价格线（蓝，左浅右深渐变）
    const g = this.ctx.createLinearGradient(L.x, 0, L.x + L.pw, 0);
    g.addColorStop(0, C.lineSoft);
    g.addColorStop(1, C.line);
    this._polyline(price, g, 1.2, L.main);

    // 均价线（黄）
    this._polyline(avg, C.avg, 1, L.main);

    // 成交量副图（涨红跌绿）
    if (L.vol) {
      let vmax = 0;
      for (const p of pts) if (p[3] > vmax) vmax = p[3];
      const sv = this._scaleY(0, vmax * 1.06 || 1, L.vol);
      const bw = Math.max(0.8, Math.min(6, (L.pw / Math.max(1, pts.length)) * 0.7));
      const ctx = this.ctx;
      ctx.save();
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const prev = i > 0 ? pts[i - 1][1] : p[1];
        ctx.fillStyle = p[1] >= prev ? C.up : C.down;
        const y0 = sv(0);
        const y1 = sv(p[3]);
        ctx.fillRect(Math.round(xOf(i) - bw / 2), Math.round(Math.min(y0, y1)), Math.max(1, Math.round(bw)), Math.max(1, Math.round(Math.abs(y0 - y1))));
      }
      ctx.restore();
      this._zeroLine(C, L.vol, sv(0));
      this._label(C, 3, L.vol.y + 4, volText(vmax), C.text, 'left', 'top');
      this._label(C, 3, L.vol.y + L.vol.h - 4, '0', C.text, 'left', 'bottom');
      this._subLabel(C, L.vol, 'VOL');
    }

    this._legendTS(L, C, pts, PC);
  }

  /** 以 baseY 为基线，把折线一侧填充（above=true 取上方） */
  _fillBand(pts, baseY, grad, above) {
    const L = this._L;
    const ctx = this.ctx;
    const proj = pts.map((p) => [p.x, above ? Math.min(p.y, baseY) : Math.max(p.y, baseY)]);
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.x, L.main.y, L.pw, L.main.h);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(proj[0][0], baseY);
    for (const p of proj) ctx.lineTo(p[0], p[1]);
    ctx.lineTo(proj[proj.length - 1][0], baseY);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
  }

  /** 分时图：网格 / 左右轴 / 时间刻度 / 昨收虚线 */
  _axesTS(L, C, sy, lo, hi, PC) {
    const ctx = this.ctx;
    const step = (hi - lo) / 4;
    const seen = [];
    ctx.save();
    ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const p = lo + step * k;
      const y = Math.round(sy(p)) + 0.5;
      if (y < L.main.y - 0.5 || y > L.main.y + L.main.h + 0.5) continue;
      let dup = false;
      for (const s of seen) if (Math.abs(s - y) < 7) dup = true;
      if (dup) continue;
      seen.push(y);
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      ctx.moveTo(L.x, y);
      ctx.lineTo(L.x + L.pw, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(L.x + L.pw, y);
      ctx.lineTo(L.x + L.pw + 4, y);
      ctx.stroke();
      this._label(C, L.x + L.pw + 7, y, fmt2(p), C.text, 'left', 'middle');
      if (PC > 0) {
        const pct = (p - PC) / PC * 100;
        this._label(C, L.x + L.pw + 7, y + 10, (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%', C.text, 'left', 'middle');
      }
    }

    /* 整点刻度：09:30 / 10:00 / 10:30 / 11:00 / 11:30 → 每 TS_SLOTS/4 格一条 */
    const N = this._tsSlots();
    for (let k = 0; k <= TS_TICKS; k++) {
      const s = (N / TS_TICKS) * k;
      const xx = Math.round(L.x + (s / N) * L.pw) + 0.5;
      if (k === TS_TICKS) {
        /* 最后一个刻度 = 11:30 上午收盘边界 */
        ctx.strokeStyle = C.gridDash;
        ctx.setLineDash([3, 3]);
      } else {
        ctx.strokeStyle = C.grid;
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      ctx.moveTo(xx, L.main.y);
      ctx.lineTo(xx, L.plotBottom);
      ctx.stroke();
      ctx.setLineDash([]);
      const lab = TS_LABELS[Math.min(k, TS_LABELS.length - 1)];
      ctx.font = '11px ' + this._fontFam();
      const lw = ctx.measureText(lab).width;
      const lx = clamp(xx, L.x + lw / 2 + 1, L.x + L.pw - lw / 2 - 1);
      this._label(C, lx, L.plotBottom + 8, lab, C.text, 'center', 'middle');
    }

    /* 半点细网格：10:00-11:00 之间两条（各占四分之一的整点间隔） */
    ctx.strokeStyle = C.grid;
    ctx.setLineDash([]);
    for (const s of [N / 4, (N * 3) / 4]) {
      const xx = Math.round(L.x + (s / N) * L.pw) + 0.5;
      ctx.beginPath();
      ctx.moveTo(xx, L.main.y);
      ctx.lineTo(xx, L.main.y + L.main.h);
      ctx.stroke();
    }

    if (PC > 0) {
      const y = Math.round(sy(PC)) + 0.5;
      ctx.strokeStyle = C.gridDash;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(L.x, y);
      ctx.lineTo(L.x + L.pw, y);
      ctx.stroke();
      ctx.setLineDash([]);
      this._label(C, L.x + L.pw + 7, y, '昨收', C.text2, 'left', 'middle');
    }
    ctx.restore();
  }

  _legendTS(L, C, pts, PC) {
    const ctx = this.ctx;
    const last = pts[pts.length - 1];
    const parts = [
      { t: '分时', c: C.text2 },
      { t: fmt2(last[1]), c: PC > 0 ? (last[1] >= PC ? C.up : C.down) : C.flat },
      { t: '均价', c: C.text2 },
      { t: fmt2(last[2]), c: C.avg },
      { t: '昨收', c: C.text2 },
      { t: fmt2(PC), c: C.text2 },
    ];
    ctx.save();
    ctx.font = '11px ' + this._fontFam();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let tw = 12;
    for (const p of parts) tw += ctx.measureText(p.t).width + 7;
    const x0 = L.main.x + 4;
    const y0 = L.main.y + 9;
    ctx.fillStyle = C.dark ? 'rgba(255,255,255,.05)' : 'rgba(120,130,145,.09)';
    ctx.fillRect(x0 - 3, y0 - 8, Math.min(tw, L.main.w - 8), 16);
    let x = x0;
    for (const p of parts) {
      const w = ctx.measureText(p.t).width;
      if (x + w > L.main.x + L.main.w - 6) break;
      ctx.fillStyle = p.c;
      ctx.fillText(p.t, x, y0);
      x += w + 7;
    }
    ctx.restore();
  }

  /* ═════════════ K 线图 ═════════════ */
  _drawCandles(L, C, bars) {
    const d = this.data;
    const info = this._visRange(bars.length, L);
    const from = info.from;
    const to = info.to;
    const X = this._barX(L, from, to);
    const bw = Math.max(1.4, Math.min(16, (L.pw / Math.max(1, to - from + 1)) * 0.72));

    let lo = Infinity;
    let hi = -Infinity;
    for (let i = from; i <= to; i++) {
      const b = bars[i];
      if (!b) continue;
      if (b[3] < lo) lo = b[3];
      if (b[2] > hi) hi = b[2];
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
    if (hi <= lo) hi = lo + Math.max(0.01, Math.abs(lo) * 0.01);
    const pad = (hi - lo) * 0.06;
    lo -= pad; hi += pad;
    const sy = this._scaleY(lo, hi, L.main);

    this._gridX(L, C, bars, from, to, sy, lo, hi);

    const ind = this._indicators(bars);
    const showMA = d.showMA !== false && !!ind;
    if (showMA) {
      this._polyline(this._maPts(ind.ma5, X, sy, from, to), C.ma5, 1, L.main);
      this._polyline(this._maPts(ind.ma10, X, sy, from, to), C.ma10, 1, L.main);
      this._polyline(this._maPts(ind.ma20, X, sy, from, to), C.ma20, 1, L.main);
      this._polyline(this._maPts(ind.ma60, X, sy, from, to), C.ma60, 1, L.main);
    }

    // 蜡烛：阳线红（空心）/ 阴线绿（实心），带上下影线
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 1;
    for (let i = from; i <= to; i++) {
      const b = bars[i];
      if (!b) continue;
      const o = b[1], h = b[2], l = b[3], c = b[4];
      const xc = X(i);
      const xi = Math.round(xc) + 0.5;
      const up = c >= o;
      const color = up ? C.up : C.down;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(xi, Math.round(sy(h)) + 0.5);
      ctx.lineTo(xi, Math.round(sy(l)) + 0.5);
      ctx.stroke();
      const yo = sy(o);
      const yc = sy(c);
      const top = Math.round(Math.min(yo, yc));
      const hgt = Math.max(1, Math.round(Math.abs(yo - yc)));
      const wdt = Math.max(1, Math.round(bw));
      const left = Math.round(xc - wdt / 2);
      if (up) ctx.strokeRect(left + 0.5, top + 0.5, wdt, hgt);
      else ctx.fillRect(left, top, wdt, hgt);
    }
    ctx.restore();

    if (L.vol) this._drawVolume(L, C, bars, from, to, X);
    if (showMA) this._legendMA(L, C, ind, to);

    const lastBar = bars[to];
    if (lastBar) {
      const prev = to > 0 ? bars[to - 1][4] : lastBar[1];
      const yy = sy(lastBar[4]);
      this._lastBadge(L, C, lastBar[4], yy, lastBar[4] >= prev);
    }
  }

  _maPts(dense, X, sy, from, to) {
    const out = [];
    if (!dense) return out;
    for (let i = from; i <= to; i++) {
      const v = dense[i];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      out.push({ x: X(i), y: sy(v) });
    }
    return out;
  }

  /** MA / MACD 指标（按数据指纹缓存） */
  _indicators(bars) {
    const d = this.data || {};
    const lastT = bars.length ? bars[bars.length - 1][0] : 0;
    const key = String(d.code || d.title || '') + '|' + String(d.tf || '') + '|' + bars.length + '|' + lastT;
    if (this._indic && this._indicKey === key) return this._indic;

    const ma5 = smaOfBars(bars, 5);
    const ma10 = smaOfBars(bars, 10);
    const ma20 = smaOfBars(bars, 20);
    const ma60 = smaOfBars(bars, 60);
    const closes = bars.map((b) => b[4]);
    const e12 = emaDense(closes, 12);
    const e26 = emaDense(closes, 26);
    const dif = new Array(bars.length).fill(null);
    for (let i = 0; i < bars.length; i++) {
      if (e12[i] === null || e26[i] === null) continue;
      dif[i] = e12[i] - e26[i];
    }
    const deaRaw = emaDense(dif.map((v) => (v === null ? 0 : v)), 9);
    const dea = new Array(bars.length).fill(null);
    const bar = new Array(bars.length).fill(null);
    for (let i = 0; i < bars.length; i++) {
      if (dif[i] === null) continue;
      dea[i] = deaRaw[i];
      bar[i] = (dif[i] - dea[i]) * 2;
    }
    this._indic = { ma5, ma10, ma20, ma60, dif, dea, bar };
    this._indicKey = key;
    return this._indic;
  }

  _legendMA(L, C, ind, i) {
    const ctx = this.ctx;
    const items = [
      { n: 'MA5', c: C.ma5, v: ind.ma5[i] },
      { n: 'MA10', c: C.ma10, v: ind.ma10[i] },
      { n: 'MA20', c: C.ma20, v: ind.ma20[i] },
      { n: 'MA60', c: C.ma60, v: ind.ma60[i] },
    ];
    const texts = items.map((it) => it.n + ' ' + (it.v === null || it.v === undefined ? '--' : fmt2(it.v)));
    ctx.save();
    ctx.font = '11px ' + this._fontFam();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let tw = 12;
    for (const t of texts) tw += ctx.measureText(t).width + 8;
    const x0 = L.main.x + 4;
    const y0 = L.main.y + 9;
    ctx.fillStyle = C.dark ? 'rgba(255,255,255,.05)' : 'rgba(120,130,145,.09)';
    ctx.fillRect(x0 - 3, y0 - 8, Math.min(tw, L.main.w - 8), 16);
    let x = x0;
    for (let k = 0; k < items.length; k++) {
      const w = ctx.measureText(texts[k]).width;
      if (x + w > L.main.x + L.main.w - 6) break;
      ctx.fillStyle = items[k].c;
      ctx.fillText(texts[k], x, y0);
      x += w + 8;
    }
    ctx.restore();
  }

  _drawVolume(L, C, bars, from, to, X) {
    let vmax = 0;
    for (let i = from; i <= to; i++) if (bars[i] && bars[i][5] > vmax) vmax = bars[i][5];
    const sv = this._scaleY(0, vmax * 1.06 || 1, L.vol);
    const bw = Math.max(1.2, Math.min(16, (L.pw / Math.max(1, to - from + 1)) * 0.72));
    const ctx = this.ctx;
    ctx.save();
    for (let i = from; i <= to; i++) {
      const b = bars[i];
      if (!b) continue;
      const prev = i > 0 ? bars[i - 1][4] : b[1];
      ctx.fillStyle = b[4] >= prev ? C.up : C.down;
      const y0 = sv(0);
      const y1 = sv(b[5]);
      const x = Math.round(X(i) - bw / 2);
      ctx.fillRect(x, Math.round(Math.min(y0, y1)), Math.max(1, Math.round(bw)), Math.max(1, Math.round(Math.abs(y0 - y1))));
    }
    ctx.restore();
    this._zeroLine(C, L.vol, sv(0));
    this._label(C, 3, L.vol.y + 4, volText(vmax), C.text, 'left', 'top');
    this._label(C, 3, L.vol.y + L.vol.h - 4, '0', C.text, 'left', 'bottom');
    this._subLabel(C, L.vol, 'VOL');
  }

  _drawMACD(L, C, bars) {
    const ind = this._indicators(bars);
    const info = this._visRange(bars.length, L);
    const from = info.from;
    const to = info.to;
    const X = this._barX(L, from, to);

    let lo = 0;
    let hi = 0;
    for (let i = from; i <= to; i++) {
      const vals = [ind.dif[i], ind.dea[i], ind.bar[i]];
      for (const v of vals) {
        if (v === null || !Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const amp = Math.max(Math.abs(lo), Math.abs(hi), 1e-6) * 1.2;
    lo = Math.min(lo * 1.1, -amp * 0.4);
    hi = Math.max(hi * 1.1, amp * 0.4);
    const sy = this._scaleY(lo, hi, L.macd);

    this._zeroLine(C, L.macd, sy(0));

    const ctx = this.ctx;
    const bw = Math.max(1.2, Math.min(12, (L.pw / Math.max(1, to - from + 1)) * 0.6));
    ctx.save();
    for (let i = from; i <= to; i++) {
      const v = ind.bar[i];
      if (v === null || !Number.isFinite(v)) continue;
      ctx.fillStyle = v >= 0 ? C.up : C.down;
      const y0 = sy(0);
      const y1 = sy(v);
      ctx.fillRect(Math.round(X(i) - bw / 2), Math.round(Math.min(y0, y1)), Math.max(1, Math.round(bw)), Math.max(1, Math.round(Math.abs(y0 - y1))));
    }
    ctx.restore();

    this._polyline(this._maPts(ind.dif, X, sy, from, to), C.ma10, 1, L.macd);
    this._polyline(this._maPts(ind.dea, X, sy, from, to), C.ma5, 1, L.macd);

    this._subLabel(C, L.macd, 'MACD(12,26,9)');
    const i = to;
    const txt = 'DIF ' + (ind.dif[i] === null ? '--' : ind.dif[i].toFixed(3)) +
      '   DEA ' + (ind.dea[i] === null ? '--' : ind.dea[i].toFixed(3)) +
      '   MACD ' + (ind.bar[i] === null ? '--' : ind.bar[i].toFixed(3));
    this._label(C, L.macd.x + 92, L.macd.y + 8, txt, C.text2, 'left', 'middle');
  }

  /* ═════════════ K 线网格 / 坐标轴 ═════════════ */
  _gridX(L, C, bars, from, to, sy, lo, hi) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 1;
    const step = niceStep(hi - lo, 4);
    if (step > 0) {
      const start = Math.ceil(lo / step) * step;
      for (let p = start; p <= hi + step * 1e-6; p += step) {
        const y = Math.round(sy(p)) + 0.5;
        if (y < L.main.y - 0.5 || y > L.main.y + L.main.h + 0.5) continue;
        ctx.strokeStyle = C.grid;
        ctx.beginPath();
        ctx.moveTo(L.x, y);
        ctx.lineTo(L.x + L.pw, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(L.x + L.pw, y);
        ctx.lineTo(L.x + L.pw + 4, y);
        ctx.stroke();
        this._label(C, L.x + L.pw + 7, y, p.toFixed(2), C.text, 'left', 'middle');
      }
    }

    const X = this._barX(L, from, to);
    const total = Math.max(1, to - from + 1);
    const target = clamp(Math.floor(L.pw / 90), 3, 8);
    const stride = Math.max(1, Math.round(total / target));
    for (let i = from; i <= to; i += stride) {
      const b = bars[i];
      if (!b) continue;
      const x = Math.round(X(i)) + 0.5;
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      ctx.moveTo(x, L.main.y);
      ctx.lineTo(x, L.main.y + L.main.h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, L.main.y + L.main.h);
      ctx.lineTo(x, L.main.y + L.main.h + 4);
      ctx.stroke();
      const lab = this._dateLabel(b[0]);
      ctx.font = '11px ' + this._fontFam();
      const lw = ctx.measureText(lab).width;
      const lx = clamp(x, L.x + lw / 2 + 1, L.x + L.pw - lw / 2 - 1);
      this._label(C, lx, L.plotBottom + 8, lab, C.text, 'center', 'middle');
    }
    ctx.restore();
  }

  _dateLabel(t) {
    const tf = (this.data && this.data.tf) || '1d';
    if (!Number.isFinite(t) || t <= 0) return '--';
    const d = new Date(t);
    if (!Number.isFinite(d.getTime())) return '--';
    if (tf === '1m' || tf === '5m' || tf === '15m') return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  _boxTime(t) {
    const tf = (this.data && this.data.tf) || '1d';
    if (!Number.isFinite(t) || t <= 0) return '--';
    const d = new Date(t);
    if (!Number.isFinite(d.getTime())) return '--';
    const md = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    if (tf === '1d') return d.getFullYear() + '-' + md + ' 周' + WEEK[d.getDay()];
    return md + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  _subLabel(C, sec, text) {
    this._label(C, sec.x + 4, sec.y + 8, text, C.text, 'left', 'middle');
  }

  /* ═════════════ 十字光标 + 浮动数据框 ═════════════ */
  _crosshair(L, C) {
    const h = this.hover;
    const d = this.data;
    if (!h || !d || !d.type) return;
    if (h.x < L.x - 1 || h.x > L.x + L.pw + 1) return;
    if (h.y < L.main.y - 1 || h.y > L.plotBottom + 1) return;

    const rows = [];
    let vx = h.x;

    if (d.type === 'timeshare') {
      const pts = normPoints(d.timesharePoints);
      if (!pts.length) return;
      const best = this._findSlot(pts, L, h.x);
      vx = L.x + (best.slot / this._tsSlots()) * L.pw;
      const p = pts[best.i];
      const PC = this._pc();
      const chg = PC > 0 ? p[1] - PC : 0;
      const pct = PC > 0 ? chg / PC * 100 : 0;
      rows.push(['时间', this._slotLabel(best.slot)]);
      rows.push(['价格', fmt2(p[1])]);
      rows.push(['均价', fmt2(p[2])]);
      rows.push(['涨跌', PC > 0 ? (chg >= 0 ? '+' : '') + fmt2(chg) : '--']);
      rows.push(['涨幅', PC > 0 ? (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%' : '--']);
      rows.push(['成交量', lots(p[3]) + ' 手']);
    } else {
      const bars = normBars(d.bars);
      if (!bars.length) return;
      const info = this._visRange(bars.length, L);
      const X = this._barX(L, info.from, info.to);
      let best = info.from;
      let bd = Infinity;
      for (let i = info.from; i <= info.to; i++) {
        const dist = Math.abs(X(i) - h.x);
        if (dist < bd) { bd = dist; best = i; }
      }
      vx = X(best);
      const b = bars[best];
      const PC = this._pc() || (best > 0 ? bars[best - 1][4] : b[1]);
      const chg = b[4] - PC;
      rows.push(['时间', this._boxTime(b[0])]);
      rows.push(['开盘', fmt2(b[1])]);
      rows.push(['最高', fmt2(b[2])]);
      rows.push(['最低', fmt2(b[3])]);
      rows.push(['收盘', fmt2(b[4])]);
      rows.push(['涨跌', (chg >= 0 ? '+' : '') + fmt2(chg)]);
      rows.push(['涨幅', PC > 0 ? (chg >= 0 ? '+' : '') + (chg / PC * 100).toFixed(2) + '%' : '--']);
      rows.push(['成交量', lots(b[5]) + ' 手']);
      if (d.showMA !== false) {
        const ind = this._indicators(bars);
        rows.push(['MA5', ind.ma5[best] === null ? '--' : fmt2(ind.ma5[best])]);
        rows.push(['MA10', ind.ma10[best] === null ? '--' : fmt2(ind.ma10[best])]);
        rows.push(['MA20', ind.ma20[best] === null ? '--' : fmt2(ind.ma20[best])]);
        rows.push(['MA60', ind.ma60[best] === null ? '--' : fmt2(ind.ma60[best])]);
      }
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = C.cursor;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(vx) + 0.5, L.main.y);
    ctx.lineTo(Math.round(vx) + 0.5, L.plotBottom);
    ctx.moveTo(L.x, Math.round(h.y) + 0.5);
    ctx.lineTo(L.x + L.pw, Math.round(h.y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    ctx.save();
    ctx.font = '11px ' + this._fontFam();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let valW = 0;
    for (const r of rows) {
      const w = ctx.measureText(String(r[1])).width;
      if (w > valW) valW = w;
    }
    const labelW = 46;
    valW = Math.max(54, Math.min(130, valW + 10));
    const rowH = 14;
    const boxW = labelW + valW + 14;
    const boxH = rows.length * rowH + 8;
    let bx = h.x + 14;
    let by = h.y + 12;
    if (bx + boxW > L.main.x + L.main.w - 2) bx = h.x - boxW - 14;
    if (bx < L.main.x + 2) bx = L.main.x + 2;
    if (by + boxH > L.main.y + L.main.h - 2) by = Math.max(L.main.y + 2, h.y - boxH - 12);
    bx = Math.round(bx) + 0.5;
    by = Math.round(by) + 0.5;

    ctx.fillStyle = C.boxBg;
    ctx.strokeStyle = C.boxBd;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(bx, by, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    let ty = by + 4 + rowH / 2;
    for (const r of rows) {
      ctx.fillStyle = C.text;
      ctx.fillText(String(r[0]), bx + 7, ty);
      ctx.fillStyle = C.boxTxt;
      ctx.fillText(String(r[1]), bx + 7 + labelW, ty);
      ty += rowH;
    }
    ctx.restore();
  }

  /** 分时：按 TS_SLOTS 格最近邻找点 */
  _findSlot(pts, L, hx) {
    const target = ((hx - L.x) / Math.max(1, L.pw)) * this._tsSlots();
    const slots = this._slots(pts.length);
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dist = Math.abs(slots[i] - target);
      if (dist < bd) { bd = dist; best = i; }
    }
    return { i: best, slot: slots[best] };
  }

  /* ═════════════ 可见范围（滚轮缩放 / 拖拽平移）═════════════ */
  _visRange(total, L) {
    const maxBars = Math.max(20, Math.floor(L.pw / 3));
    if (this._vis === null || this._vis === undefined) {
      this._vis = Math.min(total, Math.min(maxBars, 120));
      this._offs = 0;
    }
    this._vis = clamp(Math.round(this._vis), Math.min(20, total), total);
    this._offs = clamp(Math.round(this._offs), 0, Math.max(0, total - this._vis));
    const to = clamp(total - 1 - this._offs, this._vis - 1, total - 1);
    const from = clamp(to - this._vis + 1, 0, Math.max(0, total - 1));
    return { from, to, vis: this._vis, offs: this._offs };
  }

  _barX(L, from, to) {
    const n = Math.max(1, to - from + 1);
    const step = L.pw / n;
    return (i) => L.x + step * (i - from) + step / 2;
  }

  /* ═════════════ 绘制原语 ═════════════ */
  _scaleY(d0, d1, P) {
    const span = (d1 - d0) || 1;
    return (v) => P.y + P.h - (v - d0) / span * P.h;
  }

  /**
   * 分时横轴格数：优先用数据源给的 virtualDayTicks（服务端 game:start.match.virtualDayTicks），
   * 否则退回模块级默认 TS_SLOTS = 120（上午盘 09:30-11:30）。
   */
  _tsSlots() {
    const d = this.data;
    const n = d ? Number(d.virtualDayTicks) : NaN;
    return Number.isFinite(n) && n >= 2 ? n : TS_SLOTS;
  }

  /**
   * 分时横坐标：t → 上午盘 0..TS_SLOTS 格（09:30 = 0，11:30 = TS_SLOTS）。
   * 新时间模型只有上午盘，不再有 13:00-15:00 的午休压缩分支；
   * 落在时段之外的时间戳统一 clamp 到 0..TS_SLOTS。
   */
  _slot(t, i, n) {
    const N = this._tsSlots();
    if (Number.isFinite(t) && t > 0) {
      const d = new Date(t);
      if (Number.isFinite(d.getTime())) {
        const slot = (d.getHours() * 60 + d.getMinutes()) - 570;   // 09:30 起算
        return clamp(slot, 0, N);
      }
    }
    return n > 1 ? (i / (n - 1)) * N : 0;
  }

  /**
   * 预计算每个点所在的 TS_SLOTS 格位置。
   * 若时间戳整体落在极窄的时段内（例如数据源时间戳不可信 / 全是同一分钟），
   * 则退化为按索引均匀分布，避免整条线挤成一个点。
   */
  _slots(n) {
    const N = this._tsSlots();
    const pts = this.data && Array.isArray(this.data.timesharePoints) ? this.data.timesharePoints : null;
    const out = new Array(n);
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      const t = pts && pts[i] ? Number(pts[i][0]) || 0 : 0;
      const sl = this._slot(t, i, n);
      out[i] = sl;
      seen.add(Math.round(sl));
    }
    /* 只有「时间戳完全不可用」才退化为按索引均匀铺满：
       以前的条件是「当天跨度 < 60 分钟」，结果每天开盘十几秒，线就被强行拉满整个横轴
       （看着像分时图瞬间跑完），过了 60 分钟又突然缩回左边；日切后再次拉满
       （看着像收盘不收、还在继续跑）。真实时间戳是逐分钟推进的，必须按真实槽位画。 */
    if (seen.size <= 1) {
      for (let i = 0; i < n; i++) out[i] = n > 1 ? (i / (n - 1)) * N : N / 2;
    }
    return out;
  }

  _baseX(L, n) {
    const N = this._tsSlots();
    const slots = this._slots(n);
    const cache = new Array(n);
    for (let i = 0; i < n; i++) cache[i] = L.x + (slots[i] / N) * L.pw;
    return (i) => cache[i];
  }

  /** pts: [{x,y}, ...]（自动跳过非法点） */
  _polyline(pts, style, width, sec) {
    if (!pts || pts.length < 2) return;
    const clean = [];
    for (const p of pts) {
      if (!p) continue;
      const x = Number(p.x);
      const y = Number(p.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      clean.push([x, y]);
    }
    if (clean.length < 2) return;
    const ctx = this.ctx;
    const area = sec || (this._L && this._L.main) || { x: 0, y: 0, w: this.canvas.clientWidth || 1, h: this.canvas.clientHeight || 1 };
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(clean[0][0], clean[0][1]);
    for (let i = 1; i < clean.length; i++) ctx.lineTo(clean[i][0], clean[i][1]);
    ctx.strokeStyle = style;
    ctx.lineWidth = width || 1;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }

  _frame(C, sec) {
    if (!sec) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(sec.x) + 0.5, Math.round(sec.y) + 0.5, Math.max(1, Math.round(sec.w)) - 1, Math.max(1, Math.round(sec.h)) - 1);
    ctx.restore();
  }

  _zeroLine(C, sec, y) {
    if (!sec) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = C.gridDash;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sec.x, Math.round(y) + 0.5);
    ctx.lineTo(sec.x + sec.w, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  _label(C, x, y, text, color, align, baseline) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = '11px ' + this._fontFam();
    ctx.textAlign = align || 'left';
    ctx.textBaseline = baseline || 'middle';
    ctx.fillText(String(text), x, y);
    ctx.restore();
  }

  _lastBadge(L, C, price, y, up) {
    if (!Number.isFinite(price) || !Number.isFinite(y)) return;
    const ctx = this.ctx;
    const yy = Math.round(clamp(y, L.main.y + 8, L.main.y + L.main.h - 8));
    const txt = fmt2(price);
    ctx.save();
    ctx.font = '11px ' + this._fontFam();
    const tw = ctx.measureText(txt).width + 9;
    ctx.fillStyle = up ? C.up : C.down;
    ctx.fillRect(L.x + L.pw + 1, yy - 7, Math.max(tw, L.roW - 6), 14);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, L.x + L.pw + 5, yy);
    ctx.restore();
  }

  _rgba(color, a) {
    const s = String(color).trim();
    if (s.startsWith('rgb')) {
      const nums = s.replace(/[^0-9.]+/g, ' ').trim().split(/\s+/).map(Number);
      if (nums.length >= 3 && nums.every((n) => Number.isFinite(n))) {
        return 'rgba(' + nums[0] + ',' + nums[1] + ',' + nums[2] + ',' + a + ')';
      }
      return s;
    }
    let h = s.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    if (!Number.isFinite(n)) return 'rgba(128,128,128,' + a + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /** 分时格号 → HH:MM（09:30 起算，11:30 = 上午收盘） */
  _slotLabel(slot) {
    const N = this._tsSlots();
    const m = clamp(Math.round(slot), 0, N);
    const t = 570 + m;
    return pad2(Math.floor(t / 60)) + ':' + pad2(t % 60);
  }

  _pc() {
    const d = this.data;
    if (!d) return 0;
    if (Number.isFinite(Number(d.prevClose)) && Number(d.prevClose) > 0) return Number(d.prevClose);
    if (d.type === 'timeshare' && Array.isArray(d.timesharePoints) && d.timesharePoints.length) {
      const first = d.timesharePoints[0];
      if (first && Number.isFinite(Number(first[1]))) return Number(first[1]);
    }
    if (Array.isArray(d.bars) && d.bars.length) {
      const b = normBars(d.bars);
      if (b.length) return b[0][1];
    }
    return 0;
  }

  /* ═════════════ 交互 ═════════════ */
  _bind() {
    const c = this.canvas;
    const push = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this._unbinds.push(() => target.removeEventListener(type, fn, opts));
    };

    push(c, 'mousemove', (e) => {
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      this.hover = { x, y };
      if (this._drag && this._drag.active) {
        const L = this._L;
        const bars = this.data && this.data.type !== 'timeshare' && Array.isArray(this.data.bars) ? this.data.bars.length : 0;
        if (L && L.pw > 0 && bars) {
          const perBar = L.pw / Math.max(1, this._vis || 1);
          const shift = Math.round((this._drag.x - x) / Math.max(1, perBar));
          this._offs = clamp(this._drag.offs + shift, 0, Math.max(0, bars - (this._vis || 1)));
        }
      }
      this._schedule();
    });

    push(c, 'mouseleave', () => {
      this.hover = null;
      this._schedule();
    });

    push(c, 'mousedown', (e) => {
      if (e.button !== 0) return;
      const r = c.getBoundingClientRect();
      this._drag = { active: true, x: e.clientX - r.left, offs: this._offs || 0 };
    });

    push(window, 'mouseup', () => {
      if (this._drag) {
        this._drag.active = false;
        this._drag = null;
        c.style.cursor = '';
      }
    });

    push(c, 'dblclick', () => {
      this._vis = null;
      this._offs = 0;
      this._schedule();
    });

    push(c, 'wheel', (e) => {
      const d = this.data;
      if (!d || d.type === 'timeshare' || !Array.isArray(d.bars) || !d.bars.length) return;
      e.preventDefault();
      const total = d.bars.length;
      const cur = this._vis === null || this._vis === undefined ? Math.min(total, 120) : this._vis;
      const factor = e.deltaY > 0 ? 1.2 : 0.83;
      this._vis = clamp(Math.round(cur * factor), Math.min(20, total), total);
      this._offs = clamp(this._offs || 0, 0, Math.max(0, total - this._vis));
      this._schedule();
    }, { passive: false });
  }

  _schedule() {
    if (this._raf) return;
    const raf = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
    this._raf = raf(() => {
      this._raf = 0;
      this.render();
    });
  }

  /* ═════════════ 清理 ═════════════ */
  destroy() {
    if (this._raf) {
      const caf = window.cancelAnimationFrame || clearTimeout;
      try { caf(this._raf); } catch (e) { /* ignore */ }
    }
    this._raf = 0;
    for (const off of this._unbinds) {
      try { off(); } catch (e) { /* ignore */ }
    }
    this._unbinds = [];
    this.data = null;
    this.hover = null;
    this._indic = null;
    this._L = null;
    return this;
  }
}

export default Chart;
