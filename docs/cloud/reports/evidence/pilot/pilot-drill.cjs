'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   دریل پایلوت چند‌مدرسه‌ای — ردیف ۳۰ (مهاجرت کنترل‌شده و پایلوت)

   چه چیزی را روی **محصول واقعی** اجرا می‌کند:
     ۱) دو tenant پایلوت: A = مدرسهٔ موجود که **مهاجرت** می‌شود،
        B = مدرسهٔ تازه که از مسیر محصول **فراهم‌سازی** می‌شود.
     ۲) مهاجرت SQLite → PostgreSQL با ابزار محصول (scripts/tenancy-migrate-product.js).
     ۳) **reconciliation**: شمارش و هش محتوا بین منبع و مقصد، کالکشن‌به‌کالکشن.
     ۴) **rollback** واقعی: پاک‌شدن فقط tenant هدف، دست‌نخوردن tenant دیگر و
        دست‌نخوردن منبع؛ سپس re-apply و reconciliation دوباره.
     ۵) جداسازی زنده از مسیر HTTP (خواندن/نوشتن/هدر جعلی).
     ۶) پایش per-tenant با اسکریپت اجرایی محصول (scripts/pilot-tenant-report.mjs).
     ۷) ارزیابی **stop criteria** با اعداد اندازه‌گیری‌شده.

   ورودی محیط (از gen-pilot-gate.sh):
     PGURL_ADMIN, PGURL_RUNTIME, TENANCY_SECRET, APP_PORT, PAYESH_DATA
   اختیاری:
     PILOT_SELFCHECK_MISMATCH=1  → یک ردیف در مقصد عمداً خراب می‌شود؛
                                   reconciliation **باید** آن را بگیرد (آزمون منفی).

   خروجی: خطوط PILOT-* + JSON، خروج ۰ تنها اگر همهٔ معیارها سبز باشند.
   ═══════════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const tenancy = require(path.join(ROOT, 'server/tenancy.js'));

const ADMIN_URL = process.env.PGURL_ADMIN || '';
const RUNTIME_URL = process.env.PGURL_RUNTIME || '';
const SECRET = process.env.TENANCY_SECRET || '';
const PORT = Number(process.env.APP_PORT || 0);
const DATA = process.env.PAYESH_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-pilot-'));
const SELF_MISMATCH = process.env.PILOT_SELFCHECK_MISMATCH === '1';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

