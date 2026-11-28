// Row 213 — faster helper offload: a helper counts only if it will READ THE QUEUE before
// the claim window ends. Presence advertises poll_ms / next_poll_at / accepting; runJob
// offloads only to helpers polling in time, shortens the window to the soonest poll +
// margin, and otherwise goes local immediately (why=helper_idle) — so a manager never
// waits longer than local processing because of an idle/slow helper.
// Final line: HELPER-IDLE-213-OK checks=N | HELPER-IDLE-213-FAIL failures=N
'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert');
const ROOT = path.join(__dirname, '..');
const hj = require(path.join(ROOT, 'server', 'helper-jobs.js'));
const v2 = require(path.join(ROOT, 'server', 'helper-v2.js'));
const executor = require(path.join(ROOT, 'server', 'helper-executor.js'));
const s3mem = require(path.join(ROOT, 'server', 's3mem.js'));
const { startStub } = require('./lib/s3-stub');

let checks = 0; const failures = [];
async function check(name, fn) {
  try { await fn(); checks++; console.log('ok   ' + name); }
  catch (e) { failures.push(name); console.log('FAIL ' + name + ' — ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); }
}

(async () => {
  await check('H213-01 pollEta: v1 => legacy 30 s; poll_ms; next_poll_at; accepting/paused => null', async () => {
    const now = 1_000_000;
    assert.strictEqual(v2.pollEta({ v: 1, at: now }, now), v2.LEGACY_POLL_MS);
    assert.strictEqual(v2.pollEta({ poll_ms: 15000 }, now), 15000);
    assert.strictEqual(v2.pollEta({ poll_ms: 60000, next_poll_at: now + 7000 }, now), 7000);
    assert.strictEqual(v2.pollEta({ poll_ms: 60000, next_poll_at: now - 5000 }, now), 60000, 'late cron => worst case');
    assert.strictEqual(v2.pollEta({ poll_ms: 60000, next_poll_at: now + 3_600_000 }, now), 60000, 'bogus far future => period');
    assert.strictEqual(v2.pollEta({ poll_ms: 15000, accepting: false }, now), null);
    assert.strictEqual(v2.pollEta({ poll_ms: 15000, paused: true }, now), null);
    assert.strictEqual(v2.pollEta({ poll_ms: 5 }, now), v2.LEGACY_POLL_MS, 'invalid poll_ms ignored');
  });

  await check('H213-01b contract vectors v2 poll_eta (shared with Dart HelperPresence.pollEtaAt)', async () => {
    const V = require(path.join(ROOT, 'docs/cloud/contracts/helper-jobs-vectors-v2.json')).poll_eta;
    assert.strictEqual(V.idle_poll_cap_ms, v2.IDLE_POLL_CAP_MS); assert.strictEqual(V.legacy_poll_ms, v2.LEGACY_POLL_MS);
    assert.strictEqual(V.claim_margin_ms, hj.CLAIM_MARGIN_MS); assert.strictEqual(V.claim_wait_ms, hj.CLAIM_WAIT_MS);
    assert.strictEqual(V.background_claim_max_ms, hj.BACKGROUND_CLAIM_MAX_MS);
    for (const c of V.cases) assert.strictEqual(v2.pollEta(c.presence, V.now), c.eta, c.name);
  });

  await check('H213-02 idle poll cap < claim window (default nextPollDelay incl. +20% jitter)', async () => {
    assert.ok(v2.IDLE_POLL_CAP_MS + hj.CLAIM_MARGIN_MS <= hj.CLAIM_WAIT_MS);
    for (let a = 0; a < 25; a++) assert.ok(v2.nextPollDelay(a, { rand: () => 0.999 }) < hj.CLAIM_WAIT_MS, 'attempt ' + a);
    assert.strictEqual(v2.nextPollDelay(3, { hasJob: true }), 5000);
  });

  const S = await startStub({ accessKey: 'ak-213', secret: 'sk-helper-213', bucket: 'payesh-madrese' });
  const cfg = s3mem.normalize(S.cfg);
  S.poke('payesh/schools/a/1.bin', 'x'.repeat(10));
  const wipe = () => { for (const k of [...S.objects.keys()]) if (k.startsWith('payesh/helpers/') || k.startsWith('payesh/jobs/')) S.objects.delete(k); };
  const queueKeys = () => [...S.objects.keys()].filter(k => k.startsWith('payesh/jobs/'));
  const policy = { v: 1, helpers: true, off: [], at: Date.now() };
  const presence = (id, plain) => s3mem.put(cfg, cfg.prefix + hj.DIR.helpers + id + '.json',
    JSON.stringify(hj.seal(cfg.secret, hj.K.presence, plain.at, JSON.stringify(Object.assign({ helper_id: id, slots: 1, paused: false, kinds: hj.KINDS, done: 0, failed: 0 }, plain)))));

  try {
    await check('H213-03 only a legacy (v1, 30 s idle) helper online => local at once, nothing queued, no waiting', async () => {
      wipe();
      let clock = Date.now();
      await presence('a000000000000001', { v: 1, host: 'old-owner', at: clock });
      const list = await hj.helpersOnline(cfg, { now: clock });
      assert.strictEqual(list[0].online, true); assert.strictEqual(list[0].poll_eta_ms, v2.LEGACY_POLL_MS);
      let slept = 0;
      const r = await hj.runJob(cfg, 'storage.usage', {}, { busy: true, policy, route: null, now: () => clock, sleep: async (ms) => { slept += ms; clock += ms; } });
      assert.strictEqual(r.by, 'local'); assert.strictEqual(r.why, 'helper_idle'); assert.strictEqual(r.ok, true);
      assert.strictEqual(slept, 0, 'manager did not wait'); assert.deepStrictEqual(queueKeys(), []);
    });

    await check('H213-04 Actions (15 min cron) presence => user request never queued for it', async () => {
      wipe();
      let clock = Date.now();
      await executor.writePresence(cfg, { id: 'ac00000000000213', cls: 'actions', caps: hj.KINDS.slice(), capacity: 1, pollMs: 15 * 60_000 }, { now: clock });
      const [h] = await hj.helpersOnline(cfg, { now: clock });
      assert.strictEqual(h.poll_ms, 900000); assert.strictEqual(h.poll_eta_ms, 900000);
      let slept = 0;
      const r = await hj.runJob(cfg, 'storage.usage', {}, { busy: true, policy, route: null, now: () => clock, sleep: async (ms) => { slept += ms; clock += ms; } });
      assert.strictEqual(r.why, 'helper_idle'); assert.strictEqual(slept, 0); assert.deepStrictEqual(queueKeys(), []);
    });

    await check('H213-05 owner helper with processing off (accepting:false) => not waited for', async () => {
      wipe();
      const clock = Date.now();
      await presence('b000000000000213', { v: 1, host: 'owner', at: clock, poll_ms: 15000, accepting: false });
      const r = await hj.runJob(cfg, 'storage.usage', {}, { busy: true, policy, route: null, now: () => clock, sleep: async () => { throw new Error('must not wait'); } });
      assert.strictEqual(r.why, 'helper_idle');
    });

    await check('H213-06 fast helper (poll 3 s) not claiming => local after soonest poll + margin (8 s), not 20 s', async () => {
      wipe();
      let clock = Date.now();
      await presence('c000000000000213', { v: 1, host: 'owner', at: clock, poll_ms: 3000, accepting: true });
      const t0 = clock;
      const r = await hj.runJob(cfg, 'storage.usage', {}, { busy: true, policy, route: null, now: () => clock, sleep: async (ms) => { clock += ms; } });
      assert.strictEqual(r.why, 'not_claimed');
      const waited = clock - t0;
      assert.ok(waited >= 3000 + hj.CLAIM_MARGIN_MS && waited <= 3000 + hj.CLAIM_MARGIN_MS + 2000, 'waited ' + waited);
      assert.deepStrictEqual(queueKeys(), [], 'request cleaned up');
    });

    await check('H213-07 helper polling within the window claims + completes (real executor)', async () => {
      wipe();
      let clock = Date.now();
      const me = { id: 'cf00000000000213', cls: 'cloudflare', caps: hj.KINDS.slice(), capacity: 1, pollMs: 60_000 };
      await executor.writePresence(cfg, me, { now: clock, nextPollAt: clock + 6000 });
      let polled = false;
      const r = await hj.runJob(cfg, 'storage.usage', {}, {
        busy: true, policy, route: null, now: () => clock,
        sleep: async (ms) => { clock += ms; if (!polled) { polled = true; await executor.pollOnce(cfg, me, { maxJobs: 1, settleMs: 1, sleep: async () => {}, now: () => clock }); } },
      });
      assert.strictEqual(r.by, me.id, JSON.stringify(r)); assert.strictEqual(r.ok, true);
    });

    await check('H213-08 Worker cron next minute: user request local now; background job waits for it', async () => {
      wipe();
      let clock = Date.now();
      const me = { id: 'cf00000000000214', cls: 'cloudflare', caps: hj.KINDS.slice(), capacity: 1, pollMs: 60_000 };
      await executor.writePresence(cfg, me, { now: clock, nextPollAt: clock + 50_000 });
      let slept = 0;
      const user = await hj.runJob(cfg, 'endpoint.check', { url: 'https://example.org/' }, {
        policy, route: null, now: () => clock, sleep: async (ms) => { slept += ms; clock += ms; },
        checkEndpoint: async () => ({ reachable: true, status: 200 }),
      });
      assert.strictEqual(user.why, 'helper_idle'); assert.strictEqual(slept, 0);
      const t0 = clock;
      const bg = await hj.runJob(cfg, 'endpoint.check', { url: 'https://example.org/' }, {
        background: true, throttle: async () => {}, policy, route: null, now: () => clock,
        sleep: async (ms) => { clock += ms; },
        checkEndpoint: async () => ({ reachable: true, status: 200 }),
      });
      /* nobody polls in this test => falls back after next poll + margin (~55 s), never beyond 90 s */
      assert.strictEqual(bg.why, 'not_claimed');
      assert.ok(clock - t0 >= 50_000 + hj.CLAIM_MARGIN_MS && clock - t0 <= hj.BACKGROUND_CLAIM_MAX_MS, 'waited ' + (clock - t0));
    });

    await check('H213-09 slow helper path (sim: 14 s) => one local run to learn, then local while local is faster', async () => {
      wipe(); hj._resetEstimates();
      let clock = Date.now();
      const me = { id: 'cf00000000000215', cls: 'cloudflare', caps: hj.KINDS.slice(), capacity: 1, pollMs: 3000 };
      await executor.writePresence(cfg, me, { now: clock });
      /* 1st job: helper claims, but the round trip is slow (the starved server polls late) */
      let n = 0;
      const r1 = await hj.runJob(cfg, 'storage.usage', {}, {
        busy: true, policy, route: null, now: () => clock,
        sleep: async (ms) => { clock += ms; if (++n === 2) { await executor.pollOnce(cfg, me, { maxJobs: 1, settleMs: 1, sleep: async () => {}, now: () => clock }); clock += 10_000; } },
      });
      assert.strictEqual(r1.by, me.id);
      const e1 = hj.estimates()['storage.usage'];
      assert.ok(e1.helper_ms > hj.HELPER_FAST_MS, JSON.stringify(e1)); assert.strictEqual(e1.local_ms, null);
      /* 2nd: local timing unknown => learn it (manager is served locally, no waiting) */
      await executor.writePresence(cfg, me, { now: clock });
      const r2 = await hj.runJob(cfg, 'storage.usage', {}, { busy: true, policy, route: null, now: () => clock, sleep: async () => { throw new Error('must not wait'); } });
      assert.strictEqual(r2.why, 'learning'); assert.ok(hj.estimates()['storage.usage'].local_ms != null);
      /* 3rd: local (ms) is faster than eta 3 s + learned overhead ⇒ local, nothing queued */
      const r3 = await hj.runJob(cfg, 'storage.usage', {}, { busy: true, policy, route: null, now: () => clock, sleep: async () => { throw new Error('must not wait'); } });
      assert.strictEqual(r3.why, 'local_faster'); assert.deepStrictEqual(queueKeys(), []);
    });

    await check('H213-10 heavy local job (learned 40 s) => slow-but-faster helper still used; background never gated', async () => {
      wipe(); hj._resetEstimates();
      let clock = Date.now();
      const me = { id: 'cf00000000000216', cls: 'cloudflare', caps: hj.KINDS.slice(), capacity: 1, pollMs: 3000 };
      await executor.writePresence(cfg, me, { now: clock });
      /* seed: helper path 12 s (overhead 9 s), local 40 s (e.g. a 100k-object bucket on a starved server) */
      let n = 0;
      await hj.runJob(cfg, 'storage.usage', {}, { busy: true, policy, route: null, now: () => clock,
        sleep: async (ms) => { clock += ms; if (++n === 2) { await executor.pollOnce(cfg, me, { maxJobs: 1, settleMs: 1, sleep: async () => {}, now: () => clock }); clock += 8000; } } });
      await executor.writePresence(cfg, me, { now: clock });
      const realNow = Date.now;
      let fake = realNow();
      Date.now = () => (fake += 20_000);           /* the local run "takes" 40 s */
      try { await hj.runJob(cfg, 'storage.usage', {}, { busy: true, policy, route: null, now: () => clock, sleep: async () => {} }); }
      finally { Date.now = realNow; }
      const e = hj.estimates()['storage.usage'];
      assert.ok(e.local_ms >= 39_000, JSON.stringify(e));
      n = 0;
      const r = await hj.runJob(cfg, 'storage.usage', {}, { busy: true, policy, route: null, now: () => clock,
        sleep: async (ms) => { clock += ms; if (++n === 1) await executor.pollOnce(cfg, me, { maxJobs: 1, settleMs: 1, sleep: async () => {}, now: () => clock }); } });
      assert.strictEqual(r.by, me.id, JSON.stringify(r));
      /* background: no user waiting ⇒ estimates never block offload */
      hj._resetEstimates();
      await executor.writePresence(cfg, me, { now: clock });
      n = 0;
      const bg = await hj.runJob(cfg, 'storage.usage', {}, { background: true, throttle: async () => {}, busy: true, policy, route: null, now: () => clock,
        sleep: async (ms) => { clock += ms; if (++n === 1) await executor.pollOnce(cfg, me, { maxJobs: 1, settleMs: 1, sleep: async () => {}, now: () => clock }); } });
      assert.strictEqual(bg.by, me.id); assert.deepStrictEqual(hj.estimates(), {});
    });

  } finally { await S.close(); }

  console.log(failures.length ? 'HELPER-IDLE-213-FAIL failures=' + failures.length : 'HELPER-IDLE-213-OK checks=' + checks);
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.log('FAIL fatal — ' + (e && e.stack)); console.log('HELPER-IDLE-213-FAIL failures=1'); process.exit(1); });
