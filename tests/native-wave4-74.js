'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۷۴ موج ۴ — اطلاعیه در کلاینت بومی: هم‌خوانی با قرارداد (برابری با کلاینت وب)

   NW4-01  اهمیت: NoticeSeverity در Dart دقیقاً گزینه‌های فرم وب (actAnnAdd) به همان ترتیب و با
           همان برچسب؛ پیش‌فرض «عادی»؛ مقدار ناشناخته ⇐ عادی؛ رنگ مهم/اطلاع‌رسانی مثل نشان وب
   NW4-02  معنای نوشتن = فرم ann وب: عنوان و متن الزامی و trim، شکل رکورد = ردیف وب منهای
           school_id، تاریخ = روز UTC (todayISO) و در ویرایش ثابت، ویرایش فیلدهای دیگر را نگه
           می‌دارد (Object.assign)، ترتیب جدیدترین اول، خواننده‌ها = ROLES، نویسنده = policy
   NW4-03  نگهبان Gateway: announcements فقط برای مدیر؛ del هم از canWriteCollection رد می‌شود؛
           والد/دانش‌آموز نگهبان دوم دارند؛ بردارهای scope-v1 همین را می‌گویند
   NW4-04  شناسه: بازهٔ رزرو بالای بازهٔ نمره و زیر 2^53؛ رکورد تازه با base 0 (برخورد ⇐ تعارض)،
           قرعهٔ دوباره برای برخورد محلی؛ ویرایش/حذف با base = نسخه + صف
   NW4-05  مسیر داده: همان پایگاه/صندوقچه/Gateway (noticeBoardFor)، main فقط با موج روشن،
           اعتبارسنجی و سقف حجم پیش از صف، صف پیش از نوشتن محلی، board بدون شبکه
   NW4-06  پرچم: پیش‌فرض login,attendance,grades,notices؛ صفحه فقط با uses(notices) و نقش
           خواننده؛ موج خاموش ⇐ پیام نسخهٔ وب؛ دکمهٔ نوشتن فقط برای مدیر؛ بدون WebView
   NW4-07  آزمون‌ها: شمار کنترل منفی، ۸ سناریوی IT واقعی در CI با شمارش دقیق، رد شدن skip
   NW4-08  سند ردیف: ترتیب موج‌ها، موج ۴ [S]، NOT RUN [M] صریح، Security UNKNOWN
   NW4-09  جهش‌ها: هر ویرایش ممنوع قرمز می‌شود
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const F = {
  board: 'apps/payesh/packages/payesh_sync/lib/src/notices.dart',
  grades: 'apps/payesh/packages/payesh_sync/lib/src/grades.dart',
  ctrl: 'apps/payesh/app/lib/src/notices/notices_controller.dart',
  screen: 'apps/payesh/app/lib/src/notices/notices_screen.dart',
  wiring: 'apps/payesh/app/lib/src/attendance/attendance_wiring.dart',
  app: 'apps/payesh/app/lib/src/app.dart',
  flags: 'apps/payesh/app/lib/src/flags.dart',
  main: 'apps/payesh/app/lib/main.dart',
  pages: 'client/pages.js',
  appjs: 'client/app.js',
  policy: 'server/policy.js',
  scope: 'server/scope.js',
  tenancy: 'server/tenancy.js',
  vectors: 'docs/cloud/contracts/vectors/scope-v1.json',
  unit: 'apps/payesh/packages/payesh_sync/test/notices_test.dart',
  widget: 'apps/payesh/app/test/notices_wave4_test.dart',
  it: 'apps/payesh/packages/payesh_sync/test/notices_it_test.dart',
  ci: '.github/workflows/native-client.yml',
  doc: 'docs/cloud/74-native-wave4-notices.md',
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
const webForm = (s) => block(s.pages, 'function actAnnAdd(row) {', '\n}\n');
const webPage = (s) => block(s.pages, 'PAGES.announcements = () => {', '\n};\n');
const webSave = (s) => block(s.appjs, "if (kind === 'ann') {", '\n  }\n');
const dartList = (src) => src.split(',').map(x => x.trim().replace(/'/g, '')).filter(Boolean);

function nw4Severity(s) {
  const b = code(s.board);
  const en = /enum NoticeSeverity \{([\s\S]*?);\n/.exec(b);
  assert(en, 'enum NoticeSeverity missing');
  const dart = [...en[1].matchAll(/^\s+([a-zA-Z]+)\('([^']+)'\)/gm)].map(m => m[1] + '=' + m[2]);
  const web = [...webForm(s).matchAll(/<option value="([a-z]+)"[^>]*>([^<]+)<\/option>/g)].map(m => m[1] + '=' + m[2]);
  assert(web.length === 3, 'web severity options changed: ' + web);
  assert(JSON.stringify(dart) === JSON.stringify(web), 'Dart severities ' + dart + ' ≠ web ' + web);
  assert(/String get wire => name;/.test(b), 'stored value must be the enum name (= web option value)');
  assert(/const sev = editing \? String\(row\.severity \|\| 'normal'\) : 'normal';/.test(webForm(s)), 'web default severity changed');
  assert(/severity: f\.severity \? f\.severity\.value : 'normal'/.test(webSave(s)), 'web saved severity default changed');
  assert(/widget\.editing\?\.severity \?\? NoticeSeverity\.normal;/.test(code(s.screen)), 'native editor default must be normal');
  assert(/for \(final s in values\) \{\s*if \(s\.wire == v\) return s;\s*\}\s*return NoticeSeverity\.normal;/.test(b), 'unknown severity must read as normal');
  assert(/a\.severity === 'important' \? 'red' : a\.severity === 'info' \? 'purple' : ''/.test(webPage(s)), 'web badge colours changed');
  const sc = code(s.screen);
  assert(/NoticeSeverity\.important => PayeshTone\.danger,/.test(sc) && /NoticeSeverity\.info => PayeshTone\.info,/.test(sc) && /NoticeSeverity\.normal => PayeshTone\.neutral,/.test(sc), 'native tones ≠ web badge (important red, info coloured, normal plain)');
  return 'severities=' + dart.map(x => x.split('=')[0]).join('/') + ' · default normal · unknown → normal';
}

function nw4Semantics(s) {
  const b = code(s.board);
  const save = webSave(s), form = webForm(s);
  // required fields + trim
  assert(/const title = String\(f\.title\.value \|\| ''\)\.trim\(\);\s*if \(!title\) return toast\('عنوان اطلاعیه را بنویسید'/.test(save), 'web title rule changed');
  assert(/name="body" required/.test(form) && /body: String\(f\.body\.value \|\| ''\)\.trim\(\)/.test(save), 'web body rule changed (required + trim)');
  assert(/final t = title\.trim\(\);/.test(b) && /final b = body\.trim\(\);/.test(b), 'Dart must trim title and body');
  assert(/if \(t\.isEmpty\) throw const NoticeFailure\(NoticeError\.emptyTitle\);/.test(b) && /if \(b\.isEmpty\) throw const NoticeFailure\(NoticeError\.emptyBody\);/.test(b), 'Dart must require title and body');
  assert(/NoticeError\.emptyTitle => 'عنوان اطلاعیه را بنویسید',/.test(b), 'empty-title message ≠ web toast');
  // record shape (publish)
  const row = /const row = \{([\s\S]*?)\};/.exec(save);
  assert(row, 'web announcement row missing');
  /* top-level entries only (values contain commas inside parentheses); `key: v` and shorthand `key` */
  const entries = []; let depth = 0, cur = '';
  for (const ch of row[1]) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { entries.push(cur); cur = ''; } else cur += ch;
  }
  entries.push(cur);
  const webKeys = entries.map(t => /^\s*([a-z_]+)\s*(?::|$)/.exec(t)).filter(Boolean).map(m => m[1]).filter(k => k !== 'school_id');
  const pub = block(b, 'Future<NoticeWriteResult> publish({', '_requireSize(data);');
  const dm = /final data = <String, Object\?>\{([\s\S]*?)\};/.exec(pub);
  assert(dm, 'Dart publish record missing');
  const dartKeys = [...dm[1].matchAll(/'([a-z_]+)':/g)].map(m => m[1]).filter(k => k !== 'id');
  assert(JSON.stringify([...dartKeys].sort()) === JSON.stringify([...new Set(webKeys)].sort()), 'record fields Dart ' + dartKeys + ' ≠ web ' + webKeys);
  assert(/delete clean\.school_id;/.test(s.tenancy), 'Gateway no longer strips school_id — re-check record shape');
  assert(/author_id: S\.user \? S\.user\.id : null/.test(save) && /'author_id': uid,/.test(pub), 'author = the writing user (web rule)');
  // date: UTC day, kept on edit
  assert(/const todayISO = \(\) => now\(\)\.toISOString\(\)\.slice\(0, 10\);/.test(s.appjs), 'web todayISO changed (UTC day)');
  assert(/date: \(id && \(byId\('announcements', id\) \|\| \{\}\)\.date\) \|\| todayISO\(\),/.test(save), 'web edit-keeps-date rule changed');
  assert(/String today\(\) => _now\(\)\.toUtc\(\)\.toIso8601String\(\)\.substring\(0, 10\);/.test(b), 'Dart day must be the UTC day');
  assert(/'date': today\(\),/.test(pub), 'a new notice is dated today');
  const ed = block(b, 'Future<NoticeWriteResult> edit({', 'Future<NoticeWriteResult> delete(');
  assert(/'date': stored\.isEmpty \? today\(\) : stored,/.test(ed), 'an edit must keep the stored date');
  // edit merges the stored row
  assert(/Object\.assign\(\{\}, byId\('announcements', id\) \|\| \{\}, row, \{ id \}\)/.test(save), 'web edit merge changed');
  assert(/\.\.\.r\.data,/.test(ed), 'Dart edit must keep the other stored fields');
  // order
  assert(/sortBy\(list\('announcements'\), 'date'\)\.reverse\(\)/.test(webPage(s)), 'web order changed');
  assert(/final c = b\.date\.compareTo\(a\.date\);/.test(b), 'Dart order must be newest first');
  // readers / writers
  const pol = /announcements:\s*\{ write: \[([^\]]+)\], read: '([a-z]+)' \}/.exec(s.policy);
  assert(pol, 'policy announcements entry changed');
  const w = dartList(pol[1]).sort();
  const dw = /static const Set<String> writers = \{([^}]+)\};/.exec(b);
  assert(dw && JSON.stringify(dartList(dw[1]).sort()) === JSON.stringify(w), 'writers ≠ policy ' + w);
  assert(pol[2] === 'all', 'policy read must stay all');
  const roles = dartList(/const ROLES = \[([^\]]+)\];/.exec(s.policy)[1]).sort();
  const dr = /static const Set<String> readers = \{([^}]+)\};/.exec(b);
  assert(dr && JSON.stringify(dartList(dr[1]).sort()) === JSON.stringify(roles), 'readers ≠ policy ROLES ' + roles);
  assert(/canWrite = S\.role === 'manager'/.test(webPage(s)), 'web write controls changed');
  return 'title+body required · ' + dartKeys.length + ' fields · UTC day kept on edit · newest first · readers=' + roles.length + ' writers=' + w.join('/');
}

function nw4Gateway(s) {
  const sc = code(s.scope), t = code(s.tenancy);
  assert(/if \(!canWriteCollection\(scope, collection\)\) return \{ ok: false, error: 'role_denied' \};/.test(sc), 'canWriteRow must refuse collections the role cannot write');
  const pr = block(sc, "if (scope.role === 'parent' || scope.role === 'student') {", "if (scope.role === 'counselor')");
  assert(/if \(collection !== 'leaves'\) return \{ ok: false, error: 'role_denied' \};/.test(pr), 'parents/students must only write leaves (second guard)');
  const ap = block(t, 'async function applyOps(', 'const applied = [];');
  assert(/if \(!scopeMod\.canWriteCollection\(scope, p\.collection\)\) \{\s*throw new TenancyError\('role_denied', 403/.test(ap), 'applyOps must check the collection for every op (incl. del)');
  assert(/const target = p\.type === 'del' \? \(existing \|\| \{\}\)/.test(ap), 'a del must be scope-checked against the stored row');
  const v = JSON.parse(s.vectors);
  const has = (scope, exp) => v.write.some(c => c.scope === scope && c.collection === 'announcements' && JSON.stringify(c.expect) === JSON.stringify(exp));
  assert(has('teacher', { ok: false, error: 'role_denied' }), 'scope-v1 lacks: teacher announcements → role_denied');
  assert(has('parent', { ok: false, error: 'role_denied' }), 'scope-v1 lacks: parent announcements → role_denied');
  assert(has('manager', { ok: true }), 'scope-v1 lacks: manager announcements → ok');
  assert(v.read.some(c => c.scope === 'parent' && c.collection === 'announcements' && c.expect === true), 'scope-v1 lacks: parent reads announcements');
  return 'manager-only writes (put + del) · parent/student second guard · 3 write + 1 read vectors';
}

function nw4Ids(s) {
  const b = code(s.board), g = code(s.grades);
  const num = (src, n) => { const m = new RegExp('static const int ' + n + ' = (\\d+);').exec(src); assert(m, n + ' missing'); return BigInt(m[1]); };
  const base = num(b, 'idBase'), span = num(b, 'idSpan');
  assert(base + span < 2n ** 53n, 'notice id range ends at ' + (base + span) + ' ≥ 2^53');
  const gradeTop = num(g, 'idBase') + num(g, 'idSpan');
  assert(base >= gradeTop, 'notice ids overlap the grade range (< ' + gradeTop + ')');
  assert(/return idBase \+ \(\(hi << 32\) \| lo\) % idSpan;/.test(b), 'id must stay inside [idBase, idBase + idSpan)');
  assert(/_random = random \?\? Random\.secure\(\)/.test(b), 'production ids must come from a secure random source');
  assert(/for \(var i = 0; i < 8 && await engine\.get\(collection, id\) != null; i\+\+\) \{\s*id = _newId\(\);/.test(b), 'a local id collision must be re-drawn');
  const pub = block(b, 'Future<NoticeWriteResult> publish({', 'Future<EngineRow> _existing(');
  assert(/await _enqueue\('put', id, data, 0\);/.test(pub), 'a new notice must be sent with base version 0 (collision ⇒ conflict)');
  const ed = block(b, 'Future<NoticeWriteResult> edit({', 'Future<NoticeWriteResult> delete(');
  const del = b.slice(b.indexOf('Future<NoticeWriteResult> delete('));
  assert(/await _enqueue\('put', id, data, r\.version \+ _queued\(id\)\);/.test(ed), 'edit base must add the ops still queued');
  assert(/await _enqueue\('del', id, null, r\.version \+ _queued\(id\)\);/.test(del), 'delete base must add the ops still queued');
  assert(/if \(baseVersion != null && Number\(baseVersion\) !== version\) return \{ conflict: true/.test(s.tenancy), 'Gateway base_version rule changed — re-check the collision argument');
  return 'range [' + base + ', ' + (base + span) + ') · above grades ' + gradeTop + ' · new base 0';
}

function nw4DataPath(s) {
  const w = code(s.wiring);
  assert(/implements\s+AttendanceSource,\s*GradeSource,\s*NoticeSource\b/.test(w), 'the Gateway source must serve notices too (one data path)');
  assert(/return NoticeBoard\(engine: e, outbox: ob, role: role, uid: uid\);/.test(w), 'notice board must use the same engine and outbox');
  assert(/notices: flags\.ships\(NativeWave\.notices\) \? attendance : null,/.test(s.main), 'main: notices only when the wave ships, on the shared data path');
  const b = code(s.board);
  assert(!/HttpClient|Transport|GatewaySync|\/api\//.test(b), 'NoticeBoard must not talk to the network');
  const order = (fn, marks) => {
    const body = block(b, fn, '\n  }\n');
    let at = -1;
    for (const m of marks) { const i = body.indexOf(m); assert(i > at, fn + ': ' + m + ' out of order'); at = i; }
  };
  order('Future<NoticeWriteResult> publish({', ['_requireWriter();', '_clean(title, body)', '_requireSize(data);', "_enqueue('put'", 'engine.put(']);
  order('Future<NoticeWriteResult> edit({', ['_requireWriter();', '_clean(title, body)', '_existing(id)', '_requireSize(data);', "_enqueue('put'", 'engine.put(']);
  order('Future<NoticeWriteResult> delete(', ['_requireWriter();', '_existing(id)', "_enqueue('del'", 'engine.del(']);
  assert(/static const int maxOpBytes = 64 \* 1024;/.test(b) && /const MAX_OP_BYTES = 64 \* 1024;/.test(s.tenancy), 'size ceiling must equal the Gateway MAX_OP_BYTES');
  assert(/if \(res\.key != null\) source\.queued\(\);/.test(code(s.ctrl)), 'a queued write must nudge AutoSync');
  return 'shared Gateway path · validate → size → enqueue → local write · no network in the board';
}

function nw4Flags(s) {
  const d = /'PAYESH_NATIVE_WAVES',\s*defaultValue: '([a-z,]*)'/.exec(s.flags);
  assert(d && d[1].split(',').slice(0, 4).join(',') === 'login,attendance,grades,notices', 'default waves must ship notices');
  assert(/enabled: nsrc != null && s\.flags\.uses\(NativeWave\.notices\),/.test(s.app), 'page must need the notices wave');
  const sc = code(s.screen);
  const entry = sc.slice(sc.indexOf('class NoticesEntry'));
  assert(/if \(role == null \|\| !NoticeBoard\.readers\.contains\(role\)\)/.test(entry), 'entry must check the reader roles');
  assert(/if \(!enabled\) \{\s*return const Text\(\s*'اطلاعیه‌ها فعلاً در نسخهٔ وب نمایش داده می‌شود\.'/.test(entry), 'wave off ⇒ old (web) client message');
  assert(/if \(uid == null\)/.test(entry), 'unknown uid ⇒ no dead button');
  assert(/floatingActionButton: c\.canWrite/.test(sc) && /if \(c\.canWrite\) \.\.\.\[/.test(sc), 'write controls only for writers');
  assert(/bool get canWrite => NoticeBoard\.writers\.contains\(role\);/.test(code(s.ctrl)), 'controller canWrite must come from the board writers');
  for (const k of ['ctrl', 'screen', 'wiring', 'app']) assert(!/webview|WebView|InAppWebView/.test(code(s[k])), k + ': no WebView');
  return 'default login,attendance,grades,notices · readers see it · writers write · legacy message';
}

function nw4Tests(s) {
  const neg = (src, re) => [...src.matchAll(re)].filter(m => /\(negative\)|NEG/.test(m[0])).length;
  const unitN = uniq(s.unit, /'W4-U\d+ /g), widgetN = uniq(s.widget, /'W4-W\d+ /g);
  const negU = neg(s.unit, /'W4-U\d+ [^']*'/g), negW = neg(s.widget, /'W4-W\d+ [^']*'/g);
  assert(negU >= 6, 'unit negatives ' + negU + ' < 6');
  assert(negW >= 6, 'widget negatives ' + negW + ' < 6');
  const its = uniq(s.it, /'W4-IT-0\d /g);
  assert(its === 8, 'IT scenarios ' + its + ' ≠ 8');
  assert(/role_denied/.test(s.it) && /conflicts, 1/.test(s.it), 'IT must prove role_denied and the conflict paths');
  assert(/PAYESH_GW_IT/.test(s.it) && !/skip: true/.test(s.it), 'IT must be env-gated, not skipped');
  assert(/server\/gateway\.js/.test(s.it) && !/MockClient|FakeGateway/.test(s.it), 'IT must use the real Gateway');
  const step = s.ci.slice(s.ci.indexOf('- name: payesh_sync ⇄ server/gateway.js (pinned TLS)'));
  const blk = step.slice(0, step.indexOf('echo GATEWAY-REAL-OK'));
  assert(blk.includes('test/notices_it_test.dart'), 'CI gateway-real does not run the wave-4 IT');
  assert(blk.includes("grep -qE 'NATIVE-WAVE4-IT passed=8 negative_controls=8'"), 'CI must assert the exact wave-4 IT tally');
  assert(/if grep -qE '~\[0-9\]\+'/.test(blk), 'CI must fail on skipped tests');
  return `unit=${unitN} (neg ${negU}) widget=${widgetN} (neg ${negW}) IT=${its}`;
}

function nw4Doc(s) {
  const d = s.doc;
  const order = ['ورود و انتخاب مدرسه', 'حضور', 'نمره', 'اطلاعیه', 'والدین'];
  let at = -1;
  for (const w of order) { const i = d.indexOf(w, at + 1); assert(i > at, 'wave order in doc: ' + w); at = i; }
  assert(/موج ۴[^\n]*\[S\]/.test(d), 'wave 4 must be marked [S]');
  assert(/NOT RUN \[M\]/.test(d), 'doc must state NOT RUN [M]');
  assert(!/PASS \[M\]/.test(d), 'no [M] claim without a real device');
  assert(/UNKNOWN/.test(d), 'security stays UNKNOWN until row 92');
  for (const k of ['PAYESH_NATIVE_WAVES', 'login,attendance,grades,notices', '/api/gw/v1/push', 'role_denied', 'actAnnAdd', 'NATIVE-WAVE4-IT passed=8 negative_controls=8']) assert(d.includes(k), 'doc lacks ' + k);
  return 'waves in order · wave 4 [S] · NOT RUN [M]';
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
  ['M1 Dart severity label drifts from the web', s => nw4Severity(mut(s, 'board', "info('اطلاع‌رسانی')", "info('اطلاعات')"))],
  ['M2 web gains a severity the client lacks', s => nw4Severity(mut(s, 'pages', '<option value="important"', '<option value="urgent">فوری</option>\n      <option value="important"'))],
  ['M3 unknown severity reads as important', s => nw4Severity(mut(s, 'board', 'return NoticeSeverity.normal;\n  }', 'return NoticeSeverity.important;\n  }'))],
  ['M4 important shown in a neutral tone', s => nw4Severity(mut(s, 'screen', 'NoticeSeverity.important => PayeshTone.danger,', 'NoticeSeverity.important => PayeshTone.neutral,'))],
  ['M5 body no longer required', s => nw4Semantics(mut(s, 'board', 'if (b.isEmpty) throw const NoticeFailure(NoticeError.emptyBody);', ''))],
  ['M6 title not trimmed', s => nw4Semantics(mut(s, 'board', 'final t = title.trim();', 'final t = title;'))],
  ['M7 record gains a field the web does not send', s => nw4Semantics(mut(s, 'board', "      'author_id': uid,\n    };\n    _requireSize(data);\n    final k = await _enqueue('put', id, data, 0);", "      'author_id': uid,\n      'device': 'native',\n    };\n    _requireSize(data);\n    final k = await _enqueue('put', id, data, 0);"))],
  ['M8 device-local date instead of UTC', s => nw4Semantics(mut(s, 'board', '_now().toUtc().toIso8601String()', '_now().toIso8601String()'))],
  ['M9 edit re-dates the notice', s => nw4Semantics(mut(s, 'board', "'date': stored.isEmpty ? today() : stored,", "'date': today(),"))],
  ['M10 edit drops the other stored fields', s => nw4Semantics(mut(s, 'board', '      ...r.data,\n', ''))],
  ['M11 oldest first', s => nw4Semantics(mut(s, 'board', 'final c = b.date.compareTo(a.date);', 'final c = a.date.compareTo(b.date);'))],
  ['M12 teachers may write notices', s => nw4Semantics(mut(s, 'board', "static const Set<String> writers = {'manager'};", "static const Set<String> writers = {'manager', 'teacher'};"))],
  ['M13 Gateway policy lets teachers write', s => nw4Semantics(mut(s, 'policy', "announcements:    { write: ['manager'], read: 'all' },", "announcements:    { write: ['manager', 'teacher'], read: 'all' },"))],
  ['M14 parent second guard removed', s => nw4Gateway(mut(s, 'scope', "if (collection !== 'leaves') return { ok: false, error: 'role_denied' };", ''))],
  ['M15 contract vector weakened', s => nw4Gateway(mut(s, 'vectors', '"collection": "announcements",\n      "row": {\n        "title": "اطلاعیه",\n        "body": "متن",\n        "severity": "normal",\n        "date": "2026-11-12"\n      },\n      "expect": {\n        "ok": false,\n        "error": "role_denied"', '"collection": "announcements",\n      "row": {\n        "title": "اطلاعیه",\n        "body": "متن",\n        "severity": "normal",\n        "date": "2026-11-12"\n      },\n      "expect": {\n        "ok": false,\n        "error": "out_of_scope"'))],
  ['M16 id range overlaps grades', s => nw4Ids(mut(s, 'board', 'static const int idBase = 9000000000000000;', 'static const int idBase = 8000000000000000;'))],
  ['M17 new notice sent with a non-zero base (collision would overwrite)', s => nw4Ids(mut(s, 'board', "await _enqueue('put', id, data, 0);", "await _enqueue('put', id, data, 1);"))],
  ['M18 self-conflict: edit base ignores queued ops', s => nw4Ids(mut(s, 'board', "await _enqueue('put', id, data, r.version + _queued(id));", "await _enqueue('put', id, data, r.version);"))],
  ['M19 local write before the queue accepted it', s => nw4DataPath(mut(s, 'board', "    final k = await _enqueue('put', id, data, 0);\n    await engine.put(collection, id, data, version: 0);", "    await engine.put(collection, id, data, version: 0);\n    final k = await _enqueue('put', id, data, 0);"))],
  ['M20 notices wired with the wave off', s => nw4DataPath(mut(s, 'main', 'notices: flags.ships(NativeWave.notices) ? attendance : null,', 'notices: attendance,'))],
  ['M21 page ignores the wave flag', s => nw4Flags(mut(s, 'app', 'enabled: nsrc != null && s.flags.uses(NativeWave.notices),', 'enabled: nsrc != null,'))],
  ['M22 default waves drop notices', s => nw4Flags(mut(s, 'flags', "defaultValue: 'login,attendance,grades,notices", "defaultValue: 'login,attendance,grades,x"))],
  ['M23 add button for every role', s => nw4Flags(mut(s, 'screen', 'floatingActionButton: c.canWrite', 'floatingActionButton: true'))],
  ['M24 wave-4 IT removed from CI', s => nw4Tests(mut(s, 'ci', ' test/notices_it_test.dart', ''))],
  ['M25 doc claims a real-device PASS', s => nw4Doc(mut(s, 'doc', 'NOT RUN [M]', 'PASS [M]'))],
];

async function main(opts) {
  const quiet = !!(opts && opts.quiet);
  const s = load();
  const out = []; let passed = 0; const failures = [];
  const run = (id, desc, fn) => { try { const d = fn(); passed++; out.push(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); } catch (e) { failures.push(id + ': ' + e.message); out.push(`FAIL  ${id}  ${desc}  → ${e.message}`); } };
  run('NW4-01', 'severities = web form options, default normal', () => nw4Severity(s));
  run('NW4-02', 'write semantics = web ann form', () => nw4Semantics(s));
  run('NW4-03', 'manager-only writes, also in the Gateway', () => nw4Gateway(s));
  run('NW4-04', 'record id range and base_version', () => nw4Ids(s));
  run('NW4-05', 'shared Gateway data path, queue before local write', () => nw4DataPath(s));
  run('NW4-06', 'wave flag, reader/writer roles', () => nw4Flags(s));
  run('NW4-07', 'negatives, real IT in CI with exact tally', () => nw4Tests(s));
  run('NW4-08', 'row doc: wave order, wave 4 [S], NOT RUN [M]', () => nw4Doc(s));
  let killed = 0;
  run('NW4-09', 'mutants turn red', () => {
    for (const [name, fn] of MUTANTS) {
      let red = false;
      try { fn(s); } catch (e) { if (e instanceof AnchorError) throw e; red = true; }
      assert(red, 'mutant survived: ' + name); killed++;
    }
    return killed + '/' + MUTANTS.length + ' killed';
  });
  if (!quiet) out.forEach(l => console.log(l));
  const r = { passed, failed: failures.length, failures, negatives: killed };
  if (!quiet) console.log(`\nNATIVE-WAVE4-74 ${r.failed ? 'FAILED' : 'OK'} passed=${passed} failed=${r.failed} negative_controls=${killed}`);
  return r;
}
module.exports = { main };
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
