'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 80 — opt-in error reports / telemetry without PII.   TM-01 .. TM-14
   Contract docs/cloud/contracts/telemetry-v1.schema.json · client/telemetry.js
   · db/migrations/direct/0007_direct_telemetry · docs/security/80-telemetry.md

   AC (Notion row 80):
     • event schema = field allowlist, no national_id / name / phone   TM-01, TM-02
     • NEGATIVE: adding a PII field ⇒ red                              TM-03 (+ TM-12 mutant)
     • server ingest with a rate limit                                 TM-08 .. TM-11
     • opt-in consent; sent over the direct transport (row 110), not the
       Gateway                                                         TM-04 .. TM-07, TM-13

   Static + client parts always run. The ingest part needs PostgreSQL:
     PAYESH_PG_ADMIN=postgres://postgres@127.0.0.1:5432/payesh_c64 node tests/telemetry-80.js
   (TM80_REQUIRE_PG=1 turns "no PG" into a failure, as in CI)
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const T = require(path.join(ROOT, 'client/telemetry.js'));
const P = require(path.join(ROOT, 'client/provider-postgrest.js'));
const SCHEMA_PATH = 'docs/cloud/contracts/telemetry-v1.schema.json';
const SQL_PATH = 'db/migrations/direct/0007_direct_telemetry.up.sql';
const OWN = '0007_direct_telemetry';

