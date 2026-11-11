'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 66 — Directory bootstrap: school code → cell, TTL cache, re-route.
   Real PostgreSQL (three databases: central directory, cell A, cell B), two real
   Gateways bound to their cell (GW_CELL), the real transfer tool (row 54) and the
   reference client tools/directory-client-66.mjs.

   DIR-01..03  public API: exact fields, no other school's data, identical 404 for
               unknown/malformed codes (no enumeration), per-address rate limit 429.
   DIR-04      client honours the TTL (no network inside it, one call after it).
   DIR-05..09  a school is moved A → B while the client keeps writing:
               writes held while frozen/migrating, re-route on `moved`, old-cell token
               refused by B (wrong_cell), every op exactly once in B, nothing lost.

   Needs PAYESH_PG_ADMIN (superuser URL to any DB; the test creates its own DBs).
   Run: node tests/directory-66.js
   ═══════════════════════════════════════════════════════════════════ */
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = process.env.PAYESH_PG_ADMIN || '';
if (!ADMIN) { console.log('BLOCKED — PAYESH_PG_ADMIN not set'); process.exit(3); }
const tenancy = require(path.join(ROOT, 'server/tenancy.js'));
const directory = require(path.join(ROOT, 'server/directory.js'));
const transfer = require(path.join(ROOT, 'server/transfer.js'));
const { Client } = require('pg');

