// مدارس، درخواست ثبت‌نام و اشتراک (ردیف ۱۴۵ · برگردان p2) — server/school-registry.js در برابر
// صندوقچهٔ S3 محلی با بازبینی واقعی SigV4 و یک پایگاه دادهٔ واقعی (SQLite).
//
//   SR-01  بردارهای قرارداد schools v1 (همان بایت‌های پنل مالک Dart): کلید، پاکت هر پنج نوع، کلید آزمایشی، pbkdf2، قالب درگاه.
//   SR-02  نوع ۱ (ساخت دستی): مدیر با نام کاربری/رمزی که مالک داده روی سرور تازه وارد می‌شود و همان مدرسه را می‌گیرد؛
//          سرور دوم همان مدرسه را نمی‌گیرد؛ رمز اشتباه رد؛ تغییر رمز در پنل مالک روی سرور اعمال می‌شود.
//   SR-03  سیاست نقش: نقش «اشتراکی» بدون اشتراک دسترسی ندارد، نقش «رایگان» دارد؛ paywall خاموش ⇒ همه آزاد.
//   SR-04  آزمایشی فقط یک بار برای هر دستگاه — حتی با نصب دوباره (سرور/پایگاه دادهٔ تازه) و حتی پس از «بازنشانی»؛
//          صندوقچه در دسترس نیست ⇒ بسته (trial_check_unavailable).
//   SR-05  درگاه: پیوند با جای‌نگهدارها؛ بازگشت + «پیوند تأیید» ⇒ فعال؛ تمدید از پایان فعلی (p2)؛ تأیید ناموفق ⇒ failed؛
//          بدون پیوند تأیید ⇒ در انتظار تأیید مالک؛ پیوند درگاه خالی ⇒ gateway_not_configured.
//   SR-06  ثبت رسید ⇒ پرداخت مهرشده در صندوقچه؛ تصمیم مالک (تأیید/رد) یک بار اعمال می‌شود؛ هدیهٔ مالک.
//   SR-07  نوع ۲ (ثبت‌نام): درخواست معتبر مهرشده در صندوقچه؛ اعتبارسنجی فیلدها؛ نام کاربری تکراری؛ وضعیت با توکن
//          (در انتظار ← تأیید/رد)؛ پس از تأیید، مدیر وارد می‌شود ولی تا اشتراک یا آزمایشی هیچ امکانی ندارد.
//   SR-08  غیرفعال کردن مدرسه در پنل مالک ورود را می‌بندد؛ گزارش سرور (ack) برای پنل مالک.
//   SR-09  سرور واقعی (HTTP): ثبت‌نام عمومی، ورود با نام کاربری، 402 subscription_required، آزمایشی، بازگشت درگاه HTML.
// خط آخر: SCHOOLS-145-OK checks=N | SCHOOLS-145-FAIL failures=N
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const sr = require(path.join(ROOT, 'server', 'school-registry.js'));
const ay = require(path.join(ROOT, 'server', 'academic-year.js'));
const s3mem = require(path.join(ROOT, 'server', 's3mem.js'));
const auth = require(path.join(ROOT, 'server', 'auth.js'));
const { openStore } = require(path.join(ROOT, 'server', 'db.js'));
const { pbkdf2Hash, verifySecret } = require(path.join(ROOT, 'server', 'util.js'));
const { startStub } = require('./lib/s3-stub');

let checks = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); checks++; console.log('ok   ' + name); }
  catch (e) { failures.push(name); console.log('FAIL ' + name + ' — ' + String((e && e.stack) || e).split('\n').slice(0, 4).join(' | ')); }
}

const tmpDirs = [];
function newStore(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr145-'));
  tmpDirs.push(dir);
  const store = openStore(path.join(dir, 'payesh.sqlite'));
  if (cfg) s3mem.usingMeta(store).set(Object.assign({}, cfg));
  return store;
}
const DEV_A = crypto.createHash('sha256').update('android-id-A').digest('hex');
const DEV_B = crypto.createHash('sha256').update('android-id-B').digest('hex');

/* شبیه‌ساز پنل مالک: فهرست مدارس + سیاست اشتراک (همان چیزی که local/school_registry.dart می‌نویسد) */
function owner(cfg) {
  const o = {
    rev: 1000,
    plain: { v: 1, schools: [], settings: {}, domain: '', grants: [], decisions: {}, rejected: [] },
    async publish() {
      o.rev += 1;
      await s3mem.put(cfg, cfg.prefix + sr.DIR.registry, JSON.stringify(sr.seal(cfg.secret, sr.K.registry, o.rev, JSON.stringify(o.plain))));
    },
    addSchool(id, username, password, extra = {}) {
      const s = Object.assign({ id, name: 'مدرسهٔ ' + id, level: 'ابتدایی', active: true,
        manager: { username, name: 'مدیر ' + id, phone: '', password_hash: pbkdf2Hash(password), rev: 1 } }, extra);
      o.plain.schools.push(s);
      return s;
    },
    async read(key, kind) {
      try { return sr.open(cfg.secret, kind, JSON.parse(await s3mem.get(cfg, cfg.prefix + key))).plain; } catch (e) { return null; }
    },
    async list(dir) {
      const r = await s3mem.list(cfg, { prefix: cfg.prefix + dir, max: 1000 });
      return r.keys.map(k => k.key.slice((cfg.prefix + dir).length));
    },
  };
  return o;
}

async function wipe(S) { S.objects.clear(); }

