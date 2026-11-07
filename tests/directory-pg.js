'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون دایرکتوری مرکزی و مسیردهی مدرسه→cell — ردیف ۴۳  (DR-01 .. DR-16)

   سه چیز سنجیده می‌شود:
     ۱) جدول مسیردهی و کش TTL (شامل stale هنگام قطع دایرکتوری تا N دقیقه)
     ۲) توکن نشست حاوی cell و اتصال سخت Gateway به cell خودش
     ۳) شروع با یک cell و بدون تغییر رفتار (GW_CELL تنظیم‌نشده)

   پیش‌نیاز: DIR_URL, CELL1_URL, CELL2_URL, CELL1_RUNTIME, CELL2_RUNTIME,
   TENANCY_SECRET, GW1_PORT (cell1), GW2_PORT (cell2), GW3_PORT (legacy)
   نبودِ PostgreSQL ⇒ exit 3 با برچسب BLOCKED (نه PASS).
   ═══════════════════════════════════════════════════════════════════ */
const tenancy = require('../server/tenancy');
const directory = require('../server/directory');

const DIR_URL = process.env.DIR_URL || '';
const C1_URL = process.env.CELL1_URL || '';
const C2_URL = process.env.CELL2_URL || '';
const C1_RT = process.env.CELL1_RUNTIME || '';
const C2_RT = process.env.CELL2_RUNTIME || '';
const SECRET = process.env.TENANCY_SECRET || '';
const GW1 = Number(process.env.GW1_PORT || 5661);
const GW2 = Number(process.env.GW2_PORT || 5662);
const GW3 = Number(process.env.GW3_PORT || 5663);

if (!DIR_URL || !C1_URL || !C2_URL || !C1_RT || !C2_RT || SECRET.length < 16) {
  console.log('BLOCKED — ENVIRONMENT UNAVAILABLE (need DIR_URL, CELL1/2_URL, CELL1/2_RUNTIME, TENANCY_SECRET)');
  process.exit(3);
}

const CELL1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CELL2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

let passed = 0, failed = 0; const failures = [];
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 300)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function call(port, path, { method = 'GET', token = null, body = null } = {}) {
  const h = { 'content-type': 'application/json', 'x-device-id': 'dev-' + Math.random().toString(36).slice(2, 8) };
  if (token) h.authorization = 'Bearer ' + token;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* noop */ }
  return { status: res.status, body: json, text };
}

