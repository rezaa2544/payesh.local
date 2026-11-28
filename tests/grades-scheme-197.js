#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 197 — Q08 (F34) module-based assessment for هنرستان/کاردانش, Q09 (F35) descriptive
   assessment for ابتدایی, Q12 (F20/F24) «—» instead of 0% / معدل 0.0, Q11 (F3) Excel decimals.

     G01  server/grade-scheme.js: module score = competency×5 + continuous, pass 12,
          descriptive levels, numeric 0..20 — and the error codes
     G02  local server (policy via sync.push): module/descriptive rows accepted; bad shapes
          refused (bad_module / bad_level / bad_score) for the manager too
     G03  cloud scope mirrors the same checks; contract enum lists bad_module / bad_level
     G04  web: a vocational workshop subject → «پودمان ۱..۵», competency select + continuous;
          saving writes kind=module with the computed score; «ناتمام» / «قبول» course result
     G05  web: ابتدایی → descriptive select, saving writes kind=descriptive, level, score null
     G06  web: subject form «شیوهٔ ارزشیابی» (خودکار / پودمانی / نوبتی) is stored and honoured
     G07  web F20/F24: no grades / no attendance ⇒ «—», never «۰٪» or «معدل ۰٫۰»; a
          descriptive grade never pulls the average to 0
     G08  web F3: Excel float noise in a mobile cell («91887514.390000001») is read as the
          mobile; ordinary decimals are untouched
     G09  negative controls: a wrong score with the right competency, continuous 2.3, an
          unknown level and a module row with a نوبت term are all refused
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

