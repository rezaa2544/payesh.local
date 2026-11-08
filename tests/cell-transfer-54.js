'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون ردیف ۵۴ — مهاجرت چند-cell و انتقال مدرسه   (CT-01 .. CT-10)

   بخش بدون دیتابیس (در CI): منطق سه‌لایه، checksum پایدار، دروازهٔ فعال‌سازی،
   اعتبارسنجی ورودی، و اینکه Gateway واقعاً توقف نوشتن را اجرا می‌کند.
   انتقال واقعی بین دو دیتابیس در شاهد ردیف ۵۴ سنجیده می‌شود.

   اجرا: npm run test:cell54
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tr = require(path.join(ROOT, 'server', 'transfer.js'));

let passed = 0, failed = 0; const failures = [];
function check(id, desc, fn) {
  try { const d = fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 260)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

const TOOL = path.join(ROOT, 'tools', 'cell-transfer-54.mjs');
const run = (args, env = {}) => spawnSync(process.execPath, [TOOL, ...args], {
  encoding: 'utf8', cwd: ROOT, env: Object.assign({}, process.env, env),
});

check('CT-01', 'بدون مجوز صریح، ابزار فعال نمی‌شود (شرط ردیف ۵۴)', () => {
  assert(tr.enabled({}) === false, 'پیش‌فرض باید غیرفعال باشد');
  assert(tr.enabled({ PAYESH_CELL_TRANSFER_ENABLED: '1' }) === true, 'با ۱ فعال');
  assert(tr.enabled({ PAYESH_CELL_TRANSFER_ENABLED: 'true' }) === false, 'فقط «۱» مجاز است');
  const r = run(['--cells', 'postgres://127.0.0.1:1/x'], { PAYESH_CELL_TRANSFER_ENABLED: '' });
  assert(r.status === 3, 'exit=' + r.status);
  assert(/CELL-TRANSFER-54-DISABLED/.test(r.stderr), 'پیام غیرفعالی نیست');
  return 'exit=3 + پیام صریح';
});

check('CT-02', 'checksum محتوایی پایدار است (ترتیب ردیف‌ها اثر ندارد)', () => {
  const a = tr.stableChecksum([{ id: 1, v: 'x' }, { id: 2, v: 'y' }]);
  const b = tr.stableChecksum([{ id: 2, v: 'y' }, { id: 1, v: 'x' }]);
  const c = tr.stableChecksum([{ id: 1, v: 'x' }, { id: 2, v: 'z' }]);
  assert(a === b, 'ترتیب نباید checksum را عوض کند');
  assert(a !== c, 'محتوا باید checksum را عوض کند');
  assert(tr.stableChecksum([]) === tr.stableChecksum([]), 'خالی پایدار');
  return 'order-independent';
});

check('CT-03', 'لایهٔ ۱ (تعداد) اختلاف را می‌گیرد', () => {
  const r = tr.reconcile({ counts: { t1: 5 }, checksums: {}, seqs: {} }, { counts: { t1: 4 }, checksums: {}, seqs: {} });
  assert(r.ok === false, 'نباید ok باشد');
  assert(r.layer1[0].ok === false && r.layer1[0].source === 5 && r.layer1[0].target === 4, 'جزئیات لایهٔ ۱');
  return 'count mismatch detected';
});

check('CT-04', 'لایهٔ ۲ (checksum) اختلاف محتوا با تعداد برابر را می‌گیرد', () => {
  const r = tr.reconcile(
    { counts: { t1: 2 }, checksums: { t1: 'aaa' }, seqs: {} },
    { counts: { t1: 2 }, checksums: { t1: 'bbb' }, seqs: {} });
  assert(r.layer1[0].ok === true, 'تعداد برابر است');
  assert(r.layer2[0].ok === false, 'checksum باید اختلاف بدهد');
  assert(r.ok === false, 'ok نباید true باشد');
  return 'checksum mismatch detected';
});

check('CT-05', 'لایهٔ ۳ (seq) رکورد به‌رکورد را مقایسه می‌کند', () => {
  const r = tr.reconcile({ counts: {}, checksums: {}, seqs: { a: 1, b: 2, c: 3 } },
    { counts: {}, checksums: {}, seqs: { a: 1, b: 9, c: 3 } });
  assert(r.layer3.compared === 3, 'compared=' + r.layer3.compared);
  assert(r.layer3.mismatch_count === 1, 'mismatch=' + r.layer3.mismatch_count);
  assert(r.layer3.mismatched[0] === 'b', 'شناسه=' + r.layer3.mismatched[0]);
  assert(r.ok === false, 'ok نباید true باشد');
  return 'a:1 ok · b:2≠9 گرفته شد';
});

check('CT-06', 'تطبیق کامل ⇒ ok (کنترل مثبت)', () => {
  const same = { counts: { t1: 2, t2: 0 }, checksums: { t1: 'x', t2: 'y' }, seqs: { a: 1 } };
  const r = tr.reconcile(same, JSON.parse(JSON.stringify(same)));
  assert(r.ok === true, 'باید ok باشد');
  assert(r.tables === 2, 'tables=' + r.tables);
  return 'ok=true · tables=2';
});

check('CT-07', 'Gateway توقف نوشتن را اجرا می‌کند و ۴۰۹ می‌دهد', () => {
  const gw = fs.readFileSync(path.join(ROOT, 'server', 'gateway.js'), 'utf8');
  assert(/TRANSFER_ON && await tenancy\.transfer\.isFrozen/.test(gw), 'بررسی freeze در مسیر push نیست');
  assert(/write_frozen/.test(gw), 'کد خطای write_frozen نیست');
  assert(/409/.test(gw), 'کد وضعیت ۴۰۹ نیست');
  return 'push → 409 write_frozen';
});

check('CT-08', 'انتقال از lock نشستی استفاده نمی‌کند (سازگار با transaction pooling)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'transfer.js'), 'utf8');
  assert(!/pg_advisory|FOR UPDATE|LISTEN/i.test(src), 'lock نشستی/صفی در ابزار انتقال هست');
  assert(/payesh_transfer_freeze/.test(src), 'جدول توقف نوشتن نیست');
  return 'freeze row, no session lock';
});

