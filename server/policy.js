'use strict';
const finance = require('./school-finance');
/* ───────────────────────────────────────────────────────────────────
   سیاست دسترسی — همان ایدهٔ fail-closed پایش اصلی
   هر کالکشن ناشناس = رد. هر نقش ناشناس = رد. اسکوپ خواندن سمت سرور.
   کلاینت هرگز مرجع امنیتی نیست.
   ─────────────────────────────────────────────────────────────────── */

const ROLES = ['manager', 'teacher', 'parent', 'student', 'counselor', 'guard', 'staff', 'office'];

/* ردیف ۱۸۷: نقشِ «نمایشی» → نقشِ «مجوز». معاون دقیقاً همهٔ دسترسی‌های مدیر را دارد
   (همان تعریفِ مخزن p2: معاون = کاربرِ مدیر با عنوانِ معاون). پیش از این «vice» در
   ROLES نبود و fail-closed همه‌چیز را رد می‌کرد ⇒ «نقش شما به این بخش دسترسی ندارد».
   همهٔ گاردها (سرور محلی، ابر، صندوقچه، وب و گوشی) از همین نگاشت می‌خوانند. */
const ROLE_ALIASES = Object.freeze({ vice: 'manager', deputy: 'manager' });
/* همهٔ نقش‌هایی که می‌شود به کاربر داد (نمایشی) — ساخت/ویرایش کاربر، پشتیبان و صندوقچه */
const USER_ROLES = Object.freeze([...ROLES, 'vice']);
function permRole(role) {
  const r = String(role == null ? '' : role);
  return Object.prototype.hasOwnProperty.call(ROLE_ALIASES, r) ? ROLE_ALIASES[r] : r;
}

const ATT_STATUS = ['present', 'absent', 'late', 'early_exit', 'excused'];
const GRADE_KINDS = ['monthly', 'midterm', 'final', 'practical', 'theory'];
/* درخواست مرخصی ولی/دانش‌آموز فقط با این وضعیت‌ها ثبت می‌شود؛ تأیید و رد با مدرسه است (ردیف ۷۴، موج ۵). */
const LEAVE_REQUEST_STATUSES = ['pending', 'canceled'];

/* ردیف ۱۹۷ (Q02 / F25): شکل کامل مرخصی — همان قواعد packages/payesh_sync/lib/src/leave_spec.dart
   و client/pages.js `leaveIssue`. روزانه (یک روز یا بازهٔ حداکثر ۳۱ روزه) یا ساعتی (ساعت از–تا)،
   نوع مرخصی، و پیوست گواهی (فقط data URI عکس JPG/PNG، حداکثر ۶۰٬۰۰۰ نویسه). */
