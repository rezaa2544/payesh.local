#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 197 — Q12 (F19): the teacher's class tools. A teacher had no «اطلاعیه» button, no homework,
   no discipline note and no «ارجاع به مشاور», and «دانش‌آموزان من» showed 0 with no reason.

     T01  server/policy.js classNoteIssue: homework / class notice / discipline shapes
     T02  local server writes: a class notice only for the teacher's own class, author stamped;
          never a school-wide notice; another teacher cannot edit it; a teacher deletes only
          their own homework / notice (other deletes stay manager-only)
     T03  local server reads: a class notice reaches that class, its author and the manager only;
          a teacher reads back only their own referrals and never counselor notes
     T04  referral + discipline: own students / own class only, «open» only, reason/text required
     T05  cloud scope (server/scope.js) mirrors T02–T04 incl. the SQL predicate
     T06  web teacher: homework, discipline and referral forms; class notice with a class; the
          announcement list hides other classes' notices; the empty «دانش‌آموزان من» says why
     T07  Dart twin + parity matrix entries
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt197-'));
const st = openStore(path.join(TMP, 'a.sqlite'));
st.insert('schools', { name: 'مدرسه', level: 'متوسطه اول' }, { id: 1 });
const mgr = st.insert('users', { name: 'مدیر', role: 'manager', active: true });
st.insert('classes', { name: 'هفتم الف' }, { id: 10 });
st.insert('classes', { name: 'هشتم ب' }, { id: 11 });
const t1 = st.insert('users', { name: 'دبیر علوم', role: 'teacher', active: true });
const t2 = st.insert('users', { name: 'دبیر ریاضی', role: 'teacher', active: true });
const s1 = st.insert('users', { name: 'بهار', role: 'student', class_id: 10, active: true });
const s2 = st.insert('users', { name: 'آرش', role: 'student', class_id: 11, active: true });
const couns = st.insert('users', { name: 'مشاور', role: 'counselor', active: true });
st.insert('schedule', { class_id: 10, teacher_id: t1.id, subject_id: 1, weekday: 1, bell_order: 1, ref2: t1.id });
st.insert('schedule', { class_id: 11, teacher_id: t2.id, subject_id: 1, weekday: 1, bell_order: 2, ref2: t2.id });
let seq = 0;
const op = (collection, data, extra) => Object.assign({ uid: `tt197-${++seq}`, collection, type: 'put', data }, extra || {});
const actor = (id) => { const u = st.get('users', id); return { user: u, role: policy.permRole(u.role), device: null }; };
const push = (id, ops) => sync.push(st, actor(id), { ops });
const del = (id, collection, row) => push(id, [{ uid: `tt197-${++seq}`, collection, type: 'del', id: row.id, base_version: row._version }]);
const pullAll = (id) => sync.pull(st, actor(id), {}).collections || {};
const titles = (rows) => (rows || []).map(r => r.title).sort().join('|');

check('T01', 'classNoteIssue shapes', () => {
  const ci = policy.classNoteIssue;
  assert(ci('homework', { title: 'تمرین', due: '2026-11-20' }) === null, 'hw ok');
  assert(ci('homework', { title: ' ' }) === 'text_required', 'hw title');
  assert(ci('homework', { title: 'x'.repeat(201) }) === 'text_too_long', 'hw long');
  assert(ci('homework', { title: 'x', due: '1405/09/06' }) === 'bad_date', 'hw due');
  assert(ci('announcements', { title: 'x', body: 'y'.repeat(4001) }) === 'text_too_long', 'ann long');
  assert(ci('discipline', { kind: 'positive', note: 'آفرین' }) === null, 'disc ok');
  assert(ci('discipline', { kind: 'reward', note: 'x' }) === 'bad_kind', 'disc kind');
  assert(ci('discipline', { kind: 'note', note: '' }) === 'text_required', 'disc text');
  return 'text_required,text_too_long,bad_date,bad_kind';
});

