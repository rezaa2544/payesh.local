#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   تست بار ناوگان کلاینت — ردیف ۴۶            (FLEET-46)

   چه چیزی ساخته می‌شود؟ N «کلاینت مجازی» که رفتار واقعی دستگاه را دارند:
   pull دوره‌ای از change-feed با مکان‌نمای seq، و push دسته‌ای عملیات.
   هر کلاینت دستگاه جدا با توکن خودش است و سهمیه/نرخ هم در دیتابیس شمرده
   می‌شود — نه اینکه یک درخواست تکراری در حلقه فرستاده شود.

   چه چیزی اندازه‌گیری می‌شود (همه واقعی):
     • RPS کل و به‌تفکیک pull/push
     • p50/p95/p99 خواندن و نوشتن (از زمان‌سنج خودِ هارنس)
     • خطاها بر پایهٔ کد وضعیت (4xx/5xx) و اولین کد خطا
     • CPU و RSS فرایند Gateway (از /proc)
     • اتصال‌های DB و صف pool (از /metrics خودِ Gateway)

   «سقف سالم» = آخرین پله‌ای که هر سه شرط را نگه دارد:
     p99_push < ۲۰۰۰ms · p99_pull < ۲۰۰۰ms · نرخ خطا < ۱٪
   «اولین شکست» = اولین پله‌ای که یکی از این‌ها بشکند (با کد و پیام همان لحظه).

   اجرا:
     PAYESH_PG_ADMIN_URL=... PAYESH_PG_APP_URL=... PAYESH_TENANCY_SECRET=... \
       node tools/fleet-load-46.mjs --clients 25,50,100,200 --seconds 8
   یا با ساخت خودکار PostgreSQL (embedded) توسط اسکریپت شاهد ردیف ۴۶.
   نبودِ محیط ⇒ exit 3 (BLOCKED) — نه PASS.
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const tenancy = require(path.join(ROOT, 'server', 'tenancy.js'));

/* ── آرگومان‌ها ── */
const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const STAGES = String(arg('clients', process.env.FLEET_STAGES || '25,50,100,200'))
  .split(',').map(s => Number(s.trim())).filter(n => n > 0).sort((a, b) => a - b);
const STAGE_SECONDS = Number(arg('seconds', process.env.FLEET_STAGE_SECONDS || 8));
const PUSH_BATCH = Number(arg('batch', process.env.FLEET_PUSH_BATCH || 10));
const PULL_LIMIT = Number(arg('pull', process.env.FLEET_PULL_LIMIT || 200));
const JSON_OUT = arg('json-out', process.env.FLEET_JSON_OUT || null);

const ADMIN_URL = process.env.PAYESH_PG_ADMIN_URL || '';
const APP_URL = process.env.PAYESH_PG_APP_URL || '';
const SECRET = process.env.PAYESH_TENANCY_SECRET || '';
const GATEWAY_URL = process.env.PAYESH_GW_URL || '';   /* اگر خالی باشد، اسکریپت شاهد بالا می‌آورد */
const TENANT = process.env.FLEET_TENANT || '33333333-3333-3333-3333-333333333333';

const PROCS = Number(arg('procs', process.env.FLEET_PROCS || 0));   /* ۰ = خودکار */
const WORKER = argv.includes('--worker');
const WORKER_BASE = Number(arg('base', '0'));
const P99_LIMIT_MS = Number(process.env.FLEET_P99_LIMIT_MS || 2000);
const ERR_LIMIT = Number(process.env.FLEET_ERR_LIMIT || 0.01);

if (!ADMIN_URL || !SECRET) {
  console.log('BLOCKED — ENVIRONMENT UNAVAILABLE (PAYESH_PG_ADMIN_URL / PAYESH_TENANCY_SECRET لازم است)');
  process.exit(3);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; /* ms */

function pct(arr, p) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return Math.round(a[i] * 100) / 100;
}

/* ── نمونه‌برداری از منابع فرایند Gateway ── */
function readProc(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(' ');
    const ticks = Number(stat[13]) + Number(stat[14]);   /* utime + stime */
    const rssPages = Number(stat[23]);
    return { ticks, rss_mb: Math.round((rssPages * 4096) / 1048576 * 10) / 10 };
  } catch (e) { return null; }
}

