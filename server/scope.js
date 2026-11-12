'use strict';
/* ═══════════════════════════════════════════════════════════════════
   اسکوپ سمت سرور بر اساس نقش — ردیف ۳۸

   قاعده: مرجع امنیتی «سرور» است، نه فیلتر کلاینت. نقش و شناسهٔ کاربر
   فقط از توکن امضاشده می‌آید؛ فیلد/هدر scope در درخواست هیچ اثری ندارد
   (نادیده گرفته می‌شود، حتی اگر all:true باشد).

   دو مصرف‌کننده:
     ۱) pull از change-feed  → SQL: فقط ردیف‌های درون اسکوپ برمی‌گردند
        (صفحه‌بندی هم درون همان اسکوپ می‌ماند، پس نه جا می‌افتد نه تکرار).
     ۲) push دسته‌ای         → اگر یک عملیات بیرون از اسکوپ باشد، کل دسته
        اتمی رد می‌شود (`out_of_scope` / `role_denied`).

   منبع حقیقت مجوزها همان `server/policy.js` است (COLLECTIONS/canRead/canWrite)،
   تا مسیر محلی و ابری یک سیاست داشته باشند.
   ═══════════════════════════════════════════════════════════════════ */
const policy = require('./policy');

const T = () => require('./tenancy').PRODUCT_TABLE;
const BIG = (col) => `(case when r.data->>'${col}' ~ '^[0-9]{1,18}$' then (r.data->>'${col}')::bigint end)`;

/* کالکشن‌هایی که در سیاست «همه می‌خوانند» هستند و در اسکوپ هیچ محدودیتی ندارند */
const OPEN_COLLECTIONS = [
  'schools', 'school_years', 'subjects', 'bell_schedules', 'announcements',
  'calendar', 'exams', 'homework',
];
const STUDENT_COLLECTIONS = ['attendance', 'grades', 'internships', 'discipline'];

function emptyScope(role, uid) {
  return { role, uid, all: false, classIds: [], studentIds: [], cohorts: [] };
}

/* ── ساخت اسکوپ از دادهٔ خودِ مستأجر (داخل همان تراکنش/زمینهٔ RLS) ── */
async function build(c, claims) {
  const role = String((claims && claims.role) || '');
  if (!policy.ROLES.includes(role)) throw outOfScopeError('bad_role');
  const uid = Number((claims && claims.uid) || 0);
  if (role === 'manager') return { role, uid, all: true, classIds: [], studentIds: [], cohorts: [] };
  if (!Number.isInteger(uid) || uid < 1) throw outOfScopeError('bad_uid_in_token');

  const scope = emptyScope(role, uid);
  const nums = (rows, key) => rows.map(r => Number(r[key])).filter(n => Number.isInteger(n) && n > 0);

  if (role === 'teacher') {
    const sched = await c.query(
      `select distinct ${BIG('class_id')} as class_id
         from ${T()} r
        where collection = 'schedule' and deleted_at is null
          and ${BIG('teacher_id')} = $1`, [uid]
    );
    scope.classIds = nums(sched.rows, 'class_id');
    const own = await c.query(
      `select ${BIG('class_id')} as class_id from ${T()} r
        where collection = 'users' and record_id = $1`, [uid]
    );
    if (own.rows.length && own.rows[0].class_id != null) scope.classIds.push(Number(own.rows[0].class_id));
    scope.classIds = [...new Set(scope.classIds)];
  } else if (role === 'parent') {
    const links = await c.query(
      `select ${BIG('student_id')} as student_id from ${T()} r
        where collection = 'parent_links' and deleted_at is null
          and ${BIG('parent_id')} = $1`, [uid]
    );
    scope.studentIds = nums(links.rows, 'student_id');
  } else if (role === 'student') {
    scope.studentIds = [uid];
    const own = await c.query(
      `select ${BIG('class_id')} as class_id, data->>'grade' as grade, data->>'branch' as branch
         from ${T()} r where collection = 'users' and record_id = $1`, [uid]
    );
    if (own.rows.length) {
      if (own.rows[0].class_id != null) scope.classIds.push(Number(own.rows[0].class_id));
      if (own.rows[0].grade) scope.cohorts.push({ grade: String(own.rows[0].grade).trim(), branch: String(own.rows[0].branch || '').trim() });
    }
  }

  if (role !== 'student' && (role === 'teacher' || role === 'parent') && scope.studentIds.length === 0) {
    /* دانش‌آموزان کلاس‌های در اختیار (برای teacher) — ولی فقط برای همان مستأجر */
    if (role === 'teacher' && scope.classIds.length) {
      const st = await c.query(
        `select record_id from ${T()} r
          where collection = 'users' and deleted_at is null
            and ${BIG('class_id')} = any($1::bigint[])`, [scope.classIds]
      );
      scope.studentIds = nums(st.rows, 'record_id');
    }
  }
  if (role === 'parent' && scope.studentIds.length) {
    const st = await c.query(
      `select ${BIG('class_id')} as class_id, data->>'grade' as grade, data->>'branch' as branch
         from ${T()} r where collection = 'users' and deleted_at is null and record_id = any($1::bigint[])`,
      [scope.studentIds]
    );
    scope.classIds = [...new Set(nums(st.rows, 'class_id'))];
    scope.cohorts = st.rows.filter(x => x.grade).map(x => ({ grade: String(x.grade).trim(), branch: String(x.branch || '').trim() }));
  }
  return scope;
}

