'use strict';
/* ═══════════════════════════════════════════════════════════════════
   پیش‌فرض‌های صندوقچه — **هیچ کلیدی این‌جا نیست** (D‑23 · F‑04)

   قاعدهٔ سخت (قانون اساسی §۳ بند ۲۲ و D‑23):
     • اعتبارنامهٔ فضای ذخیره‌سازی هرگز در بستهٔ کلاینت و در کد پخته نمی‌شود.
     • کلید فقط از محیط سرور خوانده می‌شود (PAYESH_S3_ACCESS_KEY /
       PAYESH_S3_SECRET) یا از تنظیمات ذخیره‌شده توسط مدیر در همان سرور.
     • آنچه به کلاینت می‌رود فقط «فراداده» است: endpoint/bucket/region/prefix.

   پیش از این، کلیدها همین‌جا base64 شده بودند و اسکریپت bake آن‌ها را
   داخل client/cloud-baked.js می‌ریخت ⇒ هر دانش‌آموز کلید کامل صندوقچه
   را داشت. آن مسیر حذف شد.
   ═══════════════════════════════════════════════════════════════════ */

const DEFAULTS = {
  endpoint: 'https://s3.ir-central1.arvanstorage.ir',
  region: 'ir-central1',
  bucket: '',                                            /* اگر خالی باشد، خودِ سرور صندوقچه را پیدا می‌کند */
  prefix: 'payesh/',
  pathStyle: true,
};

/* تنها منبع کلید: محیط سرور (نه فایل، نه کد، نه باندل کلاینت) */
function envKeys(env) {
  const e = env || process.env;
  return {
    accessKey: String(e.PAYESH_S3_ACCESS_KEY || '').trim(),
    secret: String(e.PAYESH_S3_SECRET || '').trim(),
  };
}

/* ردیف ۱۷۳ (شبیه‌سازی داکر): فرادادهٔ صندوقچه هم از محیط سرور — برای سرور مرکزی (serv00/داکر)
   که فقط کلید محیطی دارد و دیتابیسش روی نشانی پیش‌فرض آروان نیست. فقط فراداده است (کلید همان
   envKeys)؛ نشانی فقط https (یا http روی همین رایانه)، همان قاعدهٔ cloud-control.endpointOk.
   خالی ⇒ همان پیش‌فرض‌های بالا. */
function envMeta(env) {
  const e = env || process.env;
  const out = {};
  const ep = String(e.PAYESH_S3_ENDPOINT || '').trim().replace(/\/+$/, '');
  if (ep) {
    try {
      const u = new URL(ep);
      const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
      if (!u.username && !u.password && !u.search && (u.protocol === 'https:' || (u.protocol === 'http:' && local))) out.endpoint = ep;
    } catch (x) { /* نشانی نامعتبر ⇒ پیش‌فرض */ }
  }
  const bucket = String(e.PAYESH_S3_BUCKET || '').trim();
  if (/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) out.bucket = bucket;
  const region = String(e.PAYESH_S3_REGION || '').trim();
  if (/^[a-z0-9-]{2,40}$/.test(region)) out.region = region;
  /* نشانی دیگر بی‌ناحیه ⇒ ناحیه از خود نشانی (همان regionFor پنل مالک: آروان ⇒ نام ناحیه، وگرنه
     us-east-1)؛ نه ناحیهٔ پیش‌فرض آروان — وگرنه امضای سرور و پنل مالک برای یک صندوقچه دو ناحیه داشت */
  else if (out.endpoint) out.region = '';
  const prefix = String(e.PAYESH_S3_PREFIX || '').trim();
  if (/^[A-Za-z0-9._-]+\/$/.test(prefix)) out.prefix = prefix;
  return out;
}

/* برای سازگاری با فراخوانی‌های قدیمی؛ فقط فراداده را برمی‌گرداند */
const b64 = (s) => Buffer.from(String(s), 'base64').toString('utf8');

module.exports = { DEFAULTS, envKeys, envMeta, b64 };
