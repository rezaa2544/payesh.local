#!/usr/bin/env node
'use strict';
/* ───────────────────────────────────────────────────────────────────
   مدل اجرایی بار و هزینهٔ دیتابیس — ردیف ۳۳ (فاز ۲)

   ورودی : تعداد مدرسه، کاربر، همگام‌سازی/روز، اندازهٔ ردیف، اوج×  (+ دفترچهٔ فرض‌ها)
   خروجی : RPS میانگین و اوج، اتصال هم‌زمان، حجم ذخیره‌سازی، هزینهٔ ماهانهٔ DB در هر پله

   اجرا:  node tools/cost-model.cjs [--schools N] [--users N] [--syncs N] [--row-bytes N]
                                    [--peak N] [--json] [--book path]
   هیچ عددی بدون برچسب [S]/[M]/[A]/[E]/[?] چاپ نمی‌شود. «ظرفیت اثبات‌شده» یا «SLA» ادعا نمی‌شود.
   قانون برچسب‌گذاری (قانون اساسی بازنگری ۱.۱۲): [M] = سنجیده‌شده روی هدف واقعی ·
   [S] = شبیه‌سازی/ماشین توسعه (loopback، SQLite) · [A] = فرض مهندسی · [E] = برآورد ·
   [?] = ناشناخته. ورودی‌های این مدل از شبیه‌سازی‌ها و بنچ‌های ماشین توسعه گرفته شده‌اند
   ⇒ برچسب آن‌ها [S] است.
   ─────────────────────────────────────────────────────────────────── */
const fs = require('node:fs');
const path = require('node:path');

const BOOK_PATH = path.join(__dirname, 'price-book.json');
const SECONDS_PER_DAY = 86400;

function loadBook(p = BOOK_PATH) {
  const b = JSON.parse(fs.readFileSync(p, 'utf8'));
  const need = ['syncs_per_device_per_day', 'device_ratio', 'row_bytes', 'index_overhead',
    'rows_per_school_per_year', 'peak_factor', 'avg_latency_ms', 'rps_per_vcpu', 'safety_headroom'];
  for (const k of need) {
    if (!b.assumptions || !b.assumptions[k] || typeof b.assumptions[k].value !== 'number') {
      throw new Error('دفترچهٔ فرض‌ها ناقص است: ' + k);
    }
  }
  for (const k of ['eur_per_vcpu_hour', 'eur_per_gb_ram_hour', 'eur_per_gb_month_storage',
    'eur_per_gb_month_backup', 'managed_db_small_month', 'managed_db_medium_month', 'managed_db_large_month']) {
    if (!b.prices || !b.prices[k] || typeof b.prices[k].value !== 'number') {
      throw new Error('دفترچهٔ قیمت ناقص است: ' + k);
    }
  }
  return b;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--book') out.book = argv[++i];
    else if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
      out[key] = Number(argv[++i]);
    }
  }
  return out;
}

