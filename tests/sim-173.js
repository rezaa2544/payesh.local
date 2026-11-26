'use strict';
/* ═══════════════════════════════════════════════════════════
   ردیف ۱۷۳ — شبیه‌سازی کامل داکر (tools/sim) · عیب‌های پیدا‌شده و رفعشان
     S173-01  D4: پروکسی معکوسِ جدا (PAYESH_TRUST_PROXY = IP/CIDR) ⇒ X-Forwarded-For پذیرفته؛
              بی‌فهرست فقط loopback؛ 0 ⇒ هیچ؛ نشانی بیرون از فهرست ⇒ نه (جعل XFF از بیرون بی‌اثر).
     S173-02  D2: ریشه‌های NODE_EXTRA_CA_CERTS در caList (گزینهٔ ca جایگزین پیش‌فرض Node است).
     S173-03  D3: سرور با کلید محیطی ⇒ نشانی/نام صندوقچه هم از محیط (PAYESH_S3_ENDPOINT/BUCKET/…)؛
              نشانی http غیرمحلی یا نام نامعتبر ⇒ پیش‌فرض.
     S173-04  D5: سرور مرکزی (PAYESH_CENTRAL=1، بی‌مدرسه) خودکار میزبان مدرسه‌های پنل مالک است،
              مدیر از همان نشانی وارد می‌شود و خودِ مرکزی هرگز به مدرسه‌ای گره نمی‌خورد.
     S173-05  D6: مدرسهٔ میزبانی‌شدهٔ غیرفعال ⇒ کاربرش «school_inactive» (۴۰۳) می‌بیند نه «رمز اشتباه»؛
              کاربران مدرسهٔ دیگرِ همان سرور بی‌اثر؛ رمز غلط همچنان ۴۰۱.
     S173-06  D7 + D9 + ابزار: سرورِ تازه گره‌خورده فوراً نشانی‌اش را منتشر می‌کند؛ تصویر داکر
              نسخهٔ واقعی را می‌گوید (نه 0.0.0)؛ پرونده‌های شبیه‌سازی
              (compose، درگاه HTTPS، صندوقچه، راننده) سالم و بی‌کلید واقعی.
     S173-07  D14: نوسازی دستگاه پس از ری‌استارت سرور مرکزی ⇒ خطای خودِ مدرسهٔ میزبانی‌شده (نه bad_device).
   ═══════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const sr = require(path.join(ROOT, 'server', 'school-registry.js'));
const s3mem = require(path.join(ROOT, 'server', 's3mem.js'));
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
function newDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 's173-')); tmpDirs.push(d); return d; }
const fresh = (mod) => { const p = require.resolve(path.join(ROOT, 'server', mod)); delete require.cache[p]; return require(p); };
function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}

const schoolA = () => ({
  id: 's-a17300000001', name: 'دبیرستان شبیه‌سازی الف', level: 'متوسطه دوم', active: true,
  manager: { username: 'sima173', name: 'مدیر الف', phone: '09120000173', national_id: '0012345679', password_hash: pbkdf2Hash('Sim-A-pass-1'), rev: 1 },
});
const schoolB = () => ({
  id: 's-b17300000002', name: 'دبستان شبیه‌سازی ب', level: 'ابتدایی', active: true,
  manager: { username: 'simb173', name: 'مدیر ب', phone: '09130000173', national_id: '3720000001', password_hash: pbkdf2Hash('Sim-B-pass-1'), rev: 1 },
});
const plainOf = (schools) => ({ v: 1, schools, settings: { trial_enabled: true, trial_days: 21 }, domain: '', grants: [], decisions: {}, rejected: [] });
async function publishRegistry(cfg, rev, plain) {
  await s3mem.put(cfg, cfg.prefix + sr.DIR.registry, JSON.stringify(sr.seal(cfg.secret, sr.K.registry, rev, JSON.stringify(plain))));
}
async function readAck(cfg, sid) {
  const raw = await s3mem.get(cfg, cfg.prefix + sr.DIR.ack + sid + '.json').catch(() => null);
  return raw ? sr.open(cfg.secret, sr.K.ack, JSON.parse(raw)).plain : null;
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const req = (method, port, p, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'content-type': 'application/json' }, data ? { 'content-length': data.length } : {}, headers) }, (res) => {
    let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j, body: t }); });
  });
  r.on('error', reject); if (data) r.write(data); r.end();
});
async function boot(dir, extraEnv) {
  const port = await freePort();
  const env = Object.assign({}, process.env, {
    PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: dir, PAYESH_LOG: '1', PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0',
    PAYESH_LIVE_MS: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '1', PAYESH_MIRROR: '0', PAYESH_HEADLESS: '1',
    PAYESH_DISCOVERY: '0', PAYESH_NO_RESTART: '1', PAYESH_TUNNEL_AUTO: '0', PAYESH_NO_DEFAULT_CENTRAL: '1',
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
/* ردیف ۱۹۷: سقف ورود هر کاربر ۲۰ در دقیقه است (login-user، server/index.js، پنجرهٔ ثابت). حلقه‌های انتظار
   با فاصلهٔ ۱۵۰ms روی runner کند پیش از آماده‌شدن مدرسهٔ میزبانی‌شده سهمیه را تمام می‌کردند و از آن به بعد
   فقط 429 می‌گرفتند (CI ۰.۹.۵۳/۰.۹.۵۴: «rate_limited 429 !== 200»). سقف نرخ رفتار درست سرور است؛ اینجا
   با فاصلهٔ ۱ ثانیه تلاش می‌کنیم و در 429 تا تازه‌شدن پنجره صبر می‌کنیم. */
