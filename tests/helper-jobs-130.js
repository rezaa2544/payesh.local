// سرور کمکی (ADR 126 §۱۱) — server/helper-jobs.js در برابر صندوقچهٔ S3 محلی با بازبینی واقعی SigV4.
//
//   HJ-01  بردارهای قرارداد (همان بایت‌های پنل مالک Dart): کلید HKDF، پاکت هر چهار نوع، جدول IP عمومی.
//   HJ-02  بدون سرور کمکی ⇒ همین سرور مدرسه انجام می‌دهد (no_helper) — پردازش متوقف نمی‌شود.
//   HJ-03  یک سرور کمکی روشن (شبیه‌سازِ همان پروتکل پنل مالک) کار را برمی‌دارد و نتیجه می‌گذارد.
//   HJ-04  دو سرور کمکی هم‌زمان: فقط یکی (رزرو + بازخوانی توکن).
//   HJ-05  سرور کمکیِ ثبت‌شده که برنمی‌دارد ⇒ not_claimed؛ رزرو منقضی ⇒ lease_expired؛ متوقف ⇒ no_helper.
//   HJ-06  نتیجهٔ مهرشده با کلید دیگر پذیرفته نمی‌شود؛ خطای پارامتر دوباره اجرا نمی‌شود.
//   HJ-07  صندوقچه در دسترس نیست ⇒ endpoint.check محلی (bucket_unreachable).
//   HJ-08  پاکسازی (bucket.gc): کارهای کهنه، حضورهای قدیمی، آینهٔ کهنهٔ به‌روزرسانی؛ پاکت کلید دیگر دست‌نخورده.
//   HJ-09  پارامترها: پیشوند/کلید بیرون از payesh/ و نشانی غیر http(s) رد؛ checkEndpoint نشانی خصوصی را رد می‌کند.
//   HJ-10  فهرست صفحه‌بندی‌شده (continuation-token) و LastModified.
//   HJ-11  وضعیت و بررسی بیرونی (سرور مدرسه).
//   HJ-12  «فقط هنگام نیاز» (ردیف ۱۳۱): سرور جا دارد ⇒ همین سرور، بدون صف؛ شلوغ ⇒ سرور کمکی؛
//          endpoint.check همیشه از بیرون؛ سیاست مالک helpers=false ⇒ هیچ کاری به سرور کمکی نمی‌رود.
// خط آخر: HELPER-JOBS-130-OK checks=N | HELPER-JOBS-130-FAIL failures=N
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const hj = require(path.join(ROOT, 'server', 'helper-jobs.js'));
const s3mem = require(path.join(ROOT, 'server', 's3mem.js'));
const { startStub } = require('./lib/s3-stub');

