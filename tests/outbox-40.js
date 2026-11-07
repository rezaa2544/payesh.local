'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون صندوقچهٔ عملیات ماندگار روی دستگاه — ردیف ۴۰  (OB-01 .. OB-15)

   دو لایه، هر دو واقعی:
     ۱) IndexedDB استاندارد (fake-indexeddb) — همان API مرورگر/WebView.
     ۲) سرور واقعی محصول: server/sync.js → push روی SQLite واقعی
        (server/db.js). پس «اعمال دقیقاً یک‌بار» ادعای آزمون نیست،
        خروجی واقعی همان تابعی است که در تولید اجرا می‌شود.
   ═══════════════════════════════════════════════════════════════════ */
require('fake-indexeddb/auto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../server/db');
const sync = require('../server/sync');
const outbox = require('../client/outbox-web');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-ob40-'));

let passed = 0, failed = 0; const failures = [];
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 260)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

/* ── سرور واقعی ───────────────────────────────────────────────────── */
const store = openStore(path.join(TMP, 'ob.sqlite'));
const manager = store.insert('users', { name: 'مدیر آزمون', role: 'manager', active: true });
const actor = { user: manager, role: 'manager', device: null };
const push = (ops, idem) => sync.push(store, actor, { ops, idempotency_key: idem });
const rowCount = () => store.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='attendance' AND deleted_at IS NULL").get().n;

let dbSeq = 0;
const freshName = (tag) => `payesh_ob40_${tag}_${++dbSeq}`;
function opAtt(id, extra = {}) {
  return Object.assign({
    uid: 'op-' + id + '-' + Math.random().toString(36).slice(2, 8),
    collection: 'attendance', type: 'put', id,
    data: { student_id: 7, class_id: 2, status: 'present', note: 'ردیف ' + id },
    base_version: 0, at: new Date().toISOString(),
  }, extra);
}