async function pollLogin(send, done, tries = 100) {
  let r = null;
  for (let i = 0; i < tries; i++) {
    r = await send();
    if (done(r)) return r;
    await sleep(r.status === 429 ? 61_000 : 1000);
  }
  return r;
}
const login = (port, phone, password) => req('POST', port, '/api/auth/login', { phone, password, platform: 'windows' });

(async () => {
  await check('S173-01 D4: پروکسی معرفی‌شده (IP/CIDR) ⇒ XFF؛ بی‌فهرست فقط loopback؛ 0 ⇒ هیچ؛ بیرون از فهرست ⇒ نه', async () => {
    const cfgm = fresh('config.js');
    const t = (v, ip) => withEnv({ PAYESH_TRUST_PROXY: v }, () => cfgm.trustProxyFor(ip));
    assert.strictEqual(t(undefined, '127.0.0.1'), true);
    assert.strictEqual(t(undefined, '172.18.0.3'), false, 'بی‌فهرست: پروکسیِ کانتینر دیگر پذیرفته نیست');
    assert.strictEqual(t('172.16.0.0/12', '172.18.0.3'), true);
    assert.strictEqual(t('172.16.0.0/12', '::ffff:172.31.255.1'), true);
    assert.strictEqual(t('172.16.0.0/12', '172.32.0.1'), false);
    assert.strictEqual(t('10.0.0.5', '10.0.0.5'), true);
    assert.strictEqual(t('10.0.0.5', '10.0.0.6'), false);
    assert.strictEqual(t('0', '127.0.0.1'), false);
    assert.strictEqual(t('1', '::1'), true);
    assert.strictEqual(t('1', '172.18.0.3'), true, '«1» = پشت پروکسی خودم (هر همتای مستقیم)');
    assert.strictEqual(t('garbage,1.2.3.4/4,999.1.1.1', '1.9.9.9'), false, 'قاعدهٔ نامعتبر/خیلی پهن ⇒ نادیده');
    const reqOf = (remote, xff) => ({ socket: { remoteAddress: remote }, headers: { 'x-forwarded-for': xff } });
    withEnv({ PAYESH_TRUST_PROXY: '172.16.0.0/12' }, () => {
      assert.strictEqual(cfgm.clientIp(reqOf('172.20.0.4', '203.0.113.9, 172.20.0.4')), '203.0.113.9');
      assert.strictEqual(cfgm.clientIp(reqOf('198.51.100.7', '203.0.113.9')), '198.51.100.7', 'NEG: جعل XFF از بیرون');
    });
    withEnv({ PAYESH_TRUST_PROXY: '1' }, () => {
      assert.strictEqual(cfgm.clientIp(reqOf('172.20.0.4', '6.6.6.6, 203.0.113.9')), '203.0.113.9', '«1»: فقط یک گام — جعل سمت چپ بی‌اثر');
    });
    withEnv({ PAYESH_TRUST_PROXY: undefined }, () => {
      assert.strictEqual(cfgm.clientIp(reqOf('127.0.0.1', '6.6.6.6, 203.0.113.9')), '203.0.113.9', 'NEG: هدر جعلی پشت پروکسی محلی (nginx/Passenger)');
      assert.strictEqual(cfgm.clientIp(reqOf('127.0.0.1', '203.0.113.7, 127.0.0.1')), '203.0.113.7');
      assert.strictEqual(cfgm.clientIp(reqOf('172.20.0.4', '203.0.113.9')), '172.20.0.4');
    });
  });

  await check('S173-02 D2: ریشه‌های NODE_EXTRA_CA_CERTS در caList', async () => {
    const d = newDir();
    const pem = '-----BEGIN CERTIFICATE-----\nTUlJQlNpbTE3M0NBZm9yVGVzdA==\n-----END CERTIFICATE-----';
    fs.writeFileSync(path.join(d, 'ca.crt'), pem + '\n' + pem.replace('TUlJ', 'TUlK') + '\n');
    const lt = fresh('le-trust.js');
    assert.strictEqual(withEnv({ NODE_EXTRA_CA_CERTS: path.join(d, 'ca.crt') }, () => lt.extraPems()).length, 2);
    assert.deepStrictEqual(withEnv({ NODE_EXTRA_CA_CERTS: path.join(d, 'nope.crt') }, () => lt.extraPems()), []);
    const list = withEnv({ NODE_EXTRA_CA_CERTS: path.join(d, 'ca.crt') }, () => fresh('le-trust.js').caList());
    assert.ok(list.includes(pem), 'ریشهٔ افزوده در فهرست');
    assert.ok(list.length > lt.PEMS.length + 2, 'ریشه‌های پیش‌فرض Node هم هستند');
    fresh('le-trust.js');
  });

  await check('S173-03 D3: نشانی و نام صندوقچه از محیط سرور (فقط https یا محلی)', async () => {
    const cd = fresh('cloud-defaults.js');
    const ok = cd.envMeta({ PAYESH_S3_ENDPOINT: 'https://s3.sim/', PAYESH_S3_BUCKET: 'payesh-sim', PAYESH_S3_REGION: 'ir-1', PAYESH_S3_PREFIX: 'payesh/' });
    assert.deepStrictEqual(ok, { endpoint: 'https://s3.sim', bucket: 'payesh-sim', region: 'ir-1', prefix: 'payesh/' });
    assert.deepStrictEqual(cd.envMeta({ PAYESH_S3_ENDPOINT: 'http://s3.example.com', PAYESH_S3_BUCKET: 'Bad_Bucket!' }), {}, 'NEG: http بیرونی / نام نامعتبر');
    assert.deepStrictEqual(cd.envMeta({ PAYESH_S3_ENDPOINT: 'https://u:p@s3.sim' }), {}, 'NEG: نشانی با کاربر/رمز');
    assert.strictEqual(cd.envMeta({ PAYESH_S3_ENDPOINT: 'http://127.0.0.1:9000' }).endpoint, 'http://127.0.0.1:9000');
    assert.deepStrictEqual(cd.envMeta({}), {});
    /* بی‌ناحیه ⇒ ناحیه از نشانی (مثل regionFor پنل مالک)، نه پیش‌فرض آروان */
    assert.strictEqual(cd.envMeta({ PAYESH_S3_ENDPOINT: 'https://s3.sim' }).region, '');
    const s3c = require(path.join(ROOT, 'client', 'lib', 's3mini.js'));
    if (typeof s3c.regionOf === 'function') {
      assert.strictEqual(s3c.regionOf({ endpoint: 'https://s3.sim', region: '' }), 'us-east-1');
      assert.strictEqual(s3c.regionOf({ endpoint: 'https://s3.ir-central1.arvanstorage.ir', region: '' }), 'ir-central1');
    }
    const c = withEnv({ PAYESH_S3_ENDPOINT: 'https://s3.sim', PAYESH_S3_BUCKET: 'payesh-sim', PAYESH_S3_ACCESS_KEY: 'ak-173', PAYESH_S3_SECRET: 'sk-173' }, () => {
      fresh('cloud-defaults.js'); const sm = fresh('s3mem.js');
      const st = openStore(path.join(newDir(), 'payesh.sqlite'));
      try { return sm.usingMeta(st).get(); } finally { st.close(); }
    });
    assert.strictEqual(c.endpoint, 'https://s3.sim'); assert.strictEqual(c.bucket, 'payesh-sim'); assert.strictEqual(c.enabled, true);
    assert.ok(!c.region || c.region === 'us-east-1', 'ناحیهٔ نشانی غیرآروان = همان پنل مالک: ' + c.region);
    fresh('cloud-defaults.js'); fresh('s3mem.js');
  });

  const S = await startStub({ accessKey: 'ak-173', secret: 'sk-sim-173', bucket: 'payesh-sim' });
  const cfg = s3mem.normalize(S.cfg);
  try {
    const dir = newDir();
    { const st = openStore(path.join(dir, 'payesh.sqlite')); s3mem.usingMeta(st).set(Object.assign({}, cfg)); st.close(); }
    await publishRegistry(cfg, 3, plainOf([schoolA(), schoolB()]));
    const box = await boot(dir, { PAYESH_CENTRAL: '1', PAYESH_HOSTING_FIRST_MS: '300', PAYESH_HOSTING_EVERY_MS: '1500', PAYESH_SCHOOLS_EVERY_MS: '1500' });
    try {
      await check('S173-04 D5: سرور مرکزیِ بی‌مدرسه خودکار میزبان هر دو مدرسه؛ ورود مدیر؛ خودش گره نمی‌خورد', async () => {
        let a = null, b = null;
        for (let i = 0; i < 200 && !(a && b); i++) { a = a || await readAck(cfg, schoolA().id); b = b || await readAck(cfg, schoolB().id); if (!(a && b)) await sleep(100); }
        assert.ok(a && b, 'رسید هر دو مدرسه\n' + box.log.slice(-3000));
        assert.notStrictEqual(a.instance, b.instance, 'هر مدرسه سرور جدا');
        assert.ok(fs.existsSync(path.join(dir, 'hosted', schoolA().id, 'payesh.sqlite')));
        const la = await login(box.port, 'sima173', 'Sim-A-pass-1');
        assert.strictEqual(la.status, 200, la.body);
        const sa = await req('GET', box.port, '/api/sub/status', null, { authorization: 'Bearer ' + la.json.session.token });
        assert.strictEqual(sa.json.school, schoolA().name);
        const lb = await login(box.port, 'simb173', 'Sim-B-pass-1');
        assert.strictEqual(lb.status, 200, lb.body);
        const h = await req('GET', box.port, '/api/health');
        assert.strictEqual(h.json.central, true);
        assert.ok(!h.json.school, 'سرور مرکزی خودش مدرسه نگرفت: ' + JSON.stringify(h.json.school));
      });

      await check('S173-05 D6: مدرسهٔ میزبانی‌شدهٔ غیرفعال ⇒ school_inactive (نه رمز اشتباه)؛ مدرسهٔ دیگر بی‌اثر', async () => {
        const pa = plainOf([Object.assign(schoolA(), { active: false }), schoolB()]);
        await publishRegistry(cfg, 4, pa);
        let r = null;
        r = await pollLogin(() => login(box.port, 'sima173', 'Sim-A-pass-1'), x => x.status === 403);
        assert.strictEqual(r.status, 403, r.body);
        assert.strictEqual(r.json.error, 'school_inactive');
        const lb = await login(box.port, 'simb173', 'Sim-B-pass-1');
        assert.strictEqual(lb.status, 200, 'مدرسهٔ ب: ' + lb.body);
        const bad = await login(box.port, 'simb173', 'wrong-pass-9');
        assert.strictEqual(bad.status, 401, bad.body);
        const nobody = await login(box.port, 'nobody173', 'whatever-1');
        assert.strictEqual(nobody.status, 401, 'کاربر ناشناس «مدرسه غیرفعال» نمی‌بیند: ' + nobody.body);
        await publishRegistry(cfg, 5, plainOf([schoolA(), schoolB()]));
        r = await pollLogin(() => login(box.port, 'sima173', 'Sim-A-pass-1'), x => x.status === 200);
        assert.strictEqual(r.status, 200, 'دوباره فعال: ' + r.body);
      });
    } finally { if (process.env.S173_LOG) console.log(box.log); await stop(box); }

    /* D14: پس از ری‌استارت سرور مرکزی (حافظهٔ توکن‌ها خالی) خطای نوسازیِ خودِ مدرسهٔ میزبانی‌شده
       برمی‌گردد، نه bad_device سرور اصلی (شبیه‌سازی داکر، گام S21) */
    const box2 = await boot(dir, { PAYESH_CENTRAL: '1', PAYESH_HOSTING_FIRST_MS: '300', PAYESH_HOSTING_EVERY_MS: '1500', PAYESH_SCHOOLS_EVERY_MS: '1500' });
    let box3 = null;
    try {
      await check('S173-07 D14: نوسازی دستگاه پس از ری‌استارت سرور مرکزی ⇒ خطای خودِ مدرسه (proof_required) و با اثبات ۲۰۰', async () => {
        const crypto = require('node:crypto');
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
        let l = null;
        l = await pollLogin(() => req('POST', box2.port, '/api/auth/login', { phone: 'sima173', password: 'Sim-A-pass-1', platform: 'windows', name: 'd14', device_pubkey: pub }), x => x.status === 200);
        assert.strictEqual(l.status, 200, l.body);
        const raw = l.json.device_token; const devId = l.json.device_id;
        assert.ok(raw && devId, 'device_token');
        await stop(box2);
        box3 = await boot(dir, { PAYESH_CENTRAL: '1', PAYESH_HOSTING_FIRST_MS: '300', PAYESH_HOSTING_EVERY_MS: '1500', PAYESH_SCHOOLS_EVERY_MS: '1500' });
        let np = null;
        /* ردیف ۱۷۶ (D-07): هر تلاش از سهمیهٔ refresh همان IP (۶۰ در دقیقه، server/index.js) کم می‌کند؛ با فاصلهٔ
           ۱۵۰ms روی runner کند سهمیه پیش از رسیدن مدرسه تمام می‌شد و refresh با اثبات 429 می‌گرفت. با ۱۱۰۰ms
           حداکثر ~۵۵ تلاش در هر دقیقه + یک refresh با اثبات، زیر سقف می‌ماند. */
        /* ردیف ۱۸۱: سهمیهٔ refresh پنجرهٔ ثابت است؛ اگر روی runner کند باز 429 آمد، تا تازه‌شدن پنجره صبر کن
           (سقف نرخ رفتار درست سرور است، موضوع این بررسی proof_required است) */
        for (let i = 0; i < 100; i++) { np = await req('POST', box3.port, '/api/auth/refresh', { device_token: raw }); if (np.json && np.json.error === 'proof_required') break; await sleep(np.status === 429 ? 61_000 : 1100); }
        assert.strictEqual(np.status, 401, np.body);
        assert.strictEqual(np.json.error, 'proof_required', 'پیش‌تر bad_device سرور اصلی: ' + np.body);
        const ts = Date.now();
        const msg = 'payesh-refresh-v1\n' + devId + '\n' + ts + '\n' + crypto.createHash('sha256').update(raw).digest('hex');
        const sig = crypto.sign('sha256', Buffer.from(msg), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
        let ok = await req('POST', box3.port, '/api/auth/refresh', { device_token: raw, proof: { ts, sig } });
        if (ok.status === 429) {
          await sleep(61_000);
          const ts2 = Date.now();
          const msg2 = 'payesh-refresh-v1\n' + devId + '\n' + ts2 + '\n' + crypto.createHash('sha256').update(raw).digest('hex');
          const sig2 = crypto.sign('sha256', Buffer.from(msg2), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
          ok = await req('POST', box3.port, '/api/auth/refresh', { device_token: raw, proof: { ts: ts2, sig: sig2 } });
        }
        assert.strictEqual(ok.status, 200, ok.body);
        assert.ok(ok.json.session && ok.json.session.token);
      });
    } finally { await stop(box2).catch(() => {}); if (box3) await stop(box3); }
  } finally { await S.close(); }

  await check('S173-06 D7 + ابزار شبیه‌سازی: انتشار فوری نشانی پس از گره؛ پرونده‌های tools/sim سالم و بی‌کلید واقعی', async () => {
    const idx = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
    assert.ok(/adoptOnLogin\([^\n]+\n\s+if \(a\.ok\) kickDiscovery\(\);/.test(idx), 'kick پس از adopt');
    assert.ok(/linkOnLogin\([^\n]+\n\s+if \(a\.ok\) kickDiscovery\(\);/.test(idx), 'kick پس از link');
    /* D9: تصویر داکر نسخهٔ واقعی را می‌گوید (پیش‌تر releases/ کامل بیرون می‌ماند ⇒ نسخه 0.0.0) */
    const di = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split(/\r?\n/).map(x => x.trim());
    assert.ok(!di.includes('releases') && di.includes('releases/*') && di.includes('!releases/manifest.json'), '.dockerignore: manifest می‌ماند');
    assert.ok(/RELEASES_DIR, 'manifest\.json'/.test(idx), 'نسخهٔ در حال اجرا از releases/manifest.json');
    const sim = path.join(ROOT, 'tools', 'sim');
    for (const f of ['s3-lite.js', 'tls-front.js', 'run-sim.js']) execFileSync(process.execPath, ['--check', path.join(sim, f)]);
    const compose = fs.readFileSync(path.join(sim, 'docker-compose.sim.yml'), 'utf8');
    for (const s of ['central:', 'school1:', 'school2:', 'front:', 'driver:', 'PAYESH_TRUST_PROXY', 'NODE_EXTRA_CA_CERTS', '/var/run/docker.sock']) assert.ok(compose.includes(s), 'compose: ' + s);
    assert.ok(!/payesh-(pg|redis)-ha|benzin|hermes/.test(compose), 'به کانتینرهای دیگر دست نمی‌زند');
    for (const f of fs.readdirSync(sim)) {
      const t = fs.readFileSync(path.join(sim, f), 'utf8');
      assert.ok(!/AKIA[0-9A-Z]{12,}|-----BEGIN (RSA |EC )?PRIVATE KEY-{5}/.test(t), 'کلید واقعی در ' + f);
    }
  });

  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* noop */ } }
  console.log('SIM-173 ' + (failures.length ? 'FAIL' : 'PASS') + ' — ' + checks + ' checks' + (failures.length ? ' · failed: ' + failures.join(', ') : ''));
  process.exit(failures.length ? 1 : 0);
})();
