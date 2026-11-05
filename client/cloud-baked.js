/* ساختهٔ خودکار از server/cloud-defaults.js — دست نزنید
   (بازسازی: node scripts/bake-cloud.mjs) */
window.PAYESH_CLOUD = {
  "endpoint": "https://s3.ir-central1.arvanstorage.ir",
  "region": "ir-central1",
  "accessKey": "997cc6ad-e97a-4e4d-abf1-db912a362c13",
  "secret": "9dc5367f78db53ea5d3a709612f9c0d4c9a880d83f66b0ee70a8faa762551092",
  "prefix": "payesh/",
  "pathStyle": true
};

/* اگر نام صندوقچه موقع ساخت APK داده شده باشد، همان مقدم است */
if (window.PAYESH_CLOUD_BUCKET) window.PAYESH_CLOUD.bucket = window.PAYESH_CLOUD_BUCKET;
