'use strict';
/* ═══════════════════════════════════════════════════════════
   ردیف ۱۶۴ — یک دیتابیس برای همه، از هر اینترنتی
     L-01..L-05  سرورِ از قبل راه‌افتاده (مدرسه و داده دارد، هنوز به مدرسهٔ پنل مالک گره
                 نخورده) با نام کاربری/همراه + رمزی که مالک داده گره می‌خورد — بدون پاک
                 شدن هیچ داده‌ای؛ رمز غلط / همراه ناهمخوان / میزبان دیگر رد می‌شود.
     L-06..L-07  فهرست «فقط نشانی»: «سرور مرکزی» مالک (فقط https) در تازه کردن ردیف
                 سرورها حفظ می‌شود.
     L-10        آدرس دستی (custom) با پاک‌سازی آغاز نمی‌رود
     L-08..L-09  تونل: پیوند تأیید یک‌بارهٔ Funnel از خروجی tailscale (فقط login.tailscale.com)
                 و رسید سرور در دیتابیس (public_url + tunnel) بدون راز.
   ═══════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const sr = require(path.join(ROOT, 'server', 'school-registry.js'));
const s3mem = require(path.join(ROOT, 'server', 's3mem.js'));
const auth = require(path.join(ROOT, 'server', 'auth.js'));
const discovery = require(path.join(ROOT, 'server', 'discovery.js'));
const tunnel = require(path.join(ROOT, 'server', 'tunnel.js'));
const cloudControl = require(path.join(ROOT, 'server', 'cloud-control.js'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln164-'));
  tmpDirs.push(dir);
  const store = openStore(path.join(dir, 'payesh.sqlite'));
  if (cfg) s3mem.usingMeta(store).set(Object.assign({}, cfg));
  return store;
}

/* سروری که پیش از پنل مالک راه افتاده: مدرسهٔ محلی + مدیر بی‌نام‌کاربری + چند کاربر */
function legacyServer(cfg) {
  const st = newStore(cfg);
  st.insert('schools', { name: 'آینده سازان', level: 'متوسطه دوم', created_at: new Date().toISOString() }, { id: 1 });
  st.insert('users', { name: 'مدیر قدیمی', role: 'manager', phone: '09187888993', national_id: '', active: true, school_id: 1,
    password_hash: pbkdf2Hash('old-local-pass'), phone_hash: pbkdf2Hash('old-local-pass') });
  for (let i = 0; i < 5; i++) st.insert('users', { name: 'معلم ' + i, role: 'teacher', phone: '0912000000' + i, active: true, school_id: 1 });
  return st;
}

async function publishRegistry(cfg, rev, schools) {
  const plain = { v: 1, schools, settings: {}, domain: '', grants: [], decisions: {}, rejected: [] };
  await s3mem.put(cfg, cfg.prefix + sr.DIR.registry, JSON.stringify(sr.seal(cfg.secret, sr.K.registry, rev, JSON.stringify(plain))));
}

const ownerSchool = (extra = {}) => Object.assign({
  id: 's-adefbf8ae8ff', name: 'کاردانش آینده سازان', level: 'متوسطه دوم', active: true,
  manager: { username: 'rezaa254', name: 'رضا', phone: '09187888993', national_id: '0012345679', password_hash: pbkdf2Hash('Owner-Pass-1'), rev: 2 },
}, extra);

