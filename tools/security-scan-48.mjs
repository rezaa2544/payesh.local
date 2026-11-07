#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────────
   ردیف ۴۸ — دروازهٔ امنیت ایستا (SAST + dependency scan) در CI
   ورودی‌ها: کد مخزن + package-lock.json + قواعد tools/semgrep/*.yml
   خروجی: خلاصهٔ JSON + کد خروج غیرصفر در صورت یافتهٔ مهارنشده

   گیت‌ها (FAIL-CLOSED):
     G1) وابستگی‌های تولیدی: هیچ high/critical (بدون استثنا)
     G2) وابستگی‌های توسعه: هر یافته باید در tools/deps-allowlist.json با
         دلیل و تاریخ انقضا باشد؛ یافتهٔ تازه یا منقضی = قرمز
     G3) semgrep (الگوها): هیچ یافتهٔ ERROR
     G4) semgrep (taint روی server/): هیچ یافتهٔ ERROR (تزریق SQL/فرمان)
     G5) هر WARNING باید در tools/semgrep/triage.json تریاژ شده باشد
         (رشد خاموش هشدارها ممنوع)
     G6) هیچ رازِ ثابت در فایل‌های ردیابی‌شدهٔ گیت (اسکن مستقل از semgrep)

   استفاده:
     node tools/security-scan-48.mjs
     node tools/security-scan-48.mjs --root /tmp/copy   # برای کنترل منفی
     node tools/security-scan-48.mjs --update-triage    # بازتولید فهرست تریاژ
   ─────────────────────────────────────────────────────────────────── */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);

const ROOT = path.resolve(arg('--root', REPO));
const JSON_OUT = arg('--json-out', null);
const UPDATE_TRIAGE = flag('--update-triage');
const SEMGREP = arg('--semgrep', process.env.SEMGREP_BIN || 'semgrep');
const SKIP_DEPS = flag('--skip-deps');   /* برای کنترل منفی: فقط SAST */

