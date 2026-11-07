'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون لایهٔ امن دادهٔ روی دستگاه — ردیف ۴۴  (SE-01 .. SE-12)

   آنچه سنجیده می‌شود: رمزبودن داده در حالت سکون، شکست خواندن با کلید
   اشتباه، قفل برنامه، نابودی کلید در wipe، چرخش راز، و اینکه هیچ‌جای
   دیتابیس راز/کلید خام نمی‌نشیند.

   آنچه این‌جا سنجیده نمی‌شود (و نباید ادعا شود): مقاومت در برابر
   malware/root روی همان دستگاه و عکس‌برداری از حافظهٔ فرایند.
   ═══════════════════════════════════════════════════════════════════ */
require('fake-indexeddb/auto');
const secure = require('../client/secure-web');

const SECRET = 'dev-secret-44-الف-۸۴۲۱';
const WRONG = 'dev-secret-44-ب-۹۹۹۹';
const SENTINEL = 'محرمانه-۴۴-حضور-غیاب';

let passed = 0, failed = 0; const failures = [];
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 240)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
async function throwsCode(fn, code) {
  try { await fn(); } catch (e) { if ((e && e.code) === code) return e.code; throw new Error('wrong error: ' + ((e && e.code) || e.message)); }
  throw new Error('did not throw (expected ' + code + ')');
}

function rawDb(name) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function rawAll(db, store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function rawPut(db, store, rec) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(rec);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}