const LEAVE_TYPES = ['sick', 'family', 'personal', 'travel', 'other'];
const LEAVE_MAX_DAYS = 31;
const LEAVE_ATTACH_MAX = 60000;
function leaveDay(v) {
  const t = String(v == null ? '' : v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = new Date(t + 'T00:00:00Z');
  return isNaN(d) || d.toISOString().slice(0, 10) !== t ? null : d;
}
function leaveIssue(row) {
  if (!row) return null;
  const from = leaveDay(row.date);
  if (!from) return 'bad_date';
  const kind = row.kind == null || row.kind === '' ? 'day' : String(row.kind);
  if (kind !== 'day' && kind !== 'hours') return 'bad_kind';
  const to = row.date_to == null ? '' : String(row.date_to);
  if (kind === 'day' && to) {
    const t = leaveDay(to);
    if (!t) return 'bad_date';
    if (t < from) return 'bad_range';
    if (Math.round((t - from) / 86400000) + 1 > LEAVE_MAX_DAYS) return 'range_too_long';
  }
  if (kind === 'hours') {
    const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
    const a = String(row.time_from || ''), b = String(row.time_to || '');
    if (!hm.test(a) || !hm.test(b) || a >= b) return 'bad_time';
    if (to && to !== String(row.date)) return 'bad_range';
  }
  if (row.type != null && row.type !== '' && !LEAVE_TYPES.includes(String(row.type))) return 'bad_type';
  if (String(row.reason || '').trim().length > 500) return 'reason_too_long';
  const att = row.attachment == null ? '' : String(row.attachment);
  if (att && (att.length > LEAVE_ATTACH_MAX || !/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(att))) return 'bad_attachment';
  return null;
}
/* ولی/دانش‌آموز/دبیر: درخواستِ بررسی‌شده دیگر عوض نمی‌شود (جز «لغو» پیش از بررسی) */
function leaveRequesterIssue(row, existing) {
  if (existing && existing.status && !LEAVE_REQUEST_STATUSES.includes(String(existing.status))) return 'leave_decided';
  return leaveIssue(row);
}

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
  /* ردیف ۱۸۷ (p2): انضباط را مدیر و دبیر ثبت می‌کنند؛ مشاور فقط می‌خواند (canWriteRow هم رد می‌کرد) */
  discipline:       { write: ['manager', 'teacher'], read: ['manager', 'teacher', 'counselor', 'parent'] },
  homework:         { write: ['manager', 'teacher'], read: 'all' },
  exams:            { write: ['manager'], read: 'all' },
  calendar:         { write: ['manager'], read: 'all' },
  app_settings:     { write: ['manager'], read: ['manager'] },
  /* ردیف‌هایی از ورود دسته‌ای که کامل نشدند — برای پیگیری بعدی مدیر */
  import_issues:    { write: ['manager'], read: ['manager'] },
  /* D‑28: تعارض‌ها فقط از سمت سرور ساخته/حل می‌شوند؛ کلاینت هیچ‌گاه نمی‌نویسد */
  conflicts:        { write: [], read: ['manager'] },
  /* ردیف ۱۹۷ (Q06 / F38، F44): دفتر مراجعینِ درِ مدرسه — مدیر، و نگهبان با ناحیهٔ «درِ مدرسه» */
  visitors:         { write: ['manager'], read: ['manager'] },
  /* ردیف ۱۹۷ (Q07 / F32, F33): کمک داوطلبانه (و شهریهٔ غیرانتفاعی) و هیئت امنا — فقط مدیر */
  contributions:    { write: ['manager'], read: ['manager'] },
  trustees:         { write: ['manager'], read: ['manager'] },
};

const PROTECTED = new Set(['audit', 'devices', 'sessions', 'pair_codes', 'sync_log']);

/* ── ردیف ۱۹۴: «سطح دسترسی» عوامل اجرایی ─────────────────────────────
   مدیر برای هر کارمند/اجرایی/نگهبان/مشاور تیک می‌زند؛ فهرست کلیدها روی ردیف کاربر
   در `access` می‌ماند. هر ناحیه: کالکشن‌هایی که مثل مدیر می‌نویسد (write) و
   کالکشن‌هایی که از کل مدرسه می‌بیند (read). معاون نیست (همهٔ دسترسی مدیر را
   دارد) و هیچ ناحیه‌ای users، parent_links یا app_settings را نمی‌نویسد — پس
   کسی با تیک نمی‌تواند نقش یا دسترسی خودش را بالا ببرد.
   رونوشتِ همین فهرست در apps/payesh/packages/payesh_sync/lib/src/staff_access.dart است
   و test/staff_access_test.dart جدا شدنشان را می‌گیرد. */
const GRANTABLE_ROLES = Object.freeze(['counselor', 'staff', 'office', 'guard']);
const STAFF_ACCESS = Object.freeze({
  attendance: { write: ['attendance'], read: ['attendance', 'users', 'classes', 'schedule'] },
  leaves:     { write: ['leaves'], read: ['leaves', 'users', 'classes'] },
  notices:    { write: ['announcements'], read: ['announcements'] },
  schedule:   { write: ['schedule', 'bell_schedules', 'substitutions'], read: ['schedule', 'substitutions', 'classes', 'users'] },
  classes:    { write: ['classes', 'subjects', 'lookups'], read: ['classes', 'users'] },
  grades:     { write: ['grades'], read: ['grades', 'users', 'classes'] },
  reports:    { write: [], read: ['attendance', 'grades', 'discipline', 'users', 'classes'] },
  counsel:    { write: ['counselor_refs'], read: ['counselor_refs', 'users'] },
  /* ردیف ۱۹۷ (Q06): نگهبان — ثبت مراجعین و دیدن خروج زودهنگامِ مرخصی‌دارِ امروز */
  gate:       { write: ['visitors'], read: ['visitors', 'leaves', 'users', 'classes'] },
});

