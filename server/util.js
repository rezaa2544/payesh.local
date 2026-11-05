'use strict';
/* ابزارهای مشترک سرور — بدون وابستگی بیرونی */
const crypto = require('crypto');

function nowISO() { return new Date().toISOString(); }

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function randomId(bytes = 16) { return crypto.randomBytes(bytes).toString('hex'); }

/* کد پیوند خوانا برای چاپ روی کارت: بدون حروف گیج‌کننده (0/O/1/I) */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(len = 8) {
  const b = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return out;
}

function scryptHash(secret, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(secret), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}
/* نسخهٔ قابل‌بررسی روی گوشی: PBKDF2-SHA256 که مرورگر/WebView هم می‌تواند
   حساب کند (WebCrypto اسکریپت ندارد). همین باعث می‌شود برنامهٔ گوشی بدون
   هیچ سروری، شماره+رمزی که مدیر تعیین کرده را خودش بررسی کند. */
const PBKDF2_ITER = 150000;
function pbkdf2Hash(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(secret), salt, PBKDF2_ITER, 32, 'sha256').toString('hex');
  return 'pbkdf2$' + PBKDF2_ITER + '$' + salt + '$' + hash;
}

function scryptVerify(secret, stored) {
  try {
    const [algo, salt, hash] = String(stored || '').split('$');
    if (algo !== 'scrypt' || !salt || !hash) return false;
    const calc = crypto.scryptSync(String(secret), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'));
  } catch (e) { return false; }
}

/* بررسی رمز، مستقل از قالب ذخیره‌شده: نسخهٔ گوشی (pbkdf2) یا قدیمی (scrypt) */
function verifySecret(secret, stored) {
  const s = String(stored || '');
  if (s.startsWith('pbkdf2$')) {
    const [, iter, salt, hash] = s.split('$');
    if (!iter || !salt || !hash) return false;
    try {
      const calc = crypto.pbkdf2Sync(String(secret), salt, Number(iter), 32, 'sha256').toString('hex');
      return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'));
    } catch (e) { return false; }
  }
  return scryptVerify(secret, s);
}

function normDigits(s) {
  return String(s == null ? '' : s)
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[^\d]/g, '');
}

function validNationalId(id) {
  const s = normDigits(id);
  if (s.length !== 10) return false;
  if (/^(\d)\1{9}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(s[i]) * (10 - i);
  const r = sum % 11;
  const c = Number(s[9]);
  return (r < 2 && c === r) || (r >= 2 && c === 11 - r);
}

function json(obj, status = 200, headers = {}) {
  const body = JSON.stringify(obj);
  return { status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers), body };
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, Number(n) || 0)); }

module.exports = { nowISO, sha256, randomId, randomCode, scryptHash, scryptVerify, pbkdf2Hash, PBKDF2_ITER, verifySecret, normDigits, validNationalId, json, clamp };
