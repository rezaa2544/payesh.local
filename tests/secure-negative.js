'use strict';
/* ═══════════════════════════════════════════════════════════════════
   کنترل منفی ردیف ۴۴ — «هر سه محافظ باید واقعاً ببندند»

   آزمون مثبت (tests/secure-web.js) نشان می‌دهد داده خوانده می‌شود؛ این
   فایل نشان می‌دهد در حالت‌های حمله‌ای **خوانده نمی‌شود**. اگر یکی از این
   سه رد شدن اتفاق نیفتد، یعنی محافظ تزئینی است و ردیف ۴۴ پاس نمی‌شود.
   ═══════════════════════════════════════════════════════════════════ */
require('fake-indexeddb/auto');
const secure = require('../client/secure-web');

const SECRET = 'neg-44-راز-دستگاه-۷۷۷';
const WRONG = 'neg-44-راز-اشتباه-۰۰۰';
const SENTINEL = 'نشت-نباید-دیده-شود-۴۴';

let passed = 0, failed = 0;
const results = [];
function line(id, desc, ok, detail) {
  results.push({ id, ok });
  if (ok) { passed++; console.log(`REFUSED  ${id}  ${desc}  → ${detail}`); }
  else { failed++; console.log(`LEAKED   ${id}  ${desc}  → ${detail}`); }
}

function rawDb(name) {
  return new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function rawAll(db, store) {
  return new Promise((res, rej) => { const r = db.transaction(store, 'readonly').objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function rawPut(db, store, rec) {
  return new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}

(async () => {
  const name = 'payesh_neg44_' + Date.now().toString(36);
  const s = await secure.SecureStore.open({ name, secret: SECRET });
  await s.put('attendance', 1, { note: SENTINEL, class_id: 3 });

  /* NEG-1: کلید اشتباه */
  try {
    const w = await secure.SecureStore.open({ name, secret: WRONG });
    await w.get('attendance', 1);
    line('NEG-1', 'خواندن با کلید اشتباه', false, 'plaintext returned!');
    w.close();
  } catch (e) {
    line('NEG-1', 'خواندن با کلید اشتباه', (e.code === 'decrypt_failed'), `${e.code}`);
  }

  /* NEG-2: دستکاری دادهٔ رمزشده */
  const db = await rawDb(name);
  const rec = (await rawAll(db, secure.STORE))[0];
  const bytes = new Uint8Array(rec.ct.slice(0));
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  await rawPut(db, secure.STORE, Object.assign({}, rec, { ct: bytes.buffer }));
  db.close();
  try {
    await s.get('attendance', 1);
    line('NEG-2', 'دستکاری بایت رمز', false, 'tampered row decrypted!');
  } catch (e) {
    line('NEG-2', 'دستکاری بایت رمز', (e.code === 'decrypt_failed'), `${e.code}`);
  }

  /* NEG-3: خواندن در حالت قفل */
  const s2 = await secure.SecureStore.open({ name, secret: SECRET });
  s2.lock();
  try {
    await s2.list('attendance');
    line('NEG-3', 'خواندن پس از قفل برنامه', false, 'locked store returned data!');
  } catch (e) {
    line('NEG-3', 'خواندن پس از قفل برنامه', (e.code === 'locked'), `${e.code}`);
  }

  /* NEG-4: راز کوتاه‌تر از حد ⇒ مشتق‌سازی رد می‌شود (جلوگیری از کلید بی‌آنتروپی) */
  try {
    await secure.SecureStore.open({ name: name + '_weak', secret: '1234567' });
    line('NEG-4', 'راز دستگاه کوتاه (۷ نویسه)', false, 'weak secret accepted!');
  } catch (e) {
    line('NEG-4', 'راز دستگاه کوتاه (۷ نویسه)', (e.code === 'weak_device_secret'), `${e.code}`);
  }

  s.close(); s2.close();
  console.log('');
  console.log(`NEG checks=${passed + failed} refused=${passed} leaked=${failed}`);
  if (failed === 0) console.log('NEGATIVE-44-OK');
  else { console.log('NEGATIVE-44-FAIL'); }
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.log('NEG harness error: ' + ((e && e.stack) || e)); process.exit(2); });
