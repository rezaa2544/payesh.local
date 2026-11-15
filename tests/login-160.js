// ردیف ۱۶۰ — دو روش ورود: نام کاربری + رمزِ تعیین‌شدهٔ مدیر، و شمارهٔ همراه + کد پیامکی
// (زیرساخت کامل پیامک، تا اتصال پنل غیرفعال). server/sms.js + server/auth.js + server/index.js.
//
//   LG-01  بردارهای مشترک auth-vectors (Node = Dart پنل مالک): نرمال‌سازی plain.auth، پیش‌فرض‌ها، پیوند نامعتبر.
//   LG-02  پیش‌فرض «غیرفعال»: بدون پیوند پنل ⇒ sms_disabled؛ صفحهٔ اول نام کاربری/رمز است حتی اگر مالک «شماره» خواسته باشد.
//   LG-03  کد یک‌بارمصرف: ارسال با قالب پیوند (رمزگذاری URL)، فقط درهم‌سازی در پایگاه داده، کد اشتباه/درست،
//          یک‌بارمصرف، انقضا، قفل پس از ۵ تلاش، فاصلهٔ ارسال دوباره، سقف ساعتی، شمارهٔ ناشناس (همان پاسخ، بی‌پیامک)،
//          خطای پنل ⇒ sms_send_failed بی‌آنکه کدی بماند، هدف «reset» با «login» قاطی نمی‌شود.
//   LG-04  ساخت درخواست POST: بدنهٔ JSON (گریز درست)، فرم، سرآیندها (بدون شکستن خط)، ok_match.
//   LG-05  نام کاربری مدیر: لاتین یا عددی ۴ تا ۹ رقم؛ یکتایی در برابر نام کاربری/شماره/کد ملیِ دیگران؛ اولویت
//          نام کاربری در جست‌وجو؛ ورود با نام کاربری عددی/لاتین و هنوز با شمارهٔ همراه.
//   LG-06  سرور واقعی (HTTP): /api/health.login، /api/auth/methods، PATCH username (۴۰۰/۴۰۹)، credentials.username،
//          ورود با نام کاربری؛ پیامک غیرفعال ⇒ ۵۰۳؛ حالت کنسول ⇒ ورود با کد و بازیابی رمز با کد ⇒ رمز تازه کار می‌کند.
// خط آخر: LOGIN-160-OK checks=N | LOGIN-160-FAIL failures=N
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const sms = require(path.join(ROOT, 'server', 'sms.js'));
const auth = require(path.join(ROOT, 'server', 'auth.js'));
const { openStore } = require(path.join(ROOT, 'server', 'db.js'));

let checks = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); checks++; console.log('ok   ' + name); }
  catch (e) { failures.push(name); console.log('FAIL ' + name + ' — ' + String((e && e.stack) || e).split('\n').slice(0, 4).join(' | ')); }
}

const tmpDirs = [];
function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg160-'));
  tmpDirs.push(dir);
  return { store: openStore(path.join(dir, 'payesh.sqlite')), dir };
}
function setAuth(store, a) {
  store.setMeta('schools:registry', { rev: 1, plain: { v: 1, schools: [], settings: {}, auth: a }, at: new Date().toISOString() });
}
function addUser(store, row) {
  return store.insert('users', auth.applyDefaultCredentials(Object.assign({ active: true, created_at: new Date().toISOString() }, row), store));
}
const SMS_ON = { enabled: true, url: 'https://sms.example.ir/send?to={mobile}&text={message}&key=K1', method: 'GET' };

function stubTransport() {
  const calls = [];
  let reply = { status: 200, text: 'ok' };
  sms.setTransport(async (url, opts) => {
    calls.push({ url, opts });
    return { status: reply.status, text: async () => reply.text };
  });
  return { calls, set(r) { reply = r; } };
}
const codeOf = (call) => {
  const u = new URL(call.url);
  const m = /(\d{4,8})/.exec(u.searchParams.get('text') || '');
  return m && m[1];
};