let PASS = 0, FAIL = 0; const failures = [];
async function check(id, name, fn) {
  try { const d = await fn(); PASS++; console.log(`PASS  ${id}  ${name}${d ? '  → ' + d : ''}`); }
  catch (e) { FAIL++; failures.push(id); console.log(`FAIL  ${id}  ${name}  → ${String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 400)}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function dbUrl(name, user) {
  const u = new URL(ADMIN); u.pathname = '/' + name; if (user) { u.username = user; u.password = ''; } return u.toString();
}
const children = [];
function startGateway(port, env) {
  const c = spawn(process.execPath, ['server/gateway.js'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', PAYESH_LOG: '0', GW_QUOTA_MAX: '100000' }, env),
  });
  c.__log = ''; c.stderr.on('data', d => { c.__log += String(d); });
  children.push(c);
  return c;
}
async function waitUp(port) {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return; } catch (e) { /* retry */ }
    await sleep(100);
  }
  throw new Error('gateway ' + port + ' did not start');
}

(async () => {
  const { DirectoryClient, CellSyncClient } = await import(path.join(ROOT, 'tools/directory-client-66.mjs'));
  const suffix = String(process.pid);
  const DBS = { dir: 'payesh_d66_dir_' + suffix, a: 'payesh_d66_a_' + suffix, b: 'payesh_d66_b_' + suffix };
  const root = new Client({ connectionString: ADMIN }); await root.connect();
  for (const d of Object.values(DBS)) await root.query(`create database ${d}`);
  const dirC = new Client({ connectionString: dbUrl(DBS.dir) }); await dirC.connect();
  const aC = new Client({ connectionString: dbUrl(DBS.a) }); await aC.connect();
  const bC = new Client({ connectionString: dbUrl(DBS.b) }); await bC.connect();
  try {
    await directory.migrate(dirC);
    await tenancy.migrate(aC); await tenancy.migrate(bC);
    await transfer.ensureTables(aC); await transfer.ensureTables(bC);

    const SECRET = 'd66-' + crypto.randomBytes(16).toString('hex');
    const CELL_A = '66666666-aaaa-4aaa-8aaa-000000000066';
    const CELL_B = '66666666-bbbb-4bbb-8bbb-000000000066';
    const TENANT = crypto.randomUUID();
    const [PA, PB, PR] = [await freePort(), await freePort(), await freePort()];
    const common = { GW_SECRET: SECRET, PAYESH_DIRECTORY_PGURL: dbUrl(DBS.dir), DIR_CACHE_TTL_SEC: '0',
      PAYESH_DIR_CLIENT_TTL_SEC: '2', PAYESH_DIR_MIGRATING_TTL_SEC: '1', PAYESH_DIR_MOVED_TTL_SEC: '1',
      PAYESH_DIR_RATE_MAX: '100000', PAYESH_CELL_TRANSFER_ENABLED: '1' };
    startGateway(PA, Object.assign({}, common, { PGURL: dbUrl(DBS.a, 'payesh_runtime'), GW_CELL: CELL_A, GW_INSTANCE: 'gw-a' }));
    startGateway(PB, Object.assign({}, common, { PGURL: dbUrl(DBS.b, 'payesh_runtime'), GW_CELL: CELL_B, GW_INSTANCE: 'gw-b' }));
    /* directory-only instance with a tight rate limit (no cell DB at all) */
    startGateway(PR, { GW_SECRET: SECRET, PAYESH_DIRECTORY_PGURL: dbUrl(DBS.dir), PAYESH_DIR_RATE_MAX: '5', PAYESH_DIR_RATE_WINDOW_SEC: '60', GW_INSTANCE: 'gw-rate' });
    await Promise.all([waitUp(PA), waitUp(PB), waitUp(PR)]);
    const URL_A = `http://127.0.0.1:${PA}`, URL_B = `http://127.0.0.1:${PB}`, URL_R = `http://127.0.0.1:${PR}`;

    await directory.upsertCell(dirC, { cellId: CELL_A, name: 'A', baseUrl: URL_A });
    await directory.upsertCell(dirC, { cellId: CELL_B, name: 'B', baseUrl: URL_B });
    await directory.upsertRoute(dirC, { schoolCode: 'school-66', cellId: CELL_A });
    await directory.upsertRoute(dirC, { schoolCode: 'other-66', cellId: CELL_B });

    await check('DIR-01', 'resolve returns exactly the contract fields of the asked school, nothing about others', async () => {
      const r = await fetch(URL_A + '/api/dir/v1/resolve?school_code=school-66');
      const j = await r.json();
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(Object.keys(j).sort(), ['cell_id', 'cell_url', 'migration_state', 'ok', 'schema_version', 'school_code', 'stale', 'ttl', 'version']);
      assert.strictEqual(j.cell_url, URL_A); assert.strictEqual(j.migration_state, 'stable'); assert.strictEqual(j.version, 1); assert.strictEqual(j.ttl, 2);
      assert.ok(!JSON.stringify(j).includes('other-66') && !JSON.stringify(j).includes(CELL_B), 'other school leaked');
      return JSON.stringify(j);
    });
    await check('DIR-02', 'no enumeration oracle: unknown, malformed, empty and injection codes → same 404 body', async () => {
      const bodies = [];
      for (const q of ['no-such-66', 'x', "' or 1=1 --", '', '%00', 'A'.repeat(41)]) {
        const r = await fetch(URL_A + '/api/dir/v1/resolve?school_code=' + encodeURIComponent(q));
        assert.strictEqual(r.status, 404, 'code ' + JSON.stringify(q));
        bodies.push(await r.text());
      }
      assert.strictEqual(new Set(bodies).size, 1, 'responses differ: ' + bodies.join(' | '));
      return bodies[0];
    });
    await check('DIR-03', 'rate limit per client address: 6th call → 429 + Retry-After, body has retry_after_ms', async () => {
      const st = [];
      let last = null;
      for (let i = 0; i < 6; i++) { last = await fetch(URL_R + '/api/dir/v1/resolve?school_code=school-66'); st.push(last.status); }
      assert.deepStrictEqual(st, [200, 200, 200, 200, 200, 429]);
      const j = await last.json();
      assert.strictEqual(j.error, 'rate_limited');
      assert.ok(Number(last.headers.get('retry-after')) >= 1, 'Retry-After header');
      assert.ok(j.retry_after_ms > 0);
      const unknown = await fetch(URL_R + '/api/dir/v1/resolve?school_code=no-such-66');
      assert.strictEqual(unknown.status, 429, 'enumeration attempts are throttled too');
      return st.join(',');
    });
    await check('DIR-04', 'reference client honours TTL: inside TTL no network, after TTL exactly one call', async () => {
      let t = 1_000_000;
      const dc = new DirectoryClient({ directoryUrl: URL_A, now: () => t });
      await dc.resolve('school-66'); await dc.resolve('school-66'); await dc.resolve('SCHOOL-66');
      assert.deepStrictEqual([dc.stats.network, dc.stats.cache_hits], [1, 2]);
      t += 1999; await dc.resolve('school-66');
      assert.strictEqual(dc.stats.network, 1, 'still inside ttl=2s');
      t += 2; await dc.resolve('school-66');
      assert.strictEqual(dc.stats.network, 2, 'expired → one new call');
      return `network=${dc.stats.network} hits=${dc.stats.cache_hits}`;
    });

    /* ── move school-66 from A to B while a client keeps writing ── */
    const tokenFor = async (route) => tenancy.signToken({ tid: TENANT, cell: route.cell_id, role: 'manager', uid: 1, did: 'dev-66', iat: Date.now(), exp: Date.now() + 600000 }, SECRET);
    const dc = new DirectoryClient({ directoryUrl: URL_A });
    const cli = new CellSyncClient({ dir: dc, schoolCode: 'school-66', tokenFor });
    const op = (i, v = 'v1') => ({ uid: 'd66-op-' + i, collection: 'homework', id: i, type: 'put', data: { title: 'h' + i, v } });
    const tokenA = await tokenFor({ cell_id: CELL_A });

    await check('DIR-05', 'before the move: 20 ops land in cell A', async () => {
      for (let i = 1; i <= 20; i++) cli.enqueue(op(i));
      const r = await cli.flush();
      assert.strictEqual(r.counts.applied, 20); assert.strictEqual(r.cell_id, CELL_A); assert.strictEqual(cli.outbox.length, 0);
    });
    await check('DIR-06', 'transfer starts (freeze A + migrating): client writes are HELD, never dropped', async () => {
      await transfer.freeze(aC, TENANT, { reason: 'dir-66', by: 'test' });
      await directory.setMigrationState(dirC, 'school-66', 'migrating');
      for (let i = 21; i <= 30; i++) cli.enqueue(op(i));
      cli.enqueue(op(15));                                  /* a retry of an op A already has */
      const first = await cli.flush();                      /* cached stable route → A answers 409 write_frozen */
      assert.ok(first.held && first.reason === 'write_frozen', JSON.stringify(first));
      const second = await cli.flush();                     /* re-resolved → migrating → hold without pushing */
      assert.ok(second.held && second.reason === 'migrating', JSON.stringify(second));
      assert.strictEqual(cli.outbox.length, 11, 'outbox kept intact');
      return `${first.reason} → ${second.reason}, outbox=${cli.outbox.length}`;
    });
    await check('DIR-07', 'real transfer tool copies A → B with 3-layer reconciliation; route flips to B (moved, version+)', async () => {
      const r = spawnSync(process.execPath, ['tools/cell-transfer-54.mjs', '--transfer', '--tenant', TENANT, '--from', dbUrl(DBS.a), '--to', dbUrl(DBS.b)], {
        cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { PAYESH_CELL_TRANSFER_ENABLED: '1' }),
      });
      assert.ok(/CELL-TRANSFER-54-OK/.test(r.stdout), 'transfer failed: ' + (r.stdout + r.stderr).slice(-400));
      const before = await (await fetch(URL_A + '/api/dir/v1/resolve?school_code=school-66')).json();
      const moved = await directory.upsertRoute(dirC, { schoolCode: 'school-66', cellId: CELL_B, migrationState: 'moved' });
      assert.ok(moved.version > before.version, 'version must increase on move');
      return `version ${before.version} → ${moved.version}`;
    });
    await check('DIR-08', 'after the move: client re-routes to B; held ops applied once, retry is a duplicate; A token refused by B', async () => {
      await sleep(1100);                                    /* migrating ttl = 1s */
      const r = await cli.flush();
      assert.strictEqual(r.cell_id, CELL_B, JSON.stringify(r));
      assert.deepStrictEqual(r.counts, { applied: 10, duplicates: 1, conflicts: 0 });
      assert.strictEqual(cli.outbox.length, 0);
      const wrong = await fetch(URL_B + '/api/gw/v1/pull?since_seq=0', { headers: { authorization: 'Bearer ' + tokenA } });
      assert.strictEqual(wrong.status, 403);
      assert.strictEqual((await wrong.json()).error, 'wrong_cell');
      return JSON.stringify(r.counts);
    });
    await check('DIR-09', 'B holds every op exactly once (30 records, no duplicate seq); A received nothing after the freeze', async () => {
      const { rows, cell_id } = await cli.pullAll();
      assert.strictEqual(cell_id, CELL_B);
      const ids = rows.map(x => x.id);
      assert.strictEqual(new Set(rows.map(x => x.seq)).size, rows.length, 'duplicate seq');
      assert.strictEqual(new Set(ids).size, 30, 'distinct records=' + new Set(ids).size);
      for (let i = 1; i <= 30; i++) assert.ok(ids.includes(i), 'record ' + i + ' lost');
      assert.strictEqual(rows.length, 30, 'rows=' + rows.length + ' (a re-applied op would add a feed row)');
      const aCount = await aC.query(`select count(*)::int n from ${tenancy.OPS_TABLE} where tenant_id = $1`, [TENANT]);
      assert.strictEqual(aCount.rows[0].n, 20, 'cell A ops after freeze');
      return `B rows=${rows.length} distinct=${new Set(ids).size}; A ops=${aCount.rows[0].n}`;
    });
    await check('DIR-10', 'route back to stable bumps version again; disabled cell → 503 cell_unavailable (no data)', async () => {
      const s = await directory.setMigrationState(dirC, 'school-66', 'stable');
      const r = await (await fetch(URL_A + '/api/dir/v1/resolve?school_code=school-66')).json();
      assert.strictEqual(r.version, s.version); assert.strictEqual(r.migration_state, 'stable'); assert.strictEqual(r.cell_url, URL_B);
      await directory.upsertCell(dirC, { cellId: CELL_B, name: 'B', status: 'disabled' });
      const d = await fetch(URL_A + '/api/dir/v1/resolve?school_code=school-66');
      assert.strictEqual(d.status, 503);
      assert.deepStrictEqual(await d.json(), { ok: false, error: 'cell_unavailable' });
      return 'version=' + r.version;
    });
  } catch (e) {
    FAIL++; failures.push('DIR-CRASH'); console.log('FAIL  DIR-CRASH  ' + (e && e.stack || e));
  } finally {
    for (const c of children) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }
    await Promise.all([dirC.end(), aC.end(), bC.end()]).catch(() => {});
    await sleep(300);
    for (const d of Object.values(DBS)) await root.query(`drop database if exists ${d} with (force)`).catch(() => {});
    await root.end();
  }
  console.log(`\nDIR checks=${PASS + FAIL} pass=${PASS} fail=${FAIL}`);
  if (FAIL) { console.log('DIRECTORY-66-FAIL ' + failures.join(',')); process.exit(1); }
  console.log('DIRECTORY-66-OK');
  process.exit(0);
})();
