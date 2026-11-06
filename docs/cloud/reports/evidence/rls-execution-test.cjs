/*
 * آزمون اجرایی RLS — A-02
 * اجرا: bash docs/cloud/reports/evidence/rls-execution-test.sh
 * نیازمند: یک PostgreSQL واقعی در حال اجرا روی RLS_TEST_PORT (پیش‌فرض 5599)
 * نقش‌ها: superuser=postgres · owner=payesh_owner (NOLOGIN) · runtime=payesh_app
 */
'use strict';
const { Client } = require('pg');

const PORT = Number(process.env.RLS_TEST_PORT || 5599);
const HOST = process.env.RLS_TEST_HOST || '127.0.0.1';
const TA = '11111111-1111-1111-1111-111111111111';
const TB = '22222222-2222-2222-2222-222222222222';

let failures = 0;
const results = [];
function check(id, desc, ok, detail) {
  results.push({ id, desc, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${desc}${detail ? '  → ' + detail : ''}`);
}

async function asTenant(client, tenantId, fn) {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  try {
    const out = await fn();
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

(async () => {
  const admin = new Client({ host: HOST, port: PORT, user: 'postgres', database: 'postgres' });
  await admin.connect();
  const v = (await admin.query('SELECT version() AS v')).rows[0].v;
  console.log('postgres: ' + v.split(' on ')[0]);

  // --- پاک‌سازی و ساخت نقش‌ها ---
  await admin.query(`DROP DATABASE IF EXISTS payesh_rls`);
  await admin.query(`DROP ROLE IF EXISTS payesh_app`);
  await admin.query(`DROP ROLE IF EXISTS payesh_owner`);
  await admin.query(`CREATE ROLE payesh_owner NOLOGIN`);
  await admin.query(`CREATE ROLE payesh_app LOGIN PASSWORD 'app-test-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  await admin.query(`CREATE DATABASE payesh_rls OWNER payesh_owner`);

  const owner = new Client({ host: HOST, port: PORT, user: 'postgres', database: 'payesh_rls' });
  // بازرس: همان نقش superuser ولی روی پایگاه آزمون (RLS را دور می‌زند؛ فقط برای تأیید داده)
  const inspector = new Client({ host: HOST, port: PORT, user: 'postgres', database: 'payesh_rls' });
  await owner.connect();
  await inspector.connect();
  // جدول را با نقش مالک بساز (مالکیت واقعی روی payesh_owner)
  await owner.query('BEGIN');
  await owner.query('SET ROLE payesh_owner');
  await owner.query(`CREATE TABLE records (
      id bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL,
      payload text NOT NULL,
      version int NOT NULL DEFAULT 1
    )`);
  await owner.query('ALTER TABLE records ENABLE ROW LEVEL SECURITY');
  await owner.query('ALTER TABLE records FORCE  ROW LEVEL SECURITY');
  await owner.query(`CREATE POLICY records_select ON records FOR SELECT
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`);
  await owner.query(`CREATE POLICY records_insert ON records FOR INSERT
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`);
  await owner.query(`CREATE POLICY records_update ON records FOR UPDATE
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`);
  await owner.query(`CREATE POLICY records_delete ON records FOR DELETE
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`);
  await owner.query('GRANT USAGE ON SCHEMA public TO payesh_app');
  await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON records TO payesh_app');
  await owner.query('GRANT USAGE, SELECT ON SEQUENCE records_id_seq TO payesh_app');
  await owner.query('COMMIT');

  // انبارش دادهٔ دو مستأجر (با context، چون FORCE حتی برای مالک هم اعمال می‌شود)
  for (const t of [TA, TB]) {
    await owner.query('BEGIN');
    await owner.query("SELECT set_config('app.tenant_id', $1, true)", [t]);
    for (let i = 1; i <= 10; i++) {
      await owner.query('INSERT INTO records (tenant_id, payload) VALUES ($1, $2)', [t, `${t === TA ? 'A' : 'B'}-row-${i}`]);
    }
    await owner.query('COMMIT');
  }

  // خواندن کامل فقط با نقش superuser (که RLS را دور می‌زند) — برای بازرسی، نه برای اپلیکیشن
  const counts = (await inspector.query('SELECT tenant_id, count(*)::int AS n FROM records GROUP BY tenant_id ORDER BY 1')).rows;
  console.log('seed: ' + JSON.stringify(counts));

  // --- اتصال runtime ---
  const app = new Client({ host: HOST, port: PORT, user: 'payesh_app', password: 'app-test-only', database: 'payesh_rls' });
  await app.connect();

  // N0: نقش runtime مالک جدول نیست
  const own = (await app.query(`SELECT tableowner FROM pg_tables WHERE tablename='records'`)).rows[0].tableowner;
  check('N0', 'مالک جدول ≠ نقش runtime', own === 'payesh_owner', `owner=${own}`);

  // N9: نه superuser، نه BYPASSRLS
  const r = (await app.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0];
  check('N9', 'نقش runtime بدون SUPERUSER/BYPASSRLS', r.rolsuper === false && r.rolbypassrls === false,
    `rolsuper=${r.rolsuper} rolbypassrls=${r.rolbypassrls}`);

  // N1: خواندن فقط مستأجر خود
  const n1 = await asTenant(app, TA, async () => (await app.query('SELECT count(*)::int AS n FROM records')).rows[0].n);
  check('N1', 'context=A ⇒ فقط ۱۰ ردیف A', n1 === 10, `n=${n1}`);

  const n1b = await asTenant(app, TA, async () =>
    (await app.query('SELECT count(*)::int AS n FROM records WHERE tenant_id = $1', [TB])).rows[0].n);
  check('N1b', 'context=A و پرس‌وجوی صریح B ⇒ صفر ردیف', n1b === 0, `n=${n1b}`);

  // N2: تغییر دادهٔ مستأجر دیگر
  const n2 = await asTenant(app, TA, async () =>
    (await app.query("UPDATE records SET payload='hacked' WHERE tenant_id = $1", [TB])).rowCount);
  check('N2', 'UPDATE روی B با context=A ⇒ صفر ردیف', n2 === 0, `rowCount=${n2}`);

  // N3: حذف دادهٔ مستأجر دیگر
  const n3 = await asTenant(app, TA, async () =>
    (await app.query('DELETE FROM records WHERE tenant_id = $1', [TB])).rowCount);
  check('N3', 'DELETE روی B با context=A ⇒ صفر ردیف', n3 === 0, `rowCount=${n3}`);

  // N4: INSERT با tenant اشتباه
  let n4ok = false, n4detail = '';
  try {
    await asTenant(app, TA, async () =>
      app.query('INSERT INTO records (tenant_id, payload) VALUES ($1, $2)', [TB, 'forged']));
  } catch (e) {
    n4ok = /row-level security/i.test(e.message);
    n4detail = e.message.split('\n')[0];
  }
  check('N4', 'INSERT با tenant_id=B در context=A ⇒ رد', n4ok, n4detail);

  // N5: جابه‌جایی ردیف به مستأجر دیگر
  let n5ok = false, n5detail = '';
  try {
    await asTenant(app, TA, async () =>
      app.query('UPDATE records SET tenant_id = $1 WHERE tenant_id = $2', [TB, TA]));
  } catch (e) {
    n5ok = /row-level security/i.test(e.message);
    n5detail = e.message.split('\n')[0];
  }
  check('N5', 'UPDATE که tenant را A→B می‌برد ⇒ رد', n5ok, n5detail);

  // N6: بدون context ⇒ صفر ردیف (نه خطا، با nullif)
  const n6 = (await app.query('SELECT count(*)::int AS n FROM records')).rows[0].n;
  let ctx6 = null;
  try { ctx6 = (await app.query(`SELECT current_setting('app.tenant_id', true) AS t`)).rows[0].t; } catch { ctx6 = '<error>'; }
  check('N6', 'بدون context ⇒ صفر ردیف (fail-closed)', n6 === 0, `n=${n6} ctx=${JSON.stringify(ctx6)}`);

  // N6b: نکتهٔ اجرایی واقعی — پس از پایان تراکنش، GUC به '' برمی‌گردد نه NULL
  let n6b = false, n6bDetail = '';
  try {
    await app.query(`SELECT current_setting('app.tenant_id', true)::uuid`);
  } catch (e) {
    n6b = /invalid input syntax for type uuid/i.test(e.message);
    n6bDetail = e.message.split('\n')[0];
  }
  check('N6b', "cast خام ''::uuid خطا می‌دهد ⇒ الزام nullif() در سیاست", n6b, n6bDetail);

  // N7: مالک جدول هم محدود است (FORCE)
  await owner.query('BEGIN');
  await owner.query('SET ROLE payesh_owner');
  await owner.query("SELECT set_config('app.tenant_id', $1, true)", [TA]);
  const n7 = (await owner.query('SELECT count(*)::int AS n FROM records')).rows[0].n;
  await owner.query('ROLLBACK');
  check('N7', 'FORCE RLS: مالک هم فقط ۱۰ ردیف A را می‌بیند', n7 === 10, `n=${n7}`);

  // N8: تلاش تغییر نقش
  let n8ok = false, n8detail = '';
  try {
    await app.query('SET ROLE payesh_owner');
  } catch (e) {
    n8ok = /permission denied|must be member/i.test(e.message);
    n8detail = e.message.split('\n')[0];
  }
  check('N8', 'runtime نمی‌تواند SET ROLE payesh_owner', n8ok, n8detail);

  // N10: نشت context میان دو تراکنش روی یک اتصال
  const a10 = await asTenant(app, TA, async () => (await app.query('SELECT count(*)::int AS n FROM records')).rows[0].n);
  const afterCommit = (await app.query(`SELECT current_setting('app.tenant_id', true) AS t`)).rows[0].t;
  const b10 = await asTenant(app, TB, async () => (await app.query('SELECT count(*)::int AS n FROM records')).rows[0].n);
  check('N10', 'دو مستأجر پشت‌سرهم روی یک اتصال ⇒ بدون نشت',
    a10 === 10 && b10 === 10 && (afterCommit === null || afterCommit === ''),
    `A=${a10} B=${b10} ctx_after_commit=${JSON.stringify(afterCommit)}`);

  // صحت داده پس از آزمون‌ها
  const finalCounts = (await inspector.query('SELECT tenant_id, count(*)::int AS n FROM records GROUP BY tenant_id ORDER BY 1')).rows;
  check('N11', 'هیچ ردیفی از B تغییر/حذف نشد', finalCounts.length === 2 && finalCounts.every((x) => x.n === 10),
    JSON.stringify(finalCounts));

  await app.end();
  await owner.end();
  await inspector.end();
  await admin.end();

  console.log(`\nTOTAL ${results.length} · FAIL ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('RUNNER-ERROR: ' + (e && e.message));
  process.exit(2);
});
