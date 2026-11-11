'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 108 (ADR-105 §3.3, Proposed): the Gateway's sync logic in SQL —
   sync_push / sync_pull RPCs, change-feed, idempotency, plan quota by
   trigger, conflict handling — on real PostgreSQL.     SY-01 .. SY-13

   Real: a fresh database, migrations 0001..0004 (rows 106, 107, 108) by the
   row-86 migrator, a LOGIN role that is only a member of
   payesh_direct_client, verified claims set the PostgREST way, every row
   end-to-end encrypted by the e2e1 library (row 107), and the device side
   of the protocol in tools/direct-sync.js.

   The AC:
     • behaviour equal to the existing server on the row-64 vectors
       (idempotency-v1, pagination-v1, scope-v1, conflict-v1 — the latter
       also side by side with server/sync.js on SQLite) and on the row-83
       convergence test (same harness and the same independent spec oracle:
       P1 every replica equals the server, P2 every op outcome and the final
       value + version of every row equal the spec);
     • sync functions are SECURITY INVOKER and run under RLS;
     • a repeated push has no second effect (uid, request key, concurrent twins);
     • going over the plan cap is refused (records, bytes, ops per push,
       ops per window, op size), atomically.
   Plus feed order under concurrent writers, RLS through the RPCs, 4 mutants
   and a rollback to 0002.

   Run: PAYESH_PG_ADMIN=postgres://postgres@127.0.0.1:5432/payesh_c64 node tests/direct-sync-108.js
        (DS108_REQUIRE_PG=1 turns "no PG" into a failure, as in CI;
         DS108_SEEDS=a,b,c or DS108_RUNS=n for the convergence part)
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const e2e = require('../tools/e2e1.js');
const { DirectSync } = require('../tools/direct-sync.js');
const convergence = require('../server/convergence.js');
const scopeMod = require('../server/scope.js');
const policy = require('../server/policy.js');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'migrate-86.mjs');
const DIR = 'db/migrations/direct';
const OWN = '0004_direct_sync_feed_index';
const API_ROLE = 'payesh_d108_api';
const VEC = path.join(ROOT, 'docs/cloud/contracts/vectors');
const vec = n => JSON.parse(fs.readFileSync(path.join(VEC, n), 'utf8'));

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
    console.log(`FAIL  ${id}  ${desc}  → ${String((e && (e.code ? e.code + ' ' : '') + e.message) || e).slice(0, 500)}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function refuses(p, codes, what, msg) {
  const want = [].concat(codes);
  try { await (typeof p === 'function' ? p() : p); } catch (e) {
    if (want.includes(e.code) && (!msg || msg.test(e.message))) { negatives++; return e; }
    throw new Error(`${what}: expected ${want.join('|')}${msg ? ' ' + msg : ''}, got ${e.code || ''} ${e.message}`);
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
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickOf = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── row-83 spec oracle (copied from tests/convergence-fuzz-83.js: written
      from docs/cloud/41-conflict-policy.md, independent of convergence.js).
      One deliberate change, three `seen.add` on conflict: the contract vector
      idempotency-v1 ("conflict retry is a duplicate (verdict is final)") — the
      behaviour of the cloud Gateway the direct path replaces — makes a conflict
      verdict final. server/sync.js (the LAN server) re-evaluates such a retry;
      SY-03 pins that single known difference. ── */
const SPEC = {
  attendance: { auto: ['note', 'arrival_time', 'leave_time', 'excuse_note'] },
  grades: { auto: ['note', 'teacher_note'] },
};
const FIELDS = {
  attendance: {
    manual: { status: ['present', 'absent', 'late'] },
    auto: { note: ['', 'n1', 'n2', 'n3'], arrival_time: ['07:30', '07:45', '08:00'], excuse_note: ['', 'e1', 'e2'] },
  },
  grades: {
    manual: { score: [10, 15, 18, 20] },
    auto: { note: ['', 'g1', 'g2', 'g3'], teacher_note: ['', 't1', 't2'] },
  },
};
const COLS = Object.keys(FIELDS);
const DOMAIN = { attendance: ['status', 'note', 'arrival_time', 'excuse_note', 'student_id', 'class_id', 'date'], grades: ['score', 'note', 'teacher_note', 'student_id', 'subject_id', 'term'] };
const META = new Set(['id', '_version', '_updated_at', 'updated_at', 'created_at', 'device_id', 'school_id', 'tenant_id']);
const specClass = (col, f) => (SPEC[col] && SPEC[col].auto.includes(f) ? 'auto' : 'manual');
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
function makeOracle() {
  const rows = new Map(); const seen = new Set(); const idem = new Map(); const conflicts = [];
  const key = (c, id) => c + '#' + id;
  function op(o) {
    if (seen.has(o.uid)) return 'duplicate';
    const k = key(o.collection, o.id);
    const r = rows.get(k);
    const live = r && !r.deleted;
    if (o.type === 'del') {
      if (!live) return 'rejected';
      if (o.base_version != null && o.base_version !== r.version) { conflicts.push({ collection: o.collection, record_id: o.id, local: {} }); seen.add(o.uid); return 'conflict'; }
      r.deleted = true; r.version++; seen.add(o.uid); return 'deleted';
    }
    if (!live) {
      if (o.base_version > 0) { conflicts.push({ collection: o.collection, record_id: o.id, local: o.data }); seen.add(o.uid); return 'conflict'; }
      if (r) return 'rejected';
      rows.set(k, { doc: Object.assign({}, o.data, { id: o.id }), version: 1, deleted: false });
      seen.add(o.uid); return 'applied';
    }
    if (o.base_version === r.version) { Object.assign(r.doc, o.data); r.version++; seen.add(o.uid); return 'applied'; }
    const changed = Object.keys(o.data).filter(f => !META.has(f) && !same(r.doc[f], o.data[f]));
    if (!changed.length) { seen.add(o.uid); return 'noop'; }
    if (changed.some(f => specClass(o.collection, f) === 'manual')) { conflicts.push({ collection: o.collection, record_id: o.id, local: o.data }); seen.add(o.uid); return 'conflict'; }
    for (const f of changed) r.doc[f] = o.data[f];
    r.version++; seen.add(o.uid); return 'merged';
  }
  function batch(idemKey, ops) {
    if (idem.has(idemKey)) return { replayed: true, outcomes: idem.get(idemKey) };
    const outcomes = ops.map(op); idem.set(idemKey, outcomes); return { replayed: false, outcomes };
  }
  function resolve(i, decision) {
    const c = conflicts[i]; if (c.resolved) return; c.resolved = decision;
    if (decision !== 'local') return;
    const r = rows.get(key(c.collection, c.record_id));
    const patch = Object.assign({}, c.local); delete patch._version;
    Object.assign(r.doc, patch); r.version++;
  }
  return { rows, conflicts, batch, resolve, key };
}
function outcomeOf(resp, uid) {
  if (resp.conflicts.some(c => c.uid === uid)) return 'conflict';
  if (resp.rejected.some(c => c.uid === uid)) return 'rejected';
  const a = resp.applied.find(c => c.uid === uid);
  if (!a) return 'missing';
  if (a.duplicate) return 'duplicate';
  if (a.deleted) return 'deleted';
  return 'ok';
}
const OK_SET = new Set(['applied', 'merged', 'noop']);

async function main() {
  console.log('\nRow 108: direct path — sync_push / sync_pull in SQL, change-feed, idempotency, plan quota, conflicts (real PostgreSQL)\n');
  const ADMIN = process.env.PAYESH_PG_ADMIN;
  if (!ADMIN) {
    if (process.env.DS108_REQUIRE_PG === '1') throw new Error('PAYESH_PG_ADMIN is required (DS108_REQUIRE_PG=1)');
    console.log('SKIP  row 108 needs PostgreSQL (set PAYESH_PG_ADMIN)');
    return { passed: 0, skipped: true };
  }
  const { Pool, Client } = require('pg');
  const DB = `payesh_d108_${process.pid}_${Date.now().toString(36)}`;
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
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-ds108-'));

  try {
    await check('SY-01', 'migrations 0001..0004 through the row-86 migrator (lint clean, all expand, feed index CONCURRENTLY outside a transaction, re-run applies nothing)', async () => {
      const l = cli(['lint', '--dir', DIR]);
      assert(l.code === 0 && /MIGRATE-86-OK lint migrations=\d+ errors=0/.test(l.out), 'lint: ' + l.out);
      const u1 = cli(['up', '--dir', DIR, '--to', OWN], DB_URL); assert(u1.code === 0, 'up: ' + u1.out);
      const u2 = cli(['up', '--dir', DIR, '--to', OWN], DB_URL); assert(u2.code === 0, 'up again: ' + u2.out);
      admin = new Pool({ connectionString: DB_URL, max: 4 });
      admin.on('error', () => {});
      const led = await admin.query(`SELECT id, phase FROM payesh_schema_migrations WHERE track = 'direct' ORDER BY id`);
      eq(led.rows.map(r => r.id).join(','), '0001_direct_identity,0002_key_grants,0003_direct_sync,0004_direct_sync_feed_index', 'ledger');
      assert(led.rows.every(r => r.phase === 'expand'), 'all expand');
      const ix = await admin.query(`SELECT indisvalid FROM pg_index WHERE indexrelid = 'payesh_direct.record_feed_idx'::regclass`);
      assert(ix.rows.length && ix.rows[0].indisvalid, 'feed index valid');
      return 'ledger 0001..0004 (expand); feed index valid; second up = no-op';
    });
    if (!admin) throw new Error('migration failed; aborting');
    await admin.query(`GRANT payesh_direct_client TO ${API_ROLE}`);
    api = new Pool({ connectionString: withDb(ADMIN, DB, API_ROLE), max: 6 });
    api.on('error', () => {});

    /* one RPC = one transaction with verified claims (PostgREST semantics) */
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
    const tok = u => ({ sub: u.sub, device_id: u.device });
    const q = (u, sql, p = []) => as(tok(u), c => c.query(sql, p)).then(r => r.rows);
    const RPC = {
      sync_push: 'SELECT payesh_direct.sync_push($1::jsonb, $2) AS r',
      sync_pull: 'SELECT payesh_direct.sync_pull($1::bigint, $2, $3::text[]) AS r',
      sync_resolve_conflict: 'SELECT payesh_direct.sync_resolve_conflict($1, $2) AS r',
    };
    const caller = u => (fn, args) => q(u, RPC[fn], args).then(r => r[0].r);

    /* ── a school: manager + SMK + published scope keys; devices get grants ── */
    const ALL_COLS = ['attendance', 'grades', 'homework', 'announcements', 'leaves', 'users', 'counselor_notes', 'app_settings', 'zz_unknown', 'conflicts', 'internships'];
    let schoolNo = 0;
    async function school() {
      const t = crypto.randomUUID(); const n = ++schoolNo;
      const r = await admin.query('SELECT * FROM payesh_direct.bootstrap_school($1, $2, $3, $4)', [t, 'mgr-' + n, 'sub-m-' + n + '-' + t.slice(0, 8), 'mgr device']);
      const mgr = { id: r.rows[0].user_id, device: r.rows[0].device_id, sub: 'sub-m-' + n + '-' + t.slice(0, 8), tenant: t, kp: e2e.generateKeyPair() };
      await q(mgr, 'SELECT payesh_direct.register_device_key($1)', [e2e.b64u(mgr.kp.pub)]);
      const smk = e2e.newSmk();
      const keys = {};
      for (const sc of ['smk', ...ALL_COLS.map(c => 'school:' + c)]) {
        const k = e2e.deriveScopeKey(smk, t, sc, 1, 0);
        await q(mgr, 'SELECT payesh_direct.publish_scope_key($1, 1, 0, $2)', [sc, e2e.b64u(k.pub)]);
        keys[sc] = k;
      }
      const directory = new Map(Object.entries(keys).map(([sc, k]) => [sc, { kid: k.kid, pub: k.pub }]));
      const S = { tenant: t, mgr, smk, keys, directory, n };
      S.grantSmk = async dev => {
        const sealed = e2e.sealGrant(dev.kp.pub, t, dev.device, keys.smk.kid, smk);
        await q(mgr, 'SELECT payesh_direct.put_key_grant($1, $2, 1, 0, $3)', [dev.device, 'smk', sealed]);
        const ring = new e2e.Keyring(t);
        const g = (await q(dev, `SELECT sealed FROM payesh_direct.key_grant WHERE device_id = $1 AND scope = 'smk'`, [dev.device]))[0];
        ring.addGrant(keys.smk.kid, e2e.openGrant(g.sealed, dev.kp.priv, t, dev.device, keys.smk.kid));
        return ring;
      };
      S.publish = async sc => {     /* a manager publishes a scope key (row 107) */
        if (keys[sc]) return keys[sc];
        const k = e2e.deriveScopeKey(smk, t, sc, 1, 0);
        await q(mgr, 'SELECT payesh_direct.publish_scope_key($1, 1, 0, $2)', [sc, e2e.b64u(k.pub)]);
        keys[sc] = k; directory.set(sc, { kid: k.kid, pub: k.pub });
        return k;
      };
      S.grantScopes = async (dev, scopes) => {
        const ring = new e2e.Keyring(t);
        for (const sc of scopes) {
          const k = await S.publish(sc);
          const priv = sc === 'smk' ? smk : k.priv;
          await q(mgr, 'SELECT payesh_direct.put_key_grant($1, $2, 1, 0, $3)', [dev.device, sc, e2e.sealGrant(dev.kp.pub, t, dev.device, k.kid, priv)]);
          const g = (await q(dev, `SELECT sealed FROM payesh_direct.key_grant WHERE device_id = $1 AND scope = $2`, [dev.device, sc]))[0];
          ring.addGrant(k.kid, e2e.openGrant(g.sealed, dev.kp.priv, t, dev.device, k.kid));
        }
        return ring;
      };
      S.device = async (user, label) => {     /* another device of an existing user */
        const id = (await q(mgr, 'SELECT payesh_direct.enroll_device($1, $2) AS id', [user.id, label]))[0].id;
        const dev = { id: user.id, device: id, sub: user.sub, tenant: t, kp: e2e.generateKeyPair() };
        await q(dev, 'SELECT payesh_direct.register_device_key($1)', [e2e.b64u(dev.kp.pub)]);
        return dev;
      };
      S.user = async (code, role) => {
        const sub = 'sub-' + code + '-' + t.slice(0, 8);
        const id = (await q(mgr, 'SELECT payesh_direct.create_user($1, $2, $3, NULL) AS id', [code, sub, role]))[0].id;
        return S.device({ id, sub }, code + ' phone');
      };
      S.cap = (u, action, kind, sid, coll) => q(mgr, 'SELECT payesh_direct.grant_capability($1, $2, $3, $4, $5) AS id', [u.id, action, kind, sid, coll]);
      S.sync = async (dev, scopes) => {
        const ring = scopes ? await S.grantScopes(dev, scopes) : await S.grantSmk(dev);
        return new DirectSync({ tenant: t, call: caller(dev), keyring: ring, directory: directory });
      };
      S.seal = (collection, id, version, doc) => e2e.sealRecord({ tenant_id: t, collection, record_id: id, version, class_id: doc.class_id == null ? null : Number(doc.class_id), student_id: doc.student_id == null ? null : Number(doc.student_id) }, doc, directory);
      S.rawPut = (u, ops) => caller(u)('sync_push', [JSON.stringify(ops.map(o => Object.assign({ type: 'put', base_version: 0 }, o, {
        sealed: o.sealed || S.seal(o.collection, o.id, (o.base_version || 0) + 1, o.doc || {}),
        class_id: o.doc && o.doc.class_id != null ? Number(o.doc.class_id) : null,
        student_id: o.doc && o.doc.student_id != null ? Number(o.doc.student_id) : null,
        doc: undefined,
      }))), null]);
      return S;
    }

    await check('SY-02', 'catalog: sync_push / sync_pull / sync_resolve_conflict are SECURITY INVOKER (RLS applies), pinned search_path, not PUBLIC; new tables RLS; client cannot write plan/usage or run plan_for; record trigger present', async () => {
      const f = await admin.query(`SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'payesh_direct' AND p.proname IN ('sync_push', 'sync_pull', 'sync_resolve_conflict') ORDER BY 1`);
      eq(f.rows.map(r => r.proname), ['sync_pull', 'sync_push', 'sync_resolve_conflict'], 'functions');
      for (const r of f.rows) {
        assert(r.prosecdef === false, r.proname + ' must be SECURITY INVOKER');
        assert((r.proconfig || []).some(x => /^search_path=pg_catalog, pg_temp$/.test(x)), r.proname + ' search_path');
        const pub = await admin.query(`SELECT has_function_privilege('public', p.oid, 'EXECUTE') AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'payesh_direct' AND p.proname = $1`, [r.proname]);
        assert(!pub.rows[0].ok, r.proname + ' executable by PUBLIC');
      }
      const t = await admin.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'payesh_direct' AND c.relname IN ('tenant_plan', 'tenant_usage', 'sync_op', 'sync_batch', 'sync_conflict') ORDER BY 1`);
      eq(t.rows.length, 5, 'new tables'); for (const r of t.rows) assert(r.relrowsecurity, 'RLS off on ' + r.relname);
      for (const tb of ['tenant_plan', 'tenant_usage']) for (const p of ['INSERT', 'UPDATE', 'DELETE']) {
        const r = await admin.query(`SELECT has_table_privilege('payesh_direct_client', $1, $2) AS ok`, ['payesh_direct.' + tb, p]);
        assert(!r.rows[0].ok, `client has ${p} on ${tb}`);
      }
      for (const fn of ['plan_for(uuid)', 'record_guard()']) {
        const r = await admin.query(`SELECT has_function_privilege('payesh_direct_client', $1, 'EXECUTE') AS ok`, ['payesh_direct.' + fn]);
        assert(!r.rows[0].ok, 'client may execute ' + fn);
      }
      const tg = await admin.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'payesh_direct.record'::regclass AND NOT tgisinternal`);
      eq(tg.rows.map(r => r.tgname), ['record_guard'], 'record trigger');
      return '3 RPCs INVOKER + pinned; 5 tables RLS; plan/usage read-only; plan_for internal';
    });

    /* ── SY-03 idempotency-v1 (+ server/sync.js side by side) ── */
    const { openStore } = require('../server/db');
    const sync = require('../server/sync');
    const refStore = (tag) => {
      const store = openStore(path.join(TMP, tag + '-' + crypto.randomBytes(4).toString('hex') + '.sqlite'));
      const mgr = store.insert('users', { name: 'مدیر', role: 'manager', active: true });
      return { store, actor: { user: mgr, role: 'manager', device: null } };
    };
    const counts = (resp) => ({
      applied: resp.applied.filter(a => !a.duplicate).length,
      duplicates: resp.applied.filter(a => a.duplicate).length + (resp.duplicates ? resp.duplicates.length : 0),
      conflicts: resp.conflicts.length,
    });

    await check('SY-03', 'idempotency-v1 vectors: every step gives the expected applied / duplicates / conflicts, and the same counts as server/sync.js on SQLite', async () => {
      const v = vec('idempotency-v1.json');
      const S = await school();
      const dev = await S.sync(S.mgr);
      const ref = refStore('idem');
      const out = []; let knownDiff = 0;
      for (const st of v.steps) {
        const r = await dev.push(st.ops.map(o => Object.assign({}, o, { data: o.data || {} })), null);
        const got = { applied: r.applied.filter(a => !a.duplicate).length, duplicates: r.applied.filter(a => a.duplicate).length, conflicts: r.conflicts.length };
        eq(got, st.expect, 'direct: ' + st.name);
        const rr = sync.push(ref.store, ref.actor, { ops: st.ops });
        if (/verdict is final/.test(st.name)) {
          /* the one known difference: sync.js re-evaluates a retried conflict (the Gateway and the vector do not) */
          eq(counts(rr), { applied: 0, duplicates: 0, conflicts: 1 }, 'sync.js known difference: ' + st.name);
          knownDiff++;
        } else eq(counts(rr), st.expect, 'sync.js: ' + st.name);
        out.push(`${got.applied}/${got.duplicates}/${got.conflicts}`);
        await dev.pull();
      }
      const n = (await q(S.mgr, 'SELECT count(*)::int AS n FROM payesh_direct.sync_conflict'))[0].n;
      eq(n, 1, 'one conflict recorded (both versions kept)');
      eq(knownDiff, 1, 'exactly one step differs from sync.js');
      return `${v.steps.length} steps equal to the vector (a/d/c ${out.join(' ')}); sync.js equal except the conflict-retry step (known, vector = Gateway)`;
    });

    await check('SY-04', 'pagination-v1 vector: 25 rows walk 10/10/5 with more t/t/f, no row skipped or repeated, cursor strictly increasing, empty last page keeps the cursor; limit clamped 0→1, 5000→50, abc→50, 7→7', async () => {
      const v = vec('pagination-v1.json');
      const S = await school();
      const ops = [];
      for (let i = 1; i <= v.seed_rows; i++) ops.push({ uid: 'pg-' + i, collection: 'homework', id: i, doc: { title: 'h' + i } });
      const w = await S.rawPut(S.mgr, ops);
      eq(w.counts.applied, v.seed_rows, 'seeded');
      const call = caller(S.mgr);
      let since = 0; const pages = [], mores = [], ids = new Set(), cursors = [];
      for (let g = 0; g < 10; g++) {
        const r = await call('sync_pull', [since, String(v.walk.limit), null]);
        pages.push(r.count); mores.push(r.more); r.rows.forEach(x => ids.add(x.collection + x.id));
        assert(r.next_seq > since || r.count === 0, 'cursor must move');
        cursors.push(r.next_seq); since = r.next_seq;
        if (!r.more) break;
      }
      eq(pages, v.walk.expect_pages, 'pages'); eq(mores, v.walk.expect_more, 'more');
      eq(ids.size, v.walk.expect_unique_total, 'unique');
      for (let i = 1; i < cursors.length; i++) assert(cursors[i] > cursors[i - 1], 'strictly increasing');
      const last = await call('sync_pull', [since, String(v.walk.limit), null]);
      eq({ count: last.count, more: last.more, cursor_unchanged: last.next_seq === since }, v.walk.expect_final_empty_page, 'final empty page');
      for (const c of v.clamp) eq((await call('sync_pull', [0, c.limit, null])).limit, c.expect_clamped_limit, 'clamp ' + c.limit);
      await refuses(call('sync_pull', [-1, '10', null]), '22023', 'negative cursor');
      return `pages ${pages.join('/')}, ${ids.size} unique, clamps ${v.clamp.map(c => c.limit + '→' + c.expect_clamped_limit).join(' ')}`;
    });

    await check('SY-05', 'scope-v1 vectors through RLS: roles become capability rows (row 106); every read case and every scope write case equals the vector; field checks (bad_score/bad_kind/bad_status) run on the device, before sealing', async () => {
      const v = vec('scope-v1.json');
      const S = await school();
      /* the SQL allow-list equals policy.collectionAllowed */
      const names = [...Object.keys(policy.COLLECTIONS), 'audit', 'devices', 'sessions', 'pair_codes', 'sync_log', 'zz_unknown', 'record', 'sync_op'];
      for (const nm of names) {
        const sqlOk = (await admin.query('SELECT payesh_direct.collection_known($1) AS ok', [nm])).rows[0].ok;
        eq(sqlOk, policy.collectionAllowed(nm), 'collection_known(' + nm + ')');
      }
      /* the role → capability mapping (what a manager grants), from server/scope.js */
      const OPEN = ['schools', 'school_years', 'subjects', 'bell_schedules', 'announcements', 'calendar', 'exams', 'homework'];
      const STUDENT_COLS = ['attendance', 'grades', 'internships', 'discipline'];
      const users = {};
      for (const [name, sc] of Object.entries(v.scopes)) {
        if (sc.role === 'manager') { users[name] = S.mgr; continue; }
        const u = await S.user(name + '-v', sc.role);
        users[name] = u;
        for (const c of OPEN) if (policy.canRead(sc.role, c)) await S.cap(u, 'read', 'school', null, c);
        for (const c of STUDENT_COLS) {
          for (const cl of sc.classIds) {
            if (sc.role === 'teacher' && policy.canRead(sc.role, c)) await S.cap(u, 'read', 'class', cl, c);
            if (sc.role === 'teacher' && policy.canWrite(sc.role, c)) await S.cap(u, 'write', 'class', cl, c);
          }
          for (const st of sc.studentIds) if (policy.canRead(sc.role, c)) await S.cap(u, 'read', 'student', st, c);
        }
        for (const st of sc.studentIds) {
          if (policy.canRead(sc.role, 'users')) await S.cap(u, 'read', 'student', st, 'users');
          if (policy.canRead(sc.role, 'leaves')) await S.cap(u, 'read', 'student', st, 'leaves');
          if (policy.canWrite(sc.role, 'leaves')) await S.cap(u, 'write', 'student', st, 'leaves');
        }
        if (sc.role === 'counselor') for (const c of ['counselor_notes', 'counselor_refs']) {
          if (policy.canRead(sc.role, c)) await S.cap(u, 'read', 'school', null, c);
          if (policy.canWrite(sc.role, c)) await S.cap(u, 'write', 'school', null, c);
        }
      }
      /* reads: the manager writes each row; each role pulls */
      let id = 0; const readOut = [];
      let selfRows = 0;
      for (const rc of v.read) {
        const row = Object.assign({}, rc.row);
        if (rc.collection === 'users' && Number(row.id) === v.scopes[rc.scope].uid) {
          /* the own identity row is app_user on the direct path (row 106 policy: own row) */
          const n = (await q(users[rc.scope], 'SELECT count(*)::int AS n FROM payesh_direct.app_user WHERE id = $1', [users[rc.scope].id]))[0].n;
          eq(n === 1, rc.expect, 'own identity row'); selfRows++; readOut.push('self'); continue;
        }
        const rid = 9000 + (++id);
        const doc = Object.assign({}, row);
        if (rc.collection === 'users') doc.student_id = Number(row.id);     /* routing: a student's users row */
        const w = await S.rawPut(S.mgr, [{ uid: 'sr-' + rid, collection: rc.collection, id: rid, doc }]);
        if (!policy.collectionAllowed(rc.collection)) {
          /* fail-closed like sync.js: such a row is never stored; the read predicate
             itself (the RLS function, = rowInScope) still equals the vector */
          eq([w.counts.applied, w.rejected[0] && w.rejected[0].error], [0, 'unknown_collection'], 'unknown collection refused');
          const pred = (await q(users[rc.scope], 'SELECT payesh_direct.can_access($1, $2, $3, $4, $5) AS ok',
            ['read', S.tenant, rc.collection, doc.class_id == null ? null : Number(doc.class_id), doc.student_id == null ? null : Number(doc.student_id)]))[0].ok;
          eq(pred, rc.expect, `read predicate ${rc.scope} ${rc.collection}`); readOut.push(pred ? 'Y' : 'N'); continue;
        }
        eq(w.counts.applied, 1, 'seed ' + rc.collection);
        const seen = (await caller(users[rc.scope])('sync_pull', [0, '50', [rc.collection]])).rows.some(r => Number(r.id) === rid);
        eq(seen, rc.expect, `read ${rc.scope} ${rc.collection} ${JSON.stringify(rc.row)}`);
        readOut.push(seen ? 'y' : 'n');
      }
      /* writes */
      const FIELD_ERRORS = new Set(['bad_score', 'bad_kind', 'bad_status']);
      let dbRefused = 0, deviceRefused = 0, ok = 0;
      for (const wc of v.write) {
        const rid = 9500 + (++id);
        const sc = v.scopes[wc.scope];
        const local = scopeMod.canWriteRow(sc, wc.collection, wc.row, null);
        if (!local.ok && FIELD_ERRORS.has(local.error)) {
          /* the database only sees ciphertext — the device refuses before sealing */
          eq(local, wc.expect, 'device-side field check ' + JSON.stringify(wc.row)); deviceRefused++; continue;
        }
        const p = S.rawPut(users[wc.scope], [{ uid: 'sw-' + rid, collection: wc.collection, id: rid, doc: wc.row }]);
        if (wc.expect.ok) { eq((await p).counts.applied, 1, 'write ' + JSON.stringify(wc)); ok++; }
        else { await refuses(p, '42501', `write ${wc.scope} ${wc.collection} ${JSON.stringify(wc.row)} (${wc.expect.error})`); dbRefused++; }
      }
      return `collection list = policy.js (${names.length} names); read ${v.read.length} equal (${readOut.join('')}, own row via app_user ×${selfRows}); write ${ok} ok, ${dbRefused} refused by RLS, ${deviceRefused} field checks on device`;
    });

    await check('SY-06', 'conflict-v1 vectors end to end: stale ops come back to the device, its verdict equals the vector (action/reason/fields), and the database result (row, version, conflict kept) equals server/sync.js on SQLite', async () => {
      const v = vec('conflict-v1.json');
      const S = await school();
      const dev = await S.sync(S.mgr);
      const ref = refStore('conf');
      let n = 0; const tally = {};
      for (const c of v.cases) {
        const i = c.input; n++;
        const rid = 700 + n; const col = i.collection;
        /* bring the row to existing._version on both servers */
        if (i.existing) {
          const base = Object.assign({}, i.existing); delete base._version; delete base.id;
          for (let ver = 0; ver < i.existing._version; ver++) {
            const sop = { uid: `cv${n}-s${ver}`, collection: col, id: rid, type: 'put', base_version: ver, data: base };
            const r1 = await dev.push([sop], null);
            await dev.pull();
            const r1r = sync.push(ref.store, ref.actor, { ops: [sop] });
            eq(outcomeOf(r1, sop.uid), outcomeOf(r1r, sop.uid), 'seed vs sync.js ' + c.name);
          }
        }
        const local = convergence.decide({ collection: col, type: i.type, incoming: i.incoming, existing: i.existing, base_version: i.base_version });
        eq({ action: local.action, reason: local.reason, fields: local.fields }, { action: c.expect.action, reason: c.expect.reason, fields: c.expect.fields }, 'verdict ' + c.name);
        const op = { uid: `cv${n}-x`, collection: col, id: rid, type: i.type, base_version: i.base_version, data: i.incoming || {} };
        const r = await dev.push([op], null);
        const rr = sync.push(ref.store, ref.actor, { ops: [op] });
        const kind = outcomeOf(r, op.uid), kindRef = outcomeOf(rr, op.uid);
        eq(kind, kindRef, 'outcome vs sync.js ' + c.name);
        tally[kind] = (tally[kind] || 0) + 1;
        await dev.pull();
        const sh = dev.shadow.get(col + '#' + rid);
        const refRow = ref.store.get(col, rid);
        eq(sh ? sh.version : null, refRow ? refRow._version : null, 'version vs sync.js ' + c.name);
        if (refRow) for (const f of Object.keys(Object.assign({}, i.incoming || {}, i.existing || {}))) {
          if (convergence.META_FIELDS.has(f)) continue;
          assert(same(sh.doc[f], refRow[f]), `${c.name}: field ${f} direct=${JSON.stringify(sh.doc[f])} sync.js=${JSON.stringify(refRow[f])}`);
        }
        if (kind === 'conflict') {
          const cf = (await q(S.mgr, 'SELECT * FROM payesh_direct.sync_conflict WHERE uid = $1', [op.uid]))[0];
          assert(cf && cf.status === 'needs_review', 'conflict kept for review');
          eq(cf.kind, c.expect.reason === 'delete_vs_edit' ? 'delete_vs_edit' : 'edit_vs_edit', 'conflict kind');
          if (i.type === 'put') eq(dev.openConflict(cf), i.incoming, 'local version readable by the manager');
        }
      }
      return `${v.cases.length} cases: verdicts equal; outcomes ${Object.entries(tally).map(([k, x]) => k + '=' + x).join(' ')}; rows/versions equal to sync.js`;
    });

    /* ── SY-07: the row-83 convergence harness on the direct path ── */
    async function scenario(seed, opts = {}) {
      const rnd = mulberry32(seed);
      const steps = opts.steps || 120;
      const nDev = 3 + Math.floor(rnd() * 3);
      const S = await school();
      const oracle = makeOracle();
      const stats = { pushes: 0, ops: 0, lost: 0, replayed: 0, dup: 0, conflicts: 0, merged: 0, noop: 0, applied: 0, deleted: 0, rejected: 0, resolved: 0, stale: 0 };
      let firstDivergence = null;
      const diverge = (step, what) => { if (!firstDivergence) firstDivergence = `seed=${seed} step=${step} ${what}`; };
      const adminDev = await S.sync(S.mgr);
      let resolveSeq = 0;

      async function serverPush(step, dev, idemKey, ops) {
        const resp = await dev.ds.push(ops.map(o => ({ uid: o.uid, collection: o.collection, type: o.type, id: o.id, data: o.data, base_version: o.base_version })), idemKey);
        const exp = oracle.batch(idemKey, ops);
        stats.pushes++;
        if (resp.replayed) stats.replayed++;
        if (!!resp.replayed !== exp.replayed) diverge(step, `replay mismatch key=${idemKey}`);
        ops.forEach((o, i) => {
          const got = outcomeOf(resp, o.uid);
          const want = exp.outcomes[i];
          const okWant = OK_SET.has(want) ? 'ok' : want;
          if (!exp.replayed) { stats.ops++; const k = want === 'duplicate' ? 'dup' : want === 'conflict' ? 'conflicts' : want; stats[k] = (stats[k] || 0) + 1; }
          if (got !== okWant) diverge(step, `op ${o.uid} ${o.collection}#${o.id} ${o.type} base=${o.base_version} data=${JSON.stringify(o.data)}: direct=${got} spec=${want}`);
        });
        return resp;
      }

      const seedOps = [];
      for (const col of COLS) for (let i = 1; i <= 5; i++) {
        const id = 100 + i;
        const data = col === 'attendance'
          ? { student_id: i, class_id: 1, date: '2026-11-0' + i, status: 'present', note: '', arrival_time: '07:30', excuse_note: '' }
          : { student_id: i, subject_id: 2, term: 1, score: 15, note: '', teacher_note: '' };
        seedOps.push({ uid: `seed-${col}-${id}`, collection: col, type: 'put', id, data, base_version: 0 });
      }
      await serverPush(-1, { ds: adminDev }, 'seed-batch-' + seed, seedOps);

      const devs = [];
      for (let n = 1; n <= nDev; n++) {
        const d = await S.device(S.mgr, 'fuzz ' + n);
        devs.push({ n, online: true, replica: new Map(), outbox: [], seq: 0, nextId: 1000 * n, lost: null, ds: await S.sync(d) });
      }
      const rkey = (c, id) => c + '#' + id;
      async function pull(dev) {
        await dev.ds.pull((k, doc) => {
          if (doc) dev.replica.set(k, Object.assign({}, doc));
          else if (!opts.ignoreTombstones) dev.replica.delete(k);
        }, { collections: COLS });
      }
      async function flush(step, dev) {
        if (!dev.outbox.length) return;
        let ops, idemKey;
        if (dev.lost && rnd() < 0.7) { ops = dev.lost.ops; idemKey = dev.lost.key; }
        else {
          ops = dev.outbox.slice(0, 1 + Math.floor(rnd() * 8));
          idemKey = 's' + seed + 'd' + dev.n + '-' + crypto.createHash('sha1').update(ops.map(o => o.uid).join('|')).digest('hex').slice(0, 16);
        }
        const resp = await serverPush(step, dev, idemKey, ops);
        if (rnd() < 0.12) { stats.lost++; dev.lost = { ops, key: idemKey }; dev.online = false; return; }
        dev.lost = null;
        const done = new Set(ops.map(o => o.uid));
        for (const c of resp.conflicts) done.add(c.uid);
        dev.outbox = dev.outbox.filter(o => !done.has(o.uid));
      }
      function localEdit(dev) {
        const known = [...dev.replica.keys()];
        const r = rnd();
        let op;
        if (r < 0.06 || !known.length) {
          const col = pickOf(rnd, COLS);
          const id = dev.nextId++;
          const data = col === 'attendance'
            ? { student_id: 50 + dev.n, class_id: 1, date: '2026-11-20', status: pickOf(rnd, FIELDS.attendance.manual.status), note: '', arrival_time: '07:45', excuse_note: '' }
            : { student_id: 50 + dev.n, subject_id: 2, term: 1, score: pickOf(rnd, FIELDS.grades.manual.score), note: '', teacher_note: '' };
          op = { collection: col, type: 'put', id, data, base_version: 0 };
          dev.replica.set(rkey(col, id), Object.assign({ id, _version: 0 }, data));
        } else if (r < 0.09) {
          const k = pickOf(rnd, known); const row = dev.replica.get(k); const col = k.split('#')[0];
          op = { collection: col, type: 'del', id: row.id, data: {}, base_version: row._version };
          dev.replica.delete(k);
        } else {
          const k = pickOf(rnd, known); const row = dev.replica.get(k); const col = k.split('#')[0];
          const F = FIELDS[col]; const data = {};
          const kinds = rnd() < 0.3 ? ['manual'] : rnd() < 0.85 ? ['auto'] : ['manual', 'auto'];
          for (const kind of kinds) {
            const names = Object.keys(F[kind]); const f = pickOf(rnd, names);
            data[f] = pickOf(rnd, F[kind][f]);
            if (rnd() < 0.3) { const g = pickOf(rnd, names); data[g] = pickOf(rnd, F[kind][g]); }
          }
          op = { collection: col, type: 'put', id: row.id, data, base_version: row._version };
          Object.assign(row, data);
        }
        op.uid = `s${seed}d${dev.n}-${++dev.seq}`;
        dev.outbox.push(op);
      }

      for (const d of devs) await pull(d);
      for (let step = 0; step < steps; step++) {
        const dev = pickOf(rnd, devs);
        const a = rnd();
        if (a < 0.12) { dev.online = !dev.online; continue; }
        if (a < 0.62) { localEdit(dev); continue; }
        if (a < 0.67) {
          const open = oracle.conflicts.map((c, i) => [c, i]).filter(([c]) => !c.resolved);
          if (open.length) {
            const [c, i] = pickOf(rnd, open);
            const live = oracle.rows.get(oracle.key(c.collection, c.record_id));
            const decision = live && !live.deleted && rnd() < 0.5 ? 'local' : 'server';
            const srv = await q(S.mgr, 'SELECT * FROM payesh_direct.sync_conflict ORDER BY id');
            const target = srv[i];
            if (!target || target.collection !== c.collection || Number(target.record_id) !== Number(c.record_id)) diverge(step, `conflict #${i} not recorded as spec says (${c.collection}#${c.record_id})`);
            else {
              const res = await adminDev.resolve(target, decision, `s${seed}-resolve-${++resolveSeq}`);
              if (decision === 'local' && (!res.write || res.write.counts.applied !== 1)) diverge(step, 'local resolution not written');
              oracle.resolve(i, decision); stats.resolved++;
            }
          }
          continue;
        }
        if (!dev.online) continue;
        await flush(step, dev);
        if (dev.online && !dev.outbox.length) await pull(dev);
      }
      for (const d of devs) d.online = true;
      for (let round = 0; round < 60 && devs.some(d => d.outbox.length); round++) for (const d of devs) { d.online = true; await flush(steps + round, d); }
      for (const d of devs) { d.online = true; await pull(d); }
      const left = devs.reduce((s, d) => s + d.outbox.length, 0);
      if (left) diverge(steps, `outbox not drained: ${left}`);

      /* the server state = what the manager reads and decrypts */
      const server = new Map();
      const reader = await S.sync(S.mgr);
      await reader.pull((k, doc) => { if (doc) server.set(k, doc); else server.delete(k); }, { collections: COLS });
      const canon = m => JSON.stringify([...m.keys()].sort().map(k => [k, m.get(k)]));
      const srvCanon = canon(server);
      const p1 = [];
      for (const d of devs) if (canon(d.replica) !== srvCanon) {
        const miss = [...server.keys()].filter(k => !d.replica.has(k)).length;
        const extra = [...d.replica.keys()].filter(k => !server.has(k)).length;
        const diff = [...server.keys()].filter(k => d.replica.has(k) && JSON.stringify(d.replica.get(k)) !== JSON.stringify(server.get(k))).length;
        p1.push(`device ${d.n}: missing=${miss} extra=${extra} differing=${diff}`);
      }
      const p2 = [];
      for (const [k, r] of oracle.rows) {
        const col = k.split('#')[0]; const s = server.get(k);
        if (r.deleted) { if (s) p2.push(`${k} should be deleted`); continue; }
        if (!s) { p2.push(`${k} missing on server`); continue; }
        if (s._version !== r.version) p2.push(`${k} version server=${s._version} spec=${r.version}`);
        for (const f of DOMAIN[col]) if (!same(s[f], r.doc[f])) p2.push(`${k}.${f} server=${JSON.stringify(s[f])} spec=${JSON.stringify(r.doc[f])}`);
      }
      for (const k of server.keys()) if (!oracle.rows.has(k)) p2.push(`${k} unexpected on server`);
      const srvConf = (await q(S.mgr, 'SELECT count(*)::int AS n FROM payesh_direct.sync_conflict'))[0].n;
      if (srvConf !== oracle.conflicts.length) p2.push(`conflicts server=${srvConf} spec=${oracle.conflicts.length}`);
      if (p2.length) diverge(steps, 'final state vs spec: ' + p2.slice(0, 3).join(' | ') + (p2.length > 3 ? ` (+${p2.length - 3})` : ''));
      for (const d of devs) stats.stale += d.ds.stats.stale;
      return { seed, nDev, stats, p1, divergence: firstDivergence, rows: server.size };
    }
    const SEEDS = process.env.DS108_SEEDS
      ? process.env.DS108_SEEDS.split(',').map(s => Number(s.trim())).filter(Number.isFinite)
      : Array.from({ length: Number(process.env.DS108_RUNS || 12) }, (_, i) => 8300 + i * 7919);
    const sum = (rs, k) => rs.reduce((s, r) => s + (r.stats[k] || 0), 0);

    await check('SY-07', `row-83 convergence on the direct path: ${SEEDS.length} seeded scenarios × 3–5 devices (offline/online, lost responses + retries, deletes, chained offline edits, human resolutions); P1 replicas = server, P2 every op and every final row = the spec oracle; a device-side domain-rule mutation and a device ignoring tombstones are caught`, async () => {
      const results = [];
      for (const s of SEEDS) results.push(await scenario(s));
      const bad = results.filter(r => r.divergence || r.p1.length);
      if (bad.length) throw new Error(bad.slice(0, 2).map(r => r.divergence || ('P1 ' + r.p1.join('; ') + ' seed=' + r.seed)).join(' || '));
      /* negative: grades.score made auto-mergeable in the device's rules ⇒ P2 */
      const saved = JSON.parse(JSON.stringify(convergence.RULES.grades));
      let caught = 0;
      try {
        convergence.RULES.grades.auto.push('score');
        convergence.RULES.grades.manual = convergence.RULES.grades.manual.filter(f => f !== 'score');
        convergence.RULES.grades.merge = 'fields';
        const m = []; for (const s of SEEDS.slice(0, 4)) m.push(await scenario(s));
        if (m.some(r => r.divergence)) caught++;
      } finally { convergence.RULES.grades = saved; }
      const t = []; for (const s of SEEDS.slice(0, 4)) t.push(await scenario(s, { ignoreTombstones: true }));
      if (t.some(r => r.p1.length)) caught++;
      eq(caught, 2, 'negative controls caught');
      negatives += 2;
      return `ops=${sum(results, 'ops')} applied=${sum(results, 'applied')} merged=${sum(results, 'merged')} noop=${sum(results, 'noop')} conflicts=${sum(results, 'conflicts')} deleted=${sum(results, 'deleted')} rejected=${sum(results, 'rejected')} dup=${sum(results, 'dup')} replayed=${sum(results, 'replayed')} lost=${sum(results, 'lost')} resolved=${sum(results, 'resolved')} stale_round_trips=${sum(results, 'stale')}; 0 divergences; score→auto and ignore-tombstones caught`;
    });

    let SQ = null;
    await check('SY-08', 'a repeated push has no second effect: same uid again (also with a changed body), same request key (replay of the merged multi-round answer), and two connections racing with the same batch ⇒ each op applied once', async () => {
      const S = await school(); SQ = S;
      const dev = await S.sync(S.mgr);
      const op = { uid: 'twice-1', collection: 'homework', id: 1, type: 'put', base_version: 0, data: { title: 'a' } };
      const r1 = await dev.push([op], 'req-1');
      const r2 = await dev.push([op], 'req-1');
      assert(r2.replayed && JSON.stringify(r2.applied) === JSON.stringify(r1.applied), 'request replay');
      const r3 = await dev.push([Object.assign({}, op, { data: { title: 'changed' } })], 'req-2');
      eq(outcomeOf(r3, 'twice-1'), 'duplicate', 'uid wins over a changed body');
      /* a batch that needs a second round (stale → merged) is replayed whole */
      await dev.pull();
      const other = await S.sync(await S.device(S.mgr, 'second'));
      await other.pull();
      await other.push([{ uid: 'o-1', collection: 'homework', id: 1, type: 'put', base_version: 1, data: { note: 'x' } }], null);
      const mixed = [{ uid: 'm-1', collection: 'homework', id: 2, type: 'put', base_version: 0, data: { title: 'b' } },
        { uid: 'm-2', collection: 'homework', id: 1, type: 'put', base_version: 1, data: { title: 'a' } }];
      const a = await dev.push(mixed, 'req-3');
      const b = await dev.push(mixed, 'req-3');
      assert(b.replayed, 'second answer is a replay');
      eq(b.applied.map(x => x.uid).sort(), a.applied.map(x => x.uid).sort(), 'replayed answer covers both rounds');
      /* concurrent twins on two connections */
      const twin = [{ uid: 'race-1', collection: 'homework', id: 50, type: 'put', base_version: 0, data: { title: 'r' } },
        { uid: 'race-2', collection: 'homework', id: 51, type: 'put', base_version: 0, data: { title: 'r' } }];
      const [x, y] = await Promise.all([dev.push(twin, null), other.push(twin, null)]);
      const appliedOnce = ['race-1', 'race-2'].every(u => [x, y].filter(r => outcomeOf(r, u) === 'ok').length === 1 && [x, y].filter(r => outcomeOf(r, u) === 'duplicate').length === 1);
      assert(appliedOnce, 'each racing op applied exactly once: ' + JSON.stringify([x.applied, y.applied]));
      const v = await admin.query(`SELECT record_id, version FROM payesh_direct.record WHERE tenant_id = $1 AND record_id IN (50, 51) ORDER BY 1`, [S.tenant]);
      eq(v.rows.map(r => r.version), [1, 1], 'versions after the race');
      negatives += 3;
      return 'uid duplicate, request replay (2-round answer whole), race ⇒ once each (v=1)';
    });

    await check('SY-09', 'plan caps refused atomically: records, bytes, ops per push, ops per window, op size (54000); a tombstone frees a slot; usage exact; plan/usage not writable by clients; usage visible to the manager only', async () => {
      const S = await school();
      const t = await S.user('t-plan', 'teacher');
      await S.cap(t, 'write', 'school', null, 'homework'); await S.cap(t, 'read', 'school', null, 'homework');
      await admin.query(`INSERT INTO payesh_direct.tenant_plan (tenant_id, max_records, max_bytes, max_ops_per_push, max_ops_per_window, window_sec, max_op_bytes)
                         VALUES ($1, 5, 200000, 4, 12, 3600, 4096)`, [S.tenant]);
      const put = (u, from, n) => S.rawPut(u, Array.from({ length: n }, (_, i) => ({ uid: `pl-${from + i}`, collection: 'homework', id: from + i, doc: { title: 'x' + (from + i) } })));
      eq((await put(S.mgr, 1, 4)).counts.applied, 4, 'within the cap');
      await refuses(put(S.mgr, 10, 2), '54000', 'records cap', /plan_records_exceeded/);
      eq((await admin.query('SELECT count(*)::int AS n FROM payesh_direct.record WHERE tenant_id = $1', [S.tenant])).rows[0].n, 4, 'nothing of the refused batch written');
      eq((await put(S.mgr, 5, 1)).counts.applied, 1, 'the 5th record fits');
      await refuses(put(S.mgr, 6, 1), '54000', 'records cap (6th)', /plan_records_exceeded/);
      const del = await caller(S.mgr)('sync_push', [JSON.stringify([{ uid: 'pl-del', collection: 'homework', id: 1, type: 'del', base_version: 1 }]), null]);
      eq(del.counts.applied, 1, 'delete'); 
      eq((await put(S.mgr, 6, 1)).counts.applied, 1, 'a tombstone frees a slot');
      await refuses(put(S.mgr, 20, 5), '54000', 'ops per push', /too_many_ops/);
      const big = 'y'.repeat(6000);
      await refuses(S.rawPut(S.mgr, [{ uid: 'pl-big', collection: 'homework', id: 2, base_version: 1, doc: { title: big } }]), '54000', 'op size', /op_too_large/);
      const u = (await admin.query('SELECT records, bytes, window_ops FROM payesh_direct.tenant_usage WHERE tenant_id = $1', [S.tenant])).rows[0];
      const real = (await admin.query('SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS n, coalesce(sum(octet_length(sealed)), 0)::bigint AS b FROM payesh_direct.record WHERE tenant_id = $1', [S.tenant])).rows[0];
      eq([Number(u.records), Number(u.bytes)], [real.n, Number(real.b)], 'usage exact');
      /* window: used so far = successful pushes' ops; fill to the cap, then one more */
      const left = 12 - Number(u.window_ops);
      assert(left > 0, 'window has room');
      await admin.query('UPDATE payesh_direct.tenant_plan SET max_records = 1000 WHERE tenant_id = $1', [S.tenant]);
      let from = 100;
      for (let k = left; k > 0; k -= Math.min(4, k)) { await put(S.mgr, from, Math.min(4, k)); from += 4; }
      await refuses(put(S.mgr, 300, 1), '54000', 'ops per window', /plan_rate_exceeded/);
      /* bytes cap */
      await admin.query('UPDATE payesh_direct.tenant_plan SET max_bytes = $2, max_ops_per_window = 100000 WHERE tenant_id = $1', [S.tenant, Number(real.b) + 100]);
      await refuses(put(S.mgr, 400, 1), '54000', 'bytes cap', /plan_bytes_exceeded/);
      /* clients cannot touch plan/usage; only the manager reads usage */
      await refuses(q(S.mgr, 'UPDATE payesh_direct.tenant_plan SET max_records = 999999 WHERE tenant_id = $1', [S.tenant]), '42501', 'manager edits plan');
      await refuses(q(S.mgr, 'UPDATE payesh_direct.tenant_usage SET records = 0 WHERE tenant_id = $1', [S.tenant]), '42501', 'manager edits usage');
      await refuses(q(S.mgr, 'SELECT payesh_direct.plan_for($1)', [S.tenant]), '42501', 'plan_for internal');
      eq((await q(t, 'SELECT count(*)::int AS n FROM payesh_direct.tenant_usage'))[0].n, 0, 'teacher sees no usage');
      eq((await q(S.mgr, 'SELECT count(*)::int AS n FROM payesh_direct.tenant_usage'))[0].n, 1, 'manager sees own usage');
      eq((await q(t, 'SELECT (payesh_direct.my_plan()).max_records AS m'))[0].m, 1000, 'own plan visible');
      return `records/bytes/ops-per-push/window/op-size refused; usage ${real.n} rows ${real.b} B exact; plan+usage read-only`;
    });

    await check('SY-10', 'RLS through the RPCs: another school pulls 0; a push with one out-of-scope op is refused whole (nothing written); read-only role cannot push; revoked device ⇒ not_authenticated; conflicts visible to reporter + manager only; resolve: manager only, once', async () => {
      const A = await school(), B = await school();
      const tA = await A.user('t-rls', 'teacher');
      await A.cap(tA, 'read', 'class', 1, 'attendance'); await A.cap(tA, 'write', 'class', 1, 'attendance');
      const pA = await A.user('p-rls', 'parent'); await A.cap(pA, 'read', 'student', 10, null);
      await A.publish('class:1:attendance');     /* before any write: the teacher's device can read its class */
      const mk = (uid, id, cls, st) => ({ uid, collection: 'attendance', id, doc: { class_id: cls, student_id: st, status: 'present' } });
      eq((await A.rawPut(tA, [mk('r1', 1, 1, 10), mk('r2', 2, 1, 11)])).counts.applied, 2, 'teacher in scope');
      await refuses(A.rawPut(tA, [mk('r3', 3, 1, 10), mk('r4', 4, 2, 12)]), '42501', 'one op out of scope');
      eq((await admin.query('SELECT count(*)::int AS n FROM payesh_direct.record WHERE tenant_id = $1', [A.tenant])).rows[0].n, 2, 'batch refused whole');
      eq((await caller(B.mgr)('sync_pull', [0, '50', null])).count, 0, 'other school pulls 0');
      eq((await caller(pA)('sync_pull', [0, '50', null])).count, 1, 'parent pulls own child only');
      await refuses(A.rawPut(pA, [mk('r5', 5, 1, 10)]), '42501', 'read-only parent pushes');
      /* someone else's existing row id (outside scope) cannot be claimed */
      eq((await A.rawPut(A.mgr, [mk('r6', 6, 9, 99)])).counts.applied, 1, 'manager row in class 9');
      await refuses(A.rawPut(tA, [mk('r7', 6, 1, 10)]), '42501', 'claim an out-of-scope id', /out_of_scope/);
      /* conflicts */
      const dT = await A.sync(tA, ['class:1:attendance']);
      await dT.pull();
      await A.rawPut(A.mgr, [{ uid: 'r8', collection: 'attendance', id: 1, base_version: 1, doc: { class_id: 1, student_id: 10, status: 'absent' } }]);
      const cr = await dT.push([{ uid: 'r9', collection: 'attendance', id: 1, type: 'put', base_version: 1, data: { status: 'late' } }], null);
      eq(cr.conflicts.length, 1, 'teacher conflict');
      const cid = cr.conflicts[0].conflict_id;
      eq((await q(tA, 'SELECT count(*)::int AS n FROM payesh_direct.sync_conflict'))[0].n, 1, 'reporter sees it');
      eq((await q(pA, 'SELECT count(*)::int AS n FROM payesh_direct.sync_conflict'))[0].n, 0, 'parent does not');
      eq((await q(B.mgr, 'SELECT count(*)::int AS n FROM payesh_direct.sync_conflict'))[0].n, 0, 'other school does not');
      await refuses(caller(tA)('sync_resolve_conflict', [cid, 'local']), 'P0002', 'teacher resolves');
      await refuses(caller(B.mgr)('sync_resolve_conflict', [cid, 'local']), 'P0002', 'other manager resolves');
      await refuses(q(tA, `UPDATE payesh_direct.sync_conflict SET decided_by = $1 WHERE id = $2`, [tA.id, cid]), '42501', 'forge decided_by');
      const res = await caller(A.mgr)('sync_resolve_conflict', [cid, 'server']);
      eq([res.decision, res.decided_by], ['server', A.mgr.id], 'resolved by the manager (identity from the database)');
      await refuses(caller(A.mgr)('sync_resolve_conflict', [cid, 'local']), '55000', 'resolve twice', /already_resolved/);
      await refuses(caller(A.mgr)('sync_resolve_conflict', [cid, 'maybe']), '22023', 'bad decision');
      /* revoked device */
      await q(A.mgr, 'SELECT payesh_direct.revoke_device($1)', [tA.device]);
      await refuses(caller(tA)('sync_pull', [0, '50', null]), '42501', 'revoked device pulls', /not_authenticated/);
      await refuses(A.rawPut(tA, [mk('r10', 10, 1, 10)]), '42501', 'revoked device pushes', /not_authenticated/);
      await refuses(caller({ sub: 'nobody', device: crypto.randomUUID() })('sync_pull', [0, '50', null]), '42501', 'unknown subject');
      return 'cross-school 0; atomic scope refusal; read-only, revoked, unknown refused; conflict visibility + manager-only single resolution';
    });

    await check('SY-11', 'feed order under concurrent writers: a second writer of the same school waits for the first; a pull taken while the first is in flight skips nothing later; seq follows commit order', async () => {
      const S = await school();
      const call = caller(S.mgr);
      const before = (await call('sync_pull', [0, '50', null])).next_seq;
      const c1 = await api.connect();
      let bDone = false;
      try {
        await c1.query('BEGIN');
        await c1.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(tok(S.mgr))]);
        await c1.query(RPC.sync_push, [JSON.stringify([{ uid: 'cc-a', collection: 'homework', id: 1, type: 'put', base_version: 0, sealed: S.seal('homework', 1, 1, { title: 'a' }) }]), null]);
        const pB = S.rawPut(S.mgr, [{ uid: 'cc-b', collection: 'homework', id: 2, doc: { title: 'b' } }]).then(r => { bDone = true; return r; });
        await sleep(300);
        assert(!bDone, 'second writer must wait for the first (tenant lock)');
        const mid = await call('sync_pull', [before, '50', null]);
        eq(mid.count, 0, 'nothing visible while in flight');
        await c1.query('COMMIT');
        await pB;
      } finally { c1.release(); }
      const after = await call('sync_pull', [before, '50', null]);
      eq(after.rows.map(r => r.id), [1, 2], 'both rows after the cursor, in commit order');
      assert(after.rows[0].seq < after.rows[1].seq, 'seq follows commit order');
      return `B waited for A; mid-flight pull empty; then ids 1,2 with seq ${after.rows.map(r => r.seq).join('<')}`;
    });

    await check('SY-12', 'mutation controls: 4 broken variants of migration 0003, each caught (uid idempotency, OCC, plan cap, feed position)', async () => {
      const S = SQ;
      const fn = (await admin.query(`SELECT pg_get_functiondef('payesh_direct.sync_push(jsonb, text)'::regprocedure) AS d`)).rows[0].d;
      const guard = (await admin.query(`SELECT pg_get_functiondef('payesh_direct.record_guard()'::regprocedure) AS d`)).rows[0].d;
      const mutate = (src, a, b) => { assert(src.includes(a), 'mutation anchor missing: ' + a.slice(0, 50)); return src.replace(a, b); };
      async function underMutant(ddl, claims, probe) {
        const c = await admin.connect();
        try {
          await c.query('BEGIN'); await c.query(ddl);
          await c.query('SET LOCAL ROLE payesh_direct_client');
          await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
          return await probe(c);
        } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
      }
      const push = (c, ops) => c.query(RPC.sync_push, [JSON.stringify(ops), null]).then(r => r.rows[0].r);
      const cur = async (c, id) => Number((await c.query(`SELECT version FROM payesh_direct.record WHERE collection = 'homework' AND record_id = $1`, [id])).rows[0].version);
      const out = [];
      // M1: uid idempotency removed ⇒ the same op applied twice
      const m1 = await underMutant(mutate(fn, 'ON CONFLICT (tenant_id, uid) DO NOTHING;', 'ON CONFLICT (tenant_id, uid) DO UPDATE SET outcome = \'pending\';'), tok(S.mgr), async c => {
        const v = await cur(c, 1);
        await push(c, [{ uid: 'twice-1', collection: 'homework', id: 1, type: 'put', base_version: v, sealed: S.seal('homework', 1, v + 1, { title: 'again' }) }]);
        return (await cur(c, 1)) - v;
      });
      eq(m1, 1, 'M1 not caught'); out.push('M1 replayed uid re-applied');
      // M2: OCC removed ⇒ a stale op overwrites the newer row (the version trigger
      //     cannot see it: sync_push always writes cur+1, so OCC is the only guard)
      const occ = "IF coalesce(cur.version, 0) <> v_base OR (v_type = 'del' AND cur.deleted) THEN";
      const staleOp = async (c, tag) => {
        const v = await cur(c, 1);
        return push(c, [{ uid: 'stale-' + tag, collection: 'homework', id: 1, type: 'put', base_version: v - 1, sealed: S.seal('homework', 1, v, { title: 'stale' }) }]);
      };
      const real = await underMutant('SELECT 1', tok(S.mgr), c => staleOp(c, 'real'));
      eq([real.counts.applied, real.counts.stale], [0, 1], 'without the mutant the op comes back stale');
      const m2 = await underMutant(mutate(fn, occ, 'IF false THEN'), tok(S.mgr), async c => (await staleOp(c, 'm2')).counts.applied);
      eq(m2, 1, 'M2 not caught'); out.push('M2 stale overwrite');
      // M3: plan cap check removed ⇒ over-cap insert accepted
      await admin.query(`INSERT INTO payesh_direct.tenant_plan (tenant_id, max_records) VALUES ($1, 1) ON CONFLICT (tenant_id) DO UPDATE SET max_records = 1`, [S.tenant]);
      const m3 = await underMutant(mutate(guard, 'IF d_rec > 0 AND u.records + d_rec > p.max_records THEN', 'IF false THEN'), tok(S.mgr), async c =>
        (await push(c, [{ uid: 'cap-m3', collection: 'homework', id: 777, type: 'put', base_version: 0, sealed: S.seal('homework', 777, 1, { title: 'over' }) }])).counts.applied);
      await refuses(S.rawPut(S.mgr, [{ uid: 'cap-real', collection: 'homework', id: 778, doc: { title: 'over' } }]), '54000', 'cap without mutant', /plan_records_exceeded/);
      await admin.query('DELETE FROM payesh_direct.tenant_plan WHERE tenant_id = $1', [S.tenant]);
      eq(m3, 1, 'M3 not caught'); out.push('M3 over-cap accepted');
      // M4: feed position not assigned ⇒ the new row never reaches a pull
      const m4 = await underMutant(mutate(guard, "NEW.seq := nextval('payesh_direct.record_seq');", 'NULL;'), tok(S.mgr), async c => {
        const before = (await c.query(RPC.sync_pull, [0, '50', null])).rows[0].r;
        let since = 0; const seen = new Set();
        for (;;) { const r = (await c.query(RPC.sync_pull, [since, '50', null])).rows[0].r; r.rows.forEach(x => seen.add(Number(x.id))); since = r.next_seq; if (!r.more) break; }
        await push(c, [{ uid: 'feed-m4', collection: 'homework', id: 888, type: 'put', base_version: 0, sealed: S.seal('homework', 888, 1, { title: 'hidden' }) }]);
        const r2 = (await c.query(RPC.sync_pull, [since, '50', null])).rows[0].r;
        return before && r2.rows.some(x => Number(x.id) === 888);
      });
      eq(m4, false, 'M4 not caught'); out.push('M4 row missing from the feed');
      mutantsKilled = 4;
      const fresh = await caller(S.mgr)('sync_pull', [0, '50', ['homework']]);
      assert(!fresh.rows.some(x => [777, 888].includes(Number(x.id))), 'schema restored after mutants');
      return out.join('; ') + ' — all 4 caught, schema restored';
    });

    await check('SY-13', 'rollback of 0004 + 0003 through the migrator leaves rows 106/107 intact (identity, key tables, ciphertext rows); re-apply is clean and re-numbers the feed', async () => {
      const n0 = (await admin.query('SELECT count(*)::int AS n FROM payesh_direct.record')).rows[0].n;
      const k0 = (await admin.query('SELECT count(*)::int AS n FROM payesh_direct.key_grant')).rows[0].n;
      const r = cli(['rollback', '--to', '0002_key_grants', '--dir', DIR], DB_URL);
      assert(r.code === 0, 'rollback: ' + r.out);
      const gone = await admin.query(`SELECT to_regclass('payesh_direct.sync_op') AS a, to_regclass('payesh_direct.tenant_plan') AS b, to_regprocedure('payesh_direct.sync_push(jsonb,text)') AS c`);
      assert(!gone.rows[0].a && !gone.rows[0].b && !gone.rows[0].c, 'sync objects gone');
      eq((await admin.query('SELECT count(*)::int AS n FROM payesh_direct.record')).rows[0].n, n0, 'records kept');
      eq((await admin.query('SELECT count(*)::int AS n FROM payesh_direct.key_grant')).rows[0].n, k0, 'key grants kept');
      const u = cli(['up', '--dir', DIR, '--to', OWN], DB_URL); assert(u.code === 0, 're-up: ' + u.out);
      const nulls = (await admin.query('SELECT count(*)::int AS n FROM payesh_direct.record WHERE seq IS NULL')).rows[0].n;
      eq(nulls, 0, 'every existing row back in the feed');
      return `down ⇒ sync objects gone, ${n0} records + ${k0} grants kept; up ⇒ feed re-numbered`;
    });
  } finally {
    if (api) await api.end().catch(() => {});
    if (admin) await admin.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    await root.end().catch(() => {});
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n# passed=${passed} failed=${failed} negative_controls=${negatives} mutants_killed=${mutantsKilled}`);
  console.log(failed ? `DIRECT-SYNC-108-FAIL ${failures.join(',')}` : 'DIRECT-SYNC-108-OK');
  return { passed, failed, negatives, mutantsKilled, failures };
}

if (require.main === module) {
  main().then(r => { if (r.failed) { console.log('row 108 failures: ' + r.failures.join(',')); process.exit(1); } })
    .catch(e => { console.error(e); process.exit(1); });
}
module.exports = { main };