/* ردیف ۱۹۷ (Q06 / F41، F42، F44): پیش‌فرض واقعی هر سمت. تا مدیر برای کسی چیزی تیک نزده
   (access خالی یا نبود)، همین ناحیه‌ها باز است؛ تیک مدیر جای پیش‌فرض را می‌گیرد و
   «هیچ» صریح به‌صورت ['none'] ذخیره می‌شود (یعنی واقعاً هیچ — راهنمای «دسترسی ندارید»).
   پیش از این بی‌تیک = هیچ بود و کارمند/اجرایی/نگهبان فقط «اطلاعیه‌ها/سیستم» می‌دید.
   رونوشت در staff_access.dart (`roleDefaultAccess`) — tests/access-194.js برابری را می‌گیرد. */
const ACCESS_NONE = 'none';
const ROLE_DEFAULT_ACCESS = Object.freeze({
  staff:     Object.freeze(['attendance', 'leaves', 'notices']),
  office:    Object.freeze(['attendance', 'leaves', 'notices', 'classes', 'grades', 'reports']),
  guard:     Object.freeze(['gate']),
  counselor: Object.freeze([]),
});
function accessRaw(access) {
  const raw = Array.isArray(access) ? access : String(access == null ? '' : access).split(',');
  return raw.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
}

/* کلیدهای شناخته‌شدهٔ access (فهرست یا رشتهٔ ویرگولی)؛ برای نقشی که تیک‌پذیر نیست خالی */
function staffAccessOf(role, access) {
  const r = permRole(role);
  if (!GRANTABLE_ROLES.includes(r)) return [];
  const raw = accessRaw(access);
  if (raw.includes(ACCESS_NONE)) return [];
  if (!raw.length) return [...(ROLE_DEFAULT_ACCESS[r] || [])];
  const want = new Set(raw);
  return Object.keys(STAFF_ACCESS).filter(k => want.has(k));
}
/* ردیف ۱۹۷ (Q06): آنچه روی ردیف کاربر ذخیره می‌شود — [] = «پیش‌فرض سمت»، ['none'] = هیچ،
   وگرنه فقط کلیدهای شناخته. فهرستی که هیچ کلید شناخته‌ای ندارد = هیچ (fail-closed). */
function accessToStore(role, access) {
  if (!GRANTABLE_ROLES.includes(permRole(role))) return [];
  const raw = accessRaw(access);
  if (raw.includes(ACCESS_NONE)) return [ACCESS_NONE];
  if (!raw.length) return [];
  const want = new Set(raw);
  const known = Object.keys(STAFF_ACCESS).filter(k => want.has(k));
  return known.length ? known : [ACCESS_NONE];
}
/* ردیف ۱۹۷ (Q06): نگهبانی که مرخصی‌ها را فقط از راه «درِ مدرسه» می‌بیند — فقط تاریخ/ساعت و
   وضعیت می‌گیرد؛ علت و گواهی پیوست (پزشکی) به او نمی‌رسد. */
