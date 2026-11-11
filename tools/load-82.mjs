#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Row 82: load and measurement script (zero dependencies, autocannon-style)

   Thousands of virtual devices across many tenants talk to a real
   Gateway (server/gateway.js) backed by real PostgreSQL.
   Each device holds its own token, its X-Device-Id and its own pull
   cursor (since_seq). Requests are a pull/push mix, sent closed-loop
   by N concurrent workers over keep-alive connections.

   Output: a raw JSON report with
     latency p50/p95/p99/max (all requests, plus per route)
     error rate and status histogram
     throughput
     gateway RSS sampled every second, with the slope over the
       measured window (leak detector)
   Every number in the report and the summary carries the label [S]
   (simulated: CI runner, synthetic devices). The label [M] (measured on
   the owner's managed database) is refused unless
   PAYESH_T2_MANAGED_DB=1 is set. That is OWNER-only (T2) and never set in CI.
   The report must never claim "unlimited" capacity: claimsGate() refuses it.

   CLI:
     node tools/load-82.mjs --base http://127.0.0.1:8080 --secret $GW_SECRET \
       [--devices 2000] [--tenants 20] [--duration 30] [--concurrency 64] \
       [--push-ratio 0.2] [--warmup 5] [--gw-pid PID] [--out report.json] \
       [--label S|M] [--max-error-rate 0.005] [--max-p95-ms 1000] \
       [--max-rss-slope-mb-min 30] [--min-rss-growth-mb 24]
   Exit: 0 every gate green · 1 a gate red · 2 bad usage
   Prints LOAD-82-OK / LOAD-82-FAILED <gates>.
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tenancy = require(path.join(ROOT, 'server', 'tenancy.js'));

export const DEFAULTS = Object.freeze({
  devices: 2000, tenants: 20, duration: 30, concurrency: 64, pushRatio: 0.2, warmup: 5,
  label: 'S', maxErrorRate: 0.005, maxP95Ms: 1000, maxRssSlopeMbMin: 30, minRssGrowthMb: 24,
});
/* SLO source: deploy/monitoring/slo-85.yml (availability 99.5% ⇒ error budget 0.5%; latency p95 ≤ 1000 ms) */

const FORBIDDEN_CLAIMS = [/unlimited/i, /infinite/i, /no\s+limit/i, /نامحدود/, /بی‌?نهایت/, /بدون\s+محدودیت/];

export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round(sorted[i] * 10) / 10;
}
export function slope(points) {                 /* least squares: y per x */
  const n = points.length;
  if (n < 3) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of points) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const d = n * sxx - sx * sx;
  return d === 0 ? 0 : (n * sxy - sx * sy) / d;
}
export function rssMb(pid) {
  try {
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Math.round(Number(m[1]) / 102.4) / 10 : null;
  } catch (e) { return null; }
}

/** leak verdict from RSS samples [{t_s, rss_mb}] after warmup */
export function leakVerdict(samples, warmupS, o = {}) {
  const maxSlope = o.maxRssSlopeMbMin ?? DEFAULTS.maxRssSlopeMbMin;
  const minGrowth = o.minRssGrowthMb ?? DEFAULTS.minRssGrowthMb;
  const w = samples.filter(s => s.t_s >= warmupS && s.rss_mb != null);
  if (w.length < 5) return { label: '[S]', measured: false, reason: 'too few RSS samples', leak_suspected: false };
  const k = Math.max(1, Math.floor(w.length / 3));
  const avg = (a) => a.reduce((s, x) => s + x.rss_mb, 0) / a.length;
  const first = avg(w.slice(0, k)), last = avg(w.slice(-k));
  const perMin = slope(w.map(s => [s.t_s, s.rss_mb])) * 60;
  const growth = last - first;
  const leak = perMin > maxSlope && growth > minGrowth;
  return {
    label: '[S]', measured: true, samples: w.length,
    start_mb: w[0].rss_mb, end_mb: w[w.length - 1].rss_mb, peak_mb: Math.max(...w.map(s => s.rss_mb)),
    first_third_avg_mb: Math.round(first * 10) / 10, last_third_avg_mb: Math.round(last * 10) / 10,
    growth_mb: Math.round(growth * 10) / 10, slope_mb_per_min: Math.round(perMin * 10) / 10,
    thresholds: { max_slope_mb_per_min: maxSlope, min_growth_mb: minGrowth },
    leak_suspected: leak,
  };
}

/** claim gate: every report must be labelled and must not claim unlimited capacity */
export function claimsGate(report, text) {
  const errs = [];
  const body = text != null ? text : JSON.stringify(report);
  for (const re of FORBIDDEN_CLAIMS) if (re.test(body)) errs.push('forbidden_claim:' + re.source);
  if (!report || (report.label !== '[S]' && report.label !== '[M]')) errs.push('missing_label');
  if (report && report.label === '[M]' && !(report.environment && report.environment.managed_db_attested)) errs.push('label_M_without_managed_db');
  for (const k of ['latency_ms', 'errors', 'throughput', 'memory']) {
    if (report && report[k] && report[k].label !== report.label) errs.push('unlabelled:' + k);
  }
  return errs;
}

