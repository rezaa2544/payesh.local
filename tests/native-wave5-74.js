'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۷۴ موج ۵ — صفحه‌های والدین در کلاینت بومی: هم‌خوانی با قرارداد (برابری با کلاینت وب)

   NW5-01  نشان‌ها: معدل ≥۱۵ سبز / ≥۱۰ کهربایی / قرمز، حضور ≥۹۰ سبز، برچسب و رنگ مرخصی
           (تأییدشده / رد شده / در انتظار)، برچسب حضور = ATT_LABEL وب؛ وضعیت ناشناخته ⇐ در انتظار
   NW5-02  خواندن = parentHome / PAGES.child وب: فرزندان از parent_links با parent_id = کاربر،
           معدل فقط نمرهٔ تأییدشده، درصد حضور گرد (Math.round)، ۱۲ حضور آخر جدیدترین اول،
           متن «فرزندی متصل نیست» همان وب
   NW5-03  نوشتن = فرم leave وب: شکل رکورد = ردیف وب منهای school_id، وضعیت pending، by_id = کاربر،
           علت trim، تاریخ پیش‌فرض روز UTC، فقط ولی، فقط فرزند متصل، روز واقعی
   NW5-04  نگهبان Gateway: scope.js درخواست ولی/دانش‌آموز با وضعیت بیرون از LEAVE_REQUEST_STATUSES
           را با approval_denied رد می‌کند؛ policy.js همان فهرست؛ بردارهای scope-v1 همین را می‌گویند
   NW5-05  مسیر داده و شناسه: همان پایگاه/صندوقچه/Gateway (familyBookFor)، main فقط با موج روشن،
           بازهٔ شناسه جدا و زیر 2^53، base 0، همهٔ بررسی‌ها پیش از صف، صف پیش از نوشتن محلی، بدون شبکه
   NW5-06  پرچم: پیش‌فرض …,parents؛ صفحه فقط با uses(parents) و نقش parent؛ موج خاموش ⇐ پیام
           نسخهٔ وب؛ تاریخ شمسی با آزمون رفت‌وبرگشت؛ بدون WebView
   NW5-07  آزمون‌ها: شمار کنترل منفی، ۸ سناریوی IT واقعی در CI با شمارش دقیق، رد شدن skip
   NW5-08  سند ردیف: ترتیب موج‌ها، موج ۵ [S]، تفاوت‌های عمدی، NOT RUN [M] صریح، Security UNKNOWN
   NW5-09  جهش‌ها: هر ویرایش ممنوع قرمز می‌شود
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const F = {
  book: 'apps/payesh/packages/payesh_sync/lib/src/family.dart',
  attendance: 'apps/payesh/packages/payesh_sync/lib/src/attendance.dart',
  grades: 'apps/payesh/packages/payesh_sync/lib/src/grades.dart',
  notices: 'apps/payesh/packages/payesh_sync/lib/src/notices.dart',
  ctrl: 'apps/payesh/app/lib/src/family/family_controller.dart',
  screen: 'apps/payesh/app/lib/src/family/family_screen.dart',
  wiring: 'apps/payesh/app/lib/src/attendance/attendance_wiring.dart',
  app: 'apps/payesh/app/lib/src/app.dart',
  flags: 'apps/payesh/app/lib/src/flags.dart',
  main: 'apps/payesh/app/lib/main.dart',
  pages: 'client/pages.js',
  appjs: 'client/app.js',
  policy: 'server/policy.js',
  scope: 'server/scope.js',
  vectors: 'docs/cloud/contracts/vectors/scope-v1.json',
  unit: 'apps/payesh/packages/payesh_sync/test/family_test.dart',
  widget: 'apps/payesh/app/test/family_wave5_test.dart',
  it: 'apps/payesh/packages/payesh_sync/test/family_it_test.dart',
  ci: '.github/workflows/native-client.yml',
  doc: 'docs/cloud/74-native-wave5-parents.md',
};