function gateLeavesOnly(user) {
  if (!user) return false;
  const a = staffAccessOf(user.role, user.access);
  return a.includes('gate') && !a.includes('leaves');
}
const GATE_LEAVE_FIELDS = ['id', 'student_id', 'date', 'date_to', 'kind', 'time_from', 'time_to', 'status', 'type', '_version'];
function leaveForGate(data) {
  const out = {};
  for (const k of GATE_LEAVE_FIELDS) if (data && data[k] !== undefined) out[k] = data[k];
  return out;
}
/* ردیف ۱۹۷ (Q06): شکل ردیف مراجع — همان visitorIssue در payesh_sync/lib/src/gate.dart */
function visitorIssue(row) {
  if (!row) return null;
  const name = String(row.name == null ? '' : row.name).trim();
  if (!name) return 'visitor_name';
  if (name.length > 80) return 'visitor_name';
  if (String(row.phone || '').replace(/\D/g, '').length > 15) return 'visitor_phone';
  if (String(row.reason || '').length > 200 || String(row.host || '').length > 80) return 'visitor_too_long';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.date || ''))) return 'bad_date';
  const at = Date.parse(String(row.in_at || ''));
  if (!Number.isFinite(at)) return 'bad_time';
  if (row.out_at != null && row.out_at !== '') {
    const out = Date.parse(String(row.out_at));
    if (!Number.isFinite(out) || out < at) return 'bad_time';
  }
  return null;
}
function grantWrites(user) {
  const out = new Set();
  if (!user) return out;
  for (const k of staffAccessOf(user.role, user.access)) STAFF_ACCESS[k].write.forEach(c => out.add(c));
  return out;
}
function grantReads(user) {
  const out = new Set();
  if (!user) return out;
  for (const k of staffAccessOf(user.role, user.access)) {
    STAFF_ACCESS[k].read.forEach(c => out.add(c));
    STAFF_ACCESS[k].write.forEach(c => out.add(c));
  }
  return out;
}
/* نقش + تیک‌های خودِ کاربر — مسیرهای همگام‌سازی از این دو استفاده می‌کنند */
function canWriteFor(user, collection) {
  if (!user) return false;
  if (canWrite(user.role, collection)) return true;
  return collectionAllowed(collection) && grantWrites(user).has(collection);
}
function canReadFor(user, collection) {
  if (!user) return false;
  if (canRead(user.role, collection)) return true;
  return collectionAllowed(collection) && grantReads(user).has(collection);
}



function collectionAllowed(name) {
  return Object.prototype.hasOwnProperty.call(COLLECTIONS, name) && !PROTECTED.has(name);
}

function canWrite(role, collection) {
  role = permRole(role);
  if (!collectionAllowed(collection)) return false;
  const c = COLLECTIONS[collection];
  return Array.isArray(c.write) && c.write.includes(role);
}

function canRead(role, collection) {
  role = permRole(role);
  if (PROTECTED.has(collection)) return false;
  if (!collectionAllowed(collection)) return false;
  const c = COLLECTIONS[collection];
  return c.read === 'all' || (Array.isArray(c.read) && c.read.includes(role));
}

