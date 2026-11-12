'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۷۴ موج ۳ — ثبت نمره در کلاینت بومی: هم‌خوانی با قرارداد (برابری با کلاینت وب)

   NW3-01  نوبت‌ها: GradeTerm در Dart دقیقاً فهرست نوبت صفحهٔ نمرهٔ وب (client/pages.js)، به
           همان ترتیب؛ برچسب وضعیت = نشان‌های وب «تأییدشده / در انتظار / جدید»
   NW3-02  معنای ذخیره = actGradeSave: بازهٔ ۰ تا ۲۰، فیلد خالی و نمرهٔ بدون‌تغییر رد می‌شوند،
           شکل رکورد = ردیف وب منهای school_id/_version، kind کارگاهی/میان‌نوبت، وضعیت
           مدیر approved و بقیه pending، نویسنده‌ها = policy، kindها ⊂ GRADE_KINDS
   NW3-03  تأیید فقط با مدیر در Gateway هم: server/scope.js دبیرِ غیر pending را با
           approval_denied رد می‌کند و بردار قرارداد scope-v1 همین را می‌گوید
   NW3-04  شناسهٔ رکورد: بازهٔ رزرو زیر 2^53 و بیرون از بازهٔ حضور؛ شناسهٔ موجود دوباره به کار
           می‌رود؛ base_version با صف
   NW3-05  مسیر داده: همان پایگاه/صندوقچه/Gateway حضور (gradeBookFor)، main فقط با موج روشن،
           اعتبارسنجی و جای صف پیش از نخستین نوشتن، book بدون شبکه
   NW3-06  پرچم: پیش‌فرض login,attendance,grades؛ صفحه فقط با uses(grades) و نقش نویسنده؛
           موج خاموش ⇒ پیام نسخهٔ وب؛ بدون WebView
   NW3-07  آزمون‌ها: شمار کنترل منفی، ۸ سناریوی IT واقعی در CI با شمارش دقیق، رد شدن skip
   NW3-08  سند ردیف: ترتیب موج‌ها، موج ۳ [S]، NOT RUN [M] صریح، Security UNKNOWN
   NW3-09  جهش‌ها: هر ویرایش ممنوع قرمز می‌شود
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const F = {
  book: 'apps/payesh/packages/payesh_sync/lib/src/grades.dart',
  att: 'apps/payesh/packages/payesh_sync/lib/src/attendance.dart',
  ctrl: 'apps/payesh/app/lib/src/grades/grades_controller.dart',
  screen: 'apps/payesh/app/lib/src/grades/grades_screen.dart',
  wiring: 'apps/payesh/app/lib/src/attendance/attendance_wiring.dart',
  app: 'apps/payesh/app/lib/src/app.dart',
  flags: 'apps/payesh/app/lib/src/flags.dart',
  main: 'apps/payesh/app/lib/main.dart',
  pages: 'client/pages.js',
  policy: 'server/policy.js',
  scope: 'server/scope.js',
  tenancy: 'server/tenancy.js',
  vectors: 'docs/cloud/contracts/vectors/scope-v1.json',
  unit: 'apps/payesh/packages/payesh_sync/test/grades_test.dart',
  widget: 'apps/payesh/app/test/grades_wave3_test.dart',
  it: 'apps/payesh/packages/payesh_sync/test/grades_it_test.dart',
  ci: '.github/workflows/native-client.yml',
  doc: 'docs/cloud/74-native-wave3-grades.md',
};

function assert(c, m) { if (!c) throw new Error(m); }
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* comments never satisfy (or break) a check */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const uniq = (src, re) => new Set([...src.matchAll(re)].map(m => m[0])).size;
const webGrades = (s) => {
  const p = s.pages.slice(s.pages.indexOf('PAGES.grades = (params) => {'));
  return p.slice(0, p.indexOf('\n};\n'));
};
const webSave = (s) => {
  const p = s.pages.slice(s.pages.indexOf('async function actGradeSave() {'));
  return p.slice(0, p.indexOf('\n}\n'));
};

