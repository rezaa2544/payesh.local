/* ═══════════════════════════════════════════════════════════════════
   Row 111 — restore drill on local PostgreSQL (label [S]).
   Called by `node tools/backup-111.mjs drill [--fresh-cluster]`.

   Needs PAYESH_PG_ADMIN (superuser on a local PostgreSQL) and pg_dump /
   pg_restore on PATH (or PAYESH_PG_CLIENT_BIN). --fresh-cluster also needs
   PAYESH_PG_BIN (directory with initdb + postgres): the restore then goes into
   a brand-new cluster where not even the roles exist — the real "provider is
   gone" case. Everything it creates is dropped at the end.

   Every step prints one `DRILL {json}` line; the last line is
   BACKUP-DRILL-111-OK or BACKUP-DRILL-111-FAILED.
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as B from './backup-111.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const e2e = require('./e2e1.js');
const { DirectSync } = require('./direct-sync.js');
const { Client } = require('pg');

const RPC = {
  sync_push: 'SELECT payesh_direct.sync_push($1::jsonb, $2) AS r',
  sync_pull: 'SELECT payesh_direct.sync_pull($1::bigint, $2, $3::text[]) AS r',
  sync_resolve_conflict: 'SELECT payesh_direct.sync_resolve_conflict($1, $2) AS r',
};
const CANARY = 'قناری-پشتیبان-' + crypto.randomBytes(6).toString('hex');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
/* scratch database DDL: the name is generated here and must match the drill pattern */
function dbDdl(verb, db) {
  if (!/^payesh_b111_(src|dst)_[0-9]+_[0-9a-z]+$/.test(db)) throw new Error('refusing database name ' + db);
  return verb === 'CREATE' ? 'CREATE DATABASE ' + db : 'DROP DATABASE IF EXISTS ' + db + ' WITH (FORCE)';
}
const dbUrl = (base, db) => { const u = new URL(base); u.pathname = '/' + db; return u.toString(); };