(async () => {
  await check('LG-01 بردارهای مشترک auth-vectors (Node = Dart)', async () => {
    const vec = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/cloud/contracts/auth-vectors.json'), 'utf8'));
    assert.ok(vec.cases.length >= 5);
    for (const c of vec.cases) {
      const st = sms.settingsOf({ auth: c.input });
      const got = { primary: st.primary, sms_ready: st.sms_ready, enabled: st.sms.enabled, url: st.sms.url, method: st.sms.method, code_length: st.sms.code_length, headers: st.sms.headers.length };
      assert.deepStrictEqual(got, c.expect, c.name);
    }
    assert.strictEqual(sms.settingsOf(null).primary, 'password');
    assert.strictEqual(sms.settingsOf({}).sms.message, sms.DEFAULT_MESSAGE);
  });

  await check('LG-02 بدون پنل ⇒ sms_disabled و صفحهٔ اول نام کاربری/رمز', async () => {
    const { store } = newStore();
    addUser(store, { name: 'معلم', role: 'teacher', phone: '09121111111', national_id: '0012345678' });
    const info = sms.publicInfo(store);
    assert.strictEqual(info.sms, false); assert.strictEqual(info.primary, 'password');
    assert.strictEqual((await sms.request(store, { phone: '09121111111' })).error, 'sms_disabled');
    assert.strictEqual(sms.verify(store, { phone: '09121111111', code: '123456' }).error, 'sms_disabled');
    /* مالک «شماره» خواسته ولی پیوند پنل خالی است ⇒ هنوز رمز اول (کسی قفل نمی‌شود) */
    setAuth(store, { primary: 'mobile', sms: { enabled: true, url: '' } });
    assert.strictEqual(sms.publicInfo(store).primary, 'password');
    assert.strictEqual(sms.publicInfo(store).requested_primary, 'mobile');
    setAuth(store, { primary: 'mobile', sms: { enabled: false, url: SMS_ON.url } });
    assert.strictEqual(sms.publicInfo(store).sms, false);
    setAuth(store, { primary: 'mobile', sms: SMS_ON });
    assert.strictEqual(sms.publicInfo(store).primary, 'mobile');
    assert.strictEqual(sms.statusOf('sms_disabled'), 503);
    store.close();
  });

  await check('LG-03 کد یک‌بارمصرف: ارسال، درهم‌سازی، تلاش‌ها، انقضا، سقف‌ها، ناشناس، خطای پنل', async () => {
    const { store } = newStore();
    const u = addUser(store, { name: 'معلم', role: 'teacher', phone: '09121111111', national_id: '0012345678' });
    setAuth(store, { primary: 'password', sms: SMS_ON });
    const tr = stubTransport();
    const find = (m) => auth.findUserByPhone(store, m);
    let now = 1_800_000_000_000;
    const r1 = await sms.request(store, { phone: '۰۹۱۲۱۱۱۱۱۱۱', purpose: 'login' }, { findUser: find, now, school: 'دبستان' });
    assert.strictEqual(r1.ok, true); assert.strictEqual(tr.calls.length, 1);
    assert.ok(tr.calls[0].url.startsWith('https://sms.example.ir/send?to=09121111111&text='), tr.calls[0].url);
    const code = codeOf(tr.calls[0]);
    assert.ok(code && code.length === 6, 'code in message');
    /* فقط درهم‌سازی در پایگاه داده */
    const raw = JSON.stringify(store.getMeta(sms.metaKey('09121111111')));
    assert.ok(!raw.includes(code), 'plain code stored');
    /* فاصلهٔ ارسال دوباره */
    const cd = await sms.request(store, { phone: '09121111111' }, { findUser: find, now: now + 5_000 });
    assert.strictEqual(cd.error, 'otp_cooldown'); assert.ok(cd.retry_after_s > 0 && cd.retry_after_s <= 60);
    /* هدف دیگر ⇒ نامعتبر؛ کد اشتباه ⇒ tries_left */
    assert.strictEqual(sms.verify(store, { phone: '09121111111', code, purpose: 'reset' }, { now }).error, 'otp_invalid');
    const bad = sms.verify(store, { phone: '09121111111', code: code === '000000' ? '111111' : '000000' }, { now });
    assert.strictEqual(bad.error, 'otp_invalid'); assert.strictEqual(bad.tries_left, 3);
    const okv = sms.verify(store, { phone: '09121111111', code }, { now: now + 1000 });
    assert.strictEqual(okv.ok, true); assert.strictEqual(okv.uid, u.id);
    assert.strictEqual(sms.verify(store, { phone: '09121111111', code }, { now: now + 2000 }).error, 'otp_invalid', 'single use');
    /* انقضا */
    now += 61_000;
    await sms.request(store, { phone: '09121111111' }, { findUser: find, now });
    const c2 = codeOf(tr.calls[1]);
    assert.strictEqual(sms.verify(store, { phone: '09121111111', code: c2 }, { now: now + 121_000 }).error, 'otp_expired');
    /* قفل پس از ۵ تلاش */
    now += 61_000;
    await sms.request(store, { phone: '09121111111' }, { findUser: find, now });
    const c3 = codeOf(tr.calls[2]);
    let last;
    for (let i = 0; i < 5; i++) last = sms.verify(store, { phone: '09121111111', code: c3 === '999999' ? '888888' : '999999' }, { now });
    assert.strictEqual(last.error, 'otp_locked');
    assert.strictEqual(sms.verify(store, { phone: '09121111111', code: c3 }, { now }).error, 'otp_invalid', 'locked code is gone');
    /* سقف ساعتی (۵) */
    now += 61_000; await sms.request(store, { phone: '09121111111' }, { findUser: find, now });
    now += 61_000; await sms.request(store, { phone: '09121111111' }, { findUser: find, now });
    now += 61_000;
    const lim = await sms.request(store, { phone: '09121111111' }, { findUser: find, now });
    assert.strictEqual(lim.error, 'otp_limit'); assert.ok(lim.retry_after_s > 0);
    /* شمارهٔ ناشناس: همان پاسخ، بدون پیامک */
    const before = tr.calls.length;
    const unk = await sms.request(store, { phone: '09359999999' }, { findUser: find, now });
    assert.deepStrictEqual(Object.keys(unk).sort(), Object.keys(r1).sort());
    assert.strictEqual(unk.ok, true); assert.strictEqual(tr.calls.length, before);
    assert.strictEqual(sms.verify(store, { phone: '09359999999', code: '123456' }, { now }).error, 'otp_invalid');
    /* خطای پنل ⇒ sms_send_failed و هیچ کدی نمی‌ماند */
    const u2 = addUser(store, { name: 'ولی', role: 'parent', phone: '09122222222' });
    assert.ok(u2.id);
    tr.set({ status: 500, text: 'down' });
    const fail = await sms.request(store, { phone: '09122222222' }, { findUser: find, now });
    assert.strictEqual(fail.error, 'sms_send_failed'); assert.strictEqual(sms.statusOf(fail.error), 502);
    assert.ok(!store.getMeta(sms.metaKey('09122222222')).h);
    assert.strictEqual((await sms.request(store, { phone: '0912' }, { findUser: find, now })).error, 'bad_phone');
    sms.setTransport(null);
    store.close();
  });

  await check('LG-04 ساخت درخواست POST (JSON/فرم/سرآیند) و ok_match', async () => {
    const st = sms.settingsOf({ auth: { sms: {
      enabled: true, url: 'https://api.sms.example/v1/send', method: 'POST',
      headers: 'x-api-key: SECRET-{school}\nbad header: x\nAccept: application/json',
      body: '{"mobile":"{mobile}","text":"{message}"}', message: 'کد "{code}"\nپایش', ok_match: '"status":1',
    } } });
    assert.strictEqual(st.sms.headers.length, 2, 'invalid header name dropped');
    const r = sms.buildRequest(st.sms, { mobile: '09121111111', code: '123456', school: 'a\r\nb', minutes: 2 });
    assert.strictEqual(r.method, 'POST');
    assert.deepStrictEqual(JSON.parse(r.body), { mobile: '09121111111', text: 'کد "123456"\nپایش' });
    assert.strictEqual(r.headers['content-type'], 'application/json');
    assert.strictEqual(r.headers['x-api-key'], 'SECRET-a  b', 'no header injection');
    const form = sms.buildRequest(sms.settingsOf({ auth: { sms: { enabled: true, url: 'https://x.example/s', method: 'POST', body: 'to={mobile98}&msg={message}', message: 'کد {code}' } } }).sms, { mobile: '09121111111', mobile98: '989121111111', code: '42' });
    assert.strictEqual(form.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.strictEqual(form.body, 'to=989121111111&msg=' + encodeURIComponent('کد 42'));
    const okv = await sms.deliver(st.sms, { mobile: '09121111111', code: '1' }, { fetchImpl: async () => ({ status: 200, text: async () => '{"status":1}' }) });
    assert.strictEqual(okv.ok, true);
    const nok = await sms.deliver(st.sms, { mobile: '09121111111', code: '1' }, { fetchImpl: async () => ({ status: 200, text: async () => '{"status":0}' }) });
    assert.strictEqual(nok.ok, false);
    const thrown = await sms.deliver(st.sms, { mobile: '09121111111', code: '1' }, { fetchImpl: async () => { throw new Error('net'); } });
    assert.strictEqual(thrown.error, 'sms_send_failed');
    assert.strictEqual(sms.settingsOf({ auth: { sms: { url: 'javascript:alert(1)' } } }).sms.url, '');
  });

  await check('LG-05 نام کاربری مدیر: شکل، یکتایی، اولویت جست‌وجو، ورود', async () => {
    const { store } = newStore();
    const a = addUser(store, { name: 'الف', role: 'teacher', phone: '09121111111', national_id: '0012345678' });
    const b = addUser(store, { name: 'ب', role: 'student', phone: '09122222222', national_id: '0087654321' });
    for (const ok of ['ali.r', 'abc', '1234', '123456789', 'Teacher_7']) assert.ok(auth.validUsername(ok), ok);
    for (const bad of ['ab', '123', '1234567890', '09121111111', '1abc', 'علی', 'a b', '']) assert.ok(!auth.validUsername(bad), bad);
    /* یکتایی: شماره/کد ملی/نام کاربری دیگران */
    assert.strictEqual(auth.loginTaken(store, '09122222222', a.id).id, b.id);
    assert.strictEqual(auth.loginTaken(store, '0087654321', a.id).id, b.id);
    assert.strictEqual(auth.loginTaken(store, '09121111111', a.id), null, 'own phone is fine');
    store.update('users', b.id, { username: '7001' });
    assert.strictEqual(auth.loginTaken(store, '7001', a.id).id, b.id);
    store.update('users', a.id, { username: 'ali.r' });
    assert.strictEqual(auth.loginTaken(store, 'ALI.R', b.id).id, a.id);
    /* جست‌وجو و ورود */
    assert.strictEqual(auth.findUserByLogin(store, '7001').id, b.id);
    assert.strictEqual(auth.findUserByLogin(store, '۷۰۰۱').id, b.id);
    assert.strictEqual(auth.findUserByLogin(store, 'Ali.R').id, a.id);
    assert.strictEqual(auth.findUserByLogin(store, '7002'), null);
    assert.strictEqual(auth.findUserByLogin(store, '09121111111').id, a.id, 'phone still works');
    auth.setPassword(store, b.id, 'pw-b-1');
    const l1 = auth.login(store, { phone: '7001', password: 'pw-b-1', platform: 'android' });
    assert.strictEqual(l1.ok, true, JSON.stringify(l1)); assert.strictEqual(l1.user.id, b.id);
    assert.strictEqual(auth.login(store, { phone: '7001', password: 'wrong-1' }).error, 'bad_credentials');
    assert.strictEqual(auth.login(store, { phone: '123', password: 'pw-b-1' }).error, 'bad_phone');
    const l2 = auth.login(store, { phone: 'ali.r', password: '0012345678', platform: 'android' });
    assert.strictEqual(l2.ok, true, JSON.stringify(l2));
    assert.strictEqual(auth.issueLogin(store, store.get('users', a.id), { platform: 'android', __sessionOnly: true }, 'otp').auth, 'otp');
    store.close();
  });

  /* ── LG-06: سرور واقعی ── */
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

  await check('LG-06 سرور واقعی: نام کاربری مدیر، پیامک غیرفعال ⇒ ۵۰۳، ورود و بازیابی رمز با کد پیامکی', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg160-http-'));
    tmpDirs.push(dir);
    {
      const store = openStore(path.join(dir, 'payesh.sqlite'));
      const s = auth.setup(store, { school_name: 'دبستان آزمون', manager_name: 'مدیر آزمون', phone: '09120000000', password: 'mgr-pass-1' });
      assert.ok(s.ok, JSON.stringify(s));
      addUser(store, { name: 'معلم یک', role: 'teacher', phone: '09121111111', national_id: '0012345678' });
      addUser(store, { name: 'معلم دو', role: 'teacher', phone: '09122222222', national_id: '0087654321' });
      store.close();
    }
    let box = await boot(dir);
    try {
      const h = (await req('GET', box.port, '/api/health')).json;
      assert.deepStrictEqual({ p: h.login.primary, s: h.login.sms }, { p: 'password', s: false });
      assert.strictEqual((await req('GET', box.port, '/api/auth/methods')).json.sms, false);
      const off = await req('POST', box.port, '/api/auth/otp/request', { phone: '09121111111' });
      assert.strictEqual(off.status, 503); assert.strictEqual(off.json.error, 'sms_disabled');
      const lg = await req('POST', box.port, '/api/auth/login', { phone: '09120000000', password: 'mgr-pass-1', platform: 'android' });
      assert.strictEqual(lg.status, 200, lg.body);
      const H = { authorization: 'Bearer ' + lg.json.session.token };
      const creds = (await req('GET', box.port, '/api/admin/users/credentials', null, H)).json.users;
      const t1 = creds.find(u => u.phone === '09121111111'); const t2 = creds.find(u => u.phone === '09122222222');
      assert.strictEqual(t1.username, '');
      assert.strictEqual((await req('PATCH', box.port, '/api/admin/users/' + t1.id, { username: '12' }, H)).json.error, 'bad_username');
      assert.strictEqual((await req('PATCH', box.port, '/api/admin/users/' + t1.id, { username: '0087654321' }, H)).json.error, 'bad_username', '10 digits = national id shape');
      assert.strictEqual((await req('PATCH', box.port, '/api/admin/users/' + t2.id, { username: '8001' }, H)).status, 200);
      const dup = await req('PATCH', box.port, '/api/admin/users/' + t1.id, { username: '8001' }, H);
      assert.strictEqual(dup.status, 409); assert.strictEqual(dup.json.error, 'duplicate_username');
      const set = await req('PATCH', box.port, '/api/admin/users/' + t1.id, { username: 'T.Yek', password: 'yek-pass-1' }, H);
      assert.strictEqual(set.status, 200, set.body); assert.strictEqual(set.json.user.username, 't.yek');
      assert.strictEqual((await req('PATCH', box.port, '/api/admin/users/' + t2.id, { username: 't.yek' }, H)).status, 409);
      assert.strictEqual((await req('PATCH', box.port, '/api/admin/users/' + t2.id, { phone: '0912', username: '' }, H)).json.error, 'bad_phone');
      assert.strictEqual((await req('GET', box.port, '/api/admin/users/credentials', null, H)).json.users.find(u => u.id === t1.id).username, 't.yek');
      const byName = await req('POST', box.port, '/api/auth/login', { phone: 't.yek', password: 'yek-pass-1', platform: 'android' });
      assert.strictEqual(byName.status, 200, byName.body);
      const byCode = await req('POST', box.port, '/api/auth/login', { phone: '8001', password: '0087654321', platform: 'android' });
      assert.strictEqual(byCode.status, 200, byCode.body);
      /* کاربر غیرمدیر نمی‌تواند نام کاربری بگذارد */
      const HT = { authorization: 'Bearer ' + byName.json.session.token };
      assert.strictEqual((await req('PATCH', box.port, '/api/admin/users/' + t2.id, { username: 'hack' }, HT)).status, 403);
    } finally { await stop(box); }

    /* حالت کنسول (توسعه): پیامک در لاگ سرور ⇒ ورود و بازیابی رمز با کد */
    box = await boot(dir, { PAYESH_SMS_CONSOLE: '1' });
    try {
      assert.strictEqual((await req('GET', box.port, '/api/health')).json.login.sms, true);
      const codeFor = async (mobile) => {
        for (let i = 0; i < 50; i++) {
          const m = new RegExp('\\[sms:console\\] ' + mobile + '[^\\n]*?(\\d{6})').exec(box.log);
          if (m) { box.log = box.log.replace(m[0], ''); return m[1]; }
          await new Promise(r => setTimeout(r, 50));
        }
        throw new Error('no console sms\n' + box.log.slice(-1500));
      };
      const rq = await req('POST', box.port, '/api/auth/otp/request', { phone: '09121111111', purpose: 'login' });
      assert.strictEqual(rq.status, 200, rq.body); assert.strictEqual(rq.json.ttl_s, 120);
      const code = await codeFor('09121111111');
      const wrong = await req('POST', box.port, '/api/auth/otp/verify', { phone: '09121111111', code: code === '000000' ? '111111' : '000000', platform: 'android' });
      assert.strictEqual(wrong.status, 401); assert.strictEqual(wrong.json.error, 'otp_invalid');
      const v = await req('POST', box.port, '/api/auth/otp/verify', { phone: '09121111111', code, platform: 'android', name: 'گوشی' });
      assert.strictEqual(v.status, 200, v.body); assert.ok(v.json.device_token && v.json.session.token); assert.strictEqual(v.json.auth, 'otp');
      const again = await req('POST', box.port, '/api/auth/otp/request', { phone: '09121111111' });
      assert.strictEqual(again.status, 429); assert.ok(Number(again.headers['retry-after']) > 0);
      /* بازیابی رمز */
      const r2 = await req('POST', box.port, '/api/auth/otp/request', { phone: '09122222222', purpose: 'reset' });
      assert.strictEqual(r2.status, 200);
      const c2 = await codeFor('09122222222');
      assert.strictEqual((await req('POST', box.port, '/api/auth/otp/verify', { phone: '09122222222', code: c2, purpose: 'reset', password: 'x' })).json.error, 'bad_password');
      const rs = await req('POST', box.port, '/api/auth/otp/verify', { phone: '09122222222', code: c2, purpose: 'reset', password: 'new-pass-2', platform: 'android' });
      assert.strictEqual(rs.status, 200, rs.body); assert.strictEqual(rs.json.password_reset, true);
      assert.strictEqual((await req('POST', box.port, '/api/auth/login', { phone: '8001', password: 'new-pass-2', platform: 'android' })).status, 200);
      assert.strictEqual((await req('POST', box.port, '/api/auth/login', { phone: '8001', password: '0087654321', platform: 'android' })).status, 401);
      /* ناشناس: همان ۲۰۰ */
      assert.strictEqual((await req('POST', box.port, '/api/auth/otp/request', { phone: '09359999999' })).status, 200);
    } finally { await stop(box); }
  });

  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* noop */ } }
  if (failures.length) { console.log('LOGIN-160-FAIL failures=' + failures.length); process.exit(1); }
  console.log('LOGIN-160-OK checks=' + checks);
})();
