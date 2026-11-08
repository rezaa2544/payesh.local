'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون سیاست خواندن — ردیف ۵۲            (RP-01 .. RP-09)

   دو چیز مستقل از هم سنجیده می‌شود:
     الف) **تصمیم** replica: چون شاهد ردیف ۴۶ نشان داد گلوگاه خواندن نیست،
          پیش‌فرض «بدون replica» است و سیاست در همهٔ حالت‌های خطرناک
          (تأخیر نامعلوم، تأخیر بیش از سقف، نوشتهٔ ندیده) به primary برمی‌گردد.
     ب) **ناوردا**: دستگاه نوشته‌های خودش را می‌بیند. ناوردا در سطح سیاست
          (انتخاب primary وقتی replica عقب است) و در سطح Gateway (endpoint
          واقعی با SQLite/PG ندارد ⇒ در شاهد) آزموده می‌شود؛ اینجا حداقل
          وجود مسیر کد و شکل پاسخ بررسی می‌شود.

   اجرا: npm run test:replica52
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pol = require(path.join(ROOT, 'server', 'replica-policy.js'));

let passed = 0, failed = 0; const failures = [];
function check(id, desc, fn) {
  try { const d = fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 260)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

check('RP-01', 'بدون replica ⇒ خواندن از primary (تصمیم پیش‌فرض، بدون وابستگی به تأخیر)', () => {
  const d = pol.chooseReadTarget({ replica_url: '', lag_ms: 5, own_write_seq: 0, replica_seq: 100 });
  assert(d.target === 'primary', 'target=' + d.target);
  assert(d.reason === 'no_replica_configured', 'reason=' + d.reason);
  assert(d.fallback === false, 'بدون replica «fallback» نیست');
  return d.reason;
});

check('RP-02', 'replica تازه ⇒ خواندن از replica (تنها حالت مجاز)', () => {
  const d = pol.chooseReadTarget({ replica_url: 'postgres://r', lag_ms: 120, own_write_seq: 5, replica_seq: 5 });
  assert(d.target === 'replica', 'target=' + d.target);
  assert(d.reason === 'replica_fresh', 'reason=' + d.reason);
  return `lag=120ms target=${d.target}`;
});

check('RP-03', 'read-your-writes: دستگاه نوشته‌ای دارد که replica ندیده ⇒ primary', () => {
  const d = pol.chooseReadTarget({ replica_url: 'postgres://r', lag_ms: 10, own_write_seq: 42, replica_seq: 41 });
  assert(d.target === 'primary', 'target=' + d.target);
  assert(d.reason === 'read_your_writes', 'reason=' + d.reason);
  assert(d.fallback === true, 'باید fallback باشد');
  return 'own=42 replica=41 → primary';
});

check('RP-04', 'تأخیر نامعلوم (replica پاسخ نمی‌دهد) ⇒ محافظه‌کارانه primary', () => {
  for (const lag of [null, undefined, NaN, 'x']) {
    const d = pol.chooseReadTarget({ replica_url: 'postgres://r', lag_ms: lag, own_write_seq: 0 });
    assert(d.target === 'primary', `lag=${lag} → ${d.target}`);
    assert(d.reason === 'lag_unknown', `lag=${lag} reason=${d.reason}`);
  }
  return 'null/undefined/NaN/str → primary';
});

check('RP-05', 'تأخیر بیش از سقف (۲۰۰۰ms) ⇒ primary؛ مرز دقیق بررسی می‌شود', () => {
  const over = pol.chooseReadTarget({ replica_url: 'postgres://r', lag_ms: pol.MAX_REPLICA_LAG_MS + 1 });
  const edge = pol.chooseReadTarget({ replica_url: 'postgres://r', lag_ms: pol.MAX_REPLICA_LAG_MS });
  assert(over.target === 'primary' && over.reason === 'lag_over_budget', 'بیش از سقف');
  assert(edge.target === 'replica', 'دقیقاً سقف باید مجاز باشد');
  return `edge=${pol.MAX_REPLICA_LAG_MS}ms accepted`;
});

check('RP-06', 'ورودی نامعتبر سیاست را نمی‌شکند (own_write_seq متنی/منفی)', () => {
  const a = pol.chooseReadTarget({ replica_url: 'postgres://r', lag_ms: 10, own_write_seq: 'abc', replica_seq: 1 });
  const b = pol.chooseReadTarget({ replica_url: 'postgres://r', lag_ms: 10, own_write_seq: -5, replica_seq: 1 });
  assert(a.target === 'replica' && b.target === 'replica', 'ورودی نامعتبر نباید همه را به primary ببرد');
  const c = pol.chooseReadTarget({});
  assert(c.target === 'primary', 'بدون ورودی ⇒ primary');
  return 'invalid/empty handled';
});

check('RP-07', 'Gateway واقعاً از سیاست استفاده می‌کند و مقصد را در پاسخ می‌گوید', () => {
  const gw = fs.readFileSync(path.join(ROOT, 'server', 'gateway.js'), 'utf8');
  assert(/readSource\(deviceId, tenantId\)/.test(gw), 'pull از readSource استفاده نمی‌کند');
  assert(/read_from: src\.decision\.target/.test(gw), 'پاسخ pull مقصد خواندن را اعلام نمی‌کند');
  assert(/PAYESH_PG_REPLICA_URL/.test(gw), 'متغیر replica خوانده نمی‌شود');
  assert(/noteOwnWrite\(/.test(gw), 'seq نوشتهٔ دستگاه ثبت نمی‌شود');
  return 'wired: readSource + read_from + noteOwnWrite';
});

check('RP-08', 'ناوردا در مسیر push واقعاً ثبت می‌شود (maxFeedSeq در tenancy)', () => {
  const tn = fs.readFileSync(path.join(ROOT, 'server', 'tenancy.js'), 'utf8');
  assert(/async function maxFeedSeq/.test(tn), 'maxFeedSeq نیست');
  assert(/replicaPolicy/.test(tn), 'سیاست در tenancy در دسترس نیست');
  const gw = fs.readFileSync(path.join(ROOT, 'server', 'gateway.js'), 'utf8');
  assert(/noteOwnWrite\(deviceId, await tenancy\.maxFeedSeq/.test(gw), 'push seq دستگاه را ثبت نمی‌کند');
  return 'push → maxFeedSeq → noteOwnWrite';
});

check('RP-09', 'شرط بازبینی تصمیم «بدون replica» عدد دارد (بر پایهٔ شاهد ردیف ۴۶)', () => {
  assert(pol.POLICY.max_replica_lag_ms === 2000, 'سقف تأخیر');
  assert(pol.POLICY.revisit_when.pull_p99_over_push_p99_ratio === 1.3, 'نسبت p99');
  assert(pol.POLICY.revisit_when.sustained_clients === 300, 'بار پایدار');
  return JSON.stringify(pol.POLICY.revisit_when);
});

console.log(`\nRP checks=${passed + failed} pass=${passed} fail=${failed}`);
if (failures.length) console.log('failures: ' + failures.join(','));
console.log(failed === 0 ? 'READ-POLICY-52-TEST-OK' : 'READ-POLICY-52-TEST-FAILED');
process.exit(failed === 0 ? 0 : 1);
