#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Row 82, direct path (ADR-105 §3.3, Proposed): load and measurement on
   the sync RPCs + RLS of real PostgreSQL — no Gateway in between.

   This is the path the row's acceptance criterion names as the main
   target: devices call payesh_direct.sync_pull / sync_push through
   PostgREST. PostgREST turns every /rpc call into ONE transaction on a
   pooled connection:
       BEGIN; SET LOCAL ROLE payesh_direct_client;
       SELECT set_config('request.jwt.claims', <verified claims>, true);
       SELECT payesh_direct.<rpc>(…); COMMIT;
   This tool sends exactly that sequence, from a LOGIN role that is only a
   member of payesh_direct_client (no BYPASSRLS), over a fixed-size pool
   (PostgREST db-pool). So the measured latency is the database work of
   the direct path plus pool waiting; the HTTP hop of the provider is not
   in it (OWNER measures that on T2 — see docs/cloud/82-load-test.md §7).

   Setup (prepare): a fresh database, the direct migrations through the
   row-86 migrator, N schools (bootstrap_school + published e2e1 scope
   keys, row 107) and D devices (enroll_device + register_device_key,
   row 106). Every pushed record is sealed end-to-end by tools/e2e1.js
   on the device side, as the app does.

   Gates (same thresholds as the Gateway variant, deploy/monitoring/slo-85.yml):
     error rate ≤ 0.5%           (any RPC that raises)
     p95 ≤ 1000 ms
     op integrity: no stale / conflict / rejected / duplicate op — every
       device writes only its own records on top of the version it saw
     no session leak: after the run no session of the API role is left
       "idle in transaction", and the peak never exceeded the pool
     tenant isolation under load (RLS): a device of school A sees all of
       A's records and none of anybody else's
     every section labelled [S]; no "unlimited" claim (claimsGate)
   [M] is refused unless PAYESH_T2_MANAGED_DB=1 (OWNER, T2).

   CLI:
     PAYESH_PG_ADMIN=postgres://postgres@127.0.0.1:5432/postgres \
       node tools/load-82-direct.mjs [--devices 2000] [--tenants 20] \
       [--duration 30] [--warmup 5] [--concurrency 64] [--pool 32] \
       [--push-ratio 0.2] [--out report.json] [--keep] [--to <migration id>]
     (--to stops the direct migrations early, e.g. 0005_direct_write_tickets
      to measure the database as it was before this row's RLS fix)
   Exit: 0 every gate green · 1 a gate red · 2 bad usage
   Prints LOAD-82-DIRECT-OK / LOAD-82-DIRECT-FAILED <gates>.
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { quantile, claimsGate } from './load-82.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const e2e = require(path.join(ROOT, 'tools', 'e2e1.js'));

export const DEFAULTS = Object.freeze({
  devices: 2000, tenants: 20, duration: 30, warmup: 5, concurrency: 64, pool: 32, pushRatio: 0.2,
  label: 'S', maxErrorRate: 0.005, maxP95Ms: 1000,
});
export const API_ROLE = 'payesh_ld82_api';
const COLLECTION = 'homework';

/* constant SQL only (security-scan-48 SS-05) */
const SQL = Object.freeze({
  begin: 'BEGIN',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
  role: 'SET LOCAL ROLE payesh_direct_client',
  claims: "SELECT set_config('request.jwt.claims', $1, true)",
  push: 'SELECT payesh_direct.sync_push($1::jsonb, $2) AS r',
  pull: 'SELECT payesh_direct.sync_pull($1::bigint, $2, $3::text[]) AS r',
  bootstrap: 'SELECT * FROM payesh_direct.bootstrap_school($1, $2, $3, $4)',
  enroll: 'SELECT payesh_direct.enroll_device($1, $2) AS id',
  regKey: 'SELECT payesh_direct.register_device_key($1)',
  publish: 'SELECT payesh_direct.publish_scope_key($1, 1, 0, $2)',
  plan: `INSERT INTO payesh_direct.tenant_plan (tenant_id, max_ops_per_window, window_sec)
         VALUES ($1, $2, $3) ON CONFLICT (tenant_id) DO UPDATE
         SET max_ops_per_window = EXCLUDED.max_ops_per_window, window_sec = EXCLUDED.window_sec`,
  ensureRole: `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payesh_ld82_api') THEN
        CREATE ROLE payesh_ld82_api LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF; END $$`,
  grantRole: 'GRANT payesh_direct_client TO payesh_ld82_api',
  sessions: `SELECT count(*)::int AS n, count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_tx
             FROM pg_stat_activity WHERE usename = 'payesh_ld82_api' AND datname = current_database()`,
  tenantCount: 'SELECT count(*)::int AS n FROM payesh_direct.record WHERE tenant_id = $1',
  isolation: `SELECT count(*)::int AS total, count(*) FILTER (WHERE tenant_id <> $1)::int AS foreign_rows
              FROM payesh_direct.record`,
  recordCount: 'SELECT count(*)::int AS n FROM payesh_direct.record',
});

function dbDdl(verb, db) {
  if (!/^payesh_ld82d_[0-9]+_[0-9a-z]+$/.test(db)) throw new Error('refusing database name ' + db);
  return verb === 'CREATE' ? 'CREATE DATABASE ' + db : 'DROP DATABASE IF EXISTS ' + db + ' WITH (FORCE)';
}
function withDb(url, db, user) {
  const u = new URL(url);
  u.pathname = '/' + db;
  if (user) { u.username = user; u.password = ''; }
  return u.toString();
}

/** fresh database + schools + devices; returns the context run() needs */
export async function prepare(o = {}) {
  const c = Object.assign({}, DEFAULTS, o);
  const admin = c.adminUrl || process.env.PAYESH_PG_ADMIN;
  if (!admin) throw Object.assign(new Error('PAYESH_PG_ADMIN is required'), { usage: true });
  const { Pool, Client } = require('pg');
  const db = `payesh_ld82d_${process.pid}_${Date.now().toString(36)}`;
  const root = new Client({ connectionString: admin });
  root.on('error', () => {});
  await root.connect();
  try {
    await root.query(dbDdl('CREATE', db));
    await root.query(SQL.ensureRole);
  } finally { await root.end().catch(() => {}); }
  const dbUrl = withDb(admin, db);
  if (c.to && !/^[0-9]{4}_[a-z0-9_]+$/.test(c.to)) throw Object.assign(new Error('bad --to ' + c.to), { usage: true });
  const m = spawnSync(process.execPath, [path.join(ROOT, 'tools/migrate-86.mjs'), 'up', '--dir', 'db/migrations/direct', ...(c.to ? ['--to', c.to] : [])],
    { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { PAYESH_MIGRATE_URL: dbUrl }) });
  if (m.status !== 0) throw new Error('migrate: ' + String(m.stdout + m.stderr).slice(-600));
  const owner = new Pool({ connectionString: dbUrl, max: 4 });
  owner.on('error', () => {});
  await owner.query(SQL.grantRole);
  const api = new Pool({ connectionString: withDb(admin, db, API_ROLE), max: c.pool });
  api.on('error', () => {});

  const ctx = { admin, db, dbUrl, owner, api, pool: c.pool, schools: [], devices: [], migrateOut: m.stdout.trim().split('\n').slice(-1)[0] };
  const as = (claims, sql, params) => rpcTx(api, claims, sql, params);
  const t0 = Date.now();
  for (let s = 0; s < c.tenants; s++) {
    const tenant = crypto.randomUUID();
    const sub = `ld82-mgr-${s}-${tenant.slice(0, 8)}`;
    const r = (await owner.query(SQL.bootstrap, [tenant, 'mgr-' + s, sub, 'mgr device'])).rows[0];
    const mgr = { tenant, user: r.user_id, sub, device: r.device_id, claims: { sub, device_id: r.device_id } };
    await as(mgr.claims, SQL.regKey, [e2e.b64u(e2e.generateKeyPair().pub)]);
    const smk = e2e.newSmk();
    const directory = new Map();
    for (const sc of ['smk', 'school:' + COLLECTION]) {
      const k = e2e.deriveScopeKey(smk, tenant, sc, 1, 0);
      await as(mgr.claims, SQL.publish, [sc, e2e.b64u(k.pub)]);
      directory.set(sc, { kid: k.kid, pub: k.pub });
    }
    /* the load plan: the default window (1200 ops/min/school) is a product
       cap, not what is measured here; negatives put a small cap back */
    await owner.query(SQL.plan, [tenant, 10000000, 60]);
    ctx.schools.push({ tenant, mgr, directory });
  }
  for (let i = 0; i < c.devices; i++) {
    const s = ctx.schools[i % c.tenants];
    const id = (await as(s.mgr.claims, SQL.enroll, [s.mgr.user, 'ld82 device ' + i])).rows[0].id;
    const claims = { sub: s.mgr.sub, device_id: id };
    await as(claims, SQL.regKey, [e2e.b64u(e2e.generateKeyPair().pub)]);
    ctx.devices.push({ i, school: s, claims, seq: 0, n: 0, ver: new Map() });
  }
  ctx.setupMs = Date.now() - t0;
  return ctx;
}