export function gates(report, o = {}) {
  const red = [];
  const maxErr = o.maxErrorRate ?? DEFAULTS.maxErrorRate;
  const maxP95 = o.maxP95Ms ?? DEFAULTS.maxP95Ms;
  if (report.errors.rate > maxErr) red.push(`error_rate ${report.errors.rate} > ${maxErr}`);
  if (report.latency_ms.all.p95 == null || report.latency_ms.all.p95 > maxP95) red.push(`p95 ${report.latency_ms.all.p95}ms > ${maxP95}ms`);
  if (report.memory.leak_suspected) red.push(`memory_leak slope=${report.memory.slope_mb_per_min}MB/min growth=${report.memory.growth_mb}MB`);
  if (report.requests.total < 100) red.push('too_few_requests ' + report.requests.total);
  for (const e of claimsGate(report)) red.push(e);
  return red;
}

export async function run(opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  if (!o.base || !o.secret) throw Object.assign(new Error('--base and --secret are required'), { usage: true });
  const label = String(o.label || 'S').toUpperCase() === 'M' ? 'M' : 'S';
  if (label === 'M' && process.env.PAYESH_T2_MANAGED_DB !== '1') {
    throw Object.assign(new Error('label [M] is OWNER-only: set PAYESH_T2_MANAGED_DB=1 on the managed T2 database run'), { usage: true, code: 'label_m_refused' });
  }
  const L = '[' + label + ']';
  const run = crypto.randomBytes(3).toString('hex');
  const devices = [];
  for (let i = 0; i < o.devices; i++) {
    const t = i % o.tenants;
    const tid = `82828282-${String(t).padStart(4, '0')}-4000-8000-${run.padStart(12, '0')}`;
    const did = `ld82-${t}-${i}`;
    const tok = tenancy.signToken({ tid, role: 'manager', uid: 1, did, iat: Date.now(), exp: Date.now() + (o.duration + 600) * 1000 }, o.secret);
    devices.push({ tid, did, headers: { authorization: 'Bearer ' + tok, 'x-device-id': did, 'content-type': 'application/json' }, seq: 0, n: 0 });
  }
  const lat = { all: [], pull: [], push: [] };
  const statuses = {};
  const samples = [];
  let total = 0, errors = 0, measured = 0, cursor = 0, stop = false;
  const t0 = Date.now();
  const warmupMs = o.warmup * 1000;
  const endAt = t0 + (o.warmup + o.duration) * 1000;
  let rng = Number.parseInt(run, 16) || 82;
  const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };

  const sampler = setInterval(() => {
    samples.push({ t_s: Math.round((Date.now() - t0) / 100) / 10, rss_mb: o.gwPid ? rssMb(o.gwPid) : null, total, errors });
  }, 1000);

  async function one() {
    const d = devices[cursor++ % devices.length];
    const isPush = rnd() < o.pushRatio;
    const t = process.hrtime.bigint();
    let status;
    try {
      let r;
      if (isPush) {
        const ops = [];
        const k = 1 + Math.floor(rnd() * 3);
        for (let j = 0; j < k; j++) ops.push({ uid: `${d.did}-${run}-${++d.n}`, collection: 'homework', id: (Number(d.did.split('-')[2]) * 1000) + (d.n % 50) + 1, type: 'put', data: { title: 'load ' + d.n, note: 'x'.repeat(40) } });
        r = await fetch(o.base + '/api/gw/v1/push', { method: 'POST', headers: d.headers, body: JSON.stringify({ ops }) });
      } else {
        r = await fetch(`${o.base}/api/gw/v1/pull?since_seq=${d.seq}&limit=50`, { headers: d.headers });
      }
      status = r.status;
      const body = await r.json().catch(() => null);
      if (!isPush && body && body.next_seq != null) d.seq = Number(body.next_seq) || d.seq;
    } catch (e) { status = 'net'; }
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    const inWindow = Date.now() - t0 >= warmupMs;
    total++;
    if (inWindow) {
      measured++;
      lat.all.push(ms); (isPush ? lat.push : lat.pull).push(ms);
      statuses[status] = (statuses[status] || 0) + 1;
      if (status !== 200) errors++;
    }
  }
  async function worker() { while (!stop && Date.now() < endAt) await one(); }
  await Promise.all(Array.from({ length: o.concurrency }, worker));
  stop = true;
  clearInterval(sampler);
  samples.push({ t_s: Math.round((Date.now() - t0) / 100) / 10, rss_mb: o.gwPid ? rssMb(o.gwPid) : null, total, errors });
  const wall = (Date.now() - t0 - warmupMs) / 1000;
  const stat = (a) => { const s = a.slice().sort((x, y) => x - y); return { label: L, n: s.length, p50: quantile(s, 0.5), p95: quantile(s, 0.95), p99: quantile(s, 0.99), max: s.length ? Math.round(s[s.length - 1] * 10) / 10 : null }; };
  const memory = o.gwPid ? leakVerdict(samples, o.warmup, o) : { label: '[S]', measured: false, reason: 'no --gw-pid', leak_suspected: false };
  memory.label = L;
  const report = {
    row: 82, label: L,
    claim_scope: label === 'S'
      ? 'simulated: synthetic devices against one gateway process + PostgreSQL on a CI runner; describes this run only, not production capacity'
      : 'measured on the owner-managed database (T2)',
    date_utc: new Date().toISOString(), node: process.version,
    environment: { base: o.base, gw_pid: o.gwPid || null, managed_db_attested: label === 'M' },
    config: { devices: o.devices, tenants: o.tenants, duration_s: o.duration, warmup_s: o.warmup, concurrency: o.concurrency, push_ratio: o.pushRatio },
    requests: { label: L, total, measured },
    latency_ms: { label: L, all: stat(lat.all), pull: stat(lat.pull), push: stat(lat.push) },
    errors: { label: L, count: errors, rate: measured ? Math.round((errors / measured) * 1e5) / 1e5 : 1, statuses },
    throughput: { label: L, rps: wall > 0 ? Math.round(measured / wall) : 0, devices_active: Math.min(o.devices, total) },
    memory,
    rss_samples: samples,
  };
  report.gates = { label: L, thresholds: { max_error_rate: o.maxErrorRate, max_p95_ms: o.maxP95Ms, max_rss_slope_mb_min: o.maxRssSlopeMbMin, min_rss_growth_mb: o.minRssGrowthMb }, red: [] };
  report.gates.red = gates(report, o);
  report.verdict = report.gates.red.length ? 'FAILED' : 'OK';
  return report;
}

