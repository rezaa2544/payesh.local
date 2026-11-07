'use strict';
/* ═══════════════════════════════════════════════════════════════════
   شاهد CC‑12‑2 — اجرای RLS از «مسیر محصول» روی PostgreSQL واقعی
   تولید: bash docs/cloud/reports/evidence/run-cc12-2-product-rls.sh
   این فایل فقط آزمون را می‌رانَد؛ کدِ آزمون‌شده در `server/tenancy.js` و
   مسیر HTTP محصول (`server/index.js` → `/api/cloud/tenancy/...`) است.

   متغیرهای محیط:
     PGURL_ADMIN     اتصال مدیر (superuser) — فقط برای مهاجرت و بازرسی کاتالوگ
     PGURL_RUNTIME   اتصال نقش runtime (payesh_runtime) — همان نقشی که محصول
                     با آن به پایگاه‌داده وصل می‌شود
     TENANCY_SECRET  کلید امضای توکن نشست
     APP_PORT        پورت سرور محصول
     PAYESH_DATA     پوشهٔ دادهٔ موقت (SQLite محصول)
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../../..');
const tenancy = require(path.join(ROOT, 'server/tenancy.js'));

const ADMIN_URL = process.env.PGURL_ADMIN || '';
const RUNTIME_URL = process.env.PGURL_RUNTIME || '';
const SECRET = process.env.TENANCY_SECRET || '';
const PORT = Number(process.env.APP_PORT || 0);
const DATA = process.env.PAYESH_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-cc122-'));
const TENANT_A = process.env.TENANT_A || '11111111-1111-1111-1111-111111111111';
const TENANT_B = process.env.TENANT_B || '22222222-2222-2222-2222-222222222222';

let passed = 0;
let failed = 0;
function check(id, desc, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => { passed++; console.log(`PASS  ${id}  ${desc}  → ${detail === undefined ? 'ok' : detail}`); })
    .catch((e) => { failed++; console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function http(pathname, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  if (opts.headers) Object.assign(headers, opts.headers);
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}

function tokenFor(tid, over = {}) {
  return tenancy.signToken(Object.assign({
    tid, role: 'manager', uid: `u-${tid.slice(0, 4)}`, did: `d-${tid.slice(0, 4)}`,
    iat: Date.now(), exp: Date.now() + 600000,
  }, over), SECRET);
}

async function waitHealth(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return true;
    } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('product server did not become healthy');
}

(async () => {
  if (!ADMIN_URL || !RUNTIME_URL || !SECRET || !PORT) throw new Error('missing env: PGURL_ADMIN/PGURL_RUNTIME/TENANCY_SECRET/APP_PORT');

  const { Client } = require('pg');
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  /* ۰) مهاجرت با کد محصول (طرح و سیاست‌ها از server/tenancy.js می‌آید) */
  const mig = await tenancy.migrate(admin);
  console.log(`# migrate: table=${mig.table} statements=${mig.statements} server_version=${mig.server_version}`);
  console.log(`# runtime_role=${tenancy.RUNTIME_ROLE} owner_role=${tenancy.OWNER_ROLE}`);
  console.log(`# tenants: A=${TENANT_A} B=${TENANT_B}`);

  /* ۱) سرور محصول با مسیر مستأجرمحور روشن */
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PAYESH_DATA: DATA,
      PAYESH_TENANCY_PG: RUNTIME_URL,
      PAYESH_TENANCY_SECRET: SECRET,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      PAYESH_PUBLIC_URL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (b) => logs.push(String(b)));
  child.stderr.on('data', (b) => logs.push(String(b)));
  let exited = false;
  child.on('exit', () => { exited = true; });

  try {
    await waitHealth();
    console.log('# product server healthy (server/index.js)');

    const tA = tokenFor(TENANT_A);
    const tB = tokenFor(TENANT_B);

    /* ۲) داده‌سازی از مسیر محصول (نه SQL خام) */
    const recA = [];
    const recB = [];
    for (let i = 0; i < 3; i++) {
      const ra = await http('/api/cloud/tenancy/records', { method: 'POST', token: tA, body: { kind: 'student', body: { n: `A${i}` } } });
      assert(ra.status === 201, `A create #${i} status ${ra.status}`);
      recA.push(ra.data.record);
      const rb = await http('/api/cloud/tenancy/records', { method: 'POST', token: tB, body: { kind: 'student', body: { n: `B${i}` } } });
      assert(rb.status === 201, `B create #${i} status ${rb.status}`);
      recB.push(rb.data.record);
    }
    console.log(`# seeded via product HTTP: A=${recA.length} B=${recB.length}`);

    /* ── بازرسی‌های ساختاری ─────────────────────────────────────────── */
    await check('N0', 'مالک جدول ≠ نقش runtime', async () => {
      const q = await admin.query(
        `select pg_get_userbyid(c.relowner) as owner, pg_get_userbyid(c.relowner) = $1 as same
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = $2`, [tenancy.RUNTIME_ROLE, tenancy.TABLE]);
      assert(q.rows.length === 1, 'table not found');
      assert(q.rows[0].same === false, `owner=${q.rows[0].owner}`);
      return `owner=${q.rows[0].owner}`;
    });

    await check('N0b', 'RLS و FORCE RLS روشن + سیاست با app.tenant_id', async () => {
      const q = await admin.query(
        `select c.relrowsecurity, c.relforcerowsecurity,
                (select string_agg(coalesce(p.qual, '') || coalesce(p.with_check, ''), '|')
                   from pg_policies p where p.schemaname='public' and p.tablename=$1) as quals
           from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relname=$1`, [tenancy.TABLE]);
      const r = q.rows[0] || {};
      assert(r.relrowsecurity === true, 'RLS off');
      assert(r.relforcerowsecurity === true, 'FORCE RLS off');
      assert(String(r.quals || '').includes('app.tenant_id'), 'policy does not use app.tenant_id');
      return `rls=on force=on policy_uses=app.tenant_id`;
    });

    /* ── جداسازی از مسیر محصول ───────────────────────────────────────── */
    await check('P1', 'فهرست محصول برای A فقط ردیف‌های A را می‌دهد', async () => {
      const r = await http('/api/cloud/tenancy/records', { token: tA });
      assert(r.status === 200, `status ${r.status}`);
      const ids = r.data.records.map(x => x.id);
      const leaked = ids.filter(id => recB.some(b => b.id === id));
      assert(leaked.length === 0, `leaked ${leaked.length}`);
      assert(ids.length === 3, `n=${ids.length}`);
      return `n=${ids.length} leaked=0`;
    });

    await check('P2', 'شناسهٔ مستأجر دیگر از مسیر محصول ⇒ ۴۰۴', async () => {
      const r = await http(`/api/cloud/tenancy/records/${recB[0].id}`, { token: tA });
      assert(r.status === 404, `status ${r.status}`);
      return 'status=404';
    });

    await check('P3', 'به‌روزرسانی ردیف مستأجر دیگر از مسیر محصول ⇒ ۴۰۴ و بدون تغییر', async () => {
      const r = await http(`/api/cloud/tenancy/records/${recB[0].id}`, { method: 'PATCH', token: tA, body: { body: { n: 'HACKED' } } });
      assert(r.status === 404, `status ${r.status}`);
      const after = await http(`/api/cloud/tenancy/records/${recB[0].id}`, { token: tB });
      assert(after.status === 200 && after.data.record.body.n === 'B0', `body=${JSON.stringify(after.data && after.data.record && after.data.record.body)}`);
      return 'status=404 unchanged=B0';
    });

    await check('P4', 'حذف ردیف مستأجر دیگر از مسیر محصول ⇒ ۴۰۴ و ردیف سالم', async () => {
      const r = await http(`/api/cloud/tenancy/records/${recB[1].id}`, { method: 'DELETE', token: tA });
      assert(r.status === 404, `status ${r.status}`);
      const after = await http('/api/cloud/tenancy/records', { token: tB });
      assert(after.data.records.length === 3, `B n=${after.data.records.length}`);
      return `status=404 B_n=${after.data.records.length}`;
    });

    await check('P5', 'tenant_id در بدنه نادیده گرفته می‌شود (مالکیت از توکن)', async () => {
      const r = await http('/api/cloud/tenancy/records', { method: 'POST', token: tA, body: { kind: 'student', tenant_id: TENANT_B, body: { n: 'A-spoof' } } });
      assert(r.status === 201, `status ${r.status}`);
      const bList = await http('/api/cloud/tenancy/records', { token: tB });
      const inB = bList.data.records.some(x => x.id === r.data.record.id);
      assert(inB === false, 'row landed in tenant B');
      const aList = await http('/api/cloud/tenancy/records', { token: tA });
      assert(aList.data.records.some(x => x.id === r.data.record.id), 'row not in A');
      return `created_in=A not_in_B (A=${aList.data.records.length})`;
    });

    await check('P6', 'هدر X-Tenant نادیده گرفته می‌شود', async () => {
      const r = await http('/api/cloud/tenancy/records', { token: tA, headers: { 'x-tenant': TENANT_B, 'x-tenant-id': TENANT_B } });
      const ids = r.data.records.map(x => x.id);
      assert(ids.length > 0, 'empty');
      const leaked = ids.filter(id => recB.some(b => b.id === id));
      assert(leaked.length === 0, `leaked ${leaked.length}`);
      return `n=${ids.length} leaked=0`;
    });

    await check('P7', 'کوئری‌استرینگ tenant_id/tenant نادیده گرفته می‌شود', async () => {
      const r = await http(`/api/cloud/tenancy/records?tenant_id=${TENANT_B}&tenant=${TENANT_B}`, { token: tA });
      const ids = r.data.records.map(x => x.id);
      const leaked = ids.filter(id => recB.some(b => b.id === id));
      assert(leaked.length === 0, `leaked ${leaked.length}`);
      return `n=${ids.length} leaked=0`;
    });

    /* ── احراز هویت مسیر ─────────────────────────────────────────────── */
    await check('P8', 'بدون توکن ⇒ ۴۰۱', async () => {
      const r = await http('/api/cloud/tenancy/records');
      assert(r.status === 401, `status ${r.status}`);
      return 'status=401';
    });

    await check('P9', 'توکن با امضای جعلی ⇒ ۴۰۱', async () => {
      const good = tokenFor(TENANT_A);
      const parts = good.split('.');
      const forged = tenancy.signToken({ tid: TENANT_B, role: 'manager', exp: Date.now() + 600000 }, 'wrong-secret-wrong-secret');
      const r1 = await http('/api/cloud/tenancy/records', { token: forged });
      const r2 = await http('/api/cloud/tenancy/records', { token: `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}AA` });
      assert(r1.status === 401 && r2.status === 401, `forged=${r1.status} tampered=${r2.status}`);
      return `forged=401 tampered=401`;
    });

    await check('P10', 'توکن منقضی ⇒ ۴۰۱', async () => {
      const r = await http('/api/cloud/tenancy/records', { token: tokenFor(TENANT_A, { exp: Date.now() - 1000 }) });
      assert(r.status === 401, `status ${r.status}`);
      return 'status=401';
    });

    await check('P11', 'توکن با tid نامعتبر ⇒ ۴۰۱', async () => {
      const r = await http('/api/cloud/tenancy/records', { token: tokenFor('not-a-uuid') });
      assert(r.status === 401, `status ${r.status}`);
      return 'status=401';
    });

    await check('P16', 'شناسهٔ نامعتبر در مسیر ⇒ ۴۰۴', async () => {
      const r = await http('/api/cloud/tenancy/records/not-a-uuid', { token: tA });
      assert(r.status === 404, `status ${r.status}`);
      return 'status=404';
    });

    /* ── RLS در لایهٔ داده (نه فیلتر اپلیکیشن) ───────────────────────── */
    const pool = tenancy.createPool({ connectionString: RUNTIME_URL, max: 4 });

    await check('P12', 'بدون زمینهٔ مستأجر روی نقش runtime ⇒ صفر ردیف (fail-closed)', async () => {
      const c = await pool.connect();
      try {
        const q = await c.query(`select count(*)::int as n from ${tenancy.TABLE}`);
        assert(q.rows[0].n === 0, `n=${q.rows[0].n}`);
        return 'n=0';
      } finally { c.release(); }
    });

    await check('P13', 'زمینهٔ A + پرس‌وجوی صریح ردیف B ⇒ صفر ردیف', async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query("select set_config('app.tenant_id', $1, true)", [TENANT_A]);
        const q = await c.query(`select count(*)::int as n from ${tenancy.TABLE} where tenant_id = $1`, [TENANT_B]);
        const own = await c.query(`select count(*)::int as n from ${tenancy.TABLE}`);
        await c.query('COMMIT');
        assert(q.rows[0].n === 0, `other=${q.rows[0].n}`);
        assert(own.rows[0].n > 0, 'own rows not visible');
        return `other=0 own=${own.rows[0].n}`;
      } finally { c.release(); }
    });

    await check('P14', 'نقش runtime نه superuser است نه BYPASSRLS و نمی‌تواند SET ROLE مالک', async () => {
      const c = await pool.connect();
      try {
        const r = await c.query('select rolsuper, rolbypassrls from pg_roles where rolname = current_user');
        assert(r.rows[0].rolsuper === false, 'superuser');
        assert(r.rows[0].rolbypassrls === false, 'bypassrls');
        let denied = false;
        try { await c.query(`set role ${tenancy.OWNER_ROLE}`); } catch (e) { denied = /permission denied/i.test(e.message); }
        assert(denied, 'SET ROLE owner was allowed');
        return 'super=false bypass=false set_role=denied';
      } finally { c.release(); }
    });

    await check('P15', 'FORCE RLS: مالک جدول هم با زمینهٔ A فقط ردیف‌های A را می‌بیند', async () => {
      await admin.query(`set role ${tenancy.OWNER_ROLE}`);
      try {
        await admin.query('BEGIN');
        await admin.query("select set_config('app.tenant_id', $1, true)", [TENANT_A]);
        const q = await admin.query(`select count(*)::int as n, count(distinct tenant_id)::int as t from ${tenancy.TABLE}`);
        await admin.query('COMMIT');
        assert(q.rows[0].t === 1, `tenants=${q.rows[0].t}`);
        return `rows=${q.rows[0].n} tenants=${q.rows[0].t}`;
      } finally { await admin.query('RESET ROLE'); }
    });

    await check('P17', '۴۰ درخواست متناوب A/B روی استخر مشترک ⇒ بدون نشت زمینه', async () => {
      for (let i = 0; i < 20; i++) {
        const a = await http('/api/cloud/tenancy/records', { token: tA });
        const b = await http('/api/cloud/tenancy/records', { token: tB });
        assert(a.data.records.every(x => !recB.some(y => y.id === x.id)), 'A saw B row');
        assert(b.data.records.every(x => !recA.some(y => y.id === x.id)), 'B saw A row');
      }
      const bFinal = await http('/api/cloud/tenancy/records', { token: tB });
      assert(bFinal.data.records.length === 3, `B n=${bFinal.data.records.length}`);
      return 'mixed=40 leaks=0';
    });

    await check('P18', 'کد مسیر محصول همان فایل‌های مخزن است (هش)', async () => {
      const h = crypto.createHash('sha256');
      h.update(fs.readFileSync(path.join(ROOT, 'server/tenancy.js')));
      const hIndex = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'server/index.js'))).digest('hex');
      const r = await http('/api/cloud/tenancy/records', { token: tA });
      assert(r.status === 200, `route not served by product (status ${r.status})`);
      assert(/payesh-cloud-tenancy|cloud\/tenancy/.test(fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8')), 'route not mounted in server/index.js');
      return `server/tenancy.js sha256=${h.digest('hex').slice(0, 12)} server/index.js sha256=${hIndex.slice(0, 12)}`;
    });

    await pool.end();
  } finally {
    if (!exited) { child.kill('SIGTERM'); await new Promise(r => setTimeout(r, 300)); if (!exited) child.kill('SIGKILL'); }
    await admin.end().catch(() => {});
    if (failed > 0 || passed === 0) console.log('# server log tail:\n' + logs.join('').split('\n').slice(-15).join('\n'));
  }

  console.log('');
  console.log(`TOTAL ${passed + failed} · FAIL ${failed}`);
  process.exit(failed === 0 && passed > 0 ? 0 : 1);
})().catch(async (e) => {
  console.log(`FATAL  ${String((e && e.message) || e)}`);
  console.log(`TOTAL ${passed + failed} · FAIL ${failed + 1}`);
  process.exit(1);
});
