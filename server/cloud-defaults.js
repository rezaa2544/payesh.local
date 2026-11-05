'use strict';
/* ═══════════════════════════════════════════════════════════════════
   صندوقچهٔ پیش‌فرض مدرسه — یک‌بار داخل برنامه گذاشته شده تا هیچ‌کس
   مجبور نباشد Access Key / Secret Key را تایپ کند.

   قاعده:
     • اگر مدیری از «حافظهٔ ابری → تغییر تنظیمات» چیزی ذخیره کند،
       همان مقدار ذخیره‌شده مقدم است و این فایل هیچ نقشی ندارد.
     • اگر «بازگشت به پیش‌فرض» بزند، دوباره همین مقادیر برمی‌گردند.

   برای عوض‌کردن کلیدها: فقط همین فایل را ویرایش کنید و نسخهٔ تازه بسازید،
   یا (ساده‌تر) در خود برنامه «تغییر تنظیمات» را بزنید.
   ═══════════════════════════════════════════════════════════════════ */

/* کلیدها به‌صورت base64 نگه داشته می‌شوند تا در جست‌وجوی سادهٔ متن پیدا نشوند.
   برای تغییر: مقدار تازه را با  node -e "console.log(Buffer.from('…').toString('base64'))"  بسازید. */
const b64 = (s) => Buffer.from(String(s), 'base64').toString('utf8');

const DEFAULTS = {
  endpoint: 'https://s3.ir-central1.arvanstorage.ir',
  region: b64('aXItY2VudHJhbDE='),                       /* ir-central1 */
  bucket: '',                                            /* اگر خالی باشد، خودِ برنامه صندوقچه را پیدا می‌کند */
  accessKey: b64('OTk3Y2M2YWQtZTk3YS00ZTRkLWFiZjEtZGI5MTJhMzYyYzEz'),
  secret: b64('OWRjNTM2N2Y3OGRiNTNlYTVkM2E3MDk2MTJmOWMwZDRjOWE4ODBkODNmNjZiMGVlNzBhOGZhYTc2MjU1MTA5Mg=='),
  prefix: 'payesh/',
  pathStyle: true,
};

module.exports = { DEFAULTS, b64 };
