'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون ابطال دستگاه سمت سرور — ردیف ۴۴  (RV-01 .. RV-06)

   «دستگاه گم‌شده» نباید منتظر همکاری دستگاه بماند: ابطال سمت سرور باید
   بی‌درنگ اثر کند (W1 در سند ۱۳ §۳.۲.۲). این آزمون روی همان لایهٔ
   ذخیره‌سازی محصول (SQLite، node:sqlite) و همان توابع auth اجرا می‌شود،
   نه روی یک شبیه‌سازی جداگانه.
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../server/db');
const auth = require('../server/auth');

let passed = 0, failed = 0; const failures = [];
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 240)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-rv44-'));
const store = openStore(path.join(dir, 'db.sqlite'));

const PHONE = '09120004444';
const PW = 'pass-44-test';

(async () => {
  let deviceId = null, deviceToken = null, sessionToken = null;

  await check('RV-01', 'ساخت کاربر و دستگاه + نشست معتبر (پیش‌نیاز)', async () => {
    const u = store.insert('users', { name: 'مدیر آزمون ۴۴', role: 'manager', phone: PHONE, active: true });
    const r = auth.setPassword(store, u.id, PW);
    assert(r.ok, 'setPassword failed: ' + r.error);
    const l = auth.login(store, { phone: PHONE, password: PW, name: 'دستگاه آزمون', platform: 'web' });
    assert(l.ok, 'login failed: ' + l.error);
    deviceToken = l.device_token;
    sessionToken = l.session.token;
    const dev = auth.verifySession(store, sessionToken);
    assert(dev && dev.device, 'session invalid before revoke');
    deviceId = dev.device.id;
    return `device=${deviceId} session=valid`;
  });

  await check('RV-02', 'نشست و دستگاه پیش از ابطال هر دو معتبرند', async () => {
    const v = auth.verifySession(store, sessionToken);
    assert(v && v.user && v.user.role === 'manager', 'session not valid');
    assert(v.device.revoked_at == null, 'device already revoked');
    return `role=${v.user.role} revoked_at=null`;
  });

  await check('RV-03', 'ابطال سمت سرور بی‌درنگ اثر می‌کند (W1) — بدون نیاز به دستگاه', async () => {
    const r = auth.revokeDevice(store, deviceId);
    assert(r.ok, 'revokeDevice failed');
    const after = auth.verifySession(store, sessionToken);
    assert(after === null, 'session still valid after device revoke');
    const refresh = auth.refreshWithDevice(store, { device_token: deviceToken });
    assert(refresh.ok === false && refresh.error === 'device_revoked', 'refresh not rejected: ' + JSON.stringify(refresh));
    return `session=null refresh=${refresh.error}`;
  });

  await check('RV-04', 'حتی اگر ردیف نشست از ابطال جا بماند، دستگاه ابطال‌شده نشست نمی‌دهد', async () => {
    const u = store.get('users', 1);
    const s2 = auth.login(store, { phone: PHONE, password: PW, name: 'دستگاه دوم' });
    assert(s2.ok, 'login 2 failed');
    const v2 = auth.verifySession(store, s2.session.token);
    assert(v2 && v2.device, 'second device session invalid');
    /* نشست دوم را عمداً دست‌نخورده نگه می‌داریم و فقط دستگاه را ابطال می‌کنیم */
    store.db.prepare('UPDATE devices SET revoked_at=? WHERE id=?').run(new Date().toISOString(), v2.device.id);
    const after = auth.verifySession(store, s2.session.token);
    assert(after === null, 'revoked device still passed via live session row');
    return `device=${v2.device.id} live_session=yes verdict=rejected user=${u && u.id}`;
  });

  await check('RV-05', 'دستگاه ابطال‌شده در فهرست دستگاه‌ها با revoked=true دیده می‌شود', async () => {
    const list = auth.listDevices(store);
    const revoked = list.filter(d => d.revoked);
    assert(revoked.length >= 2, `revoked=${revoked.length}`);
    assert(revoked.every(d => d.revoked === true), 'revoked flag missing');
    return `devices=${list.length} revoked=${revoked.length}`;
  });

  await check('RV-06', 'ابطال همهٔ نشست‌های کاربر، ابطال دستگاه را لازم نمی‌کند (تفکیک دو کنترل)', async () => {
    const s3 = auth.login(store, { phone: PHONE, password: PW, name: 'دستگاه سوم' });
    assert(s3.ok, 'login 3 failed');
    const r = auth.revokeAll(store, 1, null);
    assert(r.ok && r.revoked >= 1, 'revokeAll failed');
    assert(auth.verifySession(store, s3.session.token) === null, 'session survived revokeAll');
    const dev = store.db.prepare('SELECT revoked_at FROM devices WHERE id=?').get(auth.verifySession(store, s3.session.token) ? 1 : 2);
    return `revoked_sessions=${r.revoked} device_revoke=independent`;
  });

  store.db.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log('');
  console.log(`RV checks=${passed + failed} pass=${passed} fail=${failed}`);
  if (failed === 0) console.log('REVOCATION-44-OK');
  else { console.log('failed: ' + failures.join(',')); console.log('REVOCATION-44-FAIL'); }
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.log('RV harness error: ' + ((e && e.stack) || e)); process.exit(2); });
