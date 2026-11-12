'use strict';
/* ───────────────────────────────────────────────────────────────────
   سیاست دسترسی — همان ایدهٔ fail-closed پایش اصلی
   هر کالکشن ناشناس = رد. هر نقش ناشناس = رد. اسکوپ خواندن سمت سرور.
   کلاینت هرگز مرجع امنیتی نیست.
   ─────────────────────────────────────────────────────────────────── */

const ROLES = ['manager', 'teacher', 'parent', 'student', 'counselor', 'guard'];

const ATT_STATUS = ['present', 'absent', 'late', 'early_exit', 'excused'];
const GRADE_KINDS = ['monthly', 'midterm', 'final', 'practical', 'theory'];
/* درخواست مرخصی ولی/دانش‌آموز فقط با این وضعیت‌ها ثبت می‌شود؛ تأیید و رد با مدرسه است (ردیف ۷۴، موج ۵). */
const LEAVE_REQUEST_STATUSES = ['pending', 'canceled'];

/* write: نقش‌های مجاز به نوشتن · read: all یا فهرست نقش‌ها */
const COLLECTIONS = {
  schools:          { write: ['manager'], read: 'all' },
  school_years:     { write: ['manager'], read: 'all' },
  users:            { write: ['manager'], read: 'all' },
  classes:          { write: ['manager'], read: 'all' },
  subjects:         { write: ['manager'], read: 'all' },
  /* پایه‌ها و رشته‌ها (تعریف‌های مدرسه) — فقط مدیر می‌نویسد، همه می‌خوانند */
  lookups:          { write: ['manager'], read: 'all' },
  schedule:         { write: ['manager'], read: 'all' },
  bell_schedules:   { write: ['manager'], read: 'all' },
  /* جابه‌جای موقتِ زنگ‌ها (دبیر جایگزین برای یک تاریخ) */
  substitutions:    { write: ['manager'], read: 'all' },
  attendance:       { write: ['manager', 'teacher'], read: 'all' },
  grades:           { write: ['manager', 'teacher'], read: 'all' },
  announcements:    { write: ['manager'], read: 'all' },
  leaves:           { write: ['manager', 'teacher', 'parent', 'student'], read: 'all' },
  parent_links:     { write: ['manager'], read: ['manager', 'parent'] },
  internships:      { write: ['manager', 'teacher'], read: 'all' },
  staff_attendance: { write: ['manager'], read: ['manager'] },
  staff_posts:      { write: ['manager'], read: ['manager', 'teacher'] },
  counselor_refs:   { write: ['manager', 'counselor'], read: ['manager', 'counselor'] },
  counselor_notes:  { write: ['counselor', 'manager'], read: ['counselor'] },
  discipline:       { write: ['manager', 'teacher', 'counselor'], read: ['manager', 'teacher', 'counselor', 'parent'] },
  homework:         { write: ['manager', 'teacher'], read: 'all' },
  exams:            { write: ['manager'], read: 'all' },
  calendar:         { write: ['manager'], read: 'all' },
  app_settings:     { write: ['manager'], read: ['manager'] },
  /* ردیف‌هایی از ورود دسته‌ای که کامل نشدند — برای پیگیری بعدی مدیر */
  import_issues:    { write: ['manager'], read: ['manager'] },
  /* D‑28: تعارض‌ها فقط از سمت سرور ساخته/حل می‌شوند؛ کلاینت هیچ‌گاه نمی‌نویسد */
  conflicts:        { write: [], read: ['manager'] },
};

const PROTECTED = new Set(['audit', 'devices', 'sessions', 'pair_codes', 'sync_log']);

function collectionAllowed(name) {
  return Object.prototype.hasOwnProperty.call(COLLECTIONS, name) && !PROTECTED.has(name);
}

function canWrite(role, collection) {
  if (!collectionAllowed(collection)) return false;
  const c = COLLECTIONS[collection];
  return Array.isArray(c.write) && c.write.includes(role);
}

function canRead(role, collection) {
  if (PROTECTED.has(collection)) return false;
  if (!collectionAllowed(collection)) return false;
  const c = COLLECTIONS[collection];
  return c.read === 'all' || (Array.isArray(c.read) && c.read.includes(role));
}

