'use strict';
/* ═══════════════════════════════════════════════════════════════════
   سرور ایستای پنل مالک + پروکسی same-origin — PR-3 · ردیف ۹۸

   پنل روی مبدأ/پورت جدا از اپ مدرسه سرو می‌شود (قانون اساسی §پنل مالک).
   مرورگر فقط با همین مبدأ حرف می‌زند؛ این سرور `/api/platform/v1/*` را به
   Gateway (PAYESH_PLATFORM_UPSTREAM) می‌فرستد. سخت‌گیری‌ها:

     · CSP سخت، بدون inline/eval/منبع خارجی؛ frame-ancestors 'none'
     · فقط GET/POST/DELETE و فقط زیر /api/platform/v1/
     · هدرهای درخواست allowlist (authorization, content-type, accept,
       x-request-id)؛ cookie و هر هدر دیگری به upstream نمی‌رود
     · POST فقط application/json معتبر و ≤ 32KB
     · پاسخ upstream: redirect ⇒ 502؛ غیر JSON ⇒ 502؛ set-cookie حذف می‌شود
     · بدون PAYESH_PLATFORM_UPSTREAM ⇒ 503 upstream_not_configured (fail-closed)

   اجرا:
     PAYESH_PLATFORM_UPSTREAM=http://127.0.0.1:8090 \
     PAYESH_OWNER_PANEL_PORT=8095 node apps/owner-panel/server/static-server.js
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const API_PREFIX = '/api/platform/v1';
const MAX_BODY = 32 * 1024;
const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self'",
  "connect-src 'self'", "manifest-src 'self'", "font-src 'self'", "base-uri 'none'",
  "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const FORWARD_REQ_HEADERS = ['authorization', 'content-type', 'accept', 'x-request-id'];
const FORWARD_RES_HEADERS = ['content-type', 'cache-control', 'x-request-id', 'x-platform-instance',
  'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-window-sec'];
const METHODS = new Set(['GET', 'POST', 'DELETE']);

function send(res, status, headers, body) {
  res.writeHead(status, Object.assign({}, SECURITY_HEADERS, headers));
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(obj));
}

function readBody(req, limit) {
  /* بیش از سقف: بقیهٔ بدنه دور ریخته می‌شود (نه نگه‌داری در حافظه) تا پاسخ
     413 به‌جای قطع ناگهانی اتصال به کلاینت برسد. */
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('too large'), { code: 'body_too_large' }));
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname, webRoot) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad_path' }); }
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('\0') || rel.includes('\\')) return sendJson(res, 400, { ok: false, error: 'bad_path' });
  const file = path.resolve(webRoot, '.' + rel);
  if (file !== webRoot && !file.startsWith(webRoot + path.sep)) return sendJson(res, 404, { ok: false, error: 'not_found' });
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) return sendJson(res, 404, { ok: false, error: 'not_found' });
  let st;
  try { st = fs.statSync(file); } catch (e) { return sendJson(res, 404, { ok: false, error: 'not_found' }); }
  if (!st.isFile()) return sendJson(res, 404, { ok: false, error: 'not_found' });
  const headers = { 'content-type': type, 'content-length': String(st.size),
    'cache-control': type.startsWith('text/html') ? 'no-store' : 'no-cache' };
  if (req.method === 'HEAD') return send(res, 200, headers, '');
  return send(res, 200, headers, fs.readFileSync(file));
}

async function proxy(req, res, url, upstream) {
  if (!upstream) return sendJson(res, 503, { ok: false, error: 'upstream_not_configured' });
  if (!METHODS.has(req.method)) return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  let body = null;
  if (req.method === 'POST') {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'unsupported_media_type' });
    try { body = await readBody(req, MAX_BODY); } catch (e) {
      return sendJson(res, e.code === 'body_too_large' ? 413 : 400, { ok: false, error: e.code === 'body_too_large' ? 'body_too_large' : 'bad_body' });
    }
    if (body.length) { try { JSON.parse(body.toString('utf8')); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad_json' }); } }
  } else if (Number(req.headers['content-length'] || 0) > 0) {
    return sendJson(res, 400, { ok: false, error: 'unexpected_body' });
  }

  const target = new URL(url.pathname + url.search, upstream);
  const headers = {};
  for (const k of FORWARD_REQ_HEADERS) if (req.headers[k]) headers[k] = String(req.headers[k]);
  if (body) headers['content-length'] = String(body.length);
  const lib = target.protocol === 'https:' ? https : http;

  await new Promise((resolve) => {
    const up = lib.request(target, { method: req.method, headers, timeout: 15000 }, (ur) => {
      const status = ur.statusCode || 502;
      if (status >= 300 && status < 400) { ur.resume(); sendJson(res, 502, { ok: false, error: 'upstream_redirect_refused' }); return resolve(); }
      const ct = String(ur.headers['content-type'] || '');
      if (!ct.toLowerCase().startsWith('application/json')) { ur.resume(); sendJson(res, 502, { ok: false, error: 'upstream_bad_content_type' }); return resolve(); }
      const chunks = []; let size = 0; let aborted = false;
      ur.on('data', (c) => { size += c.length; if (size > 4 * 1024 * 1024) { aborted = true; ur.destroy(); } else chunks.push(c); });
      ur.on('end', () => {
        if (aborted) { sendJson(res, 502, { ok: false, error: 'upstream_too_large' }); return resolve(); }
        const out = {};
        for (const k of FORWARD_RES_HEADERS) if (ur.headers[k]) out[k] = ur.headers[k];
        out['cache-control'] = 'no-store';
        send(res, status, out, Buffer.concat(chunks));
        resolve();
      });
      ur.on('error', () => { if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'upstream_unavailable' }); resolve(); });
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => { if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'upstream_unavailable' }); resolve(); });
    if (body) up.write(body);
    up.end();
  });
}

function createOwnerPanelServer(options = {}) {
  const webRoot = path.resolve(options.webRoot || WEB_ROOT);
  let upstream = null;
  if (options.upstream) {
    const u = new URL(String(options.upstream));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('upstream must be http(s)');
    if (u.username || u.password) throw new Error('upstream must not embed credentials');
    upstream = u.origin;
  }
  return http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://owner-panel.invalid'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad_url' }); }
    if (url.pathname === API_PREFIX || url.pathname.startsWith(API_PREFIX + '/')) {
      return proxy(req, res, url, upstream).catch(() => { if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'upstream_unavailable' }); });
    }
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'not_found' });
    return serveStatic(req, res, url.pathname, webRoot);
  });
}

module.exports = { createOwnerPanelServer, CSP, SECURITY_HEADERS, WEB_ROOT, API_PREFIX,
  FORWARD_REQ_HEADERS, FORWARD_RES_HEADERS };

if (require.main === module) {
  const port = Number(process.env.PAYESH_OWNER_PANEL_PORT || 8095);
  const host = process.env.PAYESH_OWNER_PANEL_HOST || '127.0.0.1';
  const srv = createOwnerPanelServer({ upstream: process.env.PAYESH_PLATFORM_UPSTREAM || null });
  srv.listen(port, host, () => {
    console.log(`owner-panel on http://${host}:${port}  upstream=${process.env.PAYESH_PLATFORM_UPSTREAM ? 'configured' : 'NOT CONFIGURED (fail-closed)'}`);
  });
}
