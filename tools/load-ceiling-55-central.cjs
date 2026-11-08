#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   اندازه‌گیری سقف همزمانی — ردیف ۵۵ (Go/No-Go) — نمونهٔ مرکزی روی PG واقعی

   مانند tools/load-ceiling-55.cjs ولی به جای سرور محلی SQLite، gateway مرکزی
   (PostgreSQL واقعی) را با نشست‌های واقعی دستگاه‌ها بار می‌دهد. مسیر اصلی:
   GET /api/gw/v1/pull. خروجی: p50/p95/max latency، RPS، خطا، و «سقف سالم» =
   بالاترین سطحی که p95<=300ms و خطا<=1%.

   اجرا:
     PAYESH_GATEWAY_URL=http://127.0.0.1:5662 PAYESH_TENANCY_SECRET=... \
     TENANT=33333333-... node tools/load-ceiling-55-central.cjs \
       [--levels 10,25,50,100,200,400] [--hold 8] [--pull-limit 200]
   خروجی: docs/cloud/reports/evidence/load-55-ceiling-central-pg.json

   توجه: این یک نمونهٔ توسعه روی همین ماشین است؛ اعداد سقف روی سخت‌افزار
   تولید باید جداگانه سنجیده شود (ولی روش و ابزار همین است).
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

const GW = process.env.PAYESH_GATEWAY_URL || 'http://127.0.0.1:5662';
const SECRET = process.env.PAYESH_TENANCY_SECRET || '';
const TENANT = process.env.TENANT || '33333333-3333-3333-3333-333333333333';
const LEVELS = String(opt('levels', '10,25,50,100,200,400')).split(',').map(Number);
const HOLD_S = Number(opt('hold', 8));
const PULL_LIMIT = Number(opt('pull-limit', 200));
const OUT = path.join(ROOT, 'docs/cloud/reports/evidence/load-55-ceiling-central-pg.json');

if (!SECRET) { console.error('BLOCKED — PAYESH_TENANCY_SECRET لازم است'); process.exit(3); }

const tenancy = require(path.join(ROOT, 'server/tenancy.js'));
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; /* ms */
function pct(arr, p) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return Math.round(a[i] * 100) / 100;
}

async function readyz() {
  try {
    const r = await fetch(GW + '/readyz', { signal: AbortSignal.timeout(4000) });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) { return { status: 0, body: { error: String(e.message || e) } }; }
}
async function healthBase() {
  try {
    const t0 = now();
    await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: portOf, path: '/healthz', agent }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', resolve);
    });
    return Math.round((now() - t0) * 100) / 100;
  } catch (e) { return null; }
}

const http = require('http');
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
function pullOnce(token, deviceId, sinceSeq, limit) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const p = `/api/gw/v1/pull?since_seq=${sinceSeq}&limit=${limit}`;
    const req = http.get({ host: '127.0.0.1', port: portOf, path: p, agent,
      headers: { authorization: 'Bearer ' + token, 'x-device-id': deviceId } }, res => {
      let body = '';
      res.on('data', c => { if (body.length < 4194304) body += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode, ms: Number(process.hrtime.bigint() - start) / 1e6, body });
      });
    });
    req.on('error', e => resolve({ status: 0, ms: Number(process.hrtime.bigint() - start) / 1e6, body: '' }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, ms: 20000, body: '' }); });
  });
}
const portOf = Number(String(GW).replace(/^.*:(\d+)\/?$/, '$1'));

function makeClient(index, level) {
  const deviceId = `ceil55-${level}-${index}`;
  const token = tenancy.signToken({
    tid: TENANT, role: 'manager', uid: 'ceil55-u-' + (index % 500),
    did: deviceId, iat: Date.now(), exp: Date.now() + 3600_000,
  }, SECRET);
  let sinceSeq = 0;
  return {
    id: deviceId,
    async pull(deadline) {
      const lat = [];
      const statuses = {};
      let rows = 0, reqs = 0;
      while (now() < deadline) {
        const r = await pullOnce(token, deviceId, sinceSeq, PULL_LIMIT);
        let nextSeq = null;
        try { const j = JSON.parse(r.body); if (j && j.next_seq != null) nextSeq = Number(j.next_seq); if (j && Array.isArray(j.rows)) rows += j.rows.length; } catch (e) { /* non-json */ }
        if (r.status === 200 && nextSeq != null) sinceSeq = nextSeq;
        lat.push(r.ms);
        statuses[String(r.status)] = (statuses[String(r.status)] || 0) + 1;
        reqs++;
      }
      return { lat, statuses, rows, reqs };
    },
  };
}

(async () => {
  const startedAt = new Date().toISOString();
  const baseHealth = await healthBase();
  const ready = await readyz();
  console.log('gateway readyz:', JSON.stringify(ready));
  console.log('baseline /healthz ms:', baseHealth);

  const results = [];
  for (const level of LEVELS) {
    const clients = [];
    for (let i = 0; i < level; i++) clients.push(makeClient(i, level));
    const t0 = now();
    const deadline = t0 + HOLD_S * 1000;
    const reps = await Promise.all(clients.map(c => c.pull(deadline)));
    const dur = (now() - t0) / 1000;
    const lat = reps.flatMap(r => r.lat);
    const statuses = {};
    let rows = 0, reqs = 0;
    for (const r of reps) {
      for (const [k, v] of Object.entries(r.statuses)) statuses[k] = (statuses[k] || 0) + v;
      rows += r.rows; reqs += r.reqs;
    }
    const errs = Object.entries(statuses).reduce((s, [k, v]) => (k === '200' ? s : s + v), 0);
    const errPct = reqs ? errs / reqs : 0;
    const rec = {
      level,
      duration_s: Math.round(dur * 100) / 100,
      rps: Math.round(reqs / dur),
      requests: reqs,
      p50_ms: pct(lat, 50), p95_ms: pct(lat, 95), p99_ms: pct(lat, 99), max_ms: Math.round(Math.max(...lat) * 100) / 100,
      rows_pulled: rows,
      error_pct: Math.round(errPct * 10000) / 100,
      statuses,
    };
    results.push(rec);
    console.log(`level ${level}: rps=${rec.rps} p50=${rec.p50_ms} p95=${rec.p95_ms} max=${rec.max_ms} err=${rec.error_pct}%`);
    await new Promise(r => setTimeout(r, 1500)); /* برداشتن نفس بین سطح‌ها */
  }

  const ceiling = results.filter(r => r.p95_ms <= 300 && r.error_pct <= 1).map(r => r.level);
  const healthyCeiling = ceiling.length ? Math.max(...ceiling) : 0;
  const payload = {
    generated_at: startedAt, host: os.hostname(), node: process.version, platform: os.platform(),
    gateway: GW, tenant: TENANT, pull_limit: PULL_LIMIT, hold_s: HOLD_S, levels: LEVELS,
    gateway_readyz: ready, baseline_healthz_ms: baseHealth,
    pg_pool_max: process.env.PAYESH_PG_POOL_MAX || null,
    results, healthy_ceiling: healthyCeiling,
    ceiling_rule: 'p95<=300ms and error<=1%',
    note: 'نمونهٔ توسعه روی همین ماشین؛ سخت‌افزار تولید باید جداگانه سنجیده شود.',
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log('healthy ceiling:', healthyCeiling);
  console.log('نوشته شد:', OUT);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