(async () => {
  const dbName = 'payesh_se_test_' + Date.now().toString(36);
  let s = await secure.SecureStore.open({ name: dbName, secret: SECRET });

  await check('SE-01', 'open با راز دستگاه + put/get رمزگذاری‌شده', async () => {
    assert(!s.isLocked(), 'should be unlocked');
    await s.put('attendance', 1, { class_id: 7, note: SENTINEL, status: 'present' }, { version: 2 });
    const row = await s.get('attendance', 1);
    assert(row && row.data.note === SENTINEL, 'roundtrip failed');
    assert(row.version === 2, 'version lost');
    return `kdf=${s.meta.kdf} iter=${s.meta.iterations} version=${row.version}`;
  });

  await check('SE-02', 'در حالت سکون هیچ متن روشنی از payload روی دیسک نیست', async () => {
    await s.putMany([
      { collection: 'grades', id: 2, data: { student_id: 11, score: 18.5, note: SENTINEL } },
      { collection: 'users', id: 3, data: { name: SENTINEL, role: 'teacher' } },
    ]);
    const db = await rawDb(dbName);
    const recs = await rawAll(db, secure.STORE);
    const dump = JSON.stringify(recs.map(r => ({ k: r.k, collection: r.collection, updated_at: r.updated_at, iv: Array.from(new Uint8Array(r.iv)), ct: Array.from(new Uint8Array(r.ct)) })));
    assert(dump.indexOf('محرمانه') === -1, 'plaintext leaked into at-rest records');
    assert(dump.indexOf('present') === -1, 'plaintext enum leaked');
    assert(recs.every(r => r.iv && r.ct && r.iv.byteLength === 12), 'iv/ct missing or wrong size');
    db.close();
    return `records=${recs.length} bytes≈${Math.round(dump.length / 1024)}KB iv=12 ct>0 plaintext=absent`;
  });

  await check('SE-03', 'استخراج داده با کلید نادرست = شکست (بدون استثنای بی‌صدا)', async () => {
    const wrong = await secure.SecureStore.open({ name: dbName, secret: WRONG });
    const code = await throwsCode(() => wrong.get('attendance', 1), 'decrypt_failed');
    wrong.close();
    return `${code} (GCM auth) rows_readable=0`;
  });

  await check('SE-04', 'کلید مشتق‌شده non-extractable است (بایت خام کلید بیرون نمی‌آید)', async () => {
    const key = s.key;
    let rejected = false;
    try { await crypto.subtle.exportKey('raw', key); } catch (e) { rejected = true; }
    assert(rejected, 'key was exportable!');
    assert(key.extractable === false, 'extractable flag not false');
    return `extractable=${key.extractable} export=rejected`;
  });

  await check('SE-05', 'قفل برنامه: کلید از حافظه می‌رود و خواندن تا unlock ناممکن است', async () => {
    s.lock();
    assert(s.isLocked(), 'not locked');
    const code = await throwsCode(() => s.get('attendance', 1), 'locked');
    await s.unlock(SECRET);
    const row = await s.get('attendance', 1);
    assert(row && row.data.note === SENTINEL, 'unlock did not restore');
    return `${code} → unlock ok locks=${s.locks}`;
  });

  await check('SE-06', 'list/since/byRef روی دادهٔ رمزشده درست کار می‌کنند', async () => {
    const t0 = new Date(Date.UTC(2026, 10, 1)).toISOString();
    await s.putMany([
      { collection: 'attendance', id: 10, data: { class_id: 7, student_id: 11 }, updated_at: t0 },
      { collection: 'attendance', id: 11, data: { class_id: 8, student_id: 12 }, updated_at: '2026-11-20T00:00:00.000Z' },
      { collection: 'attendance', id: 12, data: { class_id: 7, student_id: 13 }, updated_at: '2026-11-21T00:00:00.000Z' },
    ]);
    const list = await s.list('attendance', { limit: 10 });
    assert(list.length >= 4, `list=${list.length}`);
    const ref = await s.byRef('attendance', 'class_id', 7);
    assert(ref.length >= 2, `byRef=${ref.length}`);
    const ch = await s.since('attendance', '2026-11-15T00:00:00.000Z');
    assert(ch.length === 2, `since=${ch.length}`);
    const all = await s.listAll('grades');
    assert(all.length === 1, `grades=${all.length}`);
    return `list=${list.length} byRef=${ref.length} since=${ch.length}`;
  });

  await check('SE-07', 'دستکاری بایت رمزنگاری‌شده تشخیص داده می‌شود (بدون خرابی بی‌صدا)', async () => {
    const db = await rawDb(dbName);
    const recs = await rawAll(db, secure.STORE);
    const target = recs.find(r => r.k === 'attendance:1');
    assert(target, 'target record missing');
    const bytes = new Uint8Array(target.ct.slice(0));
    bytes[0] = bytes[0] ^ 0xff;
    await rawPut(db, secure.STORE, Object.assign({}, target, { ct: bytes.buffer }));
    const code = await throwsCode(() => s.get('attendance', 1), 'decrypt_failed');
    /* بازگرداندن رکورد سالم تا آزمون‌های بعدی روی دادهٔ دست‌نخورده اجرا شوند */
    await rawPut(db, secure.STORE, target);
    await new Promise(res => { db.onclose = res; db.close(); res(); });
    const restored = await s.get('attendance', 1);
    assert(restored && restored.data.note === SENTINEL, 'restore failed');
    return `${code} tamper_detected=true restored=ok`;
  });

  await check('SE-08', 'چرخش راز: ردیف‌ها حفظ، راز قدیمی بی‌اثر، راز تازه کارگر', async () => {
    const next = 'dev-secret-44-گردش-۵۵۵۵';
    const r = await s.rotate(next);
    const ok = await s.get('grades', 2);
    assert(ok && ok.data.score === 18.5, 'rows lost after rotate');
    const old = await secure.SecureStore.open({ name: dbName, secret: SECRET });
    await throwsCode(() => old.get('grades', 2), 'decrypt_failed');
    old.close();
    const again = await secure.SecureStore.open({ name: dbName, secret: next });
    const back = await again.get('grades', 2);
    assert(back && back.data.score === 18.5, 'new secret cannot read');
    again.close();
    return `rotated=${r.rows} old=rejected new=ok`;
  });

  await check('SE-09', 'پاک‌سازی یک کالکشن، بقیه را دست نمی‌زند', async () => {
    const before = await s.count(null);
    const c = await s.clear('attendance');
    const after = await s.count(null);
    assert(after === before - c.rows, `before=${before} cleared=${c.rows} after=${after}`);
    assert((await s.count('grades')) === 1, 'grades wiped by mistake');
    return `cleared=${c.rows} remaining=${after}`;
  });

  await check('SE-10', 'wipe: نابودی کلید و نمک + صفرشدن ردیف‌ها + بازگشایی ناممکن', async () => {
    const w = await s.wipe('test_wipe');
    assert(w.key_destroyed && w.salt_destroyed, 'key/salt not destroyed');
    assert((await s.count(null)) === 0, 'rows survived wipe');
    assert(s.isLocked(), 'store still unlocked after wipe');
    const db = await rawDb(dbName);
    const meta = await rawAll(db, secure.META);
    db.close();
    assert(meta.length === 0, 'kdf meta survived wipe');
    const reopen = await secure.SecureStore.open({ name: dbName, secret: SECRET });
    assert((await reopen.count(null)) === 0, 'data came back after reopen');
    reopen.close();
    return `rows_deleted=${w.rows_deleted} meta=0 reopen_rows=0`;
  });

  await check('SE-11', 'ابطال دستگاه ⇒ wipe با شاهد قابل‌حسابرسی (بدون ACK کاذب)', async () => {
    const s2 = await secure.SecureStore.open({ name: dbName, secret: SECRET });
    await s2.put('users', 77, { name: SENTINEL, role: 'student' });
    const seen = [];
    const out = await s2.handleRevocation({ reason: 'device_revoked', notify: w => seen.push(w.reason) });
    assert(out.wiped && out.reason === 'device_revoked', 'bad evidence');
    assert(seen.length === 1 && seen[0] === 'device_revoked', 'notify not called');
    assert((await s2.count(null)) === 0, 'data survived revocation');
    s2.close();
    return `reason=${out.reason} rows_deleted=${out.rows_deleted} notified=${seen.length}`;
  });

  await check('SE-12', 'راز دستگاه نه در دیتابیس و نه در متادیتا ذخیره نمی‌شود', async () => {
    const s3 = await secure.SecureStore.open({ name: dbName, secret: SECRET });
    await s3.put('users', 5, { name: 'معلم', role: 'teacher' });
    const db = await rawDb(dbName);
    const meta = await rawAll(db, secure.META);
    const recs = await rawAll(db, secure.STORE);
    db.close();
    const dump = JSON.stringify({ meta, recs: recs.map(r => ({ k: r.k, iv: Array.from(new Uint8Array(r.iv)), ct: Array.from(new Uint8Array(r.ct)) })) });
    assert(dump.indexOf(SECRET) === -1, 'secret stored on disk!');
    assert(!/"secret"|"key"\s*:\s*\{|"passphrase"/.test(dump), 'raw key/passphrase field present');
    const metaKeys = Object.keys(meta[0] || {});
    assert(metaKeys.includes('salt') && !metaKeys.includes('secret'), `meta keys=${metaKeys.join(',')}`);
    s3.close();
    return `meta=${metaKeys.join(',')} secret_on_disk=no`;
  });

  s.close();
  console.log('');
  console.log(`SE checks=${passed + failed} pass=${passed} fail=${failed}`);
  if (failed === 0) console.log('DEVICE-SECURE-OK');
  else { console.log('failed: ' + failures.join(',')); console.log('DEVICE-SECURE-FAIL'); }
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.log('SE harness error: ' + ((e && e.stack) || e)); process.exit(2); });
