#!/usr/bin/env node
'use strict';
/* ───────────────────────────────────────────────────────────────────
   ردیف ۴۲ — دروازهٔ بودجهٔ درخواست/بایت همگام‌سازی (CI)

   محاسبهٔ مدلِ روزانهٔ هر دستگاه از روی سیاستِ واقعی زمان‌بندی
   (client/sync-schedule.js) و هزینهٔ واحدِ اندازه‌گیری‌شده، و مقایسه با
   سقف‌های tools/sync-budget.json. اگر از سقف بگذرد، خروجی غیرصفر
   می‌دهد تا CI قرمز شود.

   استفاده:
     node tools/sync-budget-42.cjs                 # بررسی با هزینهٔ واحدِ مرجع
     node tools/sync-budget-42.cjs --json '{...}'  # تزریق هزینهٔ واحدِ اندازه‌گیری‌شده
     node tools/sync-budget-42.cjs --tight         # کنترل منفی: سقف‌ها را تنگ کن
   ─────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const schedule = require(path.join(ROOT, 'client', 'sync-schedule.js'));
const budget = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'sync-budget.json'), 'utf8'));

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const tight = args.includes('--tight');
const asJson = args.includes('--json') && opt('--json') === null;

let unit = Object.assign({}, budget.unit_cost_bytes);
const injected = opt('--json');
if (injected) {
  let parsed;
  try { parsed = JSON.parse(injected); } catch (e) { console.error('SYNC-BUDGET-FAILED bad --json payload'); process.exit(2); }
  unit = Object.assign(unit, parsed);
}

const DAY = 86400000;
const caps = JSON.parse(JSON.stringify(budget.device_day));
if (tight) {
  /* کنترل منفی: سقف را پایین می‌آوریم تا دروازه حتماً قرمز شود */
  caps.idle_visible.requests = 100;
  caps.idle_visible.bytes = 4096;
}

const probesIdle = Number.isFinite(unit.probes_idle_day)
  ? unit.probes_idle_day
  : schedule.probesPerDay(true, null);
const sweepsActive = Math.round(DAY / schedule.DEFAULTS.sweepMs);
const sweepsIdle = Math.round(DAY / schedule.DEFAULTS.sweepIdleMs);

const scenarios = [
  {
    key: 'idle_visible',
    label: 'دستگاه باز و بی‌کار',
    requests: probesIdle + sweepsActive,
    bytes: (probesIdle + sweepsActive) * unit.etag_304_bytes,
  },
  {
    key: 'background',
    label: 'پس‌زمینه/آفلاین',
    requests: sweepsIdle,
    bytes: sweepsIdle * unit.etag_304_bytes,
  },
  {
    key: 'active_teacher',
    label: 'معلم فعال (۶۰ push دسته‌ای ۱۲۰تایی)',
    requests: probesIdle + sweepsActive + 60,
    bytes: (probesIdle + sweepsActive) * unit.etag_304_bytes + 60 * unit.push_120ops_bytes,
  },
];

const rows = [];
let over = 0;
for (const s of scenarios) {
  const cap = caps[s.key];
  const rOver = s.requests > cap.requests;
  const bOver = s.bytes > cap.bytes;
  if (rOver || bOver) over++;
  rows.push({
    scenario: s.key,
    label: s.label,
    requests: s.requests,
    requests_cap: cap.requests,
    requests_ok: !rOver,
    bytes: s.bytes,
    bytes_kb: Math.round(s.bytes / 1024),
    bytes_cap: cap.bytes,
    bytes_ok: !bOver,
  });
}

if (asJson) {
  console.log(JSON.stringify({ ok: over === 0, unit, rows }, null, 2));
} else {
  console.log('scenario            requests / cap        bytes / cap');
  for (const r of rows) {
    console.log(
      `${r.scenario.padEnd(18)} ${String(r.requests).padStart(6)} / ${String(r.requests_cap).padEnd(6)} ${r.requests_ok ? 'ok ' : 'OVER'}  ` +
      `${String(r.bytes_kb + 'KB').padStart(8)} / ${String(Math.round(r.bytes_cap / 1024) + 'KB').padEnd(8)} ${r.bytes_ok ? 'ok' : 'OVER'}`,
    );
  }
  console.log(`unit: 304=${unit.etag_304_bytes}B 200=${unit.pull_200_bytes}B push120=${unit.push_120ops_bytes}B · probes/day=${probesIdle}`);
}

if (over > 0) {
  console.error(`SYNC-BUDGET-FAILED ${over} scenario(s) over budget`);
  process.exit(1);
}
console.log('SYNC-BUDGET-OK');