/* محاسبهٔ یک پله؛ همهٔ فرمول‌ها در سند ۳۳ توضیح داده شده‌اند. */
function computeTier(tier, book, override = {}) {
  const A = book.assumptions;
  const P = book.prices;
  const schools = Number(override.schools ?? tier.schools);
  const usersPerSchool = Number(override.usersPerSchool ?? tier.users_per_school);
  const syncs = Number(override.syncs ?? A.syncs_per_device_per_day.value);
  const rowBytes = Number(override.rowBytes ?? A.row_bytes.value);
  const peakFactor = Number(override.peak ?? A.peak_factor.value);

  if (!(schools > 0) || !(usersPerSchool > 0) || !(syncs > 0) || !(rowBytes > 0) || !(peakFactor >= 1)) {
    throw new Error('ورودی نامعتبر: همهٔ مقادیر باید مثبت باشند و peak ≥ ۱');
  }

  const users = schools * usersPerSchool;
  const devices = users * A.device_ratio.value;                              /* [A] */
  const requestsPerDay = devices * syncs;                                    /* pull+push */
  const rpsAvg = requestsPerDay / SECONDS_PER_DAY;
  const rpsPeak = rpsAvg * peakFactor;                                       /* [A] */
  const concurrent = rpsPeak * (A.avg_latency_ms.value / 1000);              /* Little's law [S]+[A] */

  const rowsYear1 = schools * A.rows_per_school_per_year.value;              /* [S] */
  const bytesPerRow = rowBytes * A.index_overhead.value;
  const storageGbYear1 = (rowsYear1 * bytesPerRow) / 1e9;
  /* رشد ۴ ساله: ۳۰٪ ردیف بیشتر در هر سال (کلاس‌های تازه + آرشیو) — [A] */
  const storageGbYear4 = storageGbYear1 * (1 + 0.3 * 3);

  /* ظرفیت: RPS پایدار هر vCPU از سنجش محلی؛ حاشیهٔ امن ۱.۵× */
  const vcpuNeeded = Math.max(1, Math.ceil((rpsPeak / A.rps_per_vcpu.value) * A.safety_headroom.value));
  const ramGbNeeded = Math.max(1, Math.ceil((concurrent / 100) * 2));       /* ۱۰۰ اتصال هم‌زمان بر ۲GB — [A] */

  const vcpuMonth = vcpuNeeded * P.eur_per_vcpu_hour.value * 730;
  const ramMonth = ramGbNeeded * P.eur_per_gb_ram_hour.value * 730;
  const diskMonth = storageGbYear4 * P.eur_per_gb_month_storage.value;
  const backupMonth = storageGbYear4 * P.eur_per_gb_month_backup.value;
  const selfHostedMonth = round2(vcpuMonth + ramMonth + diskMonth + backupMonth);

  /* گزینهٔ مدیریت‌شده: پله بر اساس vCPU مورد نیاز */
  let managed = 'managed_db_small_month';
  if (vcpuNeeded > 1 && vcpuNeeded <= 2) managed = 'managed_db_medium_month';
  else if (vcpuNeeded > 2) managed = 'managed_db_large_month';
  const managedMonth = P[managed].value;

  return {
    name: tier.name,
    inputs: { schools, users_per_school: usersPerSchool, users, devices: Math.round(devices), syncs_per_device_per_day: syncs, row_bytes: rowBytes, peak_factor: peakFactor },
    load: { requests_per_day: Math.round(requestsPerDay), rps_avg: round2(rpsAvg), rps_peak: round2(rpsPeak), concurrent_connections: round2(concurrent) },
    storage: { rows_year1: Math.round(rowsYear1), bytes_per_row: Math.round(bytesPerRow), gb_year1: round2(storageGbYear1), gb_year4: round2(storageGbYear4) },
    sizing: { vcpu: vcpuNeeded, ram_gb: ramGbNeeded, read_replica: !!A.read_replica.value },
    cost_eur_month: {
      self_hosted: selfHostedMonth,
      managed_db: managedMonth,
      managed_plan: managed.replace('managed_db_', '').replace('_month', ''),
      breakdown_self_hosted: { vcpu: round2(vcpuMonth), ram: round2(ramMonth), disk: round2(diskMonth), backup: round2(backupMonth) },
    },
    labels: { rps: '[S]+[A]', storage: '[S]+[A]', cost: '[E]' },
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

function render(report) {
  const lines = [];
  lines.push('مدل بار و هزینهٔ دیتابیس — ردیف ۳۳  (هیچ عددی بدون برچسب نیست)');
  lines.push('برچسب‌ها: [S] شبیه‌سازی/ماشین توسعه (loopback، SQLite) · [M] اندازه‌گیری‌شده روی هدف واقعی · [A] فرض مهندسی · [E] برآورد قیمت · [?] نامعلوم');
  lines.push('');
  lines.push('پله            مدرسه  کاربر  دستگاه  RPS میانگین  RPS اوج  اتصال هم‌زمان  ذخیره‌سازی(GB سال۱/سال۴)  vCPU/RAM  خودمیزبان €/ماه  مدیریت‌شده €/ماه');
  for (const t of report.tiers) {
    lines.push([
      t.name.padEnd(13),
      String(t.inputs.schools).padStart(6),
      String(t.inputs.users).padStart(6),
      String(t.inputs.devices).padStart(7),
      String(t.load.rps_avg).padStart(11),
      String(t.load.rps_peak).padStart(8),
      String(t.load.concurrent_connections).padStart(13),
      (t.storage.gb_year1 + ' / ' + t.storage.gb_year4).padStart(21),
      (t.sizing.vcpu + ' / ' + t.sizing.ram_gb + 'GB').padStart(8),
      String(t.cost_eur_month.self_hosted).padStart(15),
      String(t.cost_eur_month.managed_db).padStart(16),
    ].join('  '));
  }
  lines.push('');
  lines.push('فرض‌های کلیدی (از tools/price-book.json):');
  for (const [k, v] of Object.entries(report.assumptions)) lines.push('  - ' + k + ' = ' + v.value + '  ' + v.label + '  ' + (v.why || ''));
  lines.push('');
  lines.push('محدودیت‌ها: هزینه‌ها [E] و بر مبنای قیمت بازار هستند، نه پیشنهاد رسمی ارائه‌دهنده؛ هیچ SLA/ظرفیت تولیدی ادعا نمی‌شود.');
  return lines.join('\n');
}

function run(opts = {}) {
  const book = loadBook(opts.book);
  const tiers = (book.tiers || []).map(t => computeTier(t, book, opts));
  if (!tiers.length) throw new Error('هیچ پله‌ای در دفترچه نیست');
  const assumptions = {};
  for (const k of ['device_ratio', 'syncs_per_device_per_day', 'row_bytes', 'rows_per_school_per_year', 'rps_per_vcpu', 'avg_latency_ms', 'peak_factor', 'safety_headroom']) {
    if (book.assumptions[k]) assumptions[k] = book.assumptions[k];
  }
  return { generated_at: new Date().toISOString(), source: 'tools/cost-model.cjs', tiers, assumptions, prices: book.prices };
}

module.exports = { loadBook, computeTier, run, render, round2 };

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const report = run(opts);
    if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stdout.write(render(report) + '\n');
  } catch (e) {
    console.error('COST-MODEL-ERROR: ' + (e && e.message));
    process.exit(2);
  }
}
