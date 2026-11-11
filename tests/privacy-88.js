'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 88 — user data delete/export (privacy).            PV-01 .. PV-19
   Doc: docs/security/88-privacy-delete-export.md · Module: server/privacy.js

   AC (Notion row 88):
     • delete/export path with a ROLE ALLOWLIST            PV-01, PV-10..PV-15
     • a non-manager export carries no one else's national_id
                                                           PV-02, PV-11, PV-13, PV-14
     • tombstone retention is defined                      PV-03, PV-05, PV-18
     • a cross-school request is refused (negative test)   PV-04, PV-16, PV-17
     • negative control: the fixture really contains leakable data, so a
       green run is not vacuous                            PV-19

   Pure + SQLite parts always run. The cloud part needs real PostgreSQL:
     PAYESH_PG_ADMIN=postgres://postgres@127.0.0.1:5432/payesh_c64 node tests/privacy-88.js
   (PV88_REQUIRE_PG=1 turns "no PG" into a failure, as in CI)
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const privacy = require(path.join(ROOT, 'server/privacy.js'));

let passed = 0, failed = 0;
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

const NID = { manager: '1111111111', teacher: '2222222222', s3: '0012345678', s4: '0098765432', parent: '5555555555', b9: '9999999999', stray: '7777777777' };

async function pure() {
  await check('PV-01', 'export role allowlist is closed: manager=school; teacher/counselor/parent/student=scoped; guard/unknown refused', () => {
    eq(['manager', 'teacher', 'counselor', 'parent', 'student', 'guard', 'admin', '', 'MANAGER'].map(privacy.exportMode),
      ['school', 'scoped', 'scoped', 'scoped', 'scoped', null, null, null, null], 'modes');
    assert(Object.isFrozen(privacy.EXPORT_ROLES), 'allowlist frozen');
    return 'guard,admin,"",MANAGER → refused';
  });
  await check('PV-02', 'scrub: non-manager loses identity fields in ANY collection (not only users) except own users row; secrets go for everyone', () => {
    const data = { name: 'x', national_id: NID.s3, father_nid: '1', phone: '0912', password_hash: 'h', token_x: 't', score: 19 };
    eq(Object.keys(privacy.scrubExportData(data, { role: 'teacher' })), ['name', 'score'], 'teacher, other row');
    eq(Object.keys(privacy.scrubExportData(data, { role: 'teacher', self: true })), ['name', 'national_id', 'father_nid', 'phone', 'score'], 'self row');
    eq(Object.keys(privacy.scrubExportData(data, { role: 'manager' })), ['name', 'national_id', 'father_nid', 'phone', 'score'], 'manager');
    const att = privacy.scrubExportRow({ role: 'parent', uid: 5 }, { collection: 'attendance', id: 9, data: { student_id: 3, national_id: NID.stray } });
    assert(!('national_id' in att.data), 'attendance row with a stray national_id is scrubbed');
    const selfRow = privacy.scrubExportRow({ role: 'parent', uid: 5 }, { collection: 'users', id: 5, data: { national_id: NID.parent } });
    eq(selfRow.data.national_id, NID.parent, 'own users row keeps own national_id');
    const notSelf = privacy.scrubExportRow({ role: 'parent', uid: 5 }, { collection: 'grades', id: 5, data: { national_id: NID.s3 } });
    assert(!('national_id' in notSelf.data), 'id==uid in ANOTHER collection is not "self"');
  });
  await check('PV-03', 'tombstone retention: default 90 days, minimum 31 (> device stale 30 / feed keep 30), maximum 3650; invalid → null', () => {
    eq([undefined, '', '90', '31', '30', '3650', '3651', 'abc', '-5'].map(v => privacy.tombstoneRetainDays(v)),
      [90, 90, 90, 31, null, 3650, null, null, null], 'retain days');
    eq(privacy.checkRetainDays(undefined), 90, 'request without retain_days → default');
    return 'min=31 default=90 max=3650';
  });
  await check('PV-04', 'cross-school: tenant_id/tenantId/tid in body or query must equal the token tenant (case-insensitive)', () => {
    const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002';
    eq(privacy.crossTenant(A, { tenant_id: A.toUpperCase() }), null, 'same school');
    eq(privacy.crossTenant(A, {}, new URLSearchParams()), null, 'none named');
    eq(privacy.crossTenant(A, { tenantId: B }), { key: 'tenantId' }, 'body tenantId');
    eq(privacy.crossTenant(A, null, new URLSearchParams('tid=' + B)), { key: 'tid' }, 'query tid');
    eq(privacy.crossTenant(A, { collection: 'x', data: { tenant_id: B } }), null, 'nested record data is not a request-level school (row data is cleaned elsewhere)');
  });
}

