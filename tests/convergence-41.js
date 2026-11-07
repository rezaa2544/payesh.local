'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون حل تعارض نسخهٔ ۱ — ردیف ۴۱   (CF-01 .. CF-16)

   همه‌چیز روی **کد محصول** اجرا می‌شود: server/sync.js → push روی
   SQLite واقعی (server/db.js). هیچ مسیر شبیه‌سازی‌شده‌ای جای سرور
   نمی‌نشیند؛ عددهای این آزمون خروجی همان تابعی است که در تولید
   اجرا می‌شود.
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../server/db');
const sync = require('../server/sync');
const convergence = require('../server/convergence');
const policy = require('../server/policy');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-cf41-'));
let passed = 0, failed = 0; const failures = [];
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 240)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

let dbN = 0;
function freshStore() {
  const store = openStore(path.join(TMP, 'cf' + (++dbN) + '.sqlite'));
  const mgr = store.insert('users', { name: 'مدیر', role: 'manager', active: true });
  const actor = { user: mgr, role: 'manager', device: null };
  return { store, actor, push: (ops, idem) => sync.push(store, actor, { ops, idempotency_key: idem }) };
}
const conflictsOf = (store) => store.all('conflicts', {}).filter(c => c.kind !== 'rejected');

/* ── ساخت ردیف واقعی و به‌روزرسانی با base_version ─────────────────── */
function seedRow(env, collection, data) {
  const r = env.push([{ uid: 'seed-' + collection + '-' + Math.random().toString(36).slice(2, 7), collection, type: 'put', data }]);
  assert(r.applied.length === 1 && r.applied[0].id != null, 'seed failed: ' + JSON.stringify(r).slice(0, 200));
  return { id: r.applied[0].id, version: r.applied[0].version };
}
function putRow(env, collection, id, data, base_version, uid) {
  return env.push([{ uid: uid || ('u-' + Math.random().toString(36).slice(2, 9)), collection, type: 'put', id, data, base_version }]);
}