/** one PostgREST-style RPC: one transaction, SET LOCAL ROLE, verified claims */
async function rpcTx(pool, claims, sql, params) {
  const cl = await pool.connect();
  try {
    await cl.query(SQL.begin);
    await cl.query(SQL.role);
    await cl.query(SQL.claims, [JSON.stringify(claims)]);
    const r = await cl.query(sql, params);
    await cl.query(SQL.commit);
    return r;
  } catch (e) {
    await cl.query(SQL.rollback).catch(() => {});
    throw e;
  } finally { cl.release(); }
}

export async function teardown(ctx, { keep = false } = {}) {
  if (!ctx) return;
  await ctx.api.end().catch(() => {});
  await ctx.owner.end().catch(() => {});
  if (keep) return;
  const { Client } = require('pg');
  const root = new Client({ connectionString: ctx.admin });
  root.on('error', () => {});
  await root.connect();
  try { await root.query(dbDdl('DROP', ctx.db)); } finally { await root.end().catch(() => {}); }
}

export function gates(report, o = {}) {
  const red = [];
  const maxErr = o.maxErrorRate ?? DEFAULTS.maxErrorRate;
  const maxP95 = o.maxP95Ms ?? DEFAULTS.maxP95Ms;
  if (report.errors.rate > maxErr) red.push(`error_rate ${report.errors.rate} > ${maxErr}`);
  if (report.latency_ms.all.p95 == null || report.latency_ms.all.p95 > maxP95) red.push(`p95 ${report.latency_ms.all.p95}ms > ${maxP95}ms`);
  const oi = report.op_integrity;
  if (oi.stale + oi.conflicts + oi.rejected + oi.duplicates > 0) red.push(`op_integrity stale=${oi.stale} conflicts=${oi.conflicts} rejected=${oi.rejected} duplicates=${oi.duplicates}`);
  if (oi.records_db !== oi.records_expected) red.push(`records ${oi.records_db} != expected ${oi.records_expected}`);
  const se = report.sessions;
  if (se.idle_in_tx_after > 0) red.push(`session_leak idle_in_transaction=${se.idle_in_tx_after}`);
  if (se.peak > se.pool) red.push(`session_peak ${se.peak} > pool ${se.pool}`);
  const iso = report.isolation;
  if (iso.foreign_rows > 0 || iso.mismatched > 0) red.push(`isolation foreign_rows=${iso.foreign_rows} mismatched=${iso.mismatched}`);
  if (report.requests.measured < 100) red.push('too_few_requests ' + report.requests.measured);
  for (const e of claimsGate(report)) red.push(e);
  return red;
}

