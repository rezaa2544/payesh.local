/* ═══════════════════════════════════════════════════════════════════
   کتابخانهٔ کوچک امضای S3 — بدون هیچ وابستگی، برای مرورگر و Node
   چرا خودمان؟ چون گوشی‌ها بعضی وقت‌ها صفحه را روی http باز می‌کنند و
   WebCrypto (window.crypto.subtle) آنجا در دسترس نیست. این پیاده‌سازی
   فقط از حساب بیتی استفاده می‌کند و همه‌جا کار می‌کند.
   ═══════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PayeshSig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ── SHA-256 ─────────────────────────────────────────────────────── */
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0xd800 || c >= 0xe000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else {
        i++;
        c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return new Uint8Array(out);
  }

  function sha256(input) {
    const msg = typeof input === 'string' ? utf8(input) : input;
    const len = msg.length;
    const bitLen = len * 8;
    const blocks = ((len + 8) >> 6) + 1;
    const padded = new Uint8Array(blocks * 64);
    padded.set(msg);
    padded[len] = 0x80;
    /* طول پیام در ۸ بایت آخر (بزرگ‌ترین ۳۲ بیت کافی است برای پیام‌های ما) */
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    const dv = new DataView(padded.buffer);
    dv.setUint32(blocks * 64 - 8, hi);
    dv.setUint32(blocks * 64 - 4, lo);

    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);

    for (let b = 0; b < blocks; b++) {
      const off = b * 64;
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const w15 = W[i - 15], w2 = W[i - 2];
        const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
        const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & bb) ^ (a & c) ^ (bb & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + bb) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }

    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }

  function hmac(key, msg) {
    let k = typeof key === 'string' ? utf8(key) : key;
    const m = typeof msg === 'string' ? utf8(msg) : msg;
    if (k.length > 64) k = sha256(k);
    const block = new Uint8Array(64);
    block.set(k);
    const ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) { ipad[i] = block[i] ^ 0x36; opad[i] = block[i] ^ 0x5c; }

    const inner = new Uint8Array(64 + m.length);
    inner.set(ipad); inner.set(m, 64);
    const innerHash = sha256(inner);

    const outer = new Uint8Array(64 + 32);
    outer.set(opad); outer.set(innerHash, 64);
    return sha256(outer);
  }

  function hex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }
  const sha256hex = str => hex(sha256(str));
  const hmacHex = (k, m) => hex(hmac(k, m));

  /* ── RFC3986 (همان چیزی که AWS می‌خواهد) ─────────────────────────── */
  function uriEncode(str, keepSlash) {
    let out = '';
    const bytes = utf8(String(str));
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      const ch = String.fromCharCode(c);
      if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) ||
        ch === '-' || ch === '_' || ch === '.' || ch === '~' || (keepSlash && ch === '/')) {
        out += ch;
      } else {
        out += '%' + (c < 16 ? '0' : '') + c.toString(16).toUpperCase();
      }
    }
    return out;
  }

  function amzDate(d) {
    const iso = (d || new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return iso; /* 20240101T120000Z */
  }

  /* ── امضای درخواست (SigV4) ───────────────────────────────────────── */
  function sign(opts) {
    const method = (opts.method || 'GET').toUpperCase();
    const region = opts.region || 'us-east-1';
    const service = opts.service || 's3';
    const host = opts.host;
    const path = opts.path || '/';
    const query = opts.query || {};          /* {k: v} */
    const headers = Object.assign({}, opts.headers || {});
    const body = opts.body || '';
    const amzdate = opts.amzDate || amzDate();
    const datestamp = amzdate.slice(0, 8);

    const payloadHash = headers['x-amz-content-sha256'] || sha256hex(body);

    const canonicalUri = path.split('/').map(p => uriEncode(p, false)).join('/') || '/';
    const qKeys = Object.keys(query).sort();
    const canonicalQuery = qKeys.map(k => uriEncode(k) + '=' + uriEncode(query[k])).join('&');

    const all = Object.assign({}, headers, { host, 'x-amz-date': amzdate });
    /* S3 حتماً هدر هش محتوا را می‌خواهد؛ سرویس‌های دیگر نه */
    if (service === 's3') all['x-amz-content-sha256'] = payloadHash;
    const names = Object.keys(all).map(k => k.toLowerCase()).sort();
    const canonicalHeaders = names.map(n => n + ':' + String(all[findKey(all, n)]).trim() + '\n').join('');
    const signedHeaders = names.join(';');

    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = datestamp + '/' + region + '/' + service + '/aws4_request';
    const stringToSign = ['AWS4-HMAC-SHA256', amzdate, scope, sha256hex(canonicalRequest)].join('\n');

    let k = hmac('AWS4' + opts.secret, datestamp);
    k = hmac(k, region);
    k = hmac(k, service);
    k = hmac(k, 'aws4_request');
    const signature = hmacHex(k, stringToSign);
    const authorization = 'AWS4-HMAC-SHA256 Credential=' + opts.accessKey + '/' + scope +
      ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

    const outHeaders = {};
    for (const key of Object.keys(all)) if (key.toLowerCase() !== 'host') outHeaders[key] = all[key];
    outHeaders['Authorization'] = authorization;
    return { url: (opts.scheme || 'https') + '://' + host + canonicalUri + (canonicalQuery ? '?' + canonicalQuery : ''), headers: outHeaders, signature, canonicalRequest, stringToSign };
  }

  function findKey(obj, lower) {
    for (const k of Object.keys(obj)) if (k.toLowerCase() === lower) return k;
    return lower;
  }

  return { sha256, sha256hex, hmac, hmacHex, hex, utf8, uriEncode, amzDate, sign };
});
