'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۷۴ موج ۲ — حضور و غیاب در کلاینت بومی: هم‌خوانی با قرارداد (برابری با کلاینت وب)

   NW2-01  وضعیت‌ها: AttendanceStatus در Dart دقیقاً ATT_STATUS سرور (server/policy.js) و
           برچسب‌ها دقیقاً ATT_LABEL کلاینت وب (client/pages.js)، به همان ترتیب
   NW2-02  معنای ذخیره = actAttendanceSave: فهرست = role student + همان class_id، پیش‌فرض
           present، بدون‌تغییر رد می‌شود، کلید روز = روز UTC، شکل رکورد = رکورد وب منهای
           school_id/_version (school_id را Gateway حذف می‌کند)، نویسنده‌ها = policy
   NW2-03  شناسهٔ رکورد: فرمول (روز، دانش‌آموز) در بازهٔ رزرو و زیر 2^53؛ base_version با صف
   NW2-04  مسیر داده: فقط Gateway (GatewayTransport/GatewaySync/AutoSync با کلاینت pinned)،
           DeviceOwner.claim پیش از شروع همگام‌سازی، وضعیت صندوقچه در نشان Sync، همه یا هیچ
   NW2-05  پرچم: پیش‌فرض login,attendance؛ صفحه فقط با uses(attendance) و نقش نویسنده؛ موج
           خاموش ⇒ پیام نسخهٔ وب (بدون دکمهٔ مرده)
   NW2-06  دستگاه مشترک: صف یا بررسی باز ⇒ blocked (هیچ پاک/ارسالی)؛ جابه‌جایی ⇒ پاک‌شدن
           ردیف‌ها، مکان‌نما و فهرست بررسی؛ uid ذخیره‌شده با خروج پاک می‌شود
   NW2-07  آزمون‌ها: شمار کنترل منفی، ۸ سناریوی IT واقعی در CI با شمارش دقیق، رد شدن skip
   NW2-08  سند ردیف: ترتیب موج‌ها، موج ۲ [S]، NOT RUN [M] صریح
   NW2-09  جهش‌ها: هر ویرایش ممنوع قرمز می‌شود
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const F = {
  book: 'apps/payesh/packages/payesh_sync/lib/src/attendance.dart',
  owner: 'apps/payesh/packages/payesh_sync/lib/src/device_owner.dart',
  access: 'apps/payesh/packages/payesh_sync/lib/src/school_access.dart',
  ctrl: 'apps/payesh/app/lib/src/attendance/attendance_controller.dart',
  screen: 'apps/payesh/app/lib/src/attendance/attendance_screen.dart',
  wiring: 'apps/payesh/app/lib/src/attendance/attendance_wiring.dart',
  session: 'apps/payesh/app/lib/src/login/session_controller.dart',
  app: 'apps/payesh/app/lib/src/app.dart',
  flags: 'apps/payesh/app/lib/src/flags.dart',
  main: 'apps/payesh/app/lib/main.dart',
  pages: 'client/pages.js',
  appjs: 'client/app.js',
  policy: 'server/policy.js',
  tenancy: 'server/tenancy.js',
  unit: 'apps/payesh/packages/payesh_sync/test/attendance_test.dart',
  widget: 'apps/payesh/app/test/attendance_wave2_test.dart',
  it: 'apps/payesh/packages/payesh_sync/test/attendance_it_test.dart',
  ci: '.github/workflows/native-client.yml',
  doc: 'docs/cloud/74-native-wave2-attendance.md',
};

function assert(c, m) { if (!c) throw new Error(m); }
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* comments never satisfy (or break) a check */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const uniq = (src, re) => new Set([...src.matchAll(re)].map(m => m[0])).size;

