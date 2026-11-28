#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 197 — Q12 / F27 «ولی» and F29 «مشاور»: messages, counseling appointments, the child's
   full record for the parent, and the counselor's student search / sessions / guidance.

     F01  parent → school / a teacher of the child (from the class schedule) / the counselor:
          applied, parent_id stamped, status open; NEG another child, a reply/approval field,
          no text, teacher without teacher_id, an appointment with a teacher, change of recipient,
          the other parent editing, editing once answered
     F02  recipients: the teacher answers only the message to them (replied_by stamped); NEG a
          colleague's message, creating, changing the text; the counselor schedules a requested
          appointment and books one itself; NEG a «message» it creates, a message to the school
     F03  pull: both parents see the child's threads; the teacher only theirs; the counselor only
          «به مشاور»; the student none
     F04  counselor (F29): every student's grades/attendance on pull; session + guidance notes;
          NEG guidance with an unknown track, a session with no text, a teacher writing notes,
          the counselor writing a grade
     F05  cloud mirror (server/scope.js, no existing row on put): parent must stamp itself; the
          recipient must stamp replied_by; NEG «open» from a recipient, a teacher scheduling
     F06  contributions: the parent pulls the rows of their own child only
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
const pm = require(path.join(ROOT, 'server/parent-msgs'));
const { openStore } = require(path.join(ROOT, 'server/db'));

const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const today = iso(0), later = iso(3);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fam197-'));
const st = openStore(path.join(TMP, 'a.sqlite'));
st.insert('schools', { name: 'مدرسه', level: 'متوسطه اول', school_type: 'non_profit' }, { id: 1 });
const mgr = st.insert('users', { name: 'مدیر', role: 'manager', active: true });
st.insert('classes', { name: 'نهم الف', grade: 'نهم' }, { id: 10 });
st.insert('classes', { name: 'نهم ب', grade: 'نهم' }, { id: 11 });
st.insert('subjects', { name: 'ریاضی' }, { id: 1 });
const kid = st.insert('users', { name: 'سارا', role: 'student', class_id: 10, grade: 'نهم', active: true });
const other = st.insert('users', { name: 'آرش', role: 'student', class_id: 11, grade: 'نهم', active: true });
const teacher = st.insert('users', { name: 'دبیر ریاضی', role: 'teacher', active: true });
const colleague = st.insert('users', { name: 'دبیر دیگر', role: 'teacher', active: true });
const counselor = st.insert('users', { name: 'مشاور', role: 'counselor', active: true });
const mom = st.insert('users', { name: 'مادر سارا', role: 'parent', active: true });
const dad = st.insert('users', { name: 'پدر سارا', role: 'parent', active: true });
st.insert('parent_links', { parent_id: mom.id, student_id: kid.id });
st.insert('parent_links', { parent_id: dad.id, student_id: kid.id });
st.insert('schedule', { class_id: 10, teacher_id: teacher.id, subject_id: 1, weekday: 1, bell_order: 1, ref2: teacher.id });
st.insert('schedule', { class_id: 11, teacher_id: colleague.id, subject_id: 1, weekday: 1, bell_order: 1, ref2: colleague.id });

let seq = 0;
const op = (collection, data, extra) => Object.assign({ uid: `f197-${++seq}`, collection, type: 'put', data }, extra || {});
const actor = (id) => { const u = st.get('users', id); return { user: u, role: policy.permRole(u.role), device: null }; };
const push = (id, ops) => sync.push(st, actor(id), { ops });
const put1 = (id, collection, data, extra) => push(id, [op(collection, data, extra)]);
const err = (r) => (r.rejected[0] || {}).error || (r.conflicts[0] ? 'conflict' : '');
const upd = (id, row, patch) => put1(id, 'parent_msgs', Object.assign({}, patch), { id: row.id, base_version: st.get('parent_msgs', row.id)._version });
const pull = (id, c) => (sync.pull(st, actor(id), { collections: c }).collections[c] || []);