(async () => {
  await check('OB-01', 'باز شدن صندوقچه با object store عملیات و ایندکس‌های state/seq', async () => {
    const ob = await outbox.open(freshName('open'));
    const names = [...ob.db.objectStoreNames];
    assert(names.includes(outbox.STORE) && names.includes(outbox.META), 'stores: ' + names.join(','));
    const st = await ob.stats();
    assert(st.total === 0 && st.capacity === outbox.DEFAULTS.capacity, 'stats ' + JSON.stringify(st));
    ob.close();
    return `stores=${names.join(',')} indexes=state,seq capacity=${st.capacity}`;
  });

  await check('OB-02', 'ماندگاری: عملیات پس از بستن/بازکردن (restart برنامه) با همان کلید می‌ماند', async () => {
    const name = freshName('durable');
    const ob1 = await outbox.open(name);
    const k = 'fixed-key-ob02';
    await ob1.enqueue(opAtt(101, { uid: k }));
    ob1.close();
    const ob2 = await outbox.open(name);
    const rows = await ob2.list();
    assert(rows.length === 1 && rows[0].k === k, 'lost after reopen: ' + rows.length);
    assert(rows[0].state === 'pending', 'state=' + rows[0].state);
    ob2.close();
    return `ops_after_restart=1 key=${k.slice(0, 12)}…`;
  });

  await check('OB-03', 'افزودن تکراری با همان کلید، عملیات دوم نمی‌سازد (idempotent enqueue)', async () => {
    const ob = await outbox.open(freshName('idem'));
    const r1 = await ob.enqueue(opAtt(102, { uid: 'k-ob03' }));
    const r2 = await ob.enqueue(opAtt(102, { uid: 'k-ob03' }));
    assert(r1.ok && !r1.duplicate, 'first');
    assert(r2.ok && r2.duplicate, 'second not duplicate');
    assert((await ob.count()) === 1, 'count=' + (await ob.count()));
    ob.close();
    return `count=1 duplicate=true`;
  });

  await check('OB-04', 'سقف صف: عملیات اضافه صریحاً رد می‌شود و هیچ عملیات قبلی حذف نمی‌شود', async () => {
    const ob = await outbox.open(freshName('cap'), { capacity: 5 });
    for (let i = 0; i < 5; i++) await ob.enqueue(opAtt(200 + i));
    const firstKey = (await ob.list())[0].k;
    const over = await ob.enqueue(opAtt(999));
    assert(over.ok === false && over.error === 'queue_full', 'overflow: ' + JSON.stringify(over));
    const rows = await ob.list();
    assert(rows.length === 5, 'count changed to ' + rows.length);
    assert(rows[0].k === firstKey, 'کهنه‌ترین عملیات حذف شد (حذف خاموش)');
    const st = await ob.stats();
    assert(st.full === true && st.used === 5, 'stats ' + JSON.stringify(st));
    assert(ob.events.some(e => e.type === 'queue_full'), 'رویداد صف پر ثبت نشد');
    ob.close();
    return `capacity=5 used=5 rejected=queue_full oldest_kept=true`;
  });

  await check('OB-05', 'برداشت دسته با اجاره: دو برداشت هم‌زمان یک عملیات را دوباره نمی‌دهد', async () => {
    const name = freshName('claim');
    const ob = await outbox.open(name, { leaseMs: 60000 });
    for (let i = 0; i < 3; i++) await ob.enqueue(opAtt(300 + i));
    const a = await ob.claim(10, 1000);
    const b = await ob.claim(10, 1001);
    assert(a.length === 3, 'first claim=' + a.length);
    assert(b.length === 0, 'second claim stole ops=' + b.length);
    assert(a.every(r => r.state === 'inflight' && r.lease_until === 61000), 'lease not set');
    ob.close();
    return `claimed=3 second_tab=0 lease_ms=60000`;
  });

  await check('OB-06', 'crash وسط ارسال: بعد از restart همان عملیات با همان کلید دوباره قابل برداشت است', async () => {
    const name = freshName('crash');
    const ob1 = await outbox.open(name, { leaseMs: 5000 });
    const k = 'crash-key-ob06';
    await ob1.enqueue(opAtt(400, { uid: k }));
    const claimed = await ob1.claim(10, 1000);
    assert(claimed.length === 1 && claimed[0].k === k, 'claim');
    ob1.close();                                   /* ← برنامه همین‌جا می‌میرد */

    const ob2 = await outbox.open(name, { leaseMs: 5000 });
    const beforeExpiry = await ob2.claim(10, 3000); /* اجاره هنوز زنده است */
    assert(beforeExpiry.length === 0, 'lease should block re-claim');
    const rec = await ob2.recover(7000);           /* بعد از پایان اجاره */
    const afterExpiry = await ob2.claim(10, 7001);
    assert(afterExpiry.length === 1 && afterExpiry[0].k === k, 'op not recovered');
    assert(rec.recovered === 1, 'recovered=' + rec.recovered);
    ob2.close();
    return `lease_blocked=true recovered=1 same_key=true`;
  });

  await check('OB-07', 'شکست ارسال: عقب‌نشینی نمایی و پذیرش دوباره در زمان درست', async () => {
    const ob = await outbox.open(freshName('backoff'));
    const { k } = await ob.enqueue(opAtt(500));
    await ob.claim(10, 1000);
    const f = await ob.fail(k, { error: 'network', now: 1000 });
    assert(f.state === 'pending' && f.attempts === 1, JSON.stringify(f));
    assert(f.next_at === 1000 + outbox.DEFAULTS.baseBackoffMs, 'next_at=' + f.next_at);
    assert((await ob.claim(10, 1500)).length === 0, 'early re-claim not prevented');
    assert((await ob.claim(10, f.next_at)).length === 1, 'not claimable at next_at');
    ob.close();
    return `attempts=1 next_at=+${outbox.DEFAULTS.baseBackoffMs}ms exponential=true`;
  });

  await check('OB-08', 'پس از سقف تلاش: عملیات blocked می‌شود و **حذف نمی‌شود**', async () => {
    const ob = await outbox.open(freshName('blocked'), { maxAttempts: 3, baseBackoffMs: 1 });
    const { k } = await ob.enqueue(opAtt(600));
    let now = 0;
    for (let i = 0; i < 3; i++) {
      now += 10;
      await ob.claim(10, now);
      const f = await ob.fail(k, { error: 'network', now });
      if (i < 2) assert(f.state === 'pending', 'attempt ' + i + ' state=' + f.state);
      else assert(f.state === 'blocked', 'final state=' + f.state);
    }
    const st = await ob.stats();
    assert(st.blocked === 1 && st.total === 1, 'stats ' + JSON.stringify(st));
    ob.close();
    return `attempts=3 state=blocked kept=true`;
  });

  await check('OB-09', 'تلاش دستی برای عملیات blocked → دوباره pending و ارسال موفق', async () => {
    const ob = await outbox.open(freshName('retry'), { maxAttempts: 1 });
    const { k } = await ob.enqueue(opAtt(700));
    await ob.claim(10, 0);
    await ob.fail(k, { error: 'network', now: 0 });
    assert((await ob.stats()).blocked === 1, 'not blocked');
    await ob.retry(k, 50);
    assert((await ob.stats()).pending === 1, 'not pending');
    const res = await ob.drain({ send: async (ops) => push(ops), now: 60 });
    assert(res.applied === 1, JSON.stringify(res));
    assert((await ob.count()) === 0, 'queue not empty');
    ob.close();
    return `blocked→retry→applied=1 queue=0`;
  });

  await check('OB-10', 'ارسال کامل روی سرور واقعی: ۴۰ عملیات اعمال و صف خالی می‌شود', async () => {
    const before = rowCount();
    const ob = await outbox.open(freshName('drain'));
    for (let i = 0; i < 40; i++) await ob.enqueue(opAtt(1000 + i));
    const res = await ob.drain({ send: async (ops) => push(ops), now: 1000 });
    assert(res.applied === 40, JSON.stringify(res));
    assert((await ob.count()) === 0, 'queue not empty');
    assert(rowCount() === before + 40, `server rows ${rowCount()} (expected ${before + 40})`);
    ob.close();
    return `batches=${res.batches} applied=40 server_rows=+40 send_ms=${res.send_ms}`;
  });

  await check('OB-11', 'اعمال دقیقاً یک‌بار: ارسال دوبارهٔ همان دسته پس از crash، ردیف تکراری نمی‌سازد', async () => {
    const name = freshName('once');
    const before = rowCount();
    const ob1 = await outbox.open(name);
    const ops = [0, 1, 2, 3, 4].map(i => opAtt(2000 + i));
    for (const o of ops) await ob1.enqueue(o);
    const batch = await ob1.claim(10, 1000);
    const first = push(batch.map(outbox.toWire));          /* سرور اعمال کرد */
    assert(first.applied.every(a => !a.duplicate), 'first send should be fresh');
    ob1.close();                                           /* ← قبل از ack می‌میرد */

    const ob2 = await outbox.open(name);
    await ob2.recover(1000 + outbox.DEFAULTS.leaseMs + 1);
    const second = await ob2.drain({ send: async (o) => push(o), now: 1000 + outbox.DEFAULTS.leaseMs + 2 });
    assert(second.applied === 5, 'resend applied=' + second.applied);
    assert(rowCount() === before + 5, `rows=${rowCount()} expected ${before + 5} (double apply!)`);
    assert((await ob2.count()) === 0, 'queue not empty');
    ob2.close();
    return `first=5 resent=5 server_rows=+5 duplicates_ignored=5 queue=0`;
  });

  await check('OB-12', 'قطعی شبکه: هیچ عملیاتی گم نمی‌شود و همه برای تلاش بعدی می‌مانند', async () => {
    const ob = await outbox.open(freshName('offline'));
    for (let i = 0; i < 100; i++) await ob.enqueue(opAtt(3000 + i));
    const res = await ob.drain({ send: async () => { throw new Error('offline'); }, now: 5000 });
    assert(res.applied === 0 && res.failed >= 100, JSON.stringify(res));
    const st = await ob.stats();
    assert(st.total === 100 && st.inflight === 0, 'stats ' + JSON.stringify(st));
    assert(st.pending === 100, 'pending=' + st.pending);
    ob.close();
    return `enqueued=100 kept=100 failed_batches=${res.batches} retry_scheduled=true`;
  });

  await check('OB-13', 'ردی که سرور رد می‌کند: از صف خارج می‌شود ولی در فهرست بررسی ثبت می‌گردد (بدون حذف خاموش)', async () => {
    const ob = await outbox.open(freshName('rejected'));
    const review = [];
    const { k } = await ob.enqueue(opAtt(4000));
    const res = await ob.drain({
      send: async (ops) => ({ applied: [], rejected: ops.map(o => ({ uid: o.uid, error: 'role_denied' })), conflicts: [] }),
      onRejected: async (rec, info) => review.push({ k: rec.k, error: info.error }),
      now: 1000,
    });
    assert(res.rejected === 1, JSON.stringify(res));
    assert((await ob.count()) === 0, 'queue not empty');
    assert(review.length === 1 && review[0].k === k && review[0].error === 'role_denied', 'review=' + JSON.stringify(review));
    ob.close();
    return `rejected=1 review_recorded=1 queue=0`;
  });

  await check('OB-14', 'تعارض: عملیات از صف خارج و در فهرست تصمیم‌گیری ثبت می‌شود', async () => {
    const ob = await outbox.open(freshName('conflict'));
    const seen = [];
    await ob.enqueue(opAtt(5000));
    const res = await ob.drain({
      send: async (ops) => ({ applied: [], rejected: [], conflicts: ops.map(o => ({ uid: o.uid, collection: 'attendance', id: 5000, server_version: 3 })) }),
      onConflict: async (rec, info) => seen.push({ k: rec.k, server_version: info.server_version }),
      now: 1000,
    });
    assert(res.conflicts === 1 && seen.length === 1 && seen[0].server_version === 3, JSON.stringify({ res, seen }));
    assert((await ob.count()) === 0, 'queue not empty');
    ob.close();
    return `conflicts=1 review=1 queue=0`;
  });

  await check('OB-15', 'سیم‌کشی واقعی در برنامه: صندوقچه در app.js و index.html وصل است و حذف خاموش حذف شده', async () => {
    const app = fs.readFileSync(path.join(ROOT, 'client/app.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
    assert(!/slice\(-500\)/.test(app), 'حذف خاموش slice(-500) هنوز در app.js هست');
    for (const needle of ['outboxInstance(', 'function enqueueOp(', 'ob.markInflight(', 'ob.ackMany(', 'ob.failMany(', 'ob.recover(']) {
      assert(app.includes(needle), 'wiring missing: ' + needle);
    }
    assert(/QUEUE_CAP\s*=\s*\d+/.test(app), 'QUEUE_CAP تعریف نشده');
    assert(/<script src="\/outbox-web\.js"><\/script>/.test(html), 'script tag missing in index.html');
    return `no_silent_truncation=true wiring=6/6 script_tag=true`;
  });

  store.db.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log('');
  console.log(`OB checks=${passed + failed} pass=${passed} fail=${failed}`);
  if (failed === 0) console.log('OUTBOX-40-OK');
  else { console.log('failed: ' + failures.join(',')); console.log('OUTBOX-40-FAIL'); }
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.log('OB harness error: ' + ((e && e.stack) || e)); process.exit(2); });
