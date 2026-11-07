'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون اسکوپ سمت سرور بر اساس نقش — ردیف ۳۸  (SC-01 .. SC-16)

   هدف: اثبات این‌که محدودیت «معلم فقط کلاس‌های خودش، ولی/دانش‌آموز فقط
   خودش» در سمت سرور اعمال می‌شود — هم روی Gateway (HTTP) و هم روی لایهٔ
   tenancy (بدون HTTP) — و این‌که فیلد/هدر scope در درخواست بی‌اثر است.

   پیش‌نیاز محیط: PGURL_ADMIN، PGURL_RUNTIME، TENANCY_SECRET، GW_PORT
   نبودِ PostgreSQL ⇒ exit 3 با برچسب BLOCKED (نه PASS).
   ═══════════════════════════════════════════════════════════════════ */
const tenancy = require('../server/tenancy');

const PGURL_ADMIN = process.env.PGURL_ADMIN || '';
const PGURL_RUNTIME = process.env.PGURL_RUNTIME || '';
const SECRET = process.env.TENANCY_SECRET || '';
const GW_PORT = Number(process.env.GW_PORT || 5650);

if (!PGURL_ADMIN || !PGURL_RUNTIME || SECRET.length < 16) {
  console.log('BLOCKED — ENVIRONMENT UNAVAILABLE (need PGURL_ADMIN, PGURL_RUNTIME, TENANCY_SECRET)');
  process.exit(3);
}

const TENANT_A = '11111111-1111-4111-8111-111111111111';
let passed = 0, failed = 0;
const failures = [];

async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 300)}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function tokenFor(role, uid, did = 'dev-' + role) {
  return tenancy.signToken({
    tid: TENANT_A, role, uid, did, iat: Date.now(), exp: Date.now() + 600000,
  }, SECRET);
}

const T = {
  manager: tokenFor('manager', 1),
  teacher: tokenFor('teacher', 10),
  parent: tokenFor('parent', 13),
  student: tokenFor('student', 11),
  counselor: tokenFor('counselor', 14),
  guard: tokenFor('guard', 15),
};