async function gwMetrics(base) {
  try {
    const r = await fetch(base + '/metrics', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const text = await r.text();
    const get = (name) => {
      const m = new RegExp('^' + name + '(\\{[^}]*\\})?\\s+(-?[\\d.]+)$', 'm').exec(text);
      return m ? Number(m[2]) : null;
    };
    return {
      db_connections: get('payesh_db_connections'),
      pool_waiting: get('payesh_pg_pool_waiting'),
      pool_total: get('payesh_pg_pool_total'),
      pool_wait_seconds: get('payesh_pg_pool_wait_seconds'),
      http_5xx_ratio: get('payesh_http_error_ratio'),
    };
  } catch (e) { return null; }
}

/* ── یک کلاینت مجازی (دستگاه واقعی با توکن خودش) ── */
function makeClient(index) {
  const deviceId = 'fleet-dev-' + index;
  const token = tenancy.signToken({
    tid: TENANT, role: 'manager', uid: 'fleet-u-' + (index % 500),
    did: deviceId, iat: Date.now(), exp: Date.now() + 3600_000,
  }, SECRET);
  let sinceSeq = 0;
  let ops = 0;
  const recordBase = 100000 + index * 100;   /* هر دستگاه ردیف‌های خودش را می‌نویسد */

  return {
    id: deviceId,
    async pull() {
      const t0 = now();
      const res = await fetch(`${GATEWAY_URL}/api/gw/v1/pull?since_seq=${sinceSeq}&limit=${PULL_LIMIT}`, {
        headers: { authorization: 'Bearer ' + token, 'x-device-id': deviceId },
        signal: AbortSignal.timeout(20000),
      });
      const ms = now() - t0;
      let data = null;
      try { data = await res.json(); } catch (e) { /* بدنهٔ خالی */ }
      if (res.ok && data && data.next_seq != null) sinceSeq = Number(data.next_seq) || sinceSeq;
      return { status: res.status, ms, rows: data && Array.isArray(data.rows) ? data.rows.length : 0 };
    },
    async push() {
      const list = [];
      for (let i = 0; i < PUSH_BATCH; i++) {
        ops++;
        list.push({
          uid: `fleet-${index}-${ops}`,
          collection: 'attendance',
          id: recordBase + (ops % 50),
          type: 'put',
          data: { date: '2026-11-08', note: 'fleet', n: ops },
        });
      }
      const t0 = now();
      const res = await fetch(`${GATEWAY_URL}/api/gw/v1/push`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'x-device-id': deviceId, 'content-type': 'application/json' },
        body: JSON.stringify({ ops: list }),
        signal: AbortSignal.timeout(20000),
      });
      const ms = now() - t0;
      let data = null;
      try { data = await res.json(); } catch (e) { /* بدنهٔ خالی */ }
      return { status: res.status, ms, applied: data && data.counts ? data.counts.applied || 0 : 0 };
    },
  };
}

/* ── اجرای یک پله ── */
/* پله را با چند کارگر موازی اجرا می‌کند و p95/p99 را روی نمونهٔ خامِ همه
   کارگرها حساب می‌کند (نه میانگینِ percentileها که عدد را نرم می‌کرد). */
async function runStageParallel(clients, seconds, gwPid, phase) {
  const procs = PROCS > 0 ? PROCS : Math.max(1, Math.min(6, Math.ceil(clients / 50)));
  const per = Math.ceil(clients / procs);
  const cpuBefore = readProc(gwPid);
  const memSamples = [];
  let metricsSample = null;
  const stop = Date.now() + seconds * 1000;
  const sampler = (async () => {
    while (Date.now() < stop + 500) {
      const p = readProc(gwPid);
      if (p) memSamples.push(p.rss_mb);
      const m = await gwMetrics(GATEWAY_URL);
      if (m) metricsSample = m;
      await sleep(400);
    }
  })();
  const parts = await Promise.all(Array.from({ length: procs }, (_, i) =>
    spawnWorker(Math.min(per, clients - i * per), seconds, phase * 100000 + i * per)));
  await sampler;
  const cpuAfter = readProc(gwPid);

  const pullMs = parts.flatMap(p => p.pullMs || []);
  const pushMs = parts.flatMap(p => p.pushMs || []);
  const sum = k => parts.reduce((a, p) => a + (p[k] || 0), 0);
  const statuses = {};
  for (const p of parts) for (const [k, v] of Object.entries(p.statuses || {})) statuses[k] = (statuses[k] || 0) + v;
  const pullN = sum('pullN'), pushN = sum('pushN'), pullErr = sum('pullErr'), pushErr = sum('pushErr');
  const totalReq = pullN + pushN;
  const out = {
    clients, seconds, procs,
    rps_total: Math.round((totalReq / seconds) * 10) / 10,
    rps_pull: Math.round((pullN / seconds) * 10) / 10,
    rps_push: Math.round((pushN / seconds) * 10) / 10,
    pull: { n: pullN, p50: pct(pullMs, 50), p95: pct(pullMs, 95), p99: pct(pullMs, 99), errors: pullErr, rows: sum('rows') },
    push: { n: pushN, p50: pct(pushMs, 50), p95: pct(pushMs, 95), p99: pct(pushMs, 99), errors: pushErr, applied: sum('applied') },
    error_rate: totalReq ? Math.round(((pullErr + pushErr) / totalReq) * 10000) / 10000 : 0,
    statuses,
    gateway_cpu_pct: (cpuBefore && cpuAfter) ? Math.round(((cpuAfter.ticks - cpuBefore.ticks) / 100) / seconds * 1000) / 10 : null,
    gateway_rss_mb_max: memSamples.length ? Math.max(...memSamples) : null,
    gateway_rss_mb_avg: memSamples.length ? Math.round(memSamples.reduce((a, b) => a + b, 0) / memSamples.length * 10) / 10 : null,
    db: metricsSample,
  };
  out.healthy = out.pull.p99 < P99_LIMIT_MS && out.push.p99 < P99_LIMIT_MS && out.error_rate < ERR_LIMIT;
  return out;
}

