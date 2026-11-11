'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Versioned, zero-downtime schema migrations for the central DB (row 86)

   The pattern is expand → migrate → contract:
     expand   additive only: new nullable columns, new tables, indexes built
              CONCURRENTLY, compatibility triggers. Code from release N-1
              keeps working unchanged.
     migrate  data movement (backfill), in small batches, one short
              transaction per batch, so no long lock ever blocks traffic.
     contract the destructive tail: drop the old column, trigger or table.
              It runs only when (a) the operator passes allowContract, and
              (b) the recorded client floor (the oldest client version still
              allowed to connect) is ≥ the version the migration declares.
              In other words, the N-1 client is retired before its column
              goes.

   Safety rails, all enforced before or while the SQL runs:
     • lint: in expand/migrate, anything destructive or lock-heavy is
       rejected (DROP TABLE/COLUMN, RENAME, ALTER TYPE, SET NOT NULL,
       ADD COLUMN NOT NULL without DEFAULT, TRUNCATE, DELETE/UPDATE without
       WHERE, CREATE INDEX without CONCURRENTLY on an existing table, plain
       DROP INDEX). Rejection happens before the database is touched.
     • checksum: an applied migration whose file changed ⇒ abort.
     • unknown applied id (DB is ahead of this binary) ⇒ abort.
     • a single migrator at a time (pg_try_advisory_lock) ⇒ second one aborts.
     • lock_timeout / statement_timeout on every migration session, so a
       migration that cannot get its lock gives up instead of queueing every
       request behind it.
     • rollback runs the .down.sql files in reverse order. It stops at a
       contract migration (irreversible by design: the data is gone).

   File format (directory, sorted by name):
     NNNN_slug.up.sql      first lines are header comments:
                             -- phase: expand|migrate|contract
                             -- transaction: false        (for CONCURRENTLY)
                             -- batch: true               (migrate: repeat until 0 rows)
                             -- requires_client_floor: 0.10.0   (contract)
     NNNN_slug.down.sql    rollback (required for expand/migrate)
     NNNN_slug.mjs/.js     JS migration: module.exports = { phase, up(client), down?(client) }
                           (used for the baseline that adopts tenancy.migrate)
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PHASES = ['expand', 'migrate', 'contract'];
const TABLE = 'payesh_schema_migrations';
const FLOOR_TABLE = 'payesh_client_floor';
const LOCK_KEY = 860086; /* advisory lock id for "payesh migrator" */

class MigrationError extends Error {
  constructor(code, detail) { super(code + (detail ? ': ' + detail : '')); this.code = code; this.detail = detail || ''; }
}