/* ── اسکوپ: چه چیزی را این کاربر می‌تواند ببیند ── */
function buildScope(store, user) {
  const scope = {
    role: user.role,
    selfId: Number(user.id),
    classIds: new Set(),
    studentIds: new Set(),
    cohorts: new Set(),
  };
  if (user.role === 'manager') {
    scope.all = true;
    return scope;
  }
  if (user.role === 'teacher') {
    const rows = store.byRef('schedule', 'ref2', user.id);
    rows.forEach(s => { if (s.class_id != null) scope.classIds.add(Number(s.class_id)); });
    if (user.class_id) scope.classIds.add(Number(user.class_id));
    store.all('users').forEach(u => {
      if (u.role === 'student' && scope.classIds.has(Number(u.class_id))) scope.studentIds.add(Number(u.id));
    });
    return scope;
  }
  if (user.role === 'parent') {
    store.all('parent_links').forEach(l => {
      if (Number(l.parent_id) === Number(user.id)) scope.studentIds.add(Number(l.student_id));
    });
    scope.studentIds.forEach(sid => {
      const st = store.get('users', sid);
      if (st && st.class_id != null) scope.classIds.add(Number(st.class_id));
      if (st && st.grade) scope.cohorts.add(String(st.grade).trim() + '|' + String(st.branch || '').trim());
    });
    return scope;
  }
  if (user.role === 'student') {
    scope.studentIds.add(Number(user.id));
    if (user.class_id != null) scope.classIds.add(Number(user.class_id));
    if (user.grade) scope.cohorts.add(String(user.grade).trim() + '|' + String(user.branch || '').trim());
    return scope;
  }
  return scope;
}

/* آیا این ردیف در محدودهٔ کاربر هست؟ */
function rowInScope(scope, collection, row) {
  if (scope.all) return true;
  const uid = scope.selfId;
  switch (collection) {
    case 'users':
      return Number(row.id) === uid || scope.studentIds.has(Number(row.id));
    case 'attendance':
    case 'grades':
    case 'internships':
      return scope.studentIds.has(Number(row.student_id)) ||
        (scope.role === 'teacher' && scope.classIds.has(Number(row.class_id)));
    case 'leaves':
      return Number(row.student_id) === uid || scope.studentIds.has(Number(row.student_id));
    case 'parent_links':
      return Number(row.parent_id) === uid;
    case 'schedule':
      return scope.classIds.has(Number(row.class_id)) ||
        (row.grade && scope.cohorts && scope.cohorts.has(String(row.grade).trim() + '|' + String(row.branch || '').trim())) ||
        (scope.role === 'teacher' && Number(row.teacher_id) === uid);
    case 'classes':
      return scope.classIds.has(Number(row.id));
    case 'subjects':
      return true;
    case 'announcements':
    case 'calendar':
    case 'exams':
    case 'homework':
    case 'schools':
    case 'school_years':
    case 'bell_schedules':
      return true;
    case 'substitutions':
      return row.class_id == null || scope.classIds.has(Number(row.class_id));
    case 'discipline':
      return scope.studentIds.has(Number(row.student_id)) ||
        (scope.role === 'teacher' && scope.classIds.has(Number(row.class_id)));
    case 'counselor_refs':
    case 'counselor_notes':
      return scope.role === 'counselor' || scope.role === 'manager';
    case 'staff_attendance':
    case 'staff_posts':
    case 'app_settings':
      return scope.role === 'manager';
    default:
      return false;
  }
}