export async function run(ctx, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const label = String(o.label || 'S').toUpperCase() === 'M' ? 'M' : 'S';
  if (label === 'M' && process.env.PAYESH_T2_MANAGED_DB !== '1') {
    throw Object.assign(new Error('label [M] is OWNER-only: set PAYESH_T2_MANAGED_DB=1 on the managed T2 database run'), { usage: true, code: 'label_m_refused' });
  }
  const L = '[' + label + ']';
  const tag = crypto.randomBytes(3).toString('hex');
  const devices = o.devices && o.devices < ctx.devices.length ? ctx.devices.slice(0, o.devices) : ctx.devices;
  const lat = { all: [], pull: [], push: [] };
  const codes = {};
  const oi = { ops_sent: 0, applied: 0, stale: 0, conflicts: 0, rejected: 0, duplicates: 0 };
  const created = new Set();
  const samples = [];
  let total = 0, measured = 0, errors = 0, cursor = 0, peak = 0;
  let rng = Number.parseInt(tag, 16) || 82;
  const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  const before = (await ctx.owner.query(SQL.recordCount)).rows[0].n;
  const t0 = Date.now();
  const warmupMs = o.warmup * 1000;
  const endAt = t0 + (o.warmup + o.duration) * 1000;
  let sampling = false;
  const sampler = setInterval(async () => {
    if (sampling) return; sampling = true;
    try {
      const s = (await ctx.owner.query(SQL.sessions)).rows[0];
      peak = Math.max(peak, s.n);
      samples.push({ t_s: Math.round((Date.now() - t0) / 100) / 10, api_sessions: s.n, idle_in_tx: s.idle_tx, total, errors });
    } catch (e) { /* sampling is best effort */ } finally { sampling = false; }
  }, 1000);

  async function one() {
    const d = devices[cursor++ % devices.length];
    const isPush = rnd() < o.pushRatio;
    const t = process.hrtime.bigint();
    let ok = true;
    try {
      if (isPush) {
        const k = 1 + Math.floor(rnd() * 3);
        const ids = new Set();
        while (ids.size < k) ids.add(d.i * 1000 + ((d.n + ids.size) % 50) + 1);
        const ops = [];
        for (const id of ids) {
          d.n++;
          const base = d.ver.get(id) || 0;
          const doc = { title: 'load ' + d.n, note: 'x'.repeat(40) };
          ops.push({
            uid: `ld82-${tag}-${d.i}-${d.n}`, type: 'put', collection: COLLECTION, id, base_version: base,
            class_id: null, student_id: null,
            sealed: e2e.sealRecord({ tenant_id: d.school.tenant, collection: COLLECTION, record_id: id, version: base + 1, class_id: null, student_id: null }, doc, d.school.directory),
          });
        }
        oi.ops_sent += ops.length;
        const r = (await rpcTx(ctx.api, d.claims, SQL.push, [JSON.stringify(ops), null])).rows[0].r;
        for (const a of r.applied || []) {
          if (a.duplicate) { oi.duplicates++; continue; }
          oi.applied++;
          d.ver.set(Number(a.id), Number(a.version));
          if (Number(a.version) === 1) created.add(d.school.tenant + '#' + a.id);   /* a new record; later versions update it */
        }
        oi.stale += (r.stale || []).length;
        oi.conflicts += (r.conflicts || []).length;
        oi.rejected += (r.rejected || []).length;
        oi.duplicates += (r.duplicates || []).length;
      } else {
        const r = (await rpcTx(ctx.api, d.claims, SQL.pull, [d.seq, '50', null])).rows[0].r;
        if (r && r.next_seq != null) d.seq = Number(r.next_seq) || d.seq;
      }
    } catch (e) {
      ok = false;
      const code = (e && e.code) || 'js';
      if (Date.now() - t0 >= warmupMs) codes[code] = (codes[code] || 0) + 1;
    }
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    total++;
    if (Date.now() - t0 >= warmupMs) {
      measured++;
      lat.all.push(ms); (isPush ? lat.push : lat.pull).push(ms);
      if (!ok) errors++;
    }
  }
  async function worker() { while (Date.now() < endAt) await one(); }
  await Promise.all(Array.from({ length: o.concurrency }, worker));
  clearInterval(sampler);
  while (sampling) await new Promise(r => setTimeout(r, 20));
  const wall = (Date.now() - t0 - warmupMs) / 1000;

  /* after the run: sessions, record count, tenant isolation (RLS) */
  const after = (await ctx.owner.query(SQL.sessions)).rows[0];
  peak = Math.max(peak, after.n);
  const recordsDb = (await ctx.owner.query(SQL.recordCount)).rows[0].n - before;
  const sampleSchools = ctx.schools.slice(0, Math.min(5, ctx.schools.length));
  const iso = { label: L, schools_checked: sampleSchools.length, foreign_rows: 0, mismatched: 0, detail: [] };
  for (const s of sampleSchools) {
    const dev = devices.find(d => d.school === s) || { claims: s.mgr.claims };
    const seen = (await rpcTx(ctx.api, dev.claims, SQL.isolation, [s.tenant])).rows[0];
    const truth = (await ctx.owner.query(SQL.tenantCount, [s.tenant])).rows[0].n;
    iso.foreign_rows += seen.foreign_rows;
    if (seen.total !== truth) iso.mismatched++;
    iso.detail.push({ tenant: s.tenant.slice(0, 8), visible: seen.total, foreign: seen.foreign_rows, truth });
  }

  const stat = (a) => { const s = a.slice().sort((x, y) => x - y); return { label: L, n: s.length, p50: quantile(s, 0.5), p95: quantile(s, 0.95), p99: quantile(s, 0.99), max: s.length ? Math.round(s[s.length - 1] * 10) / 10 : null }; };
  const report = {
    row: 82, variant: 'direct', label: L,
    claim_scope: label === 'S'
      ? 'simulated: synthetic devices calling the direct-path RPCs (PostgREST transaction semantics, no HTTP hop) on PostgreSQL on a CI runner or dev machine (loopback); describes this run only, not production capacity'
      : 'measured on the owner-managed database (T2)',
    date_utc: new Date().toISOString(), node: process.version,
    environment: { database: 'fresh, direct migrations (' + ctx.migrateOut + ')', api_role: API_ROLE + ' (member of payesh_direct_client only, NOBYPASSRLS)', pool: ctx.pool, managed_db_attested: label === 'M', setup_ms: ctx.setupMs },
    config: { devices: devices.length, tenants: ctx.schools.length, duration_s: o.duration, warmup_s: o.warmup, concurrency: o.concurrency, pool: ctx.pool, push_ratio: o.pushRatio },
    requests: { label: L, total, measured },
    latency_ms: { label: L, all: stat(lat.all), pull: stat(lat.pull), push: stat(lat.push) },
    errors: { label: L, count: errors, rate: measured ? Math.round((errors / measured) * 1e5) / 1e5 : 1, sqlstates: codes },
    throughput: { label: L, rps: wall > 0 ? Math.round(measured / wall) : 0, ops_per_s: wall > 0 ? Math.round(oi.applied / (wall + o.warmup)) : 0 },
    op_integrity: Object.assign({ label: L, records_expected: created.size, records_db: recordsDb }, oi),
    sessions: { label: L, pool: ctx.pool, peak, after: after.n, idle_in_tx_after: after.idle_tx },
    isolation: iso,
    memory: { label: L, measured: false, reason: 'direct path: no application process between device and database; leak gate = database sessions (sessions section)', leak_suspected: false },
    session_samples: samples,
  };
  report.gates = { label: L, thresholds: { max_error_rate: o.maxErrorRate, max_p95_ms: o.maxP95Ms }, red: [] };
  report.gates.red = gates(report, o);
  report.verdict = report.gates.red.length ? 'FAILED' : 'OK';
  return report;
}

