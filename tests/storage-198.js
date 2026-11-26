#!/usr/bin/env node
'use strict';
/* ردیف ۱۹۸ — صندوقچهٔ آروان ۷٫۳۸ گیگ از ۵ گیگ: صندوقچه نسخه‌بندی دارد و هر نوشتنِ بی‌تغییر
   یک نسخهٔ تازه می‌ساخت (اندازه‌گیری واقعی: ۵۸۷هزار نسخهٔ outbox/state، ۲۱هزار رسید مدرسه،
   ۹۵هزار نسخهٔ auth/ و data/person/ پس از هر راه‌اندازی دوباره).
   اجرا: node --experimental-sqlite tests/storage-198.js */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const s3mem = require(path.join(ROOT, 'server', 's3mem.js'));
const { openStore } = require(path.join(ROOT, 'server', 'db.js'));

let passed = 0; let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); }
}

/* صندوقچهٔ جعلی در حافظه: هر put شمرده می‌شود (= یک نسخهٔ تازه در صندوقچهٔ نسخه‌بندی‌شده) */
const cfg = { enabled: true, endpoint: 'https://s3.test', bucket: 'b198', prefix: 'payesh/', secret: 'x'.repeat(32), access_key: 'a', secret_key: 's' };
const puts = [];
const objs = new Map();
s3mem.put = async (c, key, text) => { puts.push(key); objs.set(key, text); return { ok: true }; };
s3mem.get = async (c, key) => objs.get(key) || null;
s3mem.ensureBucket = async () => cfg;
const realUsing = s3mem.usingMeta;
s3mem.usingMeta = () => ({ get: () => cfg, clear() {} });
const fresh = (mod) => { delete require.cache[require.resolve(path.join(ROOT, 'server', mod))]; return require(path.join(ROOT, 'server', mod)); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st198-'));
const st = openStore(path.join(dir, 'db.sqlite'));
const s1 = st.insert('users', { name: 'دانش‌آموز ۱', role: 'student', active: true });
st.insert('users', { name: 'دانش‌آموز ۲', role: 'student', active: true });
st.insert('users', { name: 'مدیر', role: 'manager', active: true, username: 'm1', phone: '09120000000' });
const count = (pre) => puts.filter(k => k.startsWith(pre)).length;

(async () => {
  let outbox = fresh('outbox.js');

  await check('ST198-01 خلاصهٔ دانش‌آموز (outbox/state): بی‌تغییر ⇒ نوشته نمی‌شود، حتی با «at» تازه', async () => {
    puts.length = 0;
    let r = await outbox.pushSnapshot(st);
    assert.strictEqual(r.count, 2);
    for (let i = 0; i < 20; i++) {             /* ۲۰ دور (یک ساعت با دورهای ۳ دقیقه‌ای) */
      await new Promise(z => setTimeout(z, 2));
      r = await outbox.pushSnapshot(st);
      assert.strictEqual(r.count, 0, 'دور ' + i);
    }
    assert.strictEqual(count('payesh/outbox/state/'), 2);
    st.insert('attendance', { student_id: s1.id, status: 'absent', date: '1405-09-06' });
    r = await outbox.pushSnapshot(st);
    assert.strictEqual(r.count, 1, 'فقط همان دانش‌آموز');
    assert.strictEqual(count('payesh/outbox/state/'), 3);
  });

  await check('ST198-02 اثر انگشت‌ها ماندگارند: راه‌اندازی دوبارهٔ سرور ⇒ auth/ و data/ از نو نوشته نمی‌شوند', async () => {
    await outbox.publishAll(st);
    outbox.flushHashes();
    const before = puts.length;
    outbox = fresh('outbox.js');               /* = راه‌اندازی دوباره (حافظه خالی) */
    await outbox.publishAll(st);
    await outbox.pushSnapshot(st);
    assert.strictEqual(puts.length, before, 'هیچ نوشتن تازه‌ای: ' + puts.slice(before).join(','));
    /* «بازنشانی اتصال دیتابیس» ⇒ همه از نو (صندوقچهٔ تازه باید کامل شود) */
    outbox.forgetPutHashes();
    await outbox.publishAll(st);
    assert.ok(puts.length > before);
  });

  await check('ST198-03 رسید مدرسه (schools/ack): بی‌تغییر فقط هر ۱۰ دقیقه؛ تغییر یا «force» ⇒ همان دم', async () => {
    const sr = fresh('school-registry.js');
    st.setMeta('schools:bound', { school_id: 's-198', instance: 'i-1' });
    puts.length = 0;
    const t0 = Date.UTC(2026, 10, 26, 10);
    assert.strictEqual(await sr.writeAck(st, { instance: 'i-1', now: t0 }), true);
    for (let m = 1; m < 10; m++) assert.strictEqual(await sr.writeAck(st, { instance: 'i-1', now: t0 + m * 60_000 }), false, 'دقیقهٔ ' + m);
    assert.strictEqual(count('payesh/schools/ack/'), 1);
    assert.strictEqual(await sr.writeAck(st, { instance: 'i-1', now: t0 + 10 * 60_000 }), true, 'زنده بودن پس از ۱۰ دقیقه');
    st.insert('users', { name: 'دبیر', role: 'teacher', active: true });
    assert.strictEqual(await sr.writeAck(st, { instance: 'i-1', now: t0 + 11 * 60_000 }), true, 'تغییر ⇒ همان دم');
    assert.strictEqual(await sr.writeAck(st, { instance: 'i-1', now: t0 + 12 * 60_000, force: true }), true, 'پذیرش مدرسه ⇒ همیشه');
    assert.strictEqual(count('payesh/schools/ack/'), 4);
    /* پیش‌تر: ۶۰ دقیقه ⇒ ۶۰ نسخه؛ حالا ≤ ۶ + تغییرها */
    let n = 0;
    for (let m = 13; m < 73; m++) if (await sr.writeAck(st, { instance: 'i-1', now: t0 + m * 60_000 })) n++;
    assert.ok(n <= 6, 'یک ساعت بی‌تغییر: ' + n);
  });

  await check('ST198-04 پنل مالک «سرور وصل» را تا ۲۵ دقیقه نشان می‌دهد (هماهنگ با رسید ۱۰ دقیقه‌ای)', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'apps/payesh/owner/lib/src/schools/schools_section.dart'), 'utf8');
    assert.match(src, /difference\(at\) < const Duration\(minutes: 25\)/);
  });

  await check('ST198-05 پشتیبان مالک: updates/ بیرون؛ دیتابیس روزی یک بار؛ ETag ماندگار', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'apps/payesh/owner/lib/src/backup/backup_engine.dart'), 'utf8');
    const store = fs.readFileSync(path.join(ROOT, 'apps/payesh/owner/lib/src/backup/backup_store.dart'), 'utf8');
    assert.match(store, /updates\|helpers\|jobs\|realtime/);
    assert.match(src, /dbEvery = Duration\(hours: 24\)/);
    assert.match(src, /'db_etag'/);
    assert.match(src, /backupSkipsKey\(o\.key\)/);
  });

  s3mem.usingMeta = realUsing;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`STORAGE-198 passed=${passed}/${passed + failed}`);
  process.exit(failed ? 1 : 0);
})();
