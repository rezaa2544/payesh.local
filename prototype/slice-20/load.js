'use strict';
// راه‌انداز بار: افزایش پله‌ای هم‌زمانی، سنجش واقعی تأخیر/خطا، و بازتولیدپذیری با بذر ثابت.
// هیچ زمانی ساختگی نیست؛ تنها زمان‌های سنجیده‌شده در گزارش می‌آید.

const { sha256 } = require('../slice-19/conflict-server');
const { summarize, classify, round, stableStringify } = require('./metrics');

const COLLECTION = 'attendance';

class LCG {
  constructor(seed) { this.s = (seed >>> 0) || 1; }
  next() { this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0; return this.s; }
  int(n) { return this.next() % n; }
}

const hrMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;

function wireOp({ op_id, collection = COLLECTION, record_id, base_version, payload }) {
  return { op_id, collection, record_id, base_version, payload, payload_hash: sha256(JSON.stringify(payload)) };
}

async function seedRecords(gateway, session, ids, { collection = COLLECTION } = {}) {
  const ops = ids.map((record_id, i) => wireOp({
    op_id: `seed-${record_id}`,
    collection, record_id, base_version: 0, payload: { status: 'present', note: 'seed' },
  }));
  for (let i = 0; i < ops.length; i += 200) {
    const res = await gateway.push(session, ops.slice(i, i + 200));
    const bad = res.results.filter((r) => r.status !== 'applied');
    if (bad.length) throw new Error(`seed failed: ${JSON.stringify(bad[0])}`);
  }
  return ids.length;
}

// مرحلهٔ بار: هر کارگر روی ردیف‌های خودش کار می‌کند ⇒ نسخه‌ها قطعی و بی‌رقابت‌اند
async function runStage({
  gateway, sessions, workers = 8, opsPerWorker = 120, readRatio = 0.5, seed = 7, label = 'stage',
  recordsPerWorker = 8, collection = COLLECTION,
}) {
  if (!sessions.length) throw new Error('sessions required');
  const perWorkerIds = [];
  for (let w = 0; w < workers; w++) {
    perWorkerIds.push(Array.from({ length: recordsPerWorker }, (_, k) => `${label}-w${w}-r${k}`));
  }
  for (let w = 0; w < workers; w++) {
    await seedRecords(gateway, sessions[w % sessions.length], perWorkerIds[w], { collection });
  }

  const t0 = hrMs();
  const stats = {
    reads: 0, writes: 0, readOk: 0, writeOk: 0, notFound: 0, retries: 0,
    errors: {}, readLat: [], writeLat: [],
  };
  const bump = (k) => { stats.errors[k] = (stats.errors[k] || 0) + 1; };

  const worker = async (w) => {
    const rnd = new LCG(seed + w * 7919);
    const session = sessions[w % sessions.length];
    const ids = perWorkerIds[w];
    const version = new Map(ids.map((id) => [id, 1]));   // ردیف‌های بذر: نسخهٔ ۱
    for (let i = 0; i < opsPerWorker; i++) {
      const target = ids[rnd.int(ids.length)];
      const isRead = rnd.int(1000) < Math.round(readRatio * 1000);
      if (isRead) {
        stats.reads++;
        const s0 = hrMs();
        try {
          await gateway.read(session, { collection, record_id: target });
          stats.readOk++;
          stats.readLat.push(hrMs() - s0);
        } catch (e) {
          const k = classify(e);
          if (k === 'not_found') stats.notFound++; else bump(k);
        }
      } else {
        stats.writes++;
        const base = version.get(target) ?? 1;
        const s0 = hrMs();
        try {
          const res = await gateway.push(session, [wireOp({
            op_id: `${label}-${session.device_id}-w${w}-${i}`, collection,
            record_id: target, base_version: base, payload: { status: i % 2 ? 'late' : 'present', note: `n${i}` },
          })]);
          const r = res.results[0];
          if (r.status === 'applied') { stats.writeOk++; version.set(target, base + 1); stats.writeLat.push(hrMs() - s0); }
          else if (r.status === 'conflict' || r.status === 'ordering') { stats.retries++; }
          else bump(r.status);
        } catch (e) { bump(classify(e)); }
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)));
  const elapsedMs = round(hrMs() - t0, 1);
  const ops = stats.reads + stats.writes;
  const hardFailures = ['outage', 'network', '5xx', 'other', 'auth', 'forbidden', '4xx', 'rate_limited']
    .reduce((acc, k) => acc + (stats.errors[k] || 0), 0) + Object.entries(stats.errors)
    .filter(([k]) => !['outage', 'network', '5xx', 'other', 'auth', 'forbidden', '4xx', 'rate_limited'].includes(k))
    .reduce((acc, [, v]) => acc + v, 0);

  return {
    label, workers, ops, opsPerWorker, readRatio, seed,
    reads: stats.reads, writes: stats.writes,
    readOk: stats.readOk, writeOk: stats.writeOk,
    notFound: stats.notFound, retries: stats.retries,
    errors: stats.errors,
    failures: hardFailures,
    errorRate: ops ? round(hardFailures / ops, 6) : 0,
    rps: elapsedMs > 0 ? Math.round((ops / elapsedMs) * 1000) : 0,
    elapsedMs,
    latency: { read: summarize(stats.readLat), write: summarize(stats.writeLat) },
  };
}

// اثر انگشت وضعیت یک مستأجر — برای اثبات «همان ورودی ⇒ همان خروجی» و «بدون تکرار/گم‌شدن»
function stateHash(core, tenant) {
  const rows = [...core.records.entries()]
    .filter(([k]) => k.startsWith(`${tenant}|`))
    .map(([k, v]) => [k, v.version, v.fields])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(stableStringify(rows));
}

function countTenantRecords(core, tenant) {
  let n = 0;
  for (const k of core.records.keys()) if (k.startsWith(`${tenant}|`)) n++;
  return n;
}

module.exports = { LCG, wireOp, seedRecords, runStage, stateHash, countTenantRecords, COLLECTION };
