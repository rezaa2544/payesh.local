#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 197 — Q12 / F21 «دانش‌آموز»: report card, average, own discipline, the exam calendar.

     R01  local server: exams manager-only (teacher/student role_denied); everyone reads them
     R02  local server + cloud scope: a student reads ONLY their own discipline notes
          (classmate's note never shipped); the counselor (F29) reads every note
     R03  web manager: «افزودن امتحان» writes the exams row (tomorrow by default, whole school);
          NEG no subject/title refused; «حذف» removes it; both acts are manager-only in authz
     R04  web student home: open homework, own class/cohort/school exams, the latest discipline;
          NEG the past homework, the other class's exam, the classmate's note; record not repeated
     R05  web «پروندهٔ من»: average = mean of numeric grades (one decimal, «٫»), report card one
          row per subject (descriptive = last level), own discipline; NEG no grade ⇒ «—»
     R06  Dart twin: same codes, slot, keys and the same report-card rule
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

const policy = require(path.join(ROOT, 'server/policy'));
const scope = require(path.join(ROOT, 'server/scope'));
const sync = require(path.join(ROOT, 'server/sync'));
const { openStore } = require(path.join(ROOT, 'server/db'));

const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const today = iso(0), tomorrow = iso(1), later = iso(3), past = iso(-5);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rec197-'));
const st = openStore(path.join(TMP, 'a.sqlite'));
st.insert('schools', { name: 'مدرسه', level: 'متوسطه دوم' }, { id: 1 });
const mgr = st.insert('users', { name: 'مدیر', role: 'manager', active: true });
st.insert('classes', { name: 'دهم', grade: '10' }, { id: 10 });
const s1 = st.insert('users', { name: 'سارا', role: 'student', class_id: 10, active: true });
const s2 = st.insert('users', { name: 'آرش', role: 'student', class_id: 10, active: true });
const teacher = st.insert('users', { name: 'دبیر', role: 'teacher', active: true });
const counselor = st.insert('users', { name: 'مشاور', role: 'counselor', active: true });
st.insert('schedule', { class_id: 10, teacher_id: teacher.id, subject_id: 1, weekday: 1, bell_order: 1, ref2: teacher.id });
let seq = 0;
const op = (collection, data) => ({ uid: `r197-${++seq}`, collection, type: 'put', data });
const actor = (id) => { const u = st.get('users', id); return { user: u, role: policy.permRole(u.role), device: null }; };
const push = (id, ops) => sync.push(st, actor(id), { ops });
check('R01', 'local server: exams manager-only, everyone reads', () => {
  const exam = { date: tomorrow, kind: 'internal', subject_id: 1, class_id: 10, title: 'میان‌نوبت' };
  for (const id of [teacher.id, s1.id]) {
    const r = push(id, [op('exams', exam)]);
    assert(r.rejected[0] && r.rejected[0].error === 'role_denied', 'non-manager ' + J(r));
  }
  const ok = push(mgr.id, [op('exams', exam)]);
  assert(ok.applied.length === 1, 'manager ' + J(ok));
  assert(policy.canRead('student', 'exams') && policy.canRead('parent', 'exams'), 'everyone reads');
  return 'teacher/student role_denied; manager applied; all read';
});

check('R02', 'a student reads only their own discipline notes', () => {
  const w = push(mgr.id, [
    op('discipline', { student_id: s1.id, kind: 'positive', note: 'همکاری', date: today }),
    op('discipline', { student_id: s2.id, kind: 'negative', note: 'همکلاسی', date: today }),
  ]);
  assert(w.applied.length === 2, 'manager writes ' + J(w));
  assert(policy.canRead('student', 'discipline'), 'student may read the collection');
  /* the cloud builder (server/scope.js) gives a student studentIds = [uid] */
  const sc = { role: 'student', uid: s1.id, all: false, studentIds: [s1.id], classIds: [10], cohorts: [] };
  assert(scope.rowInScope(sc, 'discipline', { student_id: s1.id }) === true, 'own note in cloud scope');
  assert(scope.rowInScope(sc, 'discipline', { student_id: s2.id }) === false, 'classmate note out of cloud scope');
  /* local server pull: the student's own note only */
  const mine = (sync.pull(st, actor(s1.id), { collections: 'discipline' }).collections.discipline || []);
  assert(mine.length === 1 && Number(mine[0].student_id) === s1.id, 'student pull ' + J(mine));
  const theirs = (sync.pull(st, actor(s2.id), { collections: 'discipline' }).collections.discipline || []);
  assert(theirs.length === 1 && Number(theirs[0].student_id) === s2.id, 'classmate pull ' + J(theirs));
  /* row 197 F29: the counselor reads every student's record (discipline included) — read-only */
  const c = sync.pull(st, actor(counselor.id), { collections: 'discipline' }).collections.discipline || [];
  assert(c.length === 2, 'counselor pull ' + J(c));
  return 'cloud own/classmate true/false; local pull 1/1; counselor (F29) 2';
});

function web(role, user, extra) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
  win.eval(strip('client/lib/xlsx.js') + '\n;\n' + strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
    + '\n;window.__t = { S, PAGES, list, putLocal, actExamAdd, studentHome, reportCardOf };');
  const T = win.__t;
  T.S.user = user; T.S.role = role; T.S.session = 'x';
  const m = (rows) => new Map(rows.map(r => [r.id, r]));
  T.S.data = Object.assign({
    schools: m([{ id: 1, level: 'متوسطه دوم' }]),
    users: m([{ id: 1, name: 'مدیر', role: 'manager' }, { id: 5, name: 'سارا', role: 'student', class_id: 10, active: true },
      { id: 6, name: 'آرش', role: 'student', class_id: 10, active: true }]),
    classes: m([{ id: 10, name: 'دهم', grade: '10', branch: 'ریاضی' }, { id: 11, name: 'یازدهم', grade: '11' }]),
    schedule: new Map(),
    subjects: m([{ id: 1, name: 'ریاضی' }, { id: 2, name: 'هنر' }]),
    exams: m([{ id: 1, date: later, subject_id: 1, class_id: 10, title: 'میان‌نوبت', kind: 'internal' },
      { id: 2, date: later, subject_id: 1, class_id: 11, title: 'کلاس دیگر', kind: 'internal' },
      { id: 3, date: later, title: 'نهایی ریاضی', grade: '10', branch: 'ریاضی', kind: 'national' },
      { id: 4, date: past, title: 'گذشته', kind: 'internal' }]),
    homework: m([{ id: 1, class_id: 10, title: 'تمرین ۳۰', due: tomorrow, date: today },
      { id: 2, class_id: 10, title: 'تکلیف گذشته', due: past, date: past }]),
    discipline: m([{ id: 1, student_id: 5, kind: 'positive', note: 'همکاری در کلاس', date: today },
      { id: 2, student_id: 6, kind: 'negative', note: 'یادداشت همکلاسی', date: today }]),
    grades: m([{ id: 1, student_id: 5, subject_id: 1, score: 18 }, { id: 2, student_id: 5, subject_id: 1, score: 15 },
      { id: 3, student_id: 5, subject_id: 2, kind: 'descriptive', level: 'خیلی خوب' }]),
    lookups: new Map(), attendance: new Map(), announcements: new Map(), calendar: new Map(), leaves: new Map(), parent_links: new Map(),
  }, extra || {});
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
async function click(w, sel) {
  const el = w.doc.querySelector(sel);
  assert(el, 'button ' + sel);
  el.dispatchEvent(new w.win.MouseEvent('click', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5));
}

check('R03', 'web manager: «افزودن امتحان» and «حذف»', async () => {
  const w = web('manager', { id: 1, name: 'مدیر', role: 'manager' }, { exams: new Map() });
  w.doc.getElementById('app').innerHTML = w.T.PAGES.announcements();
  assert(w.doc.querySelector('[data-act="exam-add"]'), 'button');
  w.T.actExamAdd();
  let f = w.doc.querySelector('form[data-form="exam"]');
  assert(f && f.querySelector('[name="date"]').value === tomorrow, 'default tomorrow');
  await submit(w, 'form[data-form="exam"]');
  assert(!w.T.list('exams').length, 'NEG: no subject/title refused');
  f = w.doc.querySelector('form[data-form="exam"]');
  f.querySelector('[name="title"]').value = 'آزمون جامع';
  await submit(w, 'form[data-form="exam"]');
  const ex = w.T.list('exams');
  assert(ex.length === 1 && ex[0].date === tomorrow && ex[0].kind === 'internal' && ex[0].class_id == null && ex[0].title === 'آزمون جامع', J(ex));
  w.doc.getElementById('app').innerHTML = w.T.PAGES.announcements();
  assert(w.doc.querySelector(`[data-exam-row="${ex[0].id}"]`), 'listed');
  await click(w, `[data-act="exam-delete"][data-id="${ex[0].id}"]`);
  assert(!w.T.list('exams').filter(x => !x.deleted).length, 'deleted ' + J(w.T.list('exams')));
  const authz = fs.readFileSync(path.join(ROOT, 'client/authz.js'), 'utf8');
  const mo = authz.match(/const AUTHZ_MANAGER_ONLY = \/\^\((.*)\)\$\//);
  assert(mo && mo[1].split('|').includes('exam-add') && mo[1].split('|').includes('exam-delete'), 'authz manager-only');
  return 'refused empty; written tomorrow/whole school; listed; deleted; authz';
});

check('R04', 'web student home', () => {
  const w = web('student', { id: 5, name: 'سارا', role: 'student', class_id: 10 });
  w.doc.getElementById('app').innerHTML = w.T.studentHome();
  const hw = w.doc.querySelector('[data-home="homework"]').textContent;
  assert(hw.includes('تمرین ۳۰') && !hw.includes('تکلیف گذشته'), 'homework ' + hw);
  const ex = w.doc.querySelector('[data-home="exams"]').textContent;
  assert(ex.includes('ریاضی — میان‌نوبت') && ex.includes('نهایی ریاضی'), 'own exams ' + ex);
  assert(!ex.includes('کلاس دیگر') && !ex.includes('گذشته'), 'NEG other class / past ' + ex);
  const d = w.doc.querySelector('[data-home="discipline"]').textContent;
  assert(d.includes('همکاری در کلاس') && !d.includes('یادداشت همکلاسی'), 'discipline ' + d);
  assert(!w.doc.querySelector('[data-rec="report-card"]') && !w.doc.body.textContent.includes('پروندهٔ من'), 'record not repeated');
  return 'homework 1, exams 2, discipline own only';
});

check('R05', 'web «پروندهٔ من»', () => {
  const w = web('student', { id: 5, name: 'سارا', role: 'student', class_id: 10 });
  w.doc.getElementById('app').innerHTML = w.T.PAGES.record();
  const avg = w.doc.querySelector('[data-rec="average"]').textContent;
  assert(avg.includes('۱۶٫۵') && avg.includes('معدل'), 'average ' + avg);
  const rc = [...w.doc.querySelectorAll('[data-rec="report-card"] tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim()));
  assert(J(rc) === J([['ریاضی', '۱۶٫۵'], ['هنر', 'خیلی خوب']]), 'report card ' + J(rc));
  const d = w.doc.querySelector('[data-disc="record"]').closest('.card').textContent;
  assert(d.includes('همکاری در کلاس') && !d.includes('یادداشت همکلاسی'), 'discipline ' + d);
  const n = web('student', { id: 5, name: 'سارا', role: 'student', class_id: 10 }, { grades: new Map() });
  n.doc.getElementById('app').innerHTML = n.T.PAGES.record();
  assert(/—/.test(n.doc.querySelector('[data-rec="average"]').textContent) && !/۰٫۰/.test(n.doc.querySelector('[data-rec="average"]').textContent), 'NEG no grade «—»');
  assert(n.doc.querySelector('[data-rec="report-empty"]'), 'NEG empty report card');
  return 'avg ۱۶٫۵; ریاضی ۱۶٫۵, هنر خیلی خوب; own discipline; no grade «—»';
});

check('R06', 'Dart twin', () => {
  const ex = fs.readFileSync(path.join(ROOT, 'apps/payesh/packages/payesh_sync/lib/src/school_exams.dart'), 'utf8');
  for (const c of ['not_allowed', 'bad_date', 'text_required', 'text_too_long']) assert(ex.includes(`'${c}'`), 'Dart ' + c);
  assert(/internal\('داخلی'\)/.test(ex) && /national\('نهایی'\)/.test(ex), 'Dart kinds');
  const rec = fs.readFileSync(path.join(ROOT, 'apps/payesh/packages/payesh_sync/lib/src/records.dart'), 'utf8');
  /* ردیف ۱۹۷ (F27/F29): parent_msgs و counselor_notes پس از exams آمدند — exams همچنان در idSlots */
  const slots = (rec.match(/idSlots = \[([\s\S]*?)\];/) || [])[1] || '';
  assert(/'exams',/.test(slots), 'exams id slot');
  assert(/'discipline': CollectionRule\([\s\S]*?'student'\}/.test(rec), 'Dart student reads discipline');
  const ui = fs.readFileSync(path.join(ROOT, 'apps/payesh/app/lib/src/users/users_screen.dart'), 'utf8');
  for (const k of ['rec-average', 'rec-report-card', 'rec-discipline', 'home-discipline']) assert(ui.includes(`'${k}'`), 'Dart key ' + k);
  assert(ui.includes("'عنوان درس'"), 'same report-card header');
  return 'codes, kinds, slot, read rule, keys';
});

(async () => {
  for (const p of pending) await p();
  try { st.db.close(); fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (!failed) console.log('STUDENT-RECORD-197-OK');
  process.exit(failed ? 1 : 0);
})();