/* ── اسکوپ: چه چیزی را این کاربر می‌تواند ببیند ── */
function buildScope(store, user) {
  user = Object.assign({}, user, { role: permRole(user && user.role) });
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
  /* ردیف ۱۹۴: کالکشن‌هایی که تیک‌های مدیر برای کل مدرسه باز کرده‌اند */
  scope.grantRead = grantReads(user);
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
  /* ردیف ۱۸۷ (تعریفِ p2): مشاور فقط دانش‌آموزانِ «ارجاع‌شده» به صف خودش را می‌بیند —
     نام، پایه/رشته و دادهٔ الگو (حضور/انضباط)؛ نه نمره، نه برنامه، نه پروندهٔ کامل. */
  if (user.role === 'counselor') {
    store.all('counselor_refs').forEach(r => {
      if (r && r.student_id != null && !r.deleted_at) scope.studentIds.add(Number(r.student_id));
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
  if (scope.grantRead && scope.grantRead.has(collection)) return true;
  const uid = scope.selfId;
  switch (collection) {
    case 'users':
      return Number(row.id) === uid || scope.studentIds.has(Number(row.id));
    case 'grades':
    case 'internships':
      if (scope.role === 'counselor') return false;
      return scope.studentIds.has(Number(row.student_id)) ||
        (scope.role === 'teacher' && scope.classIds.has(Number(row.class_id)));
    case 'attendance':
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
    /* ردیف ۱۹۷ (Q06): مراجعین فقط برای مدیر یا ناحیهٔ «درِ مدرسه» (grantRead بالا) */
    case 'visitors':
      return scope.role === 'manager';
    default:
      return false;
  }
}

/* آیا کاربر اجازهٔ نوشتن این ردیف را دارد؟ (مالکیت، نه فقط نقش) */
function canWriteRow(store, user, role, collection, row, existing) {
  role = permRole(role);
  /* ردیف ۱۹۴: ناحیهٔ تیک‌خورده ⇒ همان قواعد مدیر برای همین کالکشن (و فقط همین) */
  /* ردیف ۱۹۷: درخواست مرخصی ناقص/نادرست از هیچ نقشی پذیرفته نمی‌شود (حذف = row تهی) */
  if (collection === 'leaves' && row && row.date !== undefined) {
    const li = leaveIssue(row);
    if (li) return { ok: false, error: li };
  }
  if (collection === 'visitors' && row && row.name !== undefined) {
    const vi = visitorIssue(row);
    if (vi) return { ok: false, error: vi };
  }
  /* ردیف ۱۹۷ (Q07): شکل ردیف + «اثر واقعی» نوع مدرسه — شهریه فقط غیرانتفاعی، هیئت امنا فقط دولتی */
  if (collection === 'contributions' && row && row.amount !== undefined) {
    const ci = finance.contributionIssue(row, (store && store.get('schools', 1)) || null);
    if (ci) return { ok: false, error: ci };
  }
  if (collection === 'trustees' && row && row.kind !== undefined) {
    const ti = finance.trusteeIssue(row);
    if (ti) return { ok: false, error: ti };
    if (store && !finance.isPublicSchool(store.get('schools', 1) || null)) return { ok: false, error: 'feature_off' };
  }
  if (role !== 'manager' && grantWrites(Object.assign({}, user, { role })).has(collection)) {
    if (collection === 'attendance' && row && row.status != null && !ATT_STATUS.includes(row.status)) return { ok: false, error: 'bad_status' };
    if (collection === 'grades' && row && row.score != null && (Number(row.score) < 0 || Number(row.score) > 20)) return { ok: false, error: 'bad_score' };
    if (collection === 'grades' && row && row.kind && !GRADE_KINDS.includes(row.kind)) return { ok: false, error: 'bad_kind' };
    return { ok: true };
  }
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
    if (collection === 'leaves') {
      /* ردیف ۱۹۷: دبیر فقط درخواست ثبت می‌کند؛ تأیید/رد با مدیر/معاون است */
      const li = leaveRequesterIssue(row, existing);
      if (li) return { ok: false, error: li };
      if (row.status && !LEAVE_REQUEST_STATUSES.includes(row.status)) return { ok: false, error: 'approval_denied' };
      return { ok: true };
    }
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
    const li = leaveRequesterIssue(row, existing);
    if (li) return { ok: false, error: li };
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
  /* ردیف ۱۹۴: تیک‌های دسترسی و دروسِ دبیر (کسی که آن را می‌بیند باید بداند چه کاری از او برمی‌آید) */
  'access', 'teaches',
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
  ROLES, USER_ROLES, ROLE_ALIASES, permRole, ATT_STATUS, GRADE_KINDS, LEAVE_REQUEST_STATUSES, LEAVE_TYPES, leaveIssue, leaveRequesterIssue, COLLECTIONS,
  GRANTABLE_ROLES, STAFF_ACCESS, ACCESS_NONE, ROLE_DEFAULT_ACCESS, staffAccessOf, accessToStore,
  gateLeavesOnly, leaveForGate, visitorIssue, grantWrites, grantReads, canWriteFor, canReadFor,
  collectionAllowed, canRead, canWrite, buildScope, rowInScope, canWriteRow,
  USER_PUBLIC_FIELDS, USER_IDENTITY_FIELDS, SECRET_FIELD_RE, isSecretField,
  scrubUser, scrubUserFor, scrubUserIdentity,
};