check('T02', 'local server writes: class notice + homework own class / own rows', () => {
  const wide = push(t1.id, [op('announcements', { title: 'کل مدرسه', body: 'x', severity: 'normal' })]);
  assert(wide.rejected[0] && wide.rejected[0].error === 'role_denied', 'school-wide ' + J(wide));
  const other = push(t1.id, [op('announcements', { title: 'کلاس دیگر', body: 'x', class_id: 11 })]);
  assert(other.rejected[0].error === 'out_of_scope', 'other class ' + J(other));
  const ok = push(t1.id, [op('announcements', { title: 'آزمونک شنبه', body: 'فصل ۳', class_id: 10, author_id: t2.id })]);
  assert(ok.applied.length === 1, J(ok));
  const ann = st.get('announcements', ok.applied[0].id);
  assert(Number(ann.author_id) === t1.id, 'author stamped by the server, not the client: ' + J(ann));
  // t2 also teaches class 10 now — still cannot edit t1's notice
  st.insert('schedule', { class_id: 10, teacher_id: t2.id, subject_id: 2, weekday: 2, bell_order: 1, ref2: t2.id });
  const steal = push(t2.id, [op('announcements', { title: 'تغییر', body: 'x', class_id: 10 }, { id: ann.id, base_version: ann._version })]);
  assert(steal.rejected[0] && steal.rejected[0].error === 'not_author', 'other teacher edit ' + J(steal));
  const hw = push(t1.id, [op('homework', { title: 'تمرین ۱ تا ۵', class_id: 10, due: '2026-11-20' })]);
  assert(hw.applied.length === 1, J(hw));
  const hwRow = st.get('homework', hw.applied[0].id);
  const hw2 = push(t2.id, [op('homework', { title: 'تکلیف ریاضی', class_id: 11 })]);
  const hw2Row = st.get('homework', hw2.applied[0].id);
  const d1 = del(t1.id, 'homework', hw2Row);
  assert(d1.rejected[0] && d1.rejected[0].error === 'role_denied', 'delete another teacher\'s homework ' + J(d1));
  const mAnn = push(mgr.id, [op('announcements', { title: 'اردو', body: 'x', severity: 'info' })]);
  const d2 = del(t1.id, 'announcements', st.get('announcements', mAnn.applied[0].id));
  assert(d2.rejected[0].error === 'role_denied', 'delete the manager\'s notice ' + J(d2));
  const d3 = del(t1.id, 'homework', hwRow);
  assert(d3.applied.length === 1 && !st.get('homework', hwRow.id), 'own homework deleted ' + J(d3));
  const d4 = del(t1.id, 'attendance', { id: 999999, _version: 1 });
  assert(d4.rejected[0].error === 'not_found', 'unrelated delete unchanged');
  return 'role_denied (school-wide), out_of_scope, not_author; own homework deleted, others refused';
});

check('T03', 'local server reads: class notice audience; teacher sees own referrals only', () => {
  push(mgr.id, [op('announcements', { title: 'کلاس هشتم', body: 'x', class_id: 11 })]);
  const seen = (id) => titles(pullAll(id).announcements);
  assert(seen(s1.id).includes('آزمونک شنبه') && !seen(s1.id).includes('کلاس هشتم'), 'student of class 10: ' + seen(s1.id));
  assert(!seen(s2.id).includes('آزمونک شنبه') && seen(s2.id).includes('کلاس هشتم'), 'student of class 11: ' + seen(s2.id));
  assert(seen(s1.id).includes('اردو') && seen(s2.id).includes('اردو'), 'school-wide reaches everyone');
  assert(seen(couns.id).includes('اردو') && !seen(couns.id).includes('آزمونک شنبه'), 'counselor: no class notices');
  assert(seen(mgr.id).includes('آزمونک شنبه') && seen(mgr.id).includes('کلاس هشتم'), 'manager sees all');
  assert(seen(t1.id).includes('آزمونک شنبه'), 'author sees it');
  // referrals: t1 refers s1; the counselor's own referral of s2 is not visible to t1
  push(t1.id, [op('counselor_refs', { student_id: s1.id, reason: 'افت نمره', status: 'open' })]);
  push(mgr.id, [op('counselor_refs', { student_id: s2.id, reason: 'غیبت مکرر', status: 'open', referred_by: mgr.id })]);
  push(couns.id, [op('counselor_notes', { student_id: s1.id, note: 'محرمانه' })]);
  const mine = pullAll(t1.id);
  assert((mine.counselor_refs || []).length === 1 && Number(mine.counselor_refs[0].referred_by) === t1.id, 'teacher refs ' + J(mine.counselor_refs));
  assert(!(mine.counselor_notes || []).length, 'teacher never reads counselor notes');
  assert((pullAll(couns.id).counselor_refs || []).length === 2, 'counselor reads every referral');
  assert(!(pullAll(s1.id).counselor_refs || []).length, 'a student reads no referral');
  return 'class 10 / class 11 / counselor / manager / author; refs: own only, notes never';
});

