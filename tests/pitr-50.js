'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون ردیف ۵۰ — پشتیبان‌گیری مدیریت‌شده / PITR و تمرین بازیابی
                                                   (PT-01 .. PT-10)

   اجرا: npm run test:pitr50
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pitr = require(path.join(ROOT, 'server', 'pitr.js'));
const transfer = require(path.join(ROOT, 'server', 'transfer.js'));

let passed = 0, failed = 0; const failures = [];
function check(id, desc, fn) {
  try { const d = fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 260)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

const TOOL = path.join(ROOT, 'tools', 'pitr-drill-50.mjs');
const run = (args, env = {}) => spawnSync(process.execPath, [TOOL, ...args], {
  encoding: 'utf8', cwd: ROOT, env: Object.assign({}, process.env, env),
});

const TENANT_A = '11111111-2222-4333-8444-555555555555';
const TENANT_B = '22222222-3333-4444-8555-666666666666';

check('PT-01', 'آستانه‌های RPO (<= ۵ دقیقه) و RTO (<= ۲ ساعت) و کنترل منفی نقض آن‌ها', () => {
  const okEval = pitr.evaluatePitrDrill({
    rpoMs: 12000,
    rtoMs: 45000,
    reconciliation: { ok: true },
    postTargetExcluded: true,
    hostInfo: { managed: true, tag: '[M]', kind: 'managed-provider' },
  });
  assert(okEval.ok === true && okEval.production_valid === true && okEval.verdict === 'PITR-50-MANAGED-OK', 'حالت سالم باید MANAGED-OK باشد');

  const badRpo = pitr.evaluatePitrDrill({
    rpoMs: 300001,
    rtoMs: 1000,
    reconciliation: { ok: true },
    postTargetExcluded: true,
    hostInfo: { managed: true, tag: '[M]', kind: 'managed-provider' },
  });
  assert(badRpo.ok === false && badRpo.rpo_ok === false && badRpo.verdict === 'PITR-50-FAILED', 'نقض RPO باید رد شود');

  const badRto = pitr.evaluatePitrDrill({
    rpoMs: 1000,
    rtoMs: 7200001,
    reconciliation: { ok: true },
    postTargetExcluded: true,
    hostInfo: { managed: true, tag: '[M]', kind: 'managed-provider' },
  });
  assert(badRto.ok === false && badRto.rto_ok === false && badRto.verdict === 'PITR-50-FAILED', 'نقض RTO باید رد شود');
  return `RPO<=${pitr.RPO_TARGET_MS}ms · RTO<=${pitr.RTO_TARGET_MS}ms`;
});

check('PT-02', 'تفکیک [S] و [M]: میزبان محلی در حالت --require-managed با exit=3 رد می‌شود', () => {
  const loc = pitr.classifyPgHost('postgres://user:pass@127.0.0.1:5432/payesh');
  const neon = pitr.classifyPgHost('postgres://user:pass@ep-cool-sky.eu-central-1.aws.neon.tech/neondb');
  assert(loc.managed === false && loc.tag === '[S]', '127.0.0.1 نباید managed باشد');
  assert(neon.managed === true && neon.tag === '[M]', 'neon.tech باید managed باشد');

  const r1 = run(['--local-drill', '--require-managed']);
  const r2 = run(['--pg-drill', '--primary', 'postgres://127.0.0.1:5432/a', '--restored', 'postgres://127.0.0.1:5432/b', '--require-managed']);
  assert(r1.status === 3 && /PITR-50-NOT-MANAGED-PG/.test(r1.stderr), `local exit=${r1.status}`);
  assert(r2.status === 3 && /PITR-50-NOT-MANAGED-PG/.test(r2.stderr), `pg-local exit=${r2.status}`);
  return '127.0.0.1→[S] (exit=3) · neon.tech→[M]';
});

check('PT-03', 'بازیابی به نقطهٔ زمانی (t <= target_iso): حذف کامل تراکنش‌های مخرب پس از نقطهٔ هدف', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt03-'));
  try {
    const ar = pitr.createWalArchive(tmp);
    ar.writeBaseBackup({
      product_records: [{ id: '1', tenant_id: TENANT_A, version: 1, payload: { a: 1 } }],
    }, '2026-11-08T09:00:00.000Z');
    ar.appendWalEntry({
      lsn: 1, at: '2026-11-08T09:02:00.000Z', op: 'upsert', table: 'product_records',
      tenant_id: TENANT_A, id: '2', row: { id: '2', tenant_id: TENANT_A, version: 1, payload: { a: 2 } },
    });
    ar.appendWalEntry({
      lsn: 2, at: '2026-11-08T09:04:00.000Z', op: 'delete', table: 'product_records',
      tenant_id: TENANT_A, id: '1',
    });
    const out = ar.restoreToPointInTime('2026-11-08T09:03:00.000Z');
    assert(out.replayed === 1 && out.skipped_after_target === 1, `replayed=${out.replayed} skipped=${out.skipped_after_target}`);
    assert(out.tables.product_records.length === 2, `rows=${out.tables.product_records.length}`);
    assert(out.rpo_ms === 60000, `rpo_ms=${out.rpo_ms}`);
    return `replayed=1 skipped=1 rpo=${out.rpo_ms}ms`;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('PT-04', 'تطبیق سه‌لایهٔ چک‌سام SHA-256 پس از بازیابی (counts + checksums + seqs)', () => {
  const expected = {
    product_records: [{ id: '1', tenant_id: TENANT_A, version: 2, payload: { score: 20 } }],
    product_change_feed: [{ id: 'c1', tenant_id: TENANT_A, seq: 7 }],
  };
  const s1 = pitr.snapshotFromTables(expected, TENANT_A);
  const s2 = pitr.snapshotFromTables(JSON.parse(JSON.stringify(expected)), TENANT_A);
  const rec = transfer.reconcile(s1, s2);
  assert(rec.ok === true, 'reconcile should pass');
  return `tables=${rec.tables} seqs=${rec.layer3.compared}`;
});

check('PT-05', 'کنترل منفی لایهٔ ۲: تغییر ۱ بایت در دادهٔ بازیابی‌شده چک‌سام را قرمز می‌کند', () => {
  const expected = { product_records: [{ id: '1', tenant_id: TENANT_A, version: 2, payload: { score: 20 } }] };
  const tampered = { product_records: [{ id: '1', tenant_id: TENANT_A, version: 2, payload: { score: 19 } }] };
  const rec = transfer.reconcile(pitr.snapshotFromTables(expected, TENANT_A), pitr.snapshotFromTables(tampered, TENANT_A));
  const ev = pitr.evaluatePitrDrill({ rpoMs: 1000, rtoMs: 1000, reconciliation: rec, postTargetExcluded: true });
  assert(rec.layer1[0].ok === true && rec.layer2[0].ok === false, 'layer2 must fail');
  assert(ev.ok === false && ev.verdict === 'PITR-50-FAILED', 'evaluation must fail');
  return '1-byte tamper → PITR-50-FAILED';
});

check('PT-06', 'کنترل منفی دستکاری فایل پشتیبان یا WAL: تشخیص فساد CRC با SHA-256', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt06-'));
  try {
    const ar = pitr.createWalArchive(tmp);
    ar.writeBaseBackup({ product_records: [] }, '2026-11-08T09:00:00.000Z');
    ar.appendWalEntry({ lsn: 1, at: '2026-11-08T09:01:00.000Z', op: 'upsert', table: 'product_records', id: '1', row: { id: '1' } });
    const corruptedWal = fs.readFileSync(ar.walFile, 'utf8').replace('"id":"1"', '"id":"9"');
    fs.writeFileSync(ar.walFile, corruptedWal, 'utf8');
    let threw = false;
    try { ar.restoreToPointInTime('2026-11-08T09:02:00.000Z'); }
    catch (e) { threw = /wal_crc_mismatch/.test(e.message); }
    assert(threw, 'فساد WAL باید تشخیص داده شود');
    return 'wal_crc_mismatch caught';
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('PT-07', 'کنترل منفی لایهٔ ۳: کسری آخرین seq در change-feed بازیابی‌شده تشخیص داده می‌شود', () => {
  const expected = { product_change_feed: [{ id: 'c1', tenant_id: TENANT_A, seq: 10 }] };
  const stale = { product_change_feed: [{ id: 'c1', tenant_id: TENANT_A, seq: 9 }] };
  const rec = transfer.reconcile(pitr.snapshotFromTables(expected, TENANT_A), pitr.snapshotFromTables(stale, TENANT_A));
  assert(rec.layer3.ok === false && rec.layer3.mismatch_count === 1, 'layer3 must detect stale seq');
  return 'seq 10≠9 detected';
});

check('PT-08', 'ایزولاسیون مستأجر در محاسبهٔ چک‌سام بازیابی (Tenant A از Tenant B جداست)', () => {
  const mixed = {
    product_records: [
      { id: '1', tenant_id: TENANT_A, version: 1, payload: { x: 'a' } },
      { id: '2', tenant_id: TENANT_B, version: 1, payload: { x: 'b' } },
    ],
  };
  const snapA = pitr.snapshotFromTables(mixed, TENANT_A);
  const snapB = pitr.snapshotFromTables(mixed, TENANT_B);
  assert(snapA.counts.product_records === 1 && snapB.counts.product_records === 1, 'count=1 per tenant');
  assert(snapA.checksums.product_records !== snapB.checksums.product_records, 'checksums distinct');
  return 'tenant-isolated checksums';
});

check('PT-09', 'اجرای CLI تمرین محلی (--local-drill) و ثبت صادقانهٔ برچسب [S]', () => {
  const r = run(['--local-drill']);
  assert(r.status === 0, `exit=${r.status} stderr=${r.stderr}`);
  assert(/PITR-50-SIMULATED-OK/.test(r.stdout), 'verdict باید PITR-50-SIMULATED-OK باشد');
  const jsonText = r.stdout.trim().split('\n').slice(0, -1).join('\n');
  const parsed = JSON.parse(jsonText);
  assert(parsed.evaluation.tag === '[S]' && parsed.evaluation.production_valid === false, 'باید [S] و غیرتولیدی علامت بخورد');
  assert(parsed.reconciliation.ok === true && parsed.skipped_post_target_entries === 2, 'تطبیق و حذف تراکنش‌های بعدی');
  return `verdict=${parsed.evaluation.verdict} tag=${parsed.evaluation.tag}`;
});

check('PT-10', 'مستندسازی کامل رویهٔ Failover دستی در docs/cloud/50-pitr-recovery.md', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'cloud', '50-pitr-recovery.md'), 'utf8');
  for (const needle of [
    'گام ۱ — توقف نوشتن',
    'گام ۲ — ساخت شاخه/نمونهٔ بازیابی',
    'گام ۳ — راستی‌آزمایی WAL/LSN و تطبیق سه‌لایهٔ چک‌سام',
    'گام ۴ — تغییر مسیر ترافیک',
    'گام ۵ — باز کردن نوشتن',
    '--require-managed',
    'RPO <= ۵ دقیقه',
    'RTO <= ۲ ساعت',
  ]) {
    assert(doc.includes(needle), `بخش غایب در ران‌بوک: ${needle}`);
  }
  return '5-step manual failover runbook verified';
});

console.log('');
console.log(`PT checks=${passed + failed} pass=${passed} fail=${failed}`);
if (failed === 0) console.log('PITR-50-TEST-OK');
else { console.log('failed: ' + failures.join(',')); console.log('PITR-50-TEST-FAIL'); }
process.exit(failed === 0 ? 0 : 1);
