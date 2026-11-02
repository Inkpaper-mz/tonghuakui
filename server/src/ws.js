/* ═══════════════════════════════════════════════════════════════
   同花亏 · 零依赖 RFC6455 WebSocket 服务端
   ─ 不依赖任何第三方模块；不协商任何扩展（no permessage-deflate）
   ─ 支持：握手校验 / 掩码解帧 / 7·16·64bit 长度 / 分片续帧 /
           ping-pong / close 握手 / 非法帧关闭(1002) / 超限关闭(1009)
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1024 * 1024;          // 单帧/单条消息 1MB
const MAX_FRAME_HEADER = 14;              // 2 + 8 + 4

/* ───────── opcode ───────── */
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xA;

/** 关闭码 → 2 字节 */
function codeBuf(code) {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16BE(code & 0xffff, 0);
  return b;
}

/** 编码一个服务端帧（不加掩码） */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, payload], header.length + len);
}

/* ───────── WSConn ───────── */

let connCounter = 0;

class WSConn extends EventEmitter {
  /**
   * @param {net.Socket} socket
   * @param {object} opts { path, remoteAddress }
   */
  constructor(socket, opts = {}) {
    super();
    this.id = 'c_' + (++connCounter);
    this.socket = socket;
    this.path = opts.path || '/';
    this.remoteAddress = opts.remoteAddress || (socket && socket.remoteAddress) || '';
    this.isAlive = true;
    this.readyState = 'open';        // open | closing | closed
    this.binaryFrames = 0;           // 忽略的二进制帧计数（可观测）
    this.droppedFrames = 0;

    this._buf = Buffer.alloc(0);
    this._frag = null;               // { opcode, parts:[Buffer], size }
    this._closeSent = false;
    this._closeEmitted = false;
    this._closeCode = 1006;
    this._closeReason = '';
  }

  /* ───── 发送 ───── */

  /** @param {object|string|Buffer} data 对象→JSON.stringify；返回是否已写出 */
  send(data) {
    return this._sendFrame(OP_TEXT, data);
  }

  /** 发送一个 ping 帧 */
  ping(payload) {
    const p = Buffer.isBuffer(payload) ? payload : Buffer.alloc(0);
    return this._sendFrame(OP_PING, p, true);
  }

  /** 发送一个 pong 帧 */
  pong(payload) {
    const p = Buffer.isBuffer(payload) ? payload : Buffer.alloc(0);
    return this._sendFrame(OP_PONG, p, true);
  }

  _sendFrame(opcode, data, raw) {
    if (this.readyState !== 'open') return false;
    let payload;
    if (raw) {
      payload = data;
    } else if (typeof data === 'string') {
      payload = Buffer.from(data, 'utf8');
    } else if (Buffer.isBuffer(data)) {
      payload = data;
    } else {
      try {
        payload = Buffer.from(JSON.stringify(data), 'utf8');
      } catch (e) {
        this._fail(e);
        return false;
      }
    }
    if (!Buffer.isBuffer(payload)) payload = Buffer.from(String(payload), 'utf8');
    try {
      const ok = this.socket.write(encodeFrame(opcode, payload));
      return ok !== false;
    } catch (e) {
      this._fail(e);
      return false;
    }
  }

  /* ───── 关闭 ───── */

  close(code = 1000, reason = '') {
    if (this.readyState === 'closed') return;
    if (!this._closeSent) {
      this._closeSent = true;
      let reasonBuf = Buffer.alloc(0);
      try { reasonBuf = Buffer.from(String(reason == null ? '' : reason), 'utf8').slice(0, 123); } catch { /* ignore */ }
      try {
        this.socket.write(encodeFrame(OP_CLOSE, Buffer.concat([codeBuf(code || 1000), reasonBuf])));
      } catch { /* ignore */ }
    }
    if (this.readyState === 'open') this.readyState = 'closing';
    // 给对端 250ms 回 close 帧的机会，然后强制销毁
    this._closeTimer = setTimeout(() => this.terminate(), 250);
    if (this._closeTimer.unref) this._closeTimer.unref();
  }

