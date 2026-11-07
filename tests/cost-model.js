'use strict';
/* آزمون مدل بار/هزینهٔ دیتابیس — ردیف ۳۳
   اجرا: node tests/cost-model.js
   چه چیزی اثبات می‌شود؟
     ۱) فرمول‌ها درست‌اند (محاسبهٔ دستی با همان ورودی ⇒ همان خروجی)
     ۲) یکنوایی: پلهٔ بزرگ‌تر ⇒ RPS/ذخیره‌سازی/هزینهٔ کمتر یا مساوی ندارد
     ۳) ورودی نامعتبر (صفر/منفی/peak<۱) رد می‌شود — نه خروجی بی‌معنا
     ۴) هر عدد برچسب دارد و هیچ خروجی NaN/Infinity نیست
     ۵) خروجی JSON از مسیر CLI قابل مصرف است (قرارداد ابزار)
*/
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const model = require('../tools/cost-model.cjs');

let PASS = 0, FAIL = 0;
const failures = [];
function test(name, fn) {
  try { fn(); PASS++; console.log('  ✓ ' + name); }
  catch (e) { FAIL++; failures.push(name + ' — ' + (e && e.message)); console.log('  ✗ ' + name + ' — ' + (e && e.message)); }
}

const report = model.run();

test('سه پله با نام و ورودی مثبت تولید می‌شود', () => {
  assert.strictEqual(report.tiers.length, 3);
  for (const t of report.tiers) {
    assert.ok(t.name && t.inputs.schools > 0 && t.inputs.users > 0);
  }
});

test('محاسبهٔ دستی T2 مطابق مدل است (RPS و ظرفیت و ذخیره‌سازی)', () => {
  const book = model.loadBook();
  const t2 = report.tiers.find(t => t.inputs.schools === 100);
  assert.ok(t2, 'پلهٔ ۱۰۰ مدرسه پیدا نشد');
  const users = 100 * 200;
  const devices = users * book.assumptions.device_ratio.value;
  const reqDay = devices * book.assumptions.syncs_per_device_per_day.value;
  assert.strictEqual(t2.inputs.users, users);
  assert.strictEqual(t2.inputs.devices, Math.round(devices));
  assert.strictEqual(t2.load.requests_per_day, Math.round(reqDay));
  assert.strictEqual(t2.load.rps_avg, model.round2(reqDay / 86400));
  assert.strictEqual(t2.load.rps_peak, model.round2((reqDay / 86400) * book.assumptions.peak_factor.value));
  const bytesRow = book.assumptions.row_bytes.value * book.assumptions.index_overhead.value;
  const gb = (100 * book.assumptions.rows_per_school_per_year.value * bytesRow) / 1e9;
  assert.strictEqual(t2.storage.gb_year1, model.round2(gb));
});

test('یکنوایی: مدارس بیشتر ⇒ RPS اوج و ذخیره‌سازی و هزینهٔ بیشتر/مساوی', () => {
  for (let i = 1; i < report.tiers.length; i++) {
    const a = report.tiers[i - 1], b = report.tiers[i];
    assert.ok(b.load.rps_peak >= a.load.rps_peak, 'RPS اوج یکنوا نیست');
    assert.ok(b.storage.gb_year1 > a.storage.gb_year1, 'ذخیره‌سازی یکنوا نیست');
    assert.ok(b.sizing.vcpu >= a.sizing.vcpu, 'vCPU یکنوا نیست');
    assert.ok(b.cost_eur_month.self_hosted >= a.cost_eur_month.self_hosted, 'هزینهٔ خودمیزبان یکنوا نیست');
  }
});

test('Little’s law: اتصال هم‌زمان = RPS اوج × تأخیر', () => {
  const book = model.loadBook();
  for (const t of report.tiers) {
    const expect = model.round2((t.load.rps_peak) * (book.assumptions.avg_latency_ms.value / 1000));
    assert.strictEqual(t.load.concurrent_connections, expect);
  }
});

test('ورودی نامعتبر رد می‌شود (صفر، منفی، peak<۱)', () => {
  const book = model.loadBook();
  const tier = book.tiers[0];
  assert.throws(() => model.computeTier(tier, book, { schools: 0 }), /نامعتبر/);
  assert.throws(() => model.computeTier(tier, book, { users: -5, usersPerSchool: -5 }), /نامعتبر/);
  assert.throws(() => model.computeTier(tier, book, { peak: 0.5 }), /نامعتبر/);
});

test('دفترچهٔ ناقص رد می‌شود (کنترل منفی روی فرض‌های اجباری)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const tmp = path.join(os.tmpdir(), 'book-' + process.pid + '.json');
  const bad = model.loadBook();
  delete bad.assumptions.rps_per_vcpu;
  fs.writeFileSync(tmp, JSON.stringify(bad));
  assert.throws(() => model.loadBook(tmp), /ناقص/);
  fs.unlinkSync(tmp);
});

test('هیچ عددی NaN/Infinity نیست و برچسب‌ها موجودند', () => {
  const walk = (o, p) => {
    if (typeof o === 'number') { assert.ok(Number.isFinite(o), 'عدد نامعتبر در ' + p); return; }
    if (o && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], p + '.' + k);
  };
  walk(report.tiers, 'tiers');
  for (const t of report.tiers) {
    assert.ok(t.labels && t.labels.rps && t.labels.storage && t.labels.cost, 'برچسب ناقص');
  }
  for (const k of ['device_ratio', 'rps_per_vcpu']) assert.ok(report.assumptions[k].label, 'برچسب فرض نیست: ' + k);
  for (const k of Object.keys(report.prices)) assert.ok(report.prices[k].label, 'برچسب قیمت نیست: ' + k);
});

test('CLI: خروجی --json معتبر و قابل پارس است', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'cost-model.cjs'), '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.tiers.length, 3);
  assert.ok(parsed.generated_at && parsed.source.includes('cost-model'));
});

test('CLI: پارامتر ورودی روی خروجی اثر می‌گذارد (schools=500)', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'cost-model.cjs'), '--json', '--schools', '500'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  for (const t of parsed.tiers) assert.strictEqual(t.inputs.schools, 500);
});

test('متن گزارش شامل برچسب‌ها و هشدار محدودیت است', () => {
  const text = model.render(report);
  assert.ok(text.includes('[M]') && text.includes('[A]') && text.includes('[E]'));
  assert.ok(text.includes('SLA') || text.includes('ادعا نمی‌شود'));
});

console.log('\n' + PASS + ' موفق · ' + FAIL + ' ناموفق\n');
if (FAIL) { console.log('شکست‌ها:\n - ' + failures.join('\n - ')); process.exit(1); }
