'use strict';
// Test-only harness for test/family_it_test.dart (row 74, wave 5). Uses the REAL server modules
// on a throwaway PostgreSQL:
//   setup — migrates tenancy, provisions a school through server/school-access.js (its one-time
//           manager code is returned), seeds two families: parent 40 linked to students 21 and
//           22, parent 41 linked to student 23 (the "other family"), with grades (approved and
//           pending), attendance, an internship and one web leave of each family. The manager
//           issues one-time codes for parent 40 and for a teacher via issueActivation.
//           Tenant/slug are fresh per run; codes go to stdout only.
//   read  — the server's rows of COLLECTION (default leaves) of TENANT incl. tombstones (admin
//           view, for assertions). The admin role bypasses RLS, so the query filters tenant_id
//           explicitly (rows of earlier runs in the same database are never counted).
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
      const col = process.env.COLLECTION || 'leaves';
      const rows = await tenancy.withTenant(pool, process.env.TENANT, async (c) => (await c.query(
        `select record_id, version, data, deleted_at is not null as deleted from ${tenancy.PRODUCT_TABLE}
          where tenant_id = current_setting('app.tenant_id')::uuid
            and collection = $1 order by record_id`, [col])).rows);
      process.stdout.write(JSON.stringify({
        rows: rows.map(r => ({ id: Number(r.record_id), version: Number(r.version), deleted: r.deleted, data: r.data })),
      }));
      return;
    }
    const c = await pool.connect();
    try { await tenancy.migrate(c); } finally { c.release(); }
    const tid = crypto.randomUUID();
    const slug = 'fam-' + crypto.randomBytes(3).toString('hex');
    const school = await access.provisionSchool(pool, { tenantId: tid, slug, managerName: 'مدیر' });
    const put = (collection, id, data) => tenancy.upsertProduct(pool, tid, { collection, id, data: Object.assign({ id }, data) });
    await put('classes', 5, { name: 'دهم الف' });
    await put('classes', 6, { name: 'یازدهم ب' });
    await put('subjects', 41, { name: 'ریاضی' });
    await put('subjects', 42, { name: 'ادبیات' });
    await put('users', 10, { name: 'معلم', role: 'teacher', active: true });
    await put('users', 40, { name: 'والد احمدی', role: 'parent', active: true });
    await put('users', 41, { name: 'والد کریمی', role: 'parent', active: true });
    await put('users', 21, { name: 'بهار احمدی', role: 'student', class_id: 5 });
    await put('users', 22, { name: 'امید احمدی', role: 'student', class_id: 6 });
    await put('users', 23, { name: 'نیما کریمی', role: 'student', class_id: 5 });
    await put('schedule', 900, { teacher_id: 10, class_id: 5, subject_id: 41, bell: 1, day: 0 });
    await put('parent_links', 700, { parent_id: 40, student_id: 21 });
    await put('parent_links', 701, { parent_id: 40, student_id: 22 });
    await put('parent_links', 702, { parent_id: 41, student_id: 23 });
    await put('grades', 801, { student_id: 21, class_id: 5, subject_id: 41, term: 'نوبت اول', kind: 'midterm', score: 18, status: 'approved' });
    await put('grades', 802, { student_id: 21, class_id: 5, subject_id: 42, term: 'نوبت اول', kind: 'midterm', score: 14, status: 'approved' });
    await put('grades', 803, { student_id: 21, class_id: 5, subject_id: 41, term: 'نوبت دوم', kind: 'midterm', score: 9, status: 'pending' });
    await put('grades', 804, { student_id: 23, class_id: 5, subject_id: 41, term: 'نوبت اول', kind: 'midterm', score: 20, status: 'approved' });
    const day = (d) => 4000000000000000 + d * 10000000000;
    await put('attendance', day(20400) + 21, { student_id: 21, class_id: 5, date: '2025-11-08', status: 'present' });
    await put('attendance', day(20401) + 21, { student_id: 21, class_id: 5, date: '2025-11-09', status: 'present' });
    await put('attendance', day(20402) + 21, { student_id: 21, class_id: 5, date: '2025-11-10', status: 'absent' });
    await put('attendance', day(20402) + 23, { student_id: 23, class_id: 5, date: '2025-11-10', status: 'absent' });
    await put('internships', 950, { student_id: 22, date: '2025-11-01', hours: 6, location: 'کارگاه', status: 'pending' });
    await put('leaves', 960, { student_id: 21, date: '2025-11-10', reason: 'پزشک', status: 'approved', by_id: 40 });
    await put('leaves', 961, { student_id: 23, date: '2025-11-10', reason: 'سفر', status: 'pending', by_id: 41 });
    const mgr = { role: 'manager', tid, uid: 1 };
    const parent = await access.issueActivation(pool, mgr, { uid: 40 });
    const teacher = await access.issueActivation(pool, mgr, { uid: 10 });
    process.stdout.write(JSON.stringify({
      tenant: tid, slug, manager_code: school.activation_code,
      parent_code: parent.activation_code, teacher_code: teacher.activation_code,
    }));
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