check('T04', 'referral + discipline: own students / class, open only', () => {
  const r1 = push(t1.id, [op('counselor_refs', { student_id: s2.id, reason: 'x', status: 'open' })]);
  // t2 teaches class 10 too after T02; t1 only class 10
  assert(r1.rejected[0].error === 'out_of_scope', 'other class student ' + J(r1));
  const r2 = push(t1.id, [op('counselor_refs', { student_id: s1.id, reason: ' ', status: 'open' })]);
  assert(r2.rejected[0].error === 'reason_required', J(r2));
  const r3 = push(t1.id, [op('counselor_refs', { student_id: s1.id, reason: 'x', status: 'handled' })]);
  assert(r3.rejected[0].error === 'approval_denied', J(r3));
  const r4 = push(t1.id, [op('counselor_refs', { student_id: s1.id, reason: 'بی‌حوصلگی', status: 'open', referred_by: mgr.id })]);
  assert(Number(st.get('counselor_refs', r4.applied[0].id).referred_by) === t1.id, 'referred_by stamped');
  const d1 = push(t1.id, [op('discipline', { student_id: s1.id, class_id: 10, kind: 'positive', note: 'فعالیت عالی', date: '2026-11-10' })]);
  assert(d1.applied.length === 1, J(d1));
  const d2 = push(t1.id, [op('discipline', { student_id: s2.id, class_id: 11, kind: 'negative', note: 'x' })]);
  assert(d2.rejected[0].error === 'out_of_scope', J(d2));
  const d3 = push(t1.id, [op('discipline', { student_id: s1.id, class_id: 10, kind: 'negative', note: '' })]);
  assert(d3.rejected[0].error === 'text_required', J(d3));
  return 'out_of_scope, reason_required, approval_denied, referred_by stamped; discipline ok / out_of_scope / text_required';
});

check('T05', 'cloud scope mirrors (canWriteRow, rowInScope, sqlPredicate)', () => {
  const sc = { role: 'teacher', uid: 7, all: false, classIds: [10], studentIds: [5], cohorts: [], grantRead: [], grantWrite: [] };
  const w = (c, row, ex) => scope.canWriteRow(sc, c, row, ex || null);
  assert(w('announcements', { title: 'x', author_id: 7 }).error === 'role_denied', 'school-wide');
  assert(w('announcements', { title: 'x', class_id: 11, author_id: 7 }).error === 'out_of_scope', 'other class');
  assert(w('announcements', { title: 'x', class_id: 10, author_id: 8 }).error === 'not_author', 'forged author');
  assert(w('announcements', { title: 'x', class_id: 10, author_id: 7 }).ok, 'own class');
  assert(w('announcements', { title: 'x', class_id: 10, author_id: 7 }, { class_id: 10, author_id: 8 }).error === 'not_author', 'edit other');
  const own = { id: 3, class_id: 10, title: 'x', author_id: 7 };
  assert(scope.canWriteRow(sc, 'homework', own, own).ok, 'delete own homework');
  const theirs = { id: 4, class_id: 10, title: 'x', author_id: 8 };
  assert(scope.canWriteRow(sc, 'homework', theirs, theirs).error === 'not_author', 'delete other homework');
  assert(w('homework', { title: '' , class_id: 10, author_id: 7 }).error === 'text_required', 'shape');
  assert(w('counselor_refs', { student_id: 5, reason: 'x', status: 'open', referred_by: 9 }).error === 'not_author', 'forged referrer');
  assert(w('counselor_refs', { student_id: 6, reason: 'x', status: 'open', referred_by: 7 }).error === 'out_of_scope', 'other student');
  assert(w('counselor_refs', { student_id: 5, reason: 'x', status: 'open', referred_by: 7 }).ok, 'own student');
  assert(w('discipline', { student_id: 5, class_id: 10, kind: 'note', note: '' }).error === 'text_required', 'disc text');
  const rs = (c, row) => scope.rowInScope(sc, c, row);
  assert(rs('announcements', { title: 'x' }) && rs('announcements', { class_id: 10 }) && !rs('announcements', { class_id: 11 }), 'ann scope');
  assert(rs('announcements', { class_id: 11, author_id: 7 }), 'author reads own');
  assert(rs('counselor_refs', { referred_by: 7 }) && !rs('counselor_refs', { referred_by: 9 }), 'refs scope');
  assert(!rs('counselor_notes', { student_id: 5 }), 'notes never');
  const pred = scope.sqlPredicate(sc, 1).sql;
  assert(/r\.collection = 'announcements' and/.test(pred), 'ann predicate: ' + pred);
  assert(/r\.collection = 'counselor_refs' and .*referred_by/.test(pred), 'refs predicate');
  assert(!/'announcements'[,)]/.test(pred.split("r.collection = 'announcements'")[0]), 'announcements no longer open');
  const par = scope.sqlPredicate({ role: 'parent', uid: 9, all: false, classIds: [10], studentIds: [5], cohorts: [], grantRead: [], grantWrite: [] }, 1).sql;
  assert(!/counselor_refs' and \(/.test(par) && !/referred_by/.test(par), 'parent: no referral piece');
  return 'cloud = local';
});

