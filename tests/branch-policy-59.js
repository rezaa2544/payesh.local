'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون سیاست شاخهٔ قفل‌شده (D-38) — ردیف ۵۹   (BP-01 .. BP-11)

   هر قاعده با یک مخزن git واقعیِ موقت سنجیده می‌شود (بدون شبکه):
     B1 کار روی main ممنوع · B2 عقب‌بودن از origin/main ·
     B3 بازنویسی تاریخ (force-push) · B4 کامیت مستقیم روی main ·
     B5 یک PR برای هر ردیف (منطق فهرست PR).

   اجرا: npm run test:branch59
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'branch-policy-59.mjs');
const mod = require(TOOL);

let passed = 0, failed = 0; const failures = [];
function check(id, desc, fn) {
  try { const d = fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 260)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

const NB = '\u2011';

/* مخزن موقت با یک origin مصنوعی: main + شاخهٔ کار */
function makeRepo({ mainCommits = 2, branch = 'arena/test-59' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-bp59-'));
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env });
  fs.mkdirSync(origin, { recursive: true });
  g(['init', '--bare', '-b', 'main', origin], base);
  g(['init', '-b', 'main', work], base);
  g(['remote', 'add', 'origin', origin], work);
  for (let i = 0; i < mainCommits; i++) {
    fs.writeFileSync(path.join(work, 'f.txt'), 'line ' + i + '\n');
    g(['add', '.'], work); g(['commit', '-m', 'main ' + i], work);
  }
  g(['push', '-q', 'origin', 'main'], work);
  g(['checkout', '-q', '-b', branch], work);
  fs.writeFileSync(path.join(work, 'w.txt'), 'work\n');
  g(['add', '.'], work); g(['commit', '-m', 'row work'], work);
  g(['push', '-q', 'origin', branch], work);
  return { base, origin, work, branch, g, env };
}

check('BP-01', 'مخزن واقعی سالم است (شاخهٔ غیر main، همگام با origin/main)', () => {
  const r = mod.evaluate({ cwd: ROOT });
  assert(r.branch !== 'main', 'روی main هستیم');
  assert(r.ok, 'نقض: ' + JSON.stringify(r.problems).slice(0, 200));
  return `branch=${r.branch} B4=${r.checks.B4.ok}`;
});

check('BP-02', 'B1: کار روی main ⇒ قرمز', () => {
  const repo = makeRepo();
  repo.g(['checkout', '-q', 'main'], repo.work);
  const r = mod.evaluate({ cwd: repo.work });
  assert(r.ok === false, 'باید قرمز شود');
  assert(r.problems.some(p => p.rule === 'B1'), JSON.stringify(r.problems));
  return 'B1 red';
});

check('BP-03', 'B2: شاخهٔ عقب‌مانده از origin/main ⇒ قرمز با تعداد کامیت', () => {
  const repo = makeRepo();
  /* روی main یک کامیت تازه می‌گذاریم و push می‌کنیم؛ شاخه کار عقب می‌ماند */
  repo.g(['checkout', '-q', 'main'], repo.work);
  fs.writeFileSync(path.join(repo.work, 'new.txt'), 'x\n');
  repo.g(['add', '.'], repo.work); repo.g(['commit', '-m', 'main ahead'], repo.work);
  repo.g(['push', '-q', 'origin', 'main'], repo.work);
  repo.g(['checkout', '-q', repo.branch], repo.work);
  repo.g(['fetch', '-q', 'origin'], repo.work);
  const r = mod.evaluate({ cwd: repo.work });
  assert(r.ok === false, 'باید قرمز شود');
  const b2 = r.problems.find(p => p.rule === 'B2');
  assert(b2, JSON.stringify(r.problems));
  assert(/1/.test(b2.why), 'تعداد عقب‌ماندگی نیامده: ' + b2.why);
  return b2.why;
});

check('BP-04', 'B3: بازنویسی تاریخ شاخه (force-push) ⇒ قرمز', () => {
  const repo = makeRepo();
  repo.g(['reset', '-q', '--hard', 'HEAD~1'], repo.work);   /* تاریخ بازنویسی */
  const r = mod.evaluate({ cwd: repo.work });
  assert(r.ok === false, 'باید قرمز شود');
  assert(r.problems.some(p => p.rule === 'B3'), JSON.stringify(r.problems));
  return 'B3 red';
});

check('BP-05', 'B4: کامیت مستقیم (غیر merge) روی main ⇒ قرمز', () => {
  const repo = makeRepo();
  repo.g(['checkout', '-q', 'main'], repo.work);
  fs.writeFileSync(path.join(repo.work, 'direct.txt'), 'x\n');
  repo.g(['add', '.'], repo.work); repo.g(['commit', '-m', 'feat: direct on main'], repo.work);
  repo.g(['push', '-q', 'origin', 'main'], repo.work);
  repo.g(['checkout', '-q', repo.branch], repo.work);
  repo.g(['fetch', '-q', 'origin'], repo.work);
  const r = mod.evaluate({ cwd: repo.work });
  const b4 = r.problems.filter(p => p.rule === 'B4');
  assert(b4.length > 0, JSON.stringify(r.problems));
  return 'B4 red: ' + b4.length;
});