async function call(path, { method = 'GET', token = T.manager, body = null, headers = {} } = {}) {
  const h = Object.assign({ 'content-type': 'application/json', 'x-device-id': 'dev-' + Math.random().toString(36).slice(2, 8) }, headers);
  if (token) h.authorization = 'Bearer ' + token;
  const res = await fetch(`http://127.0.0.1:${GW_PORT}${path}`, {
    method, headers: h, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* noop */ }
  return { status: res.status, body: json, text };
}

function op(uid, collection, id, data, type = 'put', base_version = null) {
  return { uid, collection, id, type, data, base_version };
}

const SEED = [
  op('s-class-1', 'classes', 1, { name: 'کلاس الف', grade: 10 }),
  op('s-class-2', 'classes', 2, { name: 'کلاس ب', grade: 11 }),
  op('s-user-10', 'users', 10, { name: 'معلم الف', role: 'teacher', class_id: 1 }),
  op('s-user-11', 'users', 11, { name: 'دانش‌آموز الف', role: 'student', class_id: 1 }),
  op('s-user-12', 'users', 12, { name: 'دانش‌آموز ب', role: 'student', class_id: 2 }),
  op('s-user-13', 'users', 13, { name: 'ولی الف', role: 'parent' }),
  op('s-sched-100', 'schedule', 100, { class_id: 1, teacher_id: 10, subject_id: 5 }),
  op('s-sched-101', 'schedule', 101, { class_id: 2, teacher_id: 99, subject_id: 5 }),
  op('s-att-200', 'attendance', 200, { student_id: 11, class_id: 1, status: 'present', date: '2026-11-01' }),
  op('s-att-201', 'attendance', 201, { student_id: 12, class_id: 2, status: 'absent', date: '2026-11-01' }),
  op('s-grade-300', 'grades', 300, { student_id: 11, class_id: 1, score: 18, kind: 'monthly' }),
  op('s-grade-301', 'grades', 301, { student_id: 12, class_id: 2, score: 12, kind: 'monthly' }),
  op('s-link-400', 'parent_links', 400, { parent_id: 13, student_id: 11 }),
  op('s-leave-500', 'leaves', 500, { student_id: 11, status: 'pending', reason: 'بیماری' }),
];

async function pullAll(token, extra = '') {
  const out = [];
  let since = 0;
  for (let i = 0; i < 20; i++) {
    const r = await call(`/api/gw/v1/pull?since_seq=${since}&limit=200${extra}`, { token });
    assert(r.status === 200, `pull status ${r.status} — ${r.text.slice(0, 120)}`);
    out.push(...r.body.rows);
    if (!r.body.more) break;
    since = r.body.next_seq;
  }
  return out;
}
const keys = (rows) => rows.map(r => `${r.collection}/${r.id}`).sort();

(async () => {
  const { Client } = require('pg');
  const admin = new Client({ connectionString: PGURL_ADMIN });
  await admin.connect();
  const mig = await tenancy.migrate(admin);
  console.log(`# migrate: statements=${mig.statements} server=${mig.server_version}`);
  const pool = tenancy.createPool({ connectionString: PGURL_RUNTIME });

  await check('SC-01', 'مدیر همهٔ ردیف‌های seed را از Gateway می‌بیند (پایه)', async () => {
    const seed = await call('/api/gw/v1/push', { method: 'POST', body: { ops: SEED } });
    assert(seed.status === 200 && seed.body.applied.length === SEED.length,
      `seed failed ${seed.status} ${seed.text.slice(0, 160)}`);
    const rows = await pullAll(T.manager);
    assert(rows.length === SEED.length, `manager sees ${rows.length}/${SEED.length}`);
    return `rows=${rows.length}`;
  });

  await check('SC-02', 'معلم فقط کلاس‌های خودش را pull می‌کند (حضور/نمره/برنامه/کاربران)', async () => {
    const rows = await pullAll(T.teacher);
    const k = keys(rows);
    assert(k.includes('attendance/200'), 'own-class attendance missing');
    assert(!k.includes('attendance/201'), 'other-class attendance leaked');
    assert(k.includes('grades/300') && !k.includes('grades/301'), 'grades scope wrong');
    assert(k.includes('schedule/100') && !k.includes('schedule/101'), 'schedule scope wrong');
    assert(k.includes('users/10') && k.includes('users/11') && !k.includes('users/12'), 'users scope wrong');
    assert(!k.includes('parent_links/400'), 'parent_links leaked to teacher');
    return `rows=${rows.length} scope=${JSON.stringify(rows.length ? (await call('/api/gw/v1/pull?limit=1', { token: T.teacher })).body.scope : null)}`;
  });

  await check('SC-03', 'ولی فقط فرزند خودش را می‌بیند', async () => {
    const k = keys(await pullAll(T.parent));
    assert(k.includes('attendance/200') && !k.includes('attendance/201'), 'parent attendance scope wrong');
    assert(k.includes('grades/300') && !k.includes('grades/301'), 'parent grades scope wrong');
    assert(k.includes('parent_links/400'), 'own parent_link missing');
    assert(k.includes('leaves/500'), 'own child leave missing');
    assert(!k.includes('users/10') && !k.includes('users/12'), 'other users leaked to parent');
    return `rows=${k.length}`;
  });

  await check('SC-04', 'دانش‌آموز فقط ردیف خودش (و کلاس خودش) را می‌بیند', async () => {
    const k = keys(await pullAll(T.student));
    assert(k.includes('users/11') && !k.includes('users/12') && !k.includes('users/10'), 'student users scope wrong');
    assert(k.includes('attendance/200') && !k.includes('attendance/201'), 'student attendance leak');
    assert(k.includes('classes/1') && !k.includes('classes/2'), 'student classes leak');
    assert(!k.includes('parent_links/400'), 'parent_links leaked to student');
    return `rows=${k.length}`;
  });

  await check('SC-05', 'معلم می‌تواند برای کلاس خودش حضور بنویسد (مثبت)', async () => {
    const r = await call('/api/gw/v1/push', {
      method: 'POST', token: T.teacher,
      body: { ops: [op('t-att-ok-1', 'attendance', 210, { student_id: 11, class_id: 1, status: 'late' })] },
    });
    assert(r.status === 200 && r.body.applied.length === 1, `push failed ${r.status} ${r.text.slice(0, 160)}`);
    const back = await pullAll(T.teacher);
    assert(keys(back).includes('attendance/210'), 'own write not visible');
    return `applied=${r.body.applied.length}`;
  });

  await check('SC-06', 'نوشتن معلم برای کلاس دیگر رد می‌شود و هیچ ردیفی نمی‌نویسد', async () => {
    const before = await pullAll(T.manager);
    const r = await call('/api/gw/v1/push', {
      method: 'POST', token: T.teacher,
      body: { ops: [op('t-att-bad-1', 'attendance', 211, { student_id: 12, class_id: 2, status: 'present' })] },
    });
    assert(r.status === 403 && r.body.error === 'out_of_scope', `expected 403 out_of_scope, got ${r.status} ${r.text.slice(0, 160)}`);
    const after = await pullAll(T.manager);
    assert(after.length === before.length, `feed grew: ${before.length} -> ${after.length}`);
    const q = await admin.query('select count(*)::int n from product_records where collection=$1 and record_id=$2 and deleted_at is null', ['attendance', 211]);
    assert(q.rows[0].n === 0, 'out-of-scope row was written');
    return `feed_before=${before.length} feed_after=${after.length} rejected=${r.body.error}`;
  });

  await check('SC-07', 'معلم نمی‌تواند کالکشن غیرمجاز (users) بنویسد', async () => {
    const r = await call('/api/gw/v1/push', {
      method: 'POST', token: T.teacher,
      body: { ops: [op('t-user-bad', 'users', 12, { name: 'تغییر', role: 'student', class_id: 1 })] },
    });
    assert(r.status === 403 && r.body.error === 'role_denied', `got ${r.status} ${r.text.slice(0, 160)}`);
    return r.body.error;
  });

  await check('SC-08', 'ولی نمی‌تواند نمره بنویسد (role_denied)', async () => {
    const r = await call('/api/gw/v1/push', {
      method: 'POST', token: T.parent,
      body: { ops: [op('p-grade-bad', 'grades', 310, { student_id: 11, class_id: 1, score: 20, kind: 'monthly' })] },
    });
    assert(r.status === 403 && r.body.error === 'role_denied', `got ${r.status} ${r.text.slice(0, 160)}`);
    return r.body.error;
  });

  await check('SC-09', 'ولی می‌تواند برای فرزند خودش درخواست مرخصی بدهد (مثبت)', async () => {
    const r = await call('/api/gw/v1/push', {
      method: 'POST', token: T.parent,
      body: { ops: [op('p-leave-ok', 'leaves', 501, { student_id: 11, status: 'pending', reason: 'سفر' })] },
    });
    assert(r.status === 200 && r.body.applied.length === 1, `got ${r.status} ${r.text.slice(0, 200)}`);
    return `applied=${r.body.applied.length}`;
  });

  await check('SC-10', 'ولی نمی‌تواند برای دانش‌آموز دیگر مرخصی بدهد (out_of_scope)', async () => {
    const r = await call('/api/gw/v1/push', {
      method: 'POST', token: T.parent,
      body: { ops: [op('p-leave-bad', 'leaves', 502, { student_id: 12, status: 'pending' })] },
    });
    assert(r.status === 403 && r.body.error === 'out_of_scope', `got ${r.status} ${r.text.slice(0, 160)}`);
    return r.body.error;
  });

  await check('SC-11', 'scope داخل درخواست (هدر و بدنه و query) بی‌اثر است', async () => {
    const viaHeader = await call('/api/gw/v1/push', {
      method: 'POST', token: T.teacher,
      headers: { 'x-scope': 'all', 'x-role': 'manager', 'x-tenant': TENANT_A },
      body: { ops: [op('t-scope-h', 'attendance', 212, { student_id: 12, class_id: 2, status: 'present' })], scope: { all: true }, role: 'manager' },
    });
    assert(viaHeader.status === 403, `header/body scope bypassed: ${viaHeader.status} ${viaHeader.text.slice(0, 160)}`);
    const viaQuery = await pullAll(T.teacher, '&scope=all&role=manager&all=1');
    const k = keys(viaQuery);
    assert(!k.includes('attendance/201') && !k.includes('attendance/212'), 'query scope bypassed');
    return `push=${viaHeader.status} pull_rows=${k.length}`;
  });

  await check('SC-12', 'کالکشن ناخوانا برای نقش ⇒ 403 forbidden_collection', async () => {
    const r = await call('/api/gw/v1/pull?collection=counselor_notes&limit=10', { token: T.student });
    assert(r.status === 403 && r.body.error === 'forbidden_collection', `got ${r.status} ${r.text.slice(0, 160)}`);
    const ok = await call('/api/gw/v1/pull?collection=counselor_notes&limit=10', { token: T.counselor });
    assert(ok.status === 200, `counselor should read own collection, got ${ok.status}`);
    return `${r.body.error} / counselor=${ok.status}`;
  });

  await check('SC-13', 'صفحه‌بندی درون اسکوپ: بدون تکرار و بدون جاافتادگی', async () => {
    const oneShot = keys(await pullAll(T.teacher, '&limit=200'));
    const collected = [];
    let since = 0;
    for (let i = 0; i < 30; i++) {
      const r = await call(`/api/gw/v1/pull?since_seq=${since}&limit=2`, { token: T.teacher });
      assert(r.status === 200, `page ${i} status ${r.status}`);
      collected.push(...r.body.rows);
      if (!r.body.more) break;
      since = r.body.next_seq;
    }
    const paged = keys(collected);
    const dup = paged.length !== new Set(paged).size;
    assert(!dup, 'duplicate rows across pages');
    assert(JSON.stringify(paged) === JSON.stringify(oneShot), `paged(${paged.length}) != oneshot(${oneShot.length})`);
    return `pages_rows=${paged.length} unique=yes`;
  });

  await check('SC-14', 'اسکوپ در لایهٔ tenancy هم اعمال می‌شود (نه فقط Gateway)', async () => {
    const claims = { tid: TENANT_A, role: 'teacher', uid: 10 };
    let code = null;
    try {
      await tenancy.applyOps(pool, TENANT_A, {
        ops: [op('direct-bad', 'attendance', 213, { student_id: 12, class_id: 2 })], claims,
      });
    } catch (e) { code = e.code || String(e.message); }
    assert(code === 'out_of_scope', `direct applyOps not blocked: ${code}`);
    const feed = await tenancy.listFeed(pool, TENANT_A, { limit: 500, claims });
    const k = keys(feed.rows);
    assert(k.includes('attendance/200') && !k.includes('attendance/201'), 'direct listFeed not scoped');
    return `applyOps=${code} feed_rows=${k.length}`;
  });

  await check('SC-15', 'tombstone هم در اسکوپ می‌ماند (حذف ردیف بیرون از اسکوپ دیده نمی‌شود)', async () => {
    const del = await call('/api/gw/v1/push', {
      method: 'POST', token: T.manager, body: { ops: [op('m-del-201', 'attendance', 201, null, 'del')] },
    });
    assert(del.status === 200, `delete failed ${del.status}`);
    const k = keys(await pullAll(T.teacher));
    assert(!k.includes('attendance/201'), 'tombstone of other class leaked');
    const mk = keys(await pullAll(T.manager));
    assert(mk.includes('attendance/201'), 'manager should still see tombstone');
    return 'teacher=hidden manager=visible';
  });

  await check('SC-16', 'توکن بدون نقش معتبر ⇒ 403 و بدون افشای داده', async () => {
    const bad = tenancy.signToken({ tid: TENANT_A, role: 'system', uid: 10, iat: Date.now(), exp: Date.now() + 600000 }, SECRET);
    const r = await call('/api/gw/v1/pull?limit=5', { token: bad });
    assert(r.status === 403, `got ${r.status} ${r.text.slice(0, 160)}`);
    assert(!r.body.rows, 'rows leaked with bad role');
    return r.body.error;
  });

  await pool.end();
  await admin.end();
  console.log('');
  console.log(`SC checks=${passed + failed} pass=${passed} fail=${failed}`);
  if (failed === 0) console.log('SCOPE-38-OK');
  else { console.log('failed: ' + failures.join(',')); console.log('SCOPE-38-FAIL'); }
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.log('SC harness error: ' + ((e && e.message) || e));
  process.exit(2);
});
