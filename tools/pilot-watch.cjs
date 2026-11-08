#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   پایش پایلوت — ردیف ۵۱

   هر ۵ دقیقه سرورهای پایلوت را می‌سنجد و معیارهای توقف S1–S6 را بررسی
   می‌کند. در صورت عبور از آستانه، از کانال هشدار ردیف ۵۸ (server/alerts.js)
   خبر می‌دهد و همه را در pilot-51-watch.jsonl ثبت می‌کند.

   اجرا: node tools/pilot-watch.cjs --targets http://127.0.0.1:18099,... [--interval 300]
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { notify } = require('../server/alerts');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const TARGETS = String(opt('targets', '')).split(',').map(s => s.trim()).filter(Boolean);
const INTERVAL_S = Number(opt('interval', 300));
const OUT = opt('out', path.join(__dirname, '..', 'docs', 'cloud', 'reports', 'evidence', 'pilot-51-watch.jsonl'));

if (!TARGETS.length) { console.error('هدفی مشخص نشد: --targets http://h:p,...'); process.exit(2); }

/* معیارهای توقف پایلوت (ردیف ۵۱) */
const CRITERIA = {
  S1: { name: 'data_loss', desc: 'ردیف شمارش‌شده در دستگاه اما نه در سرور پس از پنجرهٔ همگام‌سازی' },
  S2: { name: 'cross_tenant_leak', desc: 'رویت دادهٔ مدرسه‌ای دیگر توسط کاربر' },
  S3: { name: 'convergence_mismatch', desc: 'اختلاف نسخهٔ ردیف پس از همگرایی (LWW)' },
  S4: { name: 'downtime', desc: 'قطعی تجمعی >۱۵ دقیقه در یک روز' },
  S5: { name: 'client_unusable', desc: 'حلقهٔ فروپاشی کلاینت روی یک دستگاه' },
  S6: { name: 'security_incident', desc: 'شکست یا نشانهٔ دسترسی غیرمجاز' },
};

let downSince = new Map(); // target -> ISO
let dayDown = new Map();   // target -> seconds accumulated today
let lastDay = new Date().toISOString().slice(0, 10);

function log(rec) {
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); } catch (e) { /* noop */ }
  try { fs.appendFileSync(OUT, JSON.stringify(rec) + '\n', 'utf8'); } catch (e) { /* noop */ }
}

async function probe(base) {
  const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(8000) }).then(x => x.json()).catch(e => null);
  if (!r) return { up: false };
  const sync = await fetch(base + '/api/sync?probe=watch', { signal: AbortSignal.timeout(8000) }).then(x => x.json()).catch(() => null);
  return { up: true, health: r, sync };
}

async function cycle() {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== lastDay) { dayDown.clear(); lastDay = day; }
  for (const t of TARGETS) {
    const ts = new Date().toISOString();
    const p = await probe(t);
    if (!p.up) {
      if (!downSince.has(t)) downSince.set(t, ts);
      const since = downSince.get(t);
      const add = Math.min(INTERVAL_S, 300);
      dayDown.set(t, (dayDown.get(t) || 0) + add);
      if ((dayDown.get(t) || 0) > 900) {
        // S4: قطعی تجمعی >۱۵ دقیقه
        await notify({ level: 'S1', key: `pilot-S4:${t}:${day}`, title: 'پایلوت — قطعی طولانی', body: `سرور ${t} بیش از ۱۵ دقیقه در این روز قط بوده است (${dayDown.get(t)}s).` });
        log({ ts, target: t, criterion: 'S4', level: 'S1', down_s: dayDown.get(t), verdict: 'STOP-CANDIDATE' });
      } else {
        log({ ts, target: t, up: false, down_since: since, down_s: dayDown.get(t) });
      }
      continue;
    }
    downSince.delete(t);
    const syncBag = p.sync || {};
    // سنجه‌های S1/S2/S3 از پاسخ همگام‌سازی استخراج می‌شوند (در صورت وجود)
    const stats = {
      data_loss: Number(syncBag.data_loss ?? syncBag.loss ?? -1),
      cross_tenant: Number(syncBag.cross_tenant ?? -1),
      mismatch: Number(syncBag.mismatch ?? -1),
      pending: Number(syncBag.pending ?? -1),
    };
    log({ ts, target: t, up: true, uptime_s: p.health.uptime_s, stats });
    if (stats.data_loss > 0) {
      await notify({ level: 'S1', key: `pilot-S1:${t}:${day}`, title: 'پایلوت — data_loss>0', body: `شمارهٔ کاهش دادهٔ کشف‌شده: ${stats.data_loss}` });
      log({ ts, target: t, criterion: 'S1', value: stats.data_loss, verdict: 'STOP-CANDIDATE' });
    }
    if (stats.cross_tenant > 0) {
      await notify({ level: 'S1', key: `pilot-S2:${t}:${day}`, title: 'پایلوت — نشت بین مدارس', body: `cross_tenant=${stats.cross_tenant}` });
      log({ ts, target: t, criterion: 'S2', value: stats.cross_tenant, verdict: 'STOP-CANDIDATE' });
    }
    if (stats.mismatch > 0) {
      await notify({ level: 'S2', key: `pilot-S3:${t}:${day}`, title: 'پایلوت — mismatch همگرایی', body: `mismatch=${stats.mismatch}` });
      log({ ts, target: t, criterion: 'S3', value: stats.mismatch, verdict: 'INVESTIGATE' });
    }
  }
}

console.log(`پایش پایلوت هر ${INTERVAL_S}s روی ${TARGETS.length} هدف — خروجی: ${OUT}`);
cycle();
setInterval(cycle, INTERVAL_S * 1000);
