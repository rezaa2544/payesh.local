'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 107 (ADR-105 §3.2, Proposed): end-to-end encryption on the direct
   path — database half, on real PostgreSQL.   EK-01 .. EK-11

   Real: a fresh database, migrations 0001 (row 106) + 0002 (this row)
   applied by the row-86 migrator, a LOGIN role that is only a member of
   payesh_direct_client, verified claims set the PostgREST way, and the
   e2e1 library (tools/e2e1.js) doing all crypto on the "devices".

   The AC:
     • the database holds NO clear text of sensitive fields — canary test on
       a dump: pg_dump (when installed) + COPY of every table, and when the
       data directory is readable (PAYESH_PGDATA, local D-40 run) a byte
       scan of the heap files and the WAL after CHECKPOINT; a positive
       control proves each scanner finds a planted clear-text canary;
     • moving a ciphertext to another row / version is detected (AAD);
     • revoking a user ⇒ the scope key is rotated and the rows re-encrypted;
       the revoked user's cached old key opens nothing new.
   Plus the key-management rules in SQL and 4 mutants.

   Run: PAYESH_PG_ADMIN=postgres://postgres@127.0.0.1:5432/payesh_c64 \
        [PAYESH_PGDATA=/path/to/data] node tests/e2e-keys-107.js
        (E2E107_REQUIRE_PG=1 turns "no PG" into a failure, as in CI;
         E2E107_REQUIRE_PGDUMP=1 does the same for a missing pg_dump)
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const e2e = require('../tools/e2e1.js');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'migrate-86.mjs');
const DIR = 'db/migrations/direct';
const API_ROLE = 'payesh_d107_api';

