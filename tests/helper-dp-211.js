// Rows 205-211 — distributed processing: contract v2, catalog, school token,
// executor kill/resume, adaptive polling, queue status, stub e2e.
// Final line: HELPER-DP-211-OK checks=N | HELPER-DP-211-FAIL failures=N
'use strict';
const fs = require('node:fs');
const path = require('node:path');
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
  catch (e) { failures.push(name); console.log('FAIL ' + name + ' — ' + String((e && e.stack) || e).split('\n')[0]); }
}

(async () => {
  const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/cloud/contracts/helper-jobs-vectors-v2.json'), 'utf8'));

  await check('DP-205 vectors: presence/job defaults + seal v2 roundtrip', async () => {
    const pr = v2.normalizePresence(V.cases.presence_v2.plain);
    assert.strictEqual(pr.cls, 'cloudflare'); assert.deepStrictEqual(pr.caps, ['endpoint.check', 'storage.usage']);
    assert.strictEqual(v2.normalizePresence({ v: 1, kinds: ['storage.usage'] }).cls, 'owner');
    const env = hj.seal(V.secret, hj.K.request, 1000, JSON.stringify(V.cases.job_priority.plain));
    assert.strictEqual(hj.open(V.secret, hj.K.request, env).plain.priority, 'high');
    const old = hj.seal(V.secret, hj.K.request, 1000, JSON.stringify({ v: 1, job_id: 'x' }));
    assert.strictEqual(hj.open(V.secret, hj.K.request, old).plain.v, 1);
  });

  await check('DP-208 catalog + canLease data classes', async () => {
    const cf = { cls: 'cloudflare', caps: ['report.aggregate'], kinds: [] };
    const job = { kind: 'report.aggregate', data_class: 'school-content', school_id: 'school-01' };
    assert.strictEqual(v2.canLease(cf, job), false);
    assert.strictEqual(v2.canLease({ cls: 'actions', caps: ['report.aggregate'], kinds: [] }, job), false);
    assert.strictEqual(v2.canLease({ cls: 'school', school_id: 'school-02', caps: ['report.aggregate'], kinds: [] }, job), false);
    assert.strictEqual(v2.canLease({ cls: 'school', school_id: 'school-01', caps: ['report.aggregate'], kinds: [] }, job), true);
    assert.strictEqual(v2.canLease({ cls: 'owner', caps: ['report.aggregate'], kinds: [] }, job), true);
    assert.strictEqual(v2.catalogOf('endpoint.check').data_class, 'public');
  });

  await check('DP-209 school token: issue/verify/cross-school', async () => {
    const t = v2.schoolToken(V.secret, 'school-01');
    assert.strictEqual(t, V.school_token.token);
    assert.strictEqual(v2.verifySchoolToken(V.secret, t), 'school-01');
    assert.strictEqual(v2.verifySchoolToken(V.secret, 'school-02.' + t.split('.')[1]), null);
    assert.strictEqual(v2.verifySchoolToken('other', t), null);
  });

  await check('DP-209 revocation: revoked school token is rejected', async () => {
    const t = v2.schoolToken(V.secret, 'school-01');
    assert.strictEqual(v2.verifySchoolTokenEx(V.secret, t, []), 'school-01');
    assert.strictEqual(v2.verifySchoolTokenEx(V.secret, t, ['school-01']), null);
    assert.strictEqual(v2.verifySchoolTokenEx(V.secret, t, { 'school-01': 1 }), null);
    assert.strictEqual(v2.verifySchoolTokenEx(V.secret, t, ['school-02']), 'school-01');
  });

  await check('DP-205 pickExecutor prefers capable/fresh', async () => {
    const now = Date.now();
    const a = { helper_id: 'a', cls: 'owner', caps: ['storage.usage'], kinds: [], capacity: 1, at: now - 80000, online: true };
    const b = { helper_id: 'b', cls: 'cloudflare', caps: ['storage.usage'], kinds: [], capacity: 4, at: now, online: true };
    assert.strictEqual(v2.pickExecutor([a, b], { kind: 'storage.usage' }, now).helper_id, 'b');
    assert.strictEqual(v2.pickExecutor([a], { kind: 'nope' }, now), null);
  });

  await check('DP-210 adaptive polling backoff', async () => {
    assert.strictEqual(v2.nextPollDelay(0, { hasJob: true, baseMs: 1000 }), 1000);
    const d0 = v2.nextPollDelay(0, { baseMs: 1000, rand: () => 0.5 });
    const d3 = v2.nextPollDelay(3, { baseMs: 1000, rand: () => 0.5 });
    assert.ok(d3 > d0 * 4, d0 + ' -> ' + d3);
    assert.ok(v2.nextPollDelay(99, { baseMs: 1000, maxMs: 5000, rand: () => 0.5 }) <= 6000);
  });

  const S = await startStub({ accessKey: 'ak-dp', secret: 'sk-helper-1', bucket: 'payesh-madrese' });
  const cfg = s3mem.normalize(S.cfg);
  const clock = () => Date.now();
  S.poke('payesh/schools/a/1.bin', 'x'.repeat(10));
  try {
    await check('DP-211 e2e: actions executor leases + completes a real queue job', async () => {
      const me = { id: 'ac00000000000001', cls: 'actions', caps: hj.KINDS.slice(), capacity: 1 };
      await executor.writePresence(cfg, me, {});
      const list = await hj.helpersOnline(cfg);
      assert.ok(list.some(h => h.helper_id === me.id && h.cls === 'actions'));
      // enqueue directly (requester side)
      const t0 = Date.now(); const id = hj.newJobId(t0);
      await s3mem.put(cfg, cfg.prefix + hj.DIR.req + id + '.json', JSON.stringify(hj.seal(cfg.secret, hj.K.request, t0,
        JSON.stringify({ v: 2, job_id: id, kind: 'storage.usage', params: { prefix: 'payesh/' }, from: 'test', created_at: t0, deadline_at: t0 + 600000, priority: 'normal', data_class: 'internal', idempotency_key: id }))));
      const r = await executor.pollOnce(cfg, me, { maxJobs: 1, settleMs: 1, sleep: async () => {} });
      assert.strictEqual(r.done, 1);
      const res = hj.open(cfg.secret, hj.K.result, JSON.parse(await s3mem.get(cfg, cfg.prefix + hj.DIR.res + id + '.json'))).plain;
      assert.strictEqual(res.ok, true); assert.ok(res.result.objects >= 1);
      const qs = await hj.queueStatus(cfg);
      assert.ok(qs.done >= 1);
    });

    await check('DP-211 kill mid-job: expired lease is reclaimed, no double-apply', async () => {
      const t0 = Date.now(); const id = hj.newJobId(t0);
      await s3mem.put(cfg, cfg.prefix + hj.DIR.req + id + '.json', JSON.stringify(hj.seal(cfg.secret, hj.K.request, t0,
        JSON.stringify({ v: 1, job_id: id, kind: 'storage.usage', params: { prefix: 'payesh/' }, from: 'test', created_at: t0, deadline_at: t0 + 600000 }))));
      // dead executor holds an expired lease, no result
      await s3mem.put(cfg, cfg.prefix + hj.DIR.lease + id + '.json', JSON.stringify(hj.seal(cfg.secret, hj.K.lease, t0,
        JSON.stringify({ v: 1, job_id: id, helper_id: 'dead000000000001', token: '00', until: t0 - 1000 }))));
      const me = { id: 'cf00000000000001', cls: 'cloudflare', caps: hj.KINDS.slice(), capacity: 1 };
      const r1 = await executor.pollOnce(cfg, me, { maxJobs: 1, settleMs: 1, sleep: async () => {} });
      assert.strictEqual(r1.done, 1);
      const r2 = await executor.pollOnce(cfg, me, { maxJobs: 1, settleMs: 1, sleep: async () => {} });
      assert.strictEqual(r2.done, 0, 'second poll must not re-apply (result exists)');
    });

    await check('DP-211 no executor => local fallback still works (golden rule)', async () => {
      const r = await hj.runJob(cfg, 'storage.usage', {}, { busy: true, now: clock, sleep: async () => {}, policy: { v: 1, helpers: false, off: [], at: Date.now() } });
      assert.strictEqual(r.by, 'local'); assert.strictEqual(r.ok, true);
    });
  } finally { await S.close(); }

  console.log(failures.length ? 'HELPER-DP-211-FAIL failures=' + failures.length : 'HELPER-DP-211-OK checks=' + checks);
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.log('FAIL fatal — ' + (e && e.stack)); console.log('HELPER-DP-211-FAIL failures=1'); process.exit(1); });
