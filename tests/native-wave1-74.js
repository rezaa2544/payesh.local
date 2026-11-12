'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۷۴ موج ۱ — ورود و انتخاب مدرسه در کلاینت بومی: هم‌خوانی با قرارداد (برابری با کلاینت)

   NW-01  الگوها: SchoolAccessRules در Dart دقیقاً برابر SLUG_RE/CODE_RE/DEVICE_RE سرور
          (server/school-access.js) و الگوهای openapi.yaml برای activate/refresh
   NW-02  مسیرها و فیلدها: فقط سه endpoint موجود قرارداد (resolve/activate/refresh)، با همان
          متد، پارامتر school_code و فیلدهای الزامی openapi؛ فیلدهای پاسخ در openapi تعریف شده‌اند
   NW-03  خطاها: هر کد خطای سرورِ این سه مسیر به یک SchoolAccessError نگاشت می‌شود و هر نوع
          خطا پیام فارسی دارد (پیام خام انگلیسی به کاربر نمی‌رسد)
   NW-04  امنیت: توکن مدرسه هرگز در SecureStore نوشته نمی‌شود؛ درخواست‌های ورود Authorization
          ندارند؛ cell فقط https (http فقط loopback)؛ سیم‌کشی برنامه با کلاینت pinned
   NW-05  پرچم کلاینت قدیم/جدید: پیش‌فرض native، مقدار ناشناخته ⇒ legacy؛ موج بعدی بدون قبلی
          روشن نمی‌شود؛ کلاینت قدیم = وب در مرورگر (بدون WebView)
   NW-06  آزمون‌ها و وضعیت Sync: آزمون ویجت با کنترل‌های منفی، IT واقعی در CI (gateway-real)
          با شمارش دقیق، نشان Sync در صفحهٔ واردشده
   NW-07  سند ردیف: پنج موج به ترتیب، موج ۱ انجام‌شده [S]، NOT RUN [M] صریح
   NW-08  جهش‌ها: هر ویرایش ممنوع قرمز می‌شود
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const F = {
  dart: 'apps/payesh/packages/payesh_sync/lib/src/school_access.dart',
  ctrl: 'apps/payesh/app/lib/src/login/session_controller.dart',
  screens: 'apps/payesh/app/lib/src/login/login_screens.dart',
  wiring: 'apps/payesh/app/lib/src/login/wiring.dart',
  flags: 'apps/payesh/app/lib/src/flags.dart',
  badge: 'apps/payesh/app/lib/src/sync_badge.dart',
  app: 'apps/payesh/app/lib/src/app.dart',
  main: 'apps/payesh/app/lib/main.dart',
  server: 'server/school-access.js',
  dirApi: 'server/directory-api.js',
  gateway: 'server/gateway.js',
  openapi: 'openapi.yaml',
  widget: 'apps/payesh/app/test/login_wave1_test.dart',
  unit: 'apps/payesh/packages/payesh_sync/test/school_access_test.dart',
  it: 'apps/payesh/packages/payesh_sync/test/school_access_it_test.dart',
  ci: '.github/workflows/native-client.yml',
  doc: 'docs/cloud/74-native-wave1-login.md',
};
const ENDPOINTS = [
  ['GET', '/api/dir/v1/resolve'],
  ['POST', '/api/gw/v1/session/activate'],
  ['POST', '/api/gw/v1/session/refresh'],
];