  terminate() {
    if (this.readyState === 'closed') return;
    if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null; }
    try { this.socket.destroy(); } catch { /* ignore */ }
    this._finalize();
  }

  /**
   * 优雅收尾：先 pause() 停止读取（避免内核因「未读数据 + close」发 RST 而丢掉
   * 我们刚写出的 close 帧），再 end() 发 FIN，最后兜底 destroy()。
   */
  _gracefulEnd(ms = 300) {
    if (this.readyState === 'closed') return;
    const sock = this.socket;
    try { sock.pause(); } catch { /* ignore */ }
    try { sock.end(); } catch { /* ignore */ }
    if (this._closeTimer) clearTimeout(this._closeTimer);
    this._closeTimer = setTimeout(() => {
      this._closeTimer = null;
      try { sock.destroy(); } catch { /* ignore */ }
    }, ms);
    if (this._closeTimer.unref) this._closeTimer.unref();
  }

  /* ───── 内部 ───── */

  _fail(err) {
    if (err) this.emit('error', err);
    this.terminate();
  }

  _closeFrameError(code, reason) {
    if (this.readyState !== 'open' && this.readyState !== 'closing') return;
    const wasOpen = this.readyState === 'open';
    if (!this._closeSent) {
      this._closeSent = true;
      try {
        this.socket.write(encodeFrame(OP_CLOSE, Buffer.concat([codeBuf(code), Buffer.from(String(reason || ''), 'utf8')])));
      } catch { /* ignore */ }
    }
    this.readyState = 'closing';
    if (this._closeCode === 1006) { this._closeCode = code; this._closeReason = String(reason || ''); }
    if (wasOpen) this._gracefulEnd(); else this.terminate();
  }

  _finalize() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    if (this._buf) this._buf = null;
    this._frag = null;
    if (!this._closeEmitted) {
      this._closeEmitted = true;
      try { this.emit('close', this._closeCode, this._closeReason); } catch { /* 监听器异常不得影响其它连接 */ }
    }
  }

  /* 收到 TCP 数据 */
  _onData(chunk) {
    if (this.readyState === 'closed') return;
    try {
      const buf = this._buf;
      this._buf = buf && buf.length ? Buffer.concat([buf, chunk]) : chunk;
      this._parse();
    } catch (e) {
      // 任何解析错误都不能让进程崩溃
      this._closeFrameError(1002, 'protocol error');
    }
  }

  _parse() {
    for (;;) {
      const buf = this._buf;
      if (!buf || buf.length < 2) return;

      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      // RSV 必须为 0（未协商任何扩展）
      if (rsv !== 0) return this._closeFrameError(1002, 'RSV must be 0');
      // 未知 opcode
      if (opcode !== OP_CONT && opcode !== OP_TEXT && opcode !== OP_BIN &&
          opcode !== OP_CLOSE && opcode !== OP_PING && opcode !== OP_PONG) {
        return this._closeFrameError(1002, 'bad opcode');
      }
      // 控制帧必须 FIN 且 payload <= 125
      if (opcode >= 0x8 && (!fin || len > 125)) return this._closeFrameError(1002, 'bad control frame');

      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        const hi = buf.readUInt32BE(off);
        const lo = buf.readUInt32BE(off + 4);
        off += 8;
        if (hi & 0x80000000) return this._closeFrameError(1002, 'bad length'); // 最高位必须为 0
        len = hi * 0x100000000 + lo;
      }

      // 客户端 → 服务端 必须带掩码
      if (!masked) return this._closeFrameError(1002, 'client frame must be masked');
      // 长度超限
      if (len > MAX_PAYLOAD) return this._closeFrameError(1009, 'message too big');

      const need = off + 4 + len;
      if (buf.length < need) {
        // 头部过大（不可能到这里）或数据未收全
        if (off > MAX_FRAME_HEADER) return this._closeFrameError(1002, 'bad header');
        return;
      }

      const maskKey = buf.slice(off, off + 4);
      const payload = Buffer.allocUnsafe(len);
      buf.copy(payload, 0, off + 4, off + 4 + len);
      for (let i = 0; i < len; i++) payload[i] ^= maskKey[i & 3];
      this._buf = buf.slice(off + 4 + len);

      this._handleFrame(fin, opcode, payload);
      if (this.readyState === 'closed') return;
    }
  }

  _handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP_PING:
        this.pong(payload);
        return;
      case OP_PONG:
        this.isAlive = true;
        this.emit('pong', payload);
        return;
      case OP_CLOSE: {
        let code = 1000;
        let reason = '';
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          if (code < 1000 || code === 1004 || code === 1005 || code === 1006 || (code >= 1016 && code < 3000)) code = 1002;
          reason = payload.slice(2).toString('utf8');
        }
        this.readyState = 'closing';
        if (!this._closeSent) {
          this._closeSent = true;
          try { this.socket.write(encodeFrame(OP_CLOSE, Buffer.concat([codeBuf(code === 1002 ? 1002 : 1000), Buffer.alloc(0)]))); } catch { /* ignore */ }
        }
        this._closeCode = code;
        this._closeReason = reason;
        try { this.emit('closeFrame', code, reason); } catch { /* ignore */ }
        // 停读 + FIN，避免未读数据导致 RST
        try { this.socket.pause(); } catch { /* ignore */ }
        try { this.socket.end(); } catch { /* ignore */ }
        if (this._closeTimer) clearTimeout(this._closeTimer);
        this._closeTimer = setTimeout(() => this.terminate(), 200);
        if (this._closeTimer.unref) this._closeTimer.unref();
        return;
      }
      case OP_TEXT:
      case OP_BIN: {
        if (this._frag) return this._closeFrameError(1002, 'expected continuation frame');
        if (fin) {
          if (opcode === OP_TEXT) this._emitText(payload);
          else { this.binaryFrames++; this.emit('binary', payload); }
        } else {
          this._frag = { opcode, parts: [payload], size: payload.length };
        }
        return;
      }
      case OP_CONT: {
        const f = this._frag;
        if (!f) return this._closeFrameError(1002, 'unexpected continuation frame');
        f.parts.push(payload);
        f.size += payload.length;
        if (f.size > MAX_PAYLOAD) return this._closeFrameError(1009, 'message too big');
        if (fin) {
          const full = Buffer.concat(f.parts, f.size);
          this._frag = null;
          if (f.opcode === OP_TEXT) this._emitText(full);
          else { this.binaryFrames++; this.emit('binary', full); }
        }
        return;
      }
      default:
        return this._closeFrameError(1002, 'bad opcode');
    }
  }

  _emitText(payload) {
    const text = payload.toString('utf8');
    // 严格 UTF-8：非法字节序列 → 1007
    if (!this._validUtf8(payload, text)) {
      return this._closeFrameError(1007, 'invalid utf8');
    }
    try { this.emit('message', text); } catch (e) { this.emit('error', e); }
  }

  _validUtf8(buf, text) {
    if (text === undefined) text = buf.toString('utf8');
    // 仅当出现替换字符时才需要复核，避免每次都重新编码
    if (text.indexOf('\uFFFD') < 0) return true;
    try { return Buffer.compare(Buffer.from(text, 'utf8'), buf) === 0; } catch { return false; }
  }
}