const ids = {};
check('F01', 'parent sends to the school, a teacher of the child and the counselor; NEG the other cases', () => {
  const school = put1(mom.id, 'parent_msgs', { student_id: kid.id, to: 'school', text: 'سلام، سارا فردا دیرتر می‌آید.' });
  assert(school.applied.length === 1, 'school ' + J(school));
  const row = st.get('parent_msgs', school.applied[0].id);
  assert(Number(row.parent_id) === mom.id && row.status === 'open' && row.kind === 'message', 'stamped ' + J(row));
  ids.school = row;
  const t = put1(mom.id, 'parent_msgs', { student_id: kid.id, to: 'teacher', teacher_id: teacher.id, subject_id: 1, text: 'تکلیف ریاضی را نفهمید.' });
  assert(t.applied.length === 1, 'teacher ' + J(t)); ids.teacher = st.get('parent_msgs', t.applied[0].id);
  const ap = put1(dad.id, 'parent_msgs', { student_id: kid.id, to: 'counselor', kind: 'appointment', want_date: later, text: 'نوبت مشاوره برای انتخاب رشته' });
  assert(ap.applied.length === 1, 'appointment ' + J(ap)); ids.appt = st.get('parent_msgs', ap.applied[0].id);
  /* NEG */
  const negs = [
    [{ student_id: other.id, to: 'school', text: 'x' }, 'out_of_scope'],
    [{ student_id: kid.id, to: 'school', text: 'x', status: 'answered' }, 'approval_denied'],
    [{ student_id: kid.id, to: 'school', text: 'x', reply: 'خودم جواب دادم' }, 'approval_denied'],
    [{ student_id: kid.id, to: 'school', text: 'x', appt_date: later }, 'approval_denied'],
    [{ student_id: kid.id, to: 'school', text: '   ' }, 'text_required'],
    [{ student_id: kid.id, to: 'school', text: 'x'.repeat(1001) }, 'text_too_long'],
    [{ student_id: kid.id, to: 'teacher', text: 'x' }, 'teacher_required'],
    [{ student_id: kid.id, to: 'school', teacher_id: teacher.id, text: 'x' }, 'teacher_required'],
    [{ student_id: kid.id, to: 'teacher', teacher_id: teacher.id, kind: 'appointment', text: 'x' }, 'bad_to'],
    [{ student_id: kid.id, to: 'principal', text: 'x' }, 'bad_to'],
    [{ student_id: kid.id, to: 'counselor', kind: 'appointment', want_date: '1403-13-40', text: 'x' }, 'bad_date'],
  ];
  for (const [row, want] of negs) { const r = put1(mom.id, 'parent_msgs', row); assert(err(r) === want, want + ' ← ' + J(row) + ' ' + J(r)); }
  /* edit while open: text yes; recipient no; the other parent no */
  const e1 = upd(mom.id, ids.school, { text: 'سلام، سارا فردا ساعت ۹ می‌آید.' });
  assert(e1.applied.length === 1 && st.get('parent_msgs', ids.school.id).text.includes('۹'), 'edit ' + J(e1));
  assert(err(upd(mom.id, ids.school, { to: 'counselor' })) === 'msg_fixed', 'recipient fixed');
  assert(err(upd(mom.id, ids.school, { student_id: other.id })) === 'out_of_scope', 'child fixed');
  assert(err(upd(dad.id, ids.school, { text: 'من' })) === 'not_author', 'the other parent');
  assert(err(push(mom.id, [{ uid: 'f197-del', collection: 'parent_msgs', type: 'del', id: ids.school.id }])) === 'role_denied', 'parent delete');
  return 'school/teacher/appointment applied; ' + negs.length + ' NEG + edit rules';
});