export async function drill({ freshCluster = false } = {}) {
  const ADMIN = process.env.PAYESH_PG_ADMIN;
  let ok = true;
  const steps = [];
  const log = (step, pass, info) => {
    if (!pass) ok = false;
    const line = Object.assign({ step, pass }, info || {});
    steps.push(line);
    console.log('DRILL ' + JSON.stringify(line));
  };
  const step = async (name, fn) => {
    try { const info = await fn(); log(name, true, info); return info; } catch (e) { log(name, false, { error: e.code || 'error', message: String(e.message).slice(0, 400) }); return null; }
  };
  if (!ADMIN) { console.log('BACKUP-DRILL-111-FAILED (PAYESH_PG_ADMIN not set)'); return false; }
  if (freshCluster && !process.env.PAYESH_PG_BIN) { console.log('BACKUP-DRILL-111-FAILED (--fresh-cluster needs PAYESH_PG_BIN)'); return false; }

  const tag = `${process.pid}_${Date.now().toString(36)}`;
  const SRC = 'payesh_b111_src_' + tag, DST = 'payesh_b111_dst_' + tag;
  const SRC_URL = dbUrl(ADMIN, SRC);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-b111-'));
  const keyDir = path.join(work, 'keys'), outDir = path.join(work, 'backups');
  const root = new Client({ connectionString: dbUrl(ADMIN, 'postgres') }); root.on('error', () => {});
  await root.connect();
  let src = null, cluster = null, dstUrl = null;
  const env0 = { node: process.version, pg_dump: spawnSync(process.env.PAYESH_PG_CLIENT_BIN ? path.join(process.env.PAYESH_PG_CLIENT_BIN, 'pg_dump') : 'pg_dump', ['--version'], { encoding: 'utf8' }).stdout.trim() };
  try {
    /* ── 1. source: migrated direct schema + two schools with real data through the RPCs ── */
    let schools = null;
    const seeded = await step('seed-source', async () => {
      await root.query(dbDdl('CREATE', SRC));
      const m = spawnSync(process.execPath, [path.join(ROOT, 'tools/migrate-86.mjs'), 'up', '--dir', 'db/migrations/direct'], { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { PAYESH_MIGRATE_URL: SRC_URL }) });
      if (m.status !== 0) throw new Error('migrate: ' + (m.stdout + m.stderr).slice(-400));
      src = new Client({ connectionString: SRC_URL }); src.on('error', () => {});
      await src.connect();
      const server_version = (await src.query('SHOW server_version')).rows[0].server_version;
      schools = [];
      for (const label of ['A', 'B']) schools.push(await makeSchool(src, label));
      const [A, Bs] = schools;
      /* A: 40 attendance + 10 homework (one with the canary), a delete, an auto merge and a manual conflict */
      const ops = [];
      for (let i = 1; i <= 40; i++) ops.push({ uid: crypto.randomUUID(), collection: 'attendance', type: 'put', id: i, data: { class_id: 1, student_id: 100 + i, status: i % 5 ? 'present' : 'absent', note: i === 7 ? CANARY : 'n' + i } });
      for (let i = 41; i <= 50; i++) ops.push({ uid: crypto.randomUUID(), collection: 'homework', type: 'put', id: i, data: { title: 'تکلیف ' + i, due: '1405-09-' + String(i - 30).padStart(2, '0') } });
      const r1 = await A.d1.sync.push(ops, 'idem-' + tag);
      if (r1.applied.length !== 50) throw new Error('seed push applied ' + r1.applied.length);
      await A.d2.sync.pull();
      const del = { uid: crypto.randomUUID(), collection: 'homework', type: 'del', id: 50 };
      await A.d1.sync.push([del]);
      await A.d1.sync.push([{ uid: crypto.randomUUID(), collection: 'attendance', type: 'put', id: 1, base_version: 1, data: { class_id: 1, student_id: 101, status: 'late' } }]);
      const c = await A.d2.sync.push([{ uid: crypto.randomUUID(), collection: 'attendance', type: 'put', id: 1, base_version: 1, data: { class_id: 1, student_id: 101, status: 'excused' } }]);
      if (c.conflicts.length !== 1) throw new Error('expected one manual conflict, got ' + c.conflicts.length);
      await Bs.d1.sync.push([1, 2, 3].map(i => ({ uid: crypto.randomUUID(), collection: 'attendance', type: 'put', id: i, data: { class_id: 9, student_id: 900 + i, status: 'present' } })));
      /* what device A1 sees right now = the reference for the restored copy */
      const view = new Map();
      const probe = new DirectSync({ tenant: A.tenant, call: A.d1.call, keyring: A.d1.ring, directory: A.dir });
      await probe.pull((k, doc) => { if (doc) view.set(k, doc); else view.delete(k); });
      A.view = view;
      A.replayUid = ops[3].uid;
      A.conflictRows = (await claimed(src, A.sub, A.d1.id, 'SELECT count(*)::int AS n FROM payesh_direct.sync_conflict', []))[0].n;
      A.maxSeq = Number((await src.query('SELECT max(seq)::bigint AS s FROM payesh_direct.record')).rows[0].s);
      return { db: SRC, server_version, records: Number((await src.query('SELECT count(*)::int AS n FROM payesh_direct.record')).rows[0].n), visible_to_device_A1: view.size, conflicts: 1, tenants: 2 };
    });
    if (!seeded) throw new Error('seed failed');
    const A = schools[0], Bs = schools[1];

    /* ── 2. keys ── */
    let pubRaw, privRaw, kid;
    await step('keygen', async () => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/backup-111.mjs'), 'keygen', '--out-dir', keyDir], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      const pf = path.join(keyDir, 'payesh-backup.pub'), kf = path.join(keyDir, 'payesh-backup.private.key');
      const mode = fs.statSync(kf).mode & 0o777;
      if (mode !== 0o600) throw new Error('private key mode ' + mode.toString(8));
      pubRaw = Buffer.from(fs.readFileSync(pf, 'utf8').trim(), 'base64url');
      privRaw = Buffer.from(fs.readFileSync(kf, 'utf8').split('\n').filter(l => l && !l.startsWith('#'))[0], 'base64url');
      kid = B.kidOf(pubRaw);
      const again = spawnSync(process.execPath, [path.join(ROOT, 'tools/backup-111.mjs'), 'keygen', '--out-dir', keyDir], { encoding: 'utf8' });
      if (again.status === 0) throw new Error('keygen overwrote an existing key');
      return { kid, private_key_mode: '0600', overwrite_refused: true };
    });

    /* ── 3. the backup: CLI, connection string from the environment only ── */
    let file, side;
    await step('dump-encrypted', async () => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/backup-111.mjs'), 'dump', '--pub', path.join(keyDir, 'payesh-backup.pub'), '--out-dir', outDir],
        { encoding: 'utf8', env: Object.assign({}, process.env, { PAYESH_BACKUP_SOURCE_URL: SRC_URL }) });
      if (r.status !== 0) throw new Error(r.stderr || r.stdout);
      const out = JSON.parse(r.stdout.trim().split('\n').pop());
      file = out.file;
      side = JSON.parse(fs.readFileSync(file.replace(/\.e2b$/, '.json'), 'utf8'));
      if (!/^payesh-backup-\d{8}T\d{6}Z\.e2b$/.test(path.basename(file))) throw new Error('name not timestamped: ' + path.basename(file));
      if (r.stdout.includes(SRC_URL) || r.stderr.includes(SRC_URL)) throw new Error('connection string echoed');
      return { file: path.basename(file), bytes: out.size, sha256: out.sha256.slice(0, 16) + '…', dump_ms: out.ms, mode: (fs.statSync(file).mode & 0o777).toString(8), no_partial_left: !fs.readdirSync(outDir).some(f => f.endsWith('.partial')) };
    });

    await step('ciphertext-only-on-disk', async () => {
      const buf = fs.readFileSync(file);
      const sideTxt = fs.readFileSync(file.replace(/\.e2b$/, '.json'), 'utf8');
      const needles = [Buffer.from(CANARY), Buffer.from('PGDMP'), Buffer.from('payesh_direct'), Buffer.from('CREATE TABLE'), Buffer.from(A.tenant), Buffer.from('e2e1.')];
      for (const n of needles) if (buf.includes(n)) throw new Error('backup file contains clear text: ' + n.toString().slice(0, 16));
      for (const s of [SRC_URL, 'postgres://', 'password', A.tenant]) if (sideTxt.includes(s)) throw new Error('sidecar leaks ' + s.slice(0, 12));
      /* positive control: the same scanner on the decrypted parts finds them */
      const parts = [];
      B.openContainer(file, privRaw, (p, d) => { parts[p] = Buffer.concat([parts[p] || Buffer.alloc(0), d]); });
      if (!parts[0].includes(Buffer.from('PGDMP')) || !parts[0].includes(Buffer.from('payesh_direct'))) throw new Error('positive control: decrypted dump lacks PGDMP/schema');
      if (parts[0].includes(Buffer.from(CANARY))) throw new Error('database itself held the canary in clear text (e2e1 broken)');
      return { scanned_needles: needles.length, positive_control: 'PGDMP + schema found after decryption', canary_in_decrypted_dump: false, note: 'records are e2e1 ciphertext even inside the dump (row 107); the backup adds a second layer' };
    });

    await step('status-monitor', async () => {
      const fresh = B.status({ dir: outDir, maxAgeHours: 36 });
      const later = B.status({ dir: outDir, maxAgeHours: 36, now: Date.now() + 40 * 36e5 });
      const empty = B.status({ dir: path.join(work, 'none') });
      if (!fresh.ok || later.ok || later.error !== 'backup_too_old' || empty.ok) throw new Error('status: ' + JSON.stringify({ fresh, later, empty }));
      return { fresh: 'ok', after_40h_without_dump: later.error, empty_dir: empty.error };
    });

    await step('verify', async () => {
      const v1 = B.verifyFile(file, null);
      const v2 = B.verifyFile(file, privRaw);
      return Object.assign({ checksum_only: v1.checksum }, v2);
    });

    /* ── 4. it must fail closed ── */
    await step('refuse-tampered-truncated-wrong-key', async () => {
      const buf = fs.readFileSync(file);
      const expect = (code, fn) => { try { fn(); } catch (e) { if (e.code === code) return code; throw new Error('expected ' + code + ', got ' + (e.code || e.message)); } throw new Error('expected ' + code + ', but it opened'); };
      const t1 = path.join(work, 'flip.e2b'); const fb = Buffer.from(buf); fb[Math.floor(fb.length / 2)] ^= 0x01; fs.writeFileSync(t1, fb);
      const t2 = path.join(work, 'cut.e2b'); fs.writeFileSync(t2, buf.subarray(0, buf.length - 40));
      const t3 = path.join(work, 'nolast.e2b');
      /* drop the final (manifest) record cleanly at a record boundary */
      const { off } = B.readHeader(buf); let p = off, last = off;
      while (p < buf.length) { last = p; p += 4 + buf.readUInt32BE(p); }
      fs.writeFileSync(t3, buf.subarray(0, last));
      const t4 = path.join(work, 'hdr.e2b'); const hb = Buffer.from(buf); const i = hb.indexOf(Buffer.from('"created_at":"')) + 15; hb[i] = hb[i] === 0x31 ? 0x32 : 0x31; fs.writeFileSync(t4, hb);
      const other = B.x25519Keys();
      const out = {
        bit_flip: expect('auth_failed', () => B.openContainer(t1, privRaw)),
        truncated_mid_record: expect('truncated', () => B.openContainer(t2, privRaw)),
        end_marker_removed: expect('truncated', () => B.openContainer(t3, privRaw)),
        header_edited: expect('auth_failed', () => B.openContainer(t4, privRaw)),
        wrong_key: expect('wrong_key', () => B.openContainer(file, other.priv)),
      };
      fs.copyFileSync(file.replace(/\.e2b$/, '.json'), t1.replace(/\.e2b$/, '.json'));
      out.sidecar_checksum = expect('checksum_mismatch', () => B.verifyFile(t1, null));
      return out;
    });

    /* ── 5. restore target: a brand-new cluster (no roles at all) or an empty database ── */
    await step('restore-target', async () => {
      if (freshCluster) {
        const bin = process.env.PAYESH_PG_BIN;
        const data = path.join(work, 'cluster');
        const pw = path.join(work, 'pw'); fs.writeFileSync(path.join(work, 'pw'), 'unused\n', { mode: 0o600 });
        const init = spawnSync(path.join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'], { encoding: 'utf8' });
        if (init.status !== 0) throw new Error('initdb: ' + init.stderr.slice(-300));
        fs.rmSync(pw, { force: true });
        const port = await freePort();
        const proc = spawn(path.join(bin, 'postgres'), ['-D', data, '-p', String(port), '-k', work, '-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off'], { stdio: ['ignore', 'ignore', 'pipe'] });
        let errTxt = ''; proc.stderr.on('data', d => { errTxt += d; });
        cluster = { proc, data, port };
        const base = `postgres://postgres@127.0.0.1:${port}/postgres`;
        for (let i = 0; ; i++) {
          const c = new Client({ connectionString: base }); c.on('error', () => {});
          try { await c.connect(); await c.end(); break; } catch (e) { if (i > 100) throw new Error('fresh cluster did not start: ' + errTxt.slice(-300)); await new Promise(r => setTimeout(r, 100)); }
        }
        const c = new Client({ connectionString: base }); c.on('error', () => {}); await c.connect();
        await c.query(dbDdl('CREATE', DST));
        const roles = (await c.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname LIKE 'payesh%'")).rows[0].n;
        const ver = (await c.query('SHOW server_version')).rows[0].server_version;
        await c.end();
        dstUrl = dbUrl(base, DST);
        return { kind: 'fresh cluster (initdb), different port, no payesh roles', port, payesh_roles_before: roles, server_version: ver };
      }
      await root.query(dbDdl('CREATE', DST));
      dstUrl = dbUrl(ADMIN, DST);
      return { kind: 'empty database on the same server (roles are cluster-wide)', db: DST };
    });

    let restored = null;
    await step('restore', async () => {
      if (freshCluster) {
        /* without --create-roles the tool must stop before touching the target */
        try { await B.restore({ file, privRaw, targetUrl: dstUrl }); throw new Error('restore without roles did not refuse'); } catch (e) { if (e.code !== 'roles_missing') throw e; }
      }
      const tmpBefore = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('payesh-restore-')).length;
      const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/backup-111.mjs'), 'restore', '--file', file, '--key', path.join(keyDir, 'payesh-backup.private.key'), ...(freshCluster ? ['--create-roles'] : [])],
        { encoding: 'utf8', env: Object.assign({}, process.env, { PAYESH_RESTORE_TARGET_URL: dstUrl }) });
      if (r.status !== 0) throw new Error(r.stderr || r.stdout);
      restored = JSON.parse(r.stdout.trim().split('\n').pop());
      const tmpAfter = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('payesh-restore-')).length;
      if (tmpAfter > tmpBefore) throw new Error('decrypted temp files left behind');
      return { restore_ms: restored.ms, via: restored.via, counts: restored.counts, ledger: restored.ledger.length + ' direct migrations', snapshot_equal: true, plaintext_temp_removed: true, roles_refusal_first: freshCluster || undefined };
    });

    await step('refuse-non-empty-target', async () => {
      try { await B.restore({ file, privRaw, targetUrl: dstUrl }); } catch (e) { if (e.code === 'target_not_empty') return { refused: 'target_not_empty' }; throw e; }
      throw new Error('restored over an existing schema');
    });

    /* ── 6. the restored copy works like the original for a device ── */
    await step('device-uses-restored-copy', async () => {
      const dst = new Client({ connectionString: dstUrl }); dst.on('error', () => {}); await dst.connect();
      try {
        const asDev = (s, d) => (fn, args) => claimed(dst, s.sub, d.id, RPC[fn], args).then(r => r[0].r);
        /* fresh install of device A1: empty shadow, pulls the restored feed and decrypts */
        const fresh = new DirectSync({ tenant: A.tenant, call: asDev(A, A.d1), keyring: A.d1.ring, directory: A.dir });
        const got = new Map();
        await fresh.pull((k, doc) => { if (doc) got.set(k, doc); else got.delete(k); });
        if (got.size !== A.view.size) throw new Error(`restored feed has ${got.size} records, original ${A.view.size}`);
        for (const [k, d] of A.view) if (JSON.stringify(got.get(k)) !== JSON.stringify(d)) throw new Error('record differs after restore: ' + k);
        const canaryBack = [...got.values()].some(d => d.note === CANARY);
        /* RLS still bites: school B's device sees only B */
        const bView = new Map();
        await new DirectSync({ tenant: Bs.tenant, call: asDev(Bs, Bs.d1), keyring: Bs.d1.ring, directory: Bs.dir }).pull((k, doc) => { if (doc) bView.set(k, doc); });
        const noClaims = (await withRole(dst, null, null, 'SELECT count(*)::int AS n FROM payesh_direct.record')).rows[0].n;
        const rls = (await dst.query(`SELECT bool_and(relrowsecurity AND relforcerowsecurity) AS ok FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'payesh_direct' AND relname IN ('record','sync_op','sync_conflict')`)).rows[0].ok;
        /* replay of a uid confirmed before the backup → duplicate (op log restored) */
        const rp = await fresh.push([{ uid: A.replayUid, collection: 'attendance', type: 'put', id: 4, data: { class_id: 1, student_id: 104, status: 'present', note: 'replay' } }]);
        const dup = rp.applied.length === 1 && rp.applied[0].duplicate === true;
        /* a new write continues the sequence and the conflict is still there for the manager */
        const w = await fresh.push([{ uid: crypto.randomUUID(), collection: 'attendance', type: 'put', id: 41, data: { class_id: 1, student_id: 141, status: 'present', note: 'after restore' } }]);
        const seq = Number((await dst.query('SELECT max(seq)::bigint AS s FROM payesh_direct.record')).rows[0].s);
        const conflicts = (await claimed(dst, A.sub, A.d1.id, 'SELECT count(*)::int AS n FROM payesh_direct.sync_conflict', []))[0];
        return {
          records_pulled_and_decrypted: got.size, identical_to_original: true, canary_decrypts_on_device: canaryBack,
          school_B_sees: bView.size, no_claims_sees: noClaims, rls_forced: rls,
          replay_is_duplicate: dup, new_write_applied: w.applied.length === 1, seq_continues: seq > A.maxSeq,
          conflict_rows_for_manager: conflicts.n, conflict_rows_before_backup: A.conflictRows,
        };
      } finally { await dst.end().catch(() => {}); }
    }).then(info => {
      if (info && !(info.canary_decrypts_on_device && info.school_B_sees === 3 && info.no_claims_sees === 0 && info.rls_forced && info.replay_is_duplicate && info.new_write_applied && info.seq_continues && info.conflict_rows_for_manager === info.conflict_rows_before_backup && info.conflict_rows_before_backup >= 1)) log('device-uses-restored-copy:assert', false, { message: 'one of the restored-copy checks is false' });
    });

    /* ── 7. retention ── */
    await step('retention', async () => {
      const d = path.join(work, 'ret'); fs.mkdirSync(d);
      const start = Date.UTC(2026, 4, 1);
      for (let i = 0; i < 200; i += 3) {
        const n = 'payesh-backup-' + new Date(start + i * 86400000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '.e2b';
        fs.writeFileSync(path.join(d, n), 'x'); fs.writeFileSync(path.join(d, n.replace(/\.e2b$/, '.json')), '{}');
      }
      fs.writeFileSync(path.join(d, 'unrelated.txt'), 'keep');
      const total = fs.readdirSync(d).filter(f => f.endsWith('.e2b')).length;
      const r = B.prune({ dir: d, keep: 7, monthly: 6 });
      const left = fs.readdirSync(d);
      if (!left.includes('unrelated.txt')) throw new Error('prune touched a foreign file');
      if (left.filter(f => f.endsWith('.json')).length !== r.kept.length) throw new Error('sidecars not pruned with their backup');
      const months = new Set(r.kept.map(f => f.slice(14, 20)));
      return { backups: total, kept: r.kept.length, deleted: r.deleted.length, months_covered: months.size, newest_kept: r.kept[r.kept.length - 1] };
    });
  } catch (e) {
    log('drill', false, { message: String(e.message).slice(0, 400) });
  } finally {
    if (src) await src.end().catch(() => {});
    if (cluster) { cluster.proc.kill('SIGINT'); await new Promise(r => { cluster.proc.on('exit', r); setTimeout(r, 5000); }); }
    for (const db of [SRC, DST]) await root.query(dbDdl('DROP', db)).catch(() => {});
    await root.end().catch(() => {});
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log('DRILL ' + JSON.stringify({ step: 'summary', label: '[S]', env: env0, fresh_cluster: freshCluster, steps: steps.length, failed: steps.filter(s => !s.pass).map(s => s.step) }));
  console.log(ok ? 'BACKUP-DRILL-111-OK' : 'BACKUP-DRILL-111-FAILED');
  return ok;
}

