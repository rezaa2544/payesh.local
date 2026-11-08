'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون درستی موتور دادهٔ مرورگری — ردیف ۳۹  (EW-01 .. EW-10)

   این آزمون «کارکرد» را روی یک پیاده‌سازی استاندارد IndexedDB
   (fake-indexeddb، بدون Node API اختصاصی) می‌سنجد. «سرعت/حافظهٔ»
   عمداً اینجا سنجیده نمی‌شود؛ آن اندازه‌گیری باید در Chrome/WebView
   واقعی با bench/39 انجام شود.
   ═══════════════════════════════════════════════════════════════════ */
require('fake-indexeddb/auto');
const fs = require('fs');
const path = require('path');
const engine = require('../client/engine-web');

const EVIDENCE_DIR = path.join(__dirname, '..', 'docs', 'cloud', 'reports', 'evidence');

function validateBenchEvidence(doc, { kind = 'desktop', baselineCalibMs = null } = {}) {
  if (!doc || typeof doc !== 'object') throw new Error('missing_json');
  if (doc.bench !== 'bench-39') throw new Error(`bad_bench:${doc.bench}`);
  if (doc.ok !== true || doc.verdict !== 'BENCH39-OK') throw new Error(`bad_verdict:${doc.verdict}`);
  if (doc.count !== 100000 || doc.stat_after_reopen !== 100000) throw new Error(`bad_count:${doc.count}/${doc.stat_after_reopen}`);
  if (!doc.first_get_found) throw new Error('first_get_after_reopen_failed');
  const ua = String((doc.env && doc.env.ua) || '');
  if (!ua || /HeadlessChrome|PhantomJS|Electron/i.test(ua)) throw new Error(`headless_or_invalid_ua:${ua}`);
  if (!doc.index_query || doc.index_query.rows !== 2500 || !(doc.index_query.ms > 0)) throw new Error('bad_index_query');
  if (!doc.page_query || doc.page_query.rows !== 50 || !(doc.page_query.ms >= 0)) throw new Error('bad_page_query');
  if (!doc.mem_after_load || !(doc.mem_after_load.used_mb > 0 && doc.mem_after_load.used_mb < 200)) throw new Error('bad_mem_after_load');
  if (kind === 'android' && !/Android/i.test(ua)) throw new Error(`not_android_ua:${ua}`);
  if (kind === 'cpu4') {
    const calib = doc.calibration && doc.calibration.calib_ms;
    if (!(calib > 0) || (baselineCalibMs && calib < baselineCalibMs * 2.5)) {
      throw new Error(`cpu4_throttle_not_reflected:${calib}vs${baselineCalibMs}`);
    }
  }
  return true;
}

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

  const readBench = (name) => JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, name), 'utf8'));
  let desktop1 = null;

  await check('EW-11', 'شاهد واقعی Chrome Desktop (۱۰۰هزار ردیف، ۲ اجرای مستقل)', async () => {
    desktop1 = readBench('bench-39-chrome-desktop.json');
    const desktop2 = readBench('bench-39-chrome-desktop-run2.json');
    validateBenchEvidence(desktop1, { kind: 'desktop' });
    validateBenchEvidence(desktop2, { kind: 'desktop' });
    return `run1=${desktop1.load_ms}ms(${desktop1.rows_per_sec}/s,mem=${desktop1.mem_after_load.used_mb}MB) run2=${desktop2.load_ms}ms(${desktop2.rows_per_sec}/s,mem=${desktop2.mem_after_load.used_mb}MB)`;
  });

  await check('EW-12', 'شاهد واقعی Chrome Desktop با CPU throttling 4x', async () => {
    const cpu4 = readBench('bench-39-chrome-desktop-cpu4.json');
    validateBenchEvidence(cpu4, { kind: 'cpu4', baselineCalibMs: desktop1.calibration.calib_ms });
    return `calib=${cpu4.calibration.calib_ms}ms(vs ${desktop1.calibration.calib_ms}ms) load=${cpu4.load_ms}ms(${cpu4.rows_per_sec}/s) mem=${cpu4.mem_after_load.used_mb}MB`;
  });

  await check('EW-13', 'شاهد واقعی گوشی میان‌ردهٔ اندروید (Android 16 / POCO X7 Pro)', async () => {
    const android = readBench('bench-39-android-webview.json');
    validateBenchEvidence(android, { kind: 'android' });
    return `load=${android.load_ms}ms(${android.rows_per_sec}/s) idx=${android.index_query.ms}ms page=${android.page_query.ms}ms mem=${android.mem_after_load.used_mb}MB`;
  });

  await check('EW-14', 'کنترل منفی شاهد بنچمارک: رد شدن HeadlessChrome، شمارش ناقص و throttle صوری', async () => {
    const base = readBench('bench-39-chrome-desktop.json');
    let rejected = 0;
    for (const bad of [
      { ...base, count: 99999 },
      { ...base, verdict: 'BENCH39-FAIL' },
      { ...base, env: { ...base.env, ua: 'Mozilla/5.0 HeadlessChrome/157.0.0.0' } },
      { ...base, calibration: { calib_ms: 1100 } },
    ]) {
      try {
        validateBenchEvidence(bad, { kind: bad.calibration.calib_ms === 1100 ? 'cpu4' : 'desktop', baselineCalibMs: 1000 });
      } catch (e) { rejected++; }
    }
    assert(rejected === 4, `rejected=${rejected}/4`);
    return `rejected=${rejected}/4`;
  });

  console.log('');
  console.log(`EW checks=${passed + failed} pass=${passed} fail=${failed}`);
  if (failed === 0) console.log('ENGINE-WEB-OK');
  else { console.log('failed: ' + failures.join(',')); console.log('ENGINE-WEB-FAIL'); }
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.log('EW harness error: ' + ((e && e.message) || e)); process.exit(2); });
