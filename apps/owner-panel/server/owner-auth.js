'use strict';
/* ═══════════════════════════════════════════════════════════════════
   صادرکنندهٔ ورود انسانی پنل مالک — ردیف ۹۸ · تصمیم D‑45 (O‑17 = A)

   · رمز عبور: scrypt (N=2^15, r=8, p=1, 32 بایت) با نمک تصادفی ۱۶ بایتی
   · کد دومرحله‌ای: TOTP مطابق RFC 6238 (HMAC‑SHA1، ۳۰ ثانیه، ۶ رقم، پنجرهٔ ±۱)
   · جلوگیری از تکرار: گام TOTP پذیرفته‌شده باید از آخرین گام ثبت‌شده بزرگ‌تر
     باشد؛ این شرط در دیتابیس (record_login_attempt) اتمیک اعمال می‌شود
   · هیچ رمز/راز/کدی لاگ یا برگردانده نمی‌شود
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('node:crypto');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 };
const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
const MIN_PASSWORD = 12;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function scryptAsync(password, salt, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: p.maxmem },
      (e, key) => (e ? reject(e) : resolve(key)));
  });
}

/** `scrypt$N$r$p$<salt b64url>$<hash b64url>` */
async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new Error(`password must be at least ${MIN_PASSWORD} characters`);
  }
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/* هش ساختگی برای کاربر ناموجود تا زمان پاسخ، وجود حساب را لو ندهد */
let dummyHash = null;
async function verifyPassword(password, stored) {
  let s = String(stored || '');
  const real = /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(s);
  if (!real) {
    if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(18).toString('base64url'));
    s = dummyHash;
  }
  const [, n, r, p, saltB64, keyB64] = s.split('$');
  const params = { N: Number(n), r: Number(r), p: Number(p), keylen: Buffer.from(keyB64, 'base64url').length, maxmem: SCRYPT.maxmem };
  if (params.N > (1 << 17) || params.r > 16 || params.p > 4 || params.keylen < 16 || params.keylen > 64) return false;
  const want = Buffer.from(keyB64, 'base64url');
  const got = await scryptAsync(String(password || ''), Buffer.from(saltB64, 'base64url'), params);
  return real && got.length === want.length && crypto.timingSafeEqual(got, want);
}

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[\s=]/g, '');
  if (!/^[A-Z2-7]+$/.test(clean)) throw new Error('invalid base32');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function newTotpSecret() { return base32Encode(crypto.randomBytes(20)); }

/** HOTP (RFC 4226) با کلید خام */
function hotp(key, counter, digits = TOTP_DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % (10 ** digits)).padStart(digits, '0');
}
function totpStep(nowMs) { return Math.floor(nowMs / 1000 / TOTP_PERIOD); }
function totpAt(secretB32, nowMs, digits = TOTP_DIGITS) { return hotp(base32Decode(secretB32), totpStep(nowMs), digits); }

/** گام منطبق را برمی‌گرداند یا null. مقایسه با زمان ثابت. */
function verifyTotp(secretB32, code, nowMs) {
  const c = String(code || '');
  if (!/^[0-9]{6}$/.test(c)) return null;
  let key;
  try { key = base32Decode(secretB32); } catch (_) { return null; }
  if (key.length < 10) return null;
  const step = totpStep(nowMs);
  let found = null;
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const want = Buffer.from(hotp(key, step + d));
    if (crypto.timingSafeEqual(want, Buffer.from(c)) && found === null) found = step + d;
  }
  return found;
}

function otpauthUri(loginId, secretB32, issuer = 'Payesh Owner') {
  const label = encodeURIComponent(`${issuer}:${loginId}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

/** مرجع بی‌نام برای ممیزی/سهمیه — شناسه یا IP خام ذخیره نمی‌شود */
function ref(kind, value) {
  return crypto.createHash('sha256').update(kind + ':' + String(value || '').trim().toLowerCase()).digest('hex').slice(0, 24);
}

module.exports = {
  SCRYPT, TOTP_PERIOD, TOTP_DIGITS, TOTP_WINDOW, MIN_PASSWORD,
  hashPassword, verifyPassword, base32Encode, base32Decode, newTotpSecret,
  hotp, totpStep, totpAt, verifyTotp, otpauthUri, ref,
};