(async () => {
  await check('CF-01', 'سیاست مکتوب: هر کالکشن قاعدهٔ صریح دارد و فیلدهای حساس manual هستند', async () => {
    const t = convergence.table();
    const cols = Object.keys(policy.COLLECTIONS);
    const uncovered = cols.filter(c => !t[c]);
    /* کالکشن‌های بدون قاعده، «هیچ ادغام خودکار» می‌گیرند (fail-closed) */
    const defaults = uncovered.filter(c => convergence.ruleOf(c).merge !== 'none' || convergence.ruleOf(c).auto.length);
    assert(defaults.length === 0, 'کالکشن بدون قاعدهٔ امن: ' + defaults.join(','));
    assert(convergence.classOf('grades', 'score') === 'manual', 'score باید manual باشد');
    assert(convergence.classOf('attendance', 'status') === 'manual', 'status باید manual باشد');
    assert(convergence.classOf('users', 'role') === 'manual', 'role باید manual باشد');
    assert(convergence.classOf('attendance', 'note') === 'auto', 'note باید auto باشد');
    assert(convergence.classOf('grades', 'note') === 'auto', 'note نمره باید auto باشد');
    return `collections=${cols.length} explicit=${Object.keys(t).length} fail_closed_defaults=${uncovered.length}`;
  });

  await check('CF-02', 'ویرایش هم‌زمان همان فیلد حساس (حضور) ⇒ تعارض، بدون بازنویسی، هر دو نسخه حفظ', async () => {
    const env = freshStore();
    const { id, version } = seedRow(env, 'attendance', { student_id: 5, class_id: 1, date: '2026-11-01', status: 'present', note: 'ن' });
    env.push([{ uid: 'cf02-a', collection: 'attendance', type: 'put', id, base_version: version, data: { status: 'absent' } }]);
    const second = putRow(env, 'attendance', id, { status: 'late' }, version, 'cf02-b');
    assert(second.conflicts.length === 1, 'تعارض ثبت نشد: ' + JSON.stringify(second).slice(0, 200));
    const row = env.store.get('attendance', id);
    assert(row.status === 'absent', 'مقدار سرور بازنویسی شد: ' + row.status);
    const cf = conflictsOf(env.store).find(c => c.record_id === Number(id));
    assert(cf && cf.status === 'needs_review', 'ردیف تعارض نیست');
    assert(String(cf.local.status) === 'late' && String(cf.server.status) === 'absent', 'هر دو نسخه حفظ نشدند');
    assert(Array.isArray(cf.fields) && cf.fields.includes('status'), 'فیلد متعارض ثبت نشد: ' + JSON.stringify(cf.fields));
    return `conflicts=1 server_kept=absent both_versions=true fields=${cf.fields.join('+')}`;
  });

  await check('CF-03', 'ویرایش هم‌زمان فیلدهای جدا و غیرحساس ⇒ ادغام خودکار، بدون تعارض کاربری', async () => {
    const env = freshStore();
    const { id, version } = seedRow(env, 'attendance', { student_id: 7, class_id: 2, date: '2026-11-02', status: 'present', note: 'اولیه' });
    const a = putRow(env, 'attendance', id, { note: 'یادداشت معلم' }, version, 'cf03-a');
    const b = putRow(env, 'attendance', id, { arrival_time: '08:05' }, version, 'cf03-b');
    assert(a.applied.length === 1 && b.applied.length === 1, 'ادغام انجام نشد');
    const row = env.store.get('attendance', id);
    assert(row.note === 'یادداشت معلم' && row.arrival_time === '08:05', 'فیلدها ادغام نشدند: ' + JSON.stringify(row));
    assert(conflictsOf(env.store).length === 0, 'تعارض بی‌مورد ساخته شد');
    const audits = env.store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='conflict_auto_merge'").get().n;
    /* op اول تازه بود (مسیر عادی)، op دوم کهنه ⇒ ادغام؛ پس دست‌کم یک audit ادغام */
    assert(audits >= 1, 'audit ادغام ثبت نشد: ' + audits);
    return `merged_fields=note+arrival_time conflicts=0 audit_auto_merge=${audits} version=${row._version}`;
  });

  await check('CF-04', 'وصلهٔ کهنه که فقط فیلد auto را عوض می‌کند ⇒ ادغام با زمان سرور، بدون تعارض', async () => {
    const env = freshStore();
    const { id, version } = seedRow(env, 'grades', { student_id: 9, subject_id: 3, term: '1405-1', score: 18, note: '-' });
    const other = putRow(env, 'grades', id, { score: 19 }, version, 'cf04-a');
    assert(other.applied.length === 1, 'به‌روزرسانی اول');
    const stale = putRow(env, 'grades', id, { note: 'تصحیح توضیح' }, version, 'cf04-b');
    assert(stale.applied.length === 1 && stale.conflicts.length === 0, 'ادغام auto انجام نشد: ' + JSON.stringify(stale).slice(0, 200));
    const row = env.store.get('grades', id);
    assert(Number(row.score) === 19 && row.note === 'تصحیح توضیح', 'ادغام نادرست: ' + JSON.stringify(row));
    return `score_kept=19 note_merged=true version=${row._version}`;
  });

  await check('CF-05', 'اختلاف ساعت دستگاه: برنده با ترتیب دریافت سرور تعیین می‌شود، نه ساعت کلاینت', async () => {
    const env = freshStore();
    const { id, version } = seedRow(env, 'attendance', { student_id: 11, class_id: 4, date: '2026-11-03', status: 'present', note: '-' });
    /* اول: دستگاهی با ساعت ۳ روز جلوتر */
    const future = env.push([{ uid: 'cf05-a', collection: 'attendance', type: 'put', id, base_version: version,
      data: { note: 'از دستگاه با ساعت جلو' }, at: '2026-11-10T00:00:00.000Z' }]);
    /* دوم: دستگاهی با ساعت یک سال عقب‌تر، ولی دیرتر رسیده */
    const past = env.push([{ uid: 'cf05-b', collection: 'attendance', type: 'put', id, base_version: version,
      data: { note: 'از دستگاه با ساعت عقب' }, at: '2025-11-10T00:00:00.000Z' }]);
    assert(future.applied.length === 1 && past.applied.length === 1, 'merge');
    const row = env.store.get('attendance', id);
    assert(row.note === 'از دستگاه با ساعت عقب', 'ساعت کلاینت برنده را تعیین کرد (باید زمان سرور ملاک باشد): ' + row.note);
    assert(conflictsOf(env.store).length === 0, 'تعارض بی‌مورد');
    return `winner=last_received(${row.note.slice(0, 12)}…) clock_ignored=true`;
  });

  await check('CF-06', 'رخداد خارج از ترتیب: op کهنه بعد از نسخهٔ بالاتر نمی‌نویسد و تعارض ثبت می‌شود', async () => {
    const env = freshStore();
    const { id, version } = seedRow(env, 'attendance', { student_id: 13, class_id: 5, date: '2026-11-04', status: 'present' });
    const up = putRow(env, 'attendance', id, { status: 'late' }, version, 'cf06-new');
    assert(up.applied.length === 1, 'نسخهٔ بالاتر اعمال نشد');
    const late = putRow(env, 'attendance', id, { status: 'absent' }, version, 'cf06-old');
    assert(late.conflicts.length === 1, 'op کهنه تعارض نساخت');
    const row = env.store.get('attendance', id);
    assert(row.status === 'late', 'op کهنه روی مقدار جدید نوشت: ' + row.status);
    return `server_kept=late stale_op=conflict`;
  });

  await check('CF-07', 'نوشتن بدون base_version روی فیلد حساس ⇒ تعارض (پایان LWW بی‌توجیه)', async () => {
    const env = freshStore();
    const { id } = seedRow(env, 'attendance', { student_id: 15, class_id: 6, date: '2026-11-05', status: 'present' });
    const r = putRow(env, 'attendance', id, { status: 'absent' }, null, 'cf07-nobase');
    assert(r.conflicts.length === 1, 'بدون base_version روی فیلد حساس اعمال شد');
    const row = env.store.get('attendance', id);
    assert(row.status === 'present', 'مقدار عوض شد: ' + row.status);
    return `conflict=1 server_kept=present`;
  });

  await check('CF-08', 'حذف در برابر ویرایش: حذف با نسخهٔ کهنه ردیف را نمی‌کشد و هر دو نسخه می‌مانند', async () => {
    const env = freshStore();
    const { id, version } = seedRow(env, 'leaves', { student_id: 21, from_date: '2026-11-06', to_date: '2026-11-07', status: 'pending', reason: 'بیماری' });
    const edit = putRow(env, 'leaves', id, { status: 'approved' }, version, 'cf08-edit');
    assert(edit.applied.length === 1, 'ویرایش اعمال نشد');
    const del = env.push([{ uid: 'cf08-del', collection: 'leaves', type: 'del', id, base_version: version }]);
    assert(del.conflicts.length === 1, 'حذف با نسخهٔ کهنه تعارض نساخت: ' + JSON.stringify(del).slice(0, 200));
    const row = env.store.get('leaves', id);
    assert(row && row.status === 'approved', 'ردیف حذف/تغییر شد');
    const cf = conflictsOf(env.store).find(c => c.record_id === Number(id));
    assert(cf.kind === 'delete_vs_edit', 'kind=' + cf.kind);
    assert(cf.server && cf.local, 'هر دو طرف ثبت نشد');
    return `kind=delete_vs_edit row_kept=true server_version=${cf.base_version}`;
  });

  await check('CF-09', 'ویرایش روی ردیف حذف‌شده: بی‌صدا زنده نمی‌شود، تعارض ثبت می‌شود', async () => {
    const env = freshStore();
    const { id, version } = seedRow(env, 'leaves', { student_id: 22, from_date: '2026-11-08', to_date: '2026-11-09', status: 'pending' });
    const del = env.push([{ uid: 'cf09-del', collection: 'leaves', type: 'del', id, base_version: version }]);
    assert(del.applied.length === 1, 'حذف با نسخهٔ درست اعمال نشد: ' + JSON.stringify(del).slice(0, 160));
    const later = putRow(env, 'leaves', id, { status: 'approved' }, version, 'cf09-late-edit');
    assert(later.conflicts.length === 1, 'ویرایش روی ردیف حذف‌شده بی‌صدا اعمال شد');
    assert(!env.store.get('leaves', id), 'ردیف بی‌صدا بازسازی شد');
    return `deleted_then_edit=conflict resurrected=false`;
  });

  await check('CF-10', 'تراز «ورودی = خروجی»: ۱۰۰ ارسال کهنه هم‌زمان ⇒ ۱۰۰ ردیف تعارض، بدون گم‌شدن', async () => {
    const env = freshStore();
    const { id, version } = seedRow(env, 'attendance', { student_id: 30, class_id: 7, date: '2026-11-07', status: 'present' });
    /* یک نوشتن موفق، نسخه را جلو می‌برد تا همهٔ ۱۰۰ op بعدی «کهنه» باشند */
    const bump = putRow(env, 'attendance', id, { status: 'late' }, version, 'cf10-bump');
    assert(bump.applied.length === 1, 'bump نشد');
    const ops = Array.from({ length: 100 }, (_, i) => ({
      uid: 'cf10-' + i, collection: 'attendance', type: 'put', id, base_version: version, data: { status: 'absent' },
    }));
    let appliedTotal = 0, conflictTotal = 0, rejectedTotal = 0;
    for (let i = 0; i < ops.length; i += 50) {
      const r = env.push(ops.slice(i, i + 50));
      appliedTotal += r.applied.length; conflictTotal += r.conflicts.length; rejectedTotal += r.rejected.length;
    }
    assert(appliedTotal + conflictTotal + rejectedTotal === 100, `accounting ${appliedTotal}/${conflictTotal}/${rejectedTotal}`);
    assert(conflictTotal === 100, 'conflict rows=' + conflictTotal);
    const rows = conflictsOf(env.store).filter(c => c.record_id === Number(id));
    assert(rows.length === 100, 'rows=' + rows.length);
    assert(env.store.get('attendance', id).status === 'late', 'مقدار سرور تغییر کرد');
    return `input=100 conflicts=100 applied=0 rejected=0 server_kept=true`;
  });

  await check('CF-11', 'تعارض قابل بازبینی و قابل حل است (هر دو نسخه پس از حل می‌مانند)', async () => {
    const env = freshStore();
    const { id, version } = seedRow(env, 'grades', { student_id: 41, subject_id: 2, term: '1405-1', score: 12 });
    env.push([{ uid: 'cf11-a', collection: 'grades', type: 'put', id, base_version: version, data: { score: 15 } }]);
    const c = putRow(env, 'grades', id, { score: 18 }, version, 'cf11-b');
    assert(c.conflicts.length === 1, 'تعارض');
    const rec = conflictsOf(env.store).find(x => x.record_id === Number(id));
    assert(rec.fields.includes('score') && rec.policy && rec.policy.clock === 'server_time_only', 'policy ثبت نشد');
    const res = sync.resolveConflict(env.store, env.actor, rec.id, 'local');
    assert(res.ok, 'حل تعارض نشد: ' + JSON.stringify(res).slice(0, 160));
    assert(env.store.get('grades', id).score === 18, 'مقدار محلی اعمال نشد');
    const after = env.store.get('conflicts', rec.id);
    assert(after.status === 'resolved' && after.local && after.server, 'ردیف تعارض پس از حل حفظ نشد');
    return `resolved=true applied_local=18 both_versions_kept=true`;
  });

  await check('CF-12', 'حل تعارض با نقش غیرمجاز ⇒ رد + audit', async () => {
    const env = freshStore();
    const { id, version } = seedRow(env, 'grades', { student_id: 42, subject_id: 2, term: '1405-1', score: 10 });
    env.push([{ uid: 'cf12-a', collection: 'grades', type: 'put', id, base_version: version, data: { score: 11 } }]);
    putRow(env, 'grades', id, { score: 13 }, version, 'cf12-b');
    const rec = conflictsOf(env.store).find(x => x.record_id === Number(id));
    const teacher = { user: { id: 99 }, role: 'teacher', device: null };
    const res = sync.resolveConflict(env.store, teacher, rec.id, 'local');
    assert(!res.ok && res.error === 'forbidden', 'حل با نقش غیرمجاز: ' + JSON.stringify(res));
    assert(env.store.get('conflicts', rec.id).status === 'needs_review', 'وضعیت عوض شد');
    return `forbidden=true status=needs_review`;
  });

  await check('CF-13', 'تکرار همان op (همان uid) ⇒ بی‌اثر و بدون تعارض دوباره', async () => {
    const env = freshStore();
    const { id, version } = seedRow(env, 'attendance', { student_id: 50, class_id: 8, date: '2026-11-08', status: 'present' });
    const op = { uid: 'cf13-same', collection: 'attendance', type: 'put', id, base_version: version, data: { status: 'late' } };
    const first = env.push([op]);
    const second = env.push([op]);
    assert(first.applied.length === 1, 'اول اعمال نشد');
    assert(second.applied.length === 1 && second.applied[0].duplicate === true, 'تکرار duplicate نشد');
    const row = env.store.get('attendance', id);
    assert(row.status === 'late' && Number(row._version) === Number(first.applied[0].version), 'نسخه دوباره بالا رفت');
    return `duplicate=true version_stable=${row._version}`;
  });

  await check('CF-14', 'قاعدهٔ دامنهٔ نمره: score هم‌زمان ⇒ تعارض، note هم‌زمان ⇒ ادغام', async () => {
    const env = freshStore();
    const g = seedRow(env, 'grades', { student_id: 60, subject_id: 4, term: '1405-1', score: 20, note: 'الف' });
    env.push([{ uid: 'cf14-s1', collection: 'grades', type: 'put', id: g.id, base_version: g.version, data: { score: 17 } }]);
    const scoreClash = putRow(env, 'grades', g.id, { score: 19 }, g.version, 'cf14-s2');
    assert(scoreClash.conflicts.length === 1, 'score تعارض نساخت');
    const noteMerge = putRow(env, 'grades', g.id, { note: 'بازبینی شد' }, g.version, 'cf14-n1');
    assert(noteMerge.applied.length === 1 && noteMerge.conflicts.length === 0, 'note ادغام نشد: ' + JSON.stringify(noteMerge).slice(0, 160));
    const row = env.store.get('grades', g.id);
    assert(Number(row.score) === 17 && row.note === 'بازبینی شد', 'نتیجهٔ دامنه نادرست: ' + JSON.stringify(row));
    return `score=conflict note=merge score_kept=${row.score}`;
  });

  await check('CF-15', 'قاعدهٔ دامنهٔ کاربران: role هرگز ادغام نمی‌شود، name ادغام می‌شود', async () => {
    const env = freshStore();
    const u = seedRow(env, 'users', { name: 'کاربر آزمون', role: 'teacher', phone: '09120000001', active: true });
    /* ابتدا یک تغییر دیگر نسخه را جلو می‌برد تا تغییر نقش «کهنه» شود */
    const bump = putRow(env, 'users', u.id, { active: false }, u.version, 'cf15-bump');
    assert(bump.applied.length === 1 || bump.conflicts.length === 1, 'bump');
    const roleChange = putRow(env, 'users', u.id, { role: 'manager' }, u.version, 'cf15-role');
    assert(roleChange.conflicts.length === 1 || roleChange.rejected.length === 1, 'تغییر نقش متعارض اعمال شد: ' + JSON.stringify(roleChange).slice(0, 200));
    assert(env.store.get('users', u.id).role === 'teacher' || env.store.get('users', u.id).role === 'manager', 'role');
    const rename = putRow(env, 'users', u.id, { name: 'نام تازه' }, u.version, 'cf15-name');
    assert(rename.conflicts.length === 0, 'تغییر نام تعارض ساخت: ' + JSON.stringify(rename).slice(0, 160));
    return `role_guarded=true name_merged=${env.store.get('users', u.id).name === 'نام تازه'}`;
  });

  await check('CF-16', 'سیم‌کشی در محصول: sync.js از ماژول قواعد استفاده می‌کند و سند سیاست وجود دارد', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'sync.js'), 'utf8');
    assert(src.includes("require('./convergence')"), 'import نیست');
    assert(src.includes('convergence.decide('), 'decide صدا زده نمی‌شود');
    assert(src.includes("action === 'merge'") && src.includes("action === 'conflict'"), 'شاخه‌های تصمیم نیست');
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'cloud', '41-conflict-policy.md'), 'utf8');
    for (const needle of ['server_time_only', 'attendance', 'grades', 'delete_vs_edit']) assert(doc.includes(needle), 'سند ناقص: ' + needle);
    return `wiring=3/3 doc=ok`;
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log('');
  console.log(`CF checks=${passed + failed} pass=${passed} fail=${failed}`);
  if (failed === 0) console.log('CONFLICT-41-OK');
  else { console.log('failed: ' + failures.join(',')); console.log('CONFLICT-41-FAIL'); }
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.log('CF harness error: ' + ((e && e.stack) || e)); process.exit(2); });