check('F02', 'recipients answer only their own messages; the counselor schedules and books', () => {
  const r = upd(teacher.id, ids.teacher, { reply: 'فردا زنگ آخر توضیح می‌دهم.', status: 'answered' });
  assert(r.applied.length === 1, 'teacher reply ' + J(r));
  const row = st.get('parent_msgs', ids.teacher.id);
  assert(Number(row.replied_by) === teacher.id && row.status === 'answered' && row.text === ids.teacher.text, 'reply ' + J(row));
  assert(err(upd(colleague.id, ids.teacher, { reply: 'من', status: 'answered' })) === 'out_of_scope', 'colleague');
  assert(err(upd(teacher.id, ids.school, { reply: 'من', status: 'answered' })) === 'out_of_scope', 'to school');
  assert(err(upd(teacher.id, ids.teacher, { text: 'تغییر' })) === 'msg_fixed', 'text fixed');
  assert(err(upd(teacher.id, ids.teacher, { status: 'open' })) === 'bad_status', 'reopen');
  assert(err(put1(teacher.id, 'parent_msgs', { student_id: kid.id, to: 'teacher', teacher_id: teacher.id, text: 'جعلی', status: 'answered' })) === 'role_denied', 'teacher create');
  /* once answered the parent can no longer edit */
  assert(err(upd(mom.id, ids.teacher, { text: 'ویرایش' })) === 'msg_answered', 'answered locked');
  /* the counselor schedules the requested appointment */
  const s = upd(counselor.id, ids.appt, { appt_date: later, appt_time: '10:30', status: 'scheduled', reply: 'دوشنبه ساعت ۱۰:۳۰' });
  assert(s.applied.length === 1 && st.get('parent_msgs', ids.appt.id).status === 'scheduled', 'schedule ' + J(s));
  assert(err(upd(counselor.id, ids.appt, { appt_time: '25:00' })) === 'bad_time', 'bad time');
  assert(err(upd(counselor.id, ids.appt, { status: 'scheduled', appt_date: '', appt_time: '' })) === 'appt_required', 'scheduled without date');
  /* the counselor books one with the parents of any student */
  const b = put1(counselor.id, 'parent_msgs', { student_id: other.id, to: 'counselor', kind: 'appointment', text: 'دعوت به جلسهٔ هدایت تحصیلی', appt_date: later, appt_time: '09:00', status: 'scheduled' });
  assert(b.applied.length === 1, 'book ' + J(b)); ids.booked = st.get('parent_msgs', b.applied[0].id);
  assert(Number(ids.booked.replied_by) === counselor.id && ids.booked.parent_id == null, 'booked stamp ' + J(ids.booked));
  assert(err(put1(counselor.id, 'parent_msgs', { student_id: other.id, to: 'counselor', text: 'پیام', status: 'answered' })) === 'appt_required', 'counselor message');
  assert(err(put1(counselor.id, 'parent_msgs', { student_id: 999, to: 'counselor', kind: 'appointment', text: 'x', appt_date: later, status: 'scheduled' })) === 'out_of_scope', 'non-student');
  assert(err(upd(counselor.id, ids.school, { reply: 'من', status: 'answered' })) === 'out_of_scope', 'counselor → school msg');
  const m = upd(mgr.id, ids.school, { reply: 'هماهنگ شد', status: 'closed' });
  assert(m.applied.length === 1, 'manager ' + J(m));
  return 'teacher reply stamped; 5 NEG; counselor schedule + booking; manager closes';
});

check('F03', 'pull: both parents see the child threads; teacher only theirs; counselor only «به مشاور»; student none', () => {
  const mine = pull(mom.id, 'parent_msgs').map(r => r.id).sort();
  const want = [ids.school.id, ids.teacher.id, ids.appt.id].sort();
  assert(J(mine) === J(want), 'mom ' + J(mine) + ' want ' + J(want));
  assert(J(pull(dad.id, 'parent_msgs').map(r => r.id).sort()) === J(want), 'dad sees the same');
  assert(J(pull(teacher.id, 'parent_msgs').map(r => r.id)) === J([ids.teacher.id]), 'teacher');
  assert(pull(colleague.id, 'parent_msgs').length === 0, 'colleague');
  assert(J(pull(counselor.id, 'parent_msgs').map(r => r.id).sort()) === J([ids.appt.id, ids.booked.id].sort()), 'counselor');
  assert(pull(kid.id, 'parent_msgs').length === 0 && !policy.canRead('student', 'parent_msgs'), 'student');
  assert(pull(mgr.id, 'parent_msgs').length === 4, 'manager all');
  assert(sync.pull(st, actor(counselor.id), {}).collections.parent_msgs, 'default pull carries parent_msgs');
  return 'parents 3/3, teacher 1, colleague 0, counselor 2, student 0, manager 4';
});

