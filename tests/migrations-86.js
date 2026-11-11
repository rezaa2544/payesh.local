'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 86: versioned zero-downtime migrations (expand → migrate → contract)
   MG-01 .. MG-15

   What is real:
     • a fresh PostgreSQL database per run on the pgserver (D-40: the embedded
       PostgreSQL locally, the postgres:16 service in CI);
     • the product's own migration directory (db/migrations/central, baseline
       adopting server/tenancy.js) and the drill chain
       (db/fixtures/migrations-86: rename phone → mobile in 4 steps);
     • sample data: rows written through the real tenancy API
       (applyOps / listFeed on a runtime-role pool = the N-1 server code),
       and 5,000 student rows across 3 tenants;
     • concurrency: an N-1 writer (SQL that only knows `phone`) runs in
       parallel with expand and with the batched backfill, and must see zero
       errors. That is the "no downtime" claim measured, not asserted.

   Negative controls: destructive SQL in expand/migrate is refused before the
   DB is touched; a contract migration is refused without --allow-contract or
   with a client floor below its requirement; checksum drift, an unknown
   applied id, a second migrator and lock contention all refuse; and rollback
   through a contract migration is refused.

   Run: PAYESH_PG_ADMIN=postgres://postgres@127.0.0.1:5432/payesh_c64 \
        node --experimental-sqlite tests/migrations-86.js
        (MG86_REQUIRE_PG=1 turns "no PG" into a failure, as in CI)
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const migrator = require(path.join(ROOT, 'server', 'migrator.js'));
const PRODUCT_DIR = path.join(ROOT, 'db', 'migrations', 'central');
const DRILL_DIR = path.join(ROOT, 'db', 'fixtures', 'migrations-86');
const CLI = path.join(ROOT, 'tools', 'migrate-86.mjs');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-mg86-'));