(async () => {
  const S = await startStub({ accessKey: 'ak-164', secret: 'sk-link-164', bucket: 'payesh-madrese' });
  const cfg = s3mem.normalize(S.cfg);
  try {
    await check('L-01 سرور قدیمی: نام کاربری + رمز پنل مالک ⇒ گره می‌خورد، داده‌ها می‌مانند، ورود کار می‌کند', async () => {
      S.objects.clear();
      await publishRegistry(cfg, 1001, [ownerSchool()]);
      const st = legacyServer(cfg);
      assert.strictEqual(auth.needsSetup(st), false, 'تازه نیست ⇒ adoptOnLogin اجرا نمی‌شود');
      assert.strictEqual(auth.login(st, { phone: 'rezaa254', password: 'Owner-Pass-1' }).ok, false, 'پیش از گره خوردن رد می‌شد (همان خطای کاربر)');
      const before = st.all('users').length;
      const r = await sr.linkOnLogin(st, 'rezaa254', 'Owner-Pass-1', { instance: 'dd9286ad1f5d3ccb', now: Date.now() + 120_000 });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(st.all('users').length, before, 'هیچ کاربری ساخته یا پاک نشد');
      assert.strictEqual(st.get('schools', 1).name, 'آینده سازان', 'دادهٔ مدرسه دست نخورد');
      assert.strictEqual(st.get('schools', 1).owner_school_id, 's-adefbf8ae8ff');
      const b = sr.boundOf(st);
      assert.strictEqual(b.school_id, 's-adefbf8ae8ff'); assert.strictEqual(b.manager_rev, 2); assert.strictEqual(b.linked, true);
      const ok = auth.login(st, { phone: 'rezaa254', password: 'Owner-Pass-1', platform: 'android' });
      assert.strictEqual(ok.ok, true, JSON.stringify(ok));
      assert.strictEqual(ok.user.role, 'manager');
      assert.strictEqual(auth.login(st, { phone: '09187888993', password: 'Owner-Pass-1' }).ok, true, 'با همراه هم');
      assert.strictEqual(auth.login(st, { phone: 'rezaa254', password: 'old-local-pass' }).ok, false, 'رمز قدیمی محلی دیگر نه');
      assert.strictEqual(st.all('users').find(u => u.role === 'manager').national_id, '0012345679', 'کد ملی خالی پر شد');
      /* دوباره: already_bound */
      assert.strictEqual((await sr.linkOnLogin(st, 'rezaa254', 'Owner-Pass-1', { instance: 'dd9286ad1f5d3ccb' })).error, 'already_bound');
      /* رسید میزبانی در دیتابیس */
      const ack = sr.open(cfg.secret, sr.K.ack, JSON.parse(await s3mem.get(cfg, cfg.prefix + sr.DIR.ack + 's-adefbf8ae8ff.json'))).plain;
      assert.strictEqual(ack.instance, 'dd9286ad1f5d3ccb');
    });

    await check('L-02 NEG: رمز غلط ⇒ گره نمی‌خورد و هیچ چیز عوض نمی‌شود', async () => {
      S.objects.clear();
      await publishRegistry(cfg, 1002, [ownerSchool()]);
      const st = legacyServer(cfg);
      const mgr0 = JSON.stringify(st.all('users').find(u => u.role === 'manager'));
      const r = await sr.linkOnLogin(st, 'rezaa254', 'wrong-pass', { instance: 'i', now: Date.now() + 240_000 });
      assert.strictEqual(r.error, 'bad_credentials');
      assert.strictEqual(sr.boundOf(st), null);
      assert.strictEqual(JSON.stringify(st.all('users').find(u => u.role === 'manager')), mgr0);
      assert.strictEqual((await sr.linkOnLogin(st, 'nobody', 'x', { instance: 'i' })).error, 'not_found');
      assert.strictEqual((await sr.linkOnLogin(st, 'a b', 'x', { instance: 'i' })).error, 'bad_shape');
      assert.strictEqual((await sr.linkOnLogin(newStore(null), 'rezaa254', 'Owner-Pass-1', {})).error, 'not_managed');
    });

    await check('L-03 NEG: همراه مدیر محلی با همراه مدیر پنل مالک نمی‌خواند ⇒ رد', async () => {
      S.objects.clear();
      await publishRegistry(cfg, 1003, [ownerSchool({ manager: Object.assign({}, ownerSchool().manager, { phone: '09120000999' }) })]);
      const st = legacyServer(cfg);
      const r = await sr.linkOnLogin(st, 'rezaa254', 'Owner-Pass-1', { instance: 'i', now: Date.now() + 360_000 });
      assert.strictEqual(r.error, 'no_local_manager');
      assert.strictEqual(sr.boundOf(st), null);
    });

    await check('L-04 NEG: مدرسه را سرور دیگری میزبانی می‌کند ⇒ school_hosted_elsewhere؛ غیرفعال ⇒ school_inactive', async () => {
      S.objects.clear();
      await publishRegistry(cfg, 1004, [ownerSchool()]);
      await sr.writeEnv(cfg, cfg.prefix + sr.DIR.ack + 's-adefbf8ae8ff.json', sr.K.ack, Date.now(), { v: 1, school_id: 's-adefbf8ae8ff', instance: 'other-server', at: new Date().toISOString() });
      const st = legacyServer(cfg);
      assert.strictEqual((await sr.linkOnLogin(st, 'rezaa254', 'Owner-Pass-1', { instance: 'mine', now: Date.now() + 480_000 })).error, 'school_hosted_elsewhere');
      S.objects.clear();
      await publishRegistry(cfg, 1005, [ownerSchool({ active: false })]);
      const st2 = legacyServer(cfg);
      assert.strictEqual((await sr.linkOnLogin(st2, 'rezaa254', 'Owner-Pass-1', { instance: 'mine', now: Date.now() + 600_000 })).error, 'school_inactive');
    });

    await check('L-05 بعد از گره خوردن، تغییر رمز در پنل مالک روی همین سرور اعمال می‌شود', async () => {
      S.objects.clear();
      await publishRegistry(cfg, 1006, [ownerSchool()]);
      const st = legacyServer(cfg);
      assert.strictEqual((await sr.linkOnLogin(st, 'rezaa254', 'Owner-Pass-1', { instance: 'i6', now: Date.now() + 720_000 })).ok, true);
      const changed = ownerSchool();
      changed.manager = Object.assign({}, changed.manager, { password_hash: pbkdf2Hash('Taze-1404'), rev: 3 });
      await publishRegistry(cfg, 1007, [changed]);
      await sr.poll(st, { instance: 'i6' });
      assert.strictEqual(auth.login(st, { phone: 'rezaa254', password: 'Taze-1404' }).ok, true);
      assert.strictEqual(auth.login(st, { phone: 'rezaa254', password: 'Owner-Pass-1' }).ok, false);
    });

    await check('L-06 فهرست نشانی‌ها: سرور مرکزی مالک در تازه کردن ردیف سرور حفظ می‌شود', async () => {
      S.objects.clear();
      discovery.stop();
      await s3mem.put(cfg, discovery.keyOf(cfg), JSON.stringify({ v: 1, kind: discovery.KIND, at: new Date().toISOString(), servers: [],
        central: { url: 'https://server.example.ir', at: '2026-11-15T22:00:00Z' } }));
      const st = newStore(cfg);
      const r = await discovery.publish(st, { instance: 'dd9286ad1f5d3ccb', school: null, lanUrls: ['http://192.168.1.120:8080'], publicUrl: 'https://reza.tailb692ba.ts.net', version: '0.9.18' });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      const doc = JSON.parse(await s3mem.get(cfg, discovery.keyOf(cfg)));
      assert.deepStrictEqual(doc.central, { url: 'https://server.example.ir', at: '2026-11-15T22:00:00Z' });
      assert.strictEqual(doc.servers[0].public_url, 'https://reza.tailb692ba.ts.net');
    });

    await check('L-07 NEG: سرور مرکزی غیر https یا با کاربر ⇒ کنار می‌رود', async () => {
      for (const bad of ['http://server.example.ir', 'https://u:p@server.example.ir', 'ftp://x', '', 42]) {
        assert.strictEqual(discovery.centralOf({ central: { url: bad } }), null, String(bad));
      }
      assert.strictEqual(discovery.centralOf(null), null);
      assert.deepStrictEqual(discovery.centralOf({ central: { url: 'https://Server.Example.ir/x' } }), { url: 'https://server.example.ir', at: null });
      const m = discovery.merge({ servers: [], central: { url: 'http://x.ir' } }, discovery.entryOf({ instance: 'a', lanUrls: ['http://10.0.0.2:8080'] }));
      assert.strictEqual(m.central, undefined);
    });

    await check('L-08 تونل: پیوند تأیید Funnel فقط از login.tailscale.com', async () => {
      const out = 'Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=n2Uw2YhHb811CNTRL\n';
      assert.strictEqual(tunnel.funnelEnableUrl(out), 'https://login.tailscale.com/f/funnel?node=n2Uw2YhHb811CNTRL');
      assert.strictEqual(tunnel.funnelEnableUrl('visit https://evil.example/f/funnel?node=x'), null);
      assert.strictEqual(tunnel.funnelEnableUrl(''), null);
      const h = tunnel.hint();
      assert.ok('enable_url' in h && 'ok' in h);
    });

    await check('L-09 رسید سرور در دیتابیس: نشانی عمومی و وضعیت تونل، بدون راز', async () => {
      const st = newStore(cfg);
      require(path.join(ROOT, 'server', 'config.js')).setMeta(st, 'public_url', 'https://reza.tailb692ba.ts.net');
      const info = cloudControl.publicInfo(st);
      assert.strictEqual(info.public_url, 'https://reza.tailb692ba.ts.net');
      assert.ok(info.tunnel && 'enable_url' in info.tunnel);
      const text = JSON.stringify(info);
      assert.ok(!text.includes(cfg.secret) && !text.includes(cfg.accessKey), 'بدون کلید');
    });

    await check('L-10 آدرس دستیِ ذخیره‌شده (custom) با پاک‌سازی آغاز سرور پاک نمی‌شود؛ آدرس موقت پاک می‌شود', async () => {
      const tunnel = require('../server/tunnel.js');
      const meta = {};
      const store = { getMeta: (k, d) => (k in meta ? meta[k] : (d === undefined ? null : d)), setMeta: (k, v) => { meta[k] = v; }, audit: () => {} };
      meta['cfg:public_url'] = 'https://payesh.example.ir';
      meta['cfg:tunnel_provider'] = 'custom';
      assert.strictEqual(tunnel.purgeStalePublicUrl(store).cleared, false, 'custom می‌ماند');
      assert.strictEqual(meta['cfg:public_url'], 'https://payesh.example.ir');
      meta['cfg:tunnel_provider'] = '';
      meta['cfg:public_url'] = 'https://abcd-1234.example-ephemeral.net';
      assert.strictEqual(tunnel.purgeStalePublicUrl(store).cleared, true, 'موقت پاک می‌شود');
    });
  } finally {
    discovery.stop();
    await S.close();
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* noop */ } }
  }

  if (failures.length) { console.log('LINK-164-FAIL failures=' + failures.length); process.exit(1); }
  console.log('LINK-164-OK checks=' + checks);
  process.exit(0);
})().catch((e) => { console.log('FAIL fatal — ' + (e && e.stack)); console.log('LINK-164-FAIL failures=1'); process.exit(1); });
