'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون بودجهٔ اتصال و pooling — ردیف ۴۵      (CB-01 .. CB-10)

   چه چیزی سنجیده می‌شود (بدون نیاز به PostgreSQL، پس در CI هم اجرا می‌شود):
     • فرمول بودجه: نمونه‌ها × (pool + ذخیره) و سربار پیک/rollout
     • اعتبارسنجی پیکربندی: NaN، صفر، منفی، اعشاری و خارج از سقف رد شوند
     • poolMax: پیش‌فرض، سقف سخت، مقادیر نامعتبر
     • ممیزی حالت نشستی روی کد واقعی server/** (advisory lock، LISTEN،
       SET SESSION، جدول موقت، PREPARE سطح نشست) — باید صفر باشد
     • ممیزی باید **واقعاً** کار کند: با تزریق یک فایل حاوی pg_advisory_lock
       باید یافته پیدا شود (کنترل منفی)
     • انطباق deploy/pgbouncer/pgbouncer.ini با بودجه: pool_mode=transaction،
       default_pool_size ≤ بودجه، و دو کنترل منفی (session mode، pool بزرگ)
     • کلیدهای داخل [databases] با تنظیمات pooling قاطی نشوند

   اندازه‌گیری زمان انتظار pool زیر بار واقعی در شاهد ردیف ۴۵
   (docs/cloud/reports/evidence/conn-budget-45.txt) انجام می‌شود، چون به
   PostgreSQL نیاز دارد.

   اجرا: npm run test:connb45
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '..');
const requireEsm = createRequire(path.join(ROOT, 'tools', 'conn-budget-45.mjs'));
const mod = requireEsm('./conn-budget-45.mjs');
const tenancy = require(path.join(ROOT, 'server', 'tenancy.js'));

let passed = 0, failed = 0;
const failures = [];
function check(id, desc, fn) {
  try {
    const d = fn();
    passed++;
    console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`);
  } catch (e) {
    failed++; failures.push(id);
    console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 300)}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-cb45-'));
const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'conn-budget-45.mjs'), ...args], { encoding: 'utf8', cwd: ROOT });

/* ── ۱) فرمول ── */
check('CB-01', 'فرمول بودجه: نمونه‌ها × (pool + ذخیره) با سربار ۲۰٪', () => {
  const b = mod.computeBudget({ instances: 2, pool: 4, cap: 100 });
  assert(b.required_connections === 2 * (4 + 2), 'required=' + b.required_connections);
  /* سربار ۲۰٪ روی ۱۲ = ۱۴٫۴ ⇒ گرد به ۱۴ (به‌سمت پایینِ ایمن گرد می‌شود) */
  assert(b.with_spike_headroom === Math.round(12 * 1.2), 'headroom=' + b.with_spike_headroom);
  assert(b.fits === true, 'نباید نقض شود');
  assert(b.spare_after_headroom === 100 - b.with_spike_headroom, 'spare=' + b.spare_after_headroom);
  return `required=12 headroom=${b.with_spike_headroom} spare=${b.spare_after_headroom}`;
});

check('CB-02', 'نقض بودجه واقعاً تشخیص داده می‌شود (نمونه‌های زیاد)', () => {
  const b = mod.computeBudget({ instances: 12, pool: 40, cap: 100 });
  assert(b.fits === false, 'باید نقض شود');
  assert(b.max_instances_at_this_pool >= 1, 'سقف نمونه‌ها محاسبه نشد');
  return `required=${b.required_connections} cap=${b.provider_cap} fits=false`;
});

/* ── ۲) اعتبارسنجی پیکربندی ── */
check('CB-03', 'پیکربندی نامعتبر رد می‌شود: NaN/صفر/منفی/اعشاری/خارج از سقف', () => {
  const bad = [
    ['--pool', 'NaN'], ['--pool', '0'], ['--pool', '-3'], ['--pool', '2.5'],
    ['--pool', '99999'], ['--instances', '0'], ['--instances', '99'], ['--cap', '5'], ['--cap', 'abc'],
  ];
  const results = bad.map(args => ({ args, r: run(args) }));
  const leaked = results.filter(({ r }) => r.status !== 2);
  assert(!leaked.length, 'این‌ها رد نشدند: ' + leaked.map(x => x.args.join(' ')).join(' | '));
  return `${results.length}/${bad.length} rejected with exit=2`;
});

check('CB-04', 'poolMax: پیش‌فرض ۴، سقف سخت ۵۰، ورودی نامعتبر ⇒ پیش‌فرض', () => {
  assert(tenancy.poolMax({}) === 4, 'پیش‌فرض');
  assert(tenancy.poolMax({ PAYESH_PG_POOL_MAX: '12' }) === 12, 'مقدار معتبر');
  assert(tenancy.poolMax({ PAYESH_PG_POOL_MAX: '500' }) === 50, 'سقف سخت');
  assert(tenancy.poolMax({ PAYESH_PG_POOL_MAX: 'NaN' }) === 4, 'NaN');
  assert(tenancy.poolMax({ PAYESH_PG_POOL_MAX: '-2' }) === 4, 'منفی');
  assert(tenancy.poolMax({ PAYESH_PG_POOL_MAX: '0' }) === 4, 'صفر');
  return 'default=4 hardCap=50';
});