check('F04', 'counselor (F29): every student record on pull; session + guidance; NEG cases', () => {
  push(mgr.id, [op('grades', { student_id: other.id, class_id: 11, subject_id: 1, score: 17, status: 'approved', term: 'نوبت اول' }),
    op('attendance', { student_id: other.id, class_id: 11, date: today, status: 'absent' })]);
  const g = pull(counselor.id, 'grades');
  assert(g.some(x => Number(x.student_id) === other.id), 'grades of a non-referred student ' + J(g));
  assert(pull(counselor.id, 'attendance').some(x => Number(x.student_id) === other.id), 'attendance');
  const users = pull(counselor.id, 'users').map(u => u.id);
  assert(users.includes(kid.id) && users.includes(other.id) && !users.includes(teacher.id) && !users.includes(mom.id), 'users ' + J(users));
  const s = put1(counselor.id, 'counselor_notes', { student_id: other.id, kind: 'session', date: today, text: 'جلسهٔ خوداقدام: افت حضور' });
  assert(s.applied.length === 1, 'session ' + J(s));
  const gd = put1(counselor.id, 'counselor_notes', { student_id: other.id, kind: 'guidance', date: today, track: 'علوم تجربی', text: 'علاقه به زیست' });
  assert(gd.applied.length === 1, 'guidance ' + J(gd));
  assert(err(put1(counselor.id, 'counselor_notes', { student_id: other.id, kind: 'guidance', track: 'نجوم' })) === 'bad_track', 'track');
  assert(err(put1(counselor.id, 'counselor_notes', { student_id: other.id, kind: 'session', text: ' ' })) === 'text_required', 'empty session');
  assert(err(put1(counselor.id, 'counselor_notes', { student_id: other.id, kind: 'diary', text: 'x' })) === 'bad_kind', 'kind');
  assert(err(put1(teacher.id, 'counselor_notes', { student_id: kid.id, kind: 'session', text: 'x' })) === 'role_denied', 'teacher notes');
  assert(err(put1(counselor.id, 'grades', { student_id: other.id, class_id: 11, subject_id: 1, score: 20 })) === 'role_denied', 'counselor grade');
  assert(pull(counselor.id, 'counselor_notes').length === 2 && pull(mgr.id, 'counselor_notes').length === 0, 'notes only the counselor reads');
  /* row 197: counselor_notes was missing from the default pull (the counselor's notes never synced) */
  const def = sync.pull(st, actor(counselor.id), {}).collections;
  assert((def.counselor_notes || []).length === 2, 'default pull ' + Object.keys(def).join());
  assert(J(pm.GUIDANCE_TRACKS) === J(['ریاضی و فیزیک', 'علوم تجربی', 'علوم انسانی', 'علوم و معارف اسلامی', 'فنی‌وحرفه‌ای', 'کاردانش']), 'tracks');
  return 'grades/attendance of any student; session + guidance; 5 NEG';
});