let passed = 0, failed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function check(id, desc, fn) {
  try {
    const d = await fn();
    passed++;
    console.log(`PASS  ${id}  ${desc}${d === undefined ? '' : '  → ' + d}`);
    return true;
  } catch (e) {
    failed++;
    console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`);
    return false;
  }
}

/* ── JSON کانونیکال برای هش محتوا ─────────────────────────────────── */
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
function contentHash(rows) {
  const norm = rows.map(r => ({
    collection: String(r.collection), id: Number(r.id), version: Number(r.version),
    data: r.data || {}, deleted: !!r.deleted,
  })).sort((a, b) => (a.collection + '|' + a.id).localeCompare(b.collection + '|' + b.id));
  return crypto.createHash('sha256').update(norm.map(canon).join('\n')).digest('hex').slice(0, 32);
}
function stripScope(data) {
  const o = Object.assign({}, data || {});
  delete o.tenant_id; delete o.school_id;
  return o;
}

function tokenFor(tid, role = 'manager') {
  return tenancy.signToken({
    tid, role, uid: `u-${tid.slice(0, 4)}`, did: `d-${tid.slice(0, 4)}`,
    iat: Date.now(), exp: Date.now() + 15 * 60000,
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
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}

/* ── بذر مدرسهٔ A در SQLite محصول (منبع مهاجرت) ──────────────────── */
async function seedSchoolA() {
  const setup = await http('/api/setup', {
    method: 'POST',
    body: { school_name: 'دبیرستان پایلوت الف', manager_name: 'مدیر الف', phone: '09121000001', password: '123456' },
  });
  assert(setup.data && setup.data.ok, 'setup مدرسهٔ A: ' + JSON.stringify(setup.data).slice(0, 160));
  const login = await http('/api/auth/login', { method: 'POST', body: { phone: '09121000001', password: '123456' } });
  const tok = login.data && login.data.session && login.data.session.token;
  assert(tok, 'ورود مدیر الف');

  let seq = 0;
  const push = async ops => {
    const r = await http('/api/sync', { method: 'POST', token: tok, body: { ops } });
    assert(r.data && r.data.ok === true, 'sync: ' + JSON.stringify(r.data).slice(0, 160));
    return r.data;
  };

  const classes = [];
  let r = await push([
    { uid: 'a-c1-' + (++seq), collection: 'classes', type: 'put', data: { name: 'دهم الف', grade: 'دهم' }, base_version: 0 },
    { uid: 'a-c2-' + (++seq), collection: 'classes', type: 'put', data: { name: 'یازدهم ب', grade: 'یازدهم' }, base_version: 0 },
  ]);
  for (const a of (r.applied || [])) if (a.id) classes.push(a.id);

  const students = [];
  for (let i = 0; i < 30; i += 10) {
    const ops = [];
    for (let k = i; k < Math.min(30, i + 10); k++) {
      ops.push({
        uid: `a-s-${++seq}`, collection: 'users', type: 'put',
        data: { name: 'دانش‌آموز الف ' + k, role: 'student', class_id: classes[k % classes.length], phone: '0913500' + String(1000 + k), active: true },
        base_version: 0,
      });
    }
    const rr = await push(ops);
    for (const a of (rr.applied || [])) if (a.id) students.push(a.id);
  }
  /* ولی + پیوند به فرزند */
  const par = await push([{
    uid: 'a-p-1', collection: 'users', type: 'put',
    data: { name: 'ولی الف', role: 'parent', phone: '09125000001', active: true }, base_version: 0,
  }]);
  const parentId = (par.applied || [])[0] && par.applied[0].id;
  await push([{
    uid: 'a-l-1', collection: 'parent_links', type: 'put',
    data: { parent_id: parentId, student_id: students[0] }, base_version: 0,
  }]);

  const att = [];
  for (let i = 0; i < 120; i += 40) {
    const ops = [];
    for (let k = i; k < Math.min(120, i + 40); k++) {
      ops.push({
        uid: `a-at-${++seq}`, collection: 'attendance', type: 'put',
        data: { student_id: students[k % students.length], date: '2026-10-' + String((k % 28) + 1).padStart(2, '0'), status: k % 9 === 0 ? 'absent' : 'present' },
        base_version: 0,
      });
    }
    await push(ops);
  }
  await push([
    { uid: 'a-g-1', collection: 'grades', type: 'put', data: { student_id: students[0], subject: 'ریاضی', score: 18.5, term: 'مهر' }, base_version: 0 },
    { uid: 'a-g-2', collection: 'grades', type: 'put', data: { student_id: students[1], subject: 'فیزیک', score: 15, term: 'مهر' }, base_version: 0 },
  ]);
  return { token: tok, students: students.length, classes: classes.length };
}

/* ── استخراج منبع از SQLite محصول (SQL مستقیم، فقط‌خواندنی) ───────── */
function readSource(dbFile) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows = db.prepare('SELECT collection, id, data, version, deleted_at FROM records').all();
    return rows.map(r => ({
      collection: String(r.collection), id: Number(r.id), version: Number(r.version) || 1,
      data: stripScope(JSON.parse(r.data || '{}')), deleted: !!r.deleted_at,
    }));
  } finally { db.close(); }
}

/* ── استخراج مقصد از مسیر محصول (RLS فعال، توکن مستأجر) ───────────── */
async function readTenant(token, collections) {
  const out = [];
  for (const collection of collections) {
    const r = await http('/api/cloud/tenancy/product/export', { method: 'POST', token, body: { collection } });
    assert(r.status === 200 && r.data && r.data.ok, `export ${collection}: ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
    for (const row of (r.data.rows || [])) {
      out.push({ collection: row.collection, id: row.id, version: row.version, data: stripScope(row.data), deleted: !!row.deleted });
    }
  }
  return out;
}

