'use strict';
// آزمون خودکار نمونهٔ ۱۸ — صف آفلاین، کش امن، ابطال دستگاه
// اجرا: node prototype/slice-18/tests/run.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QueueServer } = require('../server-side');
const { Clock, SecureCache, OpQueue, MAX_OPS } = require('../client-queue');

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ' — ' + detail}`);
}

const session = (over = {}) => ({ user_id: 'u-1', tenant_id: 'tenant-a', role: 'teacher', revoked: false, ...over });
const TENANT_B = 'tenant-b';

async function main() {
  // ---------- ۱) سقف ۲۰۰۰ و بدون حذف (D‑27 / F‑07) ----------
  {
    const clock = new Clock();
    const q = new OpQueue({ clock, cache: new SecureCache({ clock }).open('tenant-a') });
    for (let i = 0; i < 1800; i++) q.enqueue({ collection: 'records', record_id: 'r1', payload: { i } });
    check('۱۸۰۰ op ⇒ هشدار نرم ۹۰٪ فعال', q.pressure.warn === true && q.pressure.full === false);
    const firstId = [...q.rows.keys()][0];
    for (let i = 0; i < 200; i++) q.enqueue({ collection: 'records', record_id: 'r1', payload: { i: 1800 + i } });
    check('۲۰۰۰ op ⇒ پذیرش متوقف (full)', q.pressure.full === true && q.size === MAX_OPS);
    const overflow = q.enqueue({ collection: 'records', record_id: 'r1', payload: { x: 1 } });
    check('op ۲۰۰۱ رد می‌شود (queue_full)، نه حذف قدیمی', overflow.ok === false && overflow.reason === 'queue_full' && q.size === MAX_OPS);
    check('قدیمی‌ترین op هنوز در صف است (هیچ slice(-500))', q.rows.has(firstId));
  }

  // ---------- ۲) اعمال idempotent و ترتیب ----------
  {
    const clock = new Clock();
    const server = new QueueServer({ now: () => clock.now() });
    const cache = new SecureCache({ clock }).open('tenant-a');
    const q = new OpQueue({ clock, cache });
    q.enqueue({ collection: 'records', record_id: 'r1', payload: { n: 1 }, base_version: 0 });
    await q.flush(server, session());
    check('op اول applied و نسخهٔ رکورد ۱ شد', q.byStatus('applied').length === 1 && server.record('tenant-a', 'records', 'r1').version === 1);

    // ack گم‌شده: همان op دوباره ارسال می‌شود (بازپخش) ⇒ بی‌اثر
    const op = q.byStatus('applied')[0];
    op.status = 'ack_unknown';
    const replay = await q.flush(server, session());
    check('بازپخش همان op_id ⇒ applied بدون افزایش نسخه', replay.results[0].replay === true && server.record('tenant-a', 'records', 'r1').version === 1);

    // ترتیب: base_version جلوتر از سرور
    q.enqueue({ collection: 'records', record_id: 'r2', payload: { n: 2 }, base_version: 3 });
    await q.flush(server, session());
    check('base_version جلوتر ⇒ 409 ordering و ماندن در retry_wait (نه دور ریختن)', q.byStatus('retry_wait').length === 1 && q.byStatus('retry_wait')[0].last_result.code === 409);

    // تعارض واقعی: base_version عقب‌تر
    q.enqueue({ collection: 'records', record_id: 'r1', payload: { n: 9 }, base_version: 0 });
    await q.flush(server, session());
    check('base_version عقب‌تر ⇒ conflict (نیازمند تصمیم)، نه اعمال و نه حذف', q.byStatus('conflict').length === 1);

    // دست‌کاری payload
    q.enqueue({ collection: 'records', record_id: 'r3', payload: { n: 3 } });
    const tampered = [...q.rows.values()].find((o) => o.payload && o.payload.n === 3);
    tampered.payload = { n: 999 };
    await q.flush(server, session());
    check('payload_hash ناهم‌خوان ⇒ rejected', tampered.status === 'rejected' && tampered.last_result.reason === 'payload_hash_mismatch');
  }

  // ---------- ۳) هویت فقط از نشست (F‑06) ----------
  {
    const clock = new Clock();
    const server = new QueueServer({ now: () => clock.now() });
    const q = new OpQueue({ clock, cache: new SecureCache({ clock }).open('tenant-a') });
    q.enqueue({ collection: 'records', record_id: 'x1', payload: { v: 1 } });
    const op = [...q.rows.values()][0];
    const wire = { ...q.toWire(op), tenant_id: TENANT_B };
    const res = server.push(session(), [wire]);
    check('tenant_id بدنه نادیده گرفته می‌شود؛ رکورد در مستأجر نشست ساخته می‌شود',
      res.results[0].status === 'applied' &&
      server.record('tenant-a', 'records', 'x1').version === 1 &&
      server.record(TENANT_B, 'records', 'x1').version === 0);
    const noSession = server.push(null, [wire]);
    check('بدون نشست ⇒ 401 حتی با sig معتبر دستگاهی', noSession.status === 401);
  }

  // ---------- ۴) قاعدهٔ ۳۰ روز ⇒ review با حفظ کامل payload ----------
  {
    let mono = 1_000_000;
    let serverNow = 1_700_000_000_000;
    const clock = new Clock({ localNow: () => serverNow, monoNow: () => mono });
    const server = new QueueServer({ now: () => clock.now() });
    const q = new OpQueue({ clock, cache: new SecureCache({ clock }).open('tenant-a') });
    q.enqueue({ collection: 'records', record_id: 'old1', payload: { text: 'دادهٔ اصلی' } });
    await q.flush(server, session());                     // op1 آنلاین ⇒ applied
    clock.sync(clock.now());
    q.enqueue({ collection: 'records', record_id: 'old2', payload: { text: 'دوم' } });  // op2 آفلاین می‌ماند
    const op2Id = [...q.rows.entries()].find(([, o]) => o.record_id === 'old2')[0];
    // ۳۱ روز می‌گذرد (ساعت یکنوا)
    mono += 31 * 24 * 3600_000;
    const swept = q.sweepStale();
    const op2 = q.rows.get(op2Id);
    check('۳۱ روز ⇒ op باز به review می‌رود (نه حذف، نه موفق)', swept.includes(op2Id) && op2.status === 'review');
    check('op اعمال‌شده با کهنگی جابه‌جا نمی‌شود', q.byStatus('applied').length === 1);
    check('payload در review کامل حفظ شده', op2.payload && op2.payload.text === 'دوم' && /^[0-9a-f]{64}$/.test(op2.payload_hash));
    const before = q.byStatus('review').length;
    await q.flush(server, session());
    check('op در review خودکار ارسال نمی‌شود', q.byStatus('review').length === before && q.byStatus('applied').length === 1);

    // سمت سرور: op باز که کهنه شود هم review می‌شود (نه حذف)
    const server2 = new QueueServer({ now: () => clock.now() });
    const q2 = new OpQueue({ clock, cache: new SecureCache({ clock }).open('tenant-a') });
    q2.enqueue({ collection: 'records', record_id: 'gap', payload: { g: 1 }, base_version: 5 });
    await q2.flush(server2, session());                   // 409 ordering ⇒ ردیف open سمت سرور
    mono += 31 * 24 * 3600_000;
    const moved = server2.sweepStale();
    const meta = server2.opMetadata([...q2.rows.keys()][0])[0];
    check('سمت سرور: op بازِ کهنه ⇒ review با payload حفظ‌شده', moved.includes(meta.op_id) && meta.state === 'review' && !!meta.payload);
  }

  // ---------- ۵) کش: رمزنگاری، TTL، دست‌کاری، پاک‌سازی ----------
  {
    let local = 1_700_000_000_000;
    let mono = 5_000;
    const clock = new Clock({ localNow: () => local, monoNow: () => mono });
    const cache = new SecureCache({ clock }).open('tenant-a');
    clock.sync(local);                       // هم‌زمان با سرور
    const stored = cache.put('students', { list: [1, 2, 3], secret: 'محرمانه-۱۲۳' });
    check('متن اصلی در ciphertext نیست', !stored.ciphertext.includes(Buffer.from('محرمانه').toString('hex')) && stored.ciphertext !== JSON.stringify({ list: [1, 2, 3] }));
    check('خواندن با کلید نشست درست کار می‌کند', cache.get('students').ok === true && cache.get('students').value.list.length === 3);

    stored.ciphertext = stored.ciphertext.replace(/^../, '00');   // دست‌کاری یک بایت
    check('دست‌کاری داده ⇒ tampered (AEAD)', cache.get('students').reason === 'tampered');

    const cache2 = new SecureCache({ clock }).open('tenant-a');
    cache2.put('k', { a: 1 });
    mono += 8 * 24 * 3600_000;               // ۸ روز
    check('TTL ۷ روز ⇒ expired', cache2.get('k').reason === 'expired');

    const cache3 = new SecureCache({ clock }).open('tenant-a');
    cache3.put('k', { a: 1 });
    cache3.endSession();
    check('پایان نشست ⇒ پاک‌سازی کش', cache3.rows.size === 0);

    const cache4 = new SecureCache({ clock }).open('tenant-a');
    cache4.put('k', { a: 1 });
    check('کلید نابودشده ⇒ key_destroyed', cache4.destroyKey() === true && cache4.get('k').reason === 'key_destroyed');

    // ساعت دستگاه به عقب ⇒ TTL تمدید نمی‌شود
    const cache5 = new SecureCache({ clock }).open('tenant-a');
    clock.sync(clock.now());
    cache5.put('k', { a: 1 });
    mono += 8 * 24 * 3600_000;               // ۸ روز گذشته
    local -= 6 * 24 * 3600_000;              // و ساعت دیوار ۶ روز عقب برده شده
    check('عقب‌بردن ساعت دستگاه TTL را تمدید نمی‌کند (ساعت یکنوا)', cache5.get('k').reason === 'expired');

    // اختلاف بزرگ ساعت ⇒ حالت محافظه‌کارانه
    const clockBad = new Clock({ localNow: () => local, monoNow: () => mono });
    const cache6 = new SecureCache({ clock: clockBad }).open('tenant-a');
    check('حالت محافظه‌کارانه پیش از sync: کش منقضی فرض می‌شود', cache6.put && cache6.get('x').ok === false);
    clockBad.sync(local + 3600_000);         // اختلاف ۱ ساعت
    cache6.put('y', { a: 1 });
    check('|offset| > ۱۰ دقیقه ⇒ کش منقضی (بدترین تفسیر)', cache6.get('y').reason === 'expired');

    const cache7 = new SecureCache({ clock }).open('tenant-a');
    cache7.put('k', { a: 1 });
    check('تغییر مدرسه ⇒ تخلیهٔ کامل (کش + کلید)', cache7.wipe() === true && cache7.rows.size === 0 && cache7.key === null);
  }

  // ---------- ۶) بازیابی پس از کرش ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slice18-'));
    const file = path.join(dir, 'queue.json');
    const clock = new Clock();
    const cache = new SecureCache({ clock }).open('tenant-a');
    const q1 = new OpQueue({ clock, cache, durablePath: file });
    q1.enqueue({ collection: 'records', record_id: 'c1', payload: { a: 1 } });
    q1.enqueue({ collection: 'records', record_id: 'c2', payload: { a: 2 } });
    const q2 = new OpQueue({ clock, cache, durablePath: file });
    check('پس از کرش، صف پایدار بازگردانده می‌شود', q2.size === 2 && q2.byStatus('pending').length === 2);

    // کرش در میانهٔ ارسال ⇒ وضعیت نامعلوم، نه «موفق»
    const server = new QueueServer({ now: () => clock.now() });
    for (const op of q2.rows.values()) op.status = 'sending';
    q2.persist();
    const q3 = new OpQueue({ clock, cache, durablePath: file });
    check('op در حالت sending پس از کرش ⇒ ack_unknown (نه applied)', q3.byStatus('ack_unknown').length === 2 && q3.byStatus('applied').length === 0);

    await q3.flush(server, session());
    check('بازپخش پس از کرش با همان op_id ⇒ applied', q3.byStatus('applied').length === 2 && server.record('tenant-a', 'records', 'c1').version === 1);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- ۷) ابطال دستگاه: پنجرهٔ sync-on-revoke و orphaned سمت سرور ----------
  {
    const clock = new Clock();
    const server = new QueueServer({ now: () => clock.now() });
    const cache = new SecureCache({ clock }).open('tenant-a');
    const q = new OpQueue({ clock, cache });
    q.enqueue({ collection: 'records', record_id: 'v1', payload: { a: 1 } });
    const online = await q.syncOnRevoke(server, session());
    check('ابطال آنلاین: op ارسال و applied شد', online.result.results.some((r) => r.status === 'applied'));
    check('ابطال آنلاین: هیچ ردیف orphaned ساخته نشد', server.orphaned.length === 0);
    check('ابطال آنلاین: کلید محلی نابود شد (W2)', online.keyDestroyed === true && cache.key === null);

    // ابطال آفلاین: نشست ابطال‌شده ⇒ ارسال ممکن نیست ⇒ orphaned سمت سرور
    const server2 = new QueueServer({ now: () => clock.now() });
    const cache2 = new SecureCache({ clock }).open('tenant-a');
    cache2.put('students', { list: [1] });          // دادهٔ کش پیش از ابطال
    const q2 = new OpQueue({ clock, cache: cache2 });
    q2.enqueue({ collection: 'records', record_id: 'v2', payload: { b: 2 } });
    const off = await q2.syncOnRevoke(server2, session({ revoked: true }));
    check('ابطال آفلاین: ارسال رد شد (۴۰۱، نه «موفق»)', off.result.results.length === 0);
    check('ابطال آفلاین: ردیف orphaned سمت سرور ثبت شد', server2.orphaned.length === 1 && server2.orphaned[0].state === 'orphaned');
    check('orphaned متادیتای حسابرسی دارد (op_id + payload_hash)', !!server2.orphaned[0].op_id && /^[0-9a-f]{64}$/.test(server2.orphaned[0].payload_hash));
    check('W2: payload صف غیرقابل خواندن و کلید نابود شد', off.keyDestroyed === true && cache2.get('anything').reason === 'key_destroyed');
    check('هیچ op ناپدید نشد: همه یا applied یا orphaned', server2.orphaned.length === 1 && q2.byStatus('applied').length === 0);
  }

  // ---------- ۸) تعیین تکلیف انسانی ردیف کهنه ----------
  {
    let now = Date.now();
    const server = new QueueServer({ now: () => now });
    const clock = new Clock({ localNow: () => now });
    const q = new OpQueue({ clock, cache: new SecureCache({ clock }).open('tenant-a') });
    q.enqueue({ collection: 'records', record_id: 's1', payload: { z: 1 } });
    const opId = [...q.rows.keys()][0];
    await q.flush(server, session());                 // applied ⇒ ردیف open بسته می‌شود
    now += 31 * 24 * 3600_000;
    server.sweepStale();
    const meta = server.opMetadata(opId)[0];
    check('op اعمال‌شده با گذشت ۳۰ روز «کهنه» علامت نمی‌خورد', meta.state === 'applied');
    const noReason = server.decide('manager-a', opId, 'approve', '');
    check('تصمیم بدون دلیل ثبت نمی‌شود', noReason.ok === false && noReason.reason === 'reason_required');
    const ok = server.decide('manager-a', opId, 'approve', 'بررسی مدیر مدرسه');
    check('تصمیم با دلیل ثبت می‌شود و در queue_decision می‌آید', ok.ok === true && server.decisions.length === 1 && server.decisions[0].action === 'approve');
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed} موفق · ${failed} ناموفق`);
  console.log(`SUMMARY pass=${passed} fail=${failed} total=${results.length}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