async function localSqlite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-pv88-'));
  const { openStore } = require(path.join(ROOT, 'server/db.js'));
  const store = openStore(path.join(dir, 'payesh.db'));
  try {
    await check('PV-05', 'local school server (SQLite): tombstone view has no body; purge removes only tombstones older than retention', () => {
      const a = store.insert('grades', { student_id: 3, class_id: 10, score: 18 });
      const b = store.insert('grades', { student_id: 4, class_id: 11, score: 12 });
      const c = store.insert('users', { name: 'old', role: 'student', national_id: NID.s4 });
      const live = store.insert('grades', { student_id: 3, class_id: 10, score: 20 });
      store.remove('grades', a.id); store.remove('grades', b.id); store.remove('users', c.id);
      const old = new Date(Date.now() - 100 * 86400000).toISOString();
      store.db.prepare('UPDATE records SET deleted_at=? WHERE collection=? AND id=?').run(old, 'grades', a.id);
      store.db.prepare('UPDATE records SET deleted_at=? WHERE collection=? AND id=?').run(old, 'users', c.id);
      const view = store.tombstones(50);
      eq(view.length, 3, 'three tombstones');
      for (const t of view) eq(Object.keys(t).sort(), ['collection', 'deleted_at', 'id', 'version'], 'metadata only');
      assert(!JSON.stringify(view).includes(NID.s4), 'deleted user national_id not in the view');
      const out = store.purgeTombstones(90);
      eq([out.purged, out.tombstones_left, out.by_collection], [2, 1, { grades: 1, users: 1 }], 'purge');
      const raw = store.db.prepare('SELECT COUNT(*) n FROM records WHERE data LIKE ?').get('%' + NID.s4 + '%').n;
      eq(raw, 0, 'purged user national_id gone from the database file');
      assert(store.get('grades', live.id), 'live row untouched');
      return `purged=${out.purged} left=${out.tombstones_left}`;
    });
    await check('PV-06', 'local endpoints sit behind the manager-only /api/admin gate and validate retain_days', () => {
      const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
      const gate = src.indexOf("if (p.startsWith('/api/admin/') && actor.role !== 'manager'");
      const ep = src.indexOf("p === '/api/admin/tombstones'");
      const purge = src.indexOf("p === '/api/admin/tombstones/purge'");
      assert(gate > 0 && ep > gate && purge > gate, 'tombstone endpoints after the admin gate');
      assert(!/backupPath = .*tombstones/.test(src), 'tombstones are not a backup-role exception');
      assert(/privacy\.checkRetainDays\(body && body\.retain_days\)/.test(src.slice(purge, purge + 400)), 'purge validates retain_days');
    });
  } finally {
    try { store.db.close(); } catch (e) { /* noop */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withDb(url, db) { const u = new URL(url); u.pathname = '/' + db; return u.toString(); }

async function cloud() {
  const ADMIN = process.env.PAYESH_PG_ADMIN;
  if (!ADMIN) {
    if (process.env.PV88_REQUIRE_PG === '1') { failed++; console.log('FAIL  PV-PG  PAYESH_PG_ADMIN is required (PV88_REQUIRE_PG=1)'); return; }
    console.log('SKIP  PV-10..PV-19 need PostgreSQL (set PAYESH_PG_ADMIN)');
    return;
  }
  const { Client } = require('pg');
  const tenancy = require(path.join(ROOT, 'server/tenancy.js'));
  const DB = `payesh_pv88_${process.pid}_${Date.now().toString(36)}`;
  const root = new Client({ connectionString: ADMIN }); root.on('error', () => {});
  await root.connect();
  await root.query(`CREATE DATABASE ${DB}`);
  const admin = new Client({ connectionString: withDb(ADMIN, DB) }); admin.on('error', () => {});
  const SECRET = 'pv88-secret-' + 'x'.repeat(24);
  const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002';
  try {
    await admin.connect();
    await tenancy.migrate(admin);
    const ru = new URL(withDb(ADMIN, DB)); ru.username = tenancy.RUNTIME_ROLE; ru.password = '';
    tenancy.init({ connectionString: ru.toString(), secret: SECRET });
    const pool = tenancy.getPool();
    const put = (t, collection, id, data) => tenancy.upsertProduct(pool, t, { collection, id, data });
    /* school A */
    await put(A, 'users', 1, { name: 'مدیر', role: 'manager', national_id: NID.manager, password_hash: 'secret-hash' });
    await put(A, 'users', 2, { name: 'دبیر', role: 'teacher', national_id: NID.teacher });
    await put(A, 'users', 3, { name: 'دانش‌آموز ۳', role: 'student', class_id: 10, national_id: NID.s3, father_nid: '3333333331' });
    await put(A, 'users', 4, { name: 'دانش‌آموز ۴', role: 'student', class_id: 11, national_id: NID.s4 });
    await put(A, 'users', 5, { name: 'ولی', role: 'parent', national_id: NID.parent });
    await put(A, 'parent_links', 1, { parent_id: 5, student_id: 3 });
    await put(A, 'schedule', 1, { class_id: 10, teacher_id: 2, day: 1, period: 1 });
    await put(A, 'grades', 1, { student_id: 3, class_id: 10, score: 18 });
    await put(A, 'grades', 2, { student_id: 4, class_id: 11, score: 12 });
    await put(A, 'attendance', 1, { student_id: 3, class_id: 10, status: 'present', national_id: NID.stray });
    await put(A, 'attendance', 2, { student_id: 4, class_id: 11, status: 'absent' });
    /* school B */
    await put(B, 'users', 9, { name: 'دانش‌آموز B', role: 'student', class_id: 10, national_id: NID.b9 });
    await put(B, 'grades', 1, { student_id: 9, class_id: 10, score: 15 });

    const tok = (tid, role, uid) => tenancy.signToken({ tid, role, uid, did: 'pv88-' + role, iat: Date.now(), exp: Date.now() + 600000 }, SECRET);
    const T = { mgr: tok(A, 'manager', 1), tch: tok(A, 'teacher', 2), stu: tok(A, 'student', 3), par: tok(A, 'parent', 5), grd: tok(A, 'guard', 6), mgrB: tok(B, 'manager', 1) };
    const call = (method, p, token, body, q) => tenancy.route({
      method, pathname: '/api/cloud/tenancy/product' + p, search: new URLSearchParams(q || ''),
      headers: { authorization: 'Bearer ' + token }, body: body || {},
    });
    const others = (json, keep) => Object.entries(NID).filter(([k]) => !keep.includes(k)).filter(([, v]) => json.includes(v)).map(([k]) => k);

    await check('PV-10', 'manager exports the whole school with identity fields; secrets removed; no other school', async () => {
      const r = await call('POST', '/export', T.mgr, { collection: 'users' });
      eq(r.status, 200, 'status');
      const j = JSON.stringify(r.body);
      eq([r.body.count, r.body.scope], [5, 'school'], 'count/scope');
      assert(j.includes(NID.s3) && j.includes(NID.s4), 'manager sees national_id (D1)');
      assert(!j.includes('secret-hash') && !j.includes('password_hash'), 'password_hash never exported');
      assert(!j.includes(NID.b9), 'school B absent');
      return 'users=5 identity=yes secrets=no';
    });
    await check('PV-11', 'teacher export of grades/attendance = own classes only, and no one\'s national_id (also not a stray one inside attendance)', async () => {
      const g = await call('POST', '/export', T.tch, { collection: 'grades' });
      const a = await call('POST', '/export', T.tch, { collection: 'attendance' });
      eq([g.status, a.status], [200, 200], 'status');
      eq(g.body.rows.map(r => r.data.student_id), [3], 'grades: class 10 only');
      eq(a.body.rows.map(r => r.data.student_id), [3], 'attendance: class 10 only');
      const leak = others(JSON.stringify([g.body, a.body]), []);
      eq(leak, [], 'national_ids in teacher export');
      return `grades=${g.body.count} attendance=${a.body.count} scope=${g.body.scope}`;
    });
    await check('PV-12', 'non-manager full users export stays refused (row 57)', async () => {
      const r = await call('POST', '/export', T.tch, { collection: 'users' });
      eq([r.status, r.body.error], [403, 'forbidden'], 'teacher users export');
      const p = await call('POST', '/export', T.par, { collection: 'users' });
      eq(p.status, 403, 'parent users export');
    });
    await check('PV-13', 'parent "my data": own row with own national_id, the linked child without national_id, child\'s grades only', async () => {
      const r = await call('POST', '/export/me', T.par);
      eq(r.status, 200, 'status');
      const j = JSON.stringify(r.body);
      assert(j.includes(NID.parent), 'own national_id present');
      eq(others(j, ['parent']), [], 'other national_ids');
      const users = r.body.rows.filter(x => x.collection === 'users').map(x => x.id).sort();
      eq(users, [3, 5], 'users rows = self + linked child');
      const grades = r.body.rows.filter(x => x.collection === 'grades').map(x => x.data.student_id);
      eq(grades, [3], 'child grades only');
      return JSON.stringify(r.body.by_collection);
    });
    await check('PV-14', 'student "my data": own national_id + father_nid, nothing of classmates; manager "my data" = own row only', async () => {
      const r = await call('POST', '/export/me', T.stu);
      const j = JSON.stringify(r.body);
      assert(r.status === 200 && j.includes(NID.s3) && j.includes('3333333331'), 'own identity present');
      eq(others(j, ['s3']), [], 'other national_ids');
      const m = await call('POST', '/export/me', T.mgr);
      eq(m.body.rows.map(x => `${x.collection}/${x.id}`), ['users/1'], 'manager own data');
      return `student rows=${r.body.count}`;
    });
    await check('PV-15', 'guard (not on the allowlist) cannot export anything, not even "my data"', async () => {
      const a = await call('POST', '/export', T.grd, { collection: 'announcements' });
      const b = await call('POST', '/export/me', T.grd);
      eq([a.status, a.body.error, b.status, b.body.error], [403, 'export_role_denied', 403, 'export_role_denied'], 'guard');
    });
    await check('PV-16', 'NEGATIVE: cross-school request (token A, body/query names school B) is refused with cross_tenant', async () => {
      const r1 = await call('POST', '/export', T.mgr, { collection: 'grades', tenant_id: B });
      const r2 = await call('GET', '', T.mgr, null, 'collection=grades&tenant_id=' + B);
      const r3 = await call('POST', '/tombstones/purge', T.mgr, { tid: B });
      const r4 = await call('POST', '/export/me', T.par, { tenantId: B });
      eq([r1.status, r2.status, r3.status, r4.status], [403, 403, 403, 403], 'statuses');
      eq([r1.body.error, r2.body.error, r3.body.error, r4.body.error], ['cross_tenant', 'cross_tenant', 'cross_tenant', 'cross_tenant'], 'errors');
      const ok = await call('POST', '/export', T.mgr, { collection: 'grades', tenant_id: A });
      eq(ok.status, 200, 'naming the own school is fine');
      return 'body tenant_id, query tenant_id, body tid, body tenantId → 403';
    });
    await check('PV-17', 'RLS backstop: manager of B exporting never sees A, and A never sees B', async () => {
      const b = await call('POST', '/export', T.mgrB, { collection: 'users' });
      const jb = JSON.stringify(b.body);
      eq(b.body.count, 1, 'B users');
      assert(!jb.includes(NID.s3) && !jb.includes(NID.manager), 'no A identities in B export');
    });
    await check('PV-18', 'tombstones: manager-only view without body; purge refuses < 31 days; purges only old tombstones of the own school', async () => {
      await tenancy.deleteProduct(pool, A, { collection: 'users', id: 4 });
      await tenancy.deleteProduct(pool, A, { collection: 'grades', id: 2 });
      await tenancy.deleteProduct(pool, B, { collection: 'grades', id: 1 });
      const v = await call('GET', '/tombstones', T.mgr);
      eq([v.status, v.body.count, v.body.retain_days], [200, 2, 90], 'view');
      for (const t of v.body.rows) eq(Object.keys(t).sort(), ['collection', 'deleted_at', 'id', 'version'], 'metadata only');
      assert(!JSON.stringify(v.body).includes(NID.s4), 'deleted national_id not in view');
      eq((await call('GET', '/tombstones', T.tch)).status, 403, 'teacher view');
      eq((await call('POST', '/tombstones/purge', T.tch, {})).status, 403, 'teacher purge');
      const bad = await call('POST', '/tombstones/purge', T.mgr, { retain_days: 30 });
      eq([bad.status, bad.body.error], [400, 'bad_retain_days'], 'retain 30 refused');
      await admin.query(`update ${tenancy.PRODUCT_TABLE} set deleted_at = now() - interval '100 days' where deleted_at is not null and collection = 'users'`);
      await admin.query(`update ${tenancy.PRODUCT_TABLE} set deleted_at = now() - interval '100 days' where tenant_id = $1 and deleted_at is not null`, [B]);
      const p = await call('POST', '/tombstones/purge', T.mgr, {});
      eq([p.status, p.body.purged, p.body.by_collection, p.body.tombstones_left, p.body.retain_days], [200, 1, { users: 1 }, 1, 90], 'purge A');
      const raw = await admin.query(`select count(*)::int n from ${tenancy.PRODUCT_TABLE} where data::text like $1`, ['%' + NID.s4 + '%']);
      eq(raw.rows[0].n, 0, 'purged national_id gone from the table');
      const bLeft = await admin.query(`select count(*)::int n from ${tenancy.PRODUCT_TABLE} where tenant_id = $1 and deleted_at is not null`, [B]);
      eq(bLeft.rows[0].n, 1, 'school B old tombstone untouched by A\'s purge');
      return `purged=${p.body.purged} left=${p.body.tombstones_left} B_left=${bLeft.rows[0].n}`;
    });
    await check('PV-19', 'negative control: the same fixture DOES leak without the row-88 scope (unscoped export) — PV-11/13 are not vacuous', async () => {
      const unscoped = await tenancy.exportProduct(pool, A, { collection: 'attendance', claims: null });
      const j = JSON.stringify(unscoped);
      assert(unscoped.rows.map(r => r.data.student_id).includes(4), 'unscoped export contains the other class');
      assert(j.includes(NID.stray), 'unscoped export contains the stray national_id');
      return 'unscoped attendance rows=' + unscoped.count;
    });
  } finally {
    try { await tenancy.close(); } catch (e) { /* noop */ }
    try { await admin.end(); } catch (e) { /* noop */ }
    try { await root.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch (e) { /* noop */ }
    await root.end();
  }
}

(async () => {
  console.log('\nRow 88: privacy — export role allowlist, no foreign national_id, tombstone retention, cross-school refusal\n');
  await pure();
  await localSqlite();
  await cloud();
  console.log(`\nchecks=${passed + failed} pass=${passed} fail=${failed}`);
  console.log(failed ? 'PRIVACY-88-FAILED' : `PRIVACY-88-OK checks=${passed}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); console.log('PRIVACY-88-FAILED'); process.exit(1); });