function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function req(method, port, p, body, headers = {}) {
  return new Promise((res) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers, data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {});
    const r = http.request({ method, host: '127.0.0.1', port, path: p, headers: h }, (rs) => {
      let t = ''; rs.setEncoding('utf8'); rs.on('data', (c) => { t += c; });
      rs.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { j = null; } res({ status: rs.statusCode, type: String(rs.headers['content-type'] || ''), body: t, json: j }); });
    });
    r.on('error', (e) => res({ status: 0, type: '', body: String(e.message), json: null }));
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/cloud/contracts/schools-vectors.json'), 'utf8'));

  await check('SR-01 بردارهای قرارداد schools v1', async () => {
    assert.strictEqual(V.salt, sr.SALT);
    assert.strictEqual(sr.keyFor(V.secret).toString('hex'), V.key_hex);
    assert.deepStrictEqual(V.kinds, sr.K);
    assert.deepStrictEqual(V.dirs, sr.DIR);
    assert.deepStrictEqual(V.plans, sr.PLANS);
    assert.deepStrictEqual(V.roles, sr.ROLES);
    assert.deepStrictEqual(V.defaults, sr.DEFAULTS);
    assert.deepStrictEqual(V.levels, sr.LEVELS);
    assert.strictEqual(V.username_re, sr.USERNAME_RE.source);
    for (const [name, c] of Object.entries(V.cases)) {
      const env = sr.seal(V.secret, V.kinds[name], V.rev, c.plaintext, Buffer.from(V.nonce_hex, 'hex'));
      assert.deepStrictEqual(env, c.envelope, name);
      assert.deepStrictEqual(sr.open(V.secret, V.kinds[name], c.envelope).plain, JSON.parse(c.plaintext));
      assert.throws(() => sr.open(V.secret + 'x', V.kinds[name], c.envelope));
      const other = Object.values(V.kinds).find(k => k !== V.kinds[name]);
      assert.throws(() => sr.open(V.secret, other, Object.assign({}, c.envelope, { kind: other })));
      assert.throws(() => sr.open(V.secret, V.kinds[name], Object.assign({}, c.envelope, { rev: V.rev + 1 })));
    }
    assert.strictEqual(sr.trialKey(V.trial_key.device_hash), V.trial_key.key);
    assert.ok(verifySecret(V.pbkdf2.password, V.pbkdf2.hash), 'pbkdf2 vector verifies with server');
    assert.ok(!verifySecret(V.pbkdf2.password + '!', V.pbkdf2.hash));
    assert.strictEqual(sr.fill(V.fill.template, V.fill.values), V.fill.result);
    assert.ok(V.fill.result.includes('{unknown}') && V.fill.result.includes('amount=250000') && V.fill.result.includes('t=25000'));
  });

  const S = await startStub({ accessKey: 'ak-s', secret: 'sk-schools-1', bucket: 'payesh-madrese' });
  const cfg = s3mem.normalize(S.cfg);
  try {
    await check('SR-02 نوع ۱: مدیر ساخته‌شدهٔ مالک روی سرور تازه وارد می‌شود و همان مدرسه را می‌گیرد', async () => {
      await wipe(S);
      const o = owner(cfg);
      o.addSchool('s-0001', 'ali.rezaei', 'Madrese-1403', { level: 'متوسطه اول', capabilities: { has_tuition: true } });
      await o.publish();
      const st = newStore(cfg);
      assert.strictEqual(auth.needsSetup(st), true);
      const bad = await sr.adoptOnLogin(st, 'ali.rezaei', 'wrong-pass', { needsSetup: true, instance: 'inst-A' });
      assert.strictEqual(bad.error, 'bad_credentials');
      const nf = await sr.adoptOnLogin(st, 'nobody', 'x', { needsSetup: true, instance: 'inst-A' });
      assert.strictEqual(nf.error, 'not_found');
      /* ردیف ۱۴۶: شکل نام کاربری در ورود نخستین همان قاعدهٔ همه‌جاست — رمز درست هم کمکی نمی‌کند */
      o.plain.schools.push(Object.assign({}, o.plain.schools[0], { id: 's-bad1',
        manager: Object.assign({}, o.plain.schools[0].manager, { username: 'ab', phone: '091200001466' }) }));
      await o.publish();
      for (const bad of ['', 'ab', '2ali.rezaei', 'ali rezaei', 'علی.رضایی', 'ali.rezaei!', '0912000', '091200001466']) {
        const n = await sr.adoptOnLogin(st, bad, 'Madrese-1403', { needsSetup: true, instance: 'inst-A' });
        assert.strictEqual(n.error, 'bad_shape', '«' + bad + '» → ' + JSON.stringify(n));
        assert.strictEqual(sr.loginShape(bad), null, bad);
      }
      assert.deepStrictEqual(sr.loginShape(' ALI.Rezaei '), { name: 'ali.rezaei' });
      assert.deepStrictEqual(sr.loginShape('۰۹۱۲ ۰۰۰ ۰۱۴۶'), { digits: '09120000146' });
      assert.deepStrictEqual(sr.loginShape('٠٠١٢٣٤٥٦٧٨'), { digits: '0012345678' });
      assert.strictEqual(auth.needsSetup(st), true, 'شکل نادرست هیچ چیز نساخت');
      o.plain.schools.pop();
      await o.publish();
      const a = await sr.adoptOnLogin(st, 'ALI.Rezaei', 'Madrese-1403', { needsSetup: true, instance: 'inst-A' });
      assert.strictEqual(a.ok, true, JSON.stringify(a));
      assert.strictEqual(auth.needsSetup(st), false);
      const sch = st.get('schools', 1);
      assert.strictEqual(sch.name, 'مدرسهٔ s-0001'); assert.strictEqual(sch.level, 'متوسطه اول'); assert.strictEqual(sch.owner_school_id, 's-0001');
      const r = auth.login(st, { phone: 'ali.rezaei', password: 'Madrese-1403', platform: 'android' });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.user.role, 'manager'); assert.strictEqual(r.user.username, 'ali.rezaei');
      assert.strictEqual(auth.login(st, { phone: 'ali.rezaei', password: 'nope1234' }).error, 'bad_credentials');
      const ack = await o.read(sr.DIR.ack + 's-0001.json', sr.K.ack);
      assert.strictEqual(ack.instance, 'inst-A'); assert.strictEqual(ack.users.by_role.manager, 1);
      /* سرور دوم نمی‌تواند همان مدرسه را بگیرد */
      const st2 = newStore(cfg);
      const b = await sr.adoptOnLogin(st2, 'ali.rezaei', 'Madrese-1403', { needsSetup: true, instance: 'inst-B' });
      assert.strictEqual(b.error, 'school_hosted_elsewhere');
      assert.strictEqual(auth.needsSetup(st2), true);
      /* مالک رمز مدیر را عوض می‌کند ⇒ روی سرور میزبان اعمال می‌شود */
      o.plain.schools[0].manager.password_hash = pbkdf2Hash('Taze-5678');
      o.plain.schools[0].manager.rev = 2;
      o.plain.schools[0].name = 'دبیرستان نو';
      await o.publish();
      const p = await sr.poll(st, { instance: 'inst-A' });
      assert.strictEqual(p.bound, true);
      assert.strictEqual(auth.login(st, { phone: 'ali.rezaei', password: 'Madrese-1403' }).error, 'bad_credentials');
      assert.strictEqual(auth.login(st, { phone: 'ali.rezaei', password: 'Taze-5678' }).ok, true);
      assert.strictEqual(st.get('schools', 1).name, 'دبیرستان نو');
      /* سرورِ پیکربندی‌نشده: مسیر عادی (not_managed) */
      const st3 = newStore(null);
      assert.strictEqual((await sr.adoptOnLogin(st3, 'ali.rezaei', 'Madrese-1403', { needsSetup: true })).error, 'not_managed');
    });

    await check('SR-03 سیاست نقش: اشتراکی/رایگان؛ paywall خاموش', async () => {
      await wipe(S);
      const o = owner(cfg);
      o.addSchool('s-0002', 'mgr2', 'pass-2222');
      o.plain.settings = { roles: { manager: 'required', teacher: 'free', student: 'required' } };
      await o.publish();
      const st = newStore(cfg);
      await sr.adoptOnLogin(st, 'mgr2', 'pass-2222', { needsSetup: true, instance: 'i2' });
      const mgr = st.all('users').find(u => u.role === 'manager');
      const teacher = st.insert('users', { name: 'معلم', role: 'teacher', active: true });
      const student = st.insert('users', { name: 'دانش‌آموز', role: 'student', active: true });
      const parent = st.insert('users', { name: 'ولی', role: 'parent', active: true });
      const gm = sr.gate(st, mgr);
      assert.strictEqual(gm.access, false); assert.strictEqual(gm.status, 'none'); assert.strictEqual(gm.policy, 'required');
      assert.strictEqual(gm.trial_available, true); assert.strictEqual(gm.trial_days, 21);
      /* ردیف ۱۴۹: فقط ماهانه و سالانه، قیمت هر نقش */
      assert.strictEqual(gm.plans.length, 2); assert.strictEqual(gm.plans[1].key, 'yearly'); assert.strictEqual(gm.plans[1].price, 2200000);
      assert.strictEqual(sr.gate(st, teacher).access, true);
      assert.strictEqual(sr.gate(st, student).access, false);
      assert.strictEqual(sr.gate(st, parent).access, false, 'parent default = required');
      o.plain.settings.paywall_enabled = false; await o.publish(); await sr.poll(st, {});
      assert.strictEqual(sr.gate(st, mgr).access, true);
      assert.strictEqual(sr.gate(st, student).access, true);
      /* سرور بی‌مالک: همه آزاد (رفتار قبلی) */
      const plain = newStore(null);
      assert.strictEqual(sr.gate(plain, { id: 1, role: 'manager' }).access, true);
    });

    await check('SR-04 آزمایشی فقط یک بار برای هر دستگاه (حتی نصب دوباره و پس از بازنشانی)', async () => {
      await wipe(S);
      const o = owner(cfg);
      o.addSchool('s-0003', 'mgr3', 'pass-3333');
      o.addSchool('s-0004', 'mgr4', 'pass-4444');
      o.plain.settings = { trial_days: 14 };
      await o.publish();
      const st = newStore(cfg);
      await sr.adoptOnLogin(st, 'mgr3', 'pass-3333', { needsSetup: true, instance: 'i3' });
      const mgr = st.all('users').find(u => u.role === 'manager');
      assert.strictEqual((await sr.startTrial(st, mgr, 'not-a-hash')).error, 'bad_device');
      const t0 = Date.now();
      const t = await sr.startTrial(st, mgr, DEV_A, { now: t0 });
      assert.strictEqual(t.ok, true, JSON.stringify(t));
      assert.strictEqual(t.sub.access, true); assert.strictEqual(t.sub.status, 'trial'); assert.strictEqual(t.sub.days_left, 14);
      assert.strictEqual((await sr.startTrial(st, mgr, DEV_A)).error, 'already_active');
      const keys = await o.list(sr.DIR.trial);
      assert.deepStrictEqual(keys, [sr.trialKey(DEV_A) + '.json']);
      assert.ok(!keys[0].includes(DEV_A), 'device hash never stored in clear');
      /* پایان آزمایشی ⇒ دوباره بسته؛ آزمایشی دوم برای همین کاربر نیست */
      const later = t0 + 15 * 86400000;
      const g = sr.gate(st, mgr, { now: later });
      assert.strictEqual(g.access, false); assert.strictEqual(g.status, 'expired'); assert.strictEqual(g.trial_available, false);
      /* بازنشانی مالک: رکورد پاک، ولی دستگاه همچنان مصرف‌شده */
      o.plain.grants = [{ id: 'g1', school_id: 's-0003', kind: 'reset', user_id: mgr.id }];
      await o.publish(); await sr.poll(st, {});
      assert.strictEqual(sr.gate(st, mgr).trial_available, false, 'reset keeps trial_used');
      /* نصب دوباره: پایگاه دادهٔ کاملاً تازه، مدرسهٔ دیگر، همان دستگاه ⇒ رد */
      const st2 = newStore(cfg);
      await sr.adoptOnLogin(st2, 'mgr4', 'pass-4444', { needsSetup: true, instance: 'i4' });
      const mgr4 = st2.all('users').find(u => u.role === 'manager');
      assert.strictEqual((await sr.startTrial(st2, mgr4, DEV_A)).error, 'trial_used_device');
      /* دستگاه دیگر ⇒ مجاز */
      assert.strictEqual((await sr.startTrial(st2, mgr4, DEV_B)).ok, true);
      /* صندوقچه در دسترس نیست ⇒ بسته می‌ماند */
      const st3 = newStore(cfg);
      o.addSchool('s-0005', 'mgr5', 'pass-5555'); await o.publish();
      await sr.adoptOnLogin(st3, 'mgr5', 'pass-5555', { needsSetup: true, instance: 'i5' });
      const mgr5 = st3.all('users').find(u => u.role === 'manager');
      s3mem.usingMeta(st3).set(Object.assign({}, cfg, { endpoint: 'http://127.0.0.1:1' }));
      const DEV_C = crypto.createHash('sha256').update('android-id-C').digest('hex');
      assert.strictEqual((await sr.startTrial(st3, mgr5, DEV_C)).error, 'trial_check_unavailable');
      assert.strictEqual(sr.gate(st3, mgr5).access, false);
      /* آزمایشی خاموش در پنل مالک */
      o.plain.settings = { trial_enabled: false }; await o.publish();
      s3mem.usingMeta(st3).set(Object.assign({}, cfg)); await sr.poll(st3, {});
      assert.strictEqual(sr.gate(st3, mgr5).trial_available, false);
      assert.strictEqual((await sr.startTrial(st3, mgr5, DEV_C)).error, 'trial_unavailable');
    });

    await check('SR-05 درگاه پرداخت: پیوند، بازگشت، تأیید، تمدید، بدون پیوند تأیید', async () => {
      await wipe(S);
      const o = owner(cfg);
      o.addSchool('s-0006', 'mgr6', 'pass-6666');
      o.plain.settings = { plans: [{ key: 'monthly', price: 300000 }, { key: 'yearly', price: 3000000 }] };
      await o.publish();
      const st = newStore(cfg);
      await sr.adoptOnLogin(st, 'mgr6', 'pass-6666', { needsSetup: true, instance: 'i6' });
      const mgr = st.all('users').find(u => u.role === 'manager');
      assert.strictEqual((await sr.startPayment(st, mgr, 'monthly', { callbackBase: 'https://s6.example' })).error, 'gateway_not_configured');
      assert.strictEqual(sr.gate(st, mgr).gateway, false);
      o.plain.settings.gateway = { pay_url: 'https://pay.example/start?amount={amount}&id={payment_id}&cb={callback}', verify_url: 'https://pay.example/verify?id={payment_id}' };
      await o.publish(); await sr.poll(st, {});
      assert.strictEqual(sr.gate(st, mgr).gateway, true);
      assert.strictEqual((await sr.startPayment(st, mgr, 'seasonal', { callbackBase: 'https://s6.example' })).error, 'bad_plan', 'plan not offered by owner');
      assert.strictEqual((await sr.startPayment(st, mgr, 'monthly', {})).error, 'no_callback_address');
      const p = await sr.startPayment(st, mgr, 'monthly', { callbackBase: 'https://s6.example/' });
      assert.strictEqual(p.ok, true);
      assert.match(p.payment.id, /^SUB-[0-9A-F]{8}$/);
      const u = new URL(p.pay_url);
      assert.strictEqual(u.searchParams.get('amount'), '300000');
      assert.strictEqual(u.searchParams.get('cb'), 'https://s6.example/api/sub/callback?payment=' + p.payment.id);
      const rec = await o.read(sr.DIR.pay + p.payment.id + '.json', sr.K.payment);
      assert.strictEqual(rec.status, 'pending'); assert.strictEqual(rec.school_id, 's-0006'); assert.strictEqual(rec.method, 'gateway');
      /* تأیید ناموفق */
      let calls = [];
      const fail = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { json: async () => ({ status: 'failed' }) }; };
      const q = new URLSearchParams({ payment: p.payment.id, Authority: 'A1', Status: 'NOK' });
      const f = await sr.callback(st, q, { fetchImpl: fail });
      assert.strictEqual(f.status, 'failed'); assert.strictEqual(sr.gate(st, mgr).access, false);
      assert.strictEqual(calls[0].url, 'https://pay.example/verify?id=' + p.payment.id);
      assert.strictEqual(calls[0].body.params.Authority, 'A1');
      /* پرداخت دوم موفق */
      const p2 = await sr.startPayment(st, mgr, 'monthly', { callbackBase: 'https://s6.example' });
      const okFetch = async () => ({ json: async () => ({ data: { code: 100, ref_id: 98765 } }) });
      const t0 = Date.now();
      const c = await sr.callback(st, new URLSearchParams({ payment: p2.payment.id }), { fetchImpl: okFetch });
      assert.strictEqual(c.status, 'paid');
      const g1 = sr.gate(st, mgr);
      assert.strictEqual(g1.access, true); assert.strictEqual(g1.status, 'active'); assert.strictEqual(g1.plan, 'monthly');
      /* ردیف ۱۴۹: ماهانه ۳۱ روز، با سقف ۳۱ شهریور */
      assert.ok(Math.abs(Date.parse(g1.end) - ay.monthlyEnd(t0)) < 60000);
      /* بازگشت دوباره (تکرار) ⇒ تمدید دوباره نمی‌شود */
      await sr.callback(st, new URLSearchParams({ payment: p2.payment.id }), { fetchImpl: okFetch });
      assert.strictEqual(sr.gate(st, mgr).end, g1.end);
      /* ردیف ۱۴۹: سالانه در حین اشتراک فعال ⇒ تا پایان سال تحصیلی (۳۱ شهریور) */
      const p3 = await sr.startPayment(st, mgr, 'yearly', { callbackBase: 'https://s6.example' });
      await sr.callback(st, new URLSearchParams({ payment: p3.payment.id }), { fetchImpl: okFetch });
      assert.strictEqual(sr.gate(st, mgr).end, ay.iso(ay.yearlyEnd(Date.now(), Date.parse(g1.end))));
      const paid = await o.read(sr.DIR.pay + p3.payment.id + '.json', sr.K.payment);
      assert.strictEqual(paid.status, 'paid'); assert.strictEqual(paid.gateway_ref, '98765');
      /* شناسهٔ ناشناخته/بد */
      assert.strictEqual((await sr.callback(st, new URLSearchParams({ payment: 'SUB-FFFFFFFF' }))).error, 'not_found');
      assert.strictEqual((await sr.callback(st, new URLSearchParams({ payment: '../x' }))).error, 'bad_payment');
      /* بدون پیوند تأیید ⇒ در انتظار مالک، سپس تأیید مالک */
      o.plain.settings.gateway.verify_url = ''; await o.publish(); await sr.poll(st, {});
      const st2 = newStore(cfg);
      o.addSchool('s-0007', 'mgr7', 'pass-7777'); await o.publish();
      await sr.adoptOnLogin(st2, 'mgr7', 'pass-7777', { needsSetup: true, instance: 'i7' });
      const m7 = st2.all('users').find(x => x.role === 'manager');
      const p4 = await sr.startPayment(st2, m7, 'monthly', { callbackBase: 'https://s7.example' });
      const pend = await sr.callback(st2, new URLSearchParams({ payment: p4.payment.id, Status: 'OK' }));
      assert.strictEqual(pend.status, 'pending');
      assert.strictEqual(sr.gate(st2, m7).access, false);
      assert.strictEqual(sr.gate(st2, m7).pending.length, 1);
      const pr = await o.read(sr.DIR.pay + p4.payment.id + '.json', sr.K.payment);
      assert.strictEqual(pr.awaiting_owner, true); assert.strictEqual(pr.gateway_params.Status, 'OK');
      o.plain.decisions = { [p4.payment.id]: { status: 'approved' } }; await o.publish();
      await sr.poll(st2, {});
      assert.strictEqual(sr.gate(st2, m7).access, true);
      assert.ok(/موفق/.test(sr.callbackPage({ status: 'paid', payment: { id: 'SUB-0A1B2C3D' } })));
      assert.ok(!/<script/i.test(sr.callbackPage({ status: 'failed' })));
      for (const ok of [{ ok: true }, { status: 'paid' }, { status: 100 }, { code: 100 }, { data: { code: 101 } }, { Status: 100 }]) assert.ok(sr.verifyOk(ok));
      for (const no of [null, {}, { status: 'NOK' }, { code: -51 }, { data: { code: -9 } }]) assert.ok(!sr.verifyOk(no));
    });

    await check('SR-06 رسید + تصمیم مالک (تأیید/رد یک بار) + هدیه', async () => {
      await wipe(S);
      const o = owner(cfg);
      o.addSchool('s-0008', 'mgr8', 'pass-8888');
      o.plain.settings = { receipt_note: 'کارت ۶۰۳۷...' };
      await o.publish();
      const st = newStore(cfg);
      await sr.adoptOnLogin(st, 'mgr8', 'pass-8888', { needsSetup: true, instance: 'i8' });
      const mgr = st.all('users').find(u => u.role === 'manager');
      assert.strictEqual(sr.gate(st, mgr).receipt_note, 'کارت ۶۰۳۷...');
      assert.strictEqual((await sr.submitReceipt(st, mgr, 'monthly', '12')).error, 'bad_ref');
      const r1 = await sr.submitReceipt(st, mgr, 'monthly', 'TRX-123456');
      assert.strictEqual(r1.ok, true); assert.strictEqual(r1.reported, true);
      assert.strictEqual((await sr.submitReceipt(st, mgr, 'seasonal', 'TRX-999998')).error, 'bad_plan', 'فصلی دیگر ارائه نمی‌شود');
      const r2 = await sr.submitReceipt(st, mgr, 'yearly', 'TRX-999999');
      const names = await o.list(sr.DIR.pay);
      assert.strictEqual(names.length, 2);
      o.plain.decisions = { [r1.payment.id]: { status: 'rejected', reason: 'مبلغ نادرست' }, [r2.payment.id]: { status: 'approved' } };
      await o.publish();
      const a1 = await sr.poll(st, {});
      assert.strictEqual(a1.applied, 2);
      const g = sr.gate(st, mgr);
      assert.strictEqual(g.access, true); assert.strictEqual(g.plan, 'yearly');
      const end = g.end;
      const st8 = sr.subsState(st);
      assert.strictEqual(st8.payments.find(p => p.id === r1.payment.id).status, 'rejected');
      assert.strictEqual(st8.payments.find(p => p.id === r1.payment.id).reason, 'مبلغ نادرست');
      /* دور بعدی: هیچ چیز دوباره اعمال نمی‌شود */
      assert.strictEqual((await sr.poll(st, {})).applied, 0);
      assert.strictEqual(sr.gate(st, mgr).end, end);
      /* هدیهٔ ۱۰ روزه (p2 «🎁 فعال‌سازی») — فقط برای همین مدرسه */
      o.plain.grants = [{ id: 'gift-1', school_id: 's-0008', kind: 'gift', days: 10, user_id: mgr.id }, { id: 'gift-x', school_id: 's-9999', kind: 'gift', days: 99 }];
      await o.publish(); await sr.poll(st, {});
      assert.strictEqual(sr.gate(st, mgr).end, ay.iso(ay.daysEnd(Date.now(), 10, Date.parse(end))));
      /* رسید غیرفعال */
      o.plain.settings.receipt_enabled = false; await o.publish(); await sr.poll(st, {});
      const p = st.insert('users', { name: 'ولی', role: 'parent', active: true });
      assert.strictEqual((await sr.submitReceipt(st, p, 'monthly', 'TRX-777777')).error, 'receipt_disabled');
      /* گزارش اشتراک‌ها برای پنل مالک */
      const ack = await o.read(sr.DIR.ack + 's-0008.json', sr.K.ack);
      assert.strictEqual(ack.subs.length, 1); assert.strictEqual(ack.subs[0].plan, 'yearly');
    });

    await check('SR-07 نوع ۲: درخواست ثبت‌نام → پنل مالک → تأیید → ورود بدون امکانات تا اشتراک/آزمایشی', async () => {
      await wipe(S);
      const o = owner(cfg);
      o.addSchool('s-0010', 'taken', 'pass-0000');
      await o.publish();
      const host = newStore(cfg); /* سرور مدرسه‌ای که برنامهٔ کاربران به آن وصل است */
      const good = { school_name: 'هنرستان فنی شهید باهنر', level: 'متوسطه دوم', province: 'خراسان رضوی', county: 'نیشابور', village: 'خرو',
        phone: '۰۹۱۵۱۲۳۴۵۶۷', staff_count: '۲۵', student_count: 320, manager_name: 'محمد کریمی', username: 'm.karimi', password: 'Karimi-1403', device_hash: DEV_A };
      const bads = { school_name: 'x', level: 'دانشگاه', province: '', county: '', phone: '12345', staff_count: -1, student_count: 'abc', manager_name: 'ab', username: '1abc', password: '123' };
      for (const [k, v] of Object.entries(bads)) {
        const r = await sr.register(host, Object.assign({}, good, { [k]: v }), { hash: pbkdf2Hash });
        assert.strictEqual(r.error, 'bad_' + k, k + ' → ' + JSON.stringify(r));
      }
      assert.strictEqual((await sr.register(host, Object.assign({}, good, { username: 'taken' }), { hash: pbkdf2Hash })).error, 'username_taken');
      assert.strictEqual((await sr.register(newStore(null), good, { hash: pbkdf2Hash })).error, 'not_connected');
      const r = await sr.register(host, good, { hash: pbkdf2Hash, instance: 'host-1', publicUrl: 'https://host.example' });
      assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.match(r.id, /^\d{13}-[0-9a-f]{16}$/); assert.match(r.token, /^[0-9a-f]{32}$/);
      const reqs = await o.list(sr.DIR.req);
      assert.deepStrictEqual(reqs, [r.id + '.json']);
      const rq = await o.read(sr.DIR.req + r.id + '.json', sr.K.request);
      assert.strictEqual(rq.phone, '09151234567'); assert.strictEqual(rq.staff_count, 25); assert.strictEqual(rq.village, 'خرو');
      assert.strictEqual(rq.username, 'm.karimi'); assert.ok(verifySecret('Karimi-1403', rq.password_hash));
      assert.ok(!JSON.stringify(rq).includes('Karimi-1403'), 'no clear password in bucket');
      assert.strictEqual(rq.device, sr.trialKey(DEV_A));
      assert.ok(!(await s3mem.get(cfg, cfg.prefix + sr.DIR.req + r.id + '.json')).includes('m.karimi'), 'sealed in bucket');
      /* وضعیت: توکن لازم است */
      assert.strictEqual((await sr.requestStatus(host, r.id, 'bad')).error, 'not_found');
      assert.strictEqual((await sr.requestStatus(host, '../etc', r.token)).error, 'bad_id');
      assert.strictEqual((await sr.requestStatus(host, r.id, r.token)).status, 'pending');
      /* مالک تأیید می‌کند: مدرسه با request_id و همان هش رمز ساخته می‌شود */
      o.plain.schools.push({ id: 's-0011', name: rq.school_name, level: rq.level, province: rq.province, county: rq.county, district: rq.village,
        phone: rq.phone, active: true, request_id: r.id, manager: { username: rq.username, name: rq.manager_name, phone: rq.phone, password_hash: rq.password_hash, rev: 1 } });
      o.plain.settings = { trial_days: 14 };
      await o.publish();
      const s1 = await sr.requestStatus(host, r.id, r.token);
      assert.strictEqual(s1.status, 'approved'); assert.strictEqual(s1.username, 'm.karimi');
      /* مدیر روی سرور خودش (تازه) وارد می‌شود ⇒ مدرسه ساخته می‌شود ولی هیچ امکانی ندارد */
      const mine = newStore(cfg);
      const a = await sr.adoptOnLogin(mine, 'm.karimi', 'Karimi-1403', { needsSetup: true, instance: 'mine-1' });
      assert.strictEqual(a.ok, true);
      const sch = mine.get('schools', 1);
      assert.strictEqual(sch.name, 'هنرستان فنی شهید باهنر'); assert.strictEqual(sch.district, 'خرو');
      const mgr = mine.all('users').find(u => u.role === 'manager');
      const g = sr.gate(mine, mgr);
      assert.strictEqual(g.access, false); assert.strictEqual(g.trial_available, true); assert.strictEqual(g.trial_days, 14);
      /* رد درخواست دیگر */
      const r2 = await sr.register(host, Object.assign({}, good, { username: 'other.mgr' }), { hash: pbkdf2Hash });
      o.plain.rejected = [{ id: r2.id, reason: 'اطلاعات ناقص' }]; await o.publish();
      const s2 = await sr.requestStatus(host, r2.id, r2.token);
      assert.strictEqual(s2.status, 'rejected'); assert.strictEqual(s2.reason, 'اطلاعات ناقص');
    });

    await check('SR-08 غیرفعال کردن مدرسه ورود را می‌بندد؛ حذف از فهرست', async () => {
      await wipe(S);
      const o = owner(cfg);
      o.addSchool('s-0020', 'mgr20', 'pass-2020');
      await o.publish();
      const st = newStore(cfg);
      await sr.adoptOnLogin(st, 'mgr20', 'pass-2020', { needsSetup: true, instance: 'i20' });
      const teacher = st.insert('users', { name: 'معلم', role: 'teacher', active: true });
      assert.strictEqual(sr.gate(st, teacher).access, true);
      o.plain.schools[0].active = false; await o.publish(); await sr.poll(st, {});
      assert.strictEqual(sr.gate(st, teacher).status, 'school_inactive');
      assert.strictEqual(sr.gate(st, { id: 0, role: '' }).status, 'school_inactive');
      const fresh = newStore(cfg);
      assert.strictEqual((await sr.adoptOnLogin(fresh, 'mgr20', 'pass-2020', { needsSetup: true })).error, 'school_inactive');
      o.plain.schools = []; await o.publish(); await sr.poll(st, {});
      assert.strictEqual(sr.gate(st, teacher).status, 'school_removed');
      assert.strictEqual(sr.settingsOf({ settings: { trial_days: 999, roles: { manager: 'xx' }, gateway: { pay_url: 'javascript:alert(1)' } } }).trial_days, 21);
      assert.strictEqual(sr.settingsOf({ settings: { roles: { manager: 'xx' } } }).roles.manager, 'required');
      assert.strictEqual(sr.settingsOf({ settings: { gateway: { pay_url: 'javascript:alert(1)' } } }).gateway.pay_url, '');
    });

    await check('SR-10 ردیف ۱۴۹: قیمت هر نقش، ۳۱ شهریور، هشدار تمدید از ۱ تیر، لغو پرداخت', async () => {
      const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/cloud/contracts/academic-year-vectors.json'), 'utf8'));
      for (const j of V.jalali) {
        assert.deepStrictEqual(ay.toGregorian(j[3], j[4], j[5]), j.slice(0, 3));
        assert.deepStrictEqual(ay.toJalali(j[0], j[1], j[2]), j.slice(3));
      }
      for (const c of V.cases) {
        const n = Date.parse(c.now), e = c.cur_end ? Date.parse(c.cur_end) : 0;
        assert.strictEqual(ay.academicYearOf(n), c.academic_year, c.name);
        assert.strictEqual(ay.iso(ay.yearEndMs(n)), c.year_end, c.name);
        assert.strictEqual(ay.iso(ay.renewOpenMs(n)), c.renew_open, c.name);
        assert.strictEqual(ay.iso(ay.monthlyEnd(n, e)), c.monthly_end, c.name);
        assert.strictEqual(ay.iso(ay.yearlyEnd(n, e)), c.yearly_end, c.name);
        assert.strictEqual(ay.iso(ay.daysEnd(n, 10, e)), c.days10_end, c.name);
        assert.strictEqual(ay.renewWarning(n, e), c.renew_warning, c.name);
      }
      await wipe(S);
      const o = owner(cfg);
      o.addSchool('s-0149', 'mgr149', 'pass-1490');
      o.plain.settings = {
        roles: { manager: 'required', teacher: 'required', parent: 'free' },
        role_plans: { manager: { monthly: 400000, yearly: 3500000 }, teacher: { monthly: 90000, yearly: null } },
      };
      await o.publish();
      const st = newStore(cfg);
      await sr.adoptOnLogin(st, 'mgr149', 'pass-1490', { needsSetup: true, instance: 'i149' });
      const mgr = st.all('users').find(u => u.role === 'manager');
      const teacher = st.insert('users', { name: 'دبیر', role: 'teacher', active: true });
      const bahman = Date.parse('2027-02-01T08:00:00Z');
      const gm = sr.gate(st, mgr, { now: bahman });
      assert.deepStrictEqual(gm.plans.map(p => [p.key, p.price]), [['monthly', 400000], ['yearly', 3500000]]);
      assert.deepStrictEqual(sr.gate(st, teacher).plans.map(p => [p.key, p.price]), [['monthly', 90000]]);
      assert.strictEqual(gm.year_end, '2027-09-22T20:30:00.000Z');
      assert.strictEqual(gm.renew_warning, false, 'پیش از ۱ تیر هشدار نیست');
      assert.strictEqual((await sr.submitReceipt(st, teacher, 'yearly', 'TRX-140501')).error, 'bad_plan', 'سالانه برای دبیر ارائه نشده');
      /* سالانهٔ دیرهنگام (بهمن): مبلغ کامل، پایان ۳۱ شهریور */
      const r = await sr.submitReceipt(st, mgr, 'yearly', 'TRX-140502');
      assert.strictEqual(r.payment.amount, 3500000);
      sr.markPaid(st, r.payment, { by: 'owner', now: bahman });
      const g1 = sr.gate(st, mgr, { now: bahman });
      assert.strictEqual(g1.access, true); assert.strictEqual(g1.end, '2027-09-22T20:30:00.000Z');
      /* ۱ تیر: هشدار تمدید فقط برای مدیر */
      const tir = Date.parse('2027-06-22T06:00:00Z');
      assert.strictEqual(sr.gate(st, mgr, { now: tir }).renew_warning, true);
      /* پس از ۳۱ شهریور: منقضی */
      const mehr = Date.parse('2027-09-23T06:00:00Z');
      assert.strictEqual(sr.gate(st, mgr, { now: mehr }).access, false);
      assert.strictEqual(sr.gate(st, mgr, { now: mehr }).status, 'expired');
      /* ماهانه ۳۱ روزه برای دبیر و لغو آن از پنل مالک */
      const rt = await sr.submitReceipt(st, teacher, 'monthly', 'TRX-140503');
      o.plain.decisions = { [rt.payment.id]: { status: 'approved' } }; await o.publish();
      const a1 = await sr.poll(st, {});
      assert.ok(a1.applied >= 1);
      const gt = sr.gate(st, teacher);
      assert.strictEqual(gt.access, true);
      assert.ok(Math.abs(Date.parse(gt.end) - ay.monthlyEnd(Date.now())) < 60000);
      assert.strictEqual((await o.read(sr.DIR.pay + rt.payment.id + '.json', sr.K.payment)).status, 'paid', 'وضعیت نهایی به پنل مالک برگشت');
      o.plain.decisions[rt.payment.id] = { status: 'cancelled', reason: 'تراکنش مشکوک' }; await o.publish();
      await sr.poll(st, {});
      const gc = sr.gate(st, teacher);
      assert.strictEqual(gc.access, false); assert.strictEqual(gc.status, 'cancelled');
      const back = await o.read(sr.DIR.pay + rt.payment.id + '.json', sr.K.payment);
      assert.strictEqual(back.status, 'cancelled'); assert.strictEqual(back.reason, 'تراکنش مشکوک');
      assert.strictEqual((await sr.poll(st, {})).applied, 0, 'لغو فقط یک بار');
      /* «لغو اشتراک» یک کاربر (grant cancel) */
      sr.markPaid(st, (await sr.submitReceipt(st, mgr, 'monthly', 'TRX-140504')).payment, { by: 'owner' });
      assert.strictEqual(sr.gate(st, mgr).access, true);
      o.plain.grants = [{ id: 'cx-1', school_id: 's-0149', kind: 'cancel', user_id: mgr.id }]; await o.publish();
      await sr.poll(st, {});
      assert.strictEqual(sr.gate(st, mgr).access, false);
      /* رکورد قدیمی (پیش از ردیف ۱۴۹) با پایان ۳۶۰ روزه هم در ۳۱ شهریور تمام می‌شود */
      const legacy = { users: { [String(mgr.id)]: { status: 'active', plan: 'yearly', start: '2026-10-01T08:00:00.000Z', end: '2027-09-26T08:00:00.000Z' } }, payments: [] };
      assert.strictEqual(sr.effectiveEnd(legacy.users[String(mgr.id)], bahman), Date.parse('2027-09-22T20:30:00.000Z'));
    });

    await check('SR-09 سرور واقعی (HTTP): ثبت‌نام، ورود با نام کاربری، 402، آزمایشی، بازگشت درگاه', async () => {
      await wipe(S);
      const o = owner(cfg);
      o.addSchool('s-0030', 'web.mgr', 'Web-Pass-1');
      o.plain.settings = { trial_days: 7, roles: { manager: 'required', teacher: 'free' } };
      await o.publish();
      const port = await freePort();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr145srv-'));
      tmpDirs.push(dir);
      const pre = openStore(path.join(dir, 'payesh.sqlite'));
      s3mem.usingMeta(pre).set(Object.assign({}, cfg));
      pre.close();
      const env = Object.assign({}, process.env, {
        PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: dir, PAYESH_LOG: '0', PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0',
        PAYESH_LIVE_MS: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0', PAYESH_MIRROR: '0', PAYESH_HEADLESS: '1',
      });
      const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = ''; child.stdout.on('data', (c) => { log += c; }); child.stderr.on('data', (c) => { log += c; });
      try {
        let up = false;
        for (let i = 0; i < 200 && !up; i++) { up = (await req('GET', port, '/api/health')).status === 200; if (!up) await new Promise(r => setTimeout(r, 100)); }
        assert.ok(up, 'server up\n' + log);
        const h = (await req('GET', port, '/api/health')).json;
        assert.strictEqual(h.registration, true);
        /* ثبت‌نام عمومی */
        const bad = await req('POST', port, '/api/schools/register', { school_name: 'x' });
        assert.strictEqual(bad.status, 400); assert.strictEqual(bad.json.error, 'bad_school_name');
        const rg = await req('POST', port, '/api/schools/register', { school_name: 'دبستان وب', level: 'ابتدایی', province: 'تهران', county: 'تهران', phone: '09120000000', staff_count: 5, student_count: 50, manager_name: 'مدیر وب', username: 'web.new', password: 'Web-New-1' });
        assert.strictEqual(rg.status, 200, rg.body); assert.strictEqual(rg.json.status, 'pending');
        const stt = await req('GET', port, '/api/schools/register/status?id=' + rg.json.id + '&token=' + rg.json.token);
        assert.strictEqual(stt.json.status, 'pending');
        assert.strictEqual((await req('POST', port, '/api/schools/register', { school_name: 'دبستان وب', level: 'ابتدایی', province: 'تهران', county: 'تهران', phone: '09120000000', staff_count: 5, student_count: 50, manager_name: 'مدیر وب', username: 'web.mgr', password: 'Web-New-1' })).status, 409);
        /* ورود مدیرِ مالک‌ساخته روی سرور تازه */
        const wrong = await req('POST', port, '/api/auth/login', { phone: 'web.mgr', password: 'bad-pass-9', platform: 'android' });
        assert.strictEqual(wrong.status, 401);
        const lg = await req('POST', port, '/api/auth/login', { phone: 'web.mgr', password: 'Web-Pass-1', platform: 'android' });
        assert.strictEqual(lg.status, 200, lg.body + '\n' + log.slice(-800));
        const H = { authorization: 'Bearer ' + lg.json.session.token };
        const me = await req('GET', port, '/api/me', null, H);
        assert.strictEqual(me.status, 200, me.body + ' sess=' + JSON.stringify(lg.json).slice(0, 300));
        const boot = await req('GET', port, '/api/bootstrap', null, H);
        assert.strictEqual(boot.status, 402); assert.strictEqual(boot.json.error, 'subscription_required');
        const ss = await req('GET', port, '/api/sub/status', null, H);
        assert.strictEqual(ss.json.access, false); assert.strictEqual(ss.json.trial_days, 7); assert.strictEqual(ss.json.trial_available, true);
        const pay = await req('POST', port, '/api/sub/pay', { plan: 'monthly' }, H);
        assert.strictEqual(pay.status, 409); assert.strictEqual(pay.json.error, 'gateway_not_configured');
        const rc = await req('POST', port, '/api/sub/receipt', { plan: 'monthly', ref: 'TRX-55555' }, H);
        assert.strictEqual(rc.status, 200); assert.match(rc.json.payment.id, /^SUB-/);
        const tr = await req('POST', port, '/api/sub/trial', { device_hash: DEV_B }, H);
        assert.strictEqual(tr.status, 200, tr.body); assert.strictEqual(tr.json.sub.status, 'trial');
        assert.strictEqual((await req('GET', port, '/api/bootstrap', null, H)).status, 200);
        const cb = await req('GET', port, '/api/sub/callback?payment=' + rc.json.payment.id);
        assert.strictEqual(cb.status, 200); assert.ok(cb.type.startsWith('text/html')); assert.ok(cb.body.includes(rc.json.payment.id));
        /* سرور دوم با همان مدیر ⇒ 409 */
        const again = await req('POST', port, '/api/auth/login', { phone: 'web.mgr', password: 'Web-Pass-1', platform: 'android' });
        assert.strictEqual(again.status, 200, 'same server logs in again');
      } finally {
        child.kill('SIGKILL');
        await new Promise((r) => child.once('exit', r));
      }
    });
  } finally {
    await S.close();
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* noop */ } }
  }

  if (failures.length) { console.log('SCHOOLS-145-FAIL failures=' + failures.length); process.exit(1); }
  console.log('SCHOOLS-145-OK checks=' + checks);
  process.exit(0);
})().catch((e) => { console.log('FAIL fatal — ' + (e && e.stack)); console.log('SCHOOLS-145-FAIL failures=1'); process.exit(1); });
