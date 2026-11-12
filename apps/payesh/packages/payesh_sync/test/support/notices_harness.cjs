'use strict';
// Test-only harness for test/notices_it_test.dart (row 74, wave 4). Uses the REAL server modules
// on a throwaway PostgreSQL:
//   setup — migrates tenancy, provisions a school through server/school-access.js (its one-time
//           manager code is returned), seeds a small school (a class, a teacher, a student, a
//           parent) plus two notices published "by the web client": id 1 (normal) and one at
//           NoticeBoard.idBase + 5 (the collision target of W4-IT-08). The manager issues
//           one-time codes for the teacher and the parent via issueActivation. Tenant/slug are
//           fresh per run; codes go to stdout only.
//   read  — the server's announcement rows of TENANT incl. tombstones (admin view, for
//           assertions). The admin role bypasses RLS, so the query filters tenant_id explicitly
//           (rows of earlier runs in the same database are never counted).
const crypto = require('node:crypto');
const path = require('node:path');
const ROOT = process.env.PAYESH_REPO_ROOT;
const tenancy = require(path.join(ROOT, 'server/tenancy.js'));
const access = require(path.join(ROOT, 'server/school-access.js'));
const { Pool } = require(require.resolve('pg', { paths: [ROOT] }));

const COLLIDE = 9000000000000005; // NoticeBoard.idBase + 5

(async () => {
  const pool = new Pool({ connectionString: process.env.PGURL_ADMIN, max: 2 });
  try {
    if (process.argv[2] === 'read') {
      const rows = await tenancy.withTenant(pool, process.env.TENANT, async (c) => (await c.query(
        `select record_id, version, data, deleted_at is not null as deleted from ${tenancy.PRODUCT_TABLE}
          where tenant_id = current_setting('app.tenant_id')::uuid
            and collection = 'announcements' order by record_id`)).rows);
      process.stdout.write(JSON.stringify({
        rows: rows.map(r => ({ id: Number(r.record_id), version: Number(r.version), deleted: r.deleted, data: r.data })),
      }));
      return;
    }
    const c = await pool.connect();
    try { await tenancy.migrate(c); } finally { c.release(); }
    const tid = crypto.randomUUID();
    const slug = 'ntc-' + crypto.randomBytes(3).toString('hex');
    const school = await access.provisionSchool(pool, { tenantId: tid, slug, managerName: 'مدیر' });
    const put = (collection, id, data) => tenancy.upsertProduct(pool, tid, { collection, id, data: Object.assign({ id }, data) });
    await put('classes', 5, { name: 'دهم الف' });
    await put('users', 10, { name: 'معلم', role: 'teacher', active: true });
    await put('users', 40, { name: 'والد بهار', role: 'parent', active: true });
    await put('users', 21, { name: 'بهار', role: 'student', class_id: 5 });
    await put('schedule', 900, { teacher_id: 10, class_id: 5, subject_id: 41, bell: 1, day: 0 });
    await put('parent_links', 700, { parent_id: 40, student_id: 21 });
    await put('announcements', 1, { title: 'آغاز سال تحصیلی', body: 'کلاس‌ها از شنبه', severity: 'normal', date: '2026-09-20', author_id: 1 });
    await put('announcements', COLLIDE, { title: 'اطلاعیهٔ قبلی', body: 'نباید بازنویسی شود', severity: 'info', date: '2026-10-01', author_id: 1 });
    const mgr = { role: 'manager', tid, uid: 1 };
    const teacher = await access.issueActivation(pool, mgr, { uid: 10 });
    const parent = await access.issueActivation(pool, mgr, { uid: 40 });
    process.stdout.write(JSON.stringify({
      tenant: tid, slug, manager_code: school.activation_code,
      teacher_code: teacher.activation_code, parent_code: parent.activation_code,
    }));
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
