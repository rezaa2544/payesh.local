'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف‌های ۲۰۶/۲۰۷/۲۰۹ — هستهٔ executor نودی برای صف Helper (v1+v2)
   GitHub Actions (tools/helper-executor/run.mjs) از همین هسته استفاده می‌کند؛
   Cloudflare Worker همین منطق را با WebCrypto در worker.js دارد.
   چرخه: presence → فهرست req → ردِ نامجاز (canLease) → lease+توکن+بازخوانی
   → اجرا (runLocal) → نتیجه. اجارهٔ منقضی قابل‌برداشت است (۲۱۱: executor مرده
   کار را قفل نمی‌کند)؛ نتیجه با job_id یکتاست (تکرار اعمال نمی‌شود).
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const hj = require('./helper-jobs');
const s3mem = require('./s3mem');
const v2 = require('./helper-v2');

const LEASE_MS = 60_000;
const SETTLE_MS = 1500;

async function writePresence(cfg, me, { done = 0, failed = 0, now = Date.now() } = {}) {
  const plain = {
    v: 2, helper_id: me.id, host: String(me.host || me.cls).slice(0, 80), app: 'helper-executor',
    version: String(me.version || 'dp-1'), slots: me.capacity || 1, paused: false,
    kinds: me.caps, caps: me.caps, cls: me.cls, capacity: me.capacity || 1,
    cpu_cap: me.cpu_cap || null, region: me.region || '', contract: '2',
    school_id: me.school_id || null, at: now, done, failed,
  };
  await s3mem.put(cfg, cfg.prefix + hj.DIR.helpers + me.id + '.json',
    JSON.stringify(hj.seal(cfg.secret, hj.K.presence, now, JSON.stringify(plain))));
  return plain;
}

const readPlain = async (cfg, key, kind) => {
  try { return hj.open(cfg.secret, kind, JSON.parse(await s3mem.get(cfg, key))).plain; }
  catch (e) { return null; }
};

/* یک دور برداشت کار؛ حداکثر maxJobs کار. برمی‌گرداند: {claimed, done, failed, skipped} */
async function pollOnce(cfg, me, { maxJobs = 1, now = Date.now, settleMs = SETTLE_MS, sleep = (ms) => new Promise(r => setTimeout(r, ms)), runLocal = hj.runLocal } = {}) {
  const P = cfg.prefix;
  const out = { claimed: 0, done: 0, failed: 0, skipped: 0 };
  const { keys } = await hj.listAll(cfg, P + 'jobs/', 5);
  const names = keys.map(k => k.key.slice((P + 'jobs/').length));
  const has = (d, id) => names.includes(d + id + '.json');
  /* اولویت: high زودتر؛ بعد قدیمی‌تر (job_id با زمان شروع می‌شود) */
  const reqIds = names.filter(n => n.startsWith('req/')).map(n => n.slice(4, -5)).sort();
  const jobs = [];
  for (const id of reqIds) {
    const req = await readPlain(cfg, P + hj.DIR.req + id + '.json', hj.K.request);
    if (req && req.job_id === id) jobs.push(req);
  }
  jobs.sort((a, b) => {
    const pa = v2.PRIORITIES.indexOf(a.priority || 'normal'), pb = v2.PRIORITIES.indexOf(b.priority || 'normal');
    return pa - pb || String(a.job_id).localeCompare(String(b.job_id));
  });
  for (const req of jobs) {
    if (out.claimed >= maxJobs) break;
    const id = req.job_id;
    if (has('res/', id)) { out.skipped++; continue; }
    const meta = v2.normalizeJobMeta(req);
    if (meta.deadline_at && now() > meta.deadline_at) { out.skipped++; continue; }
    if (!v2.canLease(Object.assign({ helper_id: me.id, cls: me.cls, caps: me.caps, kinds: me.caps, capacity: me.capacity, school_id: me.school_id, online: true, at: now() }, {}), req)) { out.skipped++; continue; }
    if (has('lease/', id)) {
      const lease = await readPlain(cfg, P + hj.DIR.lease + id + '.json', hj.K.lease);
      if (lease && Number(lease.until) > now()) { out.skipped++; continue; }
      /* اجارهٔ منقضی: executor قبلی مرده ⇒ قابل برداشت (ردیف ۲۱۱) */
    }
    const token = crypto.randomBytes(8).toString('hex');
    const putLease = (at) => s3mem.put(cfg, P + hj.DIR.lease + id + '.json',
      JSON.stringify(hj.seal(cfg.secret, hj.K.lease, at, JSON.stringify({ v: 1, job_id: id, helper_id: me.id, token, until: at + LEASE_MS }))));
    await putLease(now());
    await sleep(settleMs);
    const back = await readPlain(cfg, P + hj.DIR.lease + id + '.json', hj.K.lease);
    if (!back || back.token !== token) { out.skipped++; continue; }
    out.claimed++;
    const started = now();
    let result = null, error = null;
    try { result = await runLocal(cfg, req.kind, req.params, { now }); }
    catch (e) { error = (e && e.code) || 'failed'; }
    await s3mem.put(cfg, P + hj.DIR.res + id + '.json',
      JSON.stringify(hj.seal(cfg.secret, hj.K.result, now(), JSON.stringify({
        v: 1, job_id: id, helper_id: me.id, ok: !error, result, error,
        idempotency_key: meta.idempotency_key, started_at: started, finished_at: now(),
      }))));
    if (error) out.failed++; else out.done++;
  }
  return out;
}

module.exports = { writePresence, pollOnce, LEASE_MS, SETTLE_MS };
