'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۹۴ — سند طراحی نصب و آنبوردینگ: هم‌خوانی سند با کد مخزن

   OB-01  ساختار: نمودار جریان (mermaid + متن)، گام‌ها، حالت بدون اینترنت، سه مورد خطای
          اجباری (کد اشتباه، قطع اینترنت، مدرسهٔ مهاجرت‌شده)، وابستگی O‑21، NOT RUN [M]،
          Security UNKNOWN، بدون ادعای PASS [M]
   OB-02  پیام‌ها: هر پیام خطای نقل‌شده در سند عیناً همان messageFa کلاینت بومی است
          (و اطلاعیهٔ انتقال همان migrationNotice)
   OB-03  قرارداد: مسیرها، وضعیت‌های انتقال، TTLها و کدهای خطای سند همان کد سرور است
   OB-04  فاصله‌ها: G1/G2/G4/G5 هنوز در کد وجود دارند — اگر رفع شوند، سند باید به‌روز شود
   OB-05  تصمیم نقش: نقش از ردیف users خوانده می‌شود، صدور کد فقط با مدیر، کلاینت انتخاب نقش ندارد
   OB-06  جهش‌ها: هر ویرایش ممنوع قرمز می‌شود
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const F = {
  doc: 'docs/cloud/94-onboarding-design.md',
  access: 'apps/payesh/packages/payesh_sync/lib/src/school_access.dart',
  session: 'apps/payesh/app/lib/src/login/session_controller.dart',
  outbox: 'apps/payesh/packages/payesh_sync/lib/src/outbox.dart',
  dirapi: 'server/directory-api.js',
  directory: 'server/directory.js',
  school: 'server/school-access.js',
  transfer: 'server/transfer.js',
  gateway: 'server/gateway.js',
  constitution: 'docs/00-PAYESH-CLOUD-CONSTITUTION.md',
  webapp: 'client/app.js',
  webpages: 'client/pages.js',
  ownerweb: 'apps/owner-panel/web/app.js',
};

