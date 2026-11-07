'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۴۸ — دروازهٔ امنیت ایستا: آزمون دروازه + پنج کنترل منفی
                        (SS-01 .. SS-12)

   آنچه سنجیده می‌شود (روی همین مخزن، با ابزار واقعی):
     • npm audit: وابستگی تولیدی = صفر high/critical
     • npm audit: هر یافتهٔ dev در allowlist با دلیل و تاریخ انقضا
     • semgrep (الگو + taint): هیچ یافتهٔ ERROR
     • هشدارها: هر قاعده تریاژ شده و تعداد از سقف نگذشته
     • اسکن راز روی فایل‌های ردیابی‌شدهٔ گیت
   و پنج کنترل منفی که ثابت می‌کنند دروازه واقعاً قرمز می‌شود:
     eval دینامیک · SQL آلوده به ورودی HTTP · کلید AWS ثابت ·
     قاعدهٔ هشدار بدون تریاژ · allowlist منقضی

   پیش‌نیاز: semgrep (در CI با pip نصب می‌شود) — SEMGREP_BIN یا PATH.
   اجرا: npm run test:security48
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCAN = path.join(ROOT, 'tools', 'security-scan-48.mjs');
const SEMGREP = process.env.SEMGREP_BIN || 'semgrep';

let passed = 0, failed = 0;
const failures = [];
async function check(id, desc, fn) {
  const t0 = Date.now();
  try {
    const d = await fn();
    passed++;
    console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}  (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++; failures.push(id);
    console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 300)}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

function semgrepAvailable() {
  const r = spawnSync(SEMGREP, ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

/* اجرای دروازه روی یک ریشه؛ خروجی = {code, json} */
function runScan(root, extraArgs = []) {
  const outFile = path.join(os.tmpdir(), 'sec48-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const r = spawnSync(process.execPath, [SCAN, '--root', root, '--semgrep', SEMGREP, '--quiet', '--json-out', outFile, ...extraArgs],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SEMGREP_ENABLE_VERSION_CHECK: '0' } });
  let json = null;
  try { json = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) { json = null; }
  try { fs.unlinkSync(outFile); } catch (e) { /* noop */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/* کپی سبک از درخت کاری (hardlink) برای کنترل منفی — بدون node_modules/.git/releases */
function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec48-root-'));
  const skip = new Set(['node_modules', '.git', 'releases', 'data', '.build', '.arena']);
  const walk = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const s = path.join(src, ent.name), d = path.join(dst, ent.name);
      if (ent.isDirectory()) walk(s, d);
      else if (ent.isFile()) { try { fs.linkSync(s, d); } catch (e) { fs.copyFileSync(s, d); } }
    }
  };
  walk(ROOT, dir);
  return dir;
}
function mutate(root, relPath, fn) {
  const p = path.join(root, relPath);
  const before = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const after = fn(before);
  try { fs.unlinkSync(p); } catch (e) { /* فایل تازه */ }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, after, 'utf8');
}
const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* noop */ } };