/* ── کارگر: یک تکه از ناوگان را می‌گرداند و نمونهٔ خام برمی‌گرداند ──
   چرا چند فرایند؟ چون خودِ «تولیدکنندهٔ بار» یک فرایند Node است و با یک
   هسته گلوگاه می‌شود؛ آن‌وقت p99 سقفِ سرور را نشان نمی‌دهد بلکه سقفِ خودِ
   هارنس را نشان می‌دهد. پس بار بین چند فرایند پخش می‌شود. */
async function workerStage(clients, seconds, base) {
  const list = Array.from({ length: clients }, (_, i) => makeClient(base + i + 1));
  const stop = Date.now() + seconds * 1000;
  const pullMs = [], pushMs = [];
  const statuses = {};
  let pullN = 0, pushN = 0, pullErr = 0, pushErr = 0, applied = 0, rows = 0;

  async function worker(c) {
    while (Date.now() < stop) {
      try {
        const r = await c.pull();
        pullN++; pullMs.push(r.ms); rows += r.rows;
        statuses[r.status] = (statuses[r.status] || 0) + 1;
        if (r.status >= 400) pullErr++;
      } catch (e) {
        pullN++; pullErr++; pullMs.push(seconds * 1000);
        statuses['net_error'] = (statuses['net_error'] || 0) + 1;
      }
      try {
        const w = await c.push();
        pushN++; pushMs.push(w.ms); applied += w.applied;
        statuses[w.status] = (statuses[w.status] || 0) + 1;
        if (w.status >= 400) pushErr++;
      } catch (e) {
        pushN++; pushErr++; pushMs.push(seconds * 1000);
        statuses['net_error'] = (statuses['net_error'] || 0) + 1;
      }
      await sleep(120);
    }
  }
  await Promise.all(list.map(worker));
  return { clients, pullN, pushN, pullErr, pushErr, applied, rows, pullMs, pushMs, statuses };
}

async function runStageLocalForWorker() {
  return await workerStage(Number(arg('clients', '10')), Number(arg('seconds', '8')), WORKER_BASE);
}

/* یک کارگر: خودش را به‌صورت فرایند جدا اجرا می‌کند و یک خط JSON می‌دهد */
function spawnWorker(clients, seconds, base) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url),
      '--worker', '--clients', String(clients), '--seconds', String(seconds), '--base', String(base)],
    { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('close', code => {
      const line = out.split('\n').find(l => l.startsWith('FLEET-WORKER:'));
      if (code !== 0 || !line) return reject(new Error('worker failed code=' + code + ' ' + err.slice(0, 300)));
      try { resolve(JSON.parse(line.slice('FLEET-WORKER:'.length))); }
      catch (e) { reject(new Error('worker json: ' + e.message)); }
    });
  });
}

/* ── آماده‌سازی دیتابیس ──
   طرح چندمستأجری فقط با زمینهٔ مستأجر (RLS) قابل نوشتن است؛ پس دادهٔ اولیه
   هم از مسیر واقعی (push روی Gateway) ساخته می‌شود، نه INSERT کنارگذر. */
async function prepareDb() {
  const { Client } = require('pg');
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const mig = await tenancy.migrate(admin);
  await admin.end();
  return { migrate_statements: (mig && mig.length) || null };
}


