/* ═══════════════════════════════════════════════════════════════════
   PBKDF2-HMAC-SHA256 — نسخهٔ کوچکِ جاوااسکریپتی

   چرا لازم است: بررسی رمز روی گوشی (بدون سرور) با PBKDF2 انجام می‌شود.
   جاهای امن (https) WebCrypto هست و از همان استفاده می‌کنیم؛ ولی اگر
   برنامه از یک آدرس ناامن (http داخل شبکه) باز شود، WebCrypto.subtle در
   دسترس نیست و ورود باید باز هم کار کند. این فایل همان محاسبه را در
   جاوااسکریپت انجام می‌دهد.
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function sha256(bytes) {
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const len = bytes.length;
    const withOne = len + 1;
    const total = withOne + ((64 - ((withOne + 8) % 64)) % 64) + 8;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    const bitLenHi = Math.floor(len * 8 / 0x100000000);
    const bitLenLo = (len * 8) >>> 0;
    buf[total - 8] = (bitLenHi >>> 24) & 0xff; buf[total - 7] = (bitLenHi >>> 16) & 0xff;
    buf[total - 6] = (bitLenHi >>> 8) & 0xff; buf[total - 5] = bitLenHi & 0xff;
    buf[total - 4] = (bitLenLo >>> 24) & 0xff; buf[total - 3] = (bitLenLo >>> 16) & 0xff;
    buf[total - 2] = (bitLenLo >>> 8) & 0xff; buf[total - 1] = bitLenLo & 0xff;

    const w = new Uint32Array(64);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) {
        w[i] = (buf[off + i * 4] << 24) | (buf[off + i * 4 + 1] << 16) | (buf[off + i * 4 + 2] << 8) | buf[off + i * 4 + 3];
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = (H[i] >>> 24) & 0xff; out[i * 4 + 1] = (H[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (H[i] >>> 8) & 0xff; out[i * 4 + 3] = H[i] & 0xff;
    }
    return out;
  }

  function hmac(key, msg) {
    let k = key;
    if (k.length > 64) k = sha256(k);
    const block = new Uint8Array(64);
    block.set(k);
    const inner = new Uint8Array(64 + msg.length);
    const outer = new Uint8Array(64 + 32);
    for (let i = 0; i < 64; i++) { inner[i] = block[i] ^ 0x36; outer[i] = block[i] ^ 0x5c; }
    inner.set(msg, 64);
    outer.set(sha256(inner), 64);
    return sha256(outer);
  }

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function pbkdf2(password, salt, iterations, dkLen) {
    const pw = typeof password === 'string' ? utf8(password) : password;
    const saltBytes = typeof salt === 'string' ? utf8(salt) : salt;
    const want = dkLen || 32;
    const blocks = Math.ceil(want / 32);
    const out = new Uint8Array(blocks * 32);
    for (let b = 1; b <= blocks; b++) {
      const idx = new Uint8Array(4);
      idx[0] = (b >>> 24) & 0xff; idx[1] = (b >>> 16) & 0xff; idx[2] = (b >>> 8) & 0xff; idx[3] = b & 0xff;
      const first = new Uint8Array(saltBytes.length + 4);
      first.set(saltBytes); first.set(idx, saltBytes.length);
      let u = hmac(pw, first);
      const acc = u.slice();
      for (let i = 1; i < iterations; i++) {
        u = hmac(pw, u);
        for (let j = 0; j < 32; j++) acc[j] ^= u[j];
      }
      out.set(acc, (b - 1) * 32);
    }
    return out.slice(0, want);
  }

  function hex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
  }

  root.PayeshHash = { sha256, hmac, pbkdf2, hex, utf8 };
})(typeof globalThis !== 'undefined' ? globalThis : this);