export function summary(r) {
  const l = r.label;
  return [
    `${l} row 82 direct-path load: devices=${r.config.devices} tenants=${r.config.tenants} concurrency=${r.config.concurrency} pool=${r.config.pool} duration=${r.config.duration_s}s (+${r.config.warmup_s}s warmup)`,
    `${l} rpc calls=${r.requests.measured} rps=${r.throughput.rps} applied_ops/s=${r.throughput.ops_per_s}`,
    `${l} latency ms all p50=${r.latency_ms.all.p50} p95=${r.latency_ms.all.p95} p99=${r.latency_ms.all.p99} max=${r.latency_ms.all.max}`,
    `${l} latency ms sync_pull p50=${r.latency_ms.pull.p50} p95=${r.latency_ms.pull.p95} p99=${r.latency_ms.pull.p99} · sync_push p50=${r.latency_ms.push.p50} p95=${r.latency_ms.push.p95} p99=${r.latency_ms.push.p99}`,
    `${l} errors=${r.errors.count} rate=${r.errors.rate} sqlstates=${JSON.stringify(r.errors.sqlstates)}`,
    `${l} ops sent=${r.op_integrity.ops_sent} applied=${r.op_integrity.applied} stale=${r.op_integrity.stale} conflicts=${r.op_integrity.conflicts} rejected=${r.op_integrity.rejected} duplicates=${r.op_integrity.duplicates} records db=${r.op_integrity.records_db}/${r.op_integrity.records_expected}`,
    `${l} sessions pool=${r.sessions.pool} peak=${r.sessions.peak} idle_in_tx_after=${r.sessions.idle_in_tx_after} · isolation schools=${r.isolation.schools_checked} foreign_rows=${r.isolation.foreign_rows} mismatched=${r.isolation.mismatched}`,
    `${l} scope: ${r.claim_scope}`,
  ].join('\n');
}