function assert(c, m) { if (!c) throw new Error(m); }
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* comments never satisfy (or break) a check */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const uniq = (src, re) => new Set([...src.matchAll(re)].map(m => m[0])).size;
const block = (src, start, end) => {
  const i = src.indexOf(start);
  assert(i >= 0, 'anchor missing: ' + start);
  const p = src.slice(i);
  return p.slice(0, p.indexOf(end));
};
const webHome = (s) => block(s.pages, 'function parentHome() {', '\n}\n');
const webKids = (s) => block(s.pages, 'function myChildren() {', '\n}\n');
const webChild = (s) => block(s.pages, 'PAGES.child = (params) => {', '\n};\n');
const webLeaves = (s) => block(s.pages, 'PAGES.leaves = () => {', '\n};\n');
const webForm = (s) => block(s.pages, 'function actLeaveAdd() {', '\n}\n');
const webSave = (s) => block(s.appjs, "if (kind === 'leave') {", '\n  }\n');
const dartList = (src) => src.split(',').map(x => x.trim().replace(/'/g, '')).filter(Boolean);

function nw5Badges(s) {
  const sc = code(s.screen), b = code(s.book), home = webHome(s), child = webChild(s), lv = webLeaves(s);
  // average / attendance thresholds (home card and child page)
  assert(/avg >= 15 \? 'green' : avg >= 10 \? 'amber' : 'red'/.test(home), 'web average badge changed');
  assert(/pct >= 90 \? 'green' : 'amber'/.test(home) && /pct >= 90 \? 'green' : 'amber'/.test(child), 'web attendance badge changed');
  assert(/final a when a >= 15 => PayeshTone\.success,\s*final a when a >= 10 => PayeshTone\.warning,\s*_ => PayeshTone\.danger,/.test(sc), 'native average tones ≠ web (15 green, 10 amber, else red)');
  assert(/final p when p >= 90 => PayeshTone\.success,\s*_ => PayeshTone\.warning,/.test(sc), 'native attendance tones ≠ web (90 green, else amber)');
  // leave states
  const web = /badge\(l\.status === 'approved' \? '([^']+)' : l\.status === 'rejected' \? '([^']+)' : '([^']+)', l\.status === 'approved' \? 'green' : l\.status === 'rejected' \? 'red' : 'amber'\)/.exec(lv);
  assert(web, 'web leave badge changed');
  const en = /enum LeaveState \{([\s\S]*?);\n/.exec(b);
  assert(en, 'enum LeaveState missing');
  const dart = Object.fromEntries([...en[1].matchAll(/^\s+([a-z]+)\('([^']+)'\)/gm)].map(m => [m[1], m[2]]));
  assert(dart.approved === web[1] && dart.rejected === web[2] && dart.pending === web[3] && Object.keys(dart).length === 3, 'leave labels ' + JSON.stringify(dart) + ' ≠ web ' + web.slice(1, 4));
  assert(/'approved' => LeaveState\.approved,\s*'rejected' => LeaveState\.rejected,\s*_ => LeaveState\.pending,/.test(b), 'unknown leave status must read as pending (web else-branch)');
  assert(/LeaveState\.approved => PayeshTone\.success,\s*LeaveState\.rejected => PayeshTone\.danger,\s*LeaveState\.pending => PayeshTone\.warning,/.test(sc), 'native leave tones ≠ web (green / red / amber)');
  // grade review + attendance labels on the child page
  assert(/badge\(g\.status === 'approved' \? 'تأییدشده' : 'در انتظار', g\.status === 'approved' \? 'green' : 'amber'\)/.test(child), 'web grade review badge changed');
  assert(/a\.status === 'present' \? 'green' : a\.status === 'absent' \? 'red' : 'amber'/.test(child), 'web attendance record colours changed');
  assert(/AttendanceStatus\.present => PayeshTone\.success,\s*AttendanceStatus\.absent => PayeshTone\.danger,\s*_ => PayeshTone\.warning,/.test(sc), 'native attendance record tones ≠ web');
  const att = Object.fromEntries([...code(s.attendance).matchAll(/^\s+[a-zA-Z]+\('([a-z_]+)', '([^']+)'\)/gm)].map(m => [m[1], m[2]]));
  const webAtt = {};
  const al = /const ATT_LABEL = \{([^}]+)\};/.exec(s.pages);
  assert(al, 'web ATT_LABEL missing');
  for (const m of al[1].matchAll(/([a-z_]+): '([^']+)'/g)) webAtt[m[1]] = m[2];
  assert(JSON.stringify(att) === JSON.stringify(webAtt), 'attendance labels ' + JSON.stringify(att) + ' ≠ web ATT_LABEL');
  return 'avg 15/10 · attendance 90 · leaves ' + Object.values(dart).join('/') + ' · unknown → pending';
}

function nw5Reads(s) {
  const b = code(s.book), home = webHome(s), child = webChild(s);
  // children
  assert(/list\('parent_links'\)\.filter\(l => Number\(l\.parent_id\) === Number\(S\.user\.id\)\)/.test(webKids(s)) && /byId\('users', l\.student_id\)/.test(webKids(s)), 'web myChildren changed');
  assert(/for \(final l in await _all\('parent_links'\)\)\s*if \(_live\(l\) && _int\(l\.data\['parent_id'\]\) == uid\) l,/.test(b), 'Dart children must come from the own parent_links (live only)');
  assert(/final u = await engine\.get\('users', sid\);/.test(b), 'child record = users row (web byId)');
  // approved-only average, rounded attendance
  assert(/x\.status === 'approved'\);/.test(home) && /Math\.round\(att\.filter\(x => x\.status === 'present'\)\.length \/ att\.length \* 100\)/.test(home), 'web home average/attendance formula changed');
  assert(/if \(g\.data\['status'\] == 'approved'\) _num\(g\.data\['score'\]\),/.test(b), 'Dart average must use approved grades only');
  assert(/\(present \* 100 \/ att\.length\)\.round\(\),/.test(b), 'Dart attendance % must be rounded like Math.round');
  assert(/static num _num\(Object\? v\) => switch \(v\) \{[\s\S]*?_ => 0,/.test(b) && /Number\(x\.score \|\| 0\)/.test(home), 'missing score counts as 0 (web Number(x || 0))');
  // child page
  assert(/att\.slice\(0, 12\)/.test(child) && /\.sort\(\(a, b\) => String\(b\.date\)\.localeCompare\(String\(a\.date\)\)\)/.test(child), 'web child attendance slice/order changed');
  assert(/static const int recentAttendance = 12;/.test(b), 'Dart child page must show 12 attendance records');
  assert(/for \(final a in recent\.take\(recentAttendance\)\)/.test(b), 'Dart must cut the attendance list at recentAttendance');
  assert(/final c = '\$\{b\.data\['date'\] \?\? ''\}'\.compareTo\(\s*'\$\{a\.data\['date'\] \?\? ''\}',/.test(b), 'Dart attendance must be newest first');
  assert(/list\('internships'\)\.filter\(i => Number\(i\.student_id\) === Number\(k\.id\)\)/.test(child), 'web internships changed');
  assert(/_ofStudent\('internships', /.test(b), 'Dart child page must list the internships');
  // empty state text
  const msg = /empty\('(فرزندی به حساب شما متصل نیست[^']*)'\)/.exec(home);
  assert(msg, 'web empty-family text changed');
  assert(code(s.screen).includes("'" + msg[1] + "'"), 'native empty-family text ≠ web: ' + msg[1]);
  return 'own links only · approved average · Math.round % · 12 recent days newest first';
}

function nw5Writes(s) {
  const b = code(s.book), save = webSave(s), form = webForm(s);
  const row = /putLocal\('leaves', \{([\s\S]*?)\}\);/.exec(save);
  assert(row, 'web leave row missing');
  const webKeys = [...row[1].matchAll(/([a-z_]+):/g)].map(m => m[1]).filter(k => k !== 'school_id');
  const rq = block(b, 'Future<LeaveWriteResult> requestLeave({', 'final bytes =');
  const dm = /final data = <String, Object\?>\{([\s\S]*?)\};/.exec(rq);
  assert(dm, 'Dart leave record missing');
  const dartKeys = [...dm[1].matchAll(/'([a-z_]+)':/g)].map(m => m[1]).filter(k => k !== 'id');
  assert(JSON.stringify([...dartKeys].sort()) === JSON.stringify([...new Set(webKeys)].sort()), 'record fields Dart ' + dartKeys + ' ≠ web ' + webKeys);
  assert(/status: 'pending'/.test(row[1]) && /'status': 'pending',/.test(dm[1]), 'a request is always pending');
  assert(/by_id: S\.user \? S\.user\.id : null/.test(row[1]) && /'by_id': uid,/.test(dm[1]), 'by_id = the requesting user');
  assert(/reason: String\(f\.reason\.value \|\| ''\)\.trim\(\)/.test(row[1]) && /'reason': reason\.trim\(\),/.test(dm[1]), 'reason must be trimmed (web)');
  assert(/date: \(f\.date && f\.date\.value\) \|\| todayISO\(\)/.test(row[1]) && /jalaliDateControl\('date', todayISO\(\)/.test(form), 'web date default changed');
  assert(/String today\(\) => _now\(\)\.toUtc\(\)\.toIso8601String\(\)\.substring\(0, 10\);/.test(b) && /\? today\(\) : date\.trim\(\);/.test(rq), 'Dart default day must be the UTC day');
  assert(/const kids = S\.role === 'parent' \? myChildren\(\) : \[S\.user\];/.test(form), 'web form children changed');
  assert(/_requireParent\(\);\s*await _linked\(studentId\);/.test(rq), 'Dart must refuse non-parents and children not linked to this parent');
  assert(/if \(!validDay\(day\)\) throw FamilyFailure\(FamilyError\.badDate, day\);/.test(rq), 'Dart must refuse a day that does not exist');
  assert(/return t != null && t\.toIso8601String\(\)\.substring\(0, 10\) == d;/.test(b), 'validDay must round-trip (no 2026-02-30)');
  const lv = webLeaves(s);
  assert(/if \(!canManage\) rows = rows\.filter\(l => mine\.includes\(Number\(l\.student_id\)\)\);/.test(lv), 'web leaves filter changed');
  assert(/for \(final k in kids\.values\) \{\s*for \(final l in await _ofStudent\(leaves, k\.id\)\)/.test(b), 'Dart leaves = requests of the linked children only');
  assert(/final c = b\.date\.compareTo\(a\.date\);\s*return c != 0 \? c : b\.id\.compareTo\(a\.id\);/.test(b), 'Dart leaves order: date desc, then id desc (documented)');
  return dartKeys.length + ' fields · pending · trimmed reason · UTC day · linked child only';
}

function nw5Gateway(s) {
  const sc = code(s.scope), pol = code(s.policy);
  const ls = /const LEAVE_REQUEST_STATUSES = \[([^\]]+)\];/.exec(pol);
  assert(ls && JSON.stringify(dartList(ls[1])) === JSON.stringify(['pending', 'canceled']), 'policy LEAVE_REQUEST_STATUSES must be pending/canceled');
  assert(/LEAVE_REQUEST_STATUSES, COLLECTIONS,/.test(pol), 'policy must export LEAVE_REQUEST_STATUSES');
  assert(/if \(row\.status && !LEAVE_REQUEST_STATUSES\.includes\(row\.status\)\) row\.status = 'pending';/.test(pol), 'school-server path must use the same list');
  const pr = block(sc, "if (scope.role === 'parent' || scope.role === 'student') {", "if (scope.role === 'counselor')");
  assert(/if \(collection !== 'leaves'\) return \{ ok: false, error: 'role_denied' \};/.test(pr), 'parent may only write leaves');
  assert(/if \(!rowInScope\(scope, collection, row \|\| existing \|\| \{\}\)\) return \{ ok: false, error: 'out_of_scope' \};/.test(pr), 'parent leave must stay in scope');
  assert(/if \(row && row\.status != null &&\s*!policy\.LEAVE_REQUEST_STATUSES\.includes\(String\(row\.status\)\)\) return \{ ok: false, error: 'approval_denied' \};/.test(pr), 'Gateway must refuse a parent/student leave status outside LEAVE_REQUEST_STATUSES with approval_denied');
  const v = JSON.parse(s.vectors);
  const cases = (v.write || v.writes || v.cases || []).filter(c => c.scope === 'parent' && c.collection === 'leaves' && c.row && c.row.status);
  const want = { pending: 'ok', canceled: 'ok', approved: 'approval_denied', rejected: 'approval_denied' };
  for (const [st, exp] of Object.entries(want)) {
    const c = cases.find(x => x.row.status === st);
    assert(c, 'scope-v1 lacks a parent leave vector with status ' + st);
    const got = c.expect.ok ? 'ok' : c.expect.error;
    assert(got === exp, 'scope-v1 parent leave ' + st + ' ⇒ ' + got + ' (want ' + exp + ')');
  }
  return 'approval_denied for ' + Object.keys(want).filter(k => want[k] !== 'ok').join('/') + ' · ' + cases.length + ' vectors';
}

function nw5DataPath(s) {
  const b = code(s.book), w = code(s.wiring), m = code(s.main);
  assert(/implements AttendanceSource, GradeSource, NoticeSource, FamilySource \{/.test(w), 'the Gateway source must also serve the parents pages');
  const fb = block(w, 'Future<FamilyBook?> familyBookFor({', '\n  }\n');
  assert(/return FamilyBook\(engine: e, outbox: ob, role: role, uid: uid\);/.test(fb) && /if \(e == null \|\| ob == null \|\| _auto == null\) return null;/.test(fb), 'familyBookFor must reuse the shared engine/outbox and need AutoSync');
  assert(/family: flags\.ships\(NativeWave\.parents\) \? attendance : null,/.test(m), 'main must wire the parents pages only when the wave ships');
  // ids
  const base = Number((/static const int idBase = (\d+);/.exec(b) || [])[1]);
  const span = Number((/static const int idSpan = (\d+);/.exec(b) || [])[1]);
  assert(base >= 1 && span >= 1 && base + span <= 2 ** 53, 'id range must be positive and below 2^53');
  const ranges = [];
  for (const k of ['attendance', 'grades', 'notices']) {
    const ib = /static const int idBase = (\d+);/.exec(code(s[k]));
    if (ib) ranges.push([k, Number(ib[1])]);
  }
  const attMin = 4e15;
  assert(base + span <= attMin, 'leave id range overlaps the attendance range (from 4e15)');
  for (const [k, lo] of ranges) assert(base + span <= lo || base >= lo + 1e15, 'leave id range overlaps ' + k);
  assert(/return idBase \+ \(\(hi << 32\) \| lo\) % idSpan;/.test(b), 'id must stay inside the reserved range');
  assert(/for \(var i = 0; i < 8 && await engine\.get\(leaves, id\) != null; i\+\+\) \{/.test(b), 'local collision must redraw');
  assert(/'base_version': 0,/.test(b), 'a new request is sent with base 0 (collision ⇒ conflict, never overwrite)');
  // order: all checks → size → queue → local write
  const rq = block(b, 'Future<LeaveWriteResult> requestLeave({', '\n  }\n');
  const at = (re) => { const x = rq.search(re); assert(x >= 0, 'missing in requestLeave: ' + re); return x; };
  const order = [/_requireParent\(\);/, /await _linked\(studentId\);/, /validDay\(day\)/, /bytes > maxOpBytes/, /outbox\.enqueue\(/, /if \(!q\.ok\) throw/, /await engine\.put\(leaves, id, data, version: 0\);/].map(at);
  for (let i = 1; i < order.length; i++) assert(order[i] > order[i - 1], 'requestLeave order broken at step ' + i + ' (checks → size → queue → local write)');
  assert(/static const int maxOpBytes = 64 \* 1024;/.test(b), 'size ceiling = Gateway MAX_OP_BYTES');
  for (const k of ['book', 'ctrl']) assert(!/dart:io|HttpClient|package:http\b|Socket/.test(code(s[k])), k + ': no network code (Gateway only via AutoSync)');
  return 'shared data path · ids [' + base + ', ' + (base + span) + ') · checks → queue → local write';
}

function nw5Flags(s) {
  const f = code(s.flags);
  const defs = [...f.matchAll(/'(login,attendance,grades,notices[a-z,]*)'/g)].map(m => m[1]);
  assert(defs.length === 2 && defs.every(d => d === 'login,attendance,grades,notices,parents'), 'default waves must be login,attendance,grades,notices,parents (both places): ' + defs);
  assert(/enabled: fsrc != null && s\.flags\.uses\(NativeWave\.parents\),/.test(code(s.app)), 'page must need the parents wave');
  const sc = code(s.screen);
  const entry = sc.slice(sc.indexOf('class FamilyEntry'));
  assert(/if \(role != 'parent'\) \{/.test(entry), 'entry is for parents only');
  assert(/if \(!enabled\) \{\s*return const Text\(\s*'صفحهٔ فرزندان فعلاً در نسخهٔ وب نمایش داده می‌شود\.'/.test(entry), 'wave off ⇒ old (web) client message');
  assert(/if \(uid == null\)/.test(entry), 'unknown uid ⇒ no dead button');
  assert(/bool get isParent => role == 'parent';/.test(code(s.book)), 'book must check the parent role');
  const c = code(s.ctrl);
  assert(/final j = JalaliDate\.parse\(text\);/.test(c) && /back\.year != j\.year \|\|\s*back\.month != j\.month \|\|\s*back\.day != j\.day/.test(c), 'Jalali date must round-trip (refuse impossible days)');
  assert(/formError = FamilyError\.badDate\.messageFa;/.test(c), 'bad Jalali date ⇒ the book\'s badDate message, nothing queued');
  for (const k of ['ctrl', 'screen', 'wiring', 'app']) assert(!/webview|WebView|InAppWebView/.test(code(s[k])), k + ': no WebView');
  return 'default ' + defs[0] + ' · parents only · legacy message · Jalali round-trip';
}

function nw5Tests(s) {
  const neg = (src, re) => [...src.matchAll(re)].filter(m => /\(negative\)|NEG/.test(m[0])).length;
  const unitN = uniq(s.unit, /'W5-U\d+ /g), widgetN = uniq(s.widget, /'W5-[WS]\d+ /g);
  const negU = neg(s.unit, /'W5-U\d+ [^']*'/g), negW = neg(s.widget, /'W5-[WS]\d+ [^']*'/g);
  assert(negU >= 5, 'unit negatives ' + negU + ' < 5');
  assert(negW >= 6, 'widget negatives ' + negW + ' < 6');
  const its = uniq(s.it, /'W5-IT-0\d /g);
  assert(its === 8, 'IT scenarios ' + its + ' ≠ 8');
  for (const e of ['approval_denied', 'out_of_scope', 'role_denied']) assert(s.it.includes(e), 'IT must prove ' + e);
  assert(/PAYESH_GW_IT/.test(s.it) && !/skip: true/.test(s.it), 'IT must be env-gated, not skipped');
  assert(/server\/gateway\.js/.test(s.it) && !/MockClient|FakeGateway/.test(s.it), 'IT must use the real Gateway');
  const step = s.ci.slice(s.ci.indexOf('- name: payesh_sync ⇄ server/gateway.js (pinned TLS)'));
  const blk = step.slice(0, step.indexOf('echo GATEWAY-REAL-OK'));
  assert(blk.includes('test/family_it_test.dart'), 'CI gateway-real does not run the wave-5 IT');
  assert(blk.includes("grep -qE 'NATIVE-WAVE5-IT passed=8 negative_controls=9'"), 'CI must assert the exact wave-5 IT tally');
  assert(/if grep -qE '~\[0-9\]\+'/.test(blk), 'CI must fail on skipped tests');
  return `unit=${unitN} (neg ${negU}) widget=${widgetN} (neg ${negW}) IT=${its}`;
}

function nw5Doc(s) {
  const d = s.doc;
  const order = ['ورود و انتخاب مدرسه', 'حضور', 'نمره', 'اطلاعیه', 'والدین'];
  let at = -1;
  for (const w of order) { const i = d.indexOf(w, at + 1); assert(i > at, 'wave order in doc: ' + w); at = i; }
  assert(/موج ۵[^\n]*\[S\]/.test(d), 'wave 5 must be marked [S]');
  assert(/NOT RUN \[M\]/.test(d), 'doc must state NOT RUN [M]');
  assert(!/PASS \[M\]/.test(d), 'no [M] claim without a real device');
  assert(/UNKNOWN/.test(d), 'security stays UNKNOWN until row 92');
  for (const k of ['PAYESH_NATIVE_WAVES', 'login,attendance,grades,notices,parents', '/api/gw/v1/push', 'approval_denied', 'LEAVE_REQUEST_STATUSES', 'actLeaveAdd', 'created_at', 'همه یا هیچ', 'شمسی', 'NATIVE-WAVE5-IT passed=8 negative_controls=9']) assert(d.includes(k), 'doc lacks ' + k);
  return 'waves in order · wave 5 [S] · differences stated · NOT RUN [M]';
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
  ['M1 average green from 14', s => nw5Badges(mut(s, 'screen', 'final a when a >= 15 => PayeshTone.success,', 'final a when a >= 14 => PayeshTone.success,'))],
  ['M2 leave label drifts from the web', s => nw5Badges(mut(s, 'book', "rejected('رد شده')", "rejected('ردشده')"))],
  ['M3 unknown leave status reads as approved', s => nw5Badges(mut(s, 'book', "    _ => LeaveState.pending,\n  };", "    _ => LeaveState.approved,\n  };"))],
  ['M4 rejected shown amber', s => nw5Badges(mut(s, 'screen', 'LeaveState.rejected => PayeshTone.danger,', 'LeaveState.rejected => PayeshTone.warning,'))],
  ['M5 web gains an attendance label the client lacks', s => nw5Badges(mut(s, 'pages', "excused: 'موجه' }", "excused: 'موجه', sick: 'بیمار' }"))],
  ['M6 other parents\' links count', s => nw5Reads(mut(s, 'book', "if (_live(l) && _int(l.data['parent_id']) == uid) l,", 'if (_live(l)) l,'))],
  ['M7 pending grades in the average', s => nw5Reads(mut(s, 'book', "if (g.data['status'] == 'approved') _num(g.data['score']),", "_num(g.data['score']),"))],
  ['M8 attendance % floored', s => nw5Reads(mut(s, 'book', '(present * 100 / att.length).round(),', '(present * 100 ~/ att.length),'))],
  ['M9 20 attendance rows', s => nw5Reads(mut(s, 'book', 'static const int recentAttendance = 12;', 'static const int recentAttendance = 20;'))],
  ['M10 empty-family text drifts', s => nw5Reads(mut(s, 'screen', 'فرزندی به حساب شما متصل نیست — با دفتر مدرسه تماس بگیرید.', 'فرزندی ثبت نشده است.'))],
  ['M11 record gains a field the web does not send', s => nw5Writes(mut(s, 'book', "      'by_id': uid,\n    };", "      'by_id': uid,\n      'device': 'native',\n    };"))],
  ['M12 request sent as approved', s => nw5Writes(mut(s, 'book', "      'status': 'pending',\n      'by_id': uid,", "      'status': 'approved',\n      'by_id': uid,"))],
  ['M13 reason not trimmed', s => nw5Writes(mut(s, 'book', "'reason': reason.trim(),", "'reason': reason,"))],
  ['M14 request for any child', s => nw5Writes(mut(s, 'book', '    _requireParent();\n    await _linked(studentId);\n', '    _requireParent();\n'))],
  ['M15 leaves oldest first', s => nw5Writes(mut(s, 'book', '    out.sort((a, b) {\n      final c = b.date.compareTo(a.date);', '    out.sort((a, b) {\n      final c = a.date.compareTo(b.date);'))],
  ['M16 Gateway approval guard removed', s => nw5Gateway(mut(s, 'scope', "!policy.LEAVE_REQUEST_STATUSES.includes(String(row.status))) return { ok: false, error: 'approval_denied' };", "false) return { ok: false, error: 'approval_denied' };"))],
  ['M17 policy lets parents approve', s => nw5Gateway(mut(s, 'policy', "const LEAVE_REQUEST_STATUSES = ['pending', 'canceled'];", "const LEAVE_REQUEST_STATUSES = ['pending', 'canceled', 'approved'];"))],
  ['M18 contract vector weakened', s => nw5Gateway(mut(s, 'vectors', '"status": "approved",\n        "by_id": 7\n      },\n      "expect": {\n        "ok": false,\n        "error": "approval_denied"', '"status": "approved",\n        "by_id": 7\n      },\n      "expect": {\n        "ok": true'))],
  ['M19 id range overlaps attendance', s => nw5DataPath(mut(s, 'book', 'static const int idBase = 3000000000000000;', 'static const int idBase = 3500000000000000;'))],
  ['M20 new request sent with a non-zero base', s => nw5DataPath(mut(s, 'book', "      'base_version': 0,\n    });", "      'base_version': 1,\n    });"))],
  ['M21 local write before the queue accepted it', s => nw5DataPath(mut(s, 'book', '    final q = outbox.enqueue({', '    await engine.put(leaves, id, data, version: 0);\n    final q = outbox.enqueue({'))],
  ['M22 parents wired with the wave off', s => nw5DataPath(mut(s, 'main', 'family: flags.ships(NativeWave.parents) ? attendance : null,', 'family: attendance,'))],
  ['M23 page ignores the wave flag', s => nw5Flags(mut(s, 'app', 'enabled: fsrc != null && s.flags.uses(NativeWave.parents),', 'enabled: fsrc != null,'))],
  ['M24 default waves drop parents', s => nw5Flags(mut(s, 'flags', "defaultValue: 'login,attendance,grades,notices,parents", "defaultValue: 'login,attendance,grades,notices"))],
  ['M25 entry for every role', s => nw5Flags(mut(s, 'screen', "if (role != 'parent') {", 'if (role == null) {'))],
  ['M26 Jalali date not round-tripped', s => nw5Flags(mut(s, 'ctrl', 'back.day != j.day', 'false'))],
  ['M27 wave-5 IT removed from CI', s => nw5Tests(mut(s, 'ci', ' test/family_it_test.dart', ''))],
  ['M28 doc claims a real-device PASS', s => nw5Doc(mut(s, 'doc', 'NOT RUN [M]', 'PASS [M]'))],
];

async function main(opts) {
  const quiet = !!(opts && opts.quiet);
  const s = load();
  const out = []; let passed = 0; const failures = [];
  const run = (id, desc, fn) => { try { const d = fn(); passed++; out.push(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); } catch (e) { failures.push(id + ': ' + e.message); out.push(`FAIL  ${id}  ${desc}  → ${e.message}`); } };
  run('NW5-01', 'badges and labels = web (average, attendance, leave states)', () => nw5Badges(s));
  run('NW5-02', 'reads = parentHome / PAGES.child', () => nw5Reads(s));
  run('NW5-03', 'leave request = web leave form', () => nw5Writes(s));
  run('NW5-04', 'Gateway refuses parent approvals (approval_denied)', () => nw5Gateway(s));
  run('NW5-05', 'shared Gateway data path, id range, queue before local write', () => nw5DataPath(s));
  run('NW5-06', 'wave flag, parent role, Jalali date', () => nw5Flags(s));
  run('NW5-07', 'negatives, real IT in CI with exact tally', () => nw5Tests(s));
  run('NW5-08', 'row doc: wave order, wave 5 [S], NOT RUN [M]', () => nw5Doc(s));
  let killed = 0;
  run('NW5-09', 'mutants turn red', () => {
    for (const [name, fn] of MUTANTS) {
      let red = false;
      try { fn(s); } catch (e) { if (e instanceof AnchorError) throw e; red = true; }
      assert(red, 'mutant survived: ' + name); killed++;
    }
    return killed + '/' + MUTANTS.length + ' killed';
  });
  if (!quiet) out.forEach(l => console.log(l));
  const r = { passed, failed: failures.length, failures, negatives: killed };
  if (!quiet) console.log(`\nNATIVE-WAVE5-74 ${r.failed ? 'FAILED' : 'OK'} passed=${passed} failed=${r.failed} negative_controls=${killed}`);
  return r;
}
module.exports = { main };
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