(async () => {
  if (!semgrepAvailable()) {
    console.log(`BLOCKED  semgrep «${SEMGREP}» در PATH نیست — نصب: pip install semgrep (یا SEMGREP_BIN=...)`);
    console.log('SECURITY-48-BLOCKED');
    process.exit(3);
  }

  /* ── دروازهٔ پایه روی همین مخزن ─────────────────────────────────── */
  const base = runScan(ROOT);
  const B = base.json || { gates: {}, counts: {}, findings: {} };

  await check('SS-01', 'وابستگی‌های تولیدی: صفر high/critical (بدون استثنا)', async () => {
    assert(B.gates && 'G1_deps_prod_clean' in B.gates, 'گیت G1 اجرا نشد: ' + JSON.stringify(B.errors || base.stderr).slice(0, 200));
    assert(B.gates.G1_deps_prod_clean === true, 'G1 قرمز: ' + B.counts.deps_prod_high);
    return `prod_high=${B.counts.deps_prod_high}`;
  });

  await check('SS-02', 'وابستگی‌های dev: هر یافته با دلیل و تاریخ انقضا در allowlist', async () => {
    assert(B.gates.G2_deps_dev_triaged === true, 'G2 قرمز: ' + JSON.stringify(B.findings.deps_dev_unlisted).slice(0, 200));
    const allow = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/deps-allowlist.json'), 'utf8'));
    assert(allow.entries.every(e => e.reason && e.expires), 'مدخل بدون دلیل/انقضا در allowlist');
    return `dev_high=${B.counts.deps_dev_high} همه تریاژ‌شده`;
  });

  await check('SS-03', 'SAST الگویی: صفر یافتهٔ ERROR (eval/راز/client env)', async () => {
    assert(B.gates.G3_sast_no_errors === true, 'ERROR: ' + JSON.stringify(B.findings.semgrep_error).slice(0, 250));
    return 'errors=0';
  });

  await check('SS-04', 'SAST taint روی server/: صفر تزریق SQL/فرمان', async () => {
    assert(B.gates.G4_sast_taint_no_errors === true, 'taint: ' + JSON.stringify(B.findings.semgrep_error).slice(0, 250));
    return 'taint_errors=0';
  });

  await check('SS-05', 'هشدارها تریاژ‌شده و زیر سقفِ ثبت‌شده (رشد خاموش ممنوع)', async () => {
    assert(B.gates.G5_warnings_triaged === true, 'UNTRIAGED: ' + JSON.stringify(B.findings.untriaged).slice(0, 250));
    const triage = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/semgrep/triage.json'), 'utf8'));
    for (const [rule, e] of Object.entries(triage.rules)) assert(e.reason && e.reason.length > 20, 'دلیل تریاژ ناکافی: ' + rule);
    return `warnings=${B.counts.semgrep_warning} · rules=${Object.keys(triage.rules).length} تریاژ‌شده`;
  });

  await check('SS-06', 'اسکن راز: صفر رازِ ثابت در فایل‌های ردیابی‌شده (نمونهٔ AWS مستثنا)', async () => {
    assert(B.gates.G6_no_hardcoded_secrets === true, 'SECRET: ' + JSON.stringify(B.findings.secrets).slice(0, 250));
    const src = fs.readFileSync(SCAN, 'utf8');
    assert(/AKIAIOSFODNN7EXAMPLE/.test(src), 'استثنای وکتور AWS در ابزار نیست');
    return 'secrets=0';
  });

  /* ── کنترل منفی ۱: eval دینامیک ─────────────────────────────────── */
  await check('SS-07', 'کنترل منفی: eval روی ورودی HTTP ⇒ دروازه قرمز می‌شود', async () => {
    const r = makeRoot();
    try {
      mutate(r, 'server/nc-eval.js', () => `'use strict';\nmodule.exports = function run(req, res) {\n  const out = eval(req.query.expr);\n  return res.end(String(out));\n};\n`);
      const s = runScan(r, ['--skip-deps']);
      assert(s.code !== 0, 'دروازه با eval دینامیک قرمز نشد (code=' + s.code + ')');
      const errs = (s.json && s.json.findings.semgrep_error) || [];
      assert(errs.some(e => /eval/.test(e.rule)), 'یافتهٔ eval ثبت نشد: ' + JSON.stringify(errs).slice(0, 200));
      return `gate=RED (eval, ${errs.length} error)`;
    } finally { cleanup(r); }
  });

  /* ── کنترل منفی ۲: SQL آلوده ─────────────────────────────────────── */
  await check('SS-08', 'کنترل منفی: SQL ساخته‌شده از req.body ⇒ دروازه قرمز می‌شود', async () => {
    const r = makeRoot();
    try {
      mutate(r, 'server/nc-sqli.js', () => `'use strict';\nmodule.exports = async function find(c, req) {\n  const name = req.body.name;\n  const q = \`select * from users where name = '\` + name + \`'\`;\n  return c.query(q);\n};\n`);
      const s = runScan(r, ['--skip-deps']);
      assert(s.code !== 0, 'دروازه با SQL آلوده قرمز نشد (code=' + s.code + ')');
      const errs = (s.json && s.json.findings.semgrep_error) || [];
      assert(errs.some(e => /sql-taint/.test(e.rule)), 'یافتهٔ sql-taint ثبت نشد: ' + JSON.stringify(errs).slice(0, 200));
      return `gate=RED (sql-taint)`;
    } finally { cleanup(r); }
  });

  /* ── کنترل منفی ۳: راز ثابت ─────────────────────────────────────── */
  await check('SS-09', 'کنترل منفی: کلید AWS ثابت در کد ⇒ دروازه قرمز می‌شود', async () => {
    const r = makeRoot();
    try {
      /* کلید نمونه تکه‌تکه ساخته می‌شود تا خودِ این فایل آزمون، رازِ ثابت
         نداشته باشد (G6 روی فایل‌های ردیابی‌شده اجرا می‌شود، از جمله همین فایل).
         فایل تزریق‌شده در کپی موقت، کلید کامل را دارد ⇒ دروازه باید قرمز شود. */
      const FAKE_AWS = 'AKIA' + 'QWERTYUIOPASDFGH';
      mutate(r, 'server/nc-secret.js', () => `'use strict';\nconst KEY = '${FAKE_AWS}';\nmodule.exports = KEY;\n`);
      const s = runScan(r, ['--skip-deps']);
      assert(s.code !== 0, 'دروازه با راز ثابت قرمز نشد (code=' + s.code + ')');
      const hits = (s.json && s.json.findings.secrets) || [];
      assert(hits.some(h => h.pattern === 'aws_access_key'), 'یافتهٔ راز ثبت نشد');
      return 'gate=RED (aws_access_key)';
    } finally { cleanup(r); }
  });

  /* ── کنترل منفی ۴: هشدار بدون تریاژ ─────────────────────────────── */
  await check('SS-10', 'کنترل منفی: هشدار تازه بدون تریاژ ⇒ دروازه قرمز می‌شود', async () => {
    const r = makeRoot();
    try {
      /* سقفِ ثبت‌شده را پایین می‌آوریم: یعنی یک هشدار «تازه» بلامدخل می‌شود */
      mutate(r, 'tools/semgrep/triage.json', (t) => {
        const j = JSON.parse(t);
        for (const k of Object.keys(j.rules)) j.rules[k].max = 0;
        return JSON.stringify(j, null, 2);
      });
      const s = runScan(r, ['--skip-deps']);
      assert(s.code !== 0, 'دروازه با هشدار تریاژ‌نشده قرمز نشد (code=' + s.code + ')');
      assert(s.json && s.json.gates.G5_warnings_triaged === false, 'گیت G5 قرمز نشد');
      return 'gate=RED (untriaged warnings)';
    } finally { cleanup(r); }
  });

  /* ── کنترل منفی ۵: allowlist منقضی ──────────────────────────────── */
  await check('SS-11', 'کنترل منفی: allowlist وابستگیِ منقضی ⇒ دروازه قرمز می‌شود', async () => {
    const r = makeRoot();
    try {
      mutate(r, 'tools/deps-allowlist.json', (t) => {
        const j = JSON.parse(t);
        for (const e of j.entries) e.expires = '2020-01-01';
        return JSON.stringify(j, null, 2);
      });
      const s = runScan(r);   /* بدون --skip-deps: audit واقعی */
      assert(s.code !== 0, 'دروازه با allowlist منقضی قرمز نشد (code=' + s.code + ')');
      assert(s.json && s.json.gates.G2_deps_dev_triaged === false, 'گیت G2 قرمز نشد');
      return 'gate=RED (expired allowlist)';
    } finally { cleanup(r); }
  });

  /* ── پوشش و سیم‌کشی ─────────────────────────────────────────────── */
  await check('SS-12', 'پوشش واقعی: قواعد و مسیرهای محصول اسکن می‌شوند و CI/سند وصل است', async () => {
    const rules = fs.readFileSync(path.join(ROOT, 'tools/semgrep/rules.yml'), 'utf8');
    const taint = fs.readFileSync(path.join(ROOT, 'tools/semgrep/taint-rules.yml'), 'utf8');
    const nRules = (rules.match(/^\s+- id: /gm) || []).length;
    const nTaint = (taint.match(/^\s+- id: /gm) || []).length;
    assert(nRules >= 6, 'قواعد الگویی کم است: ' + nRules);
    assert(nTaint >= 2, 'قواعد taint کم است: ' + nTaint);
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');
    assert(/test:security48/.test(wf), 'گام CI برای این دروازه نیست');
    assert(fs.existsSync(path.join(ROOT, 'docs/cloud/48-security-scan.md')), 'سند ردیف ۴۸ نیست');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert(pkg.scripts['test:security48'] && pkg.scripts['security:scan'], 'اسکریپت‌های npm ثبت نشده‌اند');
    return `rules=${nRules} taint=${nTaint} ci=true doc=true`;
  });

  console.log(`\nSS checks=${passed + failed} pass=${passed} fail=${failed}`);
  console.log(failed === 0 ? 'SECURITY-48-OK' : 'SECURITY-48-FAILED');
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', (e && e.stack) || e); process.exit(1); });