function assert(c, m) { if (!c) throw new Error(m); }
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const section = (d, title) => {
  const i = d.indexOf(title);
  assert(i >= 0, 'doc section missing: ' + title);
  const rest = d.slice(i + title.length);
  const j = rest.search(title.startsWith('### ') ? /\n#{2,3} / : /\n## /);
  return j < 0 ? rest : rest.slice(0, j);
};
/* Dart messageFa table: name => message (multi-line entries joined) */
function dartMessages(src) {
  const b = code(src);
  const i = b.indexOf('String messageFa([Duration? retryAfter]) => switch (this) {');
  assert(i >= 0, 'messageFa missing');
  const body = b.slice(i, b.indexOf('};', i));
  const out = {};
  for (const m of body.matchAll(/^\s+([a-zA-Z]+) =>\s*'([^']*)'/gm)) out[m[1]] = m[2];
  return out;
}

function obShape(s) {
  const d = s.doc;
  for (const t of ['## ۳. نمودار جریان', '## ۵. حالت اولیه بدون اینترنت', '## ۶. موارد خطا', '### ۶.۱ کد اشتباه', '### ۶.۲ قطع اینترنت', '### ۶.۳ مدرسهٔ مهاجرت‌شده', '## ۸. وابستگی به O‑21', 'NOT RUN [M]']) assert(d.includes(t), 'doc lacks ' + t);
  const flow = section(d, '## ۳. نمودار جریان');
  assert(/```mermaid\nflowchart TD[\s\S]+?```/.test(flow), 'flow diagram must be a mermaid flowchart');
  assert((flow.match(/```/g) || []).length >= 4, 'flow diagram needs a plain-text fallback too');
  for (const k of ['not_found', 'activation_failed', 'refresh_failed', 'write_frozen', 'migrating', 'moved']) assert(flow.includes(k), 'flow diagram lacks the branch ' + k);
  assert(!/PASS \[M\]/.test(d), 'no [M] claim without a real device');
  assert(/UNKNOWN/.test(d), 'security stays UNKNOWN until row 92');
  assert(/پیاده‌سازی این سند در این ردیف نیست/.test(d), 'doc must say it is design only (implementation after O‑21)');
  return 'flow (mermaid + text) · 3 error cases · offline · O‑21 · NOT RUN [M]';
}

function obMessages(s) {
  const d = s.doc, msgs = dartMessages(s.access);
  const need = ['badSchoolCode', 'schoolNotFound', 'badActivationCode', 'activationRejected', 'offline', 'unavailable', 'tlsRejected', 'insecureCell', 'upgradeRequired'];
  for (const k of need) {
    assert(msgs[k], 'Dart message missing: ' + k);
    assert(d.includes('«' + msgs[k] + '»'), 'doc does not quote the exact client message for ' + k + ': ' + msgs[k]);
  }
  const rl = /rateLimited =>\s*'تلاش‌ها زیاد بود — \$\{_seconds\(retryAfter\)\} ثانیهٔ دیگر دوباره امتحان کنید'/.test(code(s.access));
  assert(rl && d.includes('«تلاش‌ها زیاد بود — N ثانیهٔ دیگر دوباره امتحان کنید»'), '429 message drifted');
  const mn = /\? '([^']+)'\s*: null;/.exec(code(s.session));
  assert(mn && d.includes('«' + mn[1] + '»'), 'doc must quote the migration notice of the client');
  /* the «پیام» column of tables 6.1 and 6.2 may only hold real client messages (no paraphrase) */
  const known = new Set([...Object.values(msgs), mn[1], 'تلاش‌ها زیاد بود — N ثانیهٔ دیگر دوباره امتحان کنید']);
  let cells = 0;
  for (const [title, col] of [['### ۶.۱ کد اشتباه', 2], ['### ۶.۲ قطع اینترنت', 1]]) {
    const rows = section(d, title).split('\n').filter(l => /^\| /.test(l) && !/^\|---/.test(l)).slice(1);
    assert(rows.length >= 4, title + ': too few rows');
    for (const r of rows) {
      const c = r.split(' | ').map(x => x.replace(/^\|\s*/, '').replace(/\s*\|$/, '').trim())[col];
      const q = /^«([^»]+)»$/.exec(c || '');
      assert(q && known.has(q[1]), title + ': message cell is not a client message: ' + c);
      cells++;
    }
  }
  return need.length + ' client messages quoted verbatim · migration notice · ' + cells + ' message cells checked';
}

function obContract(s) {
  const d = s.doc, api = code(s.dirapi), gw = code(s.gateway);
  assert(/GET \/api\/dir\/v1\/resolve\?school_code=/.test(s.dirapi) && d.includes('GET /api/dir/v1/resolve?school_code='), 'resolve path drifted');
  assert(/'\/api\/gw\/v1\/session\/activate'/.test(gw) && d.includes('POST /api/gw/v1/session/activate'), 'activate path drifted');
  assert(/'\/api\/gw\/v1\/admin\/activation-codes'/.test(gw) && d.includes('POST /api/gw/v1/admin/activation-codes'), 'activation-code path drifted');
  const st = /CHECK \(migration_state IN \(([^)]+)\)\)/.exec(s.directory);
  assert(st, 'migration_state constraint missing');
  const states = st[1].split(',').map(x => x.trim().replace(/'/g, ''));
  assert(JSON.stringify(states) === JSON.stringify(['stable', 'migrating', 'moved']), 'migration states changed: ' + states);
  for (const x of states) assert(d.includes('`' + x + '`'), 'doc lacks migration state ' + x);
  const ttl = (k) => Number((new RegExp(k + ": Number\\(process\\.env\\.[A-Z_]+ \\|\\| (\\d+)\\)").exec(api) || [])[1]);
  assert(ttl('migratingTtlSec') === 15 && ttl('movedTtlSec') === 30 && ttl('clientTtlSec') === 300, 'Directory TTL defaults changed');
  const mig = section(d, '### ۶.۳ مدرسهٔ مهاجرت‌شده');
  assert(/۱۵ ثانیه/.test(mig) && /۳۰ ثانیه/.test(mig) && /پنج دقیقه/.test(mig), 'doc TTLs ≠ server defaults (15 s / 30 s / 5 min)');
  assert(/404, \{ ok: false, error: 'not_found' \}|NOT_FOUND = \{ ok: false, error: 'not_found' \}/.test(api), 'Directory 404 body changed');
  assert(/error: 'write_frozen'/.test(gw) && /return m == 'write_frozen' \|\| m == 'draining';/.test(code(s.outbox)), 'write_frozen must stay transient in the outbox (doc §6.3)');
  assert(d.includes('`isTransient`'), 'doc must name isTransient');
  return 'paths · states ' + states.join('/') + ' · TTL 15/30/300 · write_frozen transient';
}

function obGaps(s) {
  const sess = code(s.session), tr = code(s.transfer);
  // G1: refresh only talks to the saved cell; no Directory call outside submitSchool
  const resolves = [...sess.matchAll(/api\.resolve\(/g)].length;
  assert(resolves === 1 && /cell: saved\.cellUrl,/.test(sess), 'G1 fixed? the session now re-resolves the Directory — update doc §6.3/§7');
  // G2: transfer copies product tables only
  const allowed = /const ALLOWED_TABLES = new Set\(\[([\s\S]*?)\]\);/.exec(tr);
  assert(allowed && !/gw_credential|gw_school|CRED_TABLE/.test(allowed[1]), 'G2 fixed? transfer now moves credentials — update doc §6.3/§7');
  // G4: no UI calls the activation-code endpoint
  for (const k of ['webapp', 'webpages']) assert(!/activation-codes/.test(s[k]), 'G4 fixed? ' + F[k] + ' calls activation-codes — update doc §7');
  assert(!/activation-codes/.test(s.ownerweb), 'G4: owner panel calls the school endpoint? update doc');
  // G5: refresh_failed wipes before any Directory lookup
  const rf = sess.slice(sess.indexOf('Future<void> refresh() async {'));
  const body = rf.slice(0, rf.indexOf('Future<String?> validToken()'));
  assert(/if \(e\.kind == SchoolAccessError\.deviceRevoked\) \{\s*await accounts\.clear\(\);/.test(body) && !/resolve\(/.test(body), 'G5 fixed? refresh re-resolves before clearing — update doc §7');
  const d = s.doc;
  for (const g of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) assert(new RegExp('\\| ' + g + ' \\|').test(section(d, '## ۷. فاصله‌های کشف‌شده')), 'gap table lacks ' + g);
  return 'G1 G2 G4 G5 still present in code · gap table complete';
}

function obRoles(s) {
  const sc = code(s.school);
  assert(/async function readUser\(c, uid\)/.test(sc) && /return \{ uid, role \};/.test(sc), 'role must come from the users row');
  assert(/if \(!claims \|\| claims\.role !== 'manager'\) throw new AccessError\('manager_only', 403\);/.test(sc), 'only managers issue activation codes');
  assert(!/role:\s*(typed|selected|picked)/i.test(code(s.session)) && !/chooseRole|selectRole|RolePicker/.test(code(s.session)), 'client must not pick a role');
  const d = section(s.doc, '## ۲. نقش‌ها و منبع کد');
  assert(/هیچ صفحهٔ «انتخاب نقش» ندارد/.test(d) && d.includes('`readUser`') && d.includes('`issueActivation`'), 'role decision must be stated with its code anchors');
  return 'role from users row · manager-only codes · no role picker';
}

function load() {
  const s = {};
  for (const [k, rel] of Object.entries(F)) s[k] = read(rel);
  return s;
}
class AnchorError extends Error {}
const mut = (s, k, from, to) => { if (!s[k].includes(from)) throw new AnchorError('mutant anchor missing in ' + k + ': ' + from.slice(0, 50)); return Object.assign({}, s, { [k]: s[k].replace(from, to) }); };
const MUTANTS = [
  ['M1 doc drops the migrated-school case', s => obShape(mut(s, 'doc', '### ۶.۳ مدرسهٔ مهاجرت‌شده', '### ۶.۳ موارد دیگر'))],
  ['M2 flow diagram loses the refresh_failed branch', s => obShape(mut(s, 'doc', 'Q -- 401 refresh_failed / write_frozen', 'Q -- خطا'))],
  ['M3 doc claims a real-device PASS', s => obShape(mut(s, 'doc', '## ۱۰. اجرا نشده — NOT RUN [M]', '## ۱۰. PASS [M]'))],
  ['M4 client message drifts from the doc', s => obMessages(mut(s, 'access', "'مدرسه‌ای با این کد پیدا نشد — کد را از مدیر مدرسه بپرسید'", "'مدرسه پیدا نشد'"))],
  ['M5 doc paraphrases a client message', s => obMessages(mut(s, 'doc', '«کد فعال‌سازی پذیرفته نشد — ممکن است اشتباه، استفاده‌شده یا منقضی باشد»', '«کد اشتباه است»'))],
  ['M6 Directory gains a migration state', s => obContract(mut(s, 'directory', "CHECK (migration_state IN ('stable','migrating','moved'))", "CHECK (migration_state IN ('stable','migrating','moved','frozen'))"))],
  ['M7 moved TTL changes', s => obContract(mut(s, 'dirapi', 'PAYESH_DIR_MOVED_TTL_SEC || 30', 'PAYESH_DIR_MOVED_TTL_SEC || 120'))],
  ['M8 write_frozen no longer transient (queued work at risk)', s => obContract(mut(s, 'outbox', "return m == 'write_frozen' || m == 'draining';", "return m == 'draining';"))],
  ['M9 G1 fixed silently (refresh re-resolves)', s => obGaps(mut(s, 'session', '      final fresh = await api.refresh(', '      await api.resolve(saved.school);\n      final fresh = await api.refresh('))],
  ['M10 G2 fixed silently (transfer moves credentials)', s => obGaps(mut(s, 'transfer', "'product_records', 'product_change_feed', 'product_ops', 'gateway_quota',", "'product_records', 'product_change_feed', 'product_ops', 'gateway_quota', 'gw_credential',"))],
  ['M11 G4 fixed silently (web issues codes)', s => obGaps(mut(s, 'webpages', 'function actLeaveAdd() {', "function actIssueCode(id) { return api('POST', '/api/gw/v1/admin/activation-codes', { uid: id }); }\nfunction actLeaveAdd() {"))],
  ['M12 gap table loses G6', s => obGaps(mut(s, 'doc', '| G6 |', '| G7 |'))],
  ['M13 non-managers may issue codes', s => obRoles(mut(s, 'school', "if (!claims || claims.role !== 'manager') throw new AccessError('manager_only', 403);", "if (!claims) throw new AccessError('manager_only', 403);"))],
  ['M14 doc promises a role picker', s => obRoles(mut(s, 'doc', 'هیچ صفحهٔ «انتخاب نقش» ندارد', 'صفحهٔ «انتخاب نقش» دارد'))],
];

async function main(opts) {
  const quiet = !!(opts && opts.quiet);
  const s = load();
  const out = []; let passed = 0; const failures = [];
  const run = (id, desc, fn) => { try { const d = fn(); passed++; out.push(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); } catch (e) { failures.push(id + ': ' + e.message); out.push(`FAIL  ${id}  ${desc}  → ${e.message}`); } };
  run('OB-01', 'doc shape: flow diagram, 3 error cases, offline, O‑21, NOT RUN [M]', () => obShape(s));
  run('OB-02', 'quoted messages = client messageFa', () => obMessages(s));
  run('OB-03', 'contract: paths, migration states, TTLs, write_frozen', () => obContract(s));
  run('OB-04', 'discovered gaps still match the code', () => obGaps(s));
  run('OB-05', 'role decision: from users row, manager-only codes', () => obRoles(s));
  let killed = 0;
  run('OB-06', 'mutants turn red', () => {
    for (const [name, fn] of MUTANTS) {
      let red = false;
      try { fn(s); } catch (e) { if (e instanceof AnchorError) throw e; red = true; }
      assert(red, 'mutant survived: ' + name); killed++;
    }
    return killed + '/' + MUTANTS.length + ' killed';
  });
  if (!quiet) out.forEach(l => console.log(l));
  const r = { passed, failed: failures.length, failures, negatives: killed };
  if (!quiet) console.log(`\nONBOARDING-94 ${r.failed ? 'FAILED' : 'OK'} passed=${passed} failed=${r.failed} negative_controls=${killed}`);
  return r;
}
module.exports = { main };
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
