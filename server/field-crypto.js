'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۸۷ — رمزنگاری فیلدیِ دادهٔ حساس (AEAD) با کلید از محیط

   چه چیزی رمز می‌شود (SEALED):
     • users: کد ملی و کد ملی پدر/مادر و شمارهٔ شناسنامه
     • counselor_notes: همهٔ فیلدها به‌جز کلیدهای ارجاعی (id و *_id) و
       زمان‌ها — یعنی متن یادداشت مشاور هرگز خام در پایگاه داده نیست.

   قالب مقدارِ مهرشده (رشته):
       enc:f1:<kid>:<iv base64url 12B>:<ciphertext||tag base64url>
   الگوریتم AES-256-GCM. داده‌ی وابسته (AAD) = «payesh/f1|کالکشن|id|فیلد|kid»
   ⇒ کپی‌کردن یک مقدارِ مهرشده به ردیف یا فیلد دیگر باز نمی‌شود.
   مقدار با JSON کدگذاری می‌شود تا نوع (رشته/عدد/شیء) حفظ شود.

   کلید فقط از محیط (هرگز از مخزن و هرگز از خودِ پایگاه داده):
       PAYESH_FIELD_KEYS="k2:<base64 32B>,k1:<base64 32B>"
   اولین کلید «فعال» است (برای نوشتن)؛ بقیه فقط برای خواندن و چرخش.
       PAYESH_FIELD_CRYPTO=required  ⇒ بدون کلید، سرور بالا نمی‌آید.
   کلید اصلی / KMS کارِ مالک است؛ آزمون‌ها کلید تصادفی در زمان اجرا می‌سازند.

   چرخش کلید: کلید نو را اول فهرست بگذارید (کلید قدیم پشتش بماند)،
   سپس rekey (tools/field-rekey-87.mjs یا store.rekeyFields()) همهٔ
   مقادیر را با کلید نو دوباره مهر می‌کند؛ بعد کلید قدیم را بردارید.
   مقدارِ مهرشده‌ای که کلیدش نیست ⇒ خطای field_key_unavailable (fail-closed).
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('node:crypto');

const PREFIX = 'enc:f1:';
const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;

const SEALED = {
  users: { fields: ['national_id', 'father_nid', 'mother_nid', 'shenasname_serial', 'shenasname_seri'] },
  counselor_notes: { all: true, plain: /^(id|[a-z0-9_]+_id|created_at|updated_at|_version|_updated_at)$/ },
};

class FieldCryptoError extends Error {
  constructor(code, detail) { super(code + (detail ? ': ' + detail : '')); this.code = code; this.status = 500; }
}

function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function unb64u(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

/* «k2:base64,k1:base64» ⇒ { active, keys: Map } — کلید نامعتبر ⇒ خطا (بی‌صدا رد نمی‌شود) */
function parseKeyring(spec) {
  const keys = new Map();
  let active = null;
  const text = String(spec || '').trim();
  if (!text) return { active: null, keys };
  for (const part of text.split(',').map(s => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i < 1) throw new FieldCryptoError('bad_field_keys', 'entry must be kid:base64');
    const kid = part.slice(0, i);
    const key = Buffer.from(part.slice(i + 1), 'base64');
    if (!KID_RE.test(kid)) throw new FieldCryptoError('bad_field_keys', 'bad kid');
    if (key.length !== 32) throw new FieldCryptoError('bad_field_keys', 'key ' + kid + ' must be 32 bytes');
    if (keys.has(kid)) throw new FieldCryptoError('bad_field_keys', 'duplicate kid ' + kid);
    keys.set(kid, key);
    if (!active) active = kid;
  }
  return { active, keys };
}

let cached = null;
function keyring() {
  if (!cached) cached = parseKeyring(process.env.PAYESH_FIELD_KEYS);
  return cached;
}
/* پس از تغییر محیط (چرخش در آزمون یا بارگذاری دوباره) */
function reload(spec) {
  cached = parseKeyring(spec === undefined ? process.env.PAYESH_FIELD_KEYS : spec);
  return cached;
}
function enabled(kr = keyring()) { return !!kr.active; }

/* حالت required: بدون کلید ⇒ شروع نمی‌شود */
function assertConfigured(kr = keyring()) {
  if (String(process.env.PAYESH_FIELD_CRYPTO || '').toLowerCase() === 'required' && !enabled(kr)) {
    throw new FieldCryptoError('field_keys_required', 'PAYESH_FIELD_CRYPTO=required but PAYESH_FIELD_KEYS is empty');
  }
}

function isSealed(v) { return typeof v === 'string' && v.startsWith(PREFIX); }
function kidOf(v) { return isSealed(v) ? v.slice(PREFIX.length).split(':')[0] : null; }

function aad(collection, id, field, kid) {
  return Buffer.from(`payesh/f1|${collection}|${Number(id)}|${field}|${kid}`, 'utf8');
}

function sealValue(collection, id, field, value, kr = keyring()) {
  if (!kr.active) throw new FieldCryptoError('field_key_unavailable', 'no active key');
  const kid = kr.active;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', kr.keys.get(kid), iv);
  c.setAAD(aad(collection, id, field, kid));
  const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final(), c.getAuthTag()]);
  return `${PREFIX}${kid}:${b64u(iv)}:${b64u(ct)}`;
}