function web(role, user, extra) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
  win.eval(strip('client/lib/xlsx.js') + '\n;\n' + strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
    + '\n;window.__t = { S, PAGES, list, putLocal, actHwAdd, actDiscAdd, actCrefAdd, actAnnAdd: typeof actAnnAdd === "function" ? actAnnAdd : null, visibleAnnouncements, authz: typeof authzAllowed === "function" ? authzAllowed : null };');
  const T = win.__t;
  T.S.user = user; T.S.role = role; T.S.session = 'x';
  T.S.data = Object.assign({
    schools: new Map([[1, { id: 1, level: 'متوسطه اول' }]]),
    users: new Map([[1, { id: 1, name: 'مدیر', role: 'manager' }], [5, { id: 5, name: 'بهار', role: 'student', class_id: 10, active: true }],
      [6, { id: 6, name: 'آرش', role: 'student', class_id: 11, active: true }], [7, { id: 7, name: 'دبیر علوم', role: 'teacher' }]]),
    classes: new Map([[10, { id: 10, name: 'هفتم الف' }], [11, { id: 11, name: 'هشتم ب' }]]),
    schedule: new Map([[1, { id: 1, class_id: 10, teacher_id: 7, subject_id: 1, weekday: 1, bell_order: 1 }]]),
    subjects: new Map([[1, { id: 1, name: 'علوم' }]]),
    announcements: new Map([[1, { id: 1, title: 'اردو', date: '2026-11-01' }], [2, { id: 2, title: 'کلاس هشتم', class_id: 11, author_id: 1, date: '2026-11-02' }],
      [3, { id: 3, title: 'آزمونک', class_id: 10, author_id: 1, date: '2026-11-03' }]]),
    lookups: new Map(), grades: new Map(), attendance: new Map(), calendar: new Map(), leaves: new Map(), parent_links: new Map(),
    homework: new Map(), discipline: new Map(), counselor_refs: new Map(), exams: new Map(),
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
const tick = () => new Promise(r => setTimeout(r, 100));

check('T06', 'web teacher: homework, discipline, referral, class notice, empty state', async () => {
  const w = web('teacher', { id: 7, name: 'دبیر علوم', role: 'teacher' });
  await tick();
  w.T.S.user = { id: 7, name: 'دبیر علوم', role: 'teacher' }; w.T.S.role = 'teacher';
  // announcements: the other class's notice is hidden; «+ اطلاعیهٔ کلاس» is there
  const vis = w.T.visibleAnnouncements().map(a => a.title).sort().join('|');
  assert(vis === 'آزمونک|اردو', 'visible ' + vis);
  w.doc.getElementById('app').innerHTML = w.T.PAGES.announcements();
  assert(w.doc.querySelector('[data-act="ann-add"]'), 'class notice button');
  assert(!w.doc.querySelector('[data-act="dayoff-add"]'), 'no day-off for a teacher');
  // students: discipline + referral per row, own class only
  w.doc.getElementById('app').innerHTML = w.T.PAGES.students();
  assert(w.doc.querySelector('[data-act="disc-add"][data-id="5"]') && w.doc.querySelector('[data-act="cref-add"][data-id="5"]'), 'row actions');
  assert(!w.doc.querySelector('[data-id="6"]'), 'no other-class student');
  // homework
  w.T.actHwAdd();
  let f = w.doc.querySelector('form[data-form="hw"]');
  assert(f && f.querySelector('[name="class_id"]').options.length === 1, 'own class only');
  f.querySelector('[name="title"]').value = 'تمرین صفحهٔ ۴۲';
  f.querySelector('[name="due"]').value = '2026-11-20';
  await submit(w, 'form[data-form="hw"]');
  const hw = w.T.list('homework');
  assert(hw.length === 1 && Number(hw[0].class_id) === 10 && Number(hw[0].author_id) === 7 && policy.classNoteIssue('homework', hw[0]) === null, J(hw));
  // discipline
  w.T.actDiscAdd(5);
  f = w.doc.querySelector('form[data-form="disc"]');
  f.querySelector('[name="kind"]').value = 'positive';
  f.querySelector('[name="note"]').value = 'فعالیت عالی';
  await submit(w, 'form[data-form="disc"]');
  const d = w.T.list('discipline');
  assert(d.length === 1 && d[0].kind === 'positive' && Number(d[0].class_id) === 10 && policy.classNoteIssue('discipline', d[0]) === null, J(d));
  // referral: only own students offered
  w.T.actCrefAdd(5);
  f = w.doc.querySelector('form[data-form="cref"]');
  const opts = [...f.querySelector('[name="student_id"]').options].map(o => o.value).filter(Boolean);
  assert(J(opts) === J(['5']), 'own students only ' + J(opts));
  f.querySelector('[name="reason"]').value = 'افت ناگهانی';
  await submit(w, 'form[data-form="cref"]');
  const r = w.T.list('counselor_refs');
  assert(r.length === 1 && Number(r[0].referred_by) === 7 && r[0].status === 'open', J(r));
  // class notice
  assert(w.T.actAnnAdd, 'actAnnAdd');
  {
    w.T.actAnnAdd();
    f = w.doc.querySelector('form[data-form="ann"]');
    assert(f && f.querySelector('[name="class_id"]'), 'class select');
    f.querySelector('[name="class_id"]').value = '10';
    f.querySelector('[name="title"]').value = 'آزمونک شنبه';
    f.querySelector('[name="body"]').value = 'فصل ۳';
    await submit(w, 'form[data-form="ann"]');
    const a = w.T.list('announcements').find(x => x.title === 'آزمونک شنبه');
    assert(a && Number(a.class_id) === 10 && Number(a.author_id) === 7, 'class notice ' + J(a));
  }
  // a teacher with no timetable: the empty list says why, no notice button
  const e = web('teacher', { id: 7, name: 'دبیر علوم', role: 'teacher' }, { schedule: new Map() });
  await tick();
  e.T.S.user = { id: 7, name: 'دبیر علوم', role: 'teacher' }; e.T.S.role = 'teacher';
  e.doc.getElementById('app').innerHTML = e.T.PAGES.students();
  assert(e.doc.body.textContent.includes('برنامهٔ هفتگی'), 'empty state explains');
  e.doc.getElementById('app').innerHTML = e.T.PAGES.announcements();
  assert(!e.doc.querySelector('[data-act="ann-add"]'), 'no class ⇒ no notice button');
  return 'hw/disc/cref/ann rows pass the server shape; other class hidden; empty state explained';
});

check('T07', 'Dart twin + parity matrix', () => {
  const lib = (f) => fs.readFileSync(path.join(ROOT, 'apps/payesh/packages/payesh_sync/lib/src', f), 'utf8');
  const cn = lib('class_notes.dart');
  for (const c of ['text_required', 'text_too_long', 'bad_date', 'out_of_scope', 'not_author']) assert(cn.includes(`'${c}'`), 'Dart ' + c);
  for (const [k, v] of Object.entries({ positive: 'تشویق', negative: 'تذکر', note: 'یادداشت' })) assert(cn.includes(`${k}('${k}', '${v}')`), 'kind ' + k);
  assert(/static const int title = 200;/.test(cn) && /homeworkBody = 2000;/.test(cn) && /disciplineNote = 1000;/.test(cn), 'limits = NOTE_LIMITS');
  assert(/'class_id': \?classId/.test(lib('notices.dart')), 'Dart notice carries class_id');
  assert(/out_of_scope/.test(lib('counselor.dart')), 'Dart referral own students');
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/cloud/128-parity-matrix.json'), 'utf8'));
  for (const id of ['act:hw-add', 'act:hw-delete', 'act:disc-add', 'form:hw', 'form:disc']) {
    const it = m.items.find(x => x.id === id);
    assert(it && it.status === 'native', 'matrix ' + id);
  }
  return 'codes, kinds, limits, matrix';
});

(async () => {
  for (const p of pending) await p();
  try { st.db.close(); fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (!failed) console.log('TEACHER-TOOLS-197-OK');
  process.exit(failed ? 1 : 0);
})();
