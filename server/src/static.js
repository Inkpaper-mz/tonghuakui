/* ═══════════════════════════════════════════════════════════════
   同花亏 · 静态文件服务（零依赖）
   ─ 仅 GET/HEAD；路径穿越防护；SPA 回落 index.html；
     中文 UTF-8 正确（.js/.mjs → text/javascript; charset=utf-8）
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/* ───────── MIME ───────── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** 是否位于 root 内（root 自身或其子路径） */
function isInside(root, p) {
  const r = path.resolve(root);
  const t = path.resolve(p);
  if (t === r) return true;
  return t.startsWith(r + path.sep);
}

function sendText(res, status, text, extra, isHead) {
  const body = Buffer.from(String(text), 'utf8');
  try {
    res.writeHead(status, Object.assign({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    }, extra || {}));
    res.end(isHead ? undefined : body);
  } catch { /* 客户端已断开 */ }
}

/**
 * @param {string} rootDir 静态资源根目录（绝对路径建议）
 * @returns {(req:{method:string,url?:string}, res:any) => Promise<boolean>} 返回 true 表示已处理
 */
function createStaticHandler(rootDir) {
  const root = path.resolve(rootDir || '.');
  const indexFile = path.join(root, 'index.html');

  return async function staticHandler(req, res) {
    try {
      if (!req || !res) return false;
      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        try {
          res.writeHead(405, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Allow': 'GET, HEAD',
            'Cache-Control': 'no-cache',
          });
          res.end('405 Method Not Allowed');
        } catch { /* ignore */ }
        return true;
      }

      // 1) 取 pathname 并解码
      const rawUrl = req.url || '/';
      const q = rawUrl.indexOf('?');
      const hash = rawUrl.indexOf('#');
      let pathname = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
      if (hash >= 0) pathname = pathname.slice(0, hash);
      let decoded;
      try { decoded = decodeURIComponent(pathname); } catch { decoded = pathname; }
      decoded = decoded.replace(/\\/g, '/');            // Windows 反斜杠一律当分隔符
      decoded = decoded.replace(/^\/+/, '');

      // 2) 规范化 + 防穿越
      const norm = path.normalize(decoded);
      const target = path.resolve(root, norm);
      if (!isInside(root, target)) {
        sendText(res, 403, '403 Forbidden', null, method === 'HEAD');
        return true;
      }

      // 3) 尝试命中文件
      let stat = null;
      try { stat = await fsp.stat(target); } catch { stat = null; }

      if (stat && stat.isDirectory()) {
        const idx = path.join(target, 'index.html');
        try {
          const s2 = await fsp.stat(idx);
          if (s2.isFile()) return await serveFile(req, res, idx, s2, 200);
        } catch { /* 目录无 index.html */ }
        sendText(res, 404, '404 Not Found', null, method === 'HEAD');
        return true;
      }

      if (stat && stat.isFile()) {
        return await serveFile(req, res, target, stat, 200);
      }

      // 4) 不存在
      const ext = path.extname(target);
      if (ext === '' || ext.toLowerCase() === '.html') {
        // SPA：无扩展名的未知路径 → index.html
        try {
          const sIdx = await fsp.stat(indexFile);
          if (sIdx.isFile()) return await serveFile(req, res, indexFile, sIdx, 200);
        } catch { /* 无 index.html */ }
      }
      sendText(res, 404, '404 Not Found', null, method === 'HEAD');
      return true;
    } catch {
      // 出错也不能崩：尽量回 500（可能头已发出，忽略异常）
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end('500 Internal Server Error');
        } else {
          res.end();
        }
      } catch { /* ignore */ }
      return true;
    }
  };
}

async function serveFile(req, res, file, stat, status) {
  const headers = {
    'Content-Type': mimeOf(file),
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'Last-Modified': stat.mtime.toUTCString(),
  };
  const isHead = (req.method || 'GET').toUpperCase() === 'HEAD';
  // HTTP Range（可选支持，便于音频/大文件）
  const range = req.headers && req.headers.range;
  let start = 0;
  let end = stat.size - 1;
  let code = status;
  if (range && /^bytes=\d*-\d*$/.test(String(range))) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    if (!(m[1] === '' && m[2] === '')) {
      if (m[1] === '') {                        // bytes=-N 末尾 N 字节
        const n = parseInt(m[2], 10) || 0;
        start = Math.max(0, stat.size - n);
        end = stat.size - 1;
      } else {
        start = Math.max(0, parseInt(m[1], 10) || 0);
        if (m[2] !== '') end = Math.min(stat.size - 1, parseInt(m[2], 10) || 0);
      }
      if (start > end || start >= stat.size) {
        try {
          res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size, 'Cache-Control': 'no-cache' });
          res.end();
        } catch { /* ignore */ }
        return true;
      }
      code = 206;
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
      headers['Content-Length'] = end - start + 1;
    }
  }

  try {
    res.writeHead(code, headers);
  } catch { return true; }
  if (isHead) { try { res.end(); } catch { /* ignore */ } return true; }

  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
  res.on('close', () => { try { stream.destroy(); } catch { /* ignore */ } });
  stream.pipe(res);
  return true;
}

module.exports = { createStaticHandler, MIME, mimeOf, isInside };