/* ── ۳) ممیزی حالت نشستی ── */
check('CB-05', 'کد واقعی server/** هیچ حالت نشستی ندارد (سازگار با transaction pooling)', () => {
  const files = fs.readdirSync(path.join(ROOT, 'server')).filter(f => f.endsWith('.js')).map(f => 'server/' + f);
  const hits = mod.auditSessionState(files);
  assert(hits.length === 0, 'یافته: ' + JSON.stringify(hits).slice(0, 240));
  return `files=${files.length} hits=0`;
});

check('CB-06', 'کنترل منفی: تزریق pg_advisory_lock / LISTEN / SET SESSION باید دیده شود', () => {
  const injected = {
    'server/__nc_advisory.js': "client.query('select pg_advisory_lock(42)');\n",
    'server/__nc_listen.js': "client.query('LISTEN payesh_events');\n",
    'server/__nc_set.js': "client.query('SET SESSION statement_timeout = 1000');\n",
    'server/__nc_temp.js': "client.query('CREATE TEMP TABLE t (a int)');\n",
    'server/__nc_prepare.js': "client.query('PREPARE p1 AS select 1');\n",
  };
  const created = [];
  try {
    for (const [rel, body] of Object.entries(injected)) {
      fs.writeFileSync(path.join(ROOT, rel), body);
      created.push(rel);
    }
    const hits = mod.auditSessionState(created);
    const kinds = new Set(hits.map(h => h.pattern));
    for (const want of ['advisory_lock', 'listen_notify', 'set_session', 'temp_table', 'session_prepare']) {
      assert(kinds.has(want), 'الگوی ' + want + ' پیدا نشد (پیداشده: ' + Array.from(kinds).join(',') + ')');
    }
    return '5/5 patterns detected';
  } finally {
    for (const rel of created) { try { fs.unlinkSync(path.join(ROOT, rel)); } catch (e) { /* noop */ } }
  }
});

/* ── ۴) انطباق PgBouncer ── */
/* بودجهٔ توصیه‌شدهٔ استقرار: ۲ نمونه × pool ۱۲ (+۲ ذخیره) با ظرفیت ۱۰۰ */
const budget = mod.computeBudget({ instances: 2, pool: 12, cap: 100 });
const iniPath = path.join(ROOT, 'deploy', 'pgbouncer', 'pgbouncer.ini');

check('CB-07', 'pgbouncer.ini با بودجه سازگار است (transaction + pool ≤ بودجه)', () => {
  const text = fs.readFileSync(iniPath, 'utf8');
  const res = mod.checkPgbouncerIni(text, budget);
  assert(res.problems.length === 0, res.problems.join(' | '));
  assert(res.ini.pool_mode === 'transaction', 'pool_mode=' + res.ini.pool_mode);
  assert(res.ini.default_pool_size <= budget.pool_per_instance, 'pool بیش از بودجه');
  return `pool_mode=${res.ini.pool_mode} pool=${res.ini.default_pool_size} ≤ ${budget.pool_per_instance}`;
});

check('CB-08', 'کنترل منفی: pool_mode=session یا pool بزرگ‌تر از بودجه باید رد شود', () => {
  const text = fs.readFileSync(iniPath, 'utf8');
  const session = text.replace('pool_mode = transaction', 'pool_mode = session');
  const big = text.replace('default_pool_size = 12', 'default_pool_size = 40');
  const r1 = mod.checkPgbouncerIni(session, budget);
  const r2 = mod.checkPgbouncerIni(big, budget);
  assert(r1.problems.some(p => /transaction/.test(p)), 'session mode رد نشد');
  assert(r2.problems.some(p => /بیشتر/.test(p)), 'pool بزرگ رد نشد');
  return 'session-mode=rejected big-pool=rejected';
});

check('CB-09', 'کلیدهای [databases] با تنظیمات pooling قاطی نمی‌شوند', () => {
  const ini = mod.parsePgbouncerIni(fs.readFileSync(iniPath, 'utf8'));
  assert(ini.__sections.includes('databases'), 'بخش [databases] دیده نشد');
  assert(!ini['payesh'], 'نام پایگاه به‌اشتباه کلید تنظیمات شده');
  assert(ini.pool_mode === 'transaction', 'pool_mode خوانده نشد');
  return 'sections=' + ini.__sections.join(',');
});

/* ── ۵) دروازهٔ کامل روی خودِ مخزن ── */
check('CB-10', 'دروازهٔ ابزار روی مخزن سبز است و با پیکربندی خراب قرمز می‌شود', () => {
  const ok = run([]);
  assert(ok.status === 0, 'exit=' + ok.status + ' ' + (ok.stdout || '').slice(-200));
  const jsonPath = path.join(TMP, 'budget.json');
  const withJson = run(['--json-out', jsonPath]);
  assert(withJson.status === 0, 'json-out exit=' + withJson.status);
  const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert(j.budget.fits === true && j.session_state_hits.length === 0, 'گزارش JSON ناسازگار');
  const bad = run(['--pool', 'NaN']);
  assert(bad.status === 2, 'پیکربندی خراب باید exit=2 بدهد');
  return 'gate=OK bad-config=exit2';
});

console.log(`\nCB checks=${passed + failed} pass=${passed} fail=${failed}`);
if (failures.length) console.log('failures: ' + failures.join(','));
console.log(failed === 0 ? 'CONN-BUDGET-45-TEST-OK' : 'CONN-BUDGET-45-TEST-FAILED');
process.exit(failed === 0 ? 0 : 1);