(async () => {
  const { Client, Pool } = require('pg');
  const dir = new Client({ connectionString: DIR_URL });
  await dir.connect();
  const c1 = new Client({ connectionString: C1_URL });
  await c1.connect();
  const c2 = new Client({ connectionString: C2_URL });
  await c2.connect();

  const pool1 = tenancy.createPool({ connectionString: C1_RT });
  const pool2 = tenancy.createPool({ connectionString: C2_RT });

  await check('DR-01', 'مهاجرت دیتابیس مرکزی: جدول cell و جدول مسیر', async () => {
    const m = await directory.migrate(dir);
    const q = await dir.query(`select table_name from information_schema.tables where table_name in ($1,$2) order by table_name`, [directory.CELLS_TABLE, directory.ROUTES_TABLE]);
    assert(q.rows.length === 2, `tables=${q.rows.length}`);
    return `statements=${m.statements} tables=${q.rows.map(r => r.table_name).join(',')}`;
  });

  await check('DR-02', 'دو cell ثبت می‌شوند و هر مدرسه به یک cell مسیر می‌گیرد', async () => {
    await directory.upsertCell(dir, { cellId: CELL1, name: 'cell-1' });
    await directory.upsertCell(dir, { cellId: CELL2, name: 'cell-2' });
    await directory.upsertRoute(dir, { schoolCode: 'school-a', cellId: CELL1 });
    await directory.upsertRoute(dir, { schoolCode: 'School-B', cellId: CELL2 }); /* نرمال‌سازی حروف */
    const res = directory.createResolver(dir);
    const a = await res.resolve('school-a');
    const b = await res.resolve('school-b');
    assert(a && a.cell_id === CELL1, 'school-a route wrong');
    assert(b && b.cell_id === CELL2, 'school-b route wrong');
    return `a=${a.cell_id.slice(-2)} b=${b.cell_id.slice(-2)} misses=${res.stats().misses}`;
  });

  await check('DR-03', 'کش مسیر با TTL: درخواست دوم بدون کوئری', async () => {
    const res = directory.createResolver(dir, { ttlSec: 30 });
    await res.resolve('school-a');
    const m1 = res.stats().misses;
    await res.resolve('school-a');
    const st = res.stats();
    assert(m1 === 1 && st.hits === 1 && st.misses === 1, `hits=${st.hits} misses=${st.misses}`);
    return `ttl=30s hits=${st.hits} misses=${st.misses} cache=${res.cacheSize()}`;
  });

  await check('DR-04', 'مدرسهٔ ناشناس ⇒ null (ورود ۴۰۴)، کد بدشکل ⇒ خطای ۴۰۰', async () => {
    const res = directory.createResolver(dir);
    const none = await res.resolve('school-zzz');
    assert(none === null, 'unknown school resolved');
    let code = null;
    try { await res.resolve('bad code!!'); } catch (e) { code = `${e.code}/${e.status}`; }
    assert(code === 'bad_school_code/400', `bad code error: ${code}`);
    return `unknown=null bad=${code}`;
  });

  await check('DR-05', 'ورود برای school-a توکنِ حاوی cell می‌دهد', async () => {
    const res = directory.createResolver(dir);
    const s = await directory.issueSession(res, {
      schoolCode: 'school-a', uid: 7, role: 'manager', tenantId: TENANT_A, secret: SECRET,
    });
    const claims = tenancy.verifyToken(s.token, SECRET);
    assert(claims.cell === CELL1, `cell claim=${claims.cell}`);
    assert(claims.tid === TENANT_A, 'tenant claim wrong');
    return `cell=${claims.cell.slice(-2)} tid_ok=yes role=${claims.role}`;
  });

  const resMain = directory.createResolver(dir);
  const sesA = await directory.issueSession(resMain, { schoolCode: 'school-a', uid: 7, role: 'manager', tenantId: TENANT_A, secret: SECRET });
  const sesB = await directory.issueSession(resMain, { schoolCode: 'school-b', uid: 8, role: 'manager', tenantId: TENANT_B, secret: SECRET });
  const legacyToken = tenancy.signToken({ tid: TENANT_A, role: 'manager', uid: 7, iat: Date.now(), exp: Date.now() + 600000 }, SECRET);

  await check('DR-06', 'Gateway cell1 توکن cell1 را می‌پذیرد و cell را در healthz می‌گوید', async () => {
    const h = await call(GW1, '/healthz');
    assert(h.status === 200 && h.body.cell === CELL1, `healthz cell=${h.body && h.body.cell}`);
    const r = await call(GW1, '/api/gw/v1/pull?limit=5', { token: sesA.token });
    assert(r.status === 200, `pull ${r.status} ${r.text.slice(0, 120)}`);
    return `healthz_cell=ok pull=200`;
  });

  await check('DR-07', 'توکن cell2 روی Gateway cell1 ⇒ 403 wrong_cell (بدون افشای داده)', async () => {
    const r = await call(GW1, '/api/gw/v1/pull?limit=5', { token: sesB.token });
    assert(r.status === 403 && r.body.error === 'wrong_cell', `got ${r.status} ${r.text.slice(0, 120)}`);
    assert(!r.body.rows, 'rows leaked across cells');
    const w = await call(GW2, '/api/gw/v1/pull?limit=5', { token: sesA.token });
    assert(w.status === 403 && w.body.error === 'wrong_cell', `reverse: ${w.status}`);
    return `cell1←cell2=${r.body.error} cell2←cell1=${w.body.error}`;
  });

  await check('DR-08', 'توکن بدون claim cell روی Gateway مقید ⇒ 403 missing_cell', async () => {
    const r = await call(GW1, '/api/gw/v1/pull?limit=5', { token: legacyToken });
    assert(r.status === 403 && r.body.error === 'missing_cell', `got ${r.status} ${r.text.slice(0, 120)}`);
    return r.body.error;
  });

  await check('DR-09', 'شروع تک‌cell بدون تغییر رفتار: Gateway بدون GW_CELL توکن قدیمی را می‌پذیرد', async () => {
    const r = await call(GW3, '/api/gw/v1/pull?limit=5', { token: legacyToken });
    assert(r.status === 200, `legacy gateway ${r.status} ${r.text.slice(0, 120)}`);
    const h = await call(GW3, '/healthz');
    assert(h.body.cell === null, `legacy cell=${h.body.cell}`);
    return `pull=200 cell=null`;
  });

  await check('DR-10', 'نوشتن/خواندن در cell1 روی دیتابیس خودِ cell است', async () => {
    const push = await call(GW1, '/api/gw/v1/push', {
      method: 'POST', token: sesA.token,
      body: { ops: [{ uid: 'dr-a-1', collection: 'classes', id: 1, type: 'put', data: { name: 'کلاس cell1' } }] },
    });
    assert(push.status === 200 && push.body.applied.length === 1, `push ${push.status} ${push.text.slice(0, 160)}`);
    const pull = await call(GW1, '/api/gw/v1/pull?limit=10', { token: sesA.token });
    assert(pull.body.rows.length === 1, `cell1 rows=${pull.body.rows.length}`);
    const other = await call(GW2, '/api/gw/v1/pull?limit=10', { token: sesB.token });
    assert(other.status === 200 && other.body.rows.length === 0, `cell2 saw ${other.body.rows.length} rows of cell1`);
    const q = await c1.query('select count(*)::int n from product_records');
    const q2 = await c2.query('select count(*)::int n from product_records');
    return `cell1=${q.rows[0].n} cell2=${q2.rows[0].n}`;
  });

  await check('DR-11', 'تغییر مسیر پیش از پایان TTL دیده نمی‌شود، بعد از TTL دیده می‌شود', async () => {
    const res = directory.createResolver(dir, { ttlSec: 1 });
    const first = await res.resolve('school-a');
    assert(first.cell_id === CELL1, 'initial route wrong');
    await directory.upsertRoute(dir, { schoolCode: 'school-a', cellId: CELL2 });
    const cached = await res.resolve('school-a');
    assert(cached.cell_id === CELL1 && cached.cached === true, 'TTL did not hold old route');
    await sleep(1100);
    const fresh = await res.resolve('school-a');
    assert(fresh.cell_id === CELL2 && fresh.cached === false, `after TTL cell=${fresh.cell_id}`);
    await directory.upsertRoute(dir, { schoolCode: 'school-a', cellId: CELL1 }); /* بازگرداندن */
    return `before_ttl=cell1 after_ttl=cell2`;
  });

  await check('DR-12', 'قطع دایرکتوری: مسیر کش‌شده تا N دقیقه ادامه می‌دهد (stale)', async () => {
    const dead = new Pool({ connectionString: DIR_URL, max: 1 });
    const res = directory.createResolver(dead, { ttlSec: 1, staleMaxSec: 900 });
    const warm = await res.resolve('school-b');
    assert(warm.cell_id === CELL2, 'warm-up failed');
    await dead.end(); /* شبیه‌سازی قطع: هیچ کوئری‌ای دیگر پاسخ نمی‌گیرد */
    await sleep(1100);
    const s = await res.resolve('school-b');
    assert(s && s.stale === true && s.cell_id === CELL2, `stale=${s && s.stale}`);
    return `stale=yes cell2 kept age=${Math.round(s.age_ms / 1000)}s`;
  });

  await check('DR-13', 'قطع دایرکتوری بدون کش ⇒ 503 directory_unavailable', async () => {
    const dead = new Pool({ connectionString: DIR_URL, max: 1 });
    const res = directory.createResolver(dead, { ttlSec: 1, staleMaxSec: 5 });
    await dead.end();
    let out = null;
    try { await res.resolve('school-a'); } catch (e) { out = `${e.code}/${e.status}`; }
    assert(out === 'directory_unavailable/503', `got ${out}`);
    return out;
  });

  await check('DR-14', 'cell غیرفعال ⇒ ورود رد می‌شود (۴۰۹) و پس از فعال‌سازی برمی‌گردد', async () => {
    await directory.upsertCell(dir, { cellId: CELL1, name: 'cell-1', status: 'disabled' });
    const res = directory.createResolver(dir);
    let out = null;
    try {
      await directory.issueSession(res, { schoolCode: 'school-a', uid: 7, role: 'manager', tenantId: TENANT_A, secret: SECRET });
    } catch (e) { out = `${e.code}/${e.status}`; }
    assert(out === 'cell_disabled/409', `got ${out}`);
    await directory.upsertCell(dir, { cellId: CELL1, name: 'cell-1', status: 'active' });
    const ok = await directory.issueSession(directory.createResolver(dir), { schoolCode: 'school-a', uid: 7, role: 'manager', tenantId: TENANT_A, secret: SECRET });
    assert(ok.token && ok.cell_id === CELL1, 'reactivation failed');
    return `disabled=${out} active=ok`;
  });

  await check('DR-15', 'یکتایی و یکپارچگی جدول مسیر: کد تکراری یک ردیف، حذف cell دارای مسیر ممنوع', async () => {
    await directory.upsertRoute(dir, { schoolCode: 'school-c', cellId: CELL1 });
    await directory.upsertRoute(dir, { schoolCode: 'SCHOOL-C', cellId: CELL1 });
    const n = await dir.query(`select count(*)::int n from ${directory.ROUTES_TABLE} where school_code = 'school-c'`);
    assert(n.rows[0].n === 1, `duplicate rows=${n.rows[0].n}`);
    let fk = null;
    try { await dir.query(`delete from ${directory.CELLS_TABLE} where cell_id = $1`, [CELL1]); }
    catch (e) { fk = e.code; }
    /* RESTRICT در PostgreSQL کد 23001 (restrict_violation) می‌دهد، نه 23503 */
    assert(fk === '23001' || fk === '23503', `FK not enforced: ${fk}`);
    await dir.query(`delete from ${directory.ROUTES_TABLE} where school_code = 'school-c'`);
    return `unique=yes fk=${fk}`;
  });

  await check('DR-16', 'توکن مدرسهٔ دیگر روی cell اشتباه حتی با tenant یکسان رد می‌شود', async () => {
    const res = directory.createResolver(dir);
    const wrong = await directory.issueSession(res, { schoolCode: 'school-b', uid: 9, role: 'manager', tenantId: TENANT_A, secret: SECRET });
    const r = await call(GW1, '/api/gw/v1/pull?limit=5', { token: wrong.token });
    assert(r.status === 403 && r.body.error === 'wrong_cell', `got ${r.status} ${r.text.slice(0, 120)}`);
    return r.body.error;
  });

  await dir.end(); await c1.end(); await c2.end(); await pool1.end(); await pool2.end();
  console.log('');
  console.log(`DR checks=${passed + failed} pass=${passed} fail=${failed}`);
  if (failed === 0) console.log('DIRECTORY-43-OK');
  else { console.log('failed: ' + failures.join(',')); console.log('DIRECTORY-43-FAIL'); }
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.log('DR harness error: ' + ((e && e.message) || e));
  process.exit(2);
});
