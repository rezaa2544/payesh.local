/* ساختهٔ خودکار از server/cloud-defaults.js — دست نزنید
   (بازسازی: node scripts/bake-cloud.mjs)
   D‑23/F‑04: این فایل هیچ کلید/اعتبارنامه‌ای ندارد؛ فقط فراداده. */
window.PAYESH_CLOUD = {
  "endpoint": "https://s3.ir-central1.arvanstorage.ir",
  "region": "ir-central1",
  "prefix": "payesh/",
  "pathStyle": true
};

/* اگر نام صندوقچه موقع ساخت APK داده شده باشد، همان مقدم است */
if (window.PAYESH_CLOUD_BUCKET) window.PAYESH_CLOUD.bucket = window.PAYESH_CLOUD_BUCKET;