let passed = 0, failed = 0, negatives = 0, mutantsKilled = 0;
const failures = [];
async function check(id, desc, fn) {
  const t0 = Date.now();
  try {
    const d = await fn();
    passed++;
    console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}  (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++; failures.push(id);
    console.log(`FAIL  ${id}  ${desc}  → ${String((e && (e.code ? e.code + ' ' : '') + e.message) || e).slice(0, 400)}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function refuses(p, codes, what) {
  const want = [].concat(codes);
  try { await (typeof p === 'function' ? p() : p); } catch (e) {
    if (want.includes(e.code)) { negatives++; return e; }
    throw new Error(`${what}: expected ${want.join('|')}, got ${e.code || ''} ${e.message}`);
  }
  throw new Error(`${what}: expected refusal ${want.join('|')}, but it succeeded`);
}
function cli(args, url) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, url ? { PAYESH_MIGRATE_URL: url } : {}) });
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}
function withDb(url, db, user) {
  const u = new URL(url);
  u.pathname = '/' + db;
  if (user) { u.username = user; u.password = ''; }
  return u.toString();
}
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}

async function main() {
  console.log('\nRow 107: direct path — device-side encryption, key grants, rotation (real PostgreSQL)\n');
  const ADMIN = process.env.PAYESH_PG_ADMIN;
  if (!ADMIN) {
    if (process.env.E2E107_REQUIRE_PG === '1') throw new Error('PAYESH_PG_ADMIN is required (E2E107_REQUIRE_PG=1)');
    console.log('SKIP  row 107 needs PostgreSQL (set PAYESH_PG_ADMIN)');
    return { passed: 0, skipped: true };
  }
  const { Pool, Client } = require('pg');
  const DB = `payesh_d107_${process.pid}_${Date.now().toString(36)}`;
  const root = new Client({ connectionString: ADMIN });
  root.on('error', () => {});
  await root.connect();
  await root.query(`CREATE DATABASE ${DB}`);
  await root.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${API_ROLE}') THEN
        CREATE ROLE ${API_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF; END $$`);
  const DB_URL = withDb(ADMIN, DB);
  let admin = null, api = null;
  /* the canary: what a parent/teacher types; it must never reach the server in clear */
  const CANARY = 'CANARY107-' + crypto.randomBytes(8).toString('hex');
  const CANARY_FA = 'کدملی-' + crypto.randomBytes(4).toString('hex');

  try {
    await check('EK-01', 'migrations 0001 + 0002 through the row-86 migrator (lint clean, both expand, re-run applies nothing)', async () => {
      const l = cli(['lint', '--dir', DIR]);
      assert(l.code === 0 && /MIGRATE-86-OK lint migrations=2 errors=0/.test(l.out), 'lint: ' + l.out);
      const u1 = cli(['up', '--dir', DIR], DB_URL); assert(u1.code === 0, 'up: ' + u1.out);
      const u2 = cli(['up', '--dir', DIR], DB_URL); assert(u2.code === 0, 'up again: ' + u2.out);
      admin = new Pool({ connectionString: DB_URL, max: 3 });
      admin.on('error', () => {});
      const led = await admin.query(`SELECT id, phase FROM payesh_schema_migrations WHERE track = 'direct' ORDER BY id`);
      eq(led.rows.map(r => r.id + ':' + r.phase).join(','), '0001_direct_identity:expand,0002_key_grants:expand', 'ledger');
      return 'ledger 0001, 0002 (expand); second up = no-op';
    });
    if (!admin) throw new Error('migration failed; aborting');
    await admin.query(`GRANT payesh_direct_client TO ${API_ROLE}`);
    api = new Pool({ connectionString: withDb(ADMIN, DB, API_ROLE), max: 4 });
    api.on('error', () => {});

    async function as(claims, fn) {
      const c = await api.connect();
      try {
        await c.query('BEGIN');
        if (claims) await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        const r = await fn(c);
        await c.query('COMMIT');
        return r;
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    }
    const q = (u, sql, p = []) => as(tok(u), c => c.query(sql, p)).then(r => r.rows);
    const tok = u => ({ sub: u.sub, device_id: u.device });

    /* ── fixture: school A and B, devices with locally generated key pairs ── */
    const A = crypto.randomUUID(), B = crypto.randomUUID();
    const boot = async (t, code, sub) => {
      const r = await admin.query('SELECT * FROM payesh_direct.bootstrap_school($1, $2, $3, $4)', [t, code, sub, 'first device']);
      return { id: r.rows[0].user_id, device: r.rows[0].device_id, sub, tenant: t, kp: e2e.generateKeyPair() };
    };
    const mA = await boot(A, 'mgr-a', 'sub-mA');
    const mB = await boot(B, 'mgr-b', 'sub-mB');
    const mk = async (mgr, code, sub, role) => {
      const id = (await q(mgr, 'SELECT payesh_direct.create_user($1, $2, $3, NULL) AS id', [code, sub, role]))[0].id;
      const device = (await q(mgr, 'SELECT payesh_direct.enroll_device($1, $2) AS id', [id, code + ' phone']))[0].id;
      return { id, device, sub, tenant: mgr.tenant, kp: e2e.generateKeyPair() };
    };
    const cap = (mgr, u, action, kind, sid, coll) => q(mgr, 'SELECT payesh_direct.grant_capability($1, $2, $3, $4, $5) AS id', [u.id, action, kind, sid, coll]).then(r => Number(r[0].id));
    const tA = await mk(mA, 'teacher-a', 'sub-tA', 'teacher');
    const tA2 = await mk(mA, 'teacher-a2', 'sub-tA2', 'teacher');
    const pA = await mk(mA, 'parent-a', 'sub-pA', 'parent');
    const gA = await mk(mA, 'guard-a', 'sub-gA', 'guard');
    const tB = await mk(mB, 'teacher-b', 'sub-tB', 'teacher');
    const capTA = [await cap(mA, tA, 'read', 'class', 1, 'attendance'), await cap(mA, tA, 'write', 'class', 1, 'attendance')];
    await cap(mA, tA2, 'read', 'class', 1, 'attendance'); await cap(mA, tA2, 'write', 'class', 1, 'attendance');
    await cap(mA, pA, 'read', 'student', 10, null);
    await cap(mB, tB, 'read', 'class', 1, 'attendance');
    const register = u => q(u, 'SELECT payesh_direct.register_device_key($1)', [e2e.b64u(u.kp.pub)]);

    /* the manager device: SMK + scope keys, publish public halves, grant private halves */
    const smkA = e2e.newSmk();
    const publish = (mgr, smk, scope, sg, g) => {
      const k = e2e.deriveScopeKey(smk, mgr.tenant, scope, sg, g);
      return q(mgr, 'SELECT payesh_direct.publish_scope_key($1, $2, $3, $4)', [scope, sg, g, e2e.b64u(k.pub)]).then(() => k);
    };
    const devicePub = async (mgr, deviceId) => e2e.unb64u((await q(mgr, 'SELECT public_key FROM payesh_direct.device WHERE id = $1', [deviceId]))[0].public_key, 32);
    const grantTo = async (mgr, u, k, secret) => {
      const sealed = e2e.sealGrant(await devicePub(mgr, u.device), mgr.tenant, u.device, k.kid, secret || k.priv);
      return Number((await q(mgr, 'SELECT payesh_direct.put_key_grant($1, $2, $3, $4, $5) AS id', [u.device, k.scope, k.smkGen, k.gen, sealed]))[0].id);
    };
    /* a device's keyring = its own grants, read through RLS and opened locally */
    const keyringOf = async u => {
      const ring = new e2e.Keyring(u.tenant);
      for (const g of await q(u, 'SELECT scope, smk_gen, gen, sealed FROM payesh_direct.key_grant WHERE device_id = $1 ORDER BY id', [u.device])) {
        const kid = e2e.kidOf(g.scope, g.smk_gen, g.gen);
        ring.addGrant(kid, e2e.openGrant(g.sealed, u.kp.priv, u.tenant, u.device, kid));
      }
      return ring;
    };
    /* the writer's directory = newest published public key per scope (RLS: own school) */
    const directoryOf = async u => new Map((await q(u, `SELECT DISTINCT ON (scope) scope, smk_gen, gen, public_key
        FROM payesh_direct.scope_key ORDER BY scope, smk_gen DESC, gen DESC`)).map(r =>
      [r.scope, { kid: e2e.kidOf(r.scope, r.smk_gen, r.gen), pub: e2e.unb64u(r.public_key, 32) }]));
    const write = async (u, meta, payload) => {
      const m = Object.assign({ tenant_id: u.tenant, version: 1 }, meta);
      const sealed = e2e.sealRecord(m, payload, await directoryOf(u));
      await q(u, `INSERT INTO payesh_direct.record (tenant_id, collection, record_id, class_id, student_id, version, sealed)
                  VALUES ($1, $2, $3, $4, $5, $6, $7)`, [m.tenant_id, m.collection, m.record_id, m.class_id, m.student_id, m.version, sealed]);
      return sealed;
    };
    const readAll = (u, ring) => q(u, 'SELECT tenant_id, collection, record_id::int AS record_id, version, sealed FROM payesh_direct.record WHERE sealed IS NOT NULL ORDER BY record_id')
      .then(rows => rows.map(r => ({ id: r.record_id, v: r.version, data: ring.openRecord(r) })));

    let k = {};
    await check('EK-02', 'catalog: RLS on scope_key/key_grant, client SELECT-only, definer fns pinned + not PUBLIC, helper not executable by clients, no provider objects', async () => {
      const t = await admin.query(`SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'payesh_direct' AND c.relkind = 'r' ORDER BY 1`);
      eq(t.rows.length, 7, 'tables'); for (const r of t.rows) assert(r.relrowsecurity, 'RLS off on ' + r.relname);
      for (const tb of ['scope_key', 'key_grant']) for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const r = await admin.query(`SELECT has_table_privilege('payesh_direct_client', $1, $2) AS ok`, ['payesh_direct.' + tb, p]);
        assert(!r.rows[0].ok, `client has ${p} on ${tb}`);
      }
      const f = await admin.query(`SELECT p.proname, p.prosecdef, array_to_string(p.proconfig, ',') AS cfg,
            has_function_privilege('payesh_direct_client', p.oid, 'EXECUTE') AS client, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'payesh_direct'
           AND p.proname IN ('scope_covered','register_device_key','publish_scope_key','put_key_grant')`);
      eq(f.rows.length, 4, 'new functions');
      for (const r of f.rows) {
        assert(r.prosecdef && /search_path=pg_catalog, pg_temp/.test(r.cfg), r.proname + ' not definer/pinned');
        assert(!r.pub, r.proname + ' executable by PUBLIC');
        eq(r.client, r.proname !== 'scope_covered', r.proname + ' client exec');
      }
      const ext = await admin.query(`SELECT count(*)::int AS n FROM pg_extension WHERE extname NOT IN ('plpgsql')`);
      eq(ext.rows[0].n, 0, 'extensions');
      return '7 tables RLS; 3 RPCs for clients, scope_covered internal; no extension';
    });

    await check('EK-03', 'device keys: each device registers its own public key once; replacement, bad format, revoked device, no token ⇒ refused', async () => {
      for (const u of [mA, mB, tA, tA2, pA, tB]) await register(u);
      await refuses(register(tA), '42501', 'second registration (key replacement)');
      await refuses(q(gA, 'SELECT payesh_direct.register_device_key($1)', ['not-a-key']), '23514', 'malformed key');
      const d2 = (await q(mA, 'SELECT payesh_direct.enroll_device($1, $2) AS id', [gA.id, 'old']))[0].id;
      await q(mA, 'SELECT payesh_direct.revoke_device($1)', [d2]);
      await refuses(as({ sub: gA.sub, device_id: d2 }, c => c.query('SELECT payesh_direct.register_device_key($1)', [e2e.b64u(e2e.generateKeyPair().pub)])), '42501', 'revoked device');
      await refuses(as(null, c => c.query('SELECT payesh_direct.register_device_key($1)', [e2e.b64u(e2e.generateKeyPair().pub)])), '42501', 'no token');
      const pk = (await q(tA, 'SELECT public_key FROM payesh_direct.device WHERE id = $1', [tA.device]))[0].public_key;
      eq(pk, e2e.b64u(tA.kp.pub), 'stored key unchanged');
      return '6 devices registered; 4 refusals';
    });

    await check('EK-04', 'scope keys: only a manager publishes; every publication strictly newer (no downgrade, no older SMK generation); other school sees none', async () => {
      k.smk = await publish(mA, smkA, 'smk', 1, 0);
      k.school = await publish(mA, smkA, 'school:attendance', 1, 0);
      k.class1 = await publish(mA, smkA, 'class:1:attendance', 1, 0);
      k.stu10 = await publish(mA, smkA, 'student:10:attendance', 1, 0);
      await publish(mB, e2e.newSmk(), 'smk', 1, 0);
      await refuses(q(tA, 'SELECT payesh_direct.publish_scope_key($1, 1, 5, $2)', ['class:1:attendance', e2e.b64u(e2e.generateKeyPair().pub)]), '42501', 'teacher publishes');
      await refuses(publish(mA, smkA, 'class:1:attendance', 1, 0), '22023', 'same generation again');
      await publish(mA, smkA, 'class:2:attendance', 1, 3);
      await refuses(publish(mA, smkA, 'class:2:attendance', 1, 2), '22023', 'downgrade 1+3 → 1+2');
      await refuses(q(mA, 'SELECT payesh_direct.publish_scope_key($1, 1, 0, $2)', ['class:1:Attendance', e2e.b64u(e2e.generateKeyPair().pub)]), '23514', 'bad scope name');
      const seenB = await q(mB, 'SELECT count(*)::int AS n FROM payesh_direct.scope_key WHERE tenant_id = $1', [A]);
      eq(seenB[0].n, 0, 'school B sees A keys'); negatives++;
      eq((await q(gA, 'SELECT count(*)::int AS n FROM payesh_direct.scope_key'))[0].n, 5, 'any active user of A sees A public keys');
      return 'A: 5 public keys; 4 refusals; B sees 0 of A';
    });

    await check('EK-05', 'key grants: manager only, same school, active device with a key, published generation, scope covered by a capability; reads limited to own device', async () => {
      await grantTo(mA, mA, k.smk, smkA);
      await grantTo(mA, tA, k.class1); await grantTo(mA, tA2, k.class1); await grantTo(mA, pA, k.stu10);
      await refuses(grantTo(mA, pA, k.class1), '42501', 'class key to a parent (not covered)');
      await refuses(grantTo(mA, tA, k.smk, smkA), '42501', 'SMK to a teacher');
      await refuses(grantTo(mA, tA, k.school), '42501', 'school-wide key to a class teacher');
      await refuses(q(tA, 'SELECT payesh_direct.put_key_grant($1, $2, 1, 0, $3)', [tA2.device, 'class:1:attendance', e2e.sealGrant(tA2.kp.pub, A, tA2.device, k.class1.kid, k.class1.priv)]), '42501', 'teacher grants');
      await refuses(q(mA, 'SELECT payesh_direct.put_key_grant($1, $2, 1, 0, $3)', [tB.device, 'class:1:attendance', e2e.sealGrant(tB.kp.pub, A, tB.device, k.class1.kid, k.class1.priv)]), 'P0002', 'device of school B');
      await refuses(q(mA, 'SELECT payesh_direct.put_key_grant($1, $2, 1, 9, $3)', [tA.device, 'class:1:attendance', e2e.sealGrant(tA.kp.pub, A, tA.device, 'class:1:attendance@1+9', k.class1.priv)]), 'P0002', 'unpublished generation');
      await refuses(q(mA, 'SELECT payesh_direct.put_key_grant($1, $2, 1, 0, $3)', [gA.device, 'class:1:attendance', e2e.sealGrant(e2e.generateKeyPair().pub, A, gA.device, k.class1.kid, k.class1.priv)]), '42501', 'device without public key');
      await refuses(q(mA, 'SELECT payesh_direct.put_key_grant($1, $2, 1, 0, $3)', [tA.device, 'class:1:attendance', 'plain-secret']), '23514', 'grant not an e2e1 envelope');
      eq((await q(tA, 'SELECT count(*)::int AS n FROM payesh_direct.key_grant'))[0].n, 1, 'teacher sees own grant only');
      eq((await q(tB, 'SELECT count(*)::int AS n FROM payesh_direct.key_grant'))[0].n, 0, 'school B teacher'); negatives++;
      eq((await q(gA, 'SELECT count(*)::int AS n FROM payesh_direct.key_grant'))[0].n, 0, 'guard'); negatives++;
      eq((await q(mA, 'SELECT count(*)::int AS n FROM payesh_direct.key_grant'))[0].n, 4, 'manager sees school grants');
      return '4 grants; 8 refusals; teacher 1, guard 0, other school 0';
    });

    let rows1;
    await check('EK-06', 'end to end: a teacher writes ciphertext; the other class teacher, the parent and the manager decrypt; clear text, missing or malformed ciphertext refused by the database', async () => {
      await write(tA, { collection: 'attendance', record_id: 1, class_id: 1, student_id: 10 }, { status: 'absent', note: CANARY, national_id: CANARY_FA });
      await write(tA, { collection: 'attendance', record_id: 2, class_id: 1, student_id: 12 }, { status: 'present', note: CANARY + '-2' });
      await write(tA2, { collection: 'attendance', record_id: 3, class_id: 1, student_id: 10 }, { status: 'late', note: CANARY + '-3' });
      const ringT2 = await keyringOf(tA2); const ringP = await keyringOf(pA); const ringM = await keyringOf(mA);
      rows1 = await readAll(tA2, ringT2);
      eq(rows1.map(r => r.data.status).join(','), 'absent,present,late', 'teacher 2 decrypts');
      eq(rows1[0].data.note, CANARY, 'canary round trip');
      eq((await readAll(pA, ringP)).map(r => r.id).join(','), '1,3', 'parent sees and decrypts child 10 only');
      eq((await readAll(mA, ringM)).length, 3, 'manager decrypts all via SMK');
      await refuses(q(tA, `INSERT INTO payesh_direct.record (tenant_id, collection, record_id, class_id, student_id, payload) VALUES ($1, 'attendance', 50, 1, 10, $2)`, [A, { note: 'PLAINTEXT-NEG' }]), '23514', 'clear-text payload');
      await refuses(q(tA, `INSERT INTO payesh_direct.record (tenant_id, collection, record_id, class_id, student_id) VALUES ($1, 'attendance', 51, 1, 10)`, [A]), '23514', 'live row without ciphertext');
      await refuses(q(tA, `INSERT INTO payesh_direct.record (tenant_id, collection, record_id, class_id, student_id, sealed) VALUES ($1, 'attendance', 52, 1, 10, 'hello')`, [A]), '23514', 'not an e2e1 envelope');
      await refuses(q(tA, `UPDATE payesh_direct.record SET payload = '{"x":1}' WHERE record_id = 1`), '23514', 'clear text by update');
      return 'teacher2 3/3, parent 2/2, manager 3/3; 4 clear-text refusals';
    });

    await check('EK-07', 'CANARY on dump: pg_dump + COPY of every table (and heap/WAL bytes when PAYESH_PGDATA is readable) contain no clear text; each scanner finds a planted control canary', async () => {
      const CONTROL = 'CONTROL107-' + crypto.randomBytes(6).toString('hex');
      await admin.query('CREATE TABLE public.canary_control (t text)');
      await admin.query('INSERT INTO public.canary_control VALUES ($1)', [CONTROL]);
      await admin.query('CHECKPOINT');
      const needles = [CANARY, CANARY_FA, 'absent', 'present'];
      const hits = (buf, n) => buf.indexOf(Buffer.from(n, 'utf8')) >= 0;
      const out = [];
      // (1) pg_dump, if installed (CI runner / local apt install)
      const which = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
      if (which.status === 0) {
        const d = spawnSync('pg_dump', ['--no-owner', '--data-only', '-d', DB_URL], { maxBuffer: 256 * 1024 * 1024 });
        assert(d.status === 0, 'pg_dump failed: ' + String(d.stderr).slice(0, 300));
        assert(hits(d.stdout, CONTROL), 'pg_dump scanner misses the control canary');
        for (const n of needles) assert(!hits(d.stdout, n), `pg_dump contains clear text "${n.slice(0, 12)}…"`);
        out.push(`pg_dump ${(d.stdout.length / 1024).toFixed(0)} KiB clean (${String(which.stdout).trim()})`);
      } else {
        if (process.env.E2E107_REQUIRE_PGDUMP === '1') throw new Error('pg_dump is required (E2E107_REQUIRE_PGDUMP=1) but not installed');
        out.push('pg_dump not installed — skipped');
      }
      // (2) COPY every table of the schema as the superuser (what any DB operator / backup sees)
      const tabs = await admin.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('payesh_direct') AND c.relkind = 'r'`);
      let bytes = 0; const cc = await admin.connect();
      try {
        const dump = [];
        for (const t of tabs.rows) {
          const r = await cc.query(`SELECT coalesce(string_agg(x::text, E'\\n'), '') AS s FROM payesh_direct.${t.relname} x`);
          dump.push(r.rows[0].s);
        }
        const all = Buffer.from(dump.join('\n'), 'utf8'); bytes = all.length;
        for (const n of needles) assert(!hits(all, n), `table dump contains clear text "${n.slice(0, 12)}…"`);
        const ctl = await cc.query(`SELECT string_agg(x::text, '') AS s FROM public.canary_control x`);
        assert(hits(Buffer.from(ctl.rows[0].s), CONTROL), 'table scanner misses control');
      } finally { cc.release(); }
      out.push(`${tabs.rows.length} tables ${(bytes / 1024).toFixed(0)} KiB clean`);
      // (3) raw bytes of the database's heap files and the WAL (only when the data dir is local)
      const PGDATA = process.env.PAYESH_PGDATA;
      if (PGDATA && fs.existsSync(path.join(PGDATA, 'base'))) {
        const oid = (await admin.query('SELECT oid FROM pg_database WHERE datname = current_database()')).rows[0].oid;
        const files = walk(path.join(PGDATA, 'base', String(oid))).concat(walk(path.join(PGDATA, 'pg_wal')).filter(f => /^[0-9A-F]{24}$/.test(path.basename(f))));
        let found = false, total = 0;
        for (const f of files) {
          const b = fs.readFileSync(f); total += b.length;
          if (hits(b, CONTROL)) found = true;
          for (const n of [CANARY, CANARY_FA]) assert(!hits(b, n), `raw file ${path.relative(PGDATA, f)} contains the canary`);
        }
        assert(found, 'raw scanner misses the control canary');
        out.push(`raw heap+WAL ${files.length} files ${(total / 1048576).toFixed(0)} MiB clean`);
      } else out.push('raw heap/WAL scan skipped (PAYESH_PGDATA not set — CI service container)');
      await admin.query('DROP TABLE public.canary_control');
      negatives += needles.length;
      return out.join('; ');
    });

    await check('EK-08', 'NEGATIVE swap by a database operator: ciphertext moved to another row, or the version bumped without re-encryption ⇒ the reader detects it (AAD)', async () => {
      const ringT2 = await keyringOf(tA2);
      await admin.query(`UPDATE payesh_direct.record SET sealed = (SELECT sealed FROM payesh_direct.record WHERE tenant_id = $1 AND record_id = 1) WHERE tenant_id = $1 AND record_id = 2`, [A]);
      await admin.query(`UPDATE payesh_direct.record SET version = version + 1 WHERE tenant_id = $1 AND record_id = 3`, [A]);
      const rows = await q(tA2, 'SELECT tenant_id, collection, record_id::int AS record_id, version, sealed FROM payesh_direct.record ORDER BY record_id');
      eq(ringT2.openRecord(rows[0]).note, CANARY, 'untouched row 1 still opens');
      for (const i of [1, 2]) assert(await refuses(() => ringT2.openRecord(rows[i]), 'e2e_open_failed', 'tampered row ' + rows[i].record_id), 'x');
      // restore the honest rows (teacher 2 rewrites them, as the client would after a conflict)
      const dir = await directoryOf(tA2);
      for (const [id, stu, payload] of [[2, 12, { status: 'present', note: CANARY + '-2' }], [3, 10, { status: 'late', note: CANARY + '-3' }]]) {
        const v = rows.find(r => r.record_id === id).version + 1;
        const s = e2e.sealRecord({ tenant_id: A, collection: 'attendance', record_id: id, version: v, class_id: 1, student_id: stu }, payload, dir);
        await q(tA2, 'UPDATE payesh_direct.record SET sealed = $1, version = $2 WHERE tenant_id = $3 AND collection = $4 AND record_id = $5', [s, v, A, 'attendance', id]);
      }
      eq((await readAll(tA2, ringT2)).map(r => r.data.status).join(','), 'absent,present,late', 'restored');
      return 'moved row + version bump refused; rows rewritten honestly';
    });

    await check('EK-09', 'revocation ⇒ rotation: user revoked, class key gen 1+1 published, re-granted to remaining holders, rows re-encrypted; the revoked user\'s cached key opens nothing new', async () => {
      const ringTA = await keyringOf(tA);           // what the soon-revoked teacher has cached
      eq((await readAll(tA, ringTA)).length, 3, 'teacher A before revocation');
      await q(mA, 'SELECT payesh_direct.revoke_user($1)', [tA.id]);
      eq((await q(tA, 'SELECT count(*)::int AS n FROM payesh_direct.record'))[0].n, 0, 'revoked: RLS 0 rows'); negatives++;
      eq((await q(tA, 'SELECT count(*)::int AS n FROM payesh_direct.key_grant'))[0].n, 0, 'revoked: 0 grants'); negatives++;
      // the manager device rotates class:1:attendance and re-encrypts every row it reaches
      k.class1b = await publish(mA, smkA, 'class:1:attendance', 1, 1);
      await refuses(grantTo(mA, tA, k.class1b), ['42501', 'P0002'], 'grant to the revoked user');
      await grantTo(mA, tA2, k.class1b);
      const ringM = await keyringOf(mA); const dir = await directoryOf(mA);
      eq(dir.get('class:1:attendance').kid, 'class:1:attendance@1+1', 'directory serves the new generation');
      const raw = await q(mA, `SELECT tenant_id, collection, record_id::int AS record_id, class_id::int AS class_id, student_id::int AS student_id, version, sealed
                               FROM payesh_direct.record WHERE tenant_id = $1 AND class_id = 1 ORDER BY record_id`, [A]);
      for (const r of raw) {
        const data = ringM.openRecord(r);
        const meta = Object.assign({}, r, { version: r.version + 1 });
        const s = e2e.sealRecord(meta, data, dir);
        const u = await q(mA, 'UPDATE payesh_direct.record SET sealed = $1, version = $2 WHERE tenant_id = $3 AND collection = $4 AND record_id = $5 AND version = $6 RETURNING 1',
          [s, meta.version, r.tenant_id, r.collection, r.record_id, r.version]);
        eq(u.length, 1, 're-encrypt ' + r.record_id);
      }
      // a full copy of the database after rotation (an operator / backup) + the revoked teacher's cached keys
      const leaked = (await admin.query(`SELECT tenant_id, collection, record_id::int AS record_id, version, sealed FROM payesh_direct.record WHERE tenant_id = $1 ORDER BY record_id`, [A])).rows;
      for (const r of leaked) {
        assert(e2e.recipientsOf(r.sealed).includes('class:1:attendance@1+1'), 'row not on the new generation');
        await refuses(() => ringTA.openRecord(r), 'e2e_no_key', 'revoked teacher, cached gen 1+0, row ' + r.record_id);
      }
      const ringT2 = await keyringOf(tA2);
      eq((await readAll(tA2, ringT2)).map(r => r.data.status).join(','), 'absent,present,late', 'teacher 2 on gen 1+1');
      eq((await readAll(pA, await keyringOf(pA))).length, 2, 'parent unaffected (student key unchanged)');
      return `${raw.length} rows re-encrypted to class:1:attendance@1+1; revoked teacher 0/${leaked.length}`;
    });

    await check('EK-10', 'mutation controls: 4 broken variants of migration 0002, each caught by the checks above', async () => {
      async function underMutant(ddl, claims, probe) {
        const c = await admin.connect();
        try {
          await c.query('BEGIN'); await c.query(ddl);
          await c.query('SET LOCAL ROLE payesh_direct_client');
          await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
          return await probe(c);
        } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
      }
      const out = [];
      // M1: coverage check always true ⇒ the class key can be granted to a parent
      const m1 = await underMutant(`CREATE OR REPLACE FUNCTION payesh_direct.scope_covered(p_user uuid, p_tenant uuid, p_scope text) RETURNS boolean
          LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT true $$`, tok(mA),
        async c => (await c.query('SELECT payesh_direct.put_key_grant($1, $2, 1, 1, $3) AS id', [pA.device, 'class:1:attendance',
          e2e.sealGrant(pA.kp.pub, A, pA.device, k.class1b.kid, k.class1b.priv)])).rowCount);
      eq(m1, 1, 'M1 not caught'); out.push('M1 parent got the class key');
      // M2: grant policy opened ⇒ a guard reads everyone's sealed grants
      const m2 = await underMutant(`DROP POLICY key_grant_read ON payesh_direct.key_grant;
          CREATE POLICY key_grant_read ON payesh_direct.key_grant FOR SELECT TO payesh_direct_client USING (true)`, tok(gA),
        async c => Number((await c.query('SELECT count(*)::int AS n FROM payesh_direct.key_grant')).rows[0].n));
      assert(m2 > 0, 'M2 not caught'); out.push(`M2 guard sees ${m2} grants`);
      // M3: no-clear-text constraint dropped ⇒ a plaintext payload lands in the table
      const m3 = await underMutant(`ALTER TABLE payesh_direct.record DROP CONSTRAINT record_payload_empty;
          ALTER TABLE payesh_direct.record DROP CONSTRAINT record_live_is_sealed`, tok(tA2),
        async c => (await c.query(`INSERT INTO payesh_direct.record (tenant_id, collection, record_id, class_id, student_id, payload) VALUES ($1, 'attendance', 60, 1, 10, '{"note":"x"}')`, [A])).rowCount);
      eq(m3, 1, 'M3 not caught'); out.push('M3 clear text stored');
      // M4: no monotonic check ⇒ the old class key generation is re-published (rollback attack)
      const m4 = await underMutant(`CREATE OR REPLACE FUNCTION payesh_direct.publish_scope_key(p_scope text, p_smk_gen integer, p_gen integer, p_public_key text) RETURNS void
          LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
          DECLARE t uuid; BEGIN t := payesh_direct.require_manager();
            INSERT INTO payesh_direct.scope_key (tenant_id, scope, smk_gen, gen, public_key, published_by)
            VALUES (t, p_scope, p_smk_gen, p_gen, p_public_key, payesh_direct.current_user_id()); END $$`, tok(mA),
        async c => (await c.query('SELECT payesh_direct.publish_scope_key($1, 1, 0, $2)', ['class:2:attendance', e2e.b64u(e2e.generateKeyPair().pub)])).rowCount);
      eq(m4, 1, 'M4 not caught'); out.push('M4 downgrade published');
      mutantsKilled = 4;
      eq((await q(gA, 'SELECT count(*)::int AS n FROM payesh_direct.key_grant'))[0].n, 0, 'restored after mutants');
      return out.join('; ') + ' — all 4 caught, schema restored';
    });

    await check('EK-11', 'rollback of 0002 through the migrator leaves row 106 intact; re-apply is clean', async () => {
      await api.end(); api = null; await admin.end(); admin = null;
      const r = cli(['rollback', '--to', '0001_direct_identity', '--dir', DIR], DB_URL);
      assert(r.code === 0, 'rollback: ' + r.out);
      const c = new Client({ connectionString: DB_URL }); c.on('error', () => {}); await c.connect();
      try {
        const n = async sql => (await c.query(sql)).rows[0].n;
        eq(await n(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'payesh_direct' AND c.relname IN ('scope_key','key_grant')`), 0, 'key tables after rollback');
        eq(await n(`SELECT count(*)::int AS n FROM payesh_direct.app_user`), 7, 'row-106 data intact');
        const u = cli(['up', '--dir', DIR], DB_URL); assert(u.code === 0, 're-up: ' + u.out);
        eq(await n(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'payesh_direct' AND c.relname IN ('scope_key','key_grant')`), 2, 'key tables after re-up');
      } finally { await c.end(); }
      return 'down ⇒ key tables gone, 7 users kept; up ⇒ back';
    });
  } finally {
    if (api) await api.end().catch(() => {});
    if (admin) await admin.end().catch(() => {});
    await root.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB]).catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
    await root.end().catch(() => {});
  }

  console.log(`\n# passed=${passed} failed=${failed} negative_controls=${negatives} mutants_killed=${mutantsKilled}`);
  if (failed) {
    console.log('E2E-KEYS-107-FAIL ' + failures.join(','));
    throw new Error('row 107 failures: ' + failures.join(','));
  }
  console.log('E2E-KEYS-107-OK');
  return { passed, negative_controls: negatives, mutants_killed: mutantsKilled };
}

module.exports = { main };
if (require.main === module) main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