function outOfScopeError(code, details) {
  const E = require('./tenancy').TenancyError;
  return new E(code || 'out_of_scope', 403, details || {});
}

/* ── مجوز کالکشن (نقش × کالکشن) ── */
function canReadCollection(scope, collection) {
  if (!scope) return true;
  if (scope.all) return true;
  return policy.canRead(scope.role, collection);
}

function canWriteCollection(scope, collection) {
  if (!scope) return true;
  if (scope.all) return true;
  return policy.canWrite(scope.role, collection);
}

/* ── آیا این ردیف در اسکوپ است؟ (آینهٔ policy.rowInScope) ── */
function rowInScope(scope, collection, row) {
  if (!scope || scope.all) return true;
  const uid = scope.uid;
  const has = (arr, v) => arr.includes(Number(v));
  const data = row || {};
  switch (collection) {
    case 'users':
      return Number(row && row.id) === uid || has(scope.studentIds, row && row.id);
    case 'attendance':
    case 'grades':
    case 'internships':
    case 'discipline':
      return has(scope.studentIds, data.student_id) ||
        (scope.role === 'teacher' && has(scope.classIds, data.class_id));
    case 'leaves':
      return Number(data.student_id) === uid || has(scope.studentIds, data.student_id);
    case 'parent_links':
      return Number(data.parent_id) === uid;
    case 'schedule':
      return has(scope.classIds, data.class_id) ||
        (data.grade && (scope.cohorts || []).some(c => String(c.grade).trim() === String(data.grade).trim() && String(c.branch || '').trim() === String(data.branch || '').trim())) ||
        (scope.role === 'teacher' && Number(data.teacher_id) === uid);
    case 'classes':
      return has(scope.classIds, row && row.id);
    case 'substitutions':
      return data.class_id == null || has(scope.classIds, data.class_id);
    case 'counselor_refs':
    case 'counselor_notes':
      return scope.role === 'counselor';
    case 'staff_attendance':
    case 'staff_posts':
    case 'app_settings':
    case 'import_issues':
    case 'conflicts':
      return false;
    case 'subjects':
    case 'announcements':
    case 'calendar':
    case 'exams':
    case 'homework':
    case 'schools':
    case 'school_years':
    case 'bell_schedules':
      return true;
    default:
      return false;
  }
}

/* ── بازنویسی ردیف بر اساس نقش (همان قواعد canWriteRow، حداقلی و صریح) ── */
function canWriteRow(scope, collection, row, existing) {
  if (!scope || scope.all) return { ok: true };
  if (!canWriteCollection(scope, collection)) return { ok: false, error: 'role_denied' };
  if (scope.role === 'teacher') {
    if (!rowInScope(scope, collection, row) && !rowInScope(scope, collection, existing || {})) {
      return { ok: false, error: 'out_of_scope' };
    }
    if (collection === 'attendance' && row && row.status != null &&
        !policy.ATT_STATUS.includes(String(row.status))) return { ok: false, error: 'bad_status' };
    if (collection === 'grades' && row && row.score != null &&
        (Number(row.score) < 0 || Number(row.score) > 20)) return { ok: false, error: 'bad_score' };
    if (collection === 'grades' && row && row.kind != null &&
        !policy.GRADE_KINDS.includes(String(row.kind))) return { ok: false, error: 'bad_kind' };
    /* تأیید نمره فقط با مدیر است (همان قاعدهٔ server/policy.js). دبیر فقط «در انتظار» می‌فرستد؛
       Gateway ردیف موجود را برای put نمی‌خواند، پس به‌جای پایین‌آوردن بی‌صدا، صریح رد می‌کند (ردیف ۷۴، موج ۳). */
    if (collection === 'grades' && row && row.status != null &&
        String(row.status) !== 'pending') return { ok: false, error: 'approval_denied' };
    return { ok: true };
  }
  if (scope.role === 'parent' || scope.role === 'student') {
    if (collection !== 'leaves') return { ok: false, error: 'role_denied' };
    if (!rowInScope(scope, collection, row || existing || {})) return { ok: false, error: 'out_of_scope' };
    return { ok: true };
  }
  if (scope.role === 'counselor') {
    if (rowInScope(scope, collection, row || existing || {})) return { ok: true };
    return { ok: false, error: 'out_of_scope' };
  }
  return { ok: false, error: 'role_denied' };
}