export function summary(r) {
  const l = r.label;
  return [
    `${l} row 82 load: devices=${r.config.devices} tenants=${r.config.tenants} concurrency=${r.config.concurrency} duration=${r.config.duration_s}s (+${r.config.warmup_s}s warmup)`,
    `${l} requests=${r.requests.measured} rps=${r.throughput.rps}`,
    `${l} latency ms all p50=${r.latency_ms.all.p50} p95=${r.latency_ms.all.p95} p99=${r.latency_ms.all.p99} max=${r.latency_ms.all.max}`,
    `${l} latency ms pull p50=${r.latency_ms.pull.p50} p95=${r.latency_ms.pull.p95} p99=${r.latency_ms.pull.p99} · push p50=${r.latency_ms.push.p50} p95=${r.latency_ms.push.p95} p99=${r.latency_ms.push.p99}`,
    `${l} errors=${r.errors.count} rate=${r.errors.rate} statuses=${JSON.stringify(r.errors.statuses)}`,
    `${l} memory rss start=${r.memory.start_mb}MB end=${r.memory.end_mb}MB peak=${r.memory.peak_mb}MB growth=${r.memory.growth_mb}MB slope=${r.memory.slope_mb_per_min}MB/min leak_suspected=${r.memory.leak_suspected}`,
    `${l} scope: ${r.claim_scope}`,
  ].join('\n');
}

function parseArgs(argv) {
  const o = {};
  const map = { devices: 'devices', tenants: 'tenants', duration: 'duration', concurrency: 'concurrency', 'push-ratio': 'pushRatio', warmup: 'warmup', 'gw-pid': 'gwPid', 'max-error-rate': 'maxErrorRate', 'max-p95-ms': 'maxP95Ms', 'max-rss-slope-mb-min': 'maxRssSlopeMbMin', 'min-rss-growth-mb': 'minRssGrowthMb' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2); const v = argv[i + 1]; i++;
    if (k === 'base') o.base = v; else if (k === 'secret') o.secret = v; else if (k === 'out') o.out = v; else if (k === 'label') o.label = v;
    else if (map[k]) o[map[k]] = Number(v);
    else throw Object.assign(new Error('unknown flag --' + k), { usage: true });
  }
  if (!o.secret && process.env.LOAD82_GW_SECRET) o.secret = process.env.LOAD82_GW_SECRET;
  return o;
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  let r;
  try { r = await run(o); } catch (e) { console.error('LOAD-82-FAILED usage: ' + e.message); process.exit(2); }
  if (o.out) fs.writeFileSync(o.out, JSON.stringify(r, null, 2) + '\n');
  console.log(summary(r));
  console.log(r.verdict === 'OK' ? 'LOAD-82-OK' : 'LOAD-82-FAILED ' + r.gates.red.join(' | '));
  process.exit(r.verdict === 'OK' ? 0 : 1);
}

let isMain = false;
try { isMain = !!process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url; } catch (e) { isMain = false; }
if (isMain) main();