let passed = 0, failed = 0;
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; console.log(`FAIL  ${id}  ${desc}  → ${String((e && (e.code ? e.code + ' ' : '') + e.message) || e).slice(0, 400)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

/* field names that must never be telemetry fields (exact or as a part of a snake_case name) */
const PII_WORDS = ['national', 'nid', 'name', 'phone', 'mobile', 'email', 'mail', 'address', 'user', 'student', 'parent',
  'teacher', 'birth', 'shenasname', 'message', 'stack', 'text', 'ip', 'device', 'tenant', 'school', 'token', 'password', 'location', 'lat', 'lng'];
function piiFields(fields) {
  return fields.filter(f => f.split(/[_.-]/).some(part => PII_WORDS.includes(part.toLowerCase())) || PII_WORDS.includes(f.toLowerCase()));
}

/* the allowlist as each layer declares it */
function layers(src) {
  const schema = JSON.parse(src.schema);
  const m = src.sql.match(/allowed constant text\[\] := ARRAY\[([^\]]*)\]/);
  if (!m) throw new Error('allowlist missing in ' + SQL_PATH);
  const sqlAllowed = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  const cm = src.client.match(/const ALLOWED = Object\.freeze\(\[([^\]]*)\]\)/);
  if (!cm) throw new Error('ALLOWED missing in client/telemetry.js');
  const clientAllowed = [...cm[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  return { schema, schemaFields: Object.keys(schema.properties || {}), sqlAllowed, clientAllowed };
}
const RULE = {
  /* TM-01/02: same closed allowlist in all three layers, schema closed */
  allowlist(src) {
    const L = layers(src);
    if (L.schema.additionalProperties !== false) throw new Error('schema must be closed (additionalProperties: false)');
    const s = [...L.schemaFields].sort(), q = [...L.sqlAllowed].sort(), c = [...L.clientAllowed].sort();
    if (JSON.stringify(s) !== JSON.stringify(q) || JSON.stringify(s) !== JSON.stringify(c)) {
      throw new Error(`allowlists differ: schema=${s} sql=${q} client=${c}`);
    }
    return s;
  },
  /* TM-03: no PII-like field anywhere (and the stored table has no free column) */
  noPII(src) {
    const L = layers(src);
    const bad = piiFields([...new Set([...L.schemaFields, ...L.sqlAllowed, ...L.clientAllowed])]);
    if (bad.length) throw new Error('PII-like telemetry fields: ' + bad.join(','));
    const table = src.sql.match(/CREATE TABLE IF NOT EXISTS payesh_direct\.telemetry_event \(([\s\S]*?)\n\);/);
    if (!table) throw new Error('telemetry_event table missing');
    const cols = [...table[1].matchAll(/^\s+([a-z_]+)\s+/gm)].map(x => x[1]);
    const free = cols.filter(c => /jsonb|json\b/.test(table[1].split('\n').find(l => l.trim().startsWith(c + ' ')) || ''));
    if (free.length) throw new Error('free-form (json) column in telemetry_event: ' + free.join(','));
    const badCols = piiFields(cols.filter(c => !['id', 'tenant_id', 'device_id', 'received_at'].includes(c)));
    if (badCols.length) throw new Error('PII-like telemetry_event columns: ' + badCols.join(','));
    return `fields=${L.schemaFields.length} columns=${cols.length}`;
  },
};

async function staticAndClient() {
  const src = { schema: fs.readFileSync(path.join(ROOT, SCHEMA_PATH), 'utf8'), sql: fs.readFileSync(path.join(ROOT, SQL_PATH), 'utf8'), client: fs.readFileSync(path.join(ROOT, 'client/telemetry.js'), 'utf8') };
  await check('TM-01', 'one closed field allowlist: schema (additionalProperties:false) = SQL telemetry_ingest = client/telemetry.js', () => RULE.allowlist(src).join(','));
  await check('TM-02', 'no national_id / name / phone (or any PII-like) field, and the stored table has no free-form column', () => RULE.noPII(src));
  await check('TM-03', 'NEGATIVE: adding a PII field to any layer turns the gate red (6 mutants)', () => {
    const muts = [
      ['allowlist+noPII', s => Object.assign({}, s, { schema: s.schema.replace('"v": { "const": 1 },', '"v": { "const": 1 }, "national_id": { "type": "string" },') })],
      ['noPII', s => Object.assign({}, s, { schema: s.schema.replace('"v": { "const": 1 },', '"v": { "const": 1 }, "student_name": { "type": "string" },'), sql: s.sql.replace("ARRAY['v',", "ARRAY['student_name', 'v',"), client: s.client.replace("Object.freeze(['v',", "Object.freeze(['student_name', 'v',") })],
      ['noPII', s => Object.assign({}, s, { schema: s.schema.replace('"v": { "const": 1 },', '"v": { "const": 1 }, "phone": { "type": "string" },'), sql: s.sql.replace("ARRAY['v',", "ARRAY['phone', 'v',"), client: s.client.replace("Object.freeze(['v',", "Object.freeze(['phone', 'v',") })],
      ['allowlist', s => Object.assign({}, s, { sql: s.sql.replace("ARRAY['v',", "ARRAY['message', 'v',") })],
      ['allowlist', s => Object.assign({}, s, { schema: s.schema.replace('"additionalProperties": false', '"additionalProperties": true') })],
      ['noPII', s => Object.assign({}, s, { sql: s.sql.replace('  duration_ms integer\n);', '  duration_ms integer,\n  extra jsonb\n);') })],
    ];
    let red = 0;
    for (const [rules, mut] of muts) {
      const m = mut(src);
      const hit = rules.split('+').some(r => { try { RULE[r](m); return false; } catch (e) { return true; } });
      if (!hit) throw new Error('mutant not caught: ' + rules);
      red++;
    }
    return `${red}/${muts.length} red`;
  });
  await check('TM-04', 'client: no consent ⇒ nothing recorded or sent (default OFF); revoking consent drops the queue', async () => {
    const store = new Map();
    const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
    const calls = [];
    const r = new T.TelemetryReporter({ provider: { rpc: async (...a) => calls.push(a) }, storage });
    eq(r.record({ type: 'error', code: 'sync.push_failed' }), null, 'no consent → dropped');
    eq((await r.flush()).reason, 'no_consent', 'flush without consent');
    r.setConsent(true);
    assert(r.record({ type: 'error', code: 'sync.push_failed' }), 'consented → recorded');
    r.setConsent(false);
    eq(r.queue.length, 0, 'revoked → queue dropped');
    eq(calls.length, 0, 'nothing ever sent');
  });
  await check('TM-05', 'client: events are REBUILT from allowlisted fields — message, stack, name, national_id, phone never copied; PII-shaped values dropped', () => {
    const ev = T.toEvent({ type: 'error', code: 'db.timeout', platform: 'web', where: 'sync.push', message: 'student Ali 0012345678 failed', stack: 'at x', name: 'علی', national_id: '0012345678', phone: '09121234567', user_id: 7 });
    eq(Object.keys(ev).sort(), ['code', 'platform', 'type', 'v', 'where'], 'only allowlisted keys');
    eq(T.toEvent({ type: 'error', code: 'nid0012345678', platform: 'web' }), null, '7+ digits in code → dropped');
    eq(T.toEvent({ type: 'error', code: 'a@b', platform: 'web' }), null, 'e-mail shape → dropped');
    eq(T.toEvent({ type: 'error', code: 'ok', platform: 'web', where: 'user 09121234567' }).where, undefined, 'PII-shaped where removed');
    eq(T.toEvent({ type: 'chat', code: 'x', platform: 'web' }), null, 'unknown type → dropped');
    const fe = T.fromError(Object.assign(new Error('national id 0012345678 is wrong'), { code: 'forbidden' }), { where: 'login', platform: 'android' });
    eq(fe, { v: 1, type: 'error', code: 'forbidden', platform: 'android', where: 'login' }, 'Error → code only, never the message');
  });
  await check('TM-06', 'client: sent ONLY through the direct provider (rpc telemetry_ingest, consent=true); no direct provider ⇒ nothing; ≤20 per batch, ≤60 per hour', async () => {
    const store = new Map([[T.CONSENT_KEY, '1']]);
    const storage = { getItem: k => store.get(k) || null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
    eq((await new T.TelemetryReporter({ storage }).flush()).reason, 'no_direct_transport', 'no provider');
    const calls = [];
    let now = 1e12;
    const r = new T.TelemetryReporter({ provider: { rpc: async (fn, args) => { calls.push([fn, JSON.parse(args[0]).length, args[1]]); return { accepted: 1 }; } }, storage, now: () => now });
    for (let i = 0; i < 90; i++) r.record({ type: 'perf', code: 'sync.pull', duration_ms: i });
    const sent = [];
    for (let i = 0; i < 5; i++) sent.push((await r.flush()).sent);
    eq(sent, [20, 20, 20, 0, 0], 'batches then hourly cap');
    eq(calls.map(c => c[0] + ':' + c[2]), ['telemetry_ingest:true', 'telemetry_ingest:true', 'telemetry_ingest:true'], 'rpc + consent flag');
    now += 3600001;
    eq((await r.flush()).sent, 20, 'next hour');
    const src = fs.readFileSync(path.join(ROOT, 'client/telemetry.js'), 'utf8');
    assert(!/\/api\/gw|gateway|fetch\(/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'no Gateway route / own fetch in client/telemetry.js');
    return `sent=${sent.join('/')}`;
  });
  await check('TM-07', 'PostgREST provider allowlists telemetry_ingest(p_events, p_consent) and sends events as JSON (not text)', async () => {
    eq(P.RPC_PARAMS.telemetry_ingest, ['p_events', 'p_consent'], 'rpc params');
    eq(P.namedArgs('telemetry_ingest', [JSON.stringify([{ v: 1 }]), true]), { p_events: [{ v: 1 }], p_consent: true }, 'named args');
  });
}

function withDb(url, db, user) { const u = new URL(url); u.pathname = '/' + db; if (user) { u.username = user; u.password = ''; } return u.toString(); }

async function ingest() {
  const ADMIN = process.env.PAYESH_PG_ADMIN;
  if (!ADMIN) {
    if (process.env.TM80_REQUIRE_PG === '1') { failed++; console.log('FAIL  TM-PG  PAYESH_PG_ADMIN is required (TM80_REQUIRE_PG=1)'); return; }
    console.log('SKIP  TM-08..TM-14 need PostgreSQL (set PAYESH_PG_ADMIN)');
    return;
  }
  const { Pool, Client } = require('pg');
  const DB = `payesh_t80_${process.pid}_${Date.now().toString(36)}`;
  const AUTH = 'payesh_t80_authenticator';
  const root = new Client({ connectionString: ADMIN }); root.on('error', () => {});
  await root.connect();
  await root.query(`CREATE DATABASE ${DB}`);
  await root.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${AUTH}') THEN
    CREATE ROLE ${AUTH} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$`);
  const DB_URL = withDb(ADMIN, DB);
  let admin = null, auth = null;
  try {
    const up = spawnSync(process.execPath, [path.join(ROOT, 'tools/migrate-86.mjs'), 'up', '--dir', 'db/migrations/direct', '--to', OWN], { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { PAYESH_MIGRATE_URL: DB_URL }) });
    if (up.status !== 0) throw new Error('migrate up: ' + up.stdout + up.stderr);
    admin = new Pool({ connectionString: DB_URL, max: 3 }); admin.on('error', () => {});
    await admin.query(`GRANT payesh_direct_client TO ${AUTH}`);
    auth = new Pool({ connectionString: withDb(ADMIN, DB, AUTH), max: 3 }); auth.on('error', () => {});

    /* PostgREST-style request: one transaction, SET LOCAL ROLE + claims; `ddl` runs first as the authenticator owner (mutants use admin) */
    async function request(claims, fn, { keep = true, pool = auth, pre = null } = {}) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        if (pre) await c.query(pre);
        await c.query('SET LOCAL ROLE payesh_direct_client');
        if (claims) await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        const r = await fn(c);
        await c.query(keep ? 'COMMIT' : 'ROLLBACK');
        return r;
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    }
    /* a provider with the same rpc() contract as client/provider-postgrest.js, over pg */
    const providerFor = (claims, opts) => ({
      rpc: (fn, args) => request(claims, async (c) => {
        const names = P.RPC_PARAMS[fn];
        if (!names) throw new Error('rpc_not_allowed');
        const body = P.namedArgs(fn, args);
        const r = await c.query(`SELECT payesh_direct.telemetry_ingest($1::jsonb, $2) AS r`, [JSON.stringify(body.p_events), body.p_consent]);
        return r.rows[0].r;
      }, opts),
    });
    const school = async (tag) => {
      const t = crypto.randomUUID();
      const sub = `sub-t80-${tag}-${t.slice(0, 8)}`;
      const r = await admin.query('SELECT * FROM payesh_direct.bootstrap_school($1, $2, $3, $4)', [t, 'mgr-' + tag, sub, 'phone']);
      return { tenant: t, claims: { sub, device_id: r.rows[0].device_id } };
    };
    const A = await school('a'), B = await school('b');
    const call = (who, events, consent = true) => request(who.claims, c => c.query('SELECT payesh_direct.telemetry_ingest($1::jsonb, $2) AS r', [JSON.stringify(events), consent]).then(x => x.rows[0].r));
    const refused = async (p, code) => { try { await p; } catch (e) { if (String(e.message) === code) return e; throw new Error(`expected ${code}, got ${e.message}`); } throw new Error(`expected ${code}, got success`); };
    const good = { v: 1, type: 'error', code: 'sync.push_failed', where: 'sync.push', platform: 'android', app_version: '0.9.2', count: 1 };

    await check('TM-08', 'ingest: valid events stored in typed columns; tenant + device come from the token, not the event', async () => {
      const r = await call(A, [good, { v: 1, type: 'perf', code: 'sync.pull', platform: 'windows', duration_ms: 420 }]);
      eq(r, { accepted: 2 }, 'accepted');
      const rows = (await admin.query('SELECT tenant_id, device_id, type, code, where_ref, platform, duration_ms FROM payesh_direct.telemetry_event ORDER BY id')).rows;
      eq(rows.map(x => [x.tenant_id, x.device_id, x.type, x.code]), [[A.tenant, A.claims.device_id, 'error', 'sync.push_failed'], [A.tenant, A.claims.device_id, 'perf', 'sync.pull']], 'stored');
      return `stored=${rows.length}`;
    });
    await check('TM-09', 'NEGATIVE ingest: a PII field (national_id / name / phone / tenant_id / message) refuses the WHOLE batch; PII-shaped values refused', async () => {
      const before = Number((await admin.query('SELECT count(*) n FROM payesh_direct.telemetry_event')).rows[0].n);
      for (const k of ['national_id', 'name', 'phone', 'tenant_id', 'message', 'student_id']) {
        const e = await refused(call(A, [good, Object.assign({}, good, { [k]: 'x' })]), 'field_not_allowed');
        eq(e.detail, k, 'detail names the field');
      }
      await refused(call(A, [Object.assign({}, good, { code: 'nid0012345678' })]), 'pii_suspected');
      await refused(call(A, [Object.assign({}, good, { where: 'a@b.c' })]), 'pii_suspected');
      await refused(call(A, [Object.assign({}, good, { where: 'ali reza' })]), 'pii_suspected');
      await refused(call(A, [Object.assign({}, good, { count: '12' })]), 'bad_value');
      await refused(call(A, [Object.assign({}, good, { type: 'chat' })]), 'bad_value');
      const after = Number((await admin.query('SELECT count(*) n FROM payesh_direct.telemetry_event')).rows[0].n);
      eq(after, before, 'nothing stored from refused batches');
      return '11 refusals, 0 rows';
    });
    await check('TM-10', 'consent + identity: p_consent=false refused; no token / unknown device refused', async () => {
      await refused(call(A, [good], false), 'consent_required');
      await refused(call(A, [good], null), 'consent_required');
      await refused(request(null, c => c.query('SELECT payesh_direct.telemetry_ingest($1::jsonb, true)', [JSON.stringify([good])])), 'not_authenticated');
      await refused(call({ claims: { sub: A.claims.sub, device_id: crypto.randomUUID() } }, [good]), 'not_authenticated');
    });
    await check('TM-11', 'rate limit: ≤20 per call; per device 60/hour (61st refused, batch atomic); another device / school unaffected; window reset', async () => {
      await refused(call(B, Array(21).fill(good)), 'too_many_events');
      eq(await call(B, Array(20).fill(good)), { accepted: 20 }, '20');
      eq(await call(B, Array(20).fill(good)), { accepted: 20 }, '40');
      eq(await call(B, Array(20).fill(good)), { accepted: 20 }, '60');
      const e = await refused(call(B, [good]), 'telemetry_rate_limited');
      assert(/device limit 60 per 3600 s/.test(e.detail), 'detail: ' + e.detail);
      eq(await call(A, [good]), { accepted: 1 }, 'school A unaffected');
      await admin.query(`UPDATE payesh_direct.telemetry_usage SET window_start = now() - interval '2 hours' WHERE tenant_id = $1`, [B.tenant]);
      eq(await call(B, [good]), { accepted: 1 }, 'after the window');
      return 'device cap 60/h; school cap 2000/h';
    });
    await check('TM-12', 'clients cannot read or write telemetry tables directly; the only client RPC added is telemetry_ingest', async () => {
      for (const sql of ['SELECT * FROM payesh_direct.telemetry_event', 'SELECT * FROM payesh_direct.telemetry_usage',
        `INSERT INTO payesh_direct.telemetry_event (tenant_id, device_id) VALUES ('${A.tenant}', '${A.claims.device_id}')`,
        `UPDATE payesh_direct.telemetry_usage SET n = 0 WHERE true`]) {
        let denied = false;
        try { await request(A.claims, c => c.query(sql), { keep: false }); } catch (e) { denied = /permission denied/.test(e.message); }
        assert(denied, 'not denied: ' + sql);
      }
      const f = await admin.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'payesh_direct' AND p.proname LIKE 'telemetry%' AND has_function_privilege('payesh_direct_client', p.oid, 'EXECUTE')`);
      eq(f.rows.map(r => r.proname), ['telemetry_ingest'], 'client-executable telemetry functions');
    });
    await check('TM-13', 'end to end: client/telemetry.js → provider.rpc → telemetry_ingest; an Error with a national id in its message stores only the code', async () => {
      const store = new Map([[T.CONSENT_KEY, '1']]);
      const r = new T.TelemetryReporter({ provider: providerFor(A.claims), storage: { getItem: k => store.get(k) || null, setItem() {}, removeItem() {} }, defaults: { platform: 'web', app_version: '0.9.2' } });
      r.record(Object.assign(new Error('دانش‌آموز ۰۰۱۲۳۴۵۶۷۸ — 0012345678 not found'), { code: 'not_found' }));
      r.record({ type: 'sync_failure', code: 'network', where: 'sync.pull', national_id: '0012345678', phone: '09121234567' });
      eq(await r.flush(), { sent: 2 }, 'flushed');
      const dump = JSON.stringify((await admin.query(`SELECT * FROM payesh_direct.telemetry_event WHERE tenant_id = $1`, [A.tenant])).rows);
      assert(!dump.includes('0012345678') && !dump.includes('09121234567') && !dump.includes('۰۰۱۲'), 'no PII in the table');
      assert(dump.includes('"not_found"') && dump.includes('"network"'), 'codes stored');
    });
    await check('TM-14', 'mutant: without the allowlist check in telemetry_ingest a national_id event is ACCEPTED (control is load-bearing); down migration removes everything', async () => {
      const def = (await admin.query(`SELECT pg_get_functiondef('payesh_direct.telemetry_ingest(jsonb,boolean)'::regprocedure) AS d`)).rows[0].d;
      const anchor = 'IF NOT (k = ANY (allowed)) THEN';
      assert(def.includes(anchor), 'anchor');
      const mutant = def.replace(anchor, 'IF false THEN');
      const c = await admin.connect();
      let accepted = null;
      try {
        await c.query('BEGIN');
        await c.query(mutant);
        await c.query('SET LOCAL ROLE payesh_direct_client');
        await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(A.claims)]);
        accepted = (await c.query('SELECT payesh_direct.telemetry_ingest($1::jsonb, true) AS r', [JSON.stringify([Object.assign({}, good, { national_id: 'x' })])])).rows[0].r;
      } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
      eq(accepted, { accepted: 1 }, 'mutant accepts the PII field');
      await refused(call(A, [Object.assign({}, good, { national_id: 'x' })]), 'field_not_allowed');
      const down = spawnSync(process.execPath, [path.join(ROOT, 'tools/migrate-86.mjs'), 'rollback', '--dir', 'db/migrations/direct', '--to', '0006_direct_rls_initplan'], { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { PAYESH_MIGRATE_URL: DB_URL }) });
      assert(down.status === 0, 'rollback: ' + down.stdout + down.stderr);
      const left = (await admin.query(`SELECT count(*) n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'payesh_direct' AND c.relname LIKE 'telemetry%'`)).rows[0].n;
      eq(Number(left), 0, 'tables gone after down');
      return 'mutant red, rollback clean';
    });
  } finally {
    if (auth) await auth.end().catch(() => {});
    if (admin) await admin.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    await root.end();
  }
}

(async () => {
  console.log('\nRow 80: telemetry — closed field allowlist, no PII, opt-in, direct-path ingest with rate limit\n');
  await staticAndClient();
  await ingest();
  console.log(`\nchecks=${passed + failed} pass=${passed} fail=${failed}`);
  console.log(failed ? 'TELEMETRY-80-FAILED' : `TELEMETRY-80-OK checks=${passed}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); console.log('TELEMETRY-80-FAILED'); process.exit(1); });
