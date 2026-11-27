#!/usr/bin/env node
'use strict';
/* ردیف ۱۹۷-Q04 — کلاس دانش‌آموزی جدا از اتاق؛ پیوند دانش‌آموز ↔ پایه/رشته/کلاس.
   شکل همان دادهٔ واقعی هنرستان کاربر (۲۰۲۶-۱۱-۲۷): مقطع «متوسطه دوم»، ۱۶ اتاق/کارگاه در
   مجموعهٔ classes، یک کلاس کلاس‌محورِ «دهم» بی‌رشته، پایهٔ «دهم» دو بار، و دانش‌آموزان دهم با
   `field` (نقشه کشی ۳۲، تعمیر موتور ۱۹، …) همه بی‌کلاس.
   اجرا: node --experimental-sqlite tests/structure-197.js */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const { openStore } = require(path.join(ROOT, 'server', 'db.js'));
const sr = require(path.join(ROOT, 'server', 'structure-repair.js'));

let passed = 0; let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); }
}

function school(level) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st197-'));
  const st = openStore(path.join(dir, 'db.sqlite'));
  st.insert('schools', { name: 'کاردانش آینده سازان', level, school_type: 'vocational' }, { id: 1 });
  return st;
}

function realShape() {
  const st = school('متوسطه دوم');
  for (const r of ['101', '202', 'کارگاه نقشه کشی', 'کارگاه تعمیر موتور']) st.insert('classes', { name: r, kind: 'room', school_id: 1 });
  const dahom = st.insert('classes', { name: 'دهم', grade: 'دهم', branch: '', mode: 'class', grade_level: 10, kind: 'class', capacity: 30, school_id: 1 });
  st.insert('lookups', { kind: 'grade', name: 'دهم', order: 1 }, { id: 1 });
  st.insert('lookups', { kind: 'grade', name: 'یازدهم', order: 2 }, { id: 2 });
  st.insert('lookups', { kind: 'branch', name: 'نقشه کشی', order: 3 });
  st.insert('lookups', { kind: 'branch', name: 'تعمیر موتور', order: 6 });
  st.insert('lookups', { kind: 'grade', name: 'دهم', order: 1 }); /* تکراری (از گوشی) */
  const ids = { naghshe: [], motor: [] };
  for (let i = 0; i < 32; i++) ids.naghshe.push(st.insert('users', { name: 'ن' + i, role: 'student', grade: 'دهم', field: i === 0 ? 'نقشه‌کشی' : 'نقشه کشی', class_id: null, active: true, school_id: 1 }).id);
  for (let i = 0; i < 19; i++) ids.motor.push(st.insert('users', { name: 'م' + i, role: 'student', grade: 'دهم', field: 'تعمیر موتور', class_id: null, active: true, school_id: 1 }).id);
  const nograde = st.insert('users', { name: 'بی‌پایه', role: 'student', class_id: null, active: true }).id;
  const inactive = st.insert('users', { name: 'غیرفعال', role: 'student', grade: 'دهم', field: 'نقشه کشی', class_id: null, active: false }).id;
  const placed = st.insert('users', { name: 'در کلاس', role: 'student', grade: 'دهم', field: 'نقشه کشی', class_id: dahom.id, active: true }).id;
  const teacher = st.insert('users', { name: 'دبیر', role: 'teacher', class_id: null, active: true }).id;
  const followup = st.insert('users', { name: 'پیگیری', role: 'student', grade: 'دهم', field: 'نقشه کشی', class_id: null, active: true, followup_reason: 'کلاس حذف شد' }).id;
  return { st, dahom, ids, nograde, inactive, placed, teacher, followup };
}

const named = (st, n) => st.all('classes').filter(c => c.name === n);

check('Q04-S01 رشته‌محور: «دهم نقشه کشی» و «دهم تعمیر موتور» ساخته و هر دانش‌آموز به گروه خودش وصل می‌شود (نیم‌فاصله فرقی نمی‌کند)', () => {
  const { st, ids } = realShape();
  const r = sr.repair(st);
  assert.deepStrictEqual(r, { lookups: 1, classes: 2, linked: 51 });
  const [n] = named(st, 'دهم نقشه کشی');
  const [m] = named(st, 'دهم تعمیر موتور');
  assert.ok(n && m, 'هر دو گروه ساخته شد');
  assert.strictEqual(n.mode, 'field'); assert.strictEqual(n.kind, 'class');
  assert.strictEqual(n.grade, 'دهم'); assert.strictEqual(n.branch, 'نقشه کشی', 'املای «رشته‌ها»');
  assert.strictEqual(n.grade_level, 10); assert.strictEqual(n.capacity, 32);
  for (const id of ids.naghshe) assert.strictEqual(Number(st.get('users', id).class_id), Number(n.id));
  for (const id of ids.motor) assert.strictEqual(Number(st.get('users', id).class_id), Number(m.id));
  /* هر دانش‌آموز دادهٔ خودش را نگه می‌دارد */
  assert.strictEqual(st.get('users', ids.naghshe[3]).field, 'نقشه کشی');
});