function parseArgs(argv) {
  const o = {};
  const map = { devices: 'devices', tenants: 'tenants', duration: 'duration', concurrency: 'concurrency', pool: 'pool', 'push-ratio': 'pushRatio', warmup: 'warmup', 'max-error-rate': 'maxErrorRate', 'max-p95-ms': 'maxP95Ms' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (k === 'keep') { o.keep = true; continue; }
    const v = argv[i + 1]; i++;
    if (k === 'out') o.out = v; else if (k === 'label') o.label = v; else if (k === 'to') o.to = v;
    else if (map[k]) o[map[k]] = Number(v);
    else throw Object.assign(new Error('unknown flag --' + k), { usage: true });
  }
  return o;
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (String(o.label || 'S').toUpperCase() === 'M' && process.env.PAYESH_T2_MANAGED_DB !== '1') {
    console.error('LOAD-82-DIRECT-FAILED usage: label [M] is OWNER-only: set PAYESH_T2_MANAGED_DB=1 on the managed T2 database run');
    process.exit(2);
  }
  let ctx, r;
  try {
    ctx = await prepare(o);
    r = await run(ctx, o);
  } catch (e) {
    console.error('LOAD-82-DIRECT-FAILED ' + (e.usage ? 'usage: ' : '') + e.message);
    await teardown(ctx, o).catch(() => {});
    process.exit(e.usage ? 2 : 1);
  }
  await teardown(ctx, o);
  if (o.out) fs.writeFileSync(o.out, JSON.stringify(r, null, 2) + '\n');
  console.log(summary(r));
  console.log(r.verdict === 'OK' ? 'LOAD-82-DIRECT-OK' : 'LOAD-82-DIRECT-FAILED ' + r.gates.red.join(' | '));
  process.exit(r.verdict === 'OK' ? 0 : 1);
}

let isMain = false;
try { isMain = !!process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url; } catch (e) { isMain = false; }
if (isMain) main();
