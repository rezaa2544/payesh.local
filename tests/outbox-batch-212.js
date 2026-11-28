#!/usr/bin/env node
'use strict';
/* ردیف ۲۱۲ — آینهٔ صندوقچه پس از هر /api/sync: یک پاکت امضاشده به ازای هر همگام‌سازی.
   پیش‌تر: هر ردیف یک فایل بی‌امضای v1 (outbox/pending/<uid>.json) ⇒ در drain همیشه قرنطینه
   (۴ درخواست به ازای هر ردیف و هیچ‌وقت اعمال نمی‌شد). شبیه‌سازی ۲۰۵: ۹۹٫۶٪ درخواست‌های صندوقچه.
   اجرا: node --experimental-sqlite tests/outbox-batch-212.js
   خط آخر: OUTBOX-BATCH-212-OK checks=N | OUTBOX-BATCH-212-FAIL failures=N */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const s3mem = require(path.join(ROOT, 'server', 's3mem.js'));
const { openStore } = require(path.join(ROOT, 'server', 'db.js'));

let checks = 0; const failures = [];
async function check(name, fn) {
  try { await fn(); checks++; console.log('ok   ' + name); }
  catch (e) { failures.push(name); console.log('FAIL ' + name + ' — ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); }
}

/* صندوقچهٔ در حافظه که هر نوع درخواست را می‌شمارد */
const cfg = { enabled: true, endpoint: 'https://s3.test', bucket: 'b212', prefix: 'payesh/', secret: 'x'.repeat(32), accessKey: 'a' };
const objs = new Map();
const reqs = [];
const count = (method, pre = '') => reqs.filter(r => r.m === method && r.k.startsWith(pre)).length;
s3mem.ensureBucket = async () => cfg;
s3mem.usingMeta = () => ({ get: () => cfg, clear() {} });
s3mem.put = async (c, key, text) => { reqs.push({ m: 'PUT', k: key }); objs.set(key, String(text)); return { key }; };
s3mem.get = async (c, key) => { reqs.push({ m: 'GET', k: key }); if (!objs.has(key)) { const e = new Error('NoSuchKey'); e.status = 404; throw e; } return objs.get(key); };
s3mem.remove = async (c, key) => { reqs.push({ m: 'DELETE', k: key }); objs.delete(key); return { key }; };
s3mem.list = async (c, { prefix = '', max = 1000 } = {}) => {
  reqs.push({ m: 'LIST', k: prefix });
  const keys = [...objs.keys()].filter(k => k.startsWith(prefix)).sort().slice(0, max).map(key => ({ key, size: objs.get(key).length }));
  return { keys, truncated: false, token: null };
};
const outbox = require(path.join(ROOT, 'server', 'outbox.js'));
const sync = require(path.join(ROOT, 'server', 'sync.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob212-'));
const A = openStore(path.join(dir, 'a.sqlite'));
const mgr = A.insert('users', { name: 'مدیر ۲۱۲', role: 'manager', active: true, username: 'm212', phone: '09120000212' });
const actorA = { user: A.get('users', mgr.id), role: 'manager', device: { id: 'dev-office' } };
const ops = (n, tag) => Array.from({ length: n }, (_, i) => ({
  uid: 'u212-' + tag + '-' + i, collection: 'announcements', type: 'put', base_version: 0,
  data: { title: 'اطلاعیه ' + tag + ' ' + i, body: 'متن', date: '2026-11-10' },
}));
const pending = () => [...objs.keys()].filter(k => k.startsWith('payesh/outbox/pending/'));

(async () => {
  const batch = ops(30, 'a');

  await check('OB212-01 یک همگام‌سازی ۳۰ ردیفی ⇒ یک PUT (پاکت امضاشدهٔ v2، نه ۳۰ فایل بی‌امضا)', async () => {
    const pushed = sync.push(A, actorA, { ops: batch }, { device_id: 'dev-office' });
    assert.strictEqual(pushed.applied.length, 30);
    reqs.length = 0;
    const m = await outbox.mirror(A, actorA, batch, { device_id: 'dev-office' });
    assert.strictEqual(m.ok, true); assert.strictEqual(m.count, 30);
    assert.strictEqual(count('PUT'), 1, JSON.stringify(reqs));
    const files = pending();
    assert.strictEqual(files.length, 1);
    assert.match(files[0], /^payesh\/outbox\/pending\/sync-dev-office-[0-9a-z]+-[0-9a-f]{8}\.json$/);
    const env = JSON.parse(objs.get(files[0]));
    assert.strictEqual(env.v, 2); assert.strictEqual(typeof env.sig, 'string');
    assert.ok(outbox.verifyEnvelope(A, env), 'امضای همین سرور معتبر است');
    assert.strictEqual(env.items.length, 30);
    assert.deepStrictEqual(env.items.map(i => i.uid), batch.map(o => o.uid));
    assert.strictEqual(env.user_id, mgr.id);
  });

  await check('OB212-02 drain همان سرور: ثبت‌های خودش ⇒ بی نشان done/ و بی قرنطینه (۱ GET + ۱ DELETE)', async () => {
    reqs.length = 0;
    const d = await outbox.drain(A);
    assert.strictEqual(d.ok, true); assert.strictEqual(d.applied, 0); assert.strictEqual(d.rejected, 0);
    assert.strictEqual(d.seen_local, 30);
    assert.strictEqual(count('PUT'), 0, 'نه قرنطینه، نه done/: ' + JSON.stringify(reqs));
    assert.strictEqual(count('GET'), 1); assert.strictEqual(count('DELETE'), 1); assert.strictEqual(count('LIST'), 1);
    assert.deepStrictEqual(pending(), []);
    assert.strictEqual([...objs.keys()].filter(k => k.includes('/quarantine/')).length, 0);
  });

  await check('OB212-03 هزینه: قدیم ۴ درخواست به ازای هر ردیف ⇒ حالا ≤۴ به ازای هر همگام‌سازی (≥۳۰ برابر کمتر)', async () => {
    const b = ops(30, 'cost');
    sync.push(A, actorA, { ops: b }, { device_id: 'dev-office' });
    reqs.length = 0;
    await outbox.mirror(A, actorA, b, { device_id: 'dev-office' });
    await outbox.drain(A);
    const now = reqs.length;
    const before = 30 * 4;                      /* PUT + (GET + PUT قرنطینه + DELETE) هر ردیف */
    assert.ok(now <= 4, 'درخواست‌ها: ' + now + ' ' + JSON.stringify(reqs));
    assert.ok(before / now >= 30, before + ' / ' + now);
  });

  await check('OB212-04 سرور جایگزین (بازیابی از پشتیبان، همان کلید امضا): ثبت‌های نرسیده را اعمال می‌کند و done/ می‌گذارد', async () => {
    /* بازیابی پشتیبان: همان meta (کلید امضا + مستأجر) و همان کاربر، ولی بدون ثبت‌های پس از پشتیبان */
    const B = openStore(path.join(dir, 'b.sqlite'));
    const keyName = 'outbox:sign-key:' + outbox.serverTenant(A);
    B.setMeta(keyName, A.getMeta(keyName, null));
    const mB = B.insert('users', { name: 'مدیر ۲۱۲', role: 'manager', active: true, username: 'm212', phone: '09120000212' });
    assert.strictEqual(mB.id, mgr.id);
    const late = ops(5, 'late');
    sync.push(A, actorA, { ops: late }, { device_id: 'dev-office' });
    await outbox.mirror(A, actorA, late, { device_id: 'dev-office' });
    reqs.length = 0;
    const d = await outbox.drain(B);
    assert.strictEqual(d.applied, 5, JSON.stringify(d).slice(0, 300));
    assert.strictEqual(count('PUT', 'payesh/outbox/done/'), 5);
    const titles = B.all('announcements').map(r => r.title);
    for (const o of late) assert.ok(titles.includes(o.data.title), o.data.title);
    /* تکرار همان پاکت روی B: نه اعمال دوباره، نه درخواست done/ (B حالا خودش آن‌ها را دیده) */
    await outbox.mirror(A, actorA, late, { device_id: 'dev-office' });
    reqs.length = 0;
    const d2 = await outbox.drain(B);
    assert.strictEqual(d2.applied, 0); assert.strictEqual(d2.seen_local, 5);
    assert.strictEqual(count('GET', 'payesh/outbox/done/') + count('PUT', 'payesh/outbox/done/'), 0);
  });

  await check('OB212-05 همگام‌سازی بزرگ ⇒ چند پاکت (سقف ۲۰۰ ردیف/پاکت)؛ ردیف بزرگ‌تر از ۳۲KB کنار می‌رود', async () => {
    for (const k of pending()) objs.delete(k);
    const big = ops(450, 'big');
    big.push({ uid: 'u212-huge', collection: 'announcements', type: 'put', base_version: 0, data: { title: 'بزرگ', body: 'x'.repeat(40 * 1024) } });
    reqs.length = 0;
    const m = await outbox.mirror(A, actorA, big, { device_id: 'dev-office' });
    assert.strictEqual(m.count, 450);
    assert.strictEqual(count('PUT'), 3);
    const sizes = pending().map(k => JSON.parse(objs.get(k)).items.length).sort((a, b) => b - a);
    assert.deepStrictEqual(sizes, [200, 200, 50]);
    const parts = outbox.chunkItems(Array.from({ length: 40 }, (_, i) => ({ uid: 'c' + i, op: { collection: 'x', data: { t: 'y'.repeat(30 * 1024) } } })));
    assert.ok(parts.length >= 2 && parts.every(p => Buffer.byteLength(JSON.stringify(p)) <= outbox.MAX_ENVELOPE_BYTES + 32 * 1024), 'سقف حجم پاکت');
  });

  await check('OB212-06 امنیت دست‌نخورده: فایل بی‌امضای قدیمی/جعلی همچنان قرنطینه می‌شود؛ نقش غیرکادر آینه نمی‌کند', async () => {
    for (const k of pending()) objs.delete(k);
    objs.set('payesh/outbox/pending/legacy-1.json', JSON.stringify({ v: 1, uid: 'legacy-1', user_id: mgr.id, role: 'manager', op: { collection: 'announcements', type: 'put', data: { title: 'قدیمی' } } }));
    const d = await outbox.drain(A);
    assert.strictEqual(d.applied, 0); assert.strictEqual(d.untrusted, 1);
    assert.ok(objs.has('payesh/outbox/quarantine/legacy-1.json'));
    const parent = { user: { id: 99, role: 'parent' }, role: 'parent' };
    reqs.length = 0;
    const m = await outbox.mirror(A, parent, ops(3, 'p'), {});
    assert.strictEqual(m.skipped, 'role'); assert.strictEqual(reqs.length, 0);
    const none = await outbox.publish(A, [], actorA);
    assert.strictEqual(none.count, 0);
  });

  try { A.close && A.close(); } catch (e) { /* */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* */ }
  console.log(failures.length ? 'OUTBOX-BATCH-212-FAIL failures=' + failures.length : 'OUTBOX-BATCH-212-OK checks=' + checks);
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.log('FAIL fatal — ' + (e && e.stack)); console.log('OUTBOX-BATCH-212-FAIL failures=1'); process.exit(1); });