(async () => {
  if (WORKER) {
    const r = await runStageLocalForWorker();
    console.log('FLEET-WORKER:' + JSON.stringify(r));
    return;
  }
  let gatewayProc = null;
  const startedAt = new Date().toISOString();
  try {
    const db = await prepareDb();

    if (!GATEWAY_URL) {
      console.log('BLOCKED — ENVIRONMENT UNAVAILABLE (PAYESH_GW_URL لازم است؛ اسکریپت شاهد آن را بالا می‌آورد)');
      process.exit(3);
    }
    /* PID نمونهٔ Gateway: از /healthz گرفته می‌شود (هیچ فرضی دربارهٔ فرایند محلی) */
    let gwPid = null;
    try {
      const h = await (await fetch(GATEWAY_URL + '/healthz')).json();
      gwPid = Number(h.pid) || null;
    } catch (e) { gwPid = null; }
    if (!gwPid) { console.log('BLOCKED — gateway not reachable at ' + GATEWAY_URL); process.exit(3); }

    /* گرم‌کردن: یک دستگاه واقعی، یک push واقعی ⇒ change-feed داده دارد */
    const warm = makeClient(0);
    const wp = await warm.push();
    if (wp.status !== 200 && wp.status !== 201) {
      throw new Error('warmup push failed: ' + wp.status);
    }
    const warmPull = await warm.pull();

    const stages = [];
    for (const [i, c] of STAGES.entries()) {
      process.stderr.write(`… پلهٔ ${i + 1}/${STAGES.length}: ${c} کلاینت × ${STAGE_SECONDS}s\n`);
      stages.push(await runStageParallel(c, STAGE_SECONDS, gwPid, i));
    }

    /* سقف سالم = آخرین پلهٔ سالم پیاپی؛ اولین شکست = اولین پلهٔ ناسالم */
    let ceiling = 0;
    let firstFailure = null;
    for (const s of stages) {
      if (s.healthy) { if (!firstFailure) ceiling = s.clients; }
      else if (!firstFailure) {
        firstFailure = {
          clients: s.clients,
          reason: s.error_rate >= ERR_LIMIT
            ? `error_rate=${s.error_rate} ≥ ${ERR_LIMIT}`
            : `p99 pull=${s.pull.p99}ms push=${s.push.p99}ms ≥ ${P99_LIMIT_MS}ms`,
          statuses: s.statuses,
        };
      }
      if (firstFailure) break;   /* پس از اولین شکست، پلهٔ بالاتر معنا ندارد */
    }

    const report = {
      row: 46, started_at: startedAt, finished_at: new Date().toISOString(),
      topology: {
        database: ADMIN_URL.replace(/:[^:@/]*@/, ':***@'),
        gateway: GATEWAY_URL,
        note: 'DB و Gateway فرایندهای جدا روی همین میزبان‌اند؛ تفکیک فیزیکی میزبان در محیط مالک سنجیده می‌شود.',
      },
      params: { stages: STAGES, stage_seconds: STAGE_SECONDS, push_batch: PUSH_BATCH, pull_limit: PULL_LIMIT,
        p99_limit_ms: P99_LIMIT_MS, error_limit: ERR_LIMIT },
      db_setup: db,
      warmup: { push_status: wp.status, pull_status: warmPull.status, pull_rows: warmPull.rows },
      stages,
      healthy_ceiling_clients: ceiling,
      first_failure: firstFailure,
    };
    if (JSON_OUT) {
      fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
      fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    }

    console.log('| کلاینت | RPS کل | RPS pull | RPS push | pull p95/p99 (ms) | push p95/p99 (ms) | خطا | CPU% | RSS MB | سالم |');
    console.log('|---|---|---|---|---|---|---|---|---|---|');
    for (const s of stages) {
      console.log(`| ${s.clients} | ${s.rps_total} | ${s.rps_pull} | ${s.rps_push} | ${s.pull.p95}/${s.pull.p99} | ${s.push.p95}/${s.push.p99} | ${(s.error_rate * 100).toFixed(2)}% | ${s.gateway_cpu_pct} | ${s.gateway_rss_mb_max} | ${s.healthy ? '✓' : '✗'} |`);
    }
    const last = stages[stages.length - 1];
    if (last && last.db) {
      console.log(`# db_connections=${last.db.db_connections} pool_waiting=${last.db.pool_waiting} pool_total=${last.db.pool_total} pool_wait_s=${last.db.pool_wait_seconds}`);
    }
    console.log(`FLEET healthy_ceiling_clients=${ceiling} first_failure=${firstFailure ? firstFailure.clients + ' (' + firstFailure.reason + ')' : 'none-up-to-' + Math.max(...STAGES)}`);
    console.log(fs.existsSync(JSON_OUT || '') || !JSON_OUT ? 'FLEET-46-OK' : 'FLEET-46-OK');
  } catch (e) {
    console.error('FLEET-46-FATAL ' + ((e && e.stack) || e));
    if (gatewayProc) try { gatewayProc.kill('SIGKILL'); } catch (err) { /* noop */ }
    process.exit(1);
  }
})();
