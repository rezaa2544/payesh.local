#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   client/cloud-baked.js را از فرادادهٔ server/cloud-defaults.js می‌سازد.

   **D‑23 / F‑04 — این اسکریپت هیچ کلیدی نمی‌نویسد.**
   تنها چیزهایی که داخل باندل کلاینت پخته می‌شوند: endpoint، region،
   bucket، prefix، pathStyle. اعتبارنامه فقط روی سرور می‌ماند و کلاینت
   هرگز آن را نمی‌بیند. اگر روزی کسی کلید را به پیش‌فرض‌ها برگرداند،
   همین اسکریپت با خطا می‌ایستد (fail-closed) تا نشت دوباره ساخته نشود.

   برای تعیین نام صندوقچه در زمان ساخت:
     PAYESH_CLOUD_BUCKET=my-bucket node scripts/bake-cloud.mjs
     (یا در GitHub: Settings → Variables → CLOUD_BUCKET)
   ═══════════════════════════════════════════════════════════════════ */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* هر کلید/رازی در پیش‌فرض‌ها ⇒ توقف. کلیدها فقط از محیط سرور خوانده می‌شوند. */
const FORBIDDEN = ['accessKey', 'secret', 'secretKey', 'sessionToken'];

function auditDefaults(defs, where) {
  const bad = FORBIDDEN.filter(k => defs && defs[k]);
  if (bad.length) {
    console.error(`⛔ D‑23/F‑04: «${bad.join('، ')}» در ${where} هست — اعتبارنامه نباید در کد/باندل باشد.`);
    return false;
  }
  return true;
}

/* حالت بازرسی (برای آزمون منفی): node scripts/bake-cloud.mjs --check [file] */
if (process.argv[2] === '--check') {
  const file = process.argv[3] || path.join(ROOT, 'server', 'cloud-defaults.js');
  let mod;
  try { mod = require(path.resolve(file)); } catch (e) {
    console.error('⛔ فایل پیش‌فرض خوانده نشد: ' + path.resolve(file));
    process.exit(4);
  }
  const defs = (mod && (mod.DEFAULTS || mod.default)) || mod || {};
  if (!auditDefaults(defs, file)) process.exit(2);
  console.log(`CLOUD-DEFAULTS-OK keys=0 endpoint=${defs.endpoint || '—'} region=${defs.region || '—'}`);
  process.exit(0);
}

const { DEFAULTS } = require(path.join(ROOT, 'server', 'cloud-defaults.js'));
if (!auditDefaults(DEFAULTS, 'server/cloud-defaults.js')) process.exit(2);

const ALLOWED = ['endpoint', 'region', 'bucket', 'prefix', 'pathStyle'];
const bucket = String(process.env.PAYESH_CLOUD_BUCKET || DEFAULTS.bucket || '').trim();
const cfg = {};
for (const k of ALLOWED) {
  const v = k === 'bucket' ? bucket : DEFAULTS[k];
  if (v !== undefined && v !== null && v !== '') cfg[k] = v;
}

const out = `/* ساختهٔ خودکار از server/cloud-defaults.js — دست نزنید
   (بازسازی: node scripts/bake-cloud.mjs)
   D‑23/F‑04: این فایل هیچ کلید/اعتبارنامه‌ای ندارد؛ فقط فراداده. */
window.PAYESH_CLOUD = ${JSON.stringify(cfg, null, 2)};

/* اگر نام صندوقچه موقع ساخت APK داده شده باشد، همان مقدم است */
if (window.PAYESH_CLOUD_BUCKET) window.PAYESH_CLOUD.bucket = window.PAYESH_CLOUD_BUCKET;
`;

/* سدِ دوم: خروجی نباید هیچ‌جای خود کلید/راز داشته باشد */
if (/accessKey|secret|sessionToken/i.test(out)) {
  console.error('⛔ D‑23/F‑04: خروجی bake شامل نام/مقدار اعتبارنامه است — متوقف شد.');
  process.exit(3);
}

const file = path.join(ROOT, 'client', 'cloud-baked.js');
writeFileSync(file, out, 'utf8');
console.log(`[bake] ${path.relative(ROOT, file)} · صندوقچه: ${cfg.bucket || '(خودکار پیدا می‌شود)'} · منطقه: ${cfg.region || '—'} · keys=0`);