function dartStatuses(s) {
  const en = /enum AttendanceStatus \{([\s\S]*?);\n/.exec(code(s.book));
  assert(en, 'enum AttendanceStatus missing');
  return [...en[1].matchAll(/^\s+[a-zA-Z]+\('([a-z_]+)', '([^']+)'\)/gm)].map(m => [m[1], m[2]]);
}

function nw2Statuses(s) {
  const dart = dartStatuses(s);
  const srv = /const ATT_STATUS = \[([^\]]+)\];/.exec(s.policy);
  assert(srv, 'server ATT_STATUS missing');
  const server = srv[1].split(',').map(x => x.trim().replace(/'/g, ''));
  assert(JSON.stringify(dart.map(d => d[0])) === JSON.stringify(server), 'Dart statuses ' + dart.map(d => d[0]) + ' ≠ server ' + server);
  const lab = /const ATT_LABEL = \{([^}]+)\};/.exec(s.pages);
  assert(lab, 'web ATT_LABEL missing');
  const web = [...lab[1].matchAll(/([a-z_]+): '([^']+)'/g)].map(m => [m[1], m[2]]);
  assert(JSON.stringify(dart) === JSON.stringify(web), 'Dart labels ≠ web ATT_LABEL: ' + JSON.stringify(dart));
  assert(/for \(final s in values\) \{\s*if \(s\.wire == v\) return s;\s*\}\s*return null;/.test(s.book), 'unknown status must map to null (never present)');
  return dart.map(d => d[0] + '=' + d[1]).join(' ');
}

function nw2Semantics(s) {
  const b = code(s.book);
  const web = s.pages.slice(s.pages.indexOf('async function actAttendanceSave'));
  const fn = web.slice(0, web.indexOf('\n}\n'));
  // roster
  assert(/u\.role === 'student' && Number\(u\.class_id\) === Number\(classId\)/.test(fn), 'web roster rule changed — re-check parity');
  assert(/engine\.byRef\('users', 'class_id', classId\)/.test(b) && /if \(u\.data\['role'\] != 'student'\) continue;/.test(b), 'Dart roster must be role student + same class_id');
  // default present + skip unchanged
  assert(/: 'present'\);/.test(fn) && /if \(ex && ex\.status === status\) continue;/.test(fn), 'web default/skip changed');
  assert(/marks\[r\.studentId\] \?\? r\.recorded \?\? AttendanceStatus\.present/.test(b), 'Dart default must be present (draft → stored → present)');
  assert(/if \(r\.recorded == status\) \{\s*unchanged\+\+;\s*continue;/.test(b), 'Dart must skip unchanged students');
  // day key
  assert(/const todayISO = \(\) => now\(\)\.toISOString\(\)\.slice\(0, 10\);/.test(s.appjs), 'web todayISO changed');
  assert(/static String dateOf\(DateTime t\) =>\s*t\.toUtc\(\)\.toIso8601String\(\)\.substring\(0, 10\);/.test(b), 'Dart day key must be the UTC day');
  // record shape
  const put = /putLocal\('attendance', \{([\s\S]*?)\}\);/.exec(fn);
  assert(put, 'web putLocal(attendance) missing');
  // top-level `key: value` and shorthand `key` entries (values here contain no commas)
  const webKeys = put[1].split(',').map(t => /^\s*([a-z_]+)/.exec(t)).filter(Boolean).map(m => m[1]).filter(k => !['school_id', '_version'].includes(k)).sort();
  const data = /final data = <String, Object\?>\{([\s\S]*?)\};/.exec(b);
  assert(data, 'Dart record map missing');
  const dartKeys = [...data[1].matchAll(/'([a-z_]+)':/g)].map(m => m[1]).sort();
  assert(JSON.stringify(dartKeys) === JSON.stringify(webKeys), 'record fields Dart ' + dartKeys + ' ≠ web ' + webKeys);
  assert(/'source': 'teacher'/.test(b), "source must be 'teacher'");
  assert(/delete clean\.school_id;/.test(s.tenancy), 'Gateway no longer strips school_id — re-check record shape');
  // writers
  const pol = /attendance:\s*\{ write: \[([^\]]+)\]/.exec(s.policy);
  const w = pol[1].split(',').map(x => x.trim().replace(/'/g, '')).sort();
  const dw = /static const Set<String> writers = \{([^}]+)\};/.exec(b);
  assert(dw, 'Dart writers missing');
  assert(JSON.stringify(dw[1].split(',').map(x => x.trim().replace(/'/g, '')).sort()) === JSON.stringify(w), 'writers ≠ policy ' + w);
  return 'roster · default present · skip unchanged · UTC day · ' + dartKeys.length + ' fields · writers=' + w.join('/');
}

function nw2Ids(s) {
  const b = code(s.book);
  const num = (n) => { const m = new RegExp('static const int ' + n + ' = (\\d+);').exec(b); assert(m, n + ' missing'); return BigInt(m[1]); };
  const base = num('idBase'), maxS = num('maxStudentId'), maxD = num('maxDay');
  assert(/return idBase \+ day \* 10000000000 \+ studentId;/.test(b), 'record id formula changed');
  assert(maxS < 10000000000n, 'student id must fit the 10^10 slot');
  const top = base + maxD * 10000000000n + maxS;
  assert(top < 2n ** 53n, 'max id ' + top + ' ≥ 2^53 (unsafe for the JavaScript server)');
  assert(/if \(studentId < 1 \|\| studentId > maxStudentId\)/.test(b) && /if \(day < 0 \|\| day > maxDay\)/.test(b), 'out-of-range ids must be refused');
  assert(/r\.recordId \?\? recordId\(r\.studentId, date\)/.test(b), 'an existing record id must be reused');
  assert(/final base = r\.version \+ _queued\(id\);/.test(b), 'base_version must add the ops still queued for the record');
  return 'max id ' + top + ' < 2^53';
}

function nw2DataPath(s) {
  const w = code(s.wiring);
  for (const t of ['GatewayTransport(', 'GatewaySync(', 'AutoSync(', 'SqliteOutbox(engine.database)']) assert(w.includes(t), 'wiring lacks ' + t);
  assert(!/HttpClient\(\)|DirectTransport|SyncClient\(|\/api\/sync/.test(w), 'wiring must use only the injected pinned client and the Gateway');
  const iClaim = w.indexOf('DeviceOwner.claim('), iStart = w.indexOf('auto.start()');
  assert(iClaim > 0 && iStart > iClaim, 'DeviceOwner.claim must run before the sync engine starts');
  assert(/if \(claim == DeviceClaim\.blockedByQueue\) \{[\s\S]*?return;\s*\}/.test(w), 'blocked device must not start syncing');
  assert(/auto\.status\.listen\(session\.publishOutbox\)/.test(w), 'outbox state must reach the session badge');
  assert(/void publishOutbox\(SyncStatus s\) => sync\.value = s;/.test(s.session), 'session must expose publishOutbox');
  assert(/client: createPinnedHttpClient\(gw\)/.test(s.main) && /GatewayAttendanceSource\(/.test(s.main), 'main must wire attendance with the pinned client');
  assert(/gw == null \|\| !flags\.ships\(NativeWave\.attendance\)\s*\?\s*null/.test(s.main), 'no Gateway config ⇒ no data source (never guess)');
  const b = code(s.book);
  const iCap = b.indexOf('outbox.config.capacity'), iLoop = b.indexOf('for (final (r, status, id) in plan)');
  assert(iCap > 0 && iLoop > iCap, 'queue capacity must be checked before the first write (all or nothing)');
  const iNot = b.indexOf('AttendanceError.notInClass'), iEnq = b.indexOf('outbox.enqueue(');
  assert(iNot > 0 && iEnq > iNot, 'student/class check must precede enqueue');
  assert(/source\.queued\(\)/.test(s.ctrl), 'saving must nudge AutoSync');
  return 'Gateway only · claim → start · badge = outbox · all-or-nothing';
}

function nw2Flags(s) {
  assert(/'PAYESH_NATIVE_WAVES',\s*defaultValue: 'login,attendance'/.test(s.flags), 'default waves must ship attendance');
  assert(/enabled: src != null && s\.flags\.uses\(NativeWave\.attendance\)/.test(s.app), 'page must need the attendance wave');
  const entry = code(s.screen).slice(code(s.screen).indexOf('class AttendanceEntry'));
  assert(/if \(role == null \|\| !AttendanceBook\.writers\.contains\(role\)\)/.test(entry), 'entry must check the writer roles');
  assert(/if \(!enabled\) \{\s*return const Text\(\s*'ثبت حضور و غیاب فعلاً در نسخهٔ وب انجام می‌شود\.'/.test(entry), 'wave off ⇒ old (web) client message');
  assert(/if \(uid == null\)/.test(entry), 'unknown uid ⇒ no dead button');
  for (const k of ['ctrl', 'screen', 'wiring', 'app']) assert(!/webview|WebView|InAppWebView/.test(code(s[k])), k + ': no WebView');
  return 'default login,attendance · writers only · legacy message';
}

function nw2Owner(s) {
  const o = code(s.owner);
  assert(/outbox\.list\(\)\.isNotEmpty \|\|/.test(o) && /status = 'needs_review'/.test(o), 'unsent ops and open review items must both block');
  assert(/if \(unsent\) return DeviceClaim\.blockedByQueue;/.test(o), 'unsent ⇒ blockedByQueue');
  const iBlock = o.indexOf('if (unsent) return DeviceClaim.blockedByQueue;'), iClear = o.indexOf('await engine.clear();');
  assert(iClear > iBlock, 'wipe must come after the unsent check');
  assert(/DELETE FROM sync_review/.test(o) && /GatewaySync\.cursorKey/.test(o), 'switch must wipe review list and pull cursor');
  assert(/SchoolKeys\.uid,\s*\]\) \{\s*await store\.delete\(k\);/.test(s.access), 'sign-out must delete the saved uid');
  assert(/uid: int\.tryParse\(await store\.read\(SchoolKeys\.uid\) \?\? ''\)/.test(s.access), 'saved uid parsed strictly');
  return 'blocked on unsent/review · wipe on switch · uid cleared';
}

function nw2Tests(s) {
  const negU = uniq(s.unit, /'W2-U\d+ NEG/g);
  const negW = uniq(s.widget, /'W2-[WS]\d+ NEG/g);
  const unitN = uniq(s.unit, /'W2-U\d+ /g), widgetN = uniq(s.widget, /'W2-[WS]\d+ /g);
  assert(negU >= 10, 'unit negatives ' + negU + ' < 10');
  assert(negW >= 7, 'widget negatives ' + negW + ' < 7');
  const its = uniq(s.it, /'W2-IT-0\d /g);
  assert(its === 8, 'IT scenarios ' + its + ' ≠ 8');
  assert(/PAYESH_GW_IT/.test(s.it) && !/skip: true/.test(s.it), 'IT must be env-gated, not skipped');
  assert(/server\/gateway\.js/.test(s.it) && !/MockClient|FakeGateway/.test(s.it), 'IT must use the real Gateway');
  const step = s.ci.slice(s.ci.indexOf('- name: payesh_sync ⇄ server/gateway.js (pinned TLS)'));
  const blk = step.slice(0, step.indexOf('echo GATEWAY-REAL-OK'));
  assert(blk.includes('test/attendance_it_test.dart'), 'CI gateway-real does not run the wave-2 IT');
  assert(blk.includes("grep -qE 'NATIVE-WAVE2-IT passed=8 negative_controls=9'"), 'CI must assert the exact wave-2 IT tally');
  assert(/if grep -qE '~\[0-9\]\+'/.test(blk), 'CI must fail on skipped tests');
  return `unit=${unitN} (neg ${negU}) widget=${widgetN} (neg ${negW}) IT=${its}`;
}

function nw2Doc(s) {
  const d = s.doc;
  const order = ['ورود و انتخاب مدرسه', 'حضور', 'نمره', 'اطلاعیه', 'والدین'];
  let at = -1;
  for (const w of order) { const i = d.indexOf(w, at + 1); assert(i > at, 'wave order in doc: ' + w); at = i; }
  assert(/موج ۲[^\n]*\[S\]/.test(d), 'wave 2 must be marked [S]');
  assert(/NOT RUN \[M\]/.test(d), 'doc must state NOT RUN [M]');
  assert(!/PASS \[M\]/.test(d), 'no [M] claim without a real device');
  assert(/UNKNOWN/.test(d), 'security stays UNKNOWN until row 92');
  for (const k of ['PAYESH_NATIVE_WAVES', 'login,attendance', '/api/gw/v1/push', 'DeviceOwner', 'actAttendanceSave', 'NATIVE-WAVE2-IT passed=8 negative_controls=9']) assert(d.includes(k), 'doc lacks ' + k);
  return 'waves in order · wave 2 [S] · NOT RUN [M]';
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
  ['M1 Dart label drifts from the web', s => nw2Statuses(mut(s, 'book', "earlyExit('early_exit', 'خروج')", "earlyExit('early_exit', 'خروج زودهنگام')"))],
  ['M2 server gains a status the client lacks', s => nw2Statuses(mut(s, 'policy', "const ATT_STATUS = ['present', 'absent', 'late', 'early_exit', 'excused'];", "const ATT_STATUS = ['present', 'absent', 'late', 'early_exit', 'excused', 'sick'];"))],
  ['M3 unknown status mapped to present', s => nw2Statuses(mut(s, 'book', '    return null;\n  }\n}', '    return AttendanceStatus.present;\n  }\n}'))],
  ['M4 default becomes absent', s => nw2Semantics(mut(s, 'book', 'r.recorded ?? AttendanceStatus.present', 'r.recorded ?? AttendanceStatus.absent'))],
  ['M5 unchanged students rewritten', s => nw2Semantics(mut(s, 'book', 'if (r.recorded == status) {', 'if (false) {'))],
  ['M6 local-time day key', s => nw2Semantics(mut(s, 'book', 't.toUtc().toIso8601String().substring(0, 10)', 't.toIso8601String().substring(0, 10)'))],
  ['M7 record gains a field the web does not send', s => nw2Semantics(mut(s, 'book', "        'source': 'teacher',\n", "        'source': 'teacher',\n        'device': 'native',\n"))],
  ['M8 parents allowed to write', s => nw2Semantics(mut(s, 'book', "static const Set<String> writers = {'manager', 'teacher'};", "static const Set<String> writers = {'manager', 'teacher', 'parent'};"))],
  ['M9 id range beyond 2^53', s => nw2Ids(mut(s, 'book', 'static const int idBase = 4000000000000000;', 'static const int idBase = 9000000000000000;'))],
  ['M10 self-conflict: base ignores queued ops', s => nw2Ids(mut(s, 'book', 'final base = r.version + _queued(id);', 'final base = r.version;'))],
  ['M11 sync starts before the owner claim', s => nw2DataPath(mut(s, 'wiring', 'final claim = await DeviceOwner.claim(engine, outbox, owner);', 'auto.start();\n    final claim = await DeviceOwner.claim(engine, outbox, owner);'))],
  ['M12 badge not fed from the outbox', s => nw2DataPath(mut(s, 'wiring', '_sub = auto.status.listen(session.publishOutbox);', '_sub = null;'))],
  ['M13 unpinned client for attendance', s => nw2DataPath(mut(s, 'main', 'client: createPinnedHttpClient(gw),', 'client: HttpClient(),'))],
  ['M14 capacity checked after writing', s => nw2DataPath(mut(s, 'book', 'if (active + plan.length > outbox.config.capacity) {', 'if (false) {'))],
  ['M15 page ignores the wave flag', s => nw2Flags(mut(s, 'app', 'enabled: src != null && s.flags.uses(NativeWave.attendance),', 'enabled: src != null,'))],
  ['M16 default waves drop attendance', s => nw2Flags(mut(s, 'flags', "defaultValue: 'login,attendance'", "defaultValue: 'login'"))],
  ['M17 other user\'s queue wiped instead of blocking', s => nw2Owner(mut(s, 'owner', 'if (unsent) return DeviceClaim.blockedByQueue;', ''))],
  ['M18 sign-out keeps the uid', s => nw2Owner(mut(s, 'access', '      SchoolKeys.uid,\n    ]) {', '    ]) {'))],
  ['M19 wave-2 IT removed from CI', s => nw2Tests(mut(s, 'ci', ' test/attendance_it_test.dart | tee', ' | tee'))],
  ['M20 doc claims a real-device PASS', s => nw2Doc(mut(s, 'doc', 'NOT RUN [M]', 'PASS [M]'))],
];

async function main(opts) {
  const quiet = !!(opts && opts.quiet);
  const s = load();
  const out = []; let passed = 0; const failures = [];
  const run = (id, desc, fn) => { try { const d = fn(); passed++; out.push(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); } catch (e) { failures.push(id + ': ' + e.message); out.push(`FAIL  ${id}  ${desc}  → ${e.message}`); } };
  run('NW2-01', 'statuses = server ATT_STATUS, labels = web ATT_LABEL', () => nw2Statuses(s));
  run('NW2-02', 'save semantics = web actAttendanceSave', () => nw2Semantics(s));
  run('NW2-03', 'record id range and base_version', () => nw2Ids(s));
  run('NW2-04', 'Gateway-only data path, owner claim, outbox badge', () => nw2DataPath(s));
  run('NW2-05', 'wave flag and writer roles', () => nw2Flags(s));
  run('NW2-06', 'shared device: block on unsent, wipe on switch', () => nw2Owner(s));
  run('NW2-07', 'negatives, real IT in CI with exact tally', () => nw2Tests(s));
  run('NW2-08', 'row doc: wave order, wave 2 [S], NOT RUN [M]', () => nw2Doc(s));
  let killed = 0;
  run('NW2-09', 'mutants turn red', () => {
    for (const [name, fn] of MUTANTS) {
      let red = false;
      try { fn(s); } catch (e) { if (e instanceof AnchorError) throw e; red = true; }
      assert(red, 'mutant survived: ' + name); killed++;
    }
    return killed + '/' + MUTANTS.length + ' killed';
  });
  if (!quiet) out.forEach(l => console.log(l));
  const r = { passed, failed: failures.length, failures, negatives: killed };
  if (!quiet) console.log(`\nNATIVE-WAVE2-74 ${r.failed ? 'FAILED' : 'OK'} passed=${passed} failed=${r.failed} negative_controls=${killed}`);
  return r;
}
module.exports = { main };
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
