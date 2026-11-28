#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   کندی صفحهٔ کاربران (تشخیص و رفعِ ۲۰۲۶-۱۱-۲۸)

   علت ریشه‌ای: GET /api/admin/users/credentials برای هر کاربری که
   password_enc نداشت، در هر درخواست یک PBKDF2 کامل (۱۵۰هزار دور،
   ~۶۰ms) اجرا می‌کرد و نتیجه هیچ‌جا نمی‌نشست؛ یعنی ورود مدیر به
   «کاربران» برای مدرسهٔ ۳۰۰نفره ~۱۹ ثانیه سرورِ تک‌رشته‌ای را قفل
   می‌کرد — هر بار. کلاینت هم رمزها را با ورود به صفحه می‌خواند و بعد
   کل صفحه را دوباره می‌ساخت، و saveCache با هر تغییر کل دادهٔ مدرسه
   را از نو رشته‌سازی + رمز (AES-GCM) و بازنویسی می‌کرد.

     PERF-01  passwordOf رمز پیش‌فرض را برمی‌گرداند و همان یک بار
              password_enc مهرشده در ردیف می‌نشیند — بدون تغییر
              version/updated_at (یعنی بدون دلتای همگام‌سازی)
     PERF-02  پس از مهرشدن، حتی با خراب‌شدن password_hash در پایگاه،
              رمز از password_enc خوانده می‌شود (PBKDF2 تکرار نمی‌شود)
     PERF-03  رمزِ غیردرپیش‌فرض ⇒ null؛ کش با خودِ hash کلید می‌خورد
              و نتیجهٔ رمز قبلی روی hash تازه نمی‌نشیند
     PERF-04  updateDataInPlace: mutator بی‌اثر/نامعتبر ⇒ بدون نوشتن؛
              نسخه و updated_at ثابت می‌مانند
     PERF-05  کلاینت: رمزها تنبل (loadCreds فقط در actUserCreds)،
              render دیگر واکشی eager ندارد؛ saveCache ادغامی است و
              هنگام پنهان‌شدن/بسته‌شدن صفحه flush می‌شود؛ اندپوینت
              credentials بین کاربرها به حلقهٔ رویداد نفس می‌دهد
     PERF-06  کنترل‌های منفی: بدون password_hash ⇒ null؛ کاربر
              ناموجود ⇒ null/false؛ شناسهٔ ناموجود در updateDataInPlace
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const assert = (c, m) => { if (!c) throw new Error(m); };