let checks = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); checks++; console.log('ok   ' + name); }
  catch (e) { failures.push(name); console.log('FAIL ' + name + ' — ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); }
}

/* شبیه‌ساز پنل مالک (همان پروتکل helper_node.dart) */
function fakeHelper(cfg, id, { now, paused = false, kinds = hj.KINDS } = {}) {
  const P = cfg.prefix;
  const put = (key, kind, rev, plain) => s3mem.put(cfg, key, JSON.stringify(hj.seal(cfg.secret, kind, rev, JSON.stringify(plain))));
  const read = async (key, kind) => {
    try { return hj.open(cfg.secret, kind, JSON.parse(await s3mem.get(cfg, key))).plain; } catch (e) { return null; }
  };
  const h = {
    id, done: 0,
    async presence() {
      const at = now();
      await put(P + hj.DIR.helpers + id + '.json', hj.K.presence, at, {
        v: 1, helper_id: id, host: 'PC-' + id.slice(0, 4), app: 'owner-panel', version: 'test',
        slots: 1, paused, kinds, at, done: h.done, failed: 0,
      });
    },
    /* یک دور: فهرست، رزرو، بازخوانی، اجرا، نتیجه */
    async poll({ settle = async () => {} } = {}) {
      const r = await s3mem.list(cfg, { prefix: P + 'jobs/', max: 1000 });
      const names = r.keys.map(k => k.key.slice((P + 'jobs/').length));
      for (const n of names.filter(x => x.startsWith('req/'))) {
        const jid = n.slice(4, -5);
        if (names.includes('res/' + jid + '.json') || names.includes('lease/' + jid + '.json')) continue;
        const req = await read(P + hj.DIR.req + jid + '.json', hj.K.request);
        if (!req || req.job_id !== jid) continue;
        const token = crypto.randomBytes(8).toString('hex');
        await put(P + hj.DIR.lease + jid + '.json', hj.K.lease, now(), { v: 1, job_id: jid, helper_id: id, token, until: now() + 60000 });
        await settle();
        const back = await read(P + hj.DIR.lease + jid + '.json', hj.K.lease);
        if (!back || back.token !== token) continue;
        const started = now();
        let result = null, error = null;
        try { result = await hj.runLocal(cfg, req.kind, req.params, { now }); } catch (e) { error = e.code || 'failed'; }
        await put(P + hj.DIR.res + jid + '.json', hj.K.result, now(), {
          v: 1, job_id: jid, helper_id: id, ok: !error, result, error, started_at: started, finished_at: now(),
        });
        h.done++;
      }
    },
  };
  return h;
}

(async () => {
  const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/cloud/contracts/helper-jobs-vectors.json'), 'utf8'));

  await check('HJ-01 بردارهای قرارداد', async () => {
    assert.strictEqual(hj.keyFor(V.secret).toString('hex'), V.key_hex);
    assert.deepStrictEqual(V.kinds, hj.K);
    assert.deepStrictEqual(V.dirs, hj.DIR);
    assert.deepStrictEqual(V.job_kinds, hj.KINDS);
    assert.strictEqual(V.presence_fresh_ms, hj.PRESENCE_FRESH_MS);
    assert.strictEqual(V.claim_wait_ms, hj.CLAIM_WAIT_MS);
    assert.strictEqual(V.gc_job_age_ms, hj.GC_JOB_AGE_MS);
    for (const [name, c] of Object.entries(V.cases)) {
      const env = hj.seal(V.secret, V.kinds[name], V.rev, c.plaintext, Buffer.from(V.nonce_hex, 'hex'));
      assert.deepStrictEqual(env, c.envelope, name);
      assert.strictEqual(JSON.stringify(hj.open(V.secret, V.kinds[name], c.envelope).plain), c.plaintext);
      assert.throws(() => hj.open('other', V.kinds[name], c.envelope));
      const bad = Object.assign({}, c.envelope, { rev: V.rev + 1 });
      assert.throws(() => hj.open(V.secret, V.kinds[name], bad), 'AAD شامل rev است');
    }
    for (const [ip, want] of Object.entries(V.public_ip)) assert.strictEqual(hj.isPublicIp(ip), want, ip);
  });

  const S = await startStub({ accessKey: 'ak-h', secret: 'sk-helper-1', bucket: 'payesh-madrese' });
  const cfg = s3mem.normalize(S.cfg);
  let clock = Date.now();
  const now = () => clock;
  const wipe = () => { for (const k of [...S.objects.keys()]) if (k.startsWith('payesh/helpers/') || k.startsWith('payesh/jobs/')) S.objects.delete(k); };
  S.poke('payesh/schools/a/1.bin', 'x'.repeat(100));
  S.poke('payesh/schools/a/2.bin', 'y'.repeat(50));
  S.poke('payesh/schools/b/1.bin', 'z'.repeat(10));

  try {
    await check('HJ-02 بدون سرور کمکی ⇒ محلی', async () => {
      wipe();
      const r = await hj.runJob(cfg, 'storage.usage', {}, { busy: true, now, sleep: async () => {} });
      assert.strictEqual(r.by, 'local'); assert.strictEqual(r.why, 'no_helper'); assert.strictEqual(r.ok, true);
      assert.strictEqual(r.result.groups.schools.objects, 3);
      assert.strictEqual(r.result.groups.schools.bytes, 160);
    });

    await check('HJ-03 سرور کمکی روشن کار را انجام می‌دهد', async () => {
      wipe();
      const b = fakeHelper(cfg, 'b000000000000001', { now });
      await b.presence();
      const st = await hj.helpersOnline(cfg, { now: now() });
      assert.strictEqual(st.length, 1); assert.strictEqual(st[0].online, true); assert.strictEqual(st[0].host, 'PC-b000');
      const r = await hj.runJob(cfg, 'storage.usage', {}, { busy: true,
        now, sleep: async (ms) => { clock += ms; await b.poll(); },
      });
      assert.strictEqual(r.ok, true); assert.strictEqual(r.by, 'b000000000000001');
      assert.ok(r.result.objects >= 3);
      assert.strictEqual(b.done, 1);
      assert.deepStrictEqual([...S.objects.keys()].filter(k => k.startsWith('payesh/jobs/')), [], 'صف پاک شد');
    });

    await check('HJ-04 دو سرور کمکی هم‌زمان: فقط یکی', async () => {
      wipe();
      const b = fakeHelper(cfg, 'b000000000000001', { now });
      const c = fakeHelper(cfg, 'c000000000000001', { now });
      await b.presence(); await c.presence();
      /* هر دو لیست را می‌بینند و رزرو می‌نویسند؛ بعد از settle فقط آخرین توکن می‌ماند */
      let gate;
      const both = new Promise(r => { gate = r; });
      let waiting = 0;
      const settle = async () => { waiting++; if (waiting === 2) gate(); await both; };
      const r = await hj.runJob(cfg, 'storage.usage', {}, { busy: true,
        now, sleep: async (ms) => { clock += ms; await Promise.all([b.poll({ settle }), c.poll({ settle })]); },
      });
      assert.strictEqual(r.ok, true); assert.ok(r.by === b.id || r.by === c.id);
      assert.strictEqual(b.done + c.done, 1);
    });

    await check('HJ-05 not_claimed / lease_expired / متوقف', async () => {
      wipe();
      const b = fakeHelper(cfg, 'b000000000000001', { now });
      await b.presence();
      const r1 = await hj.runJob(cfg, 'storage.usage', {}, { busy: true, now, sleep: async (ms) => { clock += ms; } });
      assert.strictEqual(r1.why, 'not_claimed'); assert.strictEqual(r1.ok, true);

      wipe(); await b.presence();
      let leased = false;
      const r2 = await hj.runJob(cfg, 'storage.usage', {}, { busy: true,
        now,
        sleep: async () => {
          if (!leased) {
            leased = true;
            const k = [...S.objects.keys()].find(x => x.startsWith('payesh/jobs/req/'));
            const jid = k.slice('payesh/jobs/req/'.length, -5);
            S.poke('payesh/jobs/lease/' + jid + '.json', JSON.stringify(hj.seal(cfg.secret, hj.K.lease, clock,
              JSON.stringify({ v: 1, job_id: jid, helper_id: b.id, token: '00', until: clock + 60000 }))));
          }
          clock += 30000;
        },
      });
      assert.strictEqual(r2.why, 'lease_expired'); assert.strictEqual(r2.ok, true);

      wipe();
      await fakeHelper(cfg, 'd000000000000001', { now, paused: true }).presence();
      const st = await hj.helpersOnline(cfg, { now: now() });
      assert.strictEqual(st[0].online, false);
      const r3 = await hj.runJob(cfg, 'storage.usage', {}, { busy: true, now, sleep: async () => {} });
      assert.strictEqual(r3.why, 'no_helper');

      /* حضور کهنه (بیش از ۹۰ ثانیه) ⇒ خاموش */
      wipe(); await b.presence(); clock += hj.PRESENCE_FRESH_MS + 1000;
      const r4 = await hj.runJob(cfg, 'storage.usage', {}, { busy: true, now, sleep: async () => {} });
      assert.strictEqual(r4.why, 'no_helper');
    });

    await check('HJ-06 نتیجهٔ کلید دیگر رد؛ خطای پارامتر تکرار نمی‌شود', async () => {
      wipe();
      const b = fakeHelper(cfg, 'b000000000000001', { now });
      await b.presence();
      const r = await hj.runJob(cfg, 'storage.usage', {}, { busy: true,
        now,
        sleep: async (ms) => {
          const k = [...S.objects.keys()].find(x => x.startsWith('payesh/jobs/req/'));
          if (k) {
            const jid = k.slice('payesh/jobs/req/'.length, -5);
            S.poke('payesh/jobs/res/' + jid + '.json', JSON.stringify(hj.seal('attacker', hj.K.result, clock,
              JSON.stringify({ v: 1, job_id: jid, helper_id: 'evil', ok: true, result: { objects: 999 } }))));
          }
          clock += ms;
        },
      });
      assert.strictEqual(r.by, 'local'); assert.notStrictEqual(r.result.objects, 999);

      wipe(); await b.presence();
      const r2 = await hj.runJob(cfg, 'storage.usage', {}, { busy: true,
        now,
        sleep: async (ms) => {
          const k = [...S.objects.keys()].find(x => x.startsWith('payesh/jobs/req/'));
          if (k) {
            const jid = k.slice('payesh/jobs/req/'.length, -5);
            S.poke('payesh/jobs/res/' + jid + '.json', JSON.stringify(hj.seal(cfg.secret, hj.K.result, clock,
              JSON.stringify({ v: 1, job_id: jid, helper_id: b.id, ok: false, result: null, error: 'bad_params' }))));
          }
          clock += ms;
        },
      });
      assert.strictEqual(r2.ok, false); assert.strictEqual(r2.error, 'bad_params'); assert.strictEqual(r2.by, b.id);
    });

    await check('HJ-07 صندوقچه در دسترس نیست ⇒ محلی', async () => {
      const dead = Object.assign({}, cfg, { endpoint: 'http://127.0.0.1:1' });
      const r = await hj.runJob(dead, 'endpoint.check', { url: 'https://example.com/' }, {
        now, sleep: async () => {}, checkEndpoint: async (u) => ({ reachable: true, status: 200, url: u }),
      });
      assert.strictEqual(r.why, 'bucket_unreachable'); assert.strictEqual(r.ok, true); assert.strictEqual(r.result.status, 200);
    });

    await check('HJ-08 پاکسازی', async () => {
      wipe();
      const oldId = hj.newJobId(clock - 2 * 3600_000), freshId = hj.newJobId(clock);
      S.poke('payesh/jobs/req/' + oldId + '.json', '{}');
      S.poke('payesh/jobs/req/' + freshId + '.json', '{}');
      S.poke('payesh/jobs/res/junk.json', '{}');
      S.poke('payesh/updates/owner/old.gz', 'z', Date.now() - 61 * 24 * 3600_000);
      S.poke('payesh/updates/owner/new.gz', 'z');
      const old = fakeHelper(cfg, 'e000000000000001', { now: () => clock - 8 * 24 * 3600_000 });
      await old.presence();
      await fakeHelper(cfg, 'e000000000000002', { now }).presence();
      S.poke('payesh/helpers/f000000000000001.json', JSON.stringify(hj.seal('other', hj.K.presence, 1, '{"v":1}')));
      const r = await hj.runLocal(cfg, 'bucket.gc', {}, { now: () => Date.now() });
      assert.deepStrictEqual(r, { deleted_jobs: 2, deleted_helpers: 1, deleted_blobs: 1 });
      assert.ok(S.objects.has('payesh/jobs/req/' + freshId + '.json'));
      assert.ok(S.objects.has('payesh/updates/owner/new.gz'));
      assert.ok(S.objects.has('payesh/helpers/f000000000000001.json'), 'پاکت کلید دیگر دست‌نخورده');
      assert.ok(S.objects.has('payesh/helpers/e000000000000002.json'));
    });

    await check('HJ-09 پارامترها و نشانی خصوصی', async () => {
      assert.throws(() => hj.validParams(cfg, 'storage.usage', { prefix: 'other/' }), e => e.code === 'bad_params');
      assert.throws(() => hj.validParams(cfg, 'object.verify', { key: 'payesh/../x' }), e => e.code === 'bad_params');
      assert.throws(() => hj.validParams(cfg, 'endpoint.check', { url: 'ftp://x' }), e => e.code === 'bad_params');
      assert.throws(() => hj.validParams(cfg, 'nope', {}), e => e.code === 'unknown_kind');
      const r = await hj.checkEndpoint('http://127.0.0.1:9/');
      assert.strictEqual(r.reachable, false); assert.strictEqual(r.error, 'private_address');
      const v = await hj.runLocal(cfg, 'object.verify', { key: 'payesh/schools/a/2.bin', size: 50,
        sha256: crypto.createHash('sha256').update('y'.repeat(50)).digest('hex') });
      assert.strictEqual(v.match, true);
      const miss = await hj.runLocal(cfg, 'object.verify', { key: 'payesh/schools/a/none.bin' });
      assert.strictEqual(miss.exists, false);
    });

    await check('HJ-10 فهرست صفحه‌بندی‌شده و LastModified', async () => {
      for (let i = 0; i < 25; i++) S.poke('payesh/many/' + String(i).padStart(3, '0'), 'm');
      const r = await s3mem.list(cfg, { prefix: 'payesh/many/', max: 10 });
      assert.strictEqual(r.keys.length, 10); assert.strictEqual(r.truncated, true); assert.ok(r.token);
      assert.ok(Date.parse(r.keys[0].modified) > 0);
      const all = await hj.listAll(cfg, 'payesh/many/');
      assert.strictEqual(all.keys.length, 25); assert.strictEqual(all.truncated, false);
    });

    await check('HJ-11 وضعیت و بررسی بیرونی (سرور مدرسه)', async () => {
      wipe();
      const meta = new Map();
      const store = { getMeta: (k, fb = null) => (meta.has(k) ? meta.get(k) : fb), setMeta: (k, v) => meta.set(k, v) };
      s3mem.usingMeta({ getMeta: (k, fb) => store.getMeta(k, fb), setMeta: (k, v) => store.setMeta(k, JSON.stringify(v)) });
      meta.set(s3mem.META_KEY, JSON.stringify(Object.assign({}, cfg)));
      await fakeHelper(cfg, 'b000000000000001', { now: Date.now }).presence();
      const st = await hj.status(store);
      assert.strictEqual(st.configured, true); assert.strictEqual(st.online, 1);
      const rec = await hj.checkPublicUrl(store, 'https://payesh.example.test/', {
        sleep: async () => {}, claimWaitMs: 1, checkEndpoint: async () => ({ reachable: true, status: 200 }),
      });
      assert.strictEqual(rec.by, 'local'); assert.strictEqual(rec.why, 'not_claimed'); assert.strictEqual(rec.reachable, true);
      assert.strictEqual(meta.get('helper:public_check').url, 'https://payesh.example.test/');
    });

    await check('HJ-12 پردازش کمکی فقط هنگام نیاز + سیاست مالک', async () => {
      wipe();
      S.objects.delete('payesh/' + hj.POLICY_KEY);
      hj._resetPolicyCache();
      assert.strictEqual(hj.helperNeed('storage.usage', { policy: null, busy: false }), 'not_needed');
      assert.strictEqual(hj.helperNeed('storage.usage', { policy: null, busy: true }), null);
      assert.strictEqual(hj.helperNeed('endpoint.check', { policy: null, busy: false }), null);
      assert.strictEqual(hj.helperNeed('endpoint.check', { policy: { helpers: false }, busy: true }), 'helpers_disabled');
      assert.strictEqual(typeof hj.busyNow(), 'boolean');

      const b = fakeHelper(cfg, 'b000000000000001', { now });
      await b.presence();
      /* سرور جا دارد ⇒ همین سرور؛ هیچ فایلی در صف نوشته نمی‌شود */
      let slept = 0;
      const r1 = await hj.runJob(cfg, 'storage.usage', {}, { busy: false, now, sleep: async () => { slept++; } });
      assert.strictEqual(r1.by, 'local'); assert.strictEqual(r1.why, 'not_needed'); assert.strictEqual(slept, 0);
      assert.deepStrictEqual([...S.objects.keys()].filter(k => k.startsWith('payesh/jobs/')), []);
      /* شلوغ ⇒ سرور کمکی */
      const r2 = await hj.runJob(cfg, 'storage.usage', {}, { busy: () => true, now, sleep: async (ms) => { clock += ms; await b.poll(); } });
      assert.strictEqual(r2.by, b.id);
      /* بررسی از بیرون حتی وقتی سرور جا دارد */
      const r3 = await hj.runJob(cfg, 'endpoint.check', { url: 'https://example.com/' }, {
        busy: false, now, sleep: async (ms) => { clock += ms; }, claimWaitMs: 1,
        checkEndpoint: async () => ({ reachable: true, status: 200 }),
      });
      assert.strictEqual(r3.why, 'not_claimed', 'به صف رفت (سرور کمکی ثبت‌شده برنداشت)');

      /* سیاست مالک: پردازش کمکی خاموش (پاکت رمزشده در control/) */
      const pol = { v: 1, helpers: false, off: ['svc-1'], at: clock };
      await hj.writePolicy(cfg, pol);
      hj._resetPolicyCache();
      assert.deepStrictEqual(await hj.readPolicy(cfg), pol);
      const r4 = await hj.runJob(cfg, 'storage.usage', {}, { busy: true, now, sleep: async () => { throw new Error('نباید منتظر بماند'); } });
      assert.strictEqual(r4.why, 'helpers_disabled'); assert.strictEqual(r4.by, 'local');
      const meta = new Map([[s3mem.META_KEY, JSON.stringify(Object.assign({}, cfg))]]);
      const store = { getMeta: (k, fb = null) => (meta.has(k) ? meta.get(k) : fb), setMeta: (k, v) => meta.set(k, v) };
      s3mem.usingMeta({ getMeta: (k, fb) => store.getMeta(k, fb), setMeta: (k, v) => store.setMeta(k, JSON.stringify(v)) });
      const st = await hj.status(store);
      assert.strictEqual(st.use_helpers, false); assert.strictEqual(st.when, 'need');
      /* پاکت با کلید دیگر یا شکل نادرست نادیده گرفته می‌شود */
      await s3mem.put(cfg, 'payesh/' + hj.POLICY_KEY, JSON.stringify(hj.seal('other', hj.K.policy, 1, JSON.stringify(pol))));
      hj._resetPolicyCache();
      assert.strictEqual(await hj.readPolicy(cfg), null);
      assert.strictEqual(hj.validPolicy({ v: 1, helpers: 'no', off: [], at: 1 }), false);
      S.objects.delete('payesh/' + hj.POLICY_KEY);
      hj._resetPolicyCache();
    });
  } finally {
    await S.close();
  }

  const line = failures.length ? 'HELPER-JOBS-130-FAIL failures=' + failures.length : 'HELPER-JOBS-130-OK checks=' + checks;
  console.log(line);
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.log('FAIL fatal — ' + (e && e.stack)); console.log('HELPER-JOBS-130-FAIL failures=1'); process.exit(1); });