/* آیا کاربر اجازهٔ نوشتن این ردیف را دارد؟ (مالکیت، نه فقط نقش) */
function canWriteRow(store, user, role, collection, row, existing) {
  if (!canWrite(role, collection)) return { ok: false, error: 'role_denied' };
  if (role === 'manager') return { ok: true };

  if (role === 'teacher') {
    const rows = store.byRef('schedule', 'ref2', user.id);
    const myClasses = new Set(rows.map(s => Number(s.class_id)).filter(Boolean));
    if (user.class_id) myClasses.add(Number(user.class_id));
    const belongs = (cid) => cid != null && myClasses.has(Number(cid));

    if (collection === 'attendance') {
      if (!belongs(row.class_id)) return { ok: false, error: 'out_of_scope' };
      const st = store.get('users', row.student_id);
      if (!st || Number(st.class_id) !== Number(row.class_id)) return { ok: false, error: 'student_not_in_class' };
      if (!ATT_STATUS.includes(row.status)) return { ok: false, error: 'bad_status' };
      return { ok: true };
    }
    if (collection === 'grades') {
      if (!belongs(row.class_id)) return { ok: false, error: 'out_of_scope' };
      if (row.score != null && (Number(row.score) < 0 || Number(row.score) > 20)) return { ok: false, error: 'bad_score' };
      if (row.kind && !GRADE_KINDS.includes(row.kind)) return { ok: false, error: 'bad_kind' };
      /* تأیید نمره فقط با مدیر است */
      if (row.status === 'approved' && (!existing || existing.status !== 'approved')) {
        row.status = 'pending';
      }
      return { ok: true };
    }
    if (collection === 'leaves') return { ok: true };
    if (collection === 'internships') {
      const st = store.get('users', row.student_id);
      if (!st || !belongs(st.class_id)) return { ok: false, error: 'out_of_scope' };
      return { ok: true };
    }
    if (collection === 'discipline') {
      if (!belongs(row.class_id)) return { ok: false, error: 'out_of_scope' };
      return { ok: true };
    }
    return { ok: false, error: 'role_denied' };
  }

  if (role === 'parent' || role === 'student') {
    if (collection !== 'leaves') return { ok: false, error: 'role_denied' };
    const scope = buildScope(store, user);
    if (!scope.studentIds.has(Number(row.student_id))) return { ok: false, error: 'out_of_scope' };
    /* ولی فقط درخواست می‌دهد؛ تأیید با مدرسه است */
    if (row.status && !LEAVE_REQUEST_STATUSES.includes(row.status)) row.status = 'pending';
    return { ok: true };
  }

  if (role === 'counselor') {
    if (collection === 'counselor_refs' || collection === 'counselor_notes') return { ok: true };
    return { ok: false, error: 'role_denied' };
  }

  return { ok: false, error: 'role_denied' };
}

/* ══════════════════════════════════════════════════════════════════
   ردیف ۵۷ (مرحلهٔ دوم — بازبینی مستقل P0) — allowlist فیلدهای کاربر

   قاعده: هر چیزی بیرون از این فهرست، هرگز به نقش غیرمدیر داده نمی‌شود
   (blacklist سابق فقط password_hash/phone_hash/password_plain را پاک
   می‌کرد و password_enc — رمزِ پلمپ‌شدهٔ قابل‌بازخوانی — نشت می‌کرد).

   فیلدهای هویتی/حریم‌خصوصی (USER_IDENTITY_FIELDS) از allowlist عمومی
   حذف شدند: در بازبینی مستقل (P0) کد ملیِ هر کاربر برای هر نقش
   غیرمدیر قابل‌مشاهده بود.

   تصمیم طراحی — آیا معلم/والد برای کار روزمره به کد ملی نیاز دارد؟
   بررسی مسیرهای کلاینت: خیر.
     • دبیر در «دانش‌آموزان من»/حضور و غیاب فقط نام، کلاس و نمره می‌بیند
       (PAGES.students در client/pages.js)؛
     • ولی در صفحهٔ «فرزند» فقط نمره، حضور و مرخصی می‌بیند (PAGES.child)؛
     • هیچ الگوی کلایتی برای نقش غیرمدیر از national_id/شمارۀ ولی
       استفاده نمی‌کند (کاربردها همه-manager: مدیریت کاربران، ورود
       دسته‌ای، یابندۀ موارد تکراری).
   بنابراین: فیلدهای هویتی فقط در ردیفِ خودِ کاربر (self) می‌مانند
   («دادهٔ خودش» نشت نیست — /api/me و صفحهٔ «پرونده») و در ردیفِ دیگران
   — حتی درون اسکوپ (دبیرِ کلاسِ خودش، ولیِ فرزندِ خودش) — حذف می‌شوند.
   هرچیزِ رازگونه (password_*، phone_hash، __password_verifier،
   secret*، token*، pin_hash) هرگز.
   ═════════════════════════════════════════════════════════════════ */