let passed = 0, failed = 0, skipped = 0;
const failures = [];
async function check(id, desc, fn) {
  const t0 = Date.now();
  try {
    const d = await fn();
    if (d === 'SKIP') { skipped++; console.log(`SKIP  ${id}  ${desc}`); return; }
    passed++;
    console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}  (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++; failures.push(id);
    console.log(`FAIL  ${id}  ${desc}  → ${String((e && (e.code ? e.code + ' ' : '') + e.message) || e).slice(0, 400)}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function refuses(p, code) {
  try { await p; } catch (e) { if (e.code === code) return e; throw new Error(`expected ${code}, got ${e.code || e.message}`); }
  throw new Error(`expected refusal ${code}, but it succeeded`);
}
function sqlMig(id, phase, upSql, downSql = 'SELECT 1;', extraHeader = '') {
  return { id, kind: 'sql', phase, header: Object.assign({ phase }, migrator.parseHeader(extraHeader + '\n' + upSql)), upSql, downSql };
}
function copyDir(src, dst, filter = () => true) {
  fs.mkdirSync(dst, { recursive: true });
  for (const n of fs.readdirSync(src)) if (filter(n)) fs.copyFileSync(path.join(src, n), path.join(dst, n));
  return dst;
}
function cli(args, url) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, url ? { PAYESH_MIGRATE_URL: url } : {}) });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

(async () => {
  console.log('\nRow 86: versioned migrations, expand → migrate → contract\n');

  /* ── static checks (no DB) ───────────────────────────────────────── */
  await check('MG-01', 'lint: product dir (baseline) and drill chain are clean; phases parsed', async () => {
    const a = cli(['lint', '--dir', 'db/migrations/central']);
    const b = cli(['lint', '--dir', 'db/fixtures/migrations-86']);
    assert(a.code === 0 && /MIGRATE-86-OK lint migrations=1 errors=0/.test(a.out), 'product lint: ' + a.out);
    assert(b.code === 0 && /MIGRATE-86-OK lint migrations=5 errors=0/.test(b.out), 'drill lint: ' + b.out);
    const phases = migrator.loadDir(DRILL_DIR).map(m => m.phase).join(',');
    assert(phases === 'expand,expand,expand,migrate,contract', phases);
    return 'product=1 drill=5 (' + phases + ')';
  });

  await check('MG-02', 'negative lint matrix: 13 destructive/blocking statements in expand/migrate each refused with its rule; 5 safe forms pass', async () => {
    const bad = [
      ['ALTER TABLE t DROP COLUMN phone;', 'drop_column'],
      ['DROP TABLE t;', 'drop_table'],
      ['ALTER TABLE t RENAME COLUMN phone TO mobile;', 'rename'],
      ['ALTER TABLE t RENAME TO t2;', 'rename'],
      ['ALTER TABLE t ALTER COLUMN phone TYPE bigint USING phone::bigint;', 'alter_type'],
      ['ALTER TABLE t ALTER COLUMN phone SET NOT NULL;', 'set_not_null'],
      ['ALTER TABLE t ADD COLUMN grade int NOT NULL;', 'add_not_null_no_default'],
      ['TRUNCATE t;', 'truncate'],
      ['DELETE FROM t;', 'delete_without_where'],
      ['UPDATE t SET phone = NULL;', 'update_without_where'],
      ['CREATE INDEX t_phone_idx ON t (phone);', 'create_index_blocking'],
      ['DROP INDEX t_phone_idx;', 'drop_index_blocking'],
      ['CREATE INDEX CONCURRENTLY t_p ON t (phone);', 'concurrently_in_tx'],
    ];
    for (const [sql, rule] of bad) {
      for (const phase of ['expand', 'migrate']) {
        const errs = migrator.lintMigration(sqlMig('9000_x', phase, sql)).map(e => e.rule);
        assert(errs.includes(rule), `${phase}: "${sql}" not refused as ${rule} (got ${errs.join(',') || 'nothing'})`);
      }
    }
    /* expand/migrate must be reversible */
    assert(migrator.lintMigration(sqlMig('9001_x', 'expand', 'ALTER TABLE t ADD COLUMN a text;', null)).some(e => e.rule === 'missing_down'), 'missing down not refused');
    /* contract must declare its client floor */
    assert(migrator.lintMigration(sqlMig('9002_x', 'contract', 'ALTER TABLE t DROP COLUMN phone;', null)).some(e => e.rule === 'contract_without_floor'), 'contract without floor not refused');
    const good = [
      'ALTER TABLE t ADD COLUMN mobile text;',
      'ALTER TABLE t ADD COLUMN grade int NOT NULL DEFAULT 0;',
      'CREATE TABLE n (a int); CREATE INDEX n_a ON n (a);',
      'ALTER TABLE t ADD CONSTRAINT c CHECK (phone IS NOT NULL) NOT VALID;',
      "CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $$ BEGIN DELETE FROM x; RETURN NEW; END $$ LANGUAGE plpgsql;",
    ];
    for (const sql of good) {
      const errs = migrator.lintMigration(sqlMig('9003_x', 'expand', sql));
      assert(errs.length === 0, `safe form refused: "${sql}" → ${errs.map(e => e.rule)}`);
    }
    assert(migrator.lintMigration(sqlMig('9004_x', 'expand', 'CREATE INDEX CONCURRENTLY t_p ON t (phone);', 'DROP INDEX CONCURRENTLY t_p;', '-- transaction: false')).length === 0, 'concurrent index with transaction:false refused');
    return `${bad.length}×2 refused · ${good.length + 1} safe pass`;
  });

  /* ── database ────────────────────────────────────────────────────── */
  const ADMIN = process.env.PAYESH_PG_ADMIN || '';
  let pg = null;
  try { pg = require('pg'); } catch (e) { pg = null; }
  if (!ADMIN || !pg) {
    const msg = 'no PAYESH_PG_ADMIN / pg driver — DB checks skipped';
    if (process.env.MG86_REQUIRE_PG === '1') { failed++; failures.push('MG-PG'); console.log('FAIL  MG-PG  ' + msg); }
    else console.log('SKIP  MG-03..15  ' + msg);
    return finish();
  }
  const dbName = 'payesh_m86_' + process.pid + '_' + Date.now().toString(36);
  const u = new URL(ADMIN);
  const serverUrl = new URL(ADMIN); serverUrl.pathname = '/postgres';
  const dbUrl = new URL(ADMIN); dbUrl.pathname = '/' + dbName;
  const runtimeUrl = new URL(process.env.PAYESH_PG_RUNTIME || ADMIN.replace(/\/\/[^@/]+@/, '//payesh_runtime@'));
  runtimeUrl.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: serverUrl.toString() });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  root.on('error', () => {});
  const c = new pg.Client({ connectionString: dbUrl.toString(), application_name: 'mg86-test' });
  c.on('error', () => {});
  await c.connect();
  const extra = [];
  const tenancy = require(path.join(ROOT, 'server', 'tenancy.js'));
  let rtPool = null;
  const T = ['86868686-0001-4000-8000-000000000001', '86868686-0002-4000-8000-000000000002', '86868686-0003-4000-8000-000000000003'];
  const ctx = {};

  try {
    await check('MG-03', 'negative end-to-end: chain + one destructive expand (DROP COLUMN) ⇒ CLI exit 1 lint_failed, DB untouched', async () => {
      const dir = copyDir(DRILL_DIR, path.join(WORK, 'bad-chain'));
      fs.writeFileSync(path.join(dir, '0105_m86_bad.up.sql'), '-- phase: expand\nALTER TABLE m86_students DROP COLUMN full_name;\n');
      fs.writeFileSync(path.join(dir, '0105_m86_bad.down.sql'), 'SELECT 1;\n');
      const r = cli(['up', '--dir', dir], dbUrl.toString());
      assert(r.code === 1 && /"rule":"drop_column"|0105_m86_bad:drop_column/.test(r.out) && /MIGRATE-86-FAILED up code=lint_failed/.test(r.out), r.out.slice(0, 400));
      const t = await c.query("select to_regclass('public.m86_students') as t, to_regclass('public.payesh_schema_migrations') as m");
      assert(t.rows[0].t === null && t.rows[0].m === null, 'DB was touched: ' + JSON.stringify(t.rows[0]));
      return 'refused before connect-side effects (no tables created)';
    });

    await check('MG-04', 'product baseline adopts a DB built by the previous release with live data: no loss, idempotent, N-1 server code (applyOps/listFeed) still works', async () => {
      /* previous release: schema via tenancy.migrate + data via the real API */
      await tenancy.migrate(c);
      rtPool = tenancy.createPool({ connectionString: runtimeUrl.toString(), max: 4 });
      rtPool.on('error', () => {});
      for (const t of T.slice(0, 2)) {
        const ops = [];
        for (let i = 1; i <= 25; i++) ops.push({ uid: `mg86-${t.slice(-1)}-${i}`, collection: 'students', type: 'put', id: i, data: { first_name: 'S' + i, grade: 7 } });
        await tenancy.applyOps(rtPool, t, { ops, device_id: 'mg86' });
      }
      const before = (await c.query('select count(*)::int n from product_records')).rows[0].n;
      const feedBefore = (await c.query('select count(*)::int n, max(seq)::int s from product_change_feed')).rows[0];
      const r1 = await migrator.up(c, PRODUCT_DIR, {});
      assert(r1.applied.length === 1 && r1.applied[0].id === '0001_baseline', JSON.stringify(r1));
      const r2 = await migrator.up(c, PRODUCT_DIR, {});
      assert(r2.applied.length === 0, 'second run applied again');
      const after = (await c.query('select count(*)::int n from product_records')).rows[0].n;
      const feedAfter = (await c.query('select count(*)::int n, max(seq)::int s from product_change_feed')).rows[0];
      assert(before === 50 && after === before && feedAfter.n === feedBefore.n && feedAfter.s === feedBefore.s, `data changed ${before}→${after}, feed ${JSON.stringify(feedBefore)}→${JSON.stringify(feedAfter)}`);
      /* N-1 server code keeps working on the migrated DB (and RLS still isolates) */
      await tenancy.applyOps(rtPool, T[0], { ops: [{ uid: 'mg86-after-1', collection: 'students', type: 'put', id: 26, data: { first_name: 'After' } }], device_id: 'mg86' });
      const feed = await tenancy.listFeed(rtPool, T[0], { sinceSeq: 0, limit: 500 });
      const items = feed.changes || feed.items || feed.rows || [];
      assert(items.length === 26, 'tenant 0 feed size ' + items.length + ' keys=' + Object.keys(feed));
      const other = await tenancy.listFeed(rtPool, T[2], { sinceSeq: 0, limit: 500 });
      assert((other.changes || other.items || other.rows || []).length === 0, 'RLS leak after migration');
      return `records ${before}→${after}, feed seq ${feedBefore.s} kept, N-1 write+read ok, RLS ok`;
    });

    await check('MG-05', 'sample data on the N-1 schema: drill 0100 applied, 5,000 student rows across 3 tenants', async () => {
      const r = await migrator.up(c, DRILL_DIR, { to: '0100_m86_students' });
      assert(r.applied.map(x => x.id).join() === '0100_m86_students', JSON.stringify(r));
      await c.query(`insert into m86_students (tenant_id, full_name, phone)
                     select ($1::uuid[])[1 + (g % 3)], 'student ' || g, '0912' || lpad(g::text, 7, '0')
                     from generate_series(1, 5000) g`, [T]);
      const n = (await c.query('select count(*)::int n from m86_students')).rows[0].n;
      assert(n === 5000, 'rows ' + n);
      return 'rows=5000';
    });

    /* an N-1 writer: only knows phone; runs until stopped, counts errors */
    function startN1Writer(label) {
      const w = { ops: 0, errors: [], stop: false, label };
      const wc = new pg.Client({ connectionString: dbUrl.toString(), application_name: 'mg86-n1-' + label });
      wc.on('error', () => {});
      w.done = (async () => {
        await wc.connect();
        await wc.query("set statement_timeout = '10s'");
        let i = 0;
        while (!w.stop) {
          i++;
          try {
            if (i % 2) {
              await wc.query('insert into m86_students (tenant_id, full_name, phone) values ($1, $2, $3)', [T[i % 3], 'n1 ' + label + ' ' + i, '0935' + String(i).padStart(7, '0')]);
            } else {
              await wc.query('update m86_students set phone = $1, updated_at = now() where id = $2', ['0901' + String(i).padStart(7, '0'), 1 + (i * 37) % 5000]);
            }
            const r = await wc.query('select phone from m86_students where id = $1', [1 + (i * 13) % 5000]);
            if (!r.rows.length) throw new Error('row vanished');
            w.ops++;
          } catch (e) { w.errors.push(e.message); }
          await sleep(2);
        }
        await wc.end();
      })();
      return w;
    }

    await check('MG-06', 'expand (0101 column+sync trigger, 0102 CONCURRENTLY index) while an N-1 writer runs ⇒ writer errors 0; both directions sync', async () => {
      const w = startN1Writer('expand');
      await sleep(150);
      const r = await migrator.up(c, DRILL_DIR, { to: '0102_m86_mobile_index' });
      await sleep(150);
      w.stop = true; await w.done;
      assert(r.applied.map(x => x.id).join() === '0101_m86_mobile_expand,0102_m86_mobile_index', JSON.stringify(r.applied));
      assert(w.errors.length === 0, 'N-1 writer errors: ' + w.errors.slice(0, 3).join(' | '));
      assert(w.ops > 20, 'writer barely ran: ' + w.ops);
      /* N-1 insert (phone) ⇒ mobile filled; N insert (mobile) ⇒ phone filled; N-1 update ⇒ mobile follows */
      const a = (await c.query("insert into m86_students (tenant_id, full_name, phone) values ($1,'n1-new','09120000001') returning id, mobile", [T[0]])).rows[0];
      const b = (await c.query("insert into m86_students (tenant_id, full_name, mobile) values ($1,'n-new','09120000002') returning id, phone", [T[1]])).rows[0];
      await c.query("update m86_students set phone = '09120000003' where id = $1", [a.id]);
      const a2 = (await c.query('select mobile from m86_students where id = $1', [a.id])).rows[0];
      await c.query("update m86_students set mobile = '09120000004' where id = $1", [b.id]);
      const b2 = (await c.query('select phone from m86_students where id = $1', [b.id])).rows[0];
      assert(a.mobile === '09120000001' && b.phone === '09120000002' && a2.mobile === '09120000003' && b2.phone === '09120000004', 'sync broken');
      const idx = (await c.query("select indisvalid from pg_index where indexrelid = to_regclass('m86_students_mobile_idx')")).rows[0];
      assert(idx && idx.indisvalid === true, 'concurrent index missing/invalid');
      ctx.nWrittenId = b.id;
      return `n1 ops=${w.ops} errors=0 · sync n1→n, n→n1 ok · index valid`;
    });

    await check('MG-07', 'migrate (0103 batched backfill, 500/batch, one tx each) with a concurrent N-1 writer ⇒ writer errors 0, every row backfilled, short batches', async () => {
      /* expand added the column but copied nothing: the original rows still have mobile NULL
         (except rows the N-1 writer touched, which the trigger already synced) */
      const nullsBefore = (await c.query('select count(*)::int n from m86_students where mobile is null and phone is not null')).rows[0].n;
      const w = startN1Writer('migrate');
      const batches = [];
      let last = Date.now();
      const r = await migrator.up(c, DRILL_DIR, { to: '0103_m86_mobile_backfill', batchPauseMs: 5,
        onBatch: (b) => { const now = Date.now(); batches.push({ rows: b.rows, ms: now - last }); last = now; } });
      await sleep(100);
      w.stop = true; await w.done;
      assert(r.applied.length === 1 && r.applied[0].rows === nullsBefore, `backfilled ${r.applied[0] && r.applied[0].rows} of ${nullsBefore}`);
      assert(w.errors.length === 0, 'N-1 writer errors: ' + w.errors.slice(0, 3).join(' | '));
      const left = (await c.query('select count(*)::int n from m86_students where mobile is distinct from phone')).rows[0].n;
      assert(left === 0, 'rows with mobile != phone: ' + left);
      const maxMs = Math.max(...batches.map(b => b.ms));
      assert(batches.length >= 10 && batches.every(b => b.rows <= 500), 'batches ' + batches.length);
      ctx.batchMax = maxMs;
      return `rows=${nullsBefore} batches=${batches.length} max_batch_ms=${maxMs} n1 ops=${w.ops} errors=0`;
    });

    await check('MG-08', 'contract gate: no --allow-contract ⇒ refused; floor unset / 0.9.2 < 0.10.0 ⇒ refused; floor downgrade refused; nothing applied', async () => {
      await refuses(migrator.up(c, DRILL_DIR, {}), 'contract_not_allowed');
      await refuses(migrator.up(c, DRILL_DIR, { allowContract: true }), 'client_floor_too_low');
      await migrator.setClientFloor(c, '0.9.2');
      await refuses(migrator.up(c, DRILL_DIR, { allowContract: true }), 'client_floor_too_low');
      await migrator.setClientFloor(c, '0.9.5');
      await refuses(migrator.setClientFloor(c, '0.9.1'), 'floor_downgrade');
      const col = (await c.query("select count(*)::int n from information_schema.columns where table_name='m86_students' and column_name='phone'")).rows[0].n;
      const st = await migrator.status(c, DRILL_DIR);
      assert(col === 1 && st.migrations.find(m => m.id === '0104_m86_mobile_contract').applied === false, 'contract ran');
      return 'refused ×3 + downgrade refused · phone still present';
    });

    await check('MG-09', 'rollback to 0100 ⇒ trigger, index, mobile gone; N-1 reads every phone incl. rows written by the N client; then forward again to 0103', async () => {
      const r = await migrator.rollback(c, DRILL_DIR, { to: '0100_m86_students' });
      assert(r.rolled_back.join() === '0103_m86_mobile_backfill,0102_m86_mobile_index,0101_m86_mobile_expand', JSON.stringify(r));
      const cols = (await c.query("select column_name from information_schema.columns where table_name='m86_students' order by 1")).rows.map(x => x.column_name).join(',');
      assert(cols === 'full_name,id,phone,tenant_id,updated_at', 'columns after rollback: ' + cols);
      const trg = (await c.query("select count(*)::int n from pg_trigger where tgname='m86_sync_mobile_trg'")).rows[0].n;
      const idx = (await c.query("select to_regclass('m86_students_mobile_idx') as i")).rows[0].i;
      assert(trg === 0 && idx === null, 'trigger/index left');
      const nRow = (await c.query('select phone from m86_students where id = $1', [ctx.nWrittenId])).rows[0];
      assert(nRow && nRow.phone === '09120000004', 'row written by the N client lost its phone');
      const nulls = (await c.query('select count(*)::int n from m86_students where phone is null')).rows[0].n;
      assert(nulls === 0, 'phones lost: ' + nulls);
      const w = startN1Writer('after-rollback'); await sleep(120); w.stop = true; await w.done;
      assert(w.errors.length === 0 && w.ops > 5, 'N-1 after rollback: ' + w.errors.slice(0, 2));
      const f = await migrator.up(c, DRILL_DIR, { to: '0103_m86_mobile_backfill' });
      assert(f.applied.length === 3, 'forward again: ' + JSON.stringify(f.applied.map(x => x.id)));
      const left = (await c.query('select count(*)::int n from m86_students where mobile is distinct from phone')).rows[0].n;
      assert(left === 0, 'after re-forward mismatch ' + left);
      return 'rolled back 3 · N-1 ok (errors 0) · re-forward 3 · rows consistent';
    });

    await check('MG-10', 'negative: checksum drift on an applied file ⇒ refused; DB ahead of code (unknown applied id) ⇒ refused', async () => {
      const d1 = copyDir(DRILL_DIR, path.join(WORK, 'drift'));
      fs.appendFileSync(path.join(d1, '0101_m86_mobile_expand.up.sql'), '\n-- edited after apply\n');
      const TR = { track: 'migrations-86' }; /* same track as the original directory */
      await refuses(migrator.up(c, d1, TR), 'checksum_mismatch');
      const st = await migrator.status(c, d1, TR);
      assert(st.state === 'checksum_mismatch', 'status ' + st.state);
      const d2 = copyDir(DRILL_DIR, path.join(WORK, 'behind'), n => !n.startsWith('0103_') && !n.startsWith('0104_'));
      await refuses(migrator.up(c, d2, TR), 'unknown_applied');
      return 'checksum_mismatch · unknown_applied';
    });

    await check('MG-11', 'negative: a second migrator while one holds the migration lease ⇒ refused (locked); an expired lease (crashed migrator) is taken over; lease released after the run', async () => {
      const other = new pg.Client({ connectionString: dbUrl.toString() });
      other.on('error', () => {});
      await other.connect(); extra.push(other);
      /* another migrator (other connection) holds a live lease */
      await other.query("insert into payesh_migration_lock (id, holder, expires_at) values (1, 'other-migrator', now() + interval '10 minutes')");
      let msg = '';
      try { await refuses(migrator.up(c, DRILL_DIR, {}), 'locked'); }
      finally { await other.query("delete from payesh_migration_lock where holder = 'other-migrator'"); }
      /* a crashed migrator's lease that expired does not block forever */
      await other.query("insert into payesh_migration_lock (id, holder, expires_at) values (1, 'crashed-migrator', now() - interval '1 second')");
      const st = await migrator.up(c, DRILL_DIR, { to: '0103_m86_mobile_backfill' });
      assert(st.applied.length === 0, 'up --to an already-applied id ran later migrations');
      const left = (await other.query('select count(*)::int n from payesh_migration_lock')).rows[0].n;
      assert(left === 0, 'lease not released after up: ' + left);
      msg = 'live lease ⇒ locked · expired lease taken over (applied=' + st.applied.length + ') · released';
      return msg;
    });

    await check('MG-12', 'lock_timeout: a migration that cannot get its lock gives up fast (no queue of traffic behind it), records nothing; succeeds once the lock is free', async () => {
      const dir = copyDir(DRILL_DIR, path.join(WORK, 'locked'), n => !n.startsWith('0104_'));
      fs.writeFileSync(path.join(dir, '0105_m86_note.up.sql'), '-- phase: expand\nALTER TABLE m86_students ADD COLUMN IF NOT EXISTS note text;\n');
      fs.writeFileSync(path.join(dir, '0105_m86_note.down.sql'), 'ALTER TABLE m86_students DROP COLUMN IF EXISTS note;\n');
      const holder = new pg.Client({ connectionString: dbUrl.toString() });
      holder.on('error', () => {});
      await holder.connect(); extra.push(holder);
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE m86_students IN ACCESS SHARE MODE');
      const t0 = Date.now();
      let err = null;
      try { await migrator.up(c, dir, { lockTimeoutMs: 400, track: 'migrations-86' }); } catch (e) { err = e; }
      const ms = Date.now() - t0;
      await holder.query('ROLLBACK');
      assert(err && /lock timeout/i.test(err.message), 'expected lock timeout, got ' + (err && err.message));
      assert(ms < 3000, 'gave up after ' + ms + 'ms');
      const rec = (await c.query("select count(*)::int n from payesh_schema_migrations where track = 'migrations-86' and id = '0105_m86_note'")).rows[0].n;
      assert(rec === 0, 'failed migration was recorded');
      const ok = await migrator.up(c, dir, { lockTimeoutMs: 2000, track: 'migrations-86' });
      assert(ok.applied.map(x => x.id).join() === '0105_m86_note', JSON.stringify(ok.applied));
      await migrator.rollback(c, dir, { to: '0103_m86_mobile_backfill', track: 'migrations-86' });
      return `gave up after ${ms}ms (lock_timeout 400ms) · applied after release · rolled back`;
    });

    await check('MG-13', 'contract after the owner raises the client floor to 0.10.0 ⇒ applied; N client works; N-1 SQL now fails (that is why the floor exists)', async () => {
      const r = cli(['set-client-floor', '0.10.0'], dbUrl.toString());
      assert(r.code === 0, 'floor cli ' + r.out);
      const up = cli(['up', '--dir', 'db/fixtures/migrations-86', '--allow-contract'], dbUrl.toString());
      assert(up.code === 0 && /"id":"0104_m86_mobile_contract"/.test(up.out), up.out.slice(0, 400));
      const cols = (await c.query("select column_name from information_schema.columns where table_name='m86_students' order by 1")).rows.map(x => x.column_name).join(',');
      assert(cols === 'full_name,id,mobile,tenant_id,updated_at', cols);
      await c.query("insert into m86_students (tenant_id, full_name, mobile) values ($1,'n-after','09120000009')", [T[2]]);
      let n1err = null;
      try { await c.query("insert into m86_students (tenant_id, full_name, phone) values ($1,'n1-after','09120000010')", [T[2]]); } catch (e) { n1err = e; }
      assert(n1err && /column "phone"/.test(n1err.message), 'N-1 insert unexpectedly worked');
      const rows = (await c.query('select count(*)::int n, count(mobile)::int m from m86_students')).rows[0];
      assert(rows.n === rows.m, 'rows without mobile after contract: ' + (rows.n - rows.m));
      return `columns=${cols} · rows=${rows.n} all with mobile · N-1 refused by schema`;
    });

    await check('MG-14', 'negative: rollback through a contract migration ⇒ refused (irreversible), schema unchanged', async () => {
      await refuses(migrator.rollback(c, DRILL_DIR, { to: '0100_m86_students' }), 'irreversible');
      const st = await migrator.status(c, DRILL_DIR);
      assert(st.migrations.every(m => m.applied), 'state changed');
      return 'irreversible';
    });

    await check('MG-15', 'CLI status: state ok, all drill migrations applied, client_floor 0.10.0; schema_migrations rows carry checksum + duration', async () => {
      const r = cli(['status', '--dir', 'db/fixtures/migrations-86'], dbUrl.toString());
      assert(r.code === 0, r.out);
      const res = JSON.parse(r.out.split('\n').find(l => l.includes('"event":"result"'))).result;
      assert(res.state === 'ok' && res.client_floor === '0.10.0' && res.migrations.length === 5 && res.migrations.every(m => m.applied), JSON.stringify(res));
      const rows = (await c.query('select track, id, phase, length(checksum) l, duration_ms, rows from payesh_schema_migrations order by track, id')).rows;
      assert(rows.some(x => x.track === 'central' && x.id === '0001_baseline'), 'product track row missing');
      assert(rows.every(x => x.l === 64), 'checksums');
      ctx.table = rows.map(x => `${x.track}/${x.id}:${x.phase}:${x.duration_ms}ms:${x.rows}`).join(' ');
      return ctx.table;
    });
    await check('MG-16', 'negative (mutants of server/migrator.js): destructive-lint off / contract floor gate off / checksum check off ⇒ each caught; unmodified copy passes', async () => {
      const src = fs.readFileSync(path.join(ROOT, 'server', 'migrator.js'), 'utf8');
      const muts = [
        ['lint-off', "      const hit = r.test ? r.test(s) : r.re.test(s);", "      const hit = false; void 0; /* mutant */"],
        ['floor-gate-off', "      if (!floor || cmpVer(floor, m.header.requires_client_floor) < 0) {", "      if (false) { void 0; /* mutant */"],
        ['checksum-off', "    if (m.checksum !== r.checksum) throw", "    if (false) throw"],
      ];
      /* scratch track + table so mutants never touch the drill state */
      const base = path.join(WORK, 'mut-base');
      fs.mkdirSync(base, { recursive: true });
      fs.writeFileSync(path.join(base, '0200_mut_t.up.sql'), '-- phase: expand\nCREATE TABLE IF NOT EXISTS m86_mut (id int, old text);\n');
      fs.writeFileSync(path.join(base, '0200_mut_t.down.sql'), 'DROP TABLE IF EXISTS m86_mut;\n');
      fs.writeFileSync(path.join(base, '0201_mut_contract.up.sql'), '-- phase: contract\n-- requires_client_floor: 9.9.9\nALTER TABLE m86_mut DROP COLUMN old;\n');
      async function probe(mod, tag) {
        const errs = [];
        /* 1) destructive expand must be refused by lint */
        if (!mod.lintMigration(sqlMig('9100_x', 'expand', 'ALTER TABLE t DROP COLUMN phone;')).some(e => e.rule === 'drop_column')) errs.push('lint');
        /* 2) contract with floor 9.9.9 must be refused (recorded floor is 0.10.0) */
        const tr = { track: 'mut-' + tag, allowContract: true };
        await mod.up(c, base, { track: 'mut-' + tag, to: '0200_mut_t' });
        try { await mod.up(c, base, tr); errs.push('floor'); } catch (e) { if (e.code !== 'client_floor_too_low') errs.push('floor:' + e.code); }
        /* 3) drift on an applied file must be refused */
        const drift = copyDir(base, path.join(WORK, 'mut-drift-' + tag));
        fs.appendFileSync(path.join(drift, '0200_mut_t.up.sql'), '-- drift\n');
        try { await mod.status(c, drift, { track: 'mut-' + tag }).then(st => { if (st.state !== 'checksum_mismatch') errs.push('checksum'); }); } catch (e) { errs.push('checksum:' + e.code); }
        /* clean the scratch state for the next probe */
        await c.query("delete from payesh_schema_migrations where track = $1", ['mut-' + tag]);
        await c.query('DROP TABLE IF EXISTS m86_mut');
        return errs;
      }
      const res = [];
      for (const [name, a, b] of muts) {
        assert(src.split(a).length === 2, 'anchor not unique: ' + name);
        const dir = fs.mkdtempSync(path.join(WORK, 'mut86-'));
        try {
          const f = path.join(dir, 'migrator.js');
          fs.writeFileSync(f, src.replace(a, b));
          delete require.cache[require.resolve(f)];
          const errs = await probe(require(f), name);
          assert(errs.length > 0, 'mutant survived: ' + name);
          res.push(name + ':killed(' + errs.join('+') + ')');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      }
      const baseline = await probe(migrator, 'baseline');
      assert(baseline.length === 0, 'baseline probe failed: ' + baseline.join(','));
      return res.join(' ') + ' baseline:clean';
    });
  } finally {
    for (const x of extra) await x.end().catch(() => {});
    if (rtPool) await rtPool.end().catch(() => {});
    await c.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await root.end().catch(() => {});
    void u;
  }
  return finish();

  function finish() {
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* noop */ }
    console.log(`\n# passed=${passed} failed=${failed} skipped=${skipped}${failures.length ? ' failures=' + failures.join(',') : ''}`);
    console.log(failed ? 'MIGRATIONS-86-FAILED' : 'MIGRATIONS-86-OK');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