check('CT-09', 'اعتبارسنجی ورودی: tenant نامعتبر، مبدأ=مقصد، فهرست خالی', () => {
  const env = { PAYESH_CELL_TRANSFER_ENABLED: '1' };
  const a = run(['--transfer', '--tenant', 'bad', '--from', 'postgres://a', '--to', 'postgres://b'], env);
  const b = run(['--transfer', '--tenant', '11111111-2222-4333-8444-555555555555', '--from', 'postgres://a', '--to', 'postgres://a'], env);
  const c = run(['--transfer', '--tenant', '11111111-2222-4333-8444-555555555555', '--from', 'postgres://a'], env);
  const d = run(['--cells', ' '], env);
  for (const [name, r] of [['tenant', a], ['same-url', b], ['missing-to', c], ['empty-cells', d]]) {
    assert(r.status === 2, `${name}: exit=${r.status}`);
  }
  return '4/4 rejected with exit=2';
});

check('CT-10', 'رویداد batch برای rollback ثبت می‌شود (اثر انگشت انتقال)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'cell-transfer-54.mjs'), 'utf8');
  assert(/batchId = crypto\.randomUUID\(\)/.test(src), 'batch_id ساخته نمی‌شود');
  assert(/insert into \$\{transfer\.BATCH_TABLE\}/.test(src), 'batch ثبت نمی‌شود');
  assert(/delete from \$\{t\} where \(\$\{cols\}\) in/.test(src), 'rollback ردیف‌ها را حذف نمی‌کند');
  assert(/primaryKeyOf/.test(src), 'کلید اصلی جدول‌ها تشخیص داده نمی‌شود (gateway_quota ستون id ندارد)');
  assert(/auto_rollback/.test(src), 'rollback خودکار در شکست تطبیق نیست');
  return 'batch → rollback مسیر کامل';
});

console.log(`\nCT checks=${passed + failed} pass=${passed} fail=${failed}`);
if (failures.length) console.log('failures: ' + failures.join(','));
console.log(failed === 0 ? 'CELL-TRANSFER-54-TEST-OK' : 'CELL-TRANSFER-54-TEST-FAILED');
process.exit(failed === 0 ? 0 : 1);