/* ───────── WebSocketServer ───────── */

class WebSocketServer extends EventEmitter {
  /**
   * @param {object} opts { server: http.Server, path?: string, maxPayload?: number }
   */
  constructor(opts = {}) {
    super();
    this.server = opts.server || null;
    this.path = opts.path || '/ws';
    this.clients = new Set();
    this._closed = false;
    this._onUpgrade = this._onUpgrade.bind(this);
    if (this.server) this.server.on('upgrade', this._onUpgrade);
  }

  _onUpgrade(req, socket, head) {
    try {
      const url = req.url || '/';
      const q = url.indexOf('?');
      const pathname = q >= 0 ? url.slice(0, q) : url;
      if (this.path && pathname !== this.path) {
        // 不匹配路径：404 并销毁
        try {
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 9\r\n\r\nNot Found');
        } catch { /* ignore */ }
        socket.destroy();
        return;
      }
      const key = req.headers['sec-websocket-key'];
      const version = String(req.headers['sec-websocket-version'] || '');
      const upgrade = String(req.headers['upgrade'] || '').toLowerCase();
      if (!key || upgrade !== 'websocket' || (version !== '13' && version !== '8')) {
        try {
          socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 11\r\n\r\nBad Request');
        } catch { /* ignore */ }
        socket.destroy();
        return;
      }
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
      );
      socket.setNoDelay(true);

      const conn = new WSConn(socket, { path: pathname, remoteAddress: req.socket && req.socket.remoteAddress });
      this.clients.add(conn);

      socket.on('data', (chunk) => conn._onData(chunk));
      socket.on('error', (err) => {
        this.clients.delete(conn);
        try { conn.emit('error', err); } catch { /* ignore */ }
        conn._finalize();
      });
      socket.on('close', () => {
        this.clients.delete(conn);
        conn._finalize();
      });
      socket.on('end', () => { try { socket.end(); } catch { /* ignore */ } });

      if (head && head.length) conn._onData(head);

      this.emit('connection', conn);
    } catch (err) {
      try { socket.destroy(); } catch { /* ignore */ }
      this.emit('error', err);
    }
  }

  /**
   * 心跳：每 30s 调用一次。
   * 上一轮 ping 未回 pong（isAlive=false）的连接直接 terminate；
   * 其余标记 isAlive=false 并发 ping。
   * @returns {{pinged:number, terminated:number}}
   */
  heartbeat() {
    let pinged = 0, terminated = 0;
    for (const conn of Array.from(this.clients)) {
      try {
        if (conn.readyState !== 'open') { conn.terminate(); continue; }
        if (conn.isAlive === false) { terminated++; conn.terminate(); continue; }
        conn.isAlive = false;
        if (conn.ping()) pinged++;
      } catch { /* 单连接异常不影响其它连接 */ }
    }
    return { pinged, terminated };
  }

  /** 向所有 open 连接广播（对象→JSON），返回成功发送数 */
  broadcast(data) {
    let n = 0;
    for (const conn of Array.from(this.clients)) {
      try { if (conn.readyState === 'open' && conn.send(data)) n++; } catch { /* ignore */ }
    }
    return n;
  }

  close(cb) {
    if (this._closed) { if (cb) cb(); return; }
    this._closed = true;
    if (this.server) this.server.removeListener('upgrade', this._onUpgrade);
    const conns = Array.from(this.clients);
    this.clients.clear();
    for (const conn of conns) {
      try { conn.close(1001, 'server shutdown'); } catch { /* ignore */ }
    }
    // 给 close 帧一点时间写出去，然后销毁全部连接
    const t = setTimeout(() => {
      for (const conn of conns) { try { conn.terminate(); } catch { /* ignore */ } }
    }, 80);
    if (t.unref) t.unref();
    if (cb) {
      const t2 = setTimeout(() => { try { cb(); } catch { /* ignore */ } }, 120);
      if (t2.unref) t2.unref();
    }
  }
}

module.exports = { WebSocketServer, WSConn, encodeFrame, MAX_PAYLOAD };