check('Q04-S02 اتاق/کارگاه هرگز کلاس دانش‌آموزی نمی‌شود؛ کلاس دستی دست نمی‌خورد؛ بی‌پایه، غیرفعال، نیازمند پیگیری و دارای کلاس همان‌طور می‌مانند', () => {
  const { st, dahom, nograde, inactive, placed, teacher, followup } = realShape();
  sr.repair(st);
  const rooms = st.all('classes').filter(c => c.kind === 'room');
  assert.strictEqual(rooms.length, 4);
  for (const c of rooms) assert.ok(!c.grade && !c.branch && !c.mode, 'اتاق همان اتاق است: ' + c.name);
  assert.strictEqual(named(st, 'کارگاه نقشه کشی')[0].kind, 'room');
  assert.deepStrictEqual(st.get('classes', dahom.id).mode, 'class');
  assert.strictEqual(st.get('users', nograde).class_id, null);
  assert.strictEqual(st.get('users', inactive).class_id, null);
  assert.strictEqual(Number(st.get('users', placed).class_id), Number(dahom.id));
  assert.strictEqual(st.get('users', teacher).class_id, null);
  assert.strictEqual(st.get('users', followup).class_id, null, '«نیازمند پیگیری» منتظر مدیر می‌ماند');
});

check('Q04-S03 پایهٔ تکراری حذف می‌شود (قدیمی‌ترین می‌ماند)؛ رشته‌ها و پایه‌های دیگر دست نمی‌خورند', () => {
  const { st } = realShape();
  sr.repair(st);
  const g = st.all('lookups').filter(l => l.kind === 'grade');
  assert.deepStrictEqual(g.map(l => l.name).sort(), ['دهم', 'یازدهم'].sort());
  assert.ok(st.get('lookups', 1), 'شناسهٔ ۱ (قدیمی‌تر) ماند');
  assert.strictEqual(st.all('lookups').filter(l => l.kind === 'branch').length, 2);
});

check('Q04-S04 دوباره اجرا = هیچ تغییری (نه کلاس تازه، نه نوشتن)', () => {
  const { st } = realShape();
  sr.repair(st);
  let writes = 0;
  st.onWrite(() => { writes++; });
  assert.deepStrictEqual(sr.repair(st), { lookups: 0, classes: 0, linked: 0 });
  assert.strictEqual(writes, 0);
  assert.strictEqual(named(st, 'دهم نقشه کشی').length, 1);
});

check('Q04-S05 کلاس دستیِ هم‌پایه‌وهم‌رشته (حتی با نام دیگر) مقدم است — کلاس تکراری ساخته نمی‌شود', () => {
  const { st, ids } = realShape();
  const manual = st.insert('classes', { name: 'نقشه‌کشی ۱۰', grade: 'دهم', branch: 'نقشه کشی', mode: 'field', kind: 'class' });
  const r = sr.repair(st);
  assert.strictEqual(r.classes, 1, 'فقط تعمیر موتور ساخته شد');
  assert.strictEqual(named(st, 'دهم نقشه کشی').length, 0);
  assert.strictEqual(Number(st.get('users', ids.naghshe[5]).class_id), Number(manual.id));
});

check('Q04-S06 NEG کلاس‌محور (متوسطه اول): هیچ کلاسی ساخته نمی‌شود — کلاس را مدیر می‌سازد', () => {
  const st = school('متوسطه اول');
  st.insert('users', { name: 'الف', role: 'student', grade: 'هفتم', field: '', class_id: null, active: true });
  st.insert('users', { name: 'ب', role: 'student', grade: 'دهم', field: 'نقشه کشی', class_id: null, active: true });
  const r = sr.repair(st);
  assert.strictEqual(r.classes, 0); assert.strictEqual(r.linked, 0);
  assert.strictEqual(st.all('classes').length, 0);
});

