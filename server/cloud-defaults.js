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

/* برای سازگاری با فراخوانی‌های قدیمی؛ فقط فراداده را برمی‌گرداند */
const b64 = (s) => Buffer.from(String(s), 'base64').toString('utf8');

module.exports = { DEFAULTS, envKeys, b64 };
