// موتور هوشمند (ردیف ۱۵۴) — سمت سرور مدرسه: گم نشدن پرداخت و جلوگیری از تراکنش تکراری.
// server/school-registry.js در برابر صندوقچهٔ S3 محلی (SigV4 واقعی) و SQLite واقعی.
//
//   GD-01  گزارش پرداخت به دیتابیس ناموفق ⇒ «ارسال‌نشده» علامت می‌خورد و در دور تناوبی بعد خودکار
//          فرستاده می‌شود؛ علامت داخلی به صندوقچه نمی‌رود؛ دور بعدی چیزی دوباره نمی‌فرستد.
//   GD-02  رسید تکراری (با فاصله/خط تیره/ارقام فارسی) در همان مدرسه رد می‌شود (dup_ref)؛
//          پس از رد شدن رسید اول توسط مالک، ثبت دوباره آزاد است.
//   GD-03  کد تراکنش درگاهِ تکراری ⇒ خودکار فعال نمی‌شود: در انتظار مالک با پرچم dup_gateway_ref.
//   GD-04  normRef.
// خط آخر: GUARD-154-OK checks=N | GUARD-154-FAIL failures=N
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert');

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
function newStore(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd154-'));
  tmpDirs.push(dir);
  const store = openStore(path.join(dir, 'payesh.sqlite'));
  if (cfg) s3mem.usingMeta(store).set(Object.assign({}, cfg));
  return store;
}
function deadPort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

function owner(cfg) {
  const o = {
    rev: 1000,
    plain: { v: 1, schools: [], settings: {}, domain: '', grants: [], decisions: {}, rejected: [] },
    async publish() {
      o.rev += 1;
      await s3mem.put(cfg, cfg.prefix + sr.DIR.registry, JSON.stringify(sr.seal(cfg.secret, sr.K.registry, o.rev, JSON.stringify(o.plain))));
    },
    addSchool(id, username, password) {
      o.plain.schools.push({ id, name: 'مدرسهٔ ' + id, level: 'ابتدایی', active: true,
        manager: { username, name: 'مدیر ' + id, phone: '', password_hash: pbkdf2Hash(password), rev: 1 } });
    },
    async read(key, kind) {
      try { return sr.open(cfg.secret, kind, JSON.parse(await s3mem.get(cfg, cfg.prefix + key))).plain; } catch (e) { return null; }
    },
  };
  return o;
}

