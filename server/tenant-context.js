'use strict';
/* ═══════════════════════════════════════════════════════════════════
   زمینهٔ مستأجر برای بدنهٔ محصول (F‑05)
   ───────────────────────────────────────────────────────────────────
   قاعده‌های سخت:
   ۱) مستأجر (tenant) فقط از نشست/سرور می‌آید؛ هیچ کلید کلاینتی
      (`tenant_id`, `tenantId`, `school_id`, `schoolId`) پذیرفته نمی‌شود.
   ۲) `school_id` میدان قدیمی محصول است و همیشه از همین‌جا مهر می‌شود؛
      مقدار ارسالی کلاینت نادیده گرفته می‌شود.
   ۳) هر ردیف ذخیره‌شده متعلق به همین مستأجر است؛ خواندن/نوشتن متقاطع
      در لایه‌های بالاتر (sync/outbox/restore) و در پایگاه‌داده (RLS) رد
      می‌شود.
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('node:crypto');

const SCHOOL_ID = 1;
const TENANT_FIELDS = ['tenant_id', 'tenantId', 'school_id', 'schoolId'];

/* UUID پایدار برای مدرسهٔ محلی (tenant واحد نصب) — قابل تنظیم با محیط */
function tenantFor(schoolId = SCHOOL_ID) {
  const override = String(process.env.PAYESH_TENANT_ID || '').trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(override)) return override.toLowerCase();
  const h = crypto.createHash('sha256').update('payesh-tenant:' + String(schoolId)).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), '5' + h.slice(13, 16), ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20), h.slice(20, 32)].join('-');
}

/* مستأجرِ همین درخواست — فقط از نشست (actor)؛ بدون actor ⇒ مستأجر نصب */
function tenantOf(actor) {
  const sid = actor && actor.user && actor.user.school_id != null ? Number(actor.user.school_id) : SCHOOL_ID;
  return tenantFor(Number.isFinite(sid) ? sid : SCHOOL_ID);
}

/* حذف هر میدان مستأجرِ ارسالی کلاینت (بدون تغییر بقیهٔ داده) */
function sanitize(data) {
  if (!data || typeof data !== 'object') return {};
  const clean = Object.assign({}, data);
  for (const f of TENANT_FIELDS) delete clean[f];
  return clean;
}

/* مهر مستأجر روی ردیف؛ همیشه سرور تعیین می‌کند.
   در پایگاه‌دادهٔ محلی فقط `school_id` مهر می‌شود (کلید قدیمی محصول)؛
   ستون واقعیِ tenant در جدول چندمستأجری PostgreSQL است و از توکن می‌آید. */
function stamp(data, actor) { // eslint-disable-line no-unused-vars
  const clean = sanitize(data);
  clean.school_id = SCHOOL_ID;
  return clean;
}

/* آیا این ردیف به مستأجر این درخواست تعلق دارد؟ (fail-closed) */
function owns(row, actor) {
  if (!row || typeof row !== 'object') return false;
  if (row.tenant_id && String(row.tenant_id) !== tenantOf(actor)) return false;
  if (row.school_id != null && Number(row.school_id) !== SCHOOL_ID) return false;
  return true;
}

/* آیا دادهٔ ورودی کلاینتی حاوی میدان مستأجر است؟ (برای آزمون منفی) */
function carriesTenantField(data) {
  if (!data || typeof data !== 'object') return false;
  return TENANT_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(data, f));
}

module.exports = { SCHOOL_ID, TENANT_FIELDS, tenantFor, tenantOf, sanitize, stamp, owns, carriesTenantField };