/* ── شرط SQL روی alias `r` (جدول product) با پارامترهای شماره‌دار ──
   خروجی: { sql, params } — کالکشن‌های ناخوانا هرگز مطابقت نمی‌کنند. */
function sqlPredicate(scope, startIndex = 1) {
  if (!scope || scope.all) return { sql: 'true', params: [] };
  const params = [];
  const ph = (v) => { params.push(v); return '$' + (startIndex + params.length - 1); };
  const role = scope.role;
  const pieces = [];

  const readable = Object.keys(policy.COLLECTIONS).filter(c => policy.collectionAllowed(c) && policy.canRead(role, c));
  const open = OPEN_COLLECTIONS.filter(c => readable.includes(c));
  if (open.length) pieces.push(`r.collection in (${open.map(c => `'${c}'`).join(',')})`);

  if (readable.includes('users')) {
    pieces.push(`(r.collection = 'users' and (r.record_id = ${ph(scope.uid)} or r.record_id = any(${ph(scope.studentIds)}::bigint[])))`);
  }
  const studentCols = STUDENT_COLLECTIONS.filter(c => readable.includes(c));
  if (studentCols.length) {
    const inner = `(${BIG('student_id')} = any(${ph(scope.studentIds)}::bigint[])` +
      (role === 'teacher' ? ` or ${BIG('class_id')} = any(${ph(scope.classIds)}::bigint[])` : '') + ')';
    pieces.push(`(r.collection in (${studentCols.map(c => `'${c}'`).join(',')}) and ${inner})`);
  }
  if (readable.includes('leaves')) {
    pieces.push(`(r.collection = 'leaves' and (${BIG('student_id')} = ${ph(scope.uid)} or ${BIG('student_id')} = any(${ph(scope.studentIds)}::bigint[])))`);
  }
  if (readable.includes('parent_links')) {
    pieces.push(`(r.collection = 'parent_links' and ${BIG('parent_id')} = ${ph(scope.uid)})`);
  }
  if (readable.includes('schedule')) {
    let inner = `${BIG('class_id')} = any(${ph(scope.classIds)}::bigint[])`;
    if (scope.cohorts && scope.cohorts.length) {
      const cohorts = ph(JSON.stringify(scope.cohorts));
      inner += ` or exists (select 1 from jsonb_array_elements(${cohorts}::jsonb) as cohort(value) where (r.data->>'grade') = (cohort.value->>'grade') and coalesce(r.data->>'branch', '') = coalesce(cohort.value->>'branch', ''))`;
    }
    if (role === 'teacher') inner += ` or ${BIG('teacher_id')} = ${ph(scope.uid)}`;
    pieces.push(`(r.collection = 'schedule' and (${inner}))`);
  }
  if (readable.includes('classes')) {
    pieces.push(`(r.collection = 'classes' and r.record_id = any(${ph(scope.classIds)}::bigint[]))`);
  }
  if (readable.includes('substitutions')) {
    pieces.push(`(r.collection = 'substitutions' and (${BIG('class_id')} is null or ${BIG('class_id')} = any(${ph(scope.classIds)}::bigint[])))`);
  }
  if (readable.includes('counselor_refs') || readable.includes('counselor_notes')) {
    const cols = ['counselor_refs', 'counselor_notes'].filter(c => readable.includes(c));
    pieces.push(`(r.collection in (${cols.map(c => `'${c}'`).join(',')}) and ${role === 'counselor' ? 'true' : 'false'})`);
  }

  return { sql: pieces.length ? '(' + pieces.join(' or ') + ')' : 'false', params };
}

module.exports = {
  build, emptyScope, rowInScope, canWriteRow,
  canReadCollection, canWriteCollection, sqlPredicate, outOfScopeError,
  OPEN_COLLECTIONS, STUDENT_COLLECTIONS,
};
