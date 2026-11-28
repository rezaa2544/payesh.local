#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 197 — Q10 (F36): a sudden day off («تعطیل» / «غیرحضوری»: air pollution, energy, epidemic;
   announced the evening before).

     D01  server/school-calendar.js: row shape (date, kind, reason, exams_to after the day)
     D02  local server: calendar rows manager-only with shape checks; on that day «غایب/تأخیر»
          is refused for everyone (day_off), «حاضر/موجه» accepted; another day unaffected
     D03  cloud scope mirrors the calendar shape; Dart twin has the same codes
     D04  web manager: «اعلام تعطیلی / غیرحضوری» writes the calendar row, an «important» notice
          for everyone and moves the INTERNAL exams of that day; a national exam stays and is
          reported
     D05  web attendance: a closed day shows the banner and no roster/save; a remote day saves
          «حاضر» but never «غایب»
     D06  web parent/teacher home + announcements show «فردا تعطیل/غیرحضوری»
     D07  negative controls: without a day off the same absence is accepted; a cancelled day
          takes absences again
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
const pending = [];
function check(id, desc, fn) {
  pending.push(async () => {
    try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
    catch (e) { failed++; console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.stack) || e)}`); }
  });
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const J = (x) => JSON.stringify(x);

const cal = require(path.join(ROOT, 'server/school-calendar'));
const policy = require(path.join(ROOT, 'server/policy'));
const scope = require(path.join(ROOT, 'server/scope'));
const sync = require(path.join(ROOT, 'server/sync'));
const { openStore } = require(path.join(ROOT, 'server/db'));

const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const today = iso(0), tomorrow = iso(1), later = iso(3);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dayoff197-'));
const st = openStore(path.join(TMP, 'a.sqlite'));
st.insert('schools', { name: 'مدرسه', level: 'متوسطه اول' }, { id: 1 });
const mgr = st.insert('users', { name: 'مدیر', role: 'manager', active: true });
st.insert('classes', { name: 'هفتم' }, { id: 10 });
const s1 = st.insert('users', { name: 'سارا', role: 'student', class_id: 10, active: true });
const teacher = st.insert('users', { name: 'دبیر', role: 'teacher', active: true });
st.insert('schedule', { class_id: 10, teacher_id: teacher.id, subject_id: 1, weekday: 1, bell_order: 1, ref2: teacher.id });
let seq = 0;
const op = (collection, data, extra) => Object.assign({ uid: `d197-${++seq}`, collection, type: 'put', data }, extra || {});
const actor = (id) => { const u = st.get('users', id); return { user: u, role: policy.permRole(u.role), device: null }; };
const push = (id, ops) => sync.push(st, actor(id), { ops });
const day = (extra) => Object.assign({ date: tomorrow, kind: 'closed', reason: 'آلودگی هوا به اعلام استانداری' }, extra || {});
const att = (status, date) => ({ student_id: s1.id, class_id: 10, date: date || tomorrow, status, source: 'teacher' });

check('D01', 'calendar row shape', () => {
  assert(cal.dayOffIssue(day()) === null && cal.dayOffIssue(day({ kind: 'remote' })) === null, 'ok');
  assert(cal.dayOffIssue(day({ date: '1405/09/20' })) === 'bad_date', 'jalali text');
  assert(cal.dayOffIssue(day({ date: '2026-02-30' })) === 'bad_date', 'no such day');
  assert(cal.dayOffIssue(day({ kind: 'holiday' })) === 'bad_kind', 'kind');
  assert(cal.dayOffIssue(day({ reason: ' ' })) === 'reason_required', 'reason');
  assert(cal.dayOffIssue(day({ exams_to: tomorrow })) === 'bad_range' && cal.dayOffIssue(day({ exams_to: later })) === null, 'exams_to');
  return 'bad_date,bad_kind,reason_required,bad_range';
});

check('D02', 'local server: manager-only calendar, no absence on that day', () => {
  const t = push(teacher.id, [op('calendar', day())]);
  assert(t.rejected[0] && t.rejected[0].error === 'role_denied', 'teacher ' + J(t));
  const bad = push(mgr.id, [op('calendar', day({ reason: '' }))]);
  assert(bad.rejected[0].error === 'reason_required', J(bad));
  const ok = push(mgr.id, [op('calendar', day())]);
  assert(ok.applied.length === 1, J(ok));
  const a = push(mgr.id, [op('attendance', att('absent')), op('attendance', att('late'))]);
  assert(a.rejected.map(x => x.error).join() === 'day_off,day_off', 'manager absence ' + J(a));
  const tt = push(teacher.id, [op('attendance', att('absent'))]);
  assert(tt.rejected[0].error === 'day_off', 'teacher absence ' + J(tt));
  const p = push(teacher.id, [op('attendance', att('present'))]);
  assert(p.applied.length === 1, 'present ' + J(p));
  const other = push(teacher.id, [op('attendance', att('absent', today))]);
  assert(other.applied.length === 1, 'another day ' + J(other));
  return 'teacher role_denied; absent/late day_off; present ok; today unaffected';
});

check('D03', 'cloud scope + Dart twin', () => {
  const all = { all: true, role: 'manager' };
  assert(scope.canWriteRow(all, 'calendar', day()).ok, 'cloud ok');
  assert(scope.canWriteRow(all, 'calendar', day({ kind: 'x' })).error === 'bad_kind', 'cloud kind');
  const dart = fs.readFileSync(path.join(ROOT, 'apps/payesh/packages/payesh_sync/lib/src/school_calendar.dart'), 'utf8');
  for (const c of ['bad_date', 'bad_kind', 'reason_required', 'reason_too_long', 'bad_range']) assert(dart.includes(`'${c}'`), 'Dart ' + c);
  for (const [k, v] of Object.entries(cal.DAY_KIND_FA)) assert(dart.includes(`${k}('${v}')`), 'Dart kind ' + k);
  const att = fs.readFileSync(path.join(ROOT, 'apps/payesh/packages/payesh_sync/lib/src/attendance.dart'), 'utf8');
  assert(/AttendanceError\.dayOff/.test(att), 'Dart attendance refuses');
  return 'cloud = local; Dart codes + kinds';
});

function web(role, user) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
  win.eval(strip('client/lib/xlsx.js') + '\n;\n' + strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
    + '\n;window.__t = { S, PAGES, list, putLocal, actDayOffAdd, actAttendanceSave, dayOffOf, handleForm: typeof handleForm === "function" ? handleForm : null, onSubmit: typeof onSubmit === "function" ? onSubmit : null };');
  const T = win.__t;
  T.S.user = user; T.S.role = role; T.S.session = 'x';
  T.S.data = {
    schools: new Map([[1, { id: 1, level: 'متوسطه اول' }]]),
    users: new Map([[1, { id: 1, name: 'مدیر', role: 'manager' }], [5, { id: 5, name: 'سارا', role: 'student', class_id: 10, active: true }],
      [7, { id: 7, name: 'دبیر', role: 'teacher' }], [9, { id: 9, name: 'ولی', role: 'parent' }]]),
    classes: new Map([[10, { id: 10, name: 'هفتم' }]]),
    schedule: new Map([[1, { id: 1, class_id: 10, teacher_id: 7, subject_id: 1, weekday: 1, bell_order: 1 }]]),
    subjects: new Map([[1, { id: 1, name: 'ریاضی' }]]),
    parent_links: new Map([[1, { id: 1, parent_id: 9, student_id: 5 }]]),
    exams: new Map([[1, { id: 1, date: tomorrow, title: 'ریاضی میان‌نوبت', kind: 'internal', class_id: 10 }],
      [2, { id: 2, date: tomorrow, title: 'امتحان نهایی', kind: 'national' }], [3, { id: 3, date: later, title: 'علوم', kind: 'internal' }]]),
    lookups: new Map(), grades: new Map(), attendance: new Map(), announcements: new Map(), calendar: new Map(), leaves: new Map(),
  };
  T.S.queue = []; T.S.online = false;
  win.flushQueue = async () => {};
  win.confirm = () => true;
  return { win, T, doc: win.document };
}
async function submit(w, sel) {
  const form = w.doc.querySelector(sel);
  assert(form, 'form ' + sel);
  form.dispatchEvent(new w.win.Event('submit', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5));
}

check('D04', 'web manager announces a closed day', async () => {
  const w = web('manager', { id: 1, name: 'مدیر', role: 'manager' });
  w.doc.getElementById('app').innerHTML = w.T.PAGES.announcements();
  assert(w.doc.querySelector('[data-act="dayoff-add"]'), 'button');
  w.T.actDayOffAdd();
  const f = w.doc.querySelector('form[data-form="dayoff"]');
  assert(f && f.querySelector('[name="date"]').value === tomorrow, 'default tomorrow');
  f.querySelector('[name="reason"]').value = 'آلودگی هوا';
  f.querySelector('[name="exams_to"]').value = later;
  await submit(w, 'form[data-form="dayoff"]');
  const c = w.T.list('calendar');
  assert(c.length === 1 && c[0].date === tomorrow && c[0].kind === 'closed' && c[0].exams_to === later, J(c));
  assert(cal.dayOffIssue(c[0]) === null, 'web row passes the server rule');
  const ann = w.T.list('announcements');
  assert(ann.length === 1 && ann[0].severity === 'important' && ann[0].title.startsWith('تعطیل') && ann[0].body.includes('آلودگی هوا'), J(ann));
  const ex = w.T.list('exams');
  assert(ex.find(x => x.id === 1).date === later && ex.find(x => x.id === 1).moved_from === tomorrow, 'internal exam moved');
  assert(ex.find(x => x.id === 2).date === tomorrow, 'national exam stays');
  assert(ex.find(x => x.id === 3).date === later, 'other day untouched');
  w.doc.getElementById('app').innerHTML = w.T.PAGES.announcements();
  assert(w.doc.querySelector(`[data-dayoff-row="${c[0].id}"]`), 'listed');
  return 'calendar + important notice + 1 internal exam moved, national kept';
});

check('D05', 'web attendance on a closed / remote day', async () => {
  const w = web('teacher', { id: 7, name: 'دبیر', role: 'teacher' });
  w.T.putLocal('calendar', { date: today, kind: 'closed', reason: 'کمبود انرژی' });
  w.doc.getElementById('app').innerHTML = w.T.PAGES.attendance(['10']);
  assert(w.doc.querySelector('[data-dayoff="att"]') && !w.doc.querySelector('[data-act="att-save"]'), 'closed: banner, no save');
  await w.T.actAttendanceSave(10, '1');
  assert(!w.T.list('attendance').length, 'closed: nothing saved');
  w.T.S.data.calendar.forEach(r => { r.kind = 'remote'; });
  w.doc.getElementById('app').innerHTML = w.T.PAGES.attendance(['10']);
  assert(w.doc.querySelector('[data-dayoff="att"]') && w.doc.querySelector('[data-act="att-save"]'), 'remote: banner + save');
  w.T.S.attDraft = { key: '10:' + today, map: new Map([[5, 'absent']]) };
  await w.T.actAttendanceSave(10, '1');
  assert(!w.T.list('attendance').length, 'remote: absence skipped');
  w.T.S.attDraft = { key: '10:' + today, map: new Map([[5, 'present']]) };
  await w.T.actAttendanceSave(10, '1');
  assert(w.T.list('attendance').length === 1 && w.T.list('attendance')[0].status === 'present', 'remote: present saved');
  return 'closed blocked, remote present only';
});

check('D06', 'web homes + announcements show tomorrow', () => {
  for (const [role, user] of [['parent', { id: 9, name: 'ولی', role: 'parent' }], ['teacher', { id: 7, name: 'دبیر', role: 'teacher' }], ['student', { id: 5, name: 'سارا', role: 'student', class_id: 10 }]]) {
    const w = web(role, user);
    w.T.putLocal('calendar', { date: tomorrow, kind: 'remote', reason: 'آلودگی هوا' });
    w.doc.getElementById('app').innerHTML = w.T.PAGES.home([]);
    const b = w.doc.querySelector('[data-dayoff="tomorrow"]');
    assert(b && b.textContent.includes('غیرحضوری') && b.textContent.includes('آلودگی هوا'), role + ' home');
    w.doc.getElementById('app').innerHTML = w.T.PAGES.announcements();
    assert(w.doc.querySelector('[data-dayoff="tomorrow"]'), role + ' announcements');
  }
  return 'parent/teacher/student';
});

check('D07', 'negative controls', () => {
  const later2 = iso(5);
  const a = push(teacher.id, [op('attendance', att('absent', later2))]);
  assert(a.applied.length === 1, 'no day off ⇒ absence accepted ' + J(a));
  const row = st.all('calendar')[0];
  const del = sync.push(st, actor(mgr.id), { ops: [{ uid: 'd197-del', collection: 'calendar', type: 'del', id: row.id, base_version: row._version }] });
  assert(del.applied.length === 1, 'cancel ' + J(del));
  assert(!st.all('calendar').length, 'calendar left: ' + J(st.all('calendar')));
  const b = push(teacher.id, [op('attendance', att('absent'))]);
  assert(b.applied.length === 1, 'cancelled ⇒ absence accepted ' + J(b));
  return 'absences accepted without / after the day off';
});

(async () => {
  for (const p of pending) await p();
  try { st.db.close(); fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (!failed) console.log('DAY-OFF-197-OK');
  process.exit(failed ? 1 : 0);
})();