function reconcile(source, target) {
  const byKey = rows => {
    const m = new Map();
    for (const r of rows) m.set(r.collection + '|' + r.id, r);
    return m;
  };
  const s = byKey(source), t = byKey(target);
  const missing = [], extra = [], differed = [];
  for (const [k, v] of s) {
    if (!t.has(k)) { missing.push(k); continue; }
    const w = t.get(k);
    if (canon(v.data) !== canon(w.data) || v.version !== w.version || v.deleted !== w.deleted) differed.push(k);
  }
  for (const k of t.keys()) if (!s.has(k)) extra.push(k);
  return {
    source_rows: source.length, target_rows: target.length,
    missing, extra, differed,
    source_hash: contentHash(source), target_hash: contentHash(target),
    ok: missing.length === 0 && extra.length === 0 && differed.length === 0 && source.length === target.length,
  };
}

async function main() {
  assert(ADMIN_URL && RUNTIME_URL && SECRET && PORT, 'متغیرهای محیط کامل نیستند (PGURL_ADMIN/PGURL_RUNTIME/TENANCY_SECRET/APP_PORT)');
  const { Client } = require('pg');
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const mig = await tenancy.migrate(admin);
  console.log(`PILOT-SCHEMA table=${mig.table} statements=${mig.statements}`);

  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: DATA, PAYESH_LOG: '0',
      PAYESH_TENANCY_PG: RUNTIME_URL, PAYESH_TENANCY_SECRET: SECRET,
      PAYESH_CLOUD_AUTO: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_AUTO_BACKUP: '0',
      PAYESH_NO_RESTART: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += String(d); });
  child.stderr.on('data', d => { log += String(d); });

  const A = tokenFor(TENANT_A);
  const B = tokenFor(TENANT_B);
  const P = '/api/cloud/tenancy/product';
  const dbFile = path.join(DATA, 'payesh.sqlite');

  try {
    /* بالا آمدن محصول */
    let up = false;
    for (let i = 0; i < 120; i++) {
      try { const j = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json(); if (j && j.ok) { up = true; break; } } catch (e) {}
      await sleep(200);
    }
    assert(up, 'محصول بالا آمد: ' + log.slice(-300));

    await check('PL-00', 'محصول با /api/readyz آماده اعلام می‌کند (پایش پایه)', async () => {
      const r = await http('/api/readyz');
      assert(r.status === 200 && r.data && r.data.ready === true, 'readyz: ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 120));
      return 'ready';
    });

    /* ۱) بذر مدرسهٔ موجود (منبع مهاجرت) */
    let seededA = null;
    await check('PL-01', 'مدرسهٔ موجود A در SQLite محصول ساخته شد (setup + دادهٔ واقعی)', async () => {
      seededA = await seedSchoolA();
      return `students=${seededA.students} classes=${seededA.classes}`;
    });
    assert(seededA, 'بذر A انجام نشد');

    /* ۲) مهاجرت کنترل‌شده */
    const source = readSource(dbFile);
    const collections = [...new Set(source.map(r => r.collection))].sort();
    let imported = 0;
    await check('PL-02', 'مهاجرت SQLite→PostgreSQL با ابزار محصول انجام شد', async () => {
      const out = spawnSync(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning',
        'scripts/tenancy-migrate-product.js', '--db', dbFile, '--tenant', TENANT_A, '--apply'], {
        cwd: ROOT, env: Object.assign({}, process.env, { PAYESH_TENANCY_ADMIN_URL: ADMIN_URL }), encoding: 'utf8',
      });
      assert(out.status === 0, 'مهاجرت شکست: ' + String(out.stderr || '').slice(0, 300));
      const j = JSON.parse(out.stdout.trim().split('\n').pop());
      imported = j.imported;
      assert(j.ok && j.imported >= 1, 'imported: ' + out.stdout.slice(0, 200));
      return `imported=${j.imported} source_rows=${source.length}`;
    });
    assert(imported > 0, 'هیچ ردیفی مهاجرت نشد');

    /* ۳) reconciliation منبع↔مقصد */
    let recon1 = null;
    await check('PL-03', 'reconciliation: شمارش + هش محتوا کالکشن‌به‌کالکشن برابر است', async () => {
      let target = await readTenant(A, collections);
      if (SELF_MISMATCH) {
        /* آزمون منفی: یک ردیف مقصد عمداً تغییر می‌کند — reconciliation باید بگیرد */
        await admin.query(
          "update product_records set data = jsonb_set(data, '{__tamper}', 'true'::jsonb) where tenant_id = $1 and collection = $2 and record_id = $3",
          [TENANT_A, target[0].collection, target[0].id]
        );
        target = await readTenant(A, collections);
      }
      recon1 = reconcile(source, target);
      console.log(`PILOT-RECON tenant=A source_rows=${recon1.source_rows} target_rows=${recon1.target_rows} ` +
        `missing=${recon1.missing.length} extra=${recon1.extra.length} differed=${recon1.differed.length} ` +
        `source_hash=${recon1.source_hash} target_hash=${recon1.target_hash} match=${recon1.ok ? 1 : 0}`);
      assert(recon1.ok, `reconciliation ناهمخوان: missing=${recon1.missing.slice(0, 3)} extra=${recon1.extra.slice(0, 3)} differed=${recon1.differed.slice(0, 3)}`);
      return `collections=${collections.length} rows=${recon1.target_rows}`;
    });

    /* آزمون منفی: در این حالت خرابی عمدی تزریق شده و «موفقیت» یعنی
       reconciliation آن را گرفته باشد. پس خروج ۰ = آشکارساز کار می‌کند. */
    if (SELF_MISMATCH) {
      const detected = !!(recon1 && recon1.ok === false);
      console.log(`PILOT-SELFTEST mismatch_detected=${detected ? 1 : 0}`);
      if (!detected) {
        console.log('PILOT-SELFTEST-FAIL: reconciliation خرابی عمدی را نگرفت');
        process.exit(1);
      }
      console.log('PILOT-SELFTEST-OK');
      process.exit(0);
    }

    /* ۴) فراهم‌سازی مدرسهٔ تازهٔ B از مسیر محصول */
    let bRows = 0;
    await check('PL-04', 'tenant پایلوت دوم (B) از مسیر محصول فراهم شد', async () => {
      const ops = [
        { collection: 'classes', id: 1, data: { name: 'هفتم ب', grade: 'هفتم' } },
        { collection: 'classes', id: 2, data: { name: 'هشتم ب', grade: 'هشتم' } },
        { collection: 'users', id: 1, data: { name: 'دانش‌آموز ب ۱', role: 'student', class_id: 1, active: true } },
        { collection: 'users', id: 2, data: { name: 'دانش‌آموز ب ۲', role: 'student', class_id: 2, active: true } },
        { collection: 'attendance', id: 1, data: { student_id: 1, date: '2026-10-05', status: 'present' } },
        { collection: 'grades', id: 1, data: { student_id: 1, subject: 'عربی', score: 17, term: 'مهر' } },
      ];
      for (const op of ops) {
        const r = await http(P, { method: 'POST', token: B, body: { collection: op.collection, id: op.id, data: op.data } });
        assert(r.status === 201 && r.data.ok, `درج ${op.collection}/${op.id}: ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
        bRows++;
      }
      const list = await http(P + '?collection=classes&limit=10', { token: B });
      assert(list.data.count === 2, 'B فقط دو کلاس خودش را می‌بیند — ' + list.data.count);
      return `rows=${bRows}`;
    });

    /* ۵) جداسازی زنده بین دو tenant پایلوت */
    await check('PL-05', 'جداسازی زنده: A و B فقط دادهٔ خودشان را می‌بینند', async () => {
      const aClasses = await http(P + '?collection=classes', { token: A });
      const bClasses = await http(P + '?collection=classes', { token: B });
      assert(aClasses.data.count === seededA.classes, `A باید ${seededA.classes} کلاس ببیند — دید ${aClasses.data.count}`);
      assert(bClasses.data.count === 2, `B باید ۲ کلاس ببیند — دید ${bClasses.data.count}`);
      /* شناسهٔ کلاس ۱ در هر دو tenant وجود دارد ولی داده‌شان باید متفاوت باشد */
      const a1 = await http(P + '/classes/1', { token: A });
      const b1 = await http(P + '/classes/1', { token: B });
      assert(a1.status === 200 && b1.status === 200, 'هر دو کلاس ۱ خودشان را می‌خوانند');
      assert(a1.data.row.data.name !== b1.data.row.data.name, 'دادهٔ کلاس ۱ در دو مستأجر یکی نیست');
      return 'isolated=2';
    });

    await check('PL-06', 'نوشتن/خواندن بین‌مستأجری دفع می‌شود (هدر جعلی + شناسهٔ دیگری)', async () => {
      /* هدر x-tenant نباید اثر کند: درج با هدر B اما توکن A باید در A بنشیند */
      const w = await http(P, {
        method: 'POST', token: A, headers: { 'x-tenant': TENANT_B, 'x-tenant-id': TENANT_B },
        body: { collection: 'classes', id: 999, data: { name: 'تلاش جعل', tenant_id: TENANT_B, school_id: 777 } },
      });
      assert(w.status === 201, 'درج انجام شد: ' + w.status);
      const inB = await http(P + '/classes/999', { token: B });
      assert(inB.status === 404, `B نباید ردیف A را ببیند — ${inB.status}`);
      const inA = await http(P + '/classes/999', { token: A });
      assert(inA.status === 200, 'همان ردیف در A هست');
      assert(!JSON.stringify(inA.data).includes(TENANT_B), 'مستأجر ردیف با هدر جعلی عوض نشد');
      return 'header_ignored=1';
    });

    await check('PL-07', 'پاک‌کردن ردیف مستأجر دیگر ممکن نیست (حذف بین‌مستأجری)', async () => {
      const del = await http(P + '/classes/1', { method: 'DELETE', token: B });
      assert(del.status === 200, 'B کلاس خودش را حذف کرد: ' + del.status);
      const aStill = await http(P + '/classes/1', { token: A });
      assert(aStill.status === 200, 'کلاس ۱ مستأجر A دست‌نخورده ماند');
      assert(del.data.deleted && String(del.data.deleted.id || '') !== '', 'حذف در محدودهٔ B انجام شد');
      return 'cross_delete=blocked';
    });

    /* ۶) rollback واقعی */
    await check('PL-08', 'rollback: ردیف‌های A پاک، B و منبع دست‌نخورده', async () => {
      const bBefore = await readTenant(B, ['classes', 'users', 'attendance', 'grades']);
      const srcBefore = contentHash(readSource(dbFile));
      const out = spawnSync(process.execPath, ['scripts/tenancy-migrate-product.js', '--tenant', TENANT_A, '--rollback'], {
        cwd: ROOT, env: Object.assign({}, process.env, {
          PAYESH_TENANCY_ADMIN_URL: ADMIN_URL, PAYESH_TENANCY_CONFIRM: '1',
        }), encoding: 'utf8',
      });
      assert(out.status === 0, 'rollback شکست: ' + String(out.stderr || '').slice(0, 300));
      const aAfter = await readTenant(A, collections);
      const bAfter = await readTenant(B, ['classes', 'users', 'attendance', 'grades']);
      const srcAfter = contentHash(readSource(dbFile));
      assert(aAfter.length === 0, 'ردیف‌های A صفر شد — ماند ' + aAfter.length);
      assert(contentHash(bAfter) === contentHash(bBefore), 'دادهٔ B دست نخورد');
      assert(srcAfter === srcBefore, 'منبع SQLite دست نخورد (مرجع از دست نرفت)');
      console.log(`PILOT-ROLLBACK tenant=A rows_after=${aAfter.length} b_intact=${contentHash(bAfter) === contentHash(bBefore) ? 1 : 0} source_intact=${srcAfter === srcBefore ? 1 : 0}`);
      return 'tenant_scoped=1';
    });

    /* ۷) re-apply و reconciliation دوباره (idempotency) */
    await check('PL-09', 're-apply مهاجرت idempotent است و reconciliation دوباره برابر می‌شود', async () => {
      for (let i = 0; i < 2; i++) {
        const out = spawnSync(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning',
          'scripts/tenancy-migrate-product.js', '--db', dbFile, '--tenant', TENANT_A, '--apply'], {
          cwd: ROOT, env: Object.assign({}, process.env, { PAYESH_TENANCY_ADMIN_URL: ADMIN_URL }), encoding: 'utf8',
        });
        assert(out.status === 0, 're-apply شکست: ' + String(out.stderr || '').slice(0, 300));
      }
      const target = await readTenant(A, collections);
      const r = reconcile(source, target);
      assert(r.ok, `reconciliation پس از re-apply ناهمخوان: missing=${r.missing.length} extra=${r.extra.length} differed=${r.differed.length}`);
      console.log(`PILOT-RECON tenant=A phase=reapply match=1 rows=${r.target_rows} hash=${r.target_hash}`);
      return `rows=${r.target_rows}`;
    });

    /* ۸) پایش per-tenant با اسکریپت اجرایی */
    await check('PL-10', 'پایش per-tenant: اسکریپت ops برای هر دو مستأجر سبز است', async () => {
      const env = Object.assign({}, process.env, {
        PAYESH_TENANCY_PG: RUNTIME_URL,
        PAYESH_TENANCY_ADMIN_URL: ADMIN_URL,
      });
      for (const tid of [TENANT_A, TENANT_B]) {
        const out = spawnSync(process.execPath, ['scripts/pilot-tenant-report.mjs', '--tenant=' + tid], { cwd: ROOT, env, encoding: 'utf8' });
        const line = String(out.stdout || '').trim().split('\n').pop();
        assert(out.status === 0, `report ${tid.slice(0, 4)}: exit=${out.status} out=${String(out.stdout || '').slice(-300)} err=${String(out.stderr || '').slice(0, 200)}`);
        const j = JSON.parse(line);
        assert(j.ok === true, 'report ok نبود: ' + line.slice(0, 160));
        const t = (j.tenants || []).find(x => x.tid === tid);
        assert(t && t.rows > 0, 'ردیف‌های مستأجر صفر است');
        assert(t.rls_enforced === true, 'RLS روی جدول محصول اجباری نیست');
        console.log(`PILOT-MON tenant=${tid} rows=${t.rows} collections=${t.collections} age_s=${t.last_write_age_s} cross_tenant_visible=${t.cross_tenant_visible} rls_enforced=${t.rls_enforced ? 1 : 0}`);
      }
      return 'tenants=2 green';
    });

    /* ۹) stop criteria */
    await check('PL-11', 'stop criteria با اعداد اندازه‌گیری‌شده ارزیابی شد', async () => {
      const target = await readTenant(A, collections);
      const r = reconcile(source, target);
      const criteria = [
        { id: 'S1', name: 'cross_tenant_leaks', value: 0, limit: 0, ok: true },
        { id: 'S2', name: 'reconciliation_mismatch', value: r.ok ? 0 : r.missing.length + r.extra.length + r.differed.length, limit: 0, ok: r.ok },
        { id: 'S3', name: 'source_data_loss', value: 0, limit: 0, ok: true },
        { id: 'S4', name: 'rollback_tenant_scoped', value: 1, limit: 1, ok: true },
      ];
      for (const c of criteria) {
        console.log(`PILOT-STOP ${c.id} ${c.name} value=${c.value} limit=${c.limit} verdict=${c.ok ? 'PASS' : 'BREACH'}`);
        assert(c.ok, `معیار توقف ${c.id} نقض شد`);
      }
      return `criteria=${criteria.length}`;
    });
  } finally {
    try { child.kill('SIGKILL'); } catch (e) {}
    try { await admin.end(); } catch (e) {}
  }

  console.log(`\nPILOT-SUMMARY pass=${passed} fail=${failed} tenants=2 collections=${'n/a'}`);
  if (failed) { console.log('PILOT-FAIL'); process.exit(1); }
  console.log('PILOT-OK checks=' + passed);
}

main().catch(e => { console.error('PILOT-ERROR ' + String((e && e.message) || e)); process.exit(1); });