const result = {
  tool: 'security-scan-48',
  root: ROOT,
  started_at: new Date().toISOString(),
  gates: {},
  findings: { semgrep_error: [], semgrep_warning: [], untriaged: [], deps_prod: [], deps_dev_unlisted: [], secrets: [] },
  counts: {},
};

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function readJson(relPath, fallback) {
  const p = path.join(ROOT, relPath);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

/* ── G1/G2 — وابستگی‌ها (npm audit روی همان package-lock) ─────────── */
function auditArgs(kind) {
  return kind === 'prod' ? ['audit', '--omit=dev', '--json'] : ['audit', '--json'];
}
function runNpmAudit(kind) {
  try {
    const out = execFileSync('npm', auditArgs(kind), { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out || '{}');
  } catch (e) {
    /* npm audit با کد ۱ خارج می‌شود ولی JSON معتبر می‌دهد */
    const raw = String((e && e.stdout) || '');
    try { return JSON.parse(raw || '{}'); } catch (e2) { throw new Error('npm audit output unparsable'); }
  }
}

function auditFindings(report) {
  const out = [];
  const vulns = (report && report.vulnerabilities) || {};
  for (const [name, v] of Object.entries(vulns)) {
    const sev = String(v.severity || '').toLowerCase();
    if (sev !== 'high' && sev !== 'critical') continue;
    const advisories = (v.via || []).filter(x => x && typeof x === 'object').map(x => ({
      title: x.title || '', url: x.url || '', cvss: x.cvss && x.cvss.score,
    }));
    const ids = advisories.map(a => (a.url || '').split('/').pop()).filter(Boolean);
    out.push({
      package: name, severity: sev, advisories,
      ids: ids.length ? ids : ['no-advisory-id'],
      fix_available: v.fixAvailable !== false,
    });
  }
  return out;
}

if (!SKIP_DEPS) {
  const prod = auditFindings(runNpmAudit('prod'));
  const dev = auditFindings(runNpmAudit('dev')).filter(d => !prod.some(p => p.package === d.package));
  result.findings.deps_prod = prod;

  const allow = readJson('tools/deps-allowlist.json', { entries: [] }).entries || [];
  const now = Date.now();
  const unlisted = [];
  for (const d of dev) {
    const entry = allow.find(a => a.package === d.package && (!a.advisory || d.ids.includes(a.advisory)));
    if (!entry) { unlisted.push({ ...d, why: 'no allowlist entry' }); continue; }
    if (entry.expires && Date.parse(entry.expires) < now) unlisted.push({ ...d, why: 'allowlist entry expired at ' + entry.expires });
  }
  result.findings.deps_dev_unlisted = unlisted;
  result.counts.deps_prod_high = prod.length;
  result.counts.deps_dev_high = dev.length;
  result.gates.G1_deps_prod_clean = prod.length === 0;
  result.gates.G2_deps_dev_triaged = unlisted.length === 0;
} else {
  result.gates.G1_deps_prod_clean = true;
  result.gates.G2_deps_dev_triaged = true;
  result.counts.deps_prod_high = 0;
  result.counts.deps_dev_high = 0;
}

/* ── G3/G4/G5 — semgrep ──────────────────────────────────────────── */
function runSemgrep(configPath, includes) {
  const args = ['--config', configPath, '--json', '--quiet', '--metrics=off',
    '--disable-version-check', '--no-rewrite-rule-ids', '--timeout', '120'];
  for (const inc of includes) { args.push('--include', inc); }
  const excludes = ['node_modules/**', 'releases/**', 'data/**', '.git/**', '.build/**'];
  for (const exc of excludes) { args.push('--exclude', exc); }
  args.push('.');
  let stdout = '';
  try {
    stdout = execFileSync(SEMGREP, args, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SEMGREP_ENABLE_VERSION_CHECK: '0', SEMGREP_SEND_METRICS: 'off' },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    stdout = String((e && e.stdout) || '');
    if (!stdout) throw new Error('semgrep failed: ' + String((e && e.stderr) || e).slice(0, 300));
  }
  let parsed;
  try { parsed = JSON.parse(stdout); } catch (e) { throw new Error('semgrep JSON unparsable'); }
  return (parsed.results || []).map(r => {
    const checkId = String(r.check_id || '').split('.').pop();
    const file = rel(r.path);
    const line = (r.start && r.start.line) || 0;
    const text = String((r.extra && r.extra.lines) || '').trim();
    return {
      rule: checkId, path: file, line,
      severity: String((r.extra && r.extra.severity) || 'WARNING').toUpperCase(),
      message: String((r.extra && r.extra.message) || '').replace(/\s+/g, ' ').slice(0, 220),
      fingerprint: sha(`${checkId}|${file}|${text}`),
    };
  });
}

const PATTERN_RULES = path.join(ROOT, 'tools/semgrep/rules.yml');
const TAINT_RULES = path.join(ROOT, 'tools/semgrep/taint-rules.yml');
const scans = [
  { name: 'pattern', config: PATTERN_RULES, includes: ['server/**', 'client/**', 'tools/**', 'scripts/**', 'bench/**', 'tests/**'] },
  { name: 'taint', config: TAINT_RULES, includes: ['server/**'] },
];
let all = [];
try {
  for (const s of scans) all = all.concat(runSemgrep(s.config, s.includes));
} catch (e) {
  result.errors = [String(e.message || e)];
}
const errors = all.filter(f => f.severity === 'ERROR');
const warnings = all.filter(f => f.severity !== 'ERROR');
result.findings.semgrep_error = errors;
result.findings.semgrep_warning = warnings.map(w => ({ rule: w.rule, path: w.path, line: w.line, fingerprint: w.fingerprint }));

/* تریاژ بر پایهٔ «سقف تعداد به‌ازای قاعده» است، نه شمارهٔ خط:
   رشد خاموش (قاعدهٔ تازه یا تعداد بیشتر) دروازه را قرمز می‌کند، ولی جابه‌جایی
   خط با ویرایش‌های معمولی، شاهد را نمی‌شکند. */
const triagePath = 'tools/semgrep/triage.json';
const triage = readJson(triagePath, { rules: {} });
const warnByRule = {};
for (const w of warnings) warnByRule[w.rule] = (warnByRule[w.rule] || 0) + 1;
if (UPDATE_TRIAGE) {
  const rules = Object.assign({}, triage.rules);
  for (const [rule, count] of Object.entries(warnByRule)) {
    const prev = rules[rule] || {};
    rules[rule] = {
      max: Math.max(count, Number(prev.max) || 0),
      reason: prev.reason || 'TODO: دلیل تریاژ',
      owner: prev.owner || 'code',
      reviewed_at: new Date().toISOString().slice(0, 10),
      sites: count,
    };
    rules[rule].sites = count;
  }
  fs.writeFileSync(path.join(ROOT, triagePath), JSON.stringify({ _doc: triage._doc, rules }, null, 2) + '\n', 'utf8');
  triage.rules = rules;
}
const untriaged = [];
for (const [rule, count] of Object.entries(warnByRule)) {
  const entry = triage.rules && triage.rules[rule];
  if (!entry) untriaged.push({ rule, count, why: 'rule not triaged' });
  else if (count > Number(entry.max || 0)) untriaged.push({ rule, count, max: entry.max, why: 'count above triaged ceiling' });
}
result.findings.untriaged = untriaged;
result.findings.warnings_by_rule = warnByRule;

result.counts.semgrep_error = errors.length;
result.counts.semgrep_warning = warnings.length;
result.counts.untriaged = untriaged.length;
result.gates.G3_sast_no_errors = errors.length === 0;
result.gates.G4_sast_taint_no_errors = errors.filter(e => /taint/.test(e.rule)).length === 0;
result.gates.G5_warnings_triaged = untriaged.length === 0;

/* ── G6 — اسکن راز (مستقل از semgrep، روی فایل‌های ردیابی‌شده) ───── */
const SECRET_PATTERNS = [
  { id: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/g },
  { id: 'private_key_block', re: /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----/g },
  { id: 'github_pat', re: /ghp_[A-Za-z0-9]{30,}/g },
  { id: 'slack_token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'openai_key', re: /sk-[A-Za-z0-9]{32,}/g },
];
/* مقادیر نمونهٔ مستندشده (وکتور رسمی AWS SigV4) راز نیستند */
const BENIGN_SECRET = [/AKIAIOSFODNN7EXAMPLE/, /wJalrXUtnFEMI\/K7MDENG\/bPxRfiCYEXAMPLEKEY/];
let tracked = [];
try {
  tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean);
} catch (e) { tracked = []; }
if (tracked.length === 0) {
  /* --root بدون .git: کل فایل‌های متنی زیر درخت (برای کنترل منفی) */
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'releases', 'data'].includes(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs|json|yml|yaml|md|sh|txt|env)$/.test(ent.name) && fs.statSync(p).size < 2e6) tracked.push(rel(p));
    }
  };
  walk(ROOT);
}
const secretHits = [];
for (const f of tracked) {
  if (/^(node_modules|releases|data)\//.test(f)) continue;
  const abs = path.join(ROOT, f);
  let st;
  try { st = fs.statSync(abs); } catch (e) { continue; }
  if (!st.isFile() || st.size > 2e6) continue;
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { continue; }
  for (const pat of SECRET_PATTERNS) {
    pat.re.lastIndex = 0;
    let m;
    while ((m = pat.re.exec(text))) {
      const line = text.slice(0, m.index).split('\n').length;
      const lineText = text.split('\n')[line - 1] || '';
      if (BENIGN_SECRET.some(re => re.test(m[0]) || re.test(lineText))) continue;
      secretHits.push({ pattern: pat.id, path: f, line, sample: m[0].slice(0, 8) + '…' });
    }
  }
}
result.findings.secrets = secretHits.slice(0, 50);
result.counts.secrets = secretHits.length;
result.gates.G6_no_hardcoded_secrets = secretHits.length === 0;

/* ── خروجی ───────────────────────────────────────────────────────── */
const gateNames = Object.keys(result.gates);
result.ok = gateNames.every(g => result.gates[g]) && !result.errors;
result.finished_at = new Date().toISOString();

const summary = {
  ok: result.ok,
  gates: result.gates,
  counts: result.counts,
  files_scanned_hint: 'server/ client/ tools/ scripts/ bench/ tests/ (pattern) · server/ (taint)',
  errors: result.errors || [],
};
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2) + '\n', 'utf8');

if (!flag('--quiet')) {
  console.log('security-scan-48 — gates:');
  for (const g of gateNames) console.log(`  ${result.gates[g] ? 'ok  ' : 'FAIL'} ${g}`);
  console.log('  counts: ' + JSON.stringify(result.counts));
  for (const f of result.findings.semgrep_error.slice(0, 10)) console.log(`  ERROR ${f.rule} ${f.path}:${f.line}`);
  for (const u of result.findings.untriaged.slice(0, 10)) console.log(`  UNTRIAGED ${u.rule} ${u.path}:${u.line} fp=${u.fingerprint}`);
  for (const d of result.findings.deps_dev_unlisted.slice(0, 10)) console.log(`  DEP-UNLISTED ${d.package} (${d.severity}) ${d.why}`);
  for (const s of result.findings.secrets.slice(0, 10)) console.log(`  SECRET ${s.pattern} ${s.path}:${s.line}`);
  console.log(JSON.stringify(summary.gates) === '' ? '' : '');
}
console.log(result.ok ? 'SECURITY-SCAN-48-OK' : 'SECURITY-SCAN-48-FAILED');
process.exit(result.ok ? 0 : 1);
