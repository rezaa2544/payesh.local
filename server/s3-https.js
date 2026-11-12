'use strict';
/* ═══════════════════════════════════════════════════════════════════
   درخواست HTTP(S) سمت سرور برای صندوقچه — جایگزین fetch در s3mini فقط روی سرور.
   تنها تفاوت با fetch: فهرست ریشه = ریشه‌های Node + زنجیر رسمی Let's Encrypt
   (server/le-trust.js) تا گواهی نسل Y آروان پذیرفته شود. بررسی گواهی خاموش نمی‌شود.
   ═══════════════════════════════════════════════════════════════════ */
const http = require('http');
const https = require('https');
const { caList } = require('./le-trust');

const MAX_BODY = 64 * 1024 * 1024;

function trustFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const body = opts.body == null || opts.body === '' ? null : Buffer.from(opts.body);
    const headers = Object.assign({}, opts.headers || {});
    if (body) headers['content-length'] = String(body.length);
    const req = (secure ? https : http).request(u, {
      method: opts.method || 'GET',
      headers,
      ca: secure ? caList() : undefined,
      timeout: opts.timeoutMs || 30000,
      signal: opts.signal,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(new Error('response_too_large')); return; }
        chunks.push(c);
      });
      res.on('error', reject);
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: {
            get(name) {
              const v = res.headers[String(name).toLowerCase()];
              return v == null ? null : (Array.isArray(v) ? v.join(', ') : String(v));
            },
          },
          text: async () => buf.toString('utf8'),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { trustFetch };
