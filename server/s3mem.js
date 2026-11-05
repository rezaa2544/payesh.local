'use strict';
/* ═══════════════════════════════════════════════════════════════════
   حافظهٔ ابری روی سرور — همان کلاینت مرورگر (client/lib/s3mini.js)
   به‌اضافهٔ ذخیره/خواندن تنظیمات در پایگاه دادهٔ محلی.

   اولویت تنظیمات:
     ۱) آنچه مدیر در «حافظهٔ ابری» ذخیره کرده (متای cloud:config)
     ۲) صندوقچهٔ پیش‌فرض داخل برنامه (server/cloud-defaults.js)
   یعنی مدرسه بدون هیچ تایپ‌کردنی کار می‌کند و اگر لازم شد، مدیر
   می‌تواند مقادیر تازه را در همان کادر وارد و ذخیره کند.
   ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const s3 = require(path.join(__dirname, '..', 'client', 'lib', 's3mini.js'));
const baked = require('./cloud-defaults');

const META_KEY = 'cloud:config';

/* پیش‌فرضِ داخل برنامه — همیشه «فعال» است چون کلیدها از قبل هست */
function defaults() {
  const c = s3.normalize(baked.DEFAULTS);
  c.enabled = !!(c.endpoint && c.accessKey && c.secret);
  c.source = 'default';
  return c;
}

function normalize(input) {
  const c = s3.normalize(input);
  c.enabled = !!(c.endpoint && c.bucket && c.accessKey && c.secret);
  return c;
}

function saved(store) {
  let raw = {};
  try { raw = JSON.parse(store.getMeta(META_KEY, '{}')) || {}; } catch (e) { raw = {}; }
  const c = s3.normalize(raw);
  /* اگر چیزی ذخیره نشده یا ناقص است، پیش‌فرض مدرسه جایش می‌آید */
  if (!c.endpoint || !c.accessKey || !c.secret) return null;
  c.enabled = !!(c.endpoint && c.bucket && c.accessKey && c.secret);
  c.source = 'saved';
  return c;
}

function usingMeta(store) {
  return {
    get() {
      const s = saved(store);
      if (s) return s;
      const d = defaults();
      /* اگر مدیر روی «پیش‌فرض» نبود، نام صندوقچهٔ ذخیره‌شده را نگه می‌داریم */
      return d;
    },
    set(cfg) { store.setMeta(META_KEY, JSON.stringify(cfg)); return cfg; },
    clear() { store.setMeta(META_KEY, '{}'); return defaults(); },
    isDefault() { return !saved(store); },
  };
}

/* نام صندوقچه را خودمان پیدا می‌کنیم (کاربر لازم نیست بداندش) */
async function ensureBucket(store) {
  const api = usingMeta(store);
  const cfg = api.get();
  if (!cfg.endpoint || !cfg.accessKey || !cfg.secret) return cfg;
  if (cfg.bucket) return cfg;
  try {
    const names = await s3.listBuckets(cfg);
    if (!names.length) return cfg;
    const pick = names.find(n => /payesh/i.test(n)) || names.find(n => /(school|madrese|madrese|مدرسه)/i.test(n)) || names[0];
    const next = Object.assign({}, cfg, { bucket: pick, source: cfg.source });
    next.enabled = !!(next.endpoint && next.bucket && next.accessKey && next.secret);
    api.set(next);
    return next;
  } catch (e) {
    return cfg;
  }
}

/* بکاپ خودکار روی صندوقچه — برای وقتی که سیستم مدرسه روشن است */
async function uploadBackup(store, file) {
  const cfg = await ensureBucket(store);
  if (!cfg.enabled) return { ok: false, error: 'not_configured' };
  const fs = require('fs');
  const text = fs.readFileSync(file, 'base64');
  const name = cfg.prefix + 'backups/' + path.basename(file);
  await s3.put(cfg, name, JSON.stringify({ kind: 'sqlite-base64', at: new Date().toISOString(), data: text }));
  return { ok: true, key: name, bytes: text.length };
}

module.exports = Object.assign({}, s3, {
  META_KEY, DEFAULTS: baked.DEFAULTS, defaults, normalize, saved, usingMeta, ensureBucket, uploadBackup,
  smartParse: s3.smartParse, setCors: s3.setCors, getCors: s3.getCors, listBuckets: s3.listBuckets,
});
