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
const gradeScheme = require('./grade-scheme');
const schoolCalendar = require('./school-calendar');
const policy = require('./policy');
const finance = require('./school-finance');
const parentMsgs = require('./parent-msgs');

const T = () => require('./tenancy').PRODUCT_TABLE;
const BIG = (col) => `(case when r.data->>'${col}' ~ '^[0-9]{1,18}$' then (r.data->>'${col}')::bigint end)`;

/* کالکشن‌هایی که در سیاست «همه می‌خوانند» هستند و در اسکوپ هیچ محدودیتی ندارند */
const OPEN_COLLECTIONS = [
  'schools', 'school_years', 'subjects', 'bell_schedules',
  'calendar', 'exams', 'homework',
];
const STUDENT_COLLECTIONS = ['attendance', 'grades', 'internships', 'discipline'];

function emptyScope(role, uid) {
  return { role, uid, all: false, classIds: [], studentIds: [], cohorts: [], grantRead: [], grantWrite: [] };
}

/* ── ساخت اسکوپ از دادهٔ خودِ مستأجر (داخل همان تراکنش/زمینهٔ RLS) ── */
async function build(c, claims) {
  const role = policy.permRole(String((claims && claims.role) || ''));
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
  } else if (role === 'counselor') {
    /* ردیف ۱۹۷ (Q12 / F29): مشاور هر دانش‌آموز مدرسه (و کلاسش) — آینهٔ policy.buildScope؛
       به‌علاوهٔ ارجاع‌شده‌ها (ارجاعِ دانش‌آموزی که ردیفش هنوز نرسیده) */
    /* یک پرس‌وجو (union) — همان محلِ ثابتِ ردیف ۱۸۷؛ فقط ثابت‌های داخلی T()/BIG()، بدون ورودی */
    const st = await c.query(
      `select record_id as student_id, ${BIG('class_id')} as class_id from ${T()} r
        where collection = 'users' and deleted_at is null and r.data->>'role' = 'student'
       union
       select ${BIG('student_id')} as student_id, null::bigint as class_id from ${T()} r
        where collection = 'counselor_refs' and deleted_at is null`, []
    );
    scope.studentIds = [...new Set(nums(st.rows, 'student_id'))];
    scope.classIds = [...new Set(nums(st.rows, 'class_id'))];
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

  /* ردیف ۱۹۴: تیک‌های دسترسی عوامل اجرایی — آینهٔ policy.buildScope / canWriteRow */
  if (policy.GRANTABLE_ROLES.includes(role)) {
    const me = await c.query(
      `select data->'access' as access from ${T()} r
        where collection = 'users' and deleted_at is null and record_id = $1`, [uid]
    );
    const user = { role, access: me.rows.length ? me.rows[0].access : null };
    scope.grantRead = [...policy.grantReads(user)];
    scope.grantWrite = [...policy.grantWrites(user)];
    /* ردیف ۱۹۷ (Q06): نگهبانِ «درِ مدرسه» از مرخصی فقط زمان و وضعیت (آینهٔ sync.pull) */
    scope.gateLeaves = policy.gateLeavesOnly(user);
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
  if ((scope.grantRead || []).includes(collection)) return true;
  return policy.canRead(scope.role, collection);
}

function canWriteCollection(scope, collection) {
  if (!scope) return true;
  if (scope.all) return true;
  if ((scope.grantWrite || []).includes(collection)) return true;
  return policy.canWrite(scope.role, collection);
}

/* ── آیا این ردیف در اسکوپ است؟ (آینهٔ policy.rowInScope) ── */
function rowInScope(scope, collection, row) {
  if (!scope || scope.all) return true;
  if ((scope.grantRead || []).includes(collection)) return true;
  const uid = scope.uid;
  const has = (arr, v) => arr.includes(Number(v));
  const data = row || {};
  switch (collection) {
    case 'users':
      return Number(row && row.id) === uid || has(scope.studentIds, row && row.id);
    case 'grades':
    case 'internships':
      return has(scope.studentIds, data.student_id) ||
        (scope.role === 'teacher' && has(scope.classIds, data.class_id));
    case 'attendance':
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
    /* ردیف ۱۹۷ (F19): دبیر فقط ارجاع‌های خودش؛ یادداشت مشاوره فقط مشاور */
    case 'counselor_refs':
      if (scope.role === 'teacher') return data.referred_by != null && Number(data.referred_by) === uid;
      return scope.role === 'counselor';
    case 'counselor_notes':
      return scope.role === 'counselor';
    /* ردیف ۱۹۷ (Q12 / F27، F29): آینهٔ policy.rowInScope */
    case 'parent_msgs':
      if (scope.role === 'parent') return has(scope.studentIds, data.student_id);
      return parentMsgs.isRecipient(scope.role, uid, data);
    case 'contributions':
      return scope.role === 'parent' && data.student_id != null && has(scope.studentIds, data.student_id);
    case 'staff_attendance':
    case 'staff_posts':
    case 'app_settings':
    case 'import_issues':
    case 'conflicts':
    /* ردیف ۱۹۷ (Q06): مراجعین — فقط مدیر (all) یا ناحیهٔ «درِ مدرسه» (grantRead) */
    case 'visitors':
    /* ردیف ۱۹۷ (Q07): هیئت امنا — فقط مدیر (کمک‌ها بالا: ولی برای فرزند خودش) */
    case 'trustees':
      return false;
    /* ردیف ۱۹۷ (F19): اطلاعیهٔ کلاس فقط برای همان کلاس و نویسنده (مدیر all) */
    case 'announcements':
      if (data.class_id == null || data.class_id === '') return true;
      return has(scope.classIds, data.class_id) || (data.author_id != null && Number(data.author_id) === uid);
    case 'subjects':
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
  /* ردیف ۱۹۷: شکل مرخصی برای همهٔ نقش‌ها (همان policy.leaveIssue) */
  /* حذف (row همان existing است) هیچ‌وقت به‌خاطر شکل ردیف قدیمی رد نمی‌شود */
  if (collection === 'leaves' && row && row !== existing && row.date !== undefined) {
    const li = policy.leaveIssue(row);
    if (li) return { ok: false, error: li };
  }
  if (collection === 'visitors' && row && row.name !== undefined) {
    const vi = policy.visitorIssue(row);
    if (vi) return { ok: false, error: vi };
  }
  /* ردیف ۱۹۷ Q10: شکل ردیف تعطیلی (روزهای اعلام‌شده روی سرور مدرسه سنجیده می‌شوند) */
  if (collection === 'calendar' && row && row !== existing && row.date !== undefined) {
    const di = schoolCalendar.dayOffIssue(row);
    if (di) return { ok: false, error: di };
  }
  /* ردیف ۱۹۷ Q08/Q09: شکل نمرهٔ پودمانی/توصیفی/عددی (همان server/grade-scheme.js) */
  if (collection === 'grades' && row && row !== existing && (row.score !== undefined || row.kind !== undefined)) {
    const gi = gradeScheme.gradeIssue(row);
    if (gi) return { ok: false, error: gi };
  }
  /* ردیف ۱۹۷ (Q07): شکل ردیف (آینهٔ ابری ردیف مدرسه را ندارد؛ قاعدهٔ شهریه روی سرور مدرسه) */
  if (collection === 'contributions' && row && row.amount !== undefined) {
    const ci = finance.contributionIssue(row);
    if (ci) return { ok: false, error: ci };
  }
  if (collection === 'trustees' && row && row.kind !== undefined) {
    const ti = finance.trusteeIssue(row);
    if (ti) return { ok: false, error: ti };
  }
  /* ردیف ۱۹۷ (Q12 / F27، F29): شکل پیام/نوبت و یادداشت مشاوره (آینهٔ policy). Gateway برای put ردیف
     موجود را نمی‌خواند ⇒ put همیشه ردیف کامل است و همین ردیف سنجیده می‌شود. */
  if (collection === 'parent_msgs' && row && row !== existing) {
    const mi = parentMsgs.msgIssue(Object.assign({}, existing || {}, row));
    if (mi) return { ok: false, error: mi };
  }
  if (collection === 'counselor_notes' && row && row !== existing) {
    const ni = parentMsgs.noteIssue(Object.assign({}, existing || {}, row));
    if (ni) return { ok: false, error: ni };
  }
  if (!scope || scope.all) return { ok: true };
  if ((scope.grantWrite || []).includes(collection)) {
    if (collection === 'attendance' && row && row.status != null &&
        !policy.ATT_STATUS.includes(String(row.status))) return { ok: false, error: 'bad_status' };
    if (collection === 'grades' && row && row.score != null &&
        (Number(row.score) < 0 || Number(row.score) > 20)) return { ok: false, error: 'bad_score' };
    if (collection === 'grades' && row && row.kind != null &&
        !policy.GRADE_KINDS.includes(String(row.kind))) return { ok: false, error: 'bad_kind' };
    return { ok: true };
  }
  if (!canWriteCollection(scope, collection)) return { ok: false, error: 'role_denied' };
  if (scope.role === 'teacher') {
    const has = (arr, v) => v != null && arr.includes(Number(v));
    /* ردیف ۱۹۷ (Q12 / F19): تکلیف، اطلاعیهٔ کلاس و انضباط — شکل ردیف (آینهٔ policy.classNoteIssue) */
    if ((collection === 'homework' || collection === 'announcements' || collection === 'discipline') && row && row !== existing) {
      const ni = policy.classNoteIssue(collection, row);
      if (ni) return { ok: false, error: ni };
    }
    /* این دو کالکشن را همه می‌خوانند؛ نوشتنِ دبیر فقط برای کلاس خودش (اطلاعیهٔ کل مدرسه فقط مدیر) */
    if (collection === 'homework' || collection === 'announcements') {
      /* اطلاعیهٔ کل مدرسه (بی‌کلاس) مالِ مدیر است — ساختن، ویرایش و حذفش برای دبیر role_denied */
      if (collection === 'announcements' && ((row || {}).class_id == null || (existing && existing.class_id == null))) return { ok: false, error: 'role_denied' };
      if (!has(scope.classIds, (row || existing || {}).class_id)) return { ok: false, error: 'out_of_scope' };
      if (existing && !has(scope.classIds, existing.class_id)) return { ok: false, error: 'out_of_scope' };
      if (existing && existing.author_id != null && Number(existing.author_id) !== scope.uid) return { ok: false, error: 'not_author' };
      /* آینهٔ policy: سرور مدرسه author_id را مُهر می‌کند؛ ابر نویسندهٔ دیگری را نمی‌پذیرد */
      if (row && row !== existing && Number(row.author_id) !== scope.uid) return { ok: false, error: 'not_author' };
      return { ok: true };
    }
    /* ردیف ۱۹۷ (Q12 / F27): پاسخِ دبیر فقط به پیامِ خودش (مُهرِ replied_by = خودش) */
    if (collection === 'parent_msgs') return cloudRecipientMsg(scope, row, existing);
    /* ارجاع به مشاور: فقط دانش‌آموزِ خودش، فقط «باز» */
    if (collection === 'counselor_refs') {
      const r = row || existing || {};
      if (!has(scope.studentIds, r.student_id)) return { ok: false, error: 'out_of_scope' };
      if (existing && Number(existing.referred_by) !== scope.uid) return { ok: false, error: 'not_author' };
      if (row && row !== existing && row.status != null && String(row.status) !== 'open') return { ok: false, error: 'approval_denied' };
      if (row && row !== existing && !String(row.reason || '').trim()) return { ok: false, error: 'reason_required' };
      if (row && row !== existing && Number(row.referred_by) !== scope.uid) return { ok: false, error: 'not_author' };
      return { ok: true };
    }
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
    /* ردیف ۱۹۷: تأیید/رد مرخصی هم فقط با مدیر/معاون است */
    if (collection === 'leaves' && row && row.status != null &&
        !policy.LEAVE_REQUEST_STATUSES.includes(String(row.status))) return { ok: false, error: 'approval_denied' };
    return { ok: true };
  }
  /* ردیف ۱۹۷ (Q12 / F27): ولی فقط پیامِ «باز» برای فرزند خودش، با parent_id = خودش */
  if (scope.role === 'parent' && collection === 'parent_msgs') {
    if (row === existing) return { ok: false, error: 'role_denied' };
    if (!rowInScope(scope, collection, row || {})) return { ok: false, error: 'out_of_scope' };
    if (existing && !rowInScope(scope, collection, existing)) return { ok: false, error: 'out_of_scope' };
    if (Number((row || {}).parent_id) !== scope.uid) return { ok: false, error: 'not_author' };
    const pi = parentMsgs.parentMsgIssue(row, existing) || (existing ? parentMsgs.fixedChanged(row, existing, ['text']) : '');
    if (pi) return { ok: false, error: pi };
    return { ok: true };
  }
  if (scope.role === 'parent' || scope.role === 'student') {
    if (collection !== 'leaves') return { ok: false, error: 'role_denied' };
    if (!rowInScope(scope, collection, row || existing || {})) return { ok: false, error: 'out_of_scope' };
    /* ولی و دانش‌آموز فقط درخواست می‌دهند؛ تأیید با مدرسه است (همان قاعدهٔ server/policy.js که آنجا
       بی‌صدا به pending برمی‌گرداند). Gateway ردیف موجود را برای put نمی‌خواند، پس صریح رد می‌کند (ردیف ۷۴، موج ۵). */
    if (row && row.status != null &&
        !policy.LEAVE_REQUEST_STATUSES.includes(String(row.status))) return { ok: false, error: 'approval_denied' };
    if (existing && existing.status && !policy.LEAVE_REQUEST_STATUSES.includes(String(existing.status))) {
      return { ok: false, error: 'leave_decided' };
    }
    return { ok: true };
  }
  if (scope.role === 'counselor') {
    if (collection === 'parent_msgs') return cloudRecipientMsg(scope, row, existing);
    if (rowInScope(scope, collection, row || existing || {})) return { ok: true };
    return { ok: false, error: 'out_of_scope' };
  }
  return { ok: false, error: 'role_denied' };
}

/* ردیف ۱۹۷ (Q12 / F27، F29): گیرنده (دبیرِ همان پیام / مشاور) — آینهٔ policy.recipientMsgWrite.
   حذف فقط با مدیر؛ ردیف باید مُهرِ replied_by = خودِ نویسنده و پاسخ/نوبت داشته باشد (پیامِ ولی را
   نمی‌شود به نامِ ولی ساخت: parent_id فقط از خودِ ولی پذیرفته می‌شود)؛ ساختنِ تازه فقط نوبتِ مشاور. */
function cloudRecipientMsg(scope, row, existing) {
  if (!row || row === existing) return { ok: false, error: 'role_denied' };
  if (!parentMsgs.isRecipient(scope.role, scope.uid, row)) return { ok: false, error: 'out_of_scope' };
  if (existing && !parentMsgs.isRecipient(scope.role, scope.uid, existing)) return { ok: false, error: 'out_of_scope' };
  if (existing) { const fi = parentMsgs.fixedChanged(row, existing); if (fi) return { ok: false, error: fi }; }
  if (!scope.studentIds.includes(Number(row.student_id))) return { ok: false, error: 'out_of_scope' };
  if (Number(row.replied_by) !== scope.uid) return { ok: false, error: 'not_author' };
  const st = String(row.status || 'open');
  if (st === 'open') return { ok: false, error: 'bad_status' };
  if (st === 'scheduled' && scope.role !== 'counselor') return { ok: false, error: 'bad_status' };
  return { ok: true };
}

/* ── شرط SQL روی alias `r` (جدول product) با پارامترهای شماره‌دار ──
   خروجی: { sql, params } — کالکشن‌های ناخوانا هرگز مطابقت نمی‌کنند. */
function sqlPredicate(scope, startIndex = 1) {
  if (!scope || scope.all) return { sql: 'true', params: [] };
  const params = [];
  const ph = (v) => { params.push(v); return '$' + (startIndex + params.length - 1); };
  const role = scope.role;
  const pieces = [];

  /* ردیف ۱۹۴: کالکشن‌هایی که تیک‌ها برای کل مدرسه باز کرده‌اند — بی‌شرط (نام‌ها از فهرست ثابت policy) */
  const granted = Object.keys(policy.COLLECTIONS).filter(c => policy.collectionAllowed(c) && (scope.grantRead || []).includes(c));
  if (granted.length) pieces.push(`r.collection in (${granted.map(c => `'${c}'`).join(',')})`);
  const readable = Object.keys(policy.COLLECTIONS).filter(c => policy.collectionAllowed(c) && policy.canRead(role, c) && !granted.includes(c));
  const open = OPEN_COLLECTIONS.filter(c => readable.includes(c));
  if (open.length) pieces.push(`r.collection in (${open.map(c => `'${c}'`).join(',')})`);

  if (readable.includes('users')) {
    pieces.push(`(r.collection = 'users' and (r.record_id = ${ph(scope.uid)} or r.record_id = any(${ph(scope.studentIds)}::bigint[])))`);
  }
  /* ردیف ۱۹۷ (Q12 / F29): مشاور پروندهٔ کامل را می‌بیند (جای قاعدهٔ ردیف ۱۸۷ «بی‌نمره») */
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
  if (readable.includes('announcements')) {
    pieces.push(`(r.collection = 'announcements' and (coalesce(r.data->>'class_id', '') = '' or ${BIG('class_id')} = any(${ph(scope.classIds)}::bigint[]) or ${BIG('author_id')} = ${ph(scope.uid)}))`);
  }
  if (readable.includes('counselor_refs') || readable.includes('counselor_notes')) {
    const cols = ['counselor_refs', 'counselor_notes'].filter(c => readable.includes(c));
    pieces.push(`(r.collection in (${cols.map(c => `'${c}'`).join(',')}) and ${role === 'counselor' ? 'true' : 'false'})`);
    if (role === 'teacher' && cols.includes('counselor_refs')) {
      pieces.push(`(r.collection = 'counselor_refs' and ${BIG('referred_by')} = ${ph(scope.uid)})`);
    }
  }
  /* ردیف ۱۹۷ (Q12 / F27، F29): آینهٔ rowInScope بالا */
  if (readable.includes('parent_msgs')) {
    if (role === 'parent') pieces.push(`(r.collection = 'parent_msgs' and ${BIG('student_id')} = any(${ph(scope.studentIds)}::bigint[]))`);
    else if (role === 'teacher') pieces.push(`(r.collection = 'parent_msgs' and r.data->>'to' = 'teacher' and ${BIG('teacher_id')} = ${ph(scope.uid)})`);
    else if (role === 'counselor') pieces.push(`(r.collection = 'parent_msgs' and r.data->>'to' = 'counselor')`);
  }
  if (readable.includes('contributions') && role === 'parent') {
    pieces.push(`(r.collection = 'contributions' and ${BIG('student_id')} = any(${ph(scope.studentIds)}::bigint[]))`);
  }

  return { sql: pieces.length ? '(' + pieces.join(' or ') + ')' : 'false', params };
}

module.exports = {
  build, emptyScope, rowInScope, canWriteRow,
  canReadCollection, canWriteCollection, sqlPredicate, outOfScopeError,
  OPEN_COLLECTIONS, STUDENT_COLLECTIONS,
};
