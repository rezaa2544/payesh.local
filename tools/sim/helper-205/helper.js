#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 205 — one «سرور کمکی» (helper) of the owner panel, headless.

   The real helper is apps/payesh/owner/lib/src/helper/helper_node.dart inside the
   Flutter owner app (it imports package:flutter, so it cannot run in a container
   without a display). This is the same protocol step by step, with the same
   timings (helper_box.dart / helper_node.dart):
     • presence payesh/helpers/<id>.json every 60 s (kinds, slots);
     • one ListObjectsV2 of payesh/jobs/ per cycle (maxPages: 1);
     • claim = PUT lease (random token, 60 s) → wait 1.5 s + 0..400 ms → GET lease,
       only our token ⇒ run; lease renewed every 20 s while running;
     • the work itself = server/helper-jobs.js runLocal (the same four job kinds;
       the Dart executor is byte-compatible: docs/cloud/contracts/helper-jobs-vectors.json);
     • result payesh/jobs/res/<id>.json (sealed AES-256-GCM);
     • next cycle after 3 s when there was work, else 5 → 10 → 20 → 30 s.
   Environment: HELPER_ID (16 hex), S3_* (endpoint/bucket/keys/region), SLOTS (1).
   ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const crypto = require('crypto');
const ROOT = process.env.REPO || '/repo';
const hj = require(path.join(ROOT, 'server', 'helper-jobs.js'));
const s3mem = require(path.join(ROOT, 'server', 's3mem.js'));

const cfg = s3mem.normalize({
  endpoint: process.env.S3_ENDPOINT, bucket: process.env.S3_BUCKET,
  accessKey: process.env.S3_ACCESS_KEY, secret: process.env.S3_SECRET,
  region: process.env.S3_REGION || 'us-east-1', prefix: 'payesh/', pathStyle: true,
});
const ID = String(process.env.HELPER_ID || crypto.randomBytes(8).toString('hex'));
const SLOTS = Math.max(1, Number(process.env.SLOTS || 1));
const P = cfg.prefix;
const PRESENCE_EVERY = 60_000, LEASE_FOR = 60_000, LEASE_RENEW = 20_000, SETTLE = 1500;
const JOB_DEADLINE = 10 * 60_000;
const IDLE = [5, 10, 20, 30];
const URGENT = process.env.URGENT === '1';
const JOB_RE = /^[0-9]{13}-[0-9a-f]{16}$/;

const stats = { id: ID, cycles: 0, lists: 0, claimed: 0, lost: 0, done: 0, failed: 0, work_ms: 0, jobs: [] };
let lastPresence = 0, idleStep = 0;
const active = new Set();

const put = (key, kind, rev, plain) => s3mem.put(cfg, key, JSON.stringify(hj.seal(cfg.secret, kind, rev, JSON.stringify(plain))));
async function read(key, kind) {
  try { return hj.open(cfg.secret, kind, JSON.parse(await s3mem.get(cfg, key))).plain; } catch (e) { return null; }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function presence() {
  const at = Date.now();
  await put(P + hj.DIR.helpers + ID + '.json', hj.K.presence, at, {
    v: 1, helper_id: ID, host: 'sim-' + ID.slice(0, 4), app: 'owner-panel', version: 'sim-205',
    slots: SLOTS, paused: false, kinds: hj.KINDS, at, done: stats.done, failed: stats.failed,
  });
  lastPresence = at;
}

async function lease(jid, token) {
  const now = Date.now();
  await put(P + hj.DIR.lease + jid + '.json', hj.K.lease, now, { v: 1, job_id: jid, helper_id: ID, token, until: now + LEASE_FOR });
}

async function run(jid, token, req) {
  const started = Date.now();
  const renew = setInterval(() => { lease(jid, token).catch(() => {}); }, LEASE_RENEW);
  let result = null, error = null;
  try { result = await hj.runLocal(cfg, req.kind, req.params, {}); } catch (e) { error = e.code || 'failed'; }
  clearInterval(renew);
  const finished = Date.now();
  await put(P + hj.DIR.res + jid + '.json', hj.K.result, finished, {
    v: 1, job_id: jid, helper_id: ID, ok: !error, result, error, started_at: started, finished_at: finished,
  }).catch(() => {});
  stats.work_ms += finished - started;
  if (error) stats.failed++; else stats.done++;
  stats.jobs.push({ kind: req.kind, ms: finished - started, waited_ms: started - Number(jid.slice(0, 13)), error });
  active.delete(jid);
}

async function claim(jid) {
  const req = await read(P + hj.DIR.req + jid + '.json', hj.K.request);
  if (!req || req.job_id !== jid) return;
  const token = crypto.randomBytes(8).toString('hex');
  await lease(jid, token);
  await sleep(SETTLE + crypto.randomInt(400));
  const back = await read(P + hj.DIR.lease + jid + '.json', hj.K.lease);
  if (!back || back.token !== token || back.helper_id !== ID) { stats.lost++; return; }
  stats.claimed++;
  active.add(jid);
  run(jid, token, req);
}

async function pollOnce() {
  stats.lists++;
  const r = await s3mem.list(cfg, { prefix: P + 'jobs/', max: 1000 });
  const req = [], leaseAt = new Map(), res = new Set();
  for (const o of r.keys) {
    const rel = o.key.slice((P + 'jobs/').length);
    const id = rel.replace(/^[a-z]+\//, '').replace(/\.json$/, '');
    if (!JOB_RE.test(id)) continue;
    if (rel.startsWith('req/')) req.push(id);
    if (rel.startsWith('lease/')) leaseAt.set(id, o.modified ? Date.parse(o.modified) : null);
    if (rel.startsWith('res/')) res.add(id);
  }
  req.sort();
  const now = Date.now();
  let found = false;
  for (const id of req) {
    if (active.size >= SLOTS) break;
    if (res.has(id) || active.has(id)) continue;
    if (now - Number(id.slice(0, 13)) > JOB_DEADLINE) continue;
    if (leaseAt.has(id)) {
      const m = leaseAt.get(id);
      if (m == null || now - m <= LEASE_FOR) continue;
    }
    found = true;
    await claim(id);
  }
  return found;
}

async function tick() {
  stats.cycles++;
  try {
    if (!lastPresence || Date.now() - lastPresence >= PRESENCE_EVERY) await presence();
    if (active.size >= SLOTS) return 3000;
    const found = await pollOnce();
    if (found) { idleStep = 0; return 3000; }
    /* helper_service.dart: urgent = the owner panel's own load route has «helpers» active
       (bucket p95 above 1200 ms as the owner app measures it) ⇒ poll every 3 s */
    if (URGENT) { idleStep = 0; return 3000; }
    const d = IDLE[Math.min(idleStep, IDLE.length - 1)] * 1000;
    if (idleStep < IDLE.length - 1) idleStep++;
    return d;
  } catch (e) {
    stats.last_error = String(e.message || e).slice(0, 160);
    return 30_000;
  }
}

(async () => {
  console.log('[helper ' + ID + '] up — bucket ' + cfg.endpoint + '/' + cfg.bucket);
  const fs = require('fs');
  const out = process.env.HELPER_OUT;
  if (out) setInterval(() => { try { fs.writeFileSync(out, JSON.stringify(stats)); } catch (e) { /* later */ } }, 1000).unref();
  for (;;) await sleep(await tick());
})();