check('Q04-S07 مقطع اعلام‌نشده: از خود داده (دهم + رشته) رشته‌محور شناخته می‌شود', () => {
  const st = school('');
  st.insert('users', { name: 'الف', role: 'student', grade: 'یازدهم', field: 'الکترونیک', class_id: null, active: true });
  const r = sr.repair(st);
  assert.strictEqual(r.classes, 1);
  assert.strictEqual(named(st, 'یازدهم الکترونیک')[0].grade_level, 11, '«یازدهم» ۱۱ است نه ۱۰');
});

check('Q04-S08 install: پس از ورود اکسل (نوشتن users) خودش اجرا می‌شود؛ خطا سرور را نمی‌شکند', () => {
  const st = school('متوسطه دوم');
  const h = sr.install(st, { delayMs: 0 });
  st.insert('users', { name: 'تازه', role: 'student', grade: 'دهم', field: 'گرافیک', class_id: null, active: true });
  h.run();
  assert.strictEqual(named(st, 'دهم گرافیک').length, 1);
  h.stop();
  const broken = { all() { throw new Error('db closed'); }, get() { return null; }, onWrite() { return () => {}; } };
  assert.doesNotThrow(() => sr.install(broken).stop());
});

check('Q04-S09 کلید و پایه: «نقشه‌کشی» = «نقشه کشی»، «یازدهم» = ۱۱، «۱۰» = ۱۰، «الکترونیک» پایه نیست', () => {
  assert.strictEqual(sr.key('نقشه‌کشی'), sr.key('نقشه کشی'));
  assert.strictEqual(sr.key('علوم انساني'), sr.key('علوم انسانی'));
  assert.strictEqual(sr.gradeLevel('یازدهم'), 11);
  assert.strictEqual(sr.gradeLevel('دوازدهم'), 12);
  assert.strictEqual(sr.gradeLevel('۱۰'), 10);
  assert.strictEqual(sr.gradeLevel('الکترونیک'), 0);
});

check('Q04-S10 حضور واقعی: پس از ترمیم، مدیر و دبیرِ (برنامه‌دار) «دهم نقشه کشی» حضور هر ۳۲ نفر را ثبت می‌کنند؛ پیش از ترمیم دبیر رد می‌شد (کنترل منفی)', () => {
  const policy = require(path.join(ROOT, 'server', 'policy.js'));
  const { st, ids, teacher } = realShape();
  const t = st.get('users', teacher);
  const mgr = st.insert('users', { name: 'مدیر', role: 'manager', active: true });
  /* پیش از ترمیم کلاسی نیست؛ دبیر روی کلاس دستیِ بی‌دانش‌آموز «دهم» هم نمی‌تواند حضور «ن۰» را بزند */
  const dahom = named(st, 'دهم')[0];
  st.insert('schedule', { class_id: dahom.id, teacher_id: teacher, day: 0, period: 1 });
  const before = policy.canWriteRow(st, t, 'teacher', 'attendance', { class_id: dahom.id, student_id: ids.naghshe[0], date: '1405-09-06', status: 'present' }, null);
  assert.strictEqual(before.ok, false, 'NEG: student without class must be refused');
  sr.repair(st);
  const cls = named(st, 'دهم نقشه کشی')[0];
  assert.ok(cls, 'class created');
  st.insert('schedule', { class_id: cls.id, teacher_id: teacher, day: 1, period: 2 });
  for (const sid of ids.naghshe) {
    const row = { class_id: cls.id, student_id: sid, date: '1405-09-06', status: 'present' };
    assert.deepStrictEqual(policy.canWriteRow(st, t, 'teacher', 'attendance', row, null), { ok: true }, 'teacher ' + sid);
    assert.deepStrictEqual(policy.canWriteRow(st, mgr, 'manager', 'attendance', row, null), { ok: true }, 'manager ' + sid);
  }
  /* هنرجوی رشتهٔ دیگر در فهرست این کلاس نیست */
  const other = policy.canWriteRow(st, t, 'teacher', 'attendance', { class_id: cls.id, student_id: ids.motor[0], date: '1405-09-06', status: 'present' }, null);
  assert.strictEqual(other.ok, false);
});

console.log(`\nSTRUCTURE-197 ${failed ? 'FAIL' : 'OK'} checks=${passed + failed} failed=${failed}`);
process.exit(failed ? 1 : 0);
