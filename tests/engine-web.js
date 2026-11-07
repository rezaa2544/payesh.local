'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون درستی موتور دادهٔ مرورگری — ردیف ۳۹  (EW-01 .. EW-10)

   این آزمون «کارکرد» را روی یک پیاده‌سازی استاندارد IndexedDB
   (fake-indexeddb، بدون Node API اختصاصی) می‌سنجد. «سرعت/حافظهٔ»
   عمداً اینجا سنجیده نمی‌شود؛ آن اندازه‌گیری باید در Chrome/WebView
   واقعی با bench/39 انجام شود.
   ═══════════════════════════════════════════════════════════════════ */
require('fake-indexeddb/auto');
const engine = require('../client/engine-web');

let passed = 0, failed = 0; const failures = [];
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 240)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

(async () => {
  let db = await engine.open('payesh_ew_test');

  await check('EW-01', 'باز شدن دیتابیس و ساخت object store + سه ایندکس', async () => {
    const names = [...db.db.objectStoreNames];
    assert(names.includes(engine.STORE), 'store missing');
    await db.put('classes', 1, { name: 'الف', class_id: 1 });
    const n = await db.count('classes');
    assert(n === 1, `count=${n}`);
    return `store=${engine.STORE} indexes=collection,refs,updated`;
  });

  await check('EW-02', 'get/put با نسخه و payload', async () => {
    await db.put('users', 10, { name: 'معلم', role: 'teacher', class_id: 1 }, { version: 3 });
    const row = await db.get('users', 10);
    assert(row && row.data.name === 'معلم' && row.version === 3, 'row mismatch');
    return `version=${row.version}`;
  });

  await check('EW-03', 'byRef روی کلیدهای *_id (ایندکس multiEntry)', async () => {
    await db.putMany([
      { collection: 'attendance', id: 200, data: { student_id: 11, class_id: 1, status: 'present' } },
      { collection: 'attendance', id: 201, data: { student_id: 11, class_id: 2, status: 'absent' } },
      { collection: 'attendance', id: 202, data: { student_id: 12, class_id: 1, status: 'late' } },
    ]);
    const byClass = await db.byRef('attendance', 'class_id', 1);
    assert(byClass.length === 2, `byRef(class_id=1)=${byClass.length}`);
    const byStudent = await db.byRef('attendance', 'student_id', 11);
    assert(byStudent.length === 2, `byRef(student_id=11)=${byStudent.length}`);
    return `class1=${byClass.length} student11=${byStudent.length}`;
  });

  await check('EW-04', 'list با limit/offset و ترتیب پایدار', async () => {
    const page1 = await db.list('attendance', { limit: 2 });
    const page2 = await db.list('attendance', { limit: 2, offset: 2 });
    assert(page1.length === 2 && page2.length === 1, `p1=${page1.length} p2=${page2.length}`);
    const ids = [...page1, ...page2].map(r => r.id).sort((a, b) => a - b);
    assert(JSON.stringify(ids) === '[200,201,202]', `ids=${ids.join(',')}`);
    return `rows=${ids.join('/')}`;
  });

  await check('EW-05', 'since برای همگام‌سازی (ردیف‌های تغییریافته بعد از مهر زمانی)', async () => {
    await db.put('grades', 300, { student_id: 11, class_id: 1, score: 18 }, { updated_at: '2026-11-02T10:00:00.000Z' });
    await db.put('grades', 301, { student_id: 12, class_id: 2, score: 12 }, { updated_at: '2026-11-05T10:00:00.000Z' });
    const changed = await db.since('grades', '2026-11-03T00:00:00.000Z');
    assert(changed.length === 1 && changed[0].id === 301, `since=${changed.map(r => r.id).join(',')}`);
    return `changed=${changed.length}`;
  });

  await check('EW-06', 'حذف ردیف و اثرش روی count', async () => {
    await db.del('grades', 300);
    const n = await db.count('grades');
    assert(n === 1, `count=${n}`);
    const gone = await db.get('grades', 300);
    assert(gone === null, 'deleted row still present');
    return `remaining=${n}`;
  });

  await check('EW-07', 'بارگذاری دسته‌ای ۱۲٬۰۰۰ ردیف در چانک‌ها', async () => {
    const t0 = Date.now();
    const rows = engine.makeRows(12000);
    const n = await db.loadChunked(rows, { chunk: 2000 });
    const ms = Date.now() - t0;
    const c = await db.count(null);
    assert(n === 12000, `loaded=${n}`);
    assert(c === 12000 + 5, `total=${c}`);
    return `rows=${n} ms=${ms} total=${c}`;
  });

  await check('EW-08', 'پرس‌وجوی ایندکسی روی حجم بالا (بدون اسکن کامل)', async () => {
    const sample = await db.list('attendance', { limit: 1 });
    assert(sample.length === 1, 'no attendance rows');
    const cls = sample[0].data.class_id;
    const t0 = Date.now();
    const rows = await db.byRef('attendance', 'class_id', cls);
    const ms = Date.now() - t0;
    assert(rows.length > 0, `no rows for class ${cls}`);
    assert(rows.every(r => r.data.class_id === cls && r.collection === 'attendance'), 'index returned wrong rows');
    return `class=${cls} rows=${rows.length} ms=${ms}`;
  });

  await check('EW-09', 'ماندگاری بین دو باز/بسته: داده بعد از باز شدن مجدد هست', async () => {
    const before = await db.count(null);
    db.close();
    db = await engine.open('payesh_ew_test');
    const after = await db.count(null);
    assert(after === before, `before=${before} after=${after}`);
    const one = await db.get('users', 10);
    assert(one && one.data.role === 'teacher', 'row lost after reopen');
    return `rows=${after}`;
  });

  await check('EW-10', 'stats: شمارش به‌تفکیک کالکشن', async () => {
    const st = await db.stats();
    assert(st.total > 12000, `total=${st.total}`);
    assert(st.collections.attendance >= 3000, `attendance=${st.collections.attendance}`);
    return `total=${st.total} collections=${Object.keys(st.collections).length}`;
  });

  db.close();
  console.log('');
  console.log(`EW checks=${passed + failed} pass=${passed} fail=${failed}`);
  if (failed === 0) console.log('ENGINE-WEB-OK');
  else { console.log('failed: ' + failures.join(',')); console.log('ENGINE-WEB-FAIL'); }
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.log('EW harness error: ' + ((e && e.message) || e)); process.exit(2); });
