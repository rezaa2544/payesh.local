#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   client/cloud-baked.js را از server/cloud-defaults.js می‌سازد.

   چرا لازم است؟ نسخهٔ اندروید هیچ سروری ندارد؛ پس نشانی و کلیدهای
   حافظهٔ ابری باید داخل خودِ برنامه پخته شوند تا کاربر هیچ‌چیز تایپ نکند.

   نام صندوقچه اگر خالی باشد، برنامه خودش پیدایش می‌کند (فهرست‌کردن).
   برای اینکه روی گوشی حتی این هم لازم نباشد، نام صندوقچه را می‌شود
   از بیرون داد:

     PAYESH_CLOUD_BUCKET=my-bucket node scripts/bake-cloud.mjs
     (یا در GitHub: Settings → Variables → CLOUD_BUCKET)

   هیچ رمزی داخل این فایل نوشته نمی‌شود؛ فقط همان پیش‌فرض‌های پروژه.
   ═══════════════════════════════════════════════════════════════════ */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { DEFAULTS } = require(path.join(ROOT, 'server', 'cloud-defaults.js'));

const bucket = String(process.env.PAYESH_CLOUD_BUCKET || DEFAULTS.bucket || '').trim();
const cfg = Object.assign({}, DEFAULTS, bucket ? { bucket } : {});
cfg.region = String(cfg.region || '');
if (!cfg.bucket) delete cfg.bucket;

const out = `/* ساختهٔ خودکار از server/cloud-defaults.js — دست نزنید\n   (بازسازی: node scripts/bake-cloud.mjs) */\nwindow.PAYESH_CLOUD = ${JSON.stringify(cfg, null, 2)};\n\n/* اگر نام صندوقچه موقع ساخت APK داده شده باشد، همان مقدم است */\nif (window.PAYESH_CLOUD_BUCKET) window.PAYESH_CLOUD.bucket = window.PAYESH_CLOUD_BUCKET;\n`;
const file = path.join(ROOT, 'client', 'cloud-baked.js');
writeFileSync(file, out, 'utf8');
console.log(`[bake] ${path.relative(ROOT, file)} · صندوقچه: ${cfg.bucket || '(خودکار پیدا می‌شود)'} · منطقه: ${cfg.region || '—'}`);