(async () => {
  const S = await startStub({ accessKey: 'ak-g', secret: 'sk-guard-1', bucket: 'payesh-madrese' });
  const cfg = s3mem.normalize(S.cfg);
  try {
    const o = owner(cfg);
    o.addSchool('s-0154', 'mgr154', 'pass-1544');
    o.addSchool('s-0155', 'mgr155', 'pass-1555');
    o.addSchool('s-0156', 'mgr156', 'pass-1566');
    o.plain.settings = {
      receipt_note: 'کارت',
      gateway: { pay_url: 'https://pay.example/start?id={payment_id}&cb={callback}', verify_url: 'https://pay.example/verify?id={payment_id}' },
    };
    await o.publish();

    await check('GD-01 پرداخت گزارش‌نشده خودکار دوباره فرستاده می‌شود', async () => {
      const st = newStore(cfg);
      await sr.adoptOnLogin(st, 'mgr154', 'pass-1544', { needsSetup: true, instance: 'g1' });
      const mgr = st.all('users').find(u => u.role === 'manager');
      /* دیتابیس در دسترس نیست */
      s3mem.usingMeta(st).set(Object.assign({}, cfg, { endpoint: 'http://127.0.0.1:' + await deadPort() }));
      const r = await sr.submitReceipt(st, mgr, 'monthly', 'TRX-0154-A');
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.reported, false);
      const row = sr.subsState(st).payments.find(p => p.id === r.payment.id);
      assert.strictEqual(row.unreported, true);
      assert.strictEqual(await o.read(sr.DIR.pay + r.payment.id + '.json', sr.K.payment), null);
      /* وصل دوباره ⇒ دور تناوبی */
      s3mem.usingMeta(st).set(Object.assign({}, cfg));
      const p1 = await sr.poll(st, {});
      assert.strictEqual(p1.resent, 1);
      const inBucket = await o.read(sr.DIR.pay + r.payment.id + '.json', sr.K.payment);
      assert.strictEqual(inBucket.ref, 'TRX-0154-A');
      assert.strictEqual(inBucket.school_id, 's-0154');
      assert.ok(!('unreported' in inBucket));
      assert.ok(!('unreported' in sr.subsState(st).payments.find(p => p.id === r.payment.id)));
      assert.strictEqual((await sr.poll(st, {})).resent, 0);
      assert.strictEqual(await sr.resendUnreported(st), 0);
    });

    await check('GD-02 رسید تکراری رد؛ پس از رد مالک آزاد', async () => {
      const st = newStore(cfg);
      await sr.adoptOnLogin(st, 'mgr155', 'pass-1555', { needsSetup: true, instance: 'g2' });
      const mgr = st.all('users').find(u => u.role === 'manager');
      const a = await sr.submitReceipt(st, mgr, 'monthly', 'TRX-5555');
      assert.strictEqual(a.ok, true);
      assert.strictEqual((await sr.submitReceipt(st, mgr, 'yearly', 'trx ۵۵۵۵')).error, 'dup_ref');
      assert.strictEqual((await sr.submitReceipt(st, mgr, 'monthly', 'TRX_55.55')).error, 'dup_ref');
      assert.strictEqual(sr.subsState(st).payments.length, 1);
      o.plain.decisions = { [a.payment.id]: { status: 'rejected', reason: 'نامعتبر' } };
      await o.publish();
      await sr.poll(st, {});
      const b = await sr.submitReceipt(st, mgr, 'monthly', 'TRX-5555');
      assert.strictEqual(b.ok, true);
      assert.notStrictEqual(b.payment.id, a.payment.id);
    });

    await check('GD-03 کد تراکنش درگاه تکراری به تأیید مالک می‌رود', async () => {
      const st = newStore(cfg);
      await sr.adoptOnLogin(st, 'mgr156', 'pass-1566', { needsSetup: true, instance: 'g3' });
      const mgr = st.all('users').find(u => u.role === 'manager');
      const okFetch = async () => ({ json: async () => ({ data: { code: 100, ref_id: 777 } }) });
      const p1 = await sr.startPayment(st, mgr, 'monthly', { callbackBase: 'https://g3.example' });
      const c1 = await sr.callback(st, new URLSearchParams({ payment: p1.payment.id }), { fetchImpl: okFetch });
      assert.strictEqual(c1.status, 'paid');
      const end = sr.gate(st, mgr).end;
      const p2 = await sr.startPayment(st, mgr, 'yearly', { callbackBase: 'https://g3.example' });
      const c2 = await sr.callback(st, new URLSearchParams({ payment: p2.payment.id }), { fetchImpl: okFetch });
      assert.strictEqual(c2.status, 'pending');
      assert.strictEqual(sr.gate(st, mgr).end, end, 'اشتراک تمدید نشد');
      const row = sr.subsState(st).payments.find(p => p.id === p2.payment.id);
      assert.strictEqual(row.flag, 'dup_gateway_ref');
      assert.strictEqual(row.awaiting_owner, true);
      const inBucket = await o.read(sr.DIR.pay + p2.payment.id + '.json', sr.K.payment);
      assert.strictEqual(inBucket.flag, 'dup_gateway_ref');
      assert.strictEqual(inBucket.gateway_ref, '777');
      assert.strictEqual(inBucket.status, 'pending');
      /* کد تازه ⇒ عادی */
      const okFetch2 = async () => ({ json: async () => ({ data: { code: 100, ref_id: 778 } }) });
      const p3 = await sr.startPayment(st, mgr, 'monthly', { callbackBase: 'https://g3.example' });
      assert.strictEqual((await sr.callback(st, new URLSearchParams({ payment: p3.payment.id }), { fetchImpl: okFetch2 })).status, 'paid');
    });

    await check('GD-04 normRef', async () => {
      assert.strictEqual(sr.normRef(' ۱۲-۳۴ AB/c.d_e '), '1234abcde');
      assert.strictEqual(sr.normRef(null), '');
    });
  } finally {
    await S.close();
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* noop */ } }
  }

  if (failures.length) { console.log('GUARD-154-FAIL failures=' + failures.length); process.exit(1); }
  console.log('GUARD-154-OK checks=' + checks);
  process.exit(0);
})().catch((e) => { console.log('FAIL fatal — ' + (e && e.stack)); console.log('GUARD-154-FAIL failures=1'); process.exit(1); });