let passed = 0, failed = 0, negatives = 0, quiet = false;
const failures = [];
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; if (!quiet) console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`); }
}
async function negative(id, desc, fn) {
  try { await fn(); negatives++; if (!quiet) console.log(`PASS  ${id}  ${desc}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`); }
}

async function main(opts = {}) {
  quiet = !!opts.quiet;
  const { openStore } = require(path.join(ROOT, 'server', 'db'));
  const auth = require(path.join(ROOT, 'server', 'auth'));
  const { pbkdf2Hash } = require(path.join(ROOT, 'server', 'util'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-perf213-'));
  const store = openStore(path.join(dir, 't.db'));
  try {
    const nid1 = '1000000001';
    store.insert('users', { name: 'دانش‌آموز یک', role: 'student', national_id: nid1, phone: '09120001001', password_hash: pbkdf2Hash(nid1), active: true }, { id: 1 });
    const nid2 = '1000000002';
    store.insert('users', { name: 'دانش‌آموز دو', role: 'student', national_id: nid2, phone: '09120001002', password_hash: pbkdf2Hash('custom-pass-9876'), active: true }, { id: 2 });
    store.insert('users', { name: 'بدون رمز', role: 'student', national_id: '1000000003', phone: '09120001003', active: true }, { id: 3 });

    const v1 = store.versionOf('users', 1);
    const u1at = store.getRow('users', 1).updated_at;

    await check('PERF-01', 'passwordOf: رمز پیش‌فرض + مهرِ یک‌بارهٔ password_enc بدون تغییر نسخه/زمان', () => {
      assert(!store.get('users', 1).password_enc, 'precondition: password_enc must start empty');
      const out = auth.passwordOf(store, store.get('users', 1));
      assert(out === nid1, 'default password (national id) must be returned, got ' + out);
      const after = store.get('users', 1);
      assert(/^enc:v1:/.test(String(after.password_enc || '')), 'password_enc must be sealed in place after first call');
      assert(store.versionOf('users', 1) === v1, 'version must not change (no sync delta)');
      assert(store.getRow('users', 1).updated_at === u1at, 'updated_at must not change');
      return 'sealed once, version/at untouched';
    });

    await check('PERF-02', 'پس از مهرشدن، رمز از password_enc می‌آید نه از PBKDF2', () => {
      assert(store.updateDataInPlace('users', 1, d => Object.assign({}, d, { password_hash: 'garbage-not-a-hash' })) === true, 'in-place corrupt failed');
      const out = auth.passwordOf(store, store.get('users', 1));
      assert(out === nid1, 'sealed password must survive a corrupt hash (no re-verify), got ' + out);
      return 'enc path wins';
    });

    await check('PERF-03', 'رمز غیردرپیش‌فرض null است و کش با hash تازه گول نمی‌خورد', () => {
      const u2 = store.get('users', 2);
      assert(auth.passwordOf(store, u2) === null, 'non-default password must yield null');
      const swapped = Object.assign({}, u2, { password_hash: pbkdf2Hash(nid2) });
      assert(auth.passwordOf(store, swapped) === nid2, 'a new hash must be computed fresh, not served from the old cache entry');
      return 'cache keyed by hash';
    });

    await check('PERF-04', 'updateDataInPlace: mutator بی‌اثر یعنی بدون نوشتن', () => {
      const before = store.getRow('users', 2).data;
      assert(store.updateDataInPlace('users', 2, () => null) === false, 'null mutator result must not write');
      assert(store.updateDataInPlace('users', 2, () => { throw new Error('boom'); }) === false, 'throwing mutator must not write');
      assert(store.getRow('users', 2).data === before, 'row bytes must be identical after no-op mutators');
      return 'no write on no-op';
    });

    await check('PERF-05', 'کلاینت/سرور: واکشی تنبل رمزها، کش ادغامی، تنفس اندپوینت', () => {
      const app = read('client/app.js');
      const pages = read('client/pages.js');
      const idx = read('server/index.js');
      assert(app.includes('async function loadCreds('), 'app.js must define lazy loadCreds');
      assert(!app.includes("S.route === 'users' && S.role === 'manager' && S.creds === undefined"), 'render() must not eagerly fetch credentials on users page');
      assert(pages.includes('await loadCreds();'), 'actUserCreds must lazily load credentials');
      assert(app.includes('_writeCacheNow') && app.includes('pagehide'), 'saveCache must coalesce writes and flush on pagehide');
      assert(/users\/credentials[\s\S]{0,1200}setImmediate/.test(idx), 'credentials endpoint must yield to the event loop between users');
      return 'static guards ok';
    });

    await negative('PERF-06a', 'بدون password_hash ⇒ null', () => {
      assert(auth.passwordOf(store, store.get('users', 3)) === null, 'user without password_hash must yield null');
    });
    await negative('PERF-06b', 'کاربر ناموجود ⇒ null و updateDataInPlace ⇒ false', () => {
      assert(auth.passwordOf(store, null) === null, 'null user must yield null');
      assert(store.updateDataInPlace('users', 9999, d => d) === false, 'missing id must return false');
    });
    await negative('PERF-06c', 'رمز پیش‌فرض با کد ملیِ کوتاه/ناموجود ساخته نمی‌شود', () => {
      const u = { id: 42, national_id: '123', password_hash: pbkdf2Hash('123') };
      assert(auth.passwordOf(store, u) === null, 'short national id must not be treated as default password');
    });
  } finally {
    try { store.close(); } catch (e) { /* noop */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { passed, failed, negatives, failures: failures.slice() };
}

module.exports = { main };
if (require.main === module) {
  main().then(r => {
    console.log(`\nUSERS-PERF ${r.failed ? 'FAILED' : 'OK'} passed=${r.passed} failed=${r.failed} negative_controls=${r.negatives}`);
    process.exit(r.failed ? 1 : 0);
  }, e => { console.error(e); process.exit(1); });
}