function assert(c, m) { if (!c) throw new Error(m); }
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* Dart raw-string pattern: RegExp(r'…') after `static final RegExp <name> =` */
function dartPattern(src, name) {
  const m = new RegExp('static final RegExp ' + name + ' = RegExp\\(\\s*r\'([^\']+)\'').exec(src);
  assert(m, 'Dart pattern ' + name + ' missing');
  return m[1];
}
function jsPattern(src, name) {
  const m = new RegExp('const ' + name + ' = /(.+)/([a-z]*);').exec(src);
  assert(m, 'server pattern ' + name + ' missing');
  return { source: m[1], flags: m[2] };
}
/* the openapi block of one path (until the next top-level path key) */
function openapiPath(api, p) {
  const i = api.indexOf('\n  ' + p + ':\n');
  assert(i >= 0, 'openapi: ' + p + ' missing');
  const rest = api.slice(i + 1);
  const next = rest.slice(3).search(/\n {2}\/api\//);
  return next >= 0 ? rest.slice(0, next + 3) : rest;
}

function nwPatterns(s) {
  const pairs = [['school', 'SLUG_RE'], ['code', 'CODE_RE'], ['device', 'DEVICE_RE']];
  for (const [d, j] of pairs) {
    const dp = dartPattern(s.dart, d);
    const jp = jsPattern(s.server, j);
    assert(!jp.flags.includes('i'), j + ' unexpectedly case-insensitive');
    assert(dp === jp.source, `pattern drift ${d}: Dart ${dp} ≠ server ${jp.source}`);
  }
  for (const p of ['/api/gw/v1/session/activate', '/api/gw/v1/session/refresh']) {
    const blk = openapiPath(s.openapi, p);
    assert(blk.includes("school: { type: string, pattern: '" + dartPattern(s.dart, 'school') + "' }"), p + ': openapi school pattern ≠ Dart');
    assert(blk.includes("device_id: { type: string, pattern: '" + dartPattern(s.dart, 'device') + "' }"), p + ': openapi device_id pattern ≠ Dart');
  }
  return 'school/code/device identical in Dart, server and openapi';
}

function nwEndpoints(s) {
  const used = [...s.dart.matchAll(/resolve\('(\/api\/[^']+)'\)/g)].map(m => m[1]).sort();
  const want = ENDPOINTS.map(e => e[1]).sort();
  assert(JSON.stringify(used) === JSON.stringify(want), 'Dart endpoints ' + used.join(',') + ' ≠ ' + want.join(','));
  for (const [method, p] of ENDPOINTS) {
    const blk = openapiPath(s.openapi, p);
    assert(new RegExp('^ {4}' + method.toLowerCase() + ':', 'm').test(blk), `openapi: ${method} ${p} missing`);
    assert(s.dart.includes(`_send('${method}'`) || s.dart.includes(`'${method}',`), 'Dart never sends ' + method);
  }
  // resolve query parameter
  assert(/queryParameters: \{'school_code': code\}/.test(s.dart), 'Dart resolve must send school_code');
  assert(/- name: school_code\s+in: query\s+required: true/.test(openapiPath(s.openapi, '/api/dir/v1/resolve')), 'openapi school_code param');
  // request bodies: exactly the openapi required fields
  const bodies = {
    '/api/gw/v1/session/activate': ['school', 'code', 'device_id'],
    '/api/gw/v1/session/refresh': ['school', 'device_id', 'device_secret'],
  };
  for (const [p, fields] of Object.entries(bodies)) {
    const blk = openapiPath(s.openapi, p);
    const req = /required: \[([^\]]+)\]/.exec(blk);
    assert(req, p + ': openapi required list missing');
    const spec = req[1].split(',').map(x => x.trim()).sort();
    assert(JSON.stringify(spec) === JSON.stringify([...fields].sort()), p + ': openapi required ' + spec.join(','));
    const call = s.dart.slice(s.dart.indexOf("resolve('" + p + "')"));
    const body = call.slice(0, call.indexOf('}'));
    const sent = [...body.matchAll(/'([a-z_]+)':/g)].map(m => m[1]).sort();
    assert(JSON.stringify(sent) === JSON.stringify([...fields].sort()), p + ': Dart sends ' + sent.join(','));
  }
  // response fields read by Dart exist in openapi
  const resolveBlk = openapiPath(s.openapi, '/api/dir/v1/resolve');
  for (const f of ['school_code', 'cell_url', 'migration_state', 'ttl', 'stale', 'ok']) {
    assert(s.dart.includes(`j['${f}']`), 'Dart does not read ' + f);
    assert(new RegExp('\\n\\s+' + f + ':').test(resolveBlk), 'openapi resolve lacks ' + f);
  }
  const actBlk = openapiPath(s.openapi, '/api/gw/v1/session/activate');
  for (const f of ['token', 'expires_at', 'role', 'uid', 'tenant_id', 'device_secret']) {
    assert(s.dart.includes(`j['${f}']`), 'Dart does not read ' + f);
    assert(actBlk.includes(f + ':'), 'openapi activate lacks ' + f);
  }
  return ENDPOINTS.map(e => e.join(' ')).join(' · ');
}

function nwErrors(s) {
  // server error codes of these three paths
  const serverCodes = new Set();
  for (const src of [s.server, s.dirApi]) for (const m of src.matchAll(/(?:AccessError\('|error: ')([a-z_]+)'/g)) serverCodes.add(m[1]);
  for (const c of ['activation_failed', 'refresh_failed', 'not_found', 'rate_limited', 'not_configured', 'cell_unavailable']) {
    assert(serverCodes.has(c), 'server no longer emits ' + c + ' (update the client mapping)');
  }
  // status → kind mapping covers 401/404/426/429/5xx
  const map = s.dart.slice(s.dart.indexOf('final kind = switch ((status, wire))'));
  for (const st of ['(401, _)', '(404, _)', '(426, _)', '(429, _)', "(400, 'api_version_unsupported')", 'when s >= 500']) {
    assert(map.includes(st), 'error mapping lacks ' + st);
  }
  assert(/rejected: SchoolAccessError\.activationRejected/.test(s.dart), 'activate 401 must map to activationRejected');
  assert(/rejected: SchoolAccessError\.deviceRevoked/.test(s.dart), 'refresh 401 must map to deviceRevoked');
  // every enum value has exactly one Persian message
  const en = /enum SchoolAccessError \{([\s\S]*?);\n/.exec(s.dart);
  assert(en, 'enum SchoolAccessError missing');
  const kinds = [...en[1].matchAll(/^\s{2}([a-zA-Z]+),?$/gm)].map(m => m[1]);
  assert(kinds.length >= 10, 'too few error kinds: ' + kinds.length);
  const msg = s.dart.slice(s.dart.indexOf('String messageFa([Duration? retryAfter]) => switch (this) {'));
  const body = msg.slice(0, msg.indexOf('};'));
  for (const k of kinds) {
    const m = new RegExp('\\n\\s+' + k + ' =>\\s*\\n?\\s*\'([^\']+)\'').exec(body);
    assert(m, 'no message for ' + k);
    assert(/[\u0600-\u06FF]/.test(m[1]), 'message for ' + k + ' is not Persian');
  }
  // the controller shows only messageFa / Persian strings, never e.toString()/wire codes
  assert(!/\$e\b|e\.toString\(\)|\.wire\b/.test(s.ctrl), 'controller must not show raw error text');
  return kinds.length + ' kinds, each with a Persian message';
}

function nwSecurity(s) {
  for (const [n, src] of [['school_access', s.dart], ['controller', s.ctrl], ['screens', s.screens], ['wiring', s.wiring]]) {
    assert(!/write\(\s*SecureKeys\.sessionToken/.test(src), n + ': the school token must never be stored');
    assert(!/\.write\([^)]*\.token\b/.test(src), n + ': a token value is written to a store');
  }
  const send = s.dart.slice(s.dart.indexOf('Future<Map<String, Object?>> _send('));
  assert(send.length > 100, '_send missing');
  assert(!/authorizationHeader|'Authorization'/i.test(send.slice(0, send.indexOf('void close()'))), 'school access requests must not carry Authorization');
  const allowed = s.dart.slice(s.dart.indexOf('static bool isAllowedCellUrl(Uri u) {'));
  const fn = allowed.slice(0, allowed.indexOf('\n  }\n'));
  assert(/if \(u\.scheme == 'https'\) return true;/.test(fn), 'https must be the only remote scheme');
  assert(/u\.scheme == 'http' &&\s*\(u\.host == '127\.0\.0\.1' \|\| u\.host == 'localhost' \|\| u\.host == '::1'\)/.test(fn), 'http only for loopback');
  assert(/userInfo\.isNotEmpty/.test(fn), 'credentials in the cell URL must be refused');
  assert(/isAllowedCellUrl\(cell\)/.test(s.dart), 'resolve must check the cell URL');
  assert(/client: createPinnedHttpClient\(gw\)/.test(s.wiring), 'app wiring must use the pinned client');
  assert(/return const UnconfiguredSchoolAccess\(\);/.test(s.wiring), 'no config ⇒ UnconfiguredSchoolAccess (never guess a server)');
  assert(/api: schoolAccessFromEnvironment\(\)/.test(s.main), 'main must use the wiring');
  return 'token in memory only; no Authorization; https cells; pinned client';
}

function nwFlags(s) {
  assert(/'PAYESH_CLIENT',\s*defaultValue: 'native'/.test(s.flags), 'PAYESH_CLIENT default must be native');
  assert(/'native' => ClientChoice\.native,\s*_ => ClientChoice\.legacy,/.test(s.flags), 'unknown client value must fall back to legacy');
  assert(/if \(!named\.contains\(w\.name\)\) break;/.test(s.flags), 'a wave must need every earlier wave');
  assert(/enum NativeWave \{ login, attendance, grades, notices, parents \}/.test(s.flags), 'wave order changed');
  assert(/if \(!_active\.uses\(NativeWave\.login\)\) return _set\(const LegacyClient\(\)\);/.test(s.ctrl), 'controller must honour the flag');
  assert(/'native' when ships\(NativeWave\.login\) => ClientChoice\.native/.test(s.flags), 'device switch to native only when shipped');
  for (const [n, src] of Object.entries(s)) {
    if (n.startsWith('app') || ['ctrl', 'screens', 'flags', 'badge', 'main', 'wiring'].includes(n)) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert(!/webview|WebView|webview_flutter|InAppWebView/.test(code), n + ': no WebView (native gate, row 63)');
    }
  }
  assert(/LegacyClient\(\) => LegacyClientScreen/.test(s.screens), 'legacy screen missing');
  return 'default native · unknown ⇒ legacy · ordered waves · no WebView';
}

function nwTests(s) {
  const negW = (s.widget.match(/NEGATIVE:/g) || []).length;
  const negU = (s.unit.match(/NEGATIVE:/g) || []).length;
  assert(negW >= 10, 'widget negatives ' + negW + ' < 10');
  assert(negU >= 10, 'unit negatives ' + negU + ' < 10');
  const its = new Set(s.it.match(/'W1-IT-0\d /g) || []).size;
  assert(its === 7, 'IT scenarios ' + its + ' ≠ 7');
  assert(/PAYESH_GW_IT/.test(s.it) && !/skip: true/.test(s.it), 'IT must be env-gated, not skipped');
  const step = s.ci.slice(s.ci.indexOf('- name: payesh_sync ⇄ server/gateway.js (pinned TLS)'));
  const blk = step.slice(0, step.indexOf('echo GATEWAY-REAL-OK'));
  assert(blk.includes('test/school_access_it_test.dart'), 'CI gateway-real does not run the wave-1 IT');
  assert(blk.includes("grep -qE 'NATIVE-WAVE1-IT passed=7 negative_controls=11'"), 'CI must assert the exact IT tally');
  assert(/if grep -qE '~\[0-9\]\+'/.test(blk), 'CI must fail on skipped tests');
  assert(/SyncBadge\(\s*status: controller\.sync,/.test(s.screens), 'signed-in screen must show the sync badge');
  assert(/label: 'وضعیت همگام‌سازی: \$\{s\.labelFa\}'/.test(s.badge), 'badge needs a Persian semantics label');
  for (const p of ['idle', 'syncing', 'queued', 'offline', 'attention']) assert(new RegExp('SyncPhase\\.' + p + ' =>').test(s.badge), 'badge lacks ' + p);
  return `widget negatives=${negW} unit negatives=${negU} IT=${its} (CI gateway-real)`;
}

function nwDoc(s) {
  const d = s.doc;
  const order = ['ورود و انتخاب مدرسه', 'حضور', 'نمره', 'اطلاعیه', 'والدین'];
  let at = -1;
  for (const w of order) { const i = d.indexOf(w, at + 1); assert(i > at, 'wave order in doc: ' + w); at = i; }
  assert(/موج ۱[^\n]*\[S\]/.test(d), 'wave 1 must be marked [S]');
  assert(/NOT RUN \[M\]/.test(d), 'doc must state NOT RUN [M]');
  assert(!/PASS \[M\]/.test(d), 'no [M] claim without a real device');
  for (const k of ['PAYESH_CLIENT', 'PAYESH_NATIVE_WAVES', '/api/dir/v1/resolve', '/api/gw/v1/session/activate', '/api/gw/v1/session/refresh']) assert(d.includes(k), 'doc lacks ' + k);
  return 'waves in order · wave 1 [S] · NOT RUN [M]';
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
  ['M1 Dart school pattern drifts', s => nwPatterns(mut(s, 'dart', "r'^[a-z0-9][a-z0-9-]{2,39}$'", "r'^[a-z0-9][a-z0-9_-]{1,39}$'"))],
  ['M2 server code pattern drifts', s => nwPatterns(mut(s, 'server', 'const CODE_RE = /^[A-Z2-7]{32}$/;', 'const CODE_RE = /^[A-Z2-7]{26}$/;'))],
  ['M3 Dart calls an endpoint not in the contract', s => nwEndpoints(mut(s, 'dart', "resolve('/api/gw/v1/session/refresh')", "resolve('/api/gw/v1/session/renew')"))],
  ['M4 Dart sends deviceId instead of device_id', s => nwEndpoints(mut(s, 'dart', "'device_id': deviceId,\n    }, rejected: SchoolAccessError.activationRejected", "'deviceId': deviceId,\n    }, rejected: SchoolAccessError.activationRejected"))],
  ['M5 error kind with an English message', s => nwErrors(mut(s, 'dart', "offline => 'اتصال اینترنت برقرار نیست — اتصال را بررسی کنید'", "offline => 'network error'"))],
  ['M6 token written to the secure store', s => nwSecurity(mut(s, 'ctrl', '      await accounts.save(saved);\n      _saved = saved;', '      await accounts.save(saved);\n      await accounts.store.write(SecureKeys.sessionToken, a.session.token);\n      _saved = saved;'))],
  ['M7 Authorization header on school access', s => nwSecurity(mut(s, 'dart', '        ..set(PayeshApi.versionHeader, clientVersion)', "        ..set(HttpHeaders.authorizationHeader, 'Bearer x')\n        ..set(PayeshApi.versionHeader, clientVersion)"))],
  ['M8 plaintext http cell allowed', s => nwSecurity(mut(s, 'dart', "if (u.scheme == 'https') return true;", "if (u.scheme == 'https' || u.scheme == 'http') return true;"))],
  ['M9 unknown client value falls to native', s => nwFlags(mut(s, 'flags', "'native' => ClientChoice.native,\n      _ => ClientChoice.legacy,", "'legacy' => ClientChoice.legacy,\n      _ => ClientChoice.native,"))],
  ['M10 wave-1 IT removed from CI', s => nwTests(mut(s, 'ci', ' test/school_access_it_test.dart', ''))],
  ['M11 sync badge removed from the signed-in screen', s => nwTests(mut(s, 'screens', 'SyncBadge(\n                status: controller.sync,', 'StatusBadge(\n                controller.sync.value.labelFa,'))],
  ['M12 unpinned client in the app wiring', s => nwSecurity(mut(s, 'wiring', 'client: createPinnedHttpClient(gw)', 'client: HttpClient()'))],
  ['M13 doc claims a real-device PASS', s => nwDoc(mut(s, 'doc', 'NOT RUN [M]', 'PASS [M]'))],
];

async function main(opts) {
  const quiet = !!(opts && opts.quiet);
  const s = load();
  const out = []; let passed = 0; const failures = [];
  const run = (id, desc, fn) => { try { const d = fn(); passed++; out.push(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); } catch (e) { failures.push(id + ': ' + e.message); out.push(`FAIL  ${id}  ${desc}  → ${e.message}`); } };
  run('NW-01', 'patterns identical in Dart, server and openapi', () => nwPatterns(s));
  run('NW-02', 'endpoints, methods and fields from the contract', () => nwEndpoints(s));
  run('NW-03', 'every server error → one kind with a Persian message', () => nwErrors(s));
  run('NW-04', 'token never stored; no Authorization; https cells; pinned', () => nwSecurity(s));
  run('NW-05', 'old/new client flag fail-safe; no WebView', () => nwFlags(s));
  run('NW-06', 'widget/unit negatives, real IT in CI, visible sync badge', () => nwTests(s));
  run('NW-07', 'row doc: wave order, wave 1 [S], NOT RUN [M]', () => nwDoc(s));
  let killed = 0;
  run('NW-08', 'mutants turn red', () => {
    for (const [name, fn] of MUTANTS) {
      let red = false;
      try { fn(s); } catch (e) { if (e instanceof AnchorError) throw e; red = true; }
      assert(red, 'mutant survived: ' + name); killed++;
    }
    return killed + '/' + MUTANTS.length + ' killed';
  });
  if (!quiet) out.forEach(l => console.log(l));
  const r = { passed, failed: failures.length, failures, negatives: killed };
  if (!quiet) console.log(`\nNATIVE-WAVE1-74 ${r.failed ? 'FAILED' : 'OK'} passed=${passed} failed=${r.failed} negative_controls=${killed}`);
  return r;
}
module.exports = { main };
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
