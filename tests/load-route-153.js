// سه حالت معماری و مسیر بار (ردیف ۱۵۳) — server/load-route.js + server/helper-jobs.js + /metrics.
//
//   LR-01  بردارهای قرارداد load-route v1 (همان نتیجهٔ پنل مالک Dart): همهٔ سناریوها گام‌به‌گام، p95، حالت هر سیاست.
//   LR-02  پنجرهٔ لغزان: p95 فقط از پاسخ‌های موفق، نرخ خطا، درخواست در دقیقه، کنار رفتن نمونه‌های کهنه‌تر از ۶۰ ثانیه و سقف ۲۰۰.
//   LR-03  helperNeed: «فقط دیتابیس» ⇒ هرگز سیستم کمکی؛ helpers ⇒ فقط وقتی مسیر بار آن را به کار گرفته یا سرور شلوغ است.
//   LR-04  سیاست: mode/external اختیاری و اعتبارسنجی‌شده، سیاست قدیمی ⇒ helpers/db، کلید هر سیستم کمکی (helper:<id>).
//   LR-05  درخواست‌های واقعی دیتابیس (صندوقچهٔ S3 محلی با SigV4) اندازه‌گیری می‌شوند؛ خطا هم ثبت می‌شود؛
//          سرور بیرونی: /healthz، نتیجه ۳۰ ثانیه نگه داشته می‌شود، در دسترس نبودن ⇒ زنجیرهٔ دیتابیس.
//   LR-06  runJob: مسیر بار به کار گرفتن سیستم‌های کمکی را تعیین می‌کند (no_helper در برابر not_needed / helpers_disabled)
//          و سیستم کمکیِ خاموش‌شده (helper:<id>) کار نمی‌گیرد.
//   LR-07  سرور واقعی: /metrics سنجه‌های بار لحظه‌ای دیتابیس و پلهٔ مسیر بار را دارد.
// خط آخر: LOAD-ROUTE-153-OK checks=N | LOAD-ROUTE-153-FAIL failures=N
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const lr = require(path.join(ROOT, 'server', 'load-route.js'));
const hj = require(path.join(ROOT, 'server', 'helper-jobs.js'));
const s3mem = require(path.join(ROOT, 'server', 's3mem.js'));
const { startStub } = require('./lib/s3-stub');