/* ── helpers: the database as a device sees it (SET LOCAL ROLE + claims, like PostgREST) ── */
async function withRole(c, sub, device, sql, params = []) {
  await c.query('BEGIN');
  try {
    await c.query('SET LOCAL ROLE payesh_direct_client');
    if (sub) await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, device_id: device })]);
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
}
const claimed = (c, sub, device, sql, params) => withRole(c, sub, device, sql, params).then(r => r.rows);

async function makeSchool(c, label) {
  const tenant = crypto.randomUUID();
  const sub = `sub-b111-${label}-${tenant.slice(0, 8)}`;
  const boot = (await c.query('SELECT * FROM payesh_direct.bootstrap_school($1, $2, $3, $4)', [tenant, 'mgr-' + label, sub, 'phone 1'])).rows[0];
  const d2id = (await claimed(c, sub, boot.device_id, 'SELECT payesh_direct.enroll_device($1, $2) AS id', [boot.user_id, 'phone 2']))[0].id;
  const smk = e2e.newSmk();
  const dir = new Map();
  const devs = [{ id: boot.device_id, kp: e2e.generateKeyPair() }, { id: d2id, kp: e2e.generateKeyPair() }];
  for (const d of devs) await claimed(c, sub, d.id, 'SELECT payesh_direct.register_device_key($1)', [e2e.b64u(d.kp.pub)]);
  for (const sc of ['smk', 'school:attendance', 'school:homework', 'class:1:attendance', 'class:9:attendance']) {
    const k = e2e.deriveScopeKey(smk, tenant, sc, 1, 0);
    await claimed(c, sub, devs[0].id, 'SELECT payesh_direct.publish_scope_key($1, 1, 0, $2)', [sc, e2e.b64u(k.pub)]);
    dir.set(sc, { kid: k.kid, pub: k.pub });
  }
  const smkKid = e2e.kidOf('smk', 1, 0);
  for (const d of devs) {
    await claimed(c, sub, devs[0].id, 'SELECT payesh_direct.put_key_grant($1, $2, 1, 0, $3)', [d.id, 'smk', e2e.sealGrant(d.kp.pub, tenant, d.id, smkKid, smk)]);
    d.ring = new e2e.Keyring(tenant);
    d.ring.addGrant(smkKid, smk);
    d.call = (fn, args) => claimed(c, sub, d.id, RPC[fn], args).then(r => r[0].r);
    d.sync = new DirectSync({ tenant, call: d.call, keyring: d.ring, directory: dir });
  }
  return { tenant, sub, dir, d1: devs[0], d2: devs[1] };
}
