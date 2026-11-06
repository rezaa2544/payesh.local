'use strict';
// ابزار پایهٔ نمونهٔ ۲۱: هش پایدار، پاکت رمزی AES‑256‑GCM، کلید مستأجر
// مرجع: ۱۵ §۲.۱ (پاکت رمز، AAD) · ۱۶‑ب §۳.۱ گام ۶ (بازرمزنگاری کلید مستأجر)

const crypto = require('node:crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

function seal(key, value, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('hex') };
}

function open(key, box, aad) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'hex'));
    if (aad) d.setAAD(Buffer.from(String(aad), 'utf8'));
    d.setAuthTag(Buffer.from(box.tag, 'hex'));
    const p = Buffer.concat([d.update(Buffer.from(box.ct, 'hex')), d.final()]);
    return { ok: true, value: JSON.parse(p.toString('utf8')) };
  } catch {
    return { ok: false, reason: 'undecryptable' };   // جابه‌جایی مستأجر/دست‌کاری ⇒ شکست AEAD
  }
}

const newKey = () => crypto.randomBytes(32);

module.exports = { sha256, stableStringify, seal, open, newKey };
