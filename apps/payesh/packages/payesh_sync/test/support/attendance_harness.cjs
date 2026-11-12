'use strict';
// Test-only harness for test/attendance_it_test.dart (row 74, wave 2). Uses the REAL server
// modules on a throwaway PostgreSQL:
//   setup — migrates tenancy, provisions a school through server/school-access.js, seeds a small
//           school (two classes, a teacher with a schedule row for class 5 only, students in both
//           classes, a parent) and has the manager issue one-time codes for the teacher and the
//           parent via issueActivation. Tenant/slug are fresh per run; codes go to stdout only.
//   read  — the server's current attendance rows of TENANT (admin view, for assertions).
const crypto = require('node:crypto');
const path = require('node:path');
const ROOT = process.env.PAYESH_REPO_ROOT;
const tenancy = require(path.join(ROOT, 'server/tenancy.js'));
const access = require(path.join(ROOT, 'server/school-access.js'));
const { Pool } = require(require.resolve('pg', { paths: [ROOT] }));

(async () => {
  const pool = new Pool({ connectionString: process.env.PGURL_ADMIN, max: 2 });
  try {
    if (process.argv[2] === 'read') {
      const rows = await tenancy.withTenant(pool, process.env.TENANT, async (c) => (await c.query(
        `select record_id, version, data from ${tenancy.PRODUCT_TABLE}
          where collection = 'attendance' and deleted_at is null order by record_id`)).rows);
      process.stdout.write(JSON.stringify({
        rows: rows.map(r => ({ id: Number(r.record_id), version: Number(r.version), data: r.data })),
      }));
      return;
    }
    const c = await pool.connect();
    try { await tenancy.migrate(c); } finally { c.release(); }
    const tid = crypto.randomUUID();
    const slug = 'att-' + crypto.randomBytes(3).toString('hex');
    await access.provisionSchool(pool, { tenantId: tid, slug, managerName: 'مدیر' });
    const put = (collection, id, data) => tenancy.upsertProduct(pool, tid, { collection, id, data: Object.assign({ id }, data) });
    await put('classes', 5, { name: 'دهم الف' });
    await put('classes', 6, { name: 'یازدهم ب' });
    await put('users', 10, { name: 'معلم ریاضی', role: 'teacher', active: true });
    await put('users', 40, { name: 'والد بهار', role: 'parent', active: true });
    await put('schedule', 900, { teacher_id: 10, class_id: 5, bell: 1, day: 0 });
    await put('users', 21, { name: 'بهار', role: 'student', class_id: 5 });
    await put('users', 22, { name: 'آرش', role: 'student', class_id: 5 });
    await put('users', 23, { name: 'سارا', role: 'student', class_id: 5 });
    await put('users', 31, { name: 'کیان', role: 'student', class_id: 6 });
    await put('parent_links', 700, { parent_id: 40, student_id: 21 });
    const mgr = { role: 'manager', tid, uid: 1 };
    const teacher = await access.issueActivation(pool, mgr, { uid: 10 });
    const parent = await access.issueActivation(pool, mgr, { uid: 40 });
    process.stdout.write(JSON.stringify({
      tenant: tid, slug, teacher_code: teacher.activation_code, parent_code: parent.activation_code,
    }));
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