check('F05', 'cloud mirror: parent stamps itself, recipients stamp replied_by; NEG cases', async () => {
  const parentScope = { role: 'parent', uid: mom.id, all: false, studentIds: [kid.id], classIds: [10], cohorts: [] };
  const base = { student_id: kid.id, to: 'school', kind: 'message', text: 'سلام', status: 'open' };
  assert(scope.canWriteRow(parentScope, 'parent_msgs', Object.assign({ parent_id: mom.id }, base)).ok, 'parent ok');
  assert(scope.canWriteRow(parentScope, 'parent_msgs', base).error === 'not_author', 'parent unstamped');
  assert(scope.canWriteRow(parentScope, 'parent_msgs', Object.assign({ parent_id: mom.id }, base, { student_id: other.id })).error === 'out_of_scope', 'other child');
  assert(scope.canWriteRow(parentScope, 'parent_msgs', Object.assign({ parent_id: mom.id }, base, { status: 'answered' })).error === 'approval_denied', 'parent approves');
  const tScope = { role: 'teacher', uid: teacher.id, all: false, studentIds: [kid.id], classIds: [10], cohorts: [] };
  const ans = { student_id: kid.id, parent_id: mom.id, to: 'teacher', teacher_id: teacher.id, kind: 'message', text: 'سؤال', reply: 'جواب', status: 'answered' };
  assert(scope.canWriteRow(tScope, 'parent_msgs', Object.assign({ replied_by: teacher.id }, ans)).ok, 'teacher reply');
  assert(scope.canWriteRow(tScope, 'parent_msgs', ans).error === 'not_author', 'unstamped reply');
  assert(scope.canWriteRow(tScope, 'parent_msgs', Object.assign({ replied_by: teacher.id }, ans, { status: 'open' })).error === 'bad_status', 'recipient open');
  assert(scope.canWriteRow(tScope, 'parent_msgs', Object.assign({ replied_by: teacher.id }, ans, { teacher_id: colleague.id })).error === 'out_of_scope', 'colleague');
  const cScope = { role: 'counselor', uid: counselor.id, all: false, studentIds: [kid.id, other.id], classIds: [10, 11], cohorts: [] };
  const book = { student_id: other.id, to: 'counselor', kind: 'appointment', text: 'دعوت', appt_date: later, status: 'scheduled', replied_by: counselor.id };
  assert(scope.canWriteRow(cScope, 'parent_msgs', book).ok, 'counselor books');
  assert(scope.canWriteRow(cScope, 'parent_msgs', Object.assign({}, book, { to: 'school' })).error === 'out_of_scope', 'counselor → school');
  assert(scope.canWriteRow(cScope, 'counselor_notes', { student_id: other.id, kind: 'guidance', track: 'نجوم' }).error === 'bad_track', 'cloud note shape');
  assert(scope.canWriteRow(tScope, 'parent_msgs', Object.assign({}, book, { to: 'teacher', teacher_id: teacher.id, kind: 'message' })).error === 'appt_required', 'teacher schedules');
  const sql = scope.sqlPredicate(tScope).sql;
  assert(/collection = 'parent_msgs' and r\.data->>'to' = 'teacher'/.test(sql), 'teacher SQL ' + sql.slice(-300));
  const csql = scope.sqlPredicate(cScope).sql;
  assert(/'grades'/.test(csql) && /parent_msgs' and r\.data->>'to' = 'counselor'/.test(csql), 'counselor SQL');
  assert(/'contributions' and/.test(scope.sqlPredicate(parentScope).sql), 'parent contributions SQL');
  return 'parent/teacher/counselor stamps; 7 NEG; SQL predicates';
});

check('F06', 'contributions: the parent pulls the rows of their own child only', () => {
  st.insert('contributions', { kind: 'tuition', payer: 'مادر سارا', amount: 5000000, date: today, student_id: kid.id });
  st.insert('contributions', { kind: 'tuition', payer: 'پدر آرش', amount: 7000000, date: today, student_id: other.id });
  st.insert('contributions', { kind: 'voluntary', payer: 'خیّر', amount: 1000000, date: today });
  const mine = pull(mom.id, 'contributions');
  assert(mine.length === 1 && Number(mine[0].student_id) === kid.id, 'mom ' + J(mine));
  assert(pull(teacher.id, 'contributions').length === 0 && pull(kid.id, 'contributions').length === 0, 'teacher/student');
  const w = put1(mom.id, 'contributions', { kind: 'voluntary', payer: 'x', amount: 1, date: today, student_id: kid.id });
  assert(err(w) === 'role_denied', 'parent write ' + J(w));
  return 'own 1 of 3; teacher/student 0; parent write role_denied';
});

/* ── web (client/pages.js + app.js + authz.js) ── */
function web(role, user, extra) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
  win.eval(strip('client/lib/xlsx.js') + '\n;\n' + strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
    + '\n;window.__t = { S, PAGES, list, byId, actPmsgAdd, actPmsgReply, actCnoteAdd, pmsgIssue, cnoteIssue, PMSG_TO, PMSG_KINDS, PMSG_STATUSES, CNOTE_KINDS, GUIDANCE_TRACKS, PMSG_LIMITS, navConfig };');
  const T = win.__t;
  T.S.user = user; T.S.role = role; T.S.session = 'x';
  const m = (rows) => new Map(rows.map(r => [r.id, r]));
  T.S.data = Object.assign({
    schools: m([{ id: 1, level: 'متوسطه دوم' }]),
    users: m([{ id: 1, name: 'مدیر', role: 'manager' }, { id: 5, name: 'سارا', role: 'student', class_id: 10, active: true },
      { id: 6, name: 'آرش', role: 'student', class_id: 10, active: true }, { id: 7, name: 'آقای رضایی', role: 'teacher' },
      { id: 8, name: 'مادر سارا', role: 'parent' }, { id: 9, name: 'مشاور', role: 'counselor' }]),
    parent_links: m([{ id: 1, parent_id: 8, student_id: 5 }]),
    classes: m([{ id: 10, name: 'دهم', grade: '10', branch: 'ریاضی' }]),
    schedule: m([{ id: 1, class_id: 10, teacher_id: 7, subject_id: 1, weekday: 6, period: 1 }]),
    subjects: m([{ id: 1, name: 'ریاضی' }]),
    exams: m([{ id: 1, date: later, subject_id: 1, class_id: 10, title: 'میان‌نوبت', kind: 'internal' }]),
    homework: m([{ id: 1, class_id: 10, subject_id: 1, title: 'تمرین ۳۰', due: later, date: today }]),
    discipline: m([{ id: 1, student_id: 5, kind: 'positive', note: 'همکاری در کلاس', date: today },
      { id: 2, student_id: 6, kind: 'negative', note: 'یادداشت همکلاسی', date: today }]),
    grades: m([{ id: 1, student_id: 5, class_id: 10, subject_id: 1, score: 18, status: 'approved' }]),
    attendance: m([{ id: 1, student_id: 5, class_id: 10, date: today, status: 'absent' }]),
    contributions: m([{ id: 1, student_id: 5, kind: 'voluntary', amount: 1000000, date: today, purpose: 'آزمایشگاه' }]),
    parent_msgs: m([{ id: 1, student_id: 5, parent_id: 8, to: 'counselor', kind: 'appointment', text: 'وقت برای انتخاب رشته', status: 'open' },
      { id: 2, student_id: 5, parent_id: 8, to: 'teacher', teacher_id: 7, kind: 'message', text: 'تکلیف ریاضی', status: 'open' }]),
    counselor_notes: new Map(),
    lookups: new Map(), announcements: new Map(), calendar: new Map(), leaves: new Map(), counselor_refs: new Map(),
  }, extra || {});
  T.S.queue = []; T.S.online = false;
  win.flushQueue = async () => {};
  win.confirm = () => true;
  return { win, T, doc: win.document };
}
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5)); };
async function submitForm(w, sel, values) {
  const form = w.doc.querySelector(sel);
  assert(form, 'form ' + sel);
  for (const [k, v] of Object.entries(values || {})) {
    const el = form.querySelector(`[name="${k}"]`);
    assert(el, 'field ' + k);
    el.value = v;
  }
  form.dispatchEvent(new w.win.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
}

check('F07', 'web parent child page: absence, report card, homework, exams, discipline, threads, contributions', () => {
  const w = web('parent', { id: 8, name: 'مادر سارا', role: 'parent' });
  w.doc.getElementById('app').innerHTML = w.T.PAGES.child(['5']);
  const q = s => w.doc.querySelector(`[data-child="${s}"]`);
  for (const s of ['today-absent', 'report-card', 'homework', 'exams', 'discipline', 'msgs', 'contrib']) assert(q(s), 'data-child=' + s);
  assert(q('homework').textContent.includes('تمرین ۳۰'), 'homework');
  assert(q('exams').textContent.includes('میان‌نوبت'), 'exams');
  assert(q('discipline').textContent.includes('همکاری در کلاس') && !q('discipline').textContent.includes('یادداشت همکلاسی'), 'own discipline only');
  const threads = q('msgs').closest('.card').textContent;
  assert(threads.includes('وقت برای انتخاب رشته') && threads.includes('تکلیف ریاضی'), 'threads');
  assert(!threads.includes('آقای رضایی'), 'NEG teacher name hidden from the parent');
  assert(w.doc.querySelector('[data-act="pmsg-add"]'), 'write button');
  assert(!w.doc.querySelector('[data-act^="contrib"]'), 'NEG contributions read only');
  return '7 cards; own discipline; teacher shown as subject only';
});

check('F08', 'web parent writes; teacher replies (NEG «scheduled»); counselor schedules and books', async () => {
  const p = web('parent', { id: 8, name: 'مادر سارا', role: 'parent' });
  p.T.actPmsgAdd(5);
  const opts = [...p.doc.querySelectorAll('form[data-form="pmsg"] [name="teacher_id"] option')].map(o => o.textContent);
  assert(opts.includes('دبیرِ ریاضی') && !opts.some(o => o.includes('رضایی')), 'teacher options ' + J(opts));
  await submitForm(p, 'form[data-form="pmsg"]', { to: 'teacher', teacher_id: '', text: 'x' });
  assert(p.T.list('parent_msgs').length === 2, 'NEG teacher_required refused');
  await submitForm(p, 'form[data-form="pmsg"]', { to: 'teacher', teacher_id: '7', kind: 'appointment', text: 'جلسه' });
  assert(p.T.list('parent_msgs').length === 2, 'NEG appointment with a teacher refused');
  await submitForm(p, 'form[data-form="pmsg"]', { to: 'teacher', teacher_id: '7', kind: 'message', text: 'لطفاً تمرین بیشتر' });
  const sent = p.T.list('parent_msgs').find(m => m.text === 'لطفاً تمرین بیشتر');
  assert(sent && sent.to === 'teacher' && Number(sent.teacher_id) === 7 && Number(sent.parent_id) === 8 && sent.status === 'open', 'sent ' + J(sent));

  const t = web('teacher', { id: 7, name: 'آقای رضایی', role: 'teacher' });
  t.doc.getElementById('app').innerHTML = t.T.PAGES.pmsgs();
  const tl = t.doc.querySelector('[data-pmsg-list]').textContent;
  assert(tl.includes('تکلیف ریاضی') && !tl.includes('وقت برای انتخاب رشته'), 'teacher sees own thread only');
  t.T.actPmsgReply(2);
  assert(!t.doc.querySelector('form[data-form="pmsg-reply"] option[value="scheduled"]'), 'NEG teacher cannot schedule');
  await submitForm(t, 'form[data-form="pmsg-reply"]', { reply: 'چشم', status: 'answered' });
  const r2 = t.T.byId('parent_msgs', 2);
  assert(r2.status === 'answered' && r2.reply === 'چشم' && r2.text === 'تکلیف ریاضی' && Number(r2.replied_by) === 7, 'reply ' + J(r2));
  t.T.actPmsgReply(1);
  assert(!t.doc.querySelector('form[data-form="pmsg-reply"] [name="id"][value="1"]'), 'NEG teacher cannot open the counselor thread');

  const c = web('counselor', { id: 9, name: 'مشاور', role: 'counselor' });
  c.doc.getElementById('app').innerHTML = c.T.PAGES.pmsgs();
  const cl = c.doc.querySelector('[data-pmsg-list]').textContent;
  assert(cl.includes('وقت برای انتخاب رشته') && !cl.includes('تکلیف ریاضی'), 'counselor sees «to counselor» only');
  c.T.actPmsgReply(1);
  await submitForm(c, 'form[data-form="pmsg-reply"]', { status: 'scheduled', appt_date: '', appt_time: '' });
  assert(c.T.byId('parent_msgs', 1).status === 'open', 'NEG scheduled without a day');
  c.T.actPmsgReply(1);
  await submitForm(c, 'form[data-form="pmsg-reply"]', { status: 'scheduled', appt_date: later, appt_time: '10:30', reply: 'دوشنبه' });
  const r1 = c.T.byId('parent_msgs', 1);
  assert(r1.status === 'scheduled' && r1.appt_date === later && r1.appt_time === '10:30', 'scheduled ' + J(r1));
  c.T.actPmsgAdd(6);
  await submitForm(c, 'form[data-form="pmsg"]', { appt_date: later, text: 'دعوت به جلسه' });
  const b = c.T.list('parent_msgs').find(m => m.text === 'دعوت به جلسه');
  assert(b && b.parent_id === null && b.status === 'scheduled' && b.kind === 'appointment' && Number(b.student_id) === 6, 'booked ' + J(b));
  return 'parent 2 NEG + sent; teacher own/reply/2 NEG; counselor own/NEG/scheduled/booked';
});

check('F09', 'web counselor desk: every student, read-only record, guidance note with track', async () => {
  const w = web('counselor', { id: 9, name: 'مشاور', role: 'counselor' });
  w.doc.getElementById('app').innerHTML = w.T.PAGES.cstudents();
  const rows = [...w.doc.querySelectorAll('[data-cst-row]')].map(a => a.getAttribute('data-cst-row'));
  assert(J(rows.sort()) === J(['5', '6']), 'students only ' + J(rows));
  w.T.S.cq = 'آرش';
  w.doc.getElementById('app').innerHTML = w.T.PAGES.cstudents();
  assert(w.doc.querySelectorAll('[data-cst-row]').length === 1, 'search');
  w.doc.getElementById('app').innerHTML = w.T.PAGES.cstudent(['5']);
  assert(w.doc.querySelector('[data-cst="report-card"]').textContent.includes('ریاضی'), 'report card');
  assert(w.doc.body.textContent.includes('همکاری در کلاس'), 'discipline');
  assert(!w.doc.querySelector('[data-act="grade-edit"],[data-act="disc-add"],[data-act^="grade"]'), 'NEG read only');
  w.T.actCnoteAdd(5);
  await submitForm(w, 'form[data-form="cnote"]', { kind: 'guidance', track: '', text: 'x' });
  assert(!w.T.list('counselor_notes').length, 'NEG guidance without a track');
  w.T.actCnoteAdd(5);
  await submitForm(w, 'form[data-form="cnote"]', { kind: 'guidance', track: 'ریاضی و فیزیک', text: 'علاقه به ریاضی' });
  const n = w.T.list('counselor_notes');
  assert(n.length === 1 && n[0].track === 'ریاضی و فیزیک' && Number(n[0].author_id) === 9 && Number(n[0].student_id) === 5, 'note ' + J(n));
  w.doc.getElementById('app').innerHTML = w.T.PAGES.cstudent(['5']);
  assert(w.doc.querySelector(`[data-cnote-row="${n[0].id}"]`).textContent.includes('ریاضی و فیزیک'), 'listed');
  const mgr = web('manager', { id: 1, name: 'مدیر', role: 'manager' });
  mgr.doc.getElementById('app').innerHTML = mgr.T.PAGES.cstudent(['5']);
  assert(!mgr.doc.querySelector('[data-act="cnote-add"]') && !mgr.doc.querySelector('[data-cst="notes"]'), 'NEG notes are the counselor’s');
  const par = web('parent', { id: 8, name: 'مادر سارا', role: 'parent' });
  assert(/دسترسی ندارید/.test(par.T.PAGES.cstudents()) && /دسترسی ندارید/.test(par.T.PAGES.pmsgs()), 'NEG parent');
  return 'students 2 (staff hidden), search, record, 1 NEG + note, manager/parent NEG';
});

check('F10', 'web twins equal the server: issue codes, constants, nav, authz', () => {
  const pm = require(path.join(ROOT, 'server/parent-msgs.js'));
  const w = web('parent', { id: 8, name: 'مادر سارا', role: 'parent' });
  const T = w.T;
  for (const k of ['MSG_TO', 'MSG_KINDS', 'MSG_STATUSES', 'NOTE_KINDS', 'GUIDANCE_TRACKS']) {
    const webName = { MSG_TO: 'PMSG_TO', MSG_KINDS: 'PMSG_KINDS', MSG_STATUSES: 'PMSG_STATUSES', NOTE_KINDS: 'CNOTE_KINDS', GUIDANCE_TRACKS: 'GUIDANCE_TRACKS' }[k];
    if (pm[k]) assert(J([...T[webName]]) === J(pm[k]), k + ' ' + J([...T[webName]]) + ' vs ' + J(pm[k]));
  }
  const vectors = [
    {}, { student_id: 5, to: 'x', text: 'a' }, { student_id: 5, to: 'teacher', text: 'a' },
    { student_id: 5, to: 'teacher', teacher_id: 7, kind: 'appointment', text: 'a' }, { student_id: 5, to: 'school', text: '' },
    { student_id: 5, to: 'school', text: 'x'.repeat(1001) }, { student_id: 5, to: 'school', text: 'a', want_date: '2026-13-40' },
    { student_id: 5, to: 'counselor', kind: 'appointment', text: 'a', status: 'scheduled' },
    { student_id: 5, to: 'counselor', kind: 'appointment', text: 'a', status: 'scheduled', appt_date: later, appt_time: '25:00' },
    { student_id: 5, to: 'school', text: 'a', status: 'weird' }, { student_id: 5, to: 'school', text: 'a' },
    { student_id: 5, to: 'school', teacher_id: 7, text: 'a' },
  ];
  for (const v of vectors) assert(T.pmsgIssue(Object.assign({}, v)) === pm.msgIssue(Object.assign({}, v)), 'msgIssue ' + J(v) + ' web=' + T.pmsgIssue(v) + ' server=' + pm.msgIssue(v));
  const nv = [{}, { student_id: 5 }, { student_id: 5, kind: 'x', text: 'a' }, { student_id: 5, kind: 'guidance', text: 'a' },
    { student_id: 5, kind: 'guidance', text: 'a', track: 'ریاضی و فیزیک' }, { student_id: 5, kind: 'guidance', track: 'نامعلوم', text: 'a' },
    { student_id: 5, kind: 'session', text: 'x'.repeat(2001) }, { student_id: 5, kind: 'session', text: 'a', date: 'bad' }, { student_id: 5, kind: 'session', text: 'ok' }];
  for (const v of nv) assert(T.cnoteIssue(Object.assign({}, v)) === pm.noteIssue(Object.assign({}, v)), 'noteIssue ' + J(v) + ' web=' + T.cnoteIssue(v) + ' server=' + pm.noteIssue(v));
  const nav = r => T.navConfig(r).map(x => x[0]);
  assert(J(nav('counselor').slice(0, 3)) === J(['cqueue', 'cstudents', 'pmsgs']), 'counselor nav ' + J(nav('counselor')));
  assert(nav('teacher').includes('pmsgs') && nav('manager').includes('pmsgs') && !nav('parent').includes('pmsgs'), 'nav pmsgs');
  const authz = fs.readFileSync(path.join(ROOT, 'client/authz.js'), 'utf8');
  const ctx = {}; new Function('window', authz + '\n;window.R = typeof AUTHZ_EXTRA_ROUTES !== "undefined" ? AUTHZ_EXTRA_ROUTES : null; window.can = typeof authzCanAct !== "undefined" ? authzCanAct : null;')(ctx);
  assert(ctx.R && ['cqueue', 'cstudents', 'cstudent', 'pmsgs'].every(r => ctx.R.counselor.includes(r)), 'authz counselor routes ' + J(ctx.R && ctx.R.counselor));
  assert(!ctx.R.counselor.includes('record') && !ctx.R.counselor.includes('students'), 'NEG counselor has no staff record routes');
  if (ctx.can) {
    const can = (role, act) => !!ctx.can(act, role, { role });
    assert(can('parent', 'pmsg-add') && can('counselor', 'pmsg-add') && !can('student', 'pmsg-add'), 'pmsg-add');
    assert(can('counselor', 'cnote-add') && !can('teacher', 'cnote-add') && !can('parent', 'cnote-add'), 'cnote-add');
  }
  return `${vectors.length} msg + ${nv.length} note vectors equal; nav; authz`;
});

module.exports = { check, assert, J, ROOT };
if (require.main === module) {
  setImmediate(async () => {
    for (const fn of pending) await fn();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log(`FAMILY-COUNSEL-197: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
}