/* فیلدهای هویتی/حریم‌خصوصی — خارج از allowlist عمومی؛ فقط روی ردیف self */
const USER_IDENTITY_FIELDS = new Set([
  'national_id', 'father_nid', 'mother_nid',
  'shenasname_serial', 'shenasname_seri',
  'phone', 'father_phone', 'mother_phone', 'landline',
  'address', 'residence', 'village', 'residence_status',
]);

const USER_PUBLIC_FIELDS = new Set([
  'id', 'name', 'role', 'class_id', 'subject', 'active',
  'position', 'created_at', 'updated_at', 'followup_reason', '_version',
  /* فیلدهای تکمیلیِ ورود دسته‌ای (IMP_STORE_FIELDS در server/index.js) —
     به جز فیلدهای هویتی که به USER_IDENTITY_FIELDS منتقل شدند */
  'first_name', 'last_name', 'birth_date', 'gender', 'grade', 'mode',
  'father_name', 'mother_name',
  'field', 'last_gpa', 'failed_count', 'father_edu', 'father_alive', 'father_job',
  'mother_edu', 'mother_alive', 'mother_job', 'guardian', 'guardian_alive', 'sisters', 'brothers',
  'covered', 'org_type', 'org_percent', 'talent', 'degree',
]);

/* الگوی فیلد رازگونه — برای بازرسی و پاکسازی در هر مسیری که users می‌رود */
const SECRET_FIELD_RE = /^(password_|pin_|phone_hash$|__password_verifier$|secret|token|accessKey|verifier$)/;

function isSecretField(key) {
  const k = String(key || '');
  return SECRET_FIELD_RE.test(k) || k === 'phone_hash' || k === '__password_verifier' || k === 'accessKey';
}

/* کپیِAllowlist‌شدهٔ یک ردیف users — فقط فیلدهای مجاز؛ بقیه حذف می‌شوند.
   { keepIdentity: true } فیلدهای هویتی را هم نگه می‌دارد — فقط برای
   ردیفِ خودِ کاربر (self) به‌کار برده می‌شود (scrubUserFor). */
function scrubUser(data, opts) {
  const keepIdentity = !!(opts && opts.keepIdentity);
  const out = {};
  for (const k of Object.keys(data || {})) {
    if (isSecretField(k)) continue;                       /* رازها هرگز */
    if (USER_IDENTITY_FIELDS.has(k)) {                    /* هویتی: فقط self */
      if (keepIdentity) out[k] = data[k];
      continue;
    }
    if (USER_PUBLIC_FIELDS.has(k)) out[k] = data[k];
  }
  return out;
}

/* پاک‌سازیِ ردیف users برای یک دیدگر غیرمدیر: فیلدهای هویتی فقط در
   ردیفِ خودِ دیدگر باقی می‌مانند (دادهٔ خودش نشت نیست)؛ در ردیفِ دیگران
   — حتی داخل اسکوپ (دانش‌آموزِ کلاسِ دبیر، فرزندِ ولی) — حذف می‌شوند.
   viewer = { id } (شناسهٔ کاربرِ دیدگر)؛ manager‌ها اصلاً اینجا نمی‌رسند. */
function scrubUserFor(viewer, data) {
  const self = !!(viewer && data && Number(viewer.id) === Number(data.id));
  return scrubUser(data, { keepIdentity: self });
}

/* حذفِ صرفِ فیلدهای هویتی از یک ردیفِ ازپیش‌ساخته (مانند userRow در
   server/index.js) — برای مسیرهایی که خودشان فیلدها را چیده‌اند. */
function scrubUserIdentity(data) {
  const out = Object.assign({}, data);
  for (const k of Object.keys(out)) {
    if (USER_IDENTITY_FIELDS.has(k)) delete out[k];
  }
  return out;
}

module.exports = {
  ROLES, ATT_STATUS, GRADE_KINDS, LEAVE_REQUEST_STATUSES, COLLECTIONS,
  collectionAllowed, canRead, canWrite, buildScope, rowInScope, canWriteRow,
  USER_PUBLIC_FIELDS, USER_IDENTITY_FIELDS, SECRET_FIELD_RE, isSecretField,
  scrubUser, scrubUserFor, scrubUserIdentity,
};