function nw3Terms(s) {
  const b = code(s.book);
  const en = /enum GradeTerm \{([\s\S]*?);\n/.exec(b);
  assert(en, 'enum GradeTerm missing');
  const dart = [...en[1].matchAll(/^\s+[a-zA-Z]+\('([^']+)'\)/gm)].map(m => m[1]);
  const w = /\[('نوبت اول'[^\]]*)\]\.map\(t =>/.exec(webGrades(s));
  assert(w, 'web term list missing');
  const web = w[1].split(',').map(x => x.trim().replace(/'/g, ''));
  assert(JSON.stringify(dart) === JSON.stringify(web), 'Dart terms ' + dart + ' ≠ web ' + web);
  assert(/sel = S\.gradeSel \|\| \(S\.gradeSel = \{ class: classes\[0\]\.id, subject: '', term: 'نوبت اول' \}\)/.test(webGrades(s)), 'web default term changed');
  assert(/GradeTerm term = GradeTerm\.first;/.test(code(s.ctrl)), 'native default term must be the first (نوبت اول)');
  const st = /enum GradeState \{([\s\S]*?);\n/.exec(b);
  assert(st, 'enum GradeState missing');
  const labels = [...st[1].matchAll(/^\s+([a-zA-Z]+)\('([^']+)'\)/gm)].map(m => m[1] + '=' + m[2]);
  const g = webGrades(s);
  for (const l of ['تأییدشده', 'در انتظار', 'جدید']) assert(g.includes("'" + l + "'"), 'web badge ' + l + ' missing');
  assert(JSON.stringify(labels) === JSON.stringify(['fresh=جدید', 'pending=در انتظار', 'approved=تأییدشده']), 'state labels ≠ web badges: ' + labels);
  assert(/for \(final t in values\) \{\s*if \(t\.wire == v\) return t;\s*\}\s*return null;/.test(b), 'unknown term must map to null');
  return 'terms=' + dart.join('/') + ' · states=' + labels.length;
}

function nw3Semantics(s) {
  const b = code(s.book);
  const fn = webSave(s);
  // range + empty skip + unchanged skip
  assert(/if \(isNaN\(score\) \|\| score < 0 \|\| score > 20\)/.test(fn), 'web range changed — re-check parity');
  assert(/if \(v < 0 \|\| v > 20\) throw GradeFailure\(GradeError\.badScore, studentId\);/.test(b), 'Dart range must be 0..20');
  assert(/static final RegExp _score = RegExp\(r'\^\\d\{1,3\}\(\\\.\\d\{1,3\}\)\?\$'\);/.test(b), 'Dart score must be a plain decimal (no hex / exponent)');
  assert(/if \(!raw\) continue;/.test(fn) && /if \(score == null\) continue;/.test(b), 'empty field must be skipped on both');
  assert(/if \(ex && Number\(ex\.score\) === score\) continue;/.test(fn), 'web unchanged rule changed');
  assert(/if \(e\.score != null && e\.score! == score\) \{\s*unchanged\+\+;\s*continue;/.test(b), 'Dart must skip unchanged scores');
  // record shape
  const row = /const row = \{([\s\S]*?)\};/.exec(fn);
  assert(row, 'web grade row missing');
  /* `key: value` and shorthand `key` entries (values here contain no commas) */
  const webKeys = row[1].split(',').map(t => /^\s*([a-z_]+)\s*(?::|$)/.exec(t)).filter(Boolean).map(m => m[1])
    .filter(k => !['school_id', '_version'].includes(k));
  assert(/if \(subject\.workshop\) row\.practical_score = score;/.test(fn), 'web practical_score rule changed');
  webKeys.push('practical_score');
  const data = /final data = <String, Object\?>\{([\s\S]*?)\};/.exec(b);
  assert(data, 'Dart record map missing');
  const dartKeys = [...data[1].matchAll(/'([a-z_]+)':/g)].map(m => m[1]);
  assert(JSON.stringify([...dartKeys].sort()) === JSON.stringify([...webKeys].sort()), 'record fields Dart ' + dartKeys + ' ≠ web ' + webKeys);
  assert(/if \(subject\.workshop\) 'practical_score': score,/.test(b), 'practical_score only for workshop subjects');
  assert(/delete clean\.school_id;/.test(s.tenancy), 'Gateway no longer strips school_id — re-check record shape');
  // kind + status
  assert(/kind: subject\.workshop \? 'practical' : 'midterm'/.test(fn) && /'kind': subject\.workshop \? 'practical' : 'midterm',/.test(b), 'kind rule ≠ web');
  const kinds = /const GRADE_KINDS = \[([^\]]+)\];/.exec(s.policy)[1].split(',').map(x => x.trim().replace(/'/g, ''));
  for (const k of ['practical', 'midterm']) assert(kinds.includes(k), 'kind ' + k + ' not in GRADE_KINDS');
  assert(/status: S\.role === 'manager' \? 'approved' : 'pending'/.test(fn), 'web status rule changed');
  assert(/String get writeStatus => role == 'manager' \? 'approved' : 'pending';/.test(b) && /'status': writeStatus,/.test(b), 'Dart status must be approved only for the manager');
  // writers
  const pol = /grades:\s*\{ write: \[([^\]]+)\]/.exec(s.policy);
  const w = pol[1].split(',').map(x => x.trim().replace(/'/g, '')).sort();
  const dw = /static const Set<String> writers = \{([^}]+)\};/.exec(b);
  assert(dw && JSON.stringify(dw[1].split(',').map(x => x.trim().replace(/'/g, '')).sort()) === JSON.stringify(w), 'writers ≠ policy ' + w);
  // roster
  assert(/u\.role === 'student' && Number\(u\.class_id\) === Number\(sel\.class\) && u\.active !== false/.test(webGrades(s)), 'web roster rule changed');
  assert(/engine\.byRef\('users', 'class_id', classId\)/.test(b) && /if \(u\.data\['role'\] != 'student'\) continue;/.test(b) && /u\.data\['active'\] == false/.test(b), 'Dart roster must be active students of the class');
  return '0..20 · skip empty/unchanged · ' + dartKeys.length + ' fields · kind/status = web · writers=' + w.join('/');
}

function nw3Approval(s) {
  const sc = code(s.scope);
  const t = sc.slice(sc.indexOf("if (scope.role === 'teacher') {"));
  const blk = t.slice(0, t.indexOf("if (scope.role === 'parent'"));
  assert(/if \(collection === 'grades' && row && row\.status != null &&\s*String\(row\.status\) !== 'pending'\) return \{ ok: false, error: 'approval_denied' \};/.test(blk), 'Gateway must refuse a teacher grade that is not pending (approval_denied)');
  assert(/تأیید نمره فقط با مدیر است/.test(s.policy) && /row\.status = 'pending';/.test(s.policy), 'policy.js approval rule changed — re-check');
  const v = JSON.parse(s.vectors);
  const has = (scope, status, exp) => v.write.some(c => c.scope === scope && c.collection === 'grades' && c.row.status === status &&
    JSON.stringify(c.expect) === JSON.stringify(exp));
  assert(has('teacher', 'approved', { ok: false, error: 'approval_denied' }), 'scope-v1 lacks: teacher approved → approval_denied');
  assert(has('teacher', 'pending', { ok: true }), 'scope-v1 lacks: teacher pending → ok');
  assert(has('manager', 'approved', { ok: true }), 'scope-v1 lacks: manager approved → ok');
  return 'scope.js approval_denied · 3 vectors';
}

function nw3Ids(s) {
  const b = code(s.book), a = code(s.att);
  const num = (src, n) => { const m = new RegExp('static const int ' + n + ' = (\\d+);').exec(src); assert(m, n + ' missing'); return BigInt(m[1]); };
  const base = num(b, 'idBase'), span = num(b, 'idSpan');
  assert(base + span <= 2n ** 53n, 'grade id range ends at ' + (base + span) + ' > 2^53');
  const attTop = num(a, 'idBase') + num(a, 'maxDay') * 10000000000n + num(a, 'maxStudentId');
  assert(base > attTop, 'grade ids overlap the attendance range (≤ ' + attTop + ')');
  assert(/return idBase \+ v % idSpan;/.test(b), 'record id must stay inside [idBase, idBase + idSpan)');
  assert(/for \(var i = 0; i < 7; i\+\+\)/.test(b), 'hash prefix must stay 56 bits (never negative)');
  assert(/'payesh-grade-v1\|\$classId\|\$subjectId\|\$\{term\.wire\}\|\$studentId'/.test(b), 'id key must be (class, subject, term, student)');
  assert(/e\.recordId \?\?\s*recordId\(/.test(b), 'an existing grade id must be reused');
  assert(/final base = e\.version \+ _queued\(id\);/.test(b), 'base_version must add the ops still queued for the record');
  return 'range [' + base + ', ' + (base + span) + ') · above attendance ' + attTop;
}

function nw3DataPath(s) {
  const w = code(s.wiring);
  assert(/implements\s+AttendanceSource,\s*GradeSource\b/.test(w), 'the Gateway source must serve grades too (one data path)');
  assert(/return GradeBook\(engine: e, outbox: ob, role: role, uid: uid\);/.test(w), 'grade book must use the same engine and outbox');
  assert(/grades: flags\.ships\(NativeWave\.grades\) \? attendance : null,/.test(s.main), 'main: grades only when the wave ships, on the attendance data path');
  const b = code(s.book);
  assert(!/HttpClient|Transport|GatewaySync|\/api\//.test(b), 'GradeBook must not talk to the network');
  const iParse = b.indexOf('parseScore(raw, studentId: e.studentId)'), iCap = b.indexOf('outbox.config.capacity');
  const iLoop = b.indexOf('for (final (e, score, id) in plan)'), iEnq = b.indexOf('outbox.enqueue(');
  assert(iParse > 0 && iCap > iParse && iLoop > iCap && iEnq > iLoop, 'every score and the queue room must be checked before the first write');
  const iNot = b.indexOf('GradeError.notInClass');
  assert(iNot > 0 && iNot < iParse, 'student/class check must precede planning');
  assert(/source\.queued\(\)/.test(code(s.ctrl)), 'saving must nudge AutoSync');
  return 'shared Gateway path · validate → capacity → write · no network in the book';
}

function nw3Flags(s) {
  const d = /'PAYESH_NATIVE_WAVES',\s*defaultValue: '([a-z,]*)'/.exec(s.flags);
  assert(d && d[1].split(',').slice(0, 3).join(',') === 'login,attendance,grades', 'default waves must ship grades');
  assert(/enabled: gsrc != null && s\.flags\.uses\(NativeWave\.grades\),/.test(s.app), 'page must need the grades wave');
  const entry = code(s.screen).slice(code(s.screen).indexOf('class GradesEntry'));
  assert(/if \(role == null \|\| !GradeBook\.writers\.contains\(role\)\)/.test(entry), 'entry must check the writer roles');
  assert(/if \(!enabled\) \{\s*return const Text\(\s*'ثبت نمره فعلاً در نسخهٔ وب انجام می‌شود\.'/.test(entry), 'wave off ⇒ old (web) client message');
  assert(/if \(uid == null\)/.test(entry), 'unknown uid ⇒ no dead button');
  for (const k of ['ctrl', 'screen', 'wiring', 'app']) assert(!/webview|WebView|InAppWebView/.test(code(s[k])), k + ': no WebView');
  return 'default login,attendance,grades · writers only · legacy message';
}

function nw3Tests(s) {
  const negU = uniq(s.unit, /'W3-U\d+ NEG/g);
  const negW = uniq(s.widget, /'W3-[WS]\d+ NEG/g);
  const unitN = uniq(s.unit, /'W3-U\d+ /g), widgetN = uniq(s.widget, /'W3-[WS]\d+ /g);
  assert(negU >= 7, 'unit negatives ' + negU + ' < 7');
  assert(negW >= 6, 'widget negatives ' + negW + ' < 6');
  const its = uniq(s.it, /'W3-IT-0\d /g);
  assert(its === 8, 'IT scenarios ' + its + ' ≠ 8');
  assert(/approval_denied/.test(s.it), 'IT must prove the server-side approval rule');
  assert(/PAYESH_GW_IT/.test(s.it) && !/skip: true/.test(s.it), 'IT must be env-gated, not skipped');
  assert(/server\/gateway\.js/.test(s.it) && !/MockClient|FakeGateway/.test(s.it), 'IT must use the real Gateway');
  const step = s.ci.slice(s.ci.indexOf('- name: payesh_sync ⇄ server/gateway.js (pinned TLS)'));
  const blk = step.slice(0, step.indexOf('echo GATEWAY-REAL-OK'));
  assert(blk.includes('test/grades_it_test.dart'), 'CI gateway-real does not run the wave-3 IT');
  assert(blk.includes("grep -qE 'NATIVE-WAVE3-IT passed=8 negative_controls=10'"), 'CI must assert the exact wave-3 IT tally');
  assert(/if grep -qE '~\[0-9\]\+'/.test(blk), 'CI must fail on skipped tests');
  return `unit=${unitN} (neg ${negU}) widget=${widgetN} (neg ${negW}) IT=${its}`;
}

function nw3Doc(s) {
  const d = s.doc;
  const order = ['ورود و انتخاب مدرسه', 'حضور', 'نمره', 'اطلاعیه', 'والدین'];
  let at = -1;
  for (const w of order) { const i = d.indexOf(w, at + 1); assert(i > at, 'wave order in doc: ' + w); at = i; }
  assert(/موج ۳[^\n]*\[S\]/.test(d), 'wave 3 must be marked [S]');
  assert(/NOT RUN \[M\]/.test(d), 'doc must state NOT RUN [M]');
  assert(!/PASS \[M\]/.test(d), 'no [M] claim without a real device');
  assert(/UNKNOWN/.test(d), 'security stays UNKNOWN until row 92');
  for (const k of ['PAYESH_NATIVE_WAVES', 'login,attendance,grades', '/api/gw/v1/push', 'approval_denied', 'actGradeSave', 'NATIVE-WAVE3-IT passed=8 negative_controls=10']) assert(d.includes(k), 'doc lacks ' + k);
  return 'waves in order · wave 3 [S] · NOT RUN [M]';
}

function load() {
  const s = {};
  for (const [k, rel] of Object.entries(F)) s[k] = read(rel);
  return s;
}
class AnchorError extends Error {}
/* a mutant whose anchor vanished must FAIL the run, never count as "killed" */
const mut = (s, k, from, to) => { if (!s[k].includes(from)) throw new AnchorError('mutant anchor missing in ' + k + ': ' + from.slice(0, 50)); return Object.assign({}, s, { [k]: s[k].replace(from, to) }); };
const MUTANTS = [
  ['M1 Dart term drifts from the web', s => nw3Terms(mut(s, 'book', "second('نوبت دوم')", "second('نوبت ۲')"))],
  ['M2 web gains a term the client lacks', s => nw3Terms(mut(s, 'pages', "['نوبت اول', 'نوبت دوم', 'پایانی'].map(t =>", "['نوبت اول', 'نوبت دوم', 'پایانی', 'تابستان'].map(t =>"))],
  ['M3 review label drifts from the web badge', s => nw3Terms(mut(s, 'book', "approved('تأییدشده')", "approved('تایید شده')"))],
  ['M4 range widened to 25', s => nw3Semantics(mut(s, 'book', 'if (v < 0 || v > 20) throw', 'if (v < 0 || v > 25) throw'))],
  ['M5 lenient parse (hex / exponent)', s => nw3Semantics(mut(s, 'book', "RegExp(r'^\\d{1,3}(\\.\\d{1,3})?$')", "RegExp(r'^[\\dxe.]+$')"))],
  ['M6 unchanged scores rewritten', s => nw3Semantics(mut(s, 'book', 'if (e.score != null && e.score! == score) {', 'if (false) {'))],
  ['M7 teacher writes approved', s => nw3Semantics(mut(s, 'book', "String get writeStatus => role == 'manager' ? 'approved' : 'pending';", "String get writeStatus => 'approved';"))],
  ['M8 record gains a field the web does not send', s => nw3Semantics(mut(s, 'book', "        'status': writeStatus,\n", "        'status': writeStatus,\n        'device': 'native',\n"))],
  ['M9 kind drifts from the web', s => nw3Semantics(mut(s, 'book', "'kind': subject.workshop ? 'practical' : 'midterm',", "'kind': subject.workshop ? 'practical' : 'written',"))],
  ['M10 parents allowed to write', s => nw3Semantics(mut(s, 'book', "static const Set<String> writers = {'manager', 'teacher'};", "static const Set<String> writers = {'manager', 'teacher', 'parent'};"))],
  ['M11 Gateway approval rule removed', s => nw3Approval(mut(s, 'scope', "String(row.status) !== 'pending') return { ok: false, error: 'approval_denied' };", "false) return { ok: false, error: 'approval_denied' };"))],
  ['M12 contract vector weakened', s => nw3Approval(mut(s, 'vectors', '"error": "approval_denied"', '"error": "out_of_scope"'))],
  ['M13 id range beyond 2^53', s => nw3Ids(mut(s, 'book', 'static const int idSpan = 4000000000000000;', 'static const int idSpan = 5000000000000000;'))],
  ['M14 id range overlaps attendance', s => nw3Ids(mut(s, 'book', 'static const int idBase = 5000000000000000;', 'static const int idBase = 4500000000000000;'))],
  ['M15 self-conflict: base ignores queued ops', s => nw3Ids(mut(s, 'book', 'final base = e.version + _queued(id);', 'final base = e.version;'))],
  ['M16 capacity checked after writing', s => nw3DataPath(mut(s, 'book', 'if (active + plan.length > outbox.config.capacity) {', 'if (false) {'))],
  ['M17 grades wired with the wave off', s => nw3DataPath(mut(s, 'main', 'grades: flags.ships(NativeWave.grades) ? attendance : null,', 'grades: attendance,'))],
  ['M18 page ignores the wave flag', s => nw3Flags(mut(s, 'app', 'enabled: gsrc != null && s.flags.uses(NativeWave.grades),', 'enabled: gsrc != null,'))],
  ['M19 default waves drop grades', s => nw3Flags(mut(s, 'flags', "defaultValue: 'login,attendance,grades", "defaultValue: 'login,attendance,x"))],
  ['M20 wave-3 IT removed from CI', s => nw3Tests(mut(s, 'ci', ' test/grades_it_test.dart', ''))],
  ['M21 doc claims a real-device PASS', s => nw3Doc(mut(s, 'doc', 'NOT RUN [M]', 'PASS [M]'))],
];

async function main(opts) {
  const quiet = !!(opts && opts.quiet);
  const s = load();
  const out = []; let passed = 0; const failures = [];
  const run = (id, desc, fn) => { try { const d = fn(); passed++; out.push(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); } catch (e) { failures.push(id + ': ' + e.message); out.push(`FAIL  ${id}  ${desc}  → ${e.message}`); } };
  run('NW3-01', 'terms = web term list, states = web badges', () => nw3Terms(s));
  run('NW3-02', 'save semantics = web actGradeSave', () => nw3Semantics(s));
  run('NW3-03', 'approval only by the manager — also in the Gateway', () => nw3Approval(s));
  run('NW3-04', 'record id range and base_version', () => nw3Ids(s));
  run('NW3-05', 'shared Gateway data path, all-or-nothing', () => nw3DataPath(s));
  run('NW3-06', 'wave flag and writer roles', () => nw3Flags(s));
  run('NW3-07', 'negatives, real IT in CI with exact tally', () => nw3Tests(s));
  run('NW3-08', 'row doc: wave order, wave 3 [S], NOT RUN [M]', () => nw3Doc(s));
  let killed = 0;
  run('NW3-09', 'mutants turn red', () => {
    for (const [name, fn] of MUTANTS) {
      let red = false;
      try { fn(s); } catch (e) { if (e instanceof AnchorError) throw e; red = true; }
      assert(red, 'mutant survived: ' + name); killed++;
    }
    return killed + '/' + MUTANTS.length + ' killed';
  });
  if (!quiet) out.forEach(l => console.log(l));
  const r = { passed, failed: failures.length, failures, negatives: killed };
  if (!quiet) console.log(`\nNATIVE-WAVE3-74 ${r.failed ? 'FAILED' : 'OK'} passed=${passed} failed=${r.failed} negative_controls=${killed}`);
  return r;
}
module.exports = { main };
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