let checks = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); checks++; console.log('ok   ' + name); }
  catch (e) { failures.push(name); console.log('FAIL ' + name + ' — ' + String((e && e.stack) || e).split('\n').slice(0, 4).join(' | ')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function get(port, p) {
  return new Promise((res) => {
    const r = http.request({ method: 'GET', host: '127.0.0.1', port, path: p }, (rs) => {
      let t = ''; rs.setEncoding('utf8'); rs.on('data', (c) => { t += c; }); rs.on('end', () => res({ status: rs.statusCode, body: t }));
    });
    r.on('error', (e) => res({ status: 0, body: String(e.message) }));
    r.end();
  });
}

const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/cloud/contracts/load-route-vectors.json'), 'utf8'));

(async () => {
  await check('LR-01 بردارهای قرارداد load-route v1', async () => {
    assert.strictEqual(V.v, 1);
    assert.deepStrictEqual(V.thresholds, Object.assign({}, lr.THRESHOLDS));
    assert.ok(V.scenarios.length >= 7);
    for (const sc of V.scenarios) {
      let st = null;
      sc.steps.forEach((s, i) => {
        st = lr.step(st, s.sample);
        const got = Object.assign({}, st, { active: lr.routeOf(st).active });
        assert.deepStrictEqual(got, s.expect, sc.name + ' گام ' + i);
      });
    }
    for (const x of V.p95) assert.strictEqual(lr.p95(x.values), x.p95);
    for (const x of V.policies) assert.strictEqual(lr.modeOf(x.policy), x.mode);
    /* پوشش رفتارها در خود بردارها */
    const reasons = new Set(V.scenarios.flatMap(sc => sc.steps.map(s => s.expect.reason)));
    for (const r of ['escalate:db', 'escalate:external', 'recovered:db', 'recovered:external', 'no_helpers', 'external_down']) assert.ok(reasons.has(r), r);
    const ext = V.scenarios.find(s => s.name === 'external_chain_escalates_then_returns');
    assert.deepStrictEqual(ext.steps[2].expect.active, ['external', 'db', 'helpers']);
    assert.deepStrictEqual(ext.steps.at(-1).expect.active, ['external']);
  });

  await check('LR-02 پنجرهٔ لغزان زمان پاسخ و خطا', async () => {
    const w = new lr.LatencyWindow();
    const t0 = 1_000_000;
    for (let i = 1; i <= 19; i++) w.record(i * 10, true, t0 + i);
    w.record(5000, false, t0 + 20);           /* خطا در p95 حساب نمی‌شود */
    let s = w.stats(t0 + 30);
    assert.strictEqual(s.n, 20); assert.strictEqual(s.p95, 190); assert.strictEqual(s.err, 0.05);
    assert.strictEqual(s.avg, 100); assert.strictEqual(s.per_min, 20);
    s = w.stats(t0 + 60_015);                  /* نمونه‌های پیش از t0+15 کنار می‌روند */
    assert.strictEqual(s.n, 6);
    const big = new lr.LatencyWindow();
    for (let i = 0; i < 250; i++) big.record(1, true, t0);
    assert.strictEqual(big.stats(t0).n, 200);
    assert.deepStrictEqual(new lr.LatencyWindow().stats(t0), { n: 0, p95: 0, avg: 0, err: 0, per_min: 0 });
  });

  await check('LR-03 helperNeed با حالت معماری و مسیر بار', async () => {
    const on = { active: ['db', 'helpers'] }, off = { active: ['db'] };
    assert.strictEqual(hj.helperNeed('storage.usage', { policy: { helpers: true, mode: 'helpers' }, busy: false, route: off }), 'not_needed');
    assert.strictEqual(hj.helperNeed('storage.usage', { policy: { helpers: true, mode: 'helpers' }, busy: false, route: on }), null);
    assert.strictEqual(hj.helperNeed('storage.usage', { policy: { helpers: true, mode: 'external' }, busy: false, route: { active: ['external', 'db', 'helpers'] } }), null);
    assert.strictEqual(hj.helperNeed('storage.usage', { policy: { helpers: true, mode: 'helpers' }, busy: true, route: off }), null);
    assert.strictEqual(hj.helperNeed('storage.usage', { policy: { helpers: false, mode: 'db' }, busy: true, route: on }), 'helpers_disabled');
    assert.strictEqual(hj.helperNeed('endpoint.check', { policy: { helpers: true, mode: 'db' }, busy: false }), 'helpers_disabled');
    assert.strictEqual(hj.helperNeed('endpoint.check', { policy: null, busy: false }), null);
    /* سازگاری با فراخوانی قدیمی بدون route */
    assert.strictEqual(hj.helperNeed('storage.usage', { policy: null, busy: false }), 'not_needed');
  });

  await check('LR-04 سیاست: mode، external، کلید هر سیستم کمکی', async () => {
    const base = { v: 1, helpers: true, off: [], at: 5 };
    assert.ok(hj.validPolicy(base));
    assert.ok(hj.validPolicy(Object.assign({}, base, { mode: 'external', external: 'https://ext.example.ir' })));
    assert.ok(hj.validPolicy(Object.assign({}, base, { mode: 'db', external: '' })));
    assert.ok(!hj.validPolicy(Object.assign({}, base, { mode: 'cloud' })));
    assert.ok(!hj.validPolicy(Object.assign({}, base, { external: 7 })));
    assert.ok(!hj.validPolicy(Object.assign({}, base, { external: 'x'.repeat(301) })));
    assert.strictEqual(lr.modeOf({ helpers: false }), 'db');
    assert.strictEqual(lr.modeOf({ helpers: true, mode: 'bogus' }), 'helpers');
    assert.ok(hj.helperOff({ off: ['helper:abcd1234abcd1234'] }, 'abcd1234abcd1234'));
    assert.ok(!hj.helperOff({ off: ['abcd1234abcd1234'] }, 'abcd1234abcd1234'));
    assert.ok(!hj.helperOff(null, 'abcd1234abcd1234'));
    assert.deepStrictEqual(lr.chainFor('external', false), ['db', 'helpers']);
  });

  const stub = await startStub({ accessKey: 'ak-lr', secret: 'sk-load-route-1', bucket: 'payesh-madrese' });
  const cfg = s3mem.normalize(stub.cfg);
  try {
    await check('LR-05 اندازه‌گیری درخواست‌های واقعی دیتابیس و سرور بیرونی', async () => {
      lr._reset();
      await s3mem.put(cfg, cfg.prefix + 'probe/a.json', '{"a":1}');
      await s3mem.get(cfg, cfg.prefix + 'probe/a.json');
      const s = lr.db.stats();
      assert.ok(s.n >= 2, JSON.stringify(s)); assert.strictEqual(s.err, 0);
      /* خطا (پاسخ 5xx یا شبکه) ثبت می‌شود */
      const bad = lr.metered(() => Promise.reject(new Error('ECONNRESET')));
      await assert.rejects(bad('http://x/'));
      const five = lr.metered(() => Promise.resolve({ status: 503 }));
      await five('http://x/');
      assert.ok(lr.db.stats().err > 0);
      /* سرور بیرونی */
      lr._reset();
      const calls = [];
      const okFetch = (u) => { calls.push(u); return Promise.resolve({ status: 200 }); };
      let p = await lr.probeExternal('https://ext.example.ir/', okFetch, 1000);
      assert.ok(p.ok); assert.deepStrictEqual(calls, ['https://ext.example.ir/healthz']);
      await lr.probeExternal('https://ext.example.ir/', okFetch, 20_000);
      assert.strictEqual(calls.length, 1, 'نتیجه ۳۰ ثانیه نگه داشته می‌شود');
      const pol = { v: 1, helpers: true, off: [], at: 1, mode: 'external', external: 'https://ext.example.ir/' };
      assert.deepStrictEqual(lr.tick(pol, { now: 20_000 }).chain, ['external', 'db', 'helpers']);
      p = await lr.probeExternal('https://ext.example.ir/', () => Promise.reject(new Error('down')), 40_000);
      assert.ok(!p.ok);
      const r = lr.tick(pol, { now: 40_000 });
      assert.deepStrictEqual(r.chain, ['db', 'helpers']); assert.strictEqual(r.reason, 'external_down');
      assert.strictEqual(lr.tick({ v: 1, helpers: false, off: [], at: 1 }, { now: 45_000 }).primary, 'db');
      lr._reset();
    });

    await check('LR-06 runJob پیرو مسیر بار و کلید هر سیستم کمکی', async () => {
      hj._resetPolicyCache();
      const policy = { v: 1, helpers: true, off: [], at: 1, mode: 'helpers' };
      let r = await hj.runJob(cfg, 'storage.usage', {}, { policy, busy: false, route: { active: ['db'] } });
      assert.strictEqual(r.by, 'local'); assert.strictEqual(r.why, 'not_needed');
      r = await hj.runJob(cfg, 'storage.usage', {}, { policy, busy: false, route: { active: ['db', 'helpers'] } });
      assert.strictEqual(r.by, 'local'); assert.strictEqual(r.why, 'no_helper');
      r = await hj.runJob(cfg, 'storage.usage', {}, { policy: Object.assign({}, policy, { mode: 'db' }), busy: true, route: { active: ['db', 'helpers'] } });
      assert.strictEqual(r.why, 'helpers_disabled');
      /* یک سیستم کمکیِ زنده که مالک خاموشش کرده ⇒ کار نمی‌گیرد */
      const now = Date.now();
      await s3mem.put(cfg, cfg.prefix + hj.DIR.helpers + 'abcd1234abcd1234.json', JSON.stringify(hj.seal(cfg.secret, hj.K.presence, now, JSON.stringify({ v: 1, helper_id: 'abcd1234abcd1234', host: 'pc', version: 't', slots: 1, paused: false, kinds: hj.KINDS, at: now, done: 0 }))));
      const online = await hj.helpersOnline(cfg);
      assert.ok(online.some(h => h.helper_id === 'abcd1234abcd1234' && h.online), JSON.stringify(online));
      r = await hj.runJob(cfg, 'storage.usage', {}, { policy: Object.assign({}, policy, { off: ['helper:abcd1234abcd1234'] }), busy: true, route: { active: ['db', 'helpers'] } });
      assert.strictEqual(r.why, 'no_helper');
      /* بدون route صریح: routeNow خودش مسیر را می‌سازد (دیتابیس آرام ⇒ not_needed) */
      lr._reset();
      r = await hj.runJob(cfg, 'storage.usage', {}, { policy, busy: false });
      assert.strictEqual(r.why, 'not_needed');
    });
  } finally {
    await stub.close();
  }

  await check('LR-07 سرور واقعی: سنجه‌های بار لحظه‌ای در /metrics', async () => {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr153srv-'));
    const env = Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: dir, PAYESH_LOG: '0', PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0',
      PAYESH_LIVE_MS: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0', PAYESH_MIRROR: '0', PAYESH_HEADLESS: '1',
    });
    delete env.PAYESH_METRICS_TOKEN;
    const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (c) => { log += c; }); child.stderr.on('data', (c) => { log += c; });
    try {
      let up = false;
      for (let i = 0; i < 200 && !up; i++) { up = (await get(port, '/api/health')).status === 200; if (!up) await sleep(100); }
      assert.ok(up, 'server up\n' + log);
      const m = await get(port, '/metrics');
      assert.strictEqual(m.status, 200);
      for (const name of ['payesh_db_latency_p95_ms', 'payesh_db_latency_avg_ms', 'payesh_db_requests_per_min', 'payesh_db_error_ratio', 'payesh_route_level', 'payesh_route_helpers_active']) {
        assert.match(m.body, new RegExp('^' + name + ' ', 'm'), name);
      }
      assert.match(m.body, /^payesh_route_level 0$/m);
    } finally {
      child.kill('SIGTERM');
      await sleep(200);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(failures.length ? 'LOAD-ROUTE-153-FAIL failures=' + failures.length : 'LOAD-ROUTE-153-OK checks=' + checks);
  process.exit(failures.length ? 1 : 0);
})();