const gs = require(path.join(ROOT, 'server/grade-scheme'));
const policy = require(path.join(ROOT, 'server/policy'));
const scope = require(path.join(ROOT, 'server/scope'));
const sync = require(path.join(ROOT, 'server/sync'));
const { openStore } = require(path.join(ROOT, 'server/db'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grd197-'));
const st = openStore(path.join(TMP, 'a.sqlite'));
st.insert('schools', { name: 'هنرستان', level: 'متوسطه دوم', school_type: 'vocational' }, { id: 1 });
const mgr = st.insert('users', { name: 'مدیر', role: 'manager', active: true });
st.insert('classes', { name: 'دهم · نقشه‌کشی' }, { id: 10 });
st.insert('subjects', { name: 'نقشه‌کشی فنی', workshop: true }, { id: 7 });
const s1 = st.insert('users', { name: 'سارا', role: 'student', class_id: 10, active: true });
let seq = 0;
const op = (data) => ({ uid: `g197-${++seq}`, collection: 'grades', type: 'put', data });
const actor = (id) => { const u = st.get('users', id); return { user: u, role: policy.permRole(u.role), device: null }; };
const push = (ops) => sync.push(st, actor(mgr.id), { ops });
const mod = (extra) => Object.assign({ student_id: s1.id, class_id: 10, subject_id: 7, term: 'پودمان ۱', kind: 'module',
  competency: 2, continuous: 3.5, score: 13.5, status: 'approved' }, extra || {});
const desc = (extra) => Object.assign({ student_id: s1.id, class_id: 10, subject_id: 7, term: 'نوبت اول', kind: 'descriptive',
  level: 'خیلی خوب', score: null, status: 'approved' }, extra || {});

check('G01', 'grade-scheme rules', () => {
  assert(gs.gradeIssue(mod()) === null, 'module ok');
  assert(gs.gradeIssue(mod({ term: 'پودمان 5', competency: 3, continuous: 0, score: 15 })) === null, 'latin digit term');
  assert(gs.gradeIssue(mod({ score: 14 })) === 'bad_module', 'score ≠ c*5+m');
  assert(gs.gradeIssue(mod({ competency: 4, score: 23.5 })) === 'bad_module', 'competency 4');
  assert(gs.gradeIssue(mod({ continuous: 5.5, score: 15.5 })) === 'bad_module', 'continuous 5.5');
  assert(gs.gradeIssue(mod({ term: 'نوبت اول' })) === 'bad_module', 'module with نوبت term');
  assert(gs.gradeIssue(desc()) === null && gs.gradeIssue(desc({ level: 'عالی' })) === 'bad_level', 'levels');
  assert(gs.gradeIssue(desc({ score: 18 })) === 'bad_level', 'descriptive with a number');
  assert(gs.gradeIssue({ kind: 'midterm', score: 21 }) === 'bad_score' && gs.gradeIssue({ kind: 'midterm', score: 19.5 }) === null, 'numeric');
  const r = gs.moduleResult([12, 15, 20, 13.5, 12]);
  assert(r.passed && r.average === 14.5, J(r));
  const f = gs.moduleResult([12, 10, 20, null, 12]);
  assert(!f.passed && J(f.failed) === '[2]' && J(f.missing) === '[4]' && f.average === null, J(f));
  assert(J(gs.DESCRIPTIVE_LEVELS) === J(['خیلی خوب', 'خوب', 'قابل قبول', 'نیاز به تلاش بیشتر']), 'levels list');
  return 'module/descriptive/numeric + course result';
});

check('G02', 'local server accepts the new kinds, refuses bad shapes (manager too)', () => {
  const ok = push([op(mod()), op(mod({ term: 'پودمان ۲', competency: 1, continuous: 5, score: 10 })), op(desc())]);
  assert(ok.applied.length === 3, J(ok));
  const bad = push([op(mod({ score: 20 })), op(mod({ continuous: 2.3, score: 12.3 })), op(desc({ level: 'عالی' })),
    op({ student_id: s1.id, class_id: 10, subject_id: 7, term: 'نوبت اول', kind: 'midterm', score: 25, status: 'approved' })]);
  assert(bad.rejected.map(x => x.error).join() === 'bad_module,bad_module,bad_level,bad_score', J(bad.rejected));
  return '3 applied; bad_module,bad_module,bad_level,bad_score';
});

check('G03', 'cloud scope mirror + contract', () => {
  const all = { all: true, role: 'manager' };
  assert(scope.canWriteRow(all, 'grades', mod()).ok, 'cloud module');
  assert(scope.canWriteRow(all, 'grades', mod({ competency: 0, score: 3.5 })).error === 'bad_module', 'cloud bad module');
  assert(scope.canWriteRow(all, 'grades', desc({ level: 'x' })).error === 'bad_level', 'cloud bad level');
  const schema = fs.readFileSync(path.join(ROOT, 'docs/cloud/contracts/sync-v1.schema.json'), 'utf8');
  assert(schema.includes('"bad_module"') && schema.includes('"bad_level"'), 'contract enum');
  const dart = fs.readFileSync(path.join(ROOT, 'apps/payesh/packages/payesh_sync/lib/src/grade_scheme.dart'), 'utf8');
  for (const l of gs.DESCRIPTIVE_LEVELS) assert(dart.includes(`'${l}'`), 'Dart level ' + l);
  for (const c of ['bad_level', 'bad_module', 'bad_score']) assert(dart.includes(`'${c}'`), 'Dart code ' + c);
  return 'cloud = local; contract + Dart parity';
});

/* ── web (jsdom) ── */
function web(school, subjects) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
  win.eval(strip('client/lib/xlsx.js') + '\n;\n' + strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
    + '\n;window.__t = { S, PAGES, list, putLocal, actGradeSave, gradeSchemeOf, moduleResultOf, subjectFormHtml, impPickMobile, classReportTable };');
  const T = win.__t;
  T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
  T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'grades';
  T.S.data = {
    schools: new Map([[1, Object.assign({ id: 1 }, school)]]),
    users: new Map([[1, T.S.user], [5, { id: 5, name: 'سارا', role: 'student', class_id: 10, active: true }],
      [6, { id: 6, name: 'مینا', role: 'student', class_id: 10, active: true }]]),
    classes: new Map([[10, { id: 10, name: 'دهم' }]]),
    subjects: new Map(subjects.map(s => [s.id, s])),
    schedule: new Map(), lookups: new Map(), parent_links: new Map(), grades: new Map(), attendance: new Map(),
  };
  T.S.queue = []; T.S.online = false;
  win.flushQueue = async () => {};
  return { win, T, doc: win.document };
}
const html = (w, s) => { w.doc.getElementById('app').innerHTML = s; return w.doc; };

check('G04', 'web modular sheet + save + course result', async () => {
  const w = web({ level: 'متوسطه دوم', school_type: 'vocational' }, [{ id: 7, name: 'نقشه‌کشی فنی', workshop: true }]);
  w.T.S.gradeSel = { class: 10, subject: 7, term: 'نوبت اول' };
  const d = html(w, w.T.PAGES.grades([]));
  assert(w.T.S.gradeSel.term === 'پودمان ۱', 'term moved to پودمان ۱: ' + w.T.S.gradeSel.term);
  const terms = [...d.querySelectorAll('#g-term option')].map(o => o.textContent);
  assert(J(terms) === J(['پودمان ۱', 'پودمان ۲', 'پودمان ۳', 'پودمان ۴', 'پودمان ۵']), J(terms));
  assert(d.querySelector('[data-grade-modular]') && d.querySelector('select[data-grade="5"]') && d.querySelector('[data-grade-cont="5"]'), 'modular inputs');
  d.querySelector('select[data-grade="5"]').value = '2';
  d.querySelector('[data-grade-cont="5"]').value = '۳٫۵';
  d.querySelector('select[data-grade="6"]').value = '3';
  d.querySelector('[data-grade-cont="6"]').value = '9';         /* out of range ⇒ refused */
  await w.T.actGradeSave();
  const rows = w.T.list('grades');
  assert(rows.length === 1, J(rows));
  const g = rows[0];
  assert(g.kind === 'module' && g.competency === 2 && g.continuous === 3.5 && g.score === 13.5 && g.term === 'پودمان ۱', J(g));
  assert(gs.gradeIssue(g) === null, 'web row passes the server rule');
  for (const [k, sc] of [[2, 15], [3, 12], [4, 20]]) w.T.putLocal('grades', { student_id: 5, class_id: 10, subject_id: 7, term: 'پودمان ' + '۰۱۲۳۴۵'[k], kind: 'module', score: sc });
  let r = w.T.moduleResultOf(10, 7, 5);
  assert(!r.passed && r.label === 'در حال ارزشیابی (۴ از ۵ پودمان)', r.label);
  w.T.putLocal('grades', { student_id: 5, class_id: 10, subject_id: 7, term: 'پودمان ۵', kind: 'module', score: 10 });
  r = w.T.moduleResultOf(10, 7, 5);
  assert(r.label === 'ناتمام (پودمان ۵)', r.label);
  w.T.S.data.grades.forEach(x => { if (x.term === 'پودمان ۵') x.score = 16; });
  r = w.T.moduleResultOf(10, 7, 5);
  assert(r.passed && r.average === 15.3 && r.label === 'قبول — ۱۵٫۳', r.label);
  return 'پودمان ۱..۵, 13.5 saved, ناتمام → قبول';
});

check('G05', 'web descriptive (ابتدایی)', async () => {
  const w = web({ level: 'ابتدایی', school_type: 'governmental' }, [{ id: 7, name: 'علوم' }]);
  w.T.S.gradeSel = { class: 10, subject: 7, term: 'نوبت اول' };
  const d = html(w, w.T.PAGES.grades([]));
  const opts = [...d.querySelectorAll('select[data-grade="5"] option')].map(o => o.textContent);
  assert(J(opts) === J(['—', 'خیلی خوب', 'خوب', 'قابل قبول', 'نیاز به تلاش بیشتر']), J(opts));
  assert(d.querySelector('[data-act="grade-save"]').textContent === 'ثبت ارزشیابی', 'button');
  d.querySelector('select[data-grade="5"]').value = 'قابل قبول';
  await w.T.actGradeSave();
  const g = w.T.list('grades')[0];
  assert(g && g.kind === 'descriptive' && g.level === 'قابل قبول' && g.score === null, J(g));
  assert(gs.gradeIssue(g) === null, 'web row passes the server rule');
  return 'level saved, score null';
});

check('G06', 'web subject form stores «پودمانی»/«نوبتی» and the sheet follows it', () => {
  const w = web({ level: 'متوسطه دوم', school_type: 'governmental' }, [{ id: 7, name: 'دانش فنی', workshop: true }]);
  const f = html(w, w.T.subjectFormHtml(w.T.S.data.subjects.get(7)));
  const sel = f.querySelector('select[name="modular"]');
  assert(sel && sel.options[0].textContent.includes('نوبتی'), 'auto = numeric in a public school');
  assert(w.T.gradeSchemeOf({ workshop: true }) === 'numeric', 'auto');
  assert(w.T.gradeSchemeOf({ workshop: true, modular: true }) === 'modular', 'explicit');
  const w2 = web({ level: 'متوسطه دوم', school_type: 'kardanesh' }, [{ id: 7, name: 'کارگاه', workshop: true, modular: false }]);
  assert(w2.T.gradeSchemeOf(w2.T.S.data.subjects.get(7)) === 'numeric' && w2.T.gradeSchemeOf({ workshop: true }) === 'modular', 'kardanesh');
  const w3 = web({ level: 'ابتدایی' }, [{ id: 7, name: 'ریاضی' }]);
  assert(!html(w3, w3.T.subjectFormHtml(w3.T.S.data.subjects.get(7))).querySelector('select[name="modular"]'), 'no toggle in ابتدایی');
  return 'auto/explicit, kardanesh default, hidden for ابتدایی';
});

check('G07', 'web «—» instead of 0', () => {
  const w = web({ level: 'متوسطه اول' }, [{ id: 7, name: 'ریاضی' }]);
  w.T.S.role = 'parent'; w.T.S.user = { id: 9, name: 'ولی', role: 'parent' };
  w.T.S.data.users.set(9, w.T.S.user);
  w.T.S.data.parent_links.set(1, { id: 1, parent_id: 9, student_id: 5 });
  const child = html(w, w.T.PAGES.child(['5'])).body.textContent;
  assert(!/معدل[^—]*۰\.۰|۰٪/.test(child) && child.includes('—'), 'child page shows —');
  const rep = w.T.classReportTable(10);
  assert(!rep.includes('۰.۰۰') && !rep.includes('۰٪'), 'report');
  w.T.S.role = 'student'; w.T.S.user = w.T.S.data.users.get(5);
  const rec = html(w, w.T.PAGES.record()).body.textContent;
  assert(!rec.includes('۰٪'), 'record');
  w.T.putLocal('grades', { student_id: 5, class_id: 10, subject_id: 7, term: 'نوبت اول', kind: 'descriptive', level: 'خوب', score: null });
  w.T.putLocal('grades', { student_id: 5, class_id: 10, subject_id: 7, term: 'نوبت دوم', kind: 'midterm', score: 18 });
  const rep2 = w.T.classReportTable(10);
  assert(rep2.includes('۱۸.۰۰'), 'average ignores the descriptive grade: ' + rep2);
  w.T.S.role = 'teacher';
  w.T.S.data.schedule.set(1, { id: 1, class_id: 10, teacher_id: 9, subject_id: 7 });
  w.T.S.user = { id: 9, name: 'دبیر', role: 'teacher' };
  const studs = html(w, w.T.PAGES.students()).body.textContent;
  assert(studs.includes('معدل ۱۸.۰') && studs.includes('معدل —'), studs);
  return 'child/record/report/students';
});

check('G08', 'web Excel float noise in mobiles', () => {
  const w = web({}, []);
  for (const v of ['91887514.390000001', '9188751439.0000001', '9.188751439E9', '09188751439']) {
    assert(w.T.impPickMobile(v).value === '09188751439', v + ' ' + J(w.T.impPickMobile(v)));
  }
  assert(w.T.impPickMobile('18.75').value === '', 'ordinary decimal');
  const X = require(path.join(ROOT, 'client/lib/xlsx.js'));
  assert(X.numberText('18.75') === '18.75' && X.numberText('91887514.390000001') === '91887514.39', 'numberText');
  return '4 noisy forms read, 18.75 untouched';
});

check('G09', 'negative controls', () => {
  const r = push([op(mod({ competency: 3, continuous: 2, score: 13 })), op(mod({ continuous: 2.3, score: 12.3 })),
    op(desc({ level: 'متوسط' })), op(mod({ term: 'نوبت دوم' }))]);
  assert(r.applied.length === 0 && r.rejected.length === 4, J(r));
  return '4/4 refused';
});

(async () => {
  for (const p of pending) await p();
  try { st.db.close(); fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (!failed) console.log('GRADES-SCHEME-197-OK');
  process.exit(failed ? 1 : 0);
})();
