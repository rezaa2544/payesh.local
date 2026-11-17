'use strict';
/* ═══════════════════════════════════════════════════════════
   ردیف ۱۶۷ — یک سرور پایش، همهٔ مدارس پنل مالک · نقش رایگان · آزمایشی
     H-01..H-02  اشتراک: نقشی که هیچ گزینهٔ پولی ندارد (هر دو برداشته یا مبلغ صفر) رایگان است؛
                 نقش با گزینهٔ پولی ⇒ پشت دیوار با «آزمایشی در دسترس»، و آزمایشی واقعاً دسترسی می‌دهد.
     H-03        پیشوندها: دادهٔ مدرسهٔ میزبانی‌شده زیر <prefix>h/<id>/، پرونده‌های مشترک مالک همان پیشوند.
     H-04        NEG: سرور میزبانی‌شده فقط کلید همین فرایند از 127.0.0.1 را می‌پذیرد.
     H-05        برداشتن مدرسه روی سرور میزبانی‌شده: تازه ⇒ همان مدرسه؛ میزبان دیگر ⇒ رد.
     H-06        سرور واقعی: مدرسهٔ دوم پنل مالک خودکار سرور می‌گیرد (رسید «سرور وصل»)، مدیرش از همان
                 نشانی وارد می‌شود، هر نشست به سرور مدرسهٔ خودش می‌رود؛ رمز غلط رد؛ refresh کار می‌کند.
   ═══════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const sr = require(path.join(ROOT, 'server', 'school-registry.js'));
const s3mem = require(path.join(ROOT, 'server', 's3mem.js'));
const auth = require(path.join(ROOT, 'server', 'auth.js'));
const hosting = require(path.join(ROOT, 'server', 'hosting.js'));
const { openStore } = require(path.join(ROOT, 'server', 'db.js'));
const { pbkdf2Hash } = require(path.join(ROOT, 'server', 'util.js'));
const { startStub } = require('./lib/s3-stub');

let checks = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); checks++; console.log('ok   ' + name); }
  catch (e) { failures.push(name); console.log('FAIL ' + name + ' — ' + String((e && e.stack) || e).split('\n').slice(0, 4).join(' | ')); }
}

const tmpDirs = [];
function newDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'h167-')); tmpDirs.push(d); return d; }
function newStore(cfg, dir = newDir()) {
  const store = openStore(path.join(dir, 'payesh.sqlite'));
  if (cfg) s3mem.usingMeta(store).set(Object.assign({}, cfg));
  return store;
}

const schoolA = () => ({
  id: 's-adefbf8ae8ff', name: 'کاردانش آینده سازان', level: 'متوسطه دوم', active: true,
  manager: { username: 'rezaa254', name: 'رضا', phone: '09187888993', national_id: '0012345679', password_hash: pbkdf2Hash('Owner-Pass-1'), rev: 1 },
});
const schoolB = () => ({
  id: 's-0b1c2d3e4f5a', name: 'دبستان آزادی (2)', level: 'ابتدایی', active: true, province: 'کردستان', county: 'بانه',
  manager: { username: '09142869505', name: 'ریزان احمدی', phone: '09142869505', national_id: '3720000001', password_hash: pbkdf2Hash('3720000001'), rev: 1 },
});
const plainOf = (schools, settings = {}) => ({ v: 1, schools, settings, domain: '', grants: [], decisions: {}, rejected: [] });

async function publishRegistry(cfg, rev, plain) {
  await s3mem.put(cfg, cfg.prefix + sr.DIR.registry, JSON.stringify(sr.seal(cfg.secret, sr.K.registry, rev, JSON.stringify(plain))));
}
async function readAck(cfg, sid) {
  const raw = await s3mem.get(cfg, cfg.prefix + sr.DIR.ack + sid + '.json').catch(() => null);
  return raw ? sr.open(cfg.secret, sr.K.ack, JSON.parse(raw)).plain : null;
}

/* سرور اصلی که آینده‌سازان را دارد */
function boundRoot(cfg, plain, dir) {
  const st = newStore(cfg, dir);
  st.setMeta('schools:registry', { rev: 1, plain, at: new Date().toISOString() });
  sr.adoptSchool(st, plain.schools[0], { instance: 'root-instance-0001' });
  return st;
}

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const req = (method, port, p, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'content-type': 'application/json' }, data ? { 'content-length': data.length } : {}, headers) }, (res) => {
    let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j, body: t, headers: res.headers }); });
  });
  r.on('error', reject); if (data) r.write(data); r.end();
});
async function boot(dir, extraEnv) {
  const port = await freePort();
  const env = Object.assign({}, process.env, {
    PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: dir, PAYESH_LOG: '1', PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0',
    PAYESH_LIVE_MS: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0', PAYESH_MIRROR: '0', PAYESH_HEADLESS: '1',
    PAYESH_DISCOVERY: '0', PAYESH_NO_RESTART: '1',
  }, extraEnv || {});
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const box = { port, child, log: '' };
  child.stdout.on('data', (c) => { box.log += c; }); child.stderr.on('data', (c) => { box.log += c; });
  let up = false;
  for (let i = 0; i < 200 && !up; i++) { up = await req('GET', port, '/api/health').then(r => r.status === 200, () => false); if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'server up\n' + box.log.slice(-2000));
  return box;
}
const stop = (box) => new Promise((res) => { box.child.once('exit', res); box.child.kill('SIGTERM'); setTimeout(res, 3000); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const S = await startStub({ accessKey: 'ak-167', secret: 'sk-hosted-167', bucket: 'payesh-madrese' });
  const cfg = s3mem.normalize(S.cfg);
  try {
    await check('H-01 نقش «نیاز به اشتراک» بدون هیچ گزینهٔ پولی (هر دو برداشته / مبلغ صفر) ⇒ رایگان؛ با گزینهٔ پولی ⇒ دیوار', async () => {
      const st = newStore(null);
      const mk = (rp) => plainOf([schoolA()], { paywall_enabled: true, trial_enabled: true, trial_days: 21, roles: { manager: 'required', teacher: 'required' }, role_plans: rp });
      sr.adoptSchool(st, schoolA(), { instance: 'i' });
      const mgr = st.all('users').find(u => u.role === 'manager');
      const at = (rp) => { st.setMeta('schools:registry', { rev: 1, plain: mk(rp) }); return sr.gate(st, mgr); };
      let g = at({ manager: { monthly: null, yearly: null } });
      assert.deepStrictEqual({ a: g.access, s: g.status, p: g.policy }, { a: true, s: 'free', p: 'free' }, JSON.stringify(g));
      g = at({ manager: { monthly: 0, yearly: null } });
      assert.strictEqual(g.access, true); assert.strictEqual(g.status, 'free');
      g = at({ manager: { monthly: 0, yearly: 2200000 } });
      assert.deepStrictEqual({ a: g.access, s: g.status, p: g.policy, t: g.trial_available }, { a: false, s: 'none', p: 'required', t: true });
      assert.deepStrictEqual(g.plans.map(p => p.key), ['monthly', 'yearly']);
      st.close();
    });

    await check('H-02 آزمایشی روشن ⇒ کاربر نقش پولی همان دوره دسترسی دارد (یک بار برای هر دستگاه)؛ نقش رایگان ⇒ not_required', async () => {
      S.objects.clear();
      const st = newStore(cfg);
      st.setMeta('schools:registry', { rev: 1, plain: plainOf([schoolA()], { paywall_enabled: true, trial_enabled: true, trial_days: 21, roles: { manager: 'required' }, role_plans: { manager: { monthly: 300000, yearly: null } } }) });
      sr.adoptSchool(st, schoolA(), { instance: 'i' });
      const mgr = st.all('users').find(u => u.role === 'manager');
      const dh = crypto.createHash('sha256').update('dev-167').digest('hex');
      const r = await sr.startTrial(st, mgr, dh);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual({ a: r.sub.access, s: r.sub.status }, { a: true, s: 'trial' });
      assert.ok(r.sub.days_left >= 20 && r.sub.days_left <= 22, String(r.sub.days_left));
      st.setMeta('schools:registry', { rev: 2, plain: plainOf([schoolA()], { paywall_enabled: true, roles: { manager: 'required' }, role_plans: { manager: { monthly: null, yearly: null } } }) });
      const t = st.insert('users', { name: 'م', role: 'teacher', active: true, school_id: 1 });
      assert.strictEqual((await sr.startTrial(st, t, dh)).error, 'not_required');
      st.close();
    });

    await check('H-03 پیشوندها: دادهٔ مدرسهٔ میزبانی‌شده جدا، پرونده‌های مشترک مالک همان', async () => {
      assert.strictEqual(hosting.dataPrefix('payesh/', 's-0b1c2d3e4f5a'), 'payesh/h/s-0b1c2d3e4f5a/');
      const st = newStore(Object.assign({}, cfg, { prefix: 'payesh/h/s-0b1c2d3e4f5a/' }));
      assert.strictEqual(sr.cloud(st).prefix, 'payesh/h/s-0b1c2d3e4f5a/', 'پیش از پیام سرور اصلی');
      st.setMeta(hosting.CONTROL_META, { prefix: 'payesh/' });
      assert.strictEqual(sr.cloud(st).prefix, 'payesh/', 'فهرست مدارس/پرداخت/رسید ⇒ پیشوند مالک');
      assert.strictEqual(s3mem.usingMeta(st).get().prefix, 'payesh/h/s-0b1c2d3e4f5a/', 'داده/پشتیبان/آینه ⇒ پیشوند خود مدرسه');
      st.close();
      const root = newStore(cfg);
      assert.strictEqual(sr.cloud(root).prefix, 'payesh/', 'سرور اصلی دست نخورد');
      root.close();
    });

    await check('H-04 NEG: سرور میزبانی‌شده — بی‌کلید / کلید غلط / از بیرون ⇒ نه', async () => {
      const mk = (remote, key) => ({ socket: { remoteAddress: remote }, headers: key == null ? {} : { [hosting.H_KEY]: key } });
      assert.strictEqual(hosting.trusted(mk('127.0.0.1', 'k-1'), 'k-1'), true);
      assert.strictEqual(hosting.trusted(mk('::ffff:127.0.0.1', 'k-1'), 'k-1'), true);
      assert.strictEqual(hosting.trusted(mk('127.0.0.1', null), 'k-1'), false);
      assert.strictEqual(hosting.trusted(mk('127.0.0.1', 'k-2'), 'k-1'), false);
      assert.strictEqual(hosting.trusted(mk('192.168.1.20', 'k-1'), 'k-1'), false);
      assert.strictEqual(hosting.trusted(mk('127.0.0.1', ''), ''), false, 'بدون کلید فرایند هرگز');
    });

    await check('H-05 سرور تازهٔ میزبانی‌شده ⇒ همان مدرسهٔ پنل مالک؛ میزبان دیگر ⇒ school_hosted_elsewhere', async () => {
      S.objects.clear();
      await publishRegistry(cfg, 5, plainOf([schoolA(), schoolB()]));
      const deps = { schools: sr, auth };
      const st = newStore(null);
      const sent = [];
      await hosting.onParentMessage(st, { type: 'cloud', cfg: Object.assign({}, cfg) }, Object.assign({ sid: 's-0b1c2d3e4f5a', s3mem, instance: 'child-b', send: (m) => sent.push(m) }, deps));
      assert.deepStrictEqual(sent, [{ type: 'adopted', ok: true, error: null, bound: true }]);
      assert.strictEqual(st.get('schools', 1).name, 'دبستان آزادی (2)');
      assert.strictEqual(s3mem.usingMeta(st).get().prefix, 'payesh/h/s-0b1c2d3e4f5a/');
      assert.strictEqual(auth.login(st, { phone: '09142869505', password: '3720000001', platform: 'android' }).ok, true);
      assert.strictEqual((await readAck(cfg, 's-0b1c2d3e4f5a')).instance, 'child-b', 'رسید ⇒ «سرور وصل» در پنل مالک');
      /* دوباره: کاری نمی‌کند */
      assert.deepStrictEqual(await hosting.adoptHosted(st, 's-0b1c2d3e4f5a', Object.assign({ instance: 'child-b' }, deps)), { ok: true, adopted: false });
      st.close();
      /* میزبان دیگر */
      const st2 = newStore(null);
      await hosting.onParentMessage(st2, { type: 'cloud', cfg: Object.assign({}, cfg) }, Object.assign({ sid: 's-0b1c2d3e4f5a', s3mem, instance: 'other-pc' }, deps));
      assert.strictEqual(sr.boundOf(st2), null);
      assert.strictEqual((await hosting.adoptHosted(st2, 's-0b1c2d3e4f5a', Object.assign({ instance: 'other-pc' }, deps))).error, 'school_hosted_elsewhere');
      assert.strictEqual((await hosting.adoptHosted(st2, 's-missing', Object.assign({ instance: 'x' }, deps))).error, 'not_found');
      st2.close();
    });

    await check('H-06 سرور واقعی: مدرسهٔ دوم خودکار سرور می‌گیرد؛ هر کاربر از همان نشانی به سرور مدرسهٔ خودش', async () => {
      S.objects.clear();
      const plain = plainOf([schoolA(), schoolB()]);
      await publishRegistry(cfg, 7, plain);
      const dir = newDir();
      boundRoot(cfg, plain, dir).close();
      const box = await boot(dir, { PAYESH_CLOUD_AUTO: '1', PAYESH_HOSTING_FIRST_MS: '300', PAYESH_HOSTING_EVERY_MS: '2000', PAYESH_SCHOOLS_EVERY_MS: '2000' });
      try {
        /* رسید سرور مدرسهٔ دوم (= «سرور وصل» در پنل مالک)، بدون هیچ ورودی */
        let ack = null;
        for (let i = 0; i < 150 && !ack; i++) { ack = await readAck(cfg, 's-0b1c2d3e4f5a'); if (!ack) await sleep(100); }
        assert.ok(ack, 'رسید مدرسهٔ دوم\n' + box.log.slice(-3000));
        assert.notStrictEqual(ack.instance, 'root-instance-0001');
        assert.ok(fs.existsSync(path.join(dir, 'hosted', 's-0b1c2d3e4f5a', 'payesh.sqlite')), 'پوشهٔ دادهٔ جدا');

        const lb = await req('POST', box.port, '/api/auth/login', { phone: '09142869505', password: '3720000001', platform: 'android' });
        assert.strictEqual(lb.status, 200, lb.body + '\n' + box.log.slice(-2000));
        assert.strictEqual(lb.json.user.role, 'manager');
        const la = await req('POST', box.port, '/api/auth/login', { phone: 'rezaa254', password: 'Owner-Pass-1', platform: 'android' });
        assert.strictEqual(la.status, 200, la.body);

        const sb = await req('GET', box.port, '/api/sub/status', null, { authorization: 'Bearer ' + lb.json.session.token });
        assert.strictEqual(sb.status, 200, sb.body); assert.strictEqual(sb.json.school, 'دبستان آزادی (2)');
        const sa = await req('GET', box.port, '/api/sub/status', null, { authorization: 'Bearer ' + la.json.session.token });
        assert.strictEqual(sa.status, 200, sa.body); assert.strictEqual(sa.json.school, 'کاردانش آینده سازان');

        /* NEG: رمز غلط؛ نشست ناشناس */
        const bad = await req('POST', box.port, '/api/auth/login', { phone: '09142869505', password: 'wrong-pass', platform: 'android' });
        assert.strictEqual(bad.status, 401, bad.body);
        assert.strictEqual((await req('GET', box.port, '/api/sub/status', null, { authorization: 'Bearer nope' })).status, 401);
        /* NEG: مسیر داخلی از بیرون دیده نمی‌شود */
        assert.strictEqual((await req('POST', box.port, '/__hosted/owns', { token: lb.json.session.token })).status, 404);

        /* «یک‌بار ورود، همیشه داخل»: refresh دستگاه مدرسهٔ دوم */
        assert.ok(lb.json.device_token);
        const rf = await req('POST', box.port, '/api/auth/refresh', { device_token: lb.json.device_token });
        assert.strictEqual(rf.status, 200, rf.body);
        assert.strictEqual(rf.json.user.name, 'ریزان احمدی');
        const sr2 = await req('GET', box.port, '/api/sub/status', null, { authorization: 'Bearer ' + rf.json.session.token });
        assert.strictEqual(sr2.json.school, 'دبستان آزادی (2)', 'نشست تازه هم به سرور مدرسهٔ دوم');
      } finally { if (process.env.H167_LOG) console.log(box.log); await stop(box); }
    });
  } finally {
    await S.close();
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* noop */ } }
  }
  console.log('HOSTED-167 ' + (failures.length ? 'FAIL' : 'PASS') + ' — ' + checks + ' checks' + (failures.length ? ' · failed: ' + failures.join(', ') : ''));
  process.exit(failures.length ? 1 : 0);
})();
