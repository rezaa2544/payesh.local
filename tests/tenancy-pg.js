'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون ردیف ۲۶ (F‑05) — tenant model + RLS از مسیر HTTP محصول
   روی PostgreSQL واقعی.

   تولید: bash docs/cloud/reports/evidence/run-f05-product-tenancy.sh
   متغیرهای محیط: PGURL_ADMIN، PGURL_RUNTIME، TENANCY_SECRET، APP_PORT، PAYESH_DATA
   (همان قرارداد CC‑12‑2؛ باینری PostgreSQL بیرون از مخزن است)
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const tenancy = require(path.join(ROOT, 'server/tenancy.js'));

const ADMIN_URL = process.env.PGURL_ADMIN || '';
const RUNTIME_URL = process.env.PGURL_RUNTIME || '';
const SECRET = process.env.TENANCY_SECRET || '';
const PORT = Number(process.env.APP_PORT || 0);
const DATA = process.env.PAYESH_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-f05-'));
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

let passed = 0, failed = 0;
function check(id, desc, fn) {
  return Promise.resolve().then(fn)
    .then((d) => { passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); })
    .catch((e) => { failed++; console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function tokenFor(tid) {
  return tenancy.signToken({
    tid, role: 'manager', uid: `u-${tid.slice(0, 4)}`, did: `d-${tid.slice(0, 4)}`,
    iat: Date.now(), exp: Date.now() + 600000,
  }, SECRET);
}

async function http(pathname, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  if (opts.headers) Object.assign(headers, opts.headers);
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method: opts.method || 'GET', headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { Client } = require('pg');
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  /* ۱) مهاجرت از مسیر محصول */
  const mig = await tenancy.migrate(admin);
  assert(mig.table === 'tenant_records', 'جدول پایه مهاجرت شد');

  /* سرور محصول با همان تنظیمات محصول بالا می‌آید */
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: DATA, PAYESH_LOG: '0',
      PAYESH_TENANCY_PG: RUNTIME_URL, PAYESH_TENANCY_SECRET: SECRET,
      PAYESH_CLOUD_AUTO: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_AUTO_BACKUP: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });

  const up = async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
        const j = await r.json();
        if (j && j.ok) return true;
      } catch (e) { /* retry */ }
      await sleep(250);
    }
    return false;
  };
  assert(await up(), 'سرور محصول بالا آمد — ' + log.slice(-400));

  const A = tokenFor(TENANT_A);
  const B = tokenFor(TENANT_B);
  const P = '/api/cloud/tenancy/product';

  try {
    await check('F05-01', 'CRUD: درج کلاس در مستأجر A از مسیر محصول', async () => {
      const r = await http(P, { method: 'POST', token: A, body: { collection: 'classes', id: 10, data: { name: 'کلاس الف', grade: 9 } } });
      assert(r.status === 201 && r.data.ok, 'درج: ' + JSON.stringify(r.data).slice(0, 200));
      assert(r.data.row.version === 1, 'نسخهٔ آغازین ۱');
      const g = await http(`${P}/classes/10`, { token: A });
      assert(g.status === 200 && g.data.row.data.name === 'کلاس الف', 'خواندن همان ردیف');
      return 'version=1';
    });

    await check('F05-02', 'OCC: نسخهٔ کهنه ⇒ 409 و بدون نوشتن', async () => {
      await http(P, { method: 'POST', token: A, body: { collection: 'classes', id: 10, data: { name: 'کلاس الف۲' }, base_version: 1 } });
      const bad = await http(P, { method: 'POST', token: A, body: { collection: 'classes', id: 10, data: { name: 'نفوذ' }, base_version: 1 } });
      assert(bad.status === 409 && bad.data.error === 'version_conflict', 'تعارض نسخه: ' + JSON.stringify(bad.data));
      const g = await http(`${P}/classes/10`, { token: A });
      assert(g.data.row.data.name === 'کلاس الف۲', 'داده دست‌نخورده ماند');
      return 'version=' + g.data.row.version;
    });

    await check('F05-03', 'scope: ورودی کلاینت نمی‌تواند tenant/school را تعیین کند', async () => {
      const r = await http(P, {
        method: 'POST', token: A,
        headers: { 'x-tenant': TENANT_B, 'x-tenant-id': TENANT_B },
        body: { collection: 'classes', id: 11, tenant_id: TENANT_B, school_id: 999, data: { name: 'با تلاش جعل', tenant_id: TENANT_B, school_id: 999 } },
      });
      assert(r.status === 201, 'درج انجام شد');
      assert(!r.data.row.data.tenant_id && !r.data.row.data.school_id, 'فیلدهای مستأجر از دادهٔ ذخیره‌شده حذف شدند');
      const ga = await http(`${P}/classes/11`, { token: A });
      const gb = await http(`${P}/classes/11`, { token: B });
      assert(ga.status === 200, 'مستأجر A ردیف را می‌بیند');
      assert(gb.status === 404, 'مستأجر B آن را نمی‌بیند (RLS)');
      return 'tenant=session-only';
    });

    await check('F05-04', 'cross-tenant: خواندن/حذف/بروزرسانی دادهٔ A توسط B رد می‌شود', async () => {
      const g = await http(`${P}/classes/10`, { token: B });
      assert(g.status === 404, 'خواندن ۴۰۴');
      const d = await http(`${P}/classes/10`, { method: 'DELETE', token: B });
      assert(d.status === 404, 'حذف ۴۰۴');
      const e = await http(`${P}/export`, { method: 'POST', token: B, body: { collection: 'classes' } });
      assert(e.status === 200 && e.data.count === 0, 'export مستأجر B خالی است');
      const ga = await http(`${P}/classes/10`, { token: A });
      assert(ga.status === 200, 'دادهٔ A سالم است');
      return 'deny=read,delete,export';
    });

    await check('F05-05', 'join دو کالکشن در همان مستأجر', async () => {
      await http(P, { method: 'POST', token: A, body: { collection: 'students', id: 1, data: { name: 'دانش‌آموز', class_id: 10 } } });
      await http(P, { method: 'POST', token: A, body: { collection: 'attendance', id: 1, data: { class_id: 10, status: 'present' } } });
      const j = await http(`${P}/join`, { method: 'POST', token: A, body: { left: 'attendance', right: 'students', on: 'class_id' } });
      assert(j.status === 200 && j.data.count >= 1, 'join نتیجه داد: ' + JSON.stringify(j.data).slice(0, 160));
      const jb = await http(`${P}/join`, { method: 'POST', token: B, body: { left: 'attendance', right: 'students', on: 'class_id' } });
      assert(jb.data.count === 0, 'join مستأجر B خالی است');
      return 'rows=' + j.data.count;
    });

    await check('F05-06', 'export مستأجر A کامل است و حذف‌شده‌ها را ندارد', async () => {
      await http(P, { method: 'POST', token: A, body: { collection: 'classes', id: 12, data: { name: 'حذف‌شدنی' } } });
      await http(`${P}/classes/12`, { method: 'DELETE', token: A });
      const ex = await http(`${P}/export`, { method: 'POST', token: A, body: { collection: 'classes' } });
      assert(ex.status === 200, 'export ۲۰۰');
      assert(ex.data.rows.every((r) => !r.deleted), 'ردیف حذف‌شده در export نیست');
      assert(ex.data.count === 2, 'دو ردیف فعال (۱۰ و ۱۱) — شد ' + ex.data.count);
      return 'count=' + ex.data.count;
    });

    await check('F05-07', 'job: صف کار مستأجرمحور (enqueue/claim/complete)', async () => {
      const e = await http(`${P}/jobs`, { method: 'POST', token: A, body: { kind: 'export', payload: { collection: 'classes' } } });
      assert(e.status === 201 && e.data.job.id, 'کار ثبت شد');
      const cb = await http(`${P}/jobs/claim`, { method: 'POST', token: B });
      assert(cb.status === 204, 'مستأجر B هیچ کاری برنمی‌دارد');
      const ca = await http(`${P}/jobs/claim`, { method: 'POST', token: A });
      assert(ca.status === 200 && ca.data.job.id === e.data.job.id, 'کار برای A برداشته شد');
      const done = await http(`${P}/jobs/${e.data.job.id}/complete`, { method: 'POST', token: A, body: { result: { ok: true } } });
      assert(done.status === 200 && done.data.job.status === 'done', 'کار بسته شد');
      return 'job=' + e.data.job.id;
    });

    await check('F05-08', 'RLS حتی بیرون از اپلیکیشن: نقش runtime بدون زمینه ⇒ صفر ردیف', async () => {
      const rt = new Client({ connectionString: RUNTIME_URL });
      await rt.connect();
      try {
        const none = await rt.query('select count(*)::int as n from product_records');
        assert(none.rows[0].n === 0, 'بدون app.tenant_id باید صفر باشد — شد ' + none.rows[0].n);
        await rt.query('begin');
        await rt.query("select set_config('app.tenant_id', $1, true)", [TENANT_B]);
        const asB = await rt.query('select count(*)::int as n from product_records');
        await rt.query('commit');
        assert(asB.rows[0].n === 0, 'مستأجر B هیچ ردیفی ندارد — شد ' + asB.rows[0].n);
        await rt.query('begin');
        await rt.query("select set_config('app.tenant_id', $1, true)", [TENANT_A]);
        const asA = await rt.query('select count(*)::int as n from product_records');
        await rt.query('commit');
        assert(asA.rows[0].n > 0, 'مستأجر A ردیف دارد');
      } finally { await rt.end(); }
      return 'rls=enforced';
    });

    await check('F05-09', 'migration SQLite→PostgreSQL (مستأجر A)', async () => {
      const dbFile = path.join(DATA, 'payesh.sqlite');
      assert(fs.existsSync(dbFile), 'پایگاه‌دادهٔ محصول موجود است');
      const out = spawnSync(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning',
        'scripts/tenancy-migrate-product.js', '--db', dbFile, '--tenant', TENANT_A, '--apply'], {
        cwd: ROOT, env: Object.assign({}, process.env, { PAYESH_TENANCY_ADMIN_URL: ADMIN_URL }), encoding: 'utf8',
      });
      assert(out.status === 0, 'مهاجرت شکست خورد: ' + String(out.stderr || '').slice(0, 300));
      const j = JSON.parse(out.stdout.trim().split('\n').pop());
      assert(j.ok && j.imported >= 1, 'ردیف‌ها منتقل شدند: ' + out.stdout.slice(0, 200));
      return 'imported=' + j.imported;
    });

    await check('F05-10', 'rollback مهاجرت فقط ردیف‌های همان مستأجر را برمی‌گرداند', async () => {
      /* شمارش با نقش مدیر و فیلتر صریح tenant (مدیر RLS را bypass می‌کند، پس فیلتر لازم است) */
      const rt = new Client({ connectionString: ADMIN_URL });
      await rt.connect();
      let beforeB = 0;
      try {
        beforeB = (await rt.query('select count(*)::int as n from product_records where tenant_id = $1', [TENANT_B])).rows[0].n;
      } finally { await rt.end(); }
      const out = spawnSync(process.execPath, ['scripts/tenancy-migrate-product.js', '--tenant', TENANT_A, '--rollback'], {
        cwd: ROOT, env: Object.assign({}, process.env, { PAYESH_TENANCY_ADMIN_URL: ADMIN_URL, PAYESH_TENANCY_CONFIRM: '1' }), encoding: 'utf8',
      });
      assert(out.status === 0, 'rollback شکست خورد: ' + String(out.stderr || '').slice(0, 300));
      const after = new Client({ connectionString: ADMIN_URL });
      await after.connect();
      try {
        const nA = (await after.query('select count(*)::int as n from product_records where tenant_id = $1', [TENANT_A])).rows[0].n;
        const nB = (await after.query('select count(*)::int as n from product_records where tenant_id = $1', [TENANT_B])).rows[0].n;
        assert(nA === 0, 'ردیف‌های A پاک شد — ماند ' + nA);
        assert(nB === beforeB, 'ردیف‌های B دست‌نخورده');
      } finally { await after.end(); }
      return 'rollback=tenant-scoped';
    });

    await check('F05-11', 'بدون توکن ⇒ 401 (دسترسی به بدنهٔ محصول ممکن نیست)', async () => {
      const r = await http(P + '?collection=classes');
      assert(r.status === 401, 'کد پاسخ: ' + r.status);
      return 'unauthorized';
    });

    await check('F05-12', 'توکن دست‌کاری‌شده رد می‌شود (امضا)', async () => {
      const tok = tokenFor(TENANT_A).slice(0, -4) + 'AAAA';
      const r = await http(P + '?collection=classes', { token: tok });
      assert(r.status === 401, 'کد پاسخ: ' + r.status);
      return 'bad_signature';
    });
  } finally {
    try { child.kill('SIGKILL'); } catch (e) { /* noop */ }
    try { await admin.end(); } catch (e) { /* noop */ }
  }

  console.log(`\nF05-PG checks=${passed + failed} pass=${passed} fail=${failed}`);
  if (failed) { console.log('F05-PG-FAIL'); process.exit(1); }
  console.log('F05-PG-OK checks=' + passed);
}

main().catch((e) => { console.error('F05 harness error:', e && e.message); process.exit(1); });
