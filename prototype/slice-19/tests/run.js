'use strict';
// آزمون خودکار نمونهٔ ۱۹ — تعارض و هم‌گرایی (آزمون‌های الزامی ۱۴ §۵)
// اجرا: node prototype/slice-19/tests/run.js

const { ConflictServer, sha256 } = require('../conflict-server');

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ' — ' + detail}`);
}

const T = 'tenant-a';
const device = (role, over = {}) => ({ user_id: `u-${role}`, tenant_id: T, role, class_ids: ['10-1'], ...over });
let opn = 0;
const op = (collection, record_id, fields, base_version) => ({ op_id: `op-${++opn}`, collection, record_id, fields, base_version });

// سناریوی استاندارد تعارض: op اول اعمال می‌شود و op دوم (همان base_version) تعارض می‌سازد
function race(s, session, collection, record_id, firstValue, secondValue, field = 'value') {
  const a = s.apply(session, op(collection, record_id, { [field]: firstValue }, 0));
  const b = s.apply(session, op(collection, record_id, { [field]: firstValue }, 1));   // نسخه ۲
  const c = s.apply(session, op(collection, record_id, { [field]: secondValue }, 1));  // همان base ⇒ تعارض
  return { a, b, c };
}

function main() {
  // ---------- ۱) دو نویسندهٔ هم‌زمان همان فیلد ⇒ یک conflict.open، هر دو مقدار حفظ ----------
  {
    const s = new ConflictServer();
    const key = '10-1:st1:2026-11-07';
    s.apply(device('teacher'), op('attendance', key, { status: 'present' }, 0));            // نسخه ۱
    const a = s.apply(device('teacher'), op('attendance', key, { status: 'absent' }, 1));   // اعمال ⇒ نسخه ۲
    const b = s.apply(device('teacher'), op('attendance', key, { status: 'late' }, 1));     // همان base ⇒ تعارض
    check('نویسندهٔ دوم با نسخهٔ کهنه ⇒ ۴۰۹ conflict', a.status === 'applied' && b.status === 'conflict' && b.code === 409);
    const open = s.openConflicts(T);
    check('یک ردیف conflict.open ساخته شد', open.length === 1);
    check('مقدار بازنده حفظ شده (late)', open[0].local_value === 'late');
    check('مقدار سروری هم حفظ شده (absent)', open[0].server_value === 'absent');
    check('raised_by_op_id برای ردیابی ثبت شده', open[0].raised_by_op_id === b.op_id);
    check('تلاش بازنده در audit ثبت شد (conflict.open با همان op_id)',
      s.audit.some((x) => x.action === 'conflict.open' && x.op_id === b.op_id));
    check('زنجیرهٔ audit پیوسته است (prev_hash هر ردیف = hash ردیف قبل)', (() => {
      if (!s.audit.length || s.audit[0].prev_hash !== 'GENESIS') return false;
      return s.audit.every((x, i) => i === 0 || x.prev_hash === s.audit[i - 1].hash);
    })());
  }

  // ---------- ۲) دو نویسندهٔ فیلدهای جدا ⇒ هر دو ذخیره، بدون تعارض کاربری ----------
  {
    const s = new ConflictServer();
    s.apply(device('teacher'), op('attendance', '10-1:st2:2026-11-07', { status: 'present' }, 0));
    const r1 = s.apply(device('teacher'), op('attendance', '10-1:st2:2026-11-07', { note: 'با اجازهٔ مدیر' }, 1));
    const r2 = s.apply(device('teacher'), op('attendance', '10-1:st2:2026-11-07', { status: 'late' }, 2));
    check('ادغام فیلد‌به‌فیلد: هر دو اعمال می‌شوند', r1.status === 'applied' && r2.status === 'applied');
    const rec = s.record(T, 'attendance', '10-1:st2:2026-11-07');
    check('نتیجهٔ نهایی هر دو فیلد را دارد', rec.fields.status === 'late' && rec.fields.note === 'با اجازهٔ مدیر');
    check('هیچ تعارض کاربری ساخته نشد', s.openConflicts(T).length === 0);

    // تعارض فیلد + ادغام فیلد مستقل در همان op
    const r3 = s.apply(device('teacher'), op('attendance', '10-1:st2:2026-11-07', { status: 'absent', note: 'اصلاح' }, 2));
    check('op با یک فیلد متعارض: فیلد مستقل ادغام، فیلد متعارض به تصمیم', r3.status === 'conflict' && r3.merged_fields.join() === 'note' && r3.conflict.fields.join() === 'status');
    check('مقدار ادغام‌شده واقعاً ذخیره شد', s.record(T, 'attendance', '10-1:st2:2026-11-07').fields.note === 'اصلاح');
  }

  // ---------- ۳) تکرار op بعد از حل ⇒ بی‌اثر ----------
  {
    const s = new ConflictServer();
    const key = '10-1:st3:2026-11-07';
    const { c } = race(s, device('teacher'), 'attendance', key, 'present', 'absent', 'status');
    const id = s.openConflicts(T)[0].id;
    const r1 = s.resolve(device('manager'), id, { resolution: 'take_local', reason: 'تأیید دبیر' });
    const v1 = s.record(T, 'attendance', key).version;
    const r2 = s.resolve(device('manager'), id, { resolution: 'take_local', reason: 'تأیید دبیر' });
    check('حل اول موفق و نسخه یک‌بار بالا رفت', r1.ok && v1 === 3);
    check('پس از حل هم هر دو نسخه در ردیف حفظ می‌شوند', r1.conflict.local_value === 'absent' && r1.conflict.server_value === 'present');
    check('ردیف تعارض پس از حل حذف نمی‌شود (status=resolved)', r1.conflict.status === 'resolved' && s.conflicts.length === 1);
    check('حل دوباره idempotent است (بدون افزایش نسخه)', r2.ok === true && r2.idempotent === true && s.record(T, 'attendance', key).version === v1);
    const rowsBefore = s.conflicts.length;
    const replay = s.apply(device('teacher'), { ...c, op_id: c.op_id });
    check('بازپخش همان op تعارض‌ساز بی‌اثر است', replay.status === 'conflict' &&
      s.conflicts.length === rowsBefore && s.record(T, 'attendance', key).version === v1);
  }

  // ---------- ۴) حل توسط کاربر غیرمجاز ⇒ ۴۰۳ + audit رد ----------
  {
    const s = new ConflictServer();
    const key = '10-1:st4:ریاضی';
    race(s, device('teacher'), 'grades', key, 15, 18, 'score');
    const id = s.openConflicts(T)[0].id;
    const denied = s.resolve(device('parent'), id, { resolution: 'take_local', reason: 'x' });
    check('ولی نمی‌تواند تعارض نمره را حل کند ⇒ ۴۰۳', denied.ok === false && denied.code === 403 && denied.reason === 'role_denied');
    check('رد شدن در audit ثبت شد', s.audit.some((a) => a.action === 'conflict.resolve.deny' && a.reason === 'role_denied'));
    const studentDeny = s.resolve(device('student'), id, { resolution: 'take_local', reason: 'x' });
    check('هنرجو هم نمی‌تواند ⇒ ۴۰۳', studentDeny.code === 403);
    const outScope = s.resolve(device('teacher', { class_ids: ['11-2'] }), id, { resolution: 'take_local', reason: 'x' });
    check('دبیر خارج از اسکوپ کلاس ⇒ ۴۰۳ out_of_scope', outScope.code === 403 && outScope.reason === 'out_of_scope');
    const ok = s.resolve(device('teacher'), id, { resolution: 'take_server', reason: 'نمرهٔ سرور درست است' });
    check('دبیر با اسکوپ کلاس مجاز است', ok.ok === true && ok.conflict.status === 'resolved');
    check('تصمیم‌گیرنده و زمان در ردیف ثبت شد', ok.conflict.resolved_by === 'u-teacher' && !!ok.conflict.resolved_at && !!ok.conflict.audit_id);
  }

  // ---------- ۵) تعارض باز + W2 ⇒ orphaned، نه حذف ----------
  {
    const s = new ConflictServer();
    race(s, device('teacher'), 'attendance', '10-1:st5:2026-11-07', 'present', 'absent', 'status');
    const before = s.openConflicts(T).length;
    const orphaned = s.orphanAfterWipe(device('teacher'));
    check('پیش از W2 ردیف open ثبت شده بود', before === 1);
    check('پس از W2 وضعیت orphaned شد (نه حذف)', orphaned.length === 1 && s.openConflicts(T).length === 0 && s.conflicts.filter((c) => c.status === 'orphaned').length === 1);
    check('مقادیر هر دو نسخه حتی پس از orphaned می‌مانند', s.conflicts.find((c) => c.status === 'orphaned').local_value === 'absent');
    check('عملیات روی ردیف orphaned رد می‌شود', s.resolve(device('manager'), orphaned[0], { resolution: 'take_local' }).reason === 'conflict_orphaned');
  }

  // ---------- ۶) ۱۰۰ تعارض هم‌زمان ⇒ شمارش ورودی = خروجی ----------
  {
    const s = new ConflictServer();
    for (let i = 0; i < 100; i++) {
      race(s, device('teacher'), 'attendance', `10-1:bulk${i}:2026-11-07`, 'present', 'absent', 'status');
    }
    const st = s.status(T);
    check('۱۰۰ تعارض هم‌زمان ⇒ ۱۰۰ ردیف open (بدون گم‌شدن)', st.open === 100);
    check('هیچ ردیفی حذف یا ادغام بی‌صدا نشد', s.conflicts.length === 100 && s.conflicts.every((c) => c.local_value === 'absent'));
    check('همهٔ ردیف‌ها before_hash دارند (قابل حسابرسی)', s.conflicts.every((c) => /^[0-9a-f]{64}$/.test(c.before_hash)));
  }

  // ---------- ۷) LWW بسته: base_version غایب/صفر روی ردیف موجود ----------
  {
    const s = new ConflictServer();
    s.apply(device('manager'), op('users', 'st7', { name: 'الف' }, 0));
    const missing = s.apply(device('manager'), op('users', 'st7', { name: 'ب' }, undefined));
    const zero = s.apply(device('manager'), op('users', 'st7', { name: 'ج' }, 0));
    check('base_version غایب ⇒ rejected base_version_required', missing.status === 'rejected' && missing.reason === 'base_version_required');
    check('base_version=0 روی ردیف موجود ⇒ rejected', zero.status === 'rejected' && zero.reason === 'base_version_required');
    check('مقدار ردیف تغییر نکرد (هیچ LWW)', s.record(T, 'users', 'st7').fields.name === 'الف');
    const newRow = s.apply(device('manager'), op('users', 'st7-new', { name: 'تازه' }, 0));
    check('ردیف تازه با base_version=0 مجاز است', newRow.status === 'applied');
  }

  // ---------- ۸) بدون لو رفتن محتوا در پاسخ تعارض ----------
  {
    const s = new ConflictServer();
    const key = '10-1:st8:ریاضی';
    s.apply(device('teacher'), op('grades', key, { score: 12 }, 0));
    s.apply(device('teacher'), op('grades', key, { score: 14 }, 1));                       // نسخه ۲
    const stale = s.apply(device('student'), op('grades', key, { score: 20 }, 1));         // دانش‌آموز، نسخهٔ کهنه
    check('پاسخ تعارض فقط متادیتا دارد', stale.status === 'conflict' && Object.keys(stale.conflict).sort().join() === 'before_hash,fields,record_id,server_version');
    check('هیچ مقدار سروری در پاسخ نیست', !JSON.stringify(stale.conflict).includes('14') && stale.conflict.fields.join() === 'score');
    const view = s.conflictView(s.conflicts[s.conflicts.length - 1]);
    check('نمای استاندارد تعارض هم مقدار برنمی‌گرداند', !('server_value' in view) && !('local_value' in view));
    const okRes = s.apply(device('teacher'), op('grades', key, { score: 16 }, 2));
    check('پاسخ موفق هم محتوای ردیف را لو نمی‌دهد', okRes.status === 'applied' && !('fields' in okRes));
  }

  // ---------- ۹) مجوزدهی دوباره هنگام حل ----------
  {
    const s = new ConflictServer();
    race(s, device('teacher'), 'discipline', '10-1:st9', 1, 2, 'level');
    const id = s.openConflicts(T)[0].id;
    const guard = s.resolve(device('guard'), id, { resolution: 'take_local', reason: 'x' });
    check('نگهبان ⇒ ۴۰۳', guard.code === 403);
    const mergedNoReason = s.resolve(device('counselor'), id, { resolution: 'merged' });
    check('ادغام بدون دلیل ⇒ ۴۰۰ reason_required', mergedNoReason.code === 400 && mergedNoReason.reason === 'reason_required');
    const counselor = s.resolve(device('counselor'), id, { resolution: 'merged', reason: 'توافق با دبیر', value: 2 });
    check('مشاور مجاز است (per-entity §۲.۱) و ادغام با دلیل ثبت شد', counselor.ok === true && counselor.conflict.resolution === 'merged' && counselor.conflict.reason === 'توافق با دبیر');
    check('هیچ تعارض دیگری باز نماند', s.openConflicts(T).length === 0);
  }

  // ---------- ۱۰) پایداری شاهد: ردیف conflict بازیافتنی با status=open و raised_by_op_id ----------
  {
    const s = new ConflictServer();
    s.apply(device('teacher'), op('schedule', '10-1:Sunday:1', { subject: 'ریاضی' }, 0));
    s.apply(device('manager'), op('schedule', '10-1:Sunday:1', { subject: 'زیست' }, 1));
    const r = s.apply(device('manager'), op('schedule', '10-1:Sunday:1', { subject: 'فیزیک' }, 1));
    const row = s.conflicts[0];
    check('ردیف conflict با status=open ساخته شد', row.status === 'open' && r.status === 'conflict');
    check('raised_by_op_id همان op تعارض‌ساز است', row.raised_by_op_id === r.op_id);
    check('کلید یکتایی مستند کامل است', ['tenant_id', 'collection', 'record_id', 'field', 'server_version', 'raised_by_op_id'].every((k) => row[k] !== undefined && row[k] !== null));
    check('schedule ادغام فیلد‌به‌فیلد ندارد ⇒ ردیف واحد (*)', row.field === '*');
  }

  // ---------- ۱۱) parity per-entity: مثبت/منفی ----------
  {
    const cases = [
      ['attendance', 'manager', true], ['attendance', 'teacher', true], ['attendance', 'parent', false],
      ['grades', 'teacher', true], ['grades', 'student', false],
      ['leaves', 'teacher', true], ['leaves', 'guard', false],
      ['announcements', 'teacher', false], ['announcements', 'manager', true],
      ['users', 'teacher', false],
    ];
    let ok = 0;
    for (const [entity, role, expected] of cases) {
      const s = new ConflictServer();
      const key = entity === 'users' ? 'st-p' : '10-1:st-p';
      race(s, device('manager'), entity, key, 1, 2, 'v');
      const res = s.resolve(device(role), s.openConflicts(T)[0].id, { resolution: 'take_server', reason: 'parity' });
      if ((res.ok === true) === expected) ok++;
      else console.log(`   ↳ parity ${entity}/${role}: انتظار ${expected} اما ${JSON.stringify(res)}`);
    }
    check(`parity per-entity: ${ok}/${cases.length} مطابق ماتریس §۲.۱`, ok === cases.length);
  }

  // ---------- ۱۲) ترتیب قطعی ادغام (determinism) ----------
  {
    const build = (order) => {
      const s = new ConflictServer();
      s.apply(device('manager'), op('users', 'st12', { name: 'پایه', phone: '0912', class: '10-1' }, 0));
      const fields = {};
      for (const f of order) fields[f] = `${f}-new`;
      s.apply(device('manager'), op('users', 'st12', fields, 1));
      return sha256(JSON.stringify(s.record(T, 'users', 'st12').fields));
    };
    const h1 = build(['name', 'phone', 'class']);
    const h2 = build(['class', 'phone', 'name']);
    check('ترتیب فیلدها در op نتیجه را تغییر نمی‌دهد (determinism)', h1 === h2);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed} موفق · ${failed} ناموفق`);
  console.log(`SUMMARY pass=${passed} fail=${failed} total=${results.length}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
