'use strict';
/* ═══════════════════════════════════════════════════════════════════
   حافظهٔ ابری روی سرور — همان کلاینت مرورگر (client/lib/s3mini.js)
   به‌اضافهٔ ذخیره/خواندن تنظیمات در پایگاه دادهٔ محلی.
   ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const s3 = require(path.join(__dirname, '..', 'client', 'lib', 's3mini.js'));

const META_KEY = 'cloud:config';

function defaults() {
  return Object.assign(s3.DEFAULTS, { enabled: false });
}

function normalize(input) {
  const c = s3.normalize(input);
  c.enabled = !!(c.endpoint && c.bucket && c.accessKey && c.secret);
  return c;
}

function usingMeta(store) {
  return {
    get() {
      try { return normalize(JSON.parse(store.getMeta(META_KEY, '{}'))); } catch (e) { return normalize({}); }
    },
    set(cfg) { store.setMeta(META_KEY, JSON.stringify(cfg)); return cfg; },
  };
}

/* بکاپ خودکار روی صندوقچه — برای وقتی که سیستم مدرسه روشن است */
async function uploadBackup(store, file) {
  const cfg = usingMeta(store).get();
  if (!cfg.enabled) return { ok: false, error: 'not_configured' };
  const fs = require('fs');
  const text = fs.readFileSync(file, 'base64');
  const name = cfg.prefix + 'backups/' + path.basename(file);
  await s3.put(cfg, name, JSON.stringify({ kind: 'sqlite-base64', at: new Date().toISOString(), data: text }));
  return { ok: true, key: name, bytes: text.length };
}

module.exports = Object.assign({}, s3, { META_KEY, defaults, normalize, usingMeta, uploadBackup, smartParse: s3.smartParse, setCors: s3.setCors, getCors: s3.getCors });