check('BP-06', 'B4: merge و کامیت خودکار انتشار روی main مجازند', () => {
  const repo = makeRepo();
  /* ادغام واقعی --no-ff روی main */
  repo.g(['checkout', '-q', 'main'], repo.work);
  repo.g(['merge', '-q', '--no-ff', '-m', 'Merge branch ' + repo.branch, repo.branch], repo.work);
  fs.writeFileSync(path.join(repo.work, 'm.txt'), 'x\n');
  repo.g(['add', '.'], repo.work);
  repo.g(['commit', '-q', '-m', 'chore(release): مانیفست 0.8.63 [skip ci]'], repo.work);
  const commits = repo.g(['rev-list', '-n', '10', 'main'], repo.work).split('\n').filter(Boolean);
  const r = mod.mainIntegrity(commits, repo.work);
  assert(r.ok === true, 'merge/انتشار نباید قرمز شوند: ' + JSON.stringify(r.bad));
  return `commits=${commits.length} all merge/bot`;
});

check('BP-07', 'B5: هر ردیف دقیقاً یک PR (بدون PR و دو PR ⇒ قرمز)', () => {
  const list = [
    { number: 1, title: 'ردیف ۴۵ — بودجهٔ اتصال' },
    { number: 2, title: 'ردیف ۵۲ — سیاست خواندن' },
    { number: 3, title: 'ردیف ۵۲ — اصلاح سیاست' },
  ];
  const r = mod.auditPrsPerRow(list, ['45', '52', '54']);
  assert(r.ok === false, 'باید نقض پیدا شود');
  assert(r.problems.find(p => p.row === '52' && p.prs.length === 2), 'دو PR برای ۵۲ گرفته نشد');
  assert(r.problems.find(p => p.row === '54' && p.why === 'بدون PR'), 'ردیف بی‌PR گرفته نشد');
  const ok = mod.auditPrsPerRow(list, ['45']);
  assert(ok.ok === true, 'ردیف تک‌PR نباید قرمز شود');
  return 'duplicate/missing detected';
});

check('BP-08', 'مرز ردیف: «۴۵» با «۴۵۰» یا «۱۴۵» قاطی نمی‌شود', () => {
  const list = [{ number: 9, title: 'ردیف ۴۵۰ — چیز دیگر' }, { number: 10, title: 'ردیف ۱۴۵' }];
  const r = mod.auditPrsPerRow(list, ['45']);
  assert(r.ok === false && r.problems[0].why === 'بدون PR', JSON.stringify(r.problems));
  return 'boundary ok';
});

check('BP-09', 'CLI: کد خروج و خروجی JSON', () => {
  const good = spawnSync(process.execPath, [TOOL, '--json'], { encoding: 'utf8', cwd: ROOT });
  assert(good.status === 0, 'exit=' + good.status);
  const j = JSON.parse(good.stdout);
  assert(j.branch && j.checks && j.checks.B4, 'ساختار JSON ناقص');
  const bad = spawnSync(process.execPath, [TOOL, '--repo', '/tmp/definitely-not-a-repo'], { encoding: 'utf8' });
  assert(bad.status === 1, 'ریشهٔ ناموجود باید ۱ بدهد، شد ' + bad.status);
  return 'exit 0/1 + JSON';
});

check('BP-10', 'قاعده‌ها برای همهٔ ردیف‌های صف قابل اجراست (فهرست صریح، نه حدس)', () => {
  const r = mod.evaluate({ cwd: ROOT });
  assert(typeof r.checks.B1 === 'boolean', 'B1 بولین نیست');
  assert(r.checks.B2 && typeof r.checks.B2.ok === 'boolean', 'B2 نیست');
  assert(r.checks.B3 && typeof r.checks.B3.ok === 'boolean', 'B3 نیست');
  const rows = ['60', '59', '54', '52', '45'];
  const list = rows.map((row, i) => ({ number: i + 1, title: `ردیف ${row} — نمونه` }));
  assert(mod.auditPrsPerRow(list, rows).ok === true, 'صف نمونه نباید نقض بدهد');
  return `rows=${rows.join(',')} branch=${r.branch}`;
});

check('BP-11', 'B5: عدد لخت در عنوان («تست ۶۰ روزه») با «ردیف ۶۰» قاطی نمی‌شود', () => {
  const fresh = '2026-11-08T10:00:00Z';
  const list = [
    { number: 17, title: 'بستهٔ استقرار ابری برای تست ۶۰ روزه', mergedAt: '2026-11-05T09:36:19Z' },
    { number: 115, title: 'docs(cloud): شناسهٔ تصمیم (ردیف ۶۰)', mergedAt: fresh },
  ];
  const r = mod.auditPrsPerRow(list, ['60']);
  assert(r.ok === true, 'یک PR صریح برای ردیف ۶۰ باید کافی باشد');
  assert(r.historical.length === 0, 'عنوان «۶۰ روزه» نباید تاریخی حساب شود');
  // دو PR صریح + یک عنوان فریبنده ⇒ باید قرمز شود (نه سه)
  const two = list.concat([{ number: 116, title: 'fix: ردیف ۶۰ — اصلاح', mergedAt: fresh }]);
  const r2 = mod.auditPrsPerRow(two, ['60']);
  assert(r2.ok === false && r2.problems[0].prs.length === 2,
    'باید فقط دو PR صریح شمرده شود: ' + JSON.stringify(r2.problems));
  return 'explicit-only matching ok';
});

console.log(`\nBP checks=${passed + failed} pass=${passed} fail=${failed}`);
if (failures.length) console.log('failures: ' + failures.join(','));
console.log(failed === 0 ? 'BRANCH-POLICY-59-TEST-OK' : 'BRANCH-POLICY-59-TEST-FAILED');
process.exit(failed === 0 ? 0 : 1);