function openValue(collection, id, field, sealed, kr = keyring()) {
  const parts = String(sealed).slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new FieldCryptoError('field_corrupt', `${collection}.${field}`);
  const [kid, ivS, ctS] = parts;
  const key = kr.keys.get(kid);
  if (!key) throw new FieldCryptoError('field_key_unavailable', `kid=${kid} (${collection}.${field})`);
  const iv = unb64u(ivS);
  const all = unb64u(ctS);
  if (iv.length !== 12 || all.length < 17) throw new FieldCryptoError('field_corrupt', `${collection}.${field}`);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(aad(collection, id, field, kid));
    d.setAuthTag(all.subarray(all.length - 16));
    const pt = Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8');
    return JSON.parse(pt);
  } catch (e) {
    throw new FieldCryptoError('field_auth_failed', `${collection}.${field}`);
  }
}

function sealedFieldsOf(collection, obj) {
  const cfg = SEALED[collection];
  if (!cfg || !obj || typeof obj !== 'object') return [];
  if (cfg.fields) return cfg.fields.filter(k => Object.prototype.hasOwnProperty.call(obj, k));
  return Object.keys(obj).filter(k => !cfg.plain.test(k));
}
function isSensitiveField(collection, field) {
  const cfg = SEALED[collection];
  if (!cfg) return false;
  return cfg.fields ? cfg.fields.includes(field) : !cfg.plain.test(field);
}

/* شیء خام (متن ساده) ⇒ شیء آمادهٔ ذخیره.
   • فیلدهای حساس مهر می‌شوند (اگر کلید فعال باشد).
   • مقدارِ «شبیه مهرشده» که از بیرون آمده در فیلد غیرحساس پذیرفته نمی‌شود
     (وگرنه کاربر می‌توانست با یک رشتهٔ جعلی خواندن آن ردیف را بشکند). */
function sealRecord(collection, id, obj, kr = keyring()) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = Object.assign({}, obj);
  const sens = new Set(enabled(kr) ? sealedFieldsOf(collection, out) : []);
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (sens.has(k)) {
      if (v === null || v === undefined || v === '') continue;
      out[k] = sealValue(collection, id, k, v, kr);
    } else if (isSealed(v)) {
      out[k] = '';
    }
  }
  return out;
}

/* شیء ذخیره‌شده ⇒ متن ساده (هر فیلدِ مهرشده باز می‌شود؛ کلید نبود ⇒ خطا) */
function openRecord(collection, id, obj, kr = keyring()) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  let out = null;
  for (const k of Object.keys(obj)) {
    if (isSealed(obj[k])) {
      if (!out) out = Object.assign({}, obj);
      out[k] = openValue(collection, id, k, obj[k], kr);
    }
  }
  return out || obj;
}

/* آیا این شیءِ ذخیره‌شده نیاز به مهرِ دوباره دارد؟ (متن سادهٔ قدیمی یا kid قدیمی) */
function needsReseal(collection, obj, kr = keyring()) {
  if (!obj || typeof obj !== 'object' || !enabled(kr)) return false;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (isSealed(v)) { if (kidOf(v) !== kr.active) return true; }
    else if (isSensitiveField(collection, k) && v !== null && v !== undefined && v !== '') return true;
  }
  return false;
}

module.exports = {
  PREFIX, SEALED, FieldCryptoError, parseKeyring, keyring, reload, enabled, assertConfigured,
  isSealed, kidOf, sealValue, openValue, sealRecord, openRecord, needsReseal, isSensitiveField,
  sealedCollections: () => Object.keys(SEALED),
};