/* ── parsing ─────────────────────────────────────────────────────── */
function stripSql(sql) {
  /* remove comments and string literals so lint sees statements, not data */
  return String(sql)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' $BODY$ ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

function parseHeader(sql) {
  const h = {};
  for (const line of String(sql).split('\n').slice(0, 20)) {
    const m = /^--\s*([a-z_]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) h[m[1]] = m[2];
  }
  return h;
}

function checksum(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function loadDir(dir) {
  const names = fs.readdirSync(dir).filter(n => /^\d{4}_[a-z0-9_]+\.(up\.sql|down\.sql|mjs|js)$/.test(n)).sort();
  const byId = new Map();
  for (const n of names) {
    const id = n.replace(/\.(up\.sql|down\.sql|mjs|js)$/, '');
    if (!byId.has(id)) byId.set(id, { id, dir });
    const m = byId.get(id);
    const full = path.join(dir, n);
    if (n.endsWith('.up.sql')) { m.upFile = full; m.upSql = fs.readFileSync(full, 'utf8'); }
    else if (n.endsWith('.down.sql')) { m.downFile = full; m.downSql = fs.readFileSync(full, 'utf8'); }
    else { m.jsFile = full; }
  }
  const out = [];
  for (const m of byId.values()) {
    if (m.jsFile) {
      // eslint-disable-next-line global-require
      const mod = require(m.jsFile);
      m.kind = 'js';
      m.phase = mod.phase;
      m.mod = mod;
      m.header = { phase: mod.phase, transaction: mod.transaction === false ? 'false' : 'true' };
      m.checksum = checksum(fs.readFileSync(m.jsFile));
    } else {
      if (!m.upSql) throw new MigrationError('missing_up', m.id);
      m.kind = 'sql';
      m.header = parseHeader(m.upSql);
      m.phase = m.header.phase;
      m.checksum = checksum(Buffer.from(m.upSql + '\n--down--\n' + (m.downSql || '')));
    }
    if (!PHASES.includes(m.phase)) throw new MigrationError('bad_phase', `${m.id}: ${m.phase}`);
    out.push(m);
  }
  return out;
}

/* ── lint ────────────────────────────────────────────────────────── */
const RULES = [
  { id: 'drop_table', re: /\bDROP\s+TABLE\b/i, why: 'drops a table N-1 code may still read' },
  { id: 'drop_column', re: /\bALTER\s+TABLE\b[^;]*\bDROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(?!CONSTRAINT\b|DEFAULT\b|NOT\b|IDENTITY\b|EXPRESSION\b)[\w"]+/i, why: 'drops a column N-1 code may still read/write' },
  { id: 'drop_schema', re: /\bDROP\s+SCHEMA\b/i, why: 'drops a schema' },
  { id: 'truncate', re: /\bTRUNCATE\b/i, why: 'deletes all rows' },
  { id: 'rename', re: /\bALTER\s+TABLE\b[^;]*\bRENAME\b/i, why: 'rename breaks N-1 code that uses the old name; add + backfill + contract instead' },
  { id: 'alter_type', re: /\bALTER\s+(?:COLUMN\s+)?[\w"]+\s+(?:SET\s+DATA\s+)?TYPE\b/i, why: 'type change rewrites the table under ACCESS EXCLUSIVE and can break N-1' },
  { id: 'set_not_null', re: /\bSET\s+NOT\s+NULL\b/i, why: 'N-1 inserts without the column would fail; full-table scan under lock' },
  { id: 'add_not_null_no_default', test: (s) => addClauses(s).some(cl => /\bNOT\s+NULL\b/i.test(cl) && !/\bDEFAULT\b/i.test(cl)), why: 'NOT NULL without DEFAULT fails for N-1 inserts' },
  { id: 'delete_without_where', test: (s) => splitStatements(s).some(st => /^\s*DELETE\s+FROM\b/i.test(st) && !/\bWHERE\b/i.test(st)), why: 'unbounded delete' },
  { id: 'update_without_where', test: (s) => splitStatements(s).some(st => /^\s*UPDATE\b/i.test(st) && !/\bWHERE\b/i.test(st)), why: 'unbounded update (one long transaction, locks every row)' },
  { id: 'drop_index_blocking', test: (s) => /\bDROP\s+INDEX\b/i.test(s) && !/\bDROP\s+INDEX\s+CONCURRENTLY\b/i.test(s), why: 'plain DROP INDEX takes ACCESS EXCLUSIVE' },
  { id: 'drop_index', re: /\bDROP\s+INDEX\b/i, why: 'removing an index is a contract step (N-1 query plans may rely on it)' },
];

/* each "ADD [COLUMN] name type …" clause up to the next comma/semicolon (constraints excluded) */
function addClauses(s) {
  const out = [];
  for (const m of String(s).matchAll(/\bADD\s+(?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|FOREIGN\b|CHECK\b)(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[\w"]+\s+([^,;]*)/gi)) out.push(m[1]);
  return out;
}

function splitStatements(s) { return String(s).split(';').map(x => x.trim()).filter(Boolean); }

function createdTables(s) {
  const out = new Set();
  for (const m of String(s).matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/gi)) out.add(m[1].replace(/"/g, '').split('.').pop().toLowerCase());
  return out;
}

function lintMigration(m) {
  const errors = [];
  if (m.kind === 'js') return errors; /* baseline adopts existing idempotent DDL; reviewed in code */
  const s = stripSql(m.upSql);
  const h = m.header;
  if (m.phase !== 'contract') {
    for (const r of RULES) {
      const hit = r.test ? r.test(s) : r.re.test(s);
      if (hit) errors.push({ rule: r.id, why: r.why });
    }
    if (!m.downSql) errors.push({ rule: 'missing_down', why: 'expand/migrate must be reversible' });
  } else {
    if (!h.requires_client_floor) errors.push({ rule: 'contract_without_floor', why: 'contract must declare requires_client_floor' });
    if (/\bDROP\s+INDEX\b/i.test(s) && !/\bDROP\s+INDEX\s+CONCURRENTLY\b/i.test(s)) errors.push({ rule: 'drop_index_blocking', why: 'use DROP INDEX CONCURRENTLY' });
  }
  /* CREATE INDEX on a pre-existing table must be CONCURRENTLY (no write lock) */
  const created = createdTables(s);
  for (const mm of s.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[\w"]*\s*ON\s+(?:ONLY\s+)?([\w."]+)/gi)) {
    const tbl = mm[2].replace(/"/g, '').split('.').pop().toLowerCase();
    if (!mm[1] && !created.has(tbl)) errors.push({ rule: 'create_index_blocking', why: `CREATE INDEX on existing table ${tbl} without CONCURRENTLY blocks writes` });
  }
  if (/\bCONCURRENTLY\b/i.test(s) && h.transaction !== 'false') errors.push({ rule: 'concurrently_in_tx', why: 'CONCURRENTLY needs "-- transaction: false"' });
  if (h.batch === 'true') {
    if (m.phase !== 'migrate') errors.push({ rule: 'batch_outside_migrate', why: 'batch backfill belongs to the migrate phase' });
    if (!/\bLIMIT\b/i.test(s)) errors.push({ rule: 'batch_without_limit', why: 'a batch statement must bound its rows with LIMIT' });
    if (splitStatements(s).length !== 1) errors.push({ rule: 'batch_multi_statement', why: 'a batch migration is exactly one statement' });
  }
  return errors;
}

function lintAll(list) {
  const out = [];
  for (const m of list) for (const e of lintMigration(m)) out.push(Object.assign({ id: m.id, phase: m.phase }, e));
  return out;
}

/* ── semver (x.y.z, numeric) ─────────────────────────────────────── */
function cmpVer(a, b) {
  const pa = String(a || '0').split(/[.+-]/).slice(0, 3).map(n => Number(n) || 0);
  const pb = String(b || '0').split(/[.+-]/).slice(0, 3).map(n => Number(n) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/* ── database side ───────────────────────────────────────────────── */
async function ensureMeta(c) {
  /* track = one migration directory (e.g. "central"); several tracks can share a DB */
  await c.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    track text NOT NULL, id text NOT NULL, phase text NOT NULL, checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(), duration_ms integer NOT NULL DEFAULT 0, rows bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (track, id))`);
  await c.query(`CREATE TABLE IF NOT EXISTS ${FLOOR_TABLE} (
    id integer PRIMARY KEY CHECK (id = 1), min_version text NOT NULL, set_at timestamptz NOT NULL DEFAULT now())`);
}

function trackOf(dir, o) { return String((o && o.track) || path.basename(path.resolve(dir))); }

async function applied(c, track) {
  const r = await c.query(`select id, phase, checksum, applied_at, rows from ${TABLE} where track = $1 order by id`, [track]);
  return r.rows;
}

async function clientFloor(c) {
  const r = await c.query(`select min_version from ${FLOOR_TABLE} where id = 1`);
  return r.rows[0] ? r.rows[0].min_version : null;
}

async function setClientFloor(c, version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new MigrationError('bad_version', String(version));
  await ensureMeta(c);
  const cur = await clientFloor(c);
  if (cur && cmpVer(version, cur) < 0) throw new MigrationError('floor_downgrade', `${cur} → ${version}`);
  await c.query(`insert into ${FLOOR_TABLE} (id, min_version) values (1, $1)
                 on conflict (id) do update set min_version = excluded.min_version, set_at = now()`, [String(version)]);
  return { min_version: String(version) };
}

async function withLock(c, fn) {
  const r = await c.query('select pg_try_advisory_lock($1) as ok', [LOCK_KEY]);
  if (!r.rows[0].ok) throw new MigrationError('locked', 'another migrator holds the lock');
  try { return await fn(); } finally { await c.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {}); }
}

async function setTimeouts(c, o) {
  await c.query(`set lock_timeout = '${Number(o.lockTimeoutMs) | 0}ms'`);
  await c.query(`set statement_timeout = '${Number(o.statementTimeoutMs) | 0}ms'`);
}

function verifyState(list, rows) {
  const known = new Map(list.map(m => [m.id, m]));
  for (const r of rows) {
    const m = known.get(r.id);
    if (!m) throw new MigrationError('unknown_applied', `${r.id} is applied but not in this release (DB is ahead of the code)`);
    if (m.checksum !== r.checksum) throw new MigrationError('checksum_mismatch', `${r.id} changed after it was applied`);
  }
  /* applied set must be a prefix: no hole in the middle */
  const ids = list.map(m => m.id);
  const done = new Set(rows.map(r => r.id));
  let seenGap = false;
  for (const id of ids) {
    if (!done.has(id)) seenGap = true;
    else if (seenGap) throw new MigrationError('out_of_order', `${id} applied after a pending migration`);
  }
}

async function runOne(c, m, o, log, track) {
  const t0 = Date.now();
  let rows = 0;
  const tx = m.header.transaction !== 'false';
  await setTimeouts(c, o);
  if (m.kind === 'js') {
    if (tx) await c.query('BEGIN');
    try { await m.mod.up(c, o); if (tx) await c.query('COMMIT'); }
    catch (e) { if (tx) await c.query('ROLLBACK').catch(() => {}); throw e; }
  } else if (m.header.batch === 'true') {
    /* one short transaction per batch; stops when a batch touches 0 rows */
    const sql = m.upSql;
    for (let i = 0; i < (o.maxBatches || 100000); i++) {
      await c.query('BEGIN');
      let n = 0;
      try { const r = await c.query(sql); n = r.rowCount || 0; await c.query('COMMIT'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      rows += n;
      if (o.onBatch) await o.onBatch({ id: m.id, batch: i + 1, rows: n });
      if (!n) break;
      if (o.batchPauseMs) await new Promise(r => setTimeout(r, o.batchPauseMs));
    }
  } else if (tx) {
    await c.query('BEGIN');
    try { await c.query(m.upSql); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  } else {
    /* non-transactional (CONCURRENTLY): statements one by one */
    for (const st of splitSqlKeepingBodies(m.upSql)) await c.query(st);
  }
  const ms = Date.now() - t0;
  await c.query(`insert into ${TABLE} (track, id, phase, checksum, duration_ms, rows) values ($1, $2, $3, $4, $5, $6)`, [track, m.id, m.phase, m.checksum, ms, rows]);
  log && log({ event: 'applied', id: m.id, phase: m.phase, ms, rows });
  return { id: m.id, phase: m.phase, ms, rows };
}

/* split on ; outside $$…$$ bodies and quotes (needed for non-tx files) */
function splitSqlKeepingBodies(sql) {
  const out = [];
  let cur = '', i = 0, inQ = false, dollar = null;
  const s = String(sql).replace(/--[^\n]*/g, '');
  while (i < s.length) {
    const ch = s[i];
    if (dollar) {
      if (s.startsWith(dollar, i)) { cur += dollar; i += dollar.length; dollar = null; continue; }
      cur += ch; i++; continue;
    }
    if (inQ) { cur += ch; if (ch === "'") inQ = false; i++; continue; }
    if (ch === "'") { inQ = true; cur += ch; i++; continue; }
    const dm = /^\$[A-Za-z_]*\$/.exec(s.slice(i));
    if (dm) { dollar = dm[0]; cur += dollar; i += dollar.length; continue; }
    if (ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const DEFAULTS = { lockTimeoutMs: 3000, statementTimeoutMs: 120000, allowContract: false, to: null };

/* up: apply pending migrations in order (optionally up to and including `to`) */
async function up(c, dir, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const list = loadDir(dir);
  const lint = lintAll(list);
  if (lint.length) throw Object.assign(new MigrationError('lint_failed', lint.map(e => `${e.id}:${e.rule}`).join(',')), { lint });
  await ensureMeta(c);
  const track = trackOf(dir, o);
  return withLock(c, async () => {
    const rows = await applied(c, track);
    verifyState(list, rows);
    const done = new Set(rows.map(r => r.id));
    const pending = [];
    for (const m of list) {
      if (done.has(m.id)) continue;
      pending.push(m);
      if (o.to && m.id === o.to) break;
    }
    if (o.to && !list.some(m => m.id === o.to)) throw new MigrationError('unknown_target', o.to);
    /* gate contracts BEFORE running anything, so a run never stops half-way at the gate */
    const floor = await clientFloor(c);
    for (const m of pending) {
      if (m.phase !== 'contract') continue;
      if (!o.allowContract) throw new MigrationError('contract_not_allowed', `${m.id} needs --allow-contract`);
      if (!floor || cmpVer(floor, m.header.requires_client_floor) < 0) {
        throw new MigrationError('client_floor_too_low', `${m.id} needs client floor ≥ ${m.header.requires_client_floor}, recorded ${floor || 'none'}`);
      }
    }
    const results = [];
    for (const m of pending) results.push(await runOne(c, m, o, o.log, track));
    return { applied: results, pending_after: list.filter(m => !done.has(m.id) && !results.some(r => r.id === m.id)).map(m => m.id) };
  });
}

/* rollback: undo applied migrations newer than `to` (exclusive), newest first */
async function rollback(c, dir, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const list = loadDir(dir);
  await ensureMeta(c);
  const track = trackOf(dir, o);
  return withLock(c, async () => {
    const rows = await applied(c, track);
    verifyState(list, rows);
    const byId = new Map(list.map(m => [m.id, m]));
    const targets = rows.map(r => r.id).filter(id => !o.to || id > o.to).sort().reverse();
    for (const id of targets) {
      const m = byId.get(id);
      if (m.phase === 'contract') throw new MigrationError('irreversible', `${id} is a contract migration`);
      if (m.kind === 'js' ? typeof m.mod.down !== 'function' : !m.downSql) throw new MigrationError('missing_down', id);
    }
    const undone = [];
    for (const id of targets) {
      const m = byId.get(id);
      await setTimeouts(c, o);
      const tx = m.header.transaction !== 'false';
      if (tx) await c.query('BEGIN');
      try {
        if (m.kind === 'js') await m.mod.down(c, o);
        else if (tx) await c.query(m.downSql);
        else for (const st of splitSqlKeepingBodies(m.downSql)) await c.query(st);
        await c.query(`delete from ${TABLE} where track = $1 and id = $2`, [track, id]);
        if (tx) await c.query('COMMIT');
      } catch (e) { if (tx) await c.query('ROLLBACK').catch(() => {}); throw e; }
      undone.push(id);
      o.log && o.log({ event: 'rolled_back', id });
    }
    return { rolled_back: undone };
  });
}

async function status(c, dir, o = {}) {
  const list = loadDir(dir);
  await ensureMeta(c);
  const track = trackOf(dir, o);
  const rows = await applied(c, track);
  let state = 'ok';
  try { verifyState(list, rows); } catch (e) { state = e.code; }
  const done = new Set(rows.map(r => r.id));
  return {
    state, track,
    client_floor: await clientFloor(c),
    migrations: list.map(m => ({ id: m.id, phase: m.phase, applied: done.has(m.id) })),
  };
}

module.exports = {
  PHASES, TABLE, FLOOR_TABLE, RULES, MigrationError,
  loadDir, lintMigration, lintAll, parseHeader, stripSql, cmpVer, splitSqlKeepingBodies,
  up, rollback, status, setClientFloor, clientFloor, ensureMeta,
};
