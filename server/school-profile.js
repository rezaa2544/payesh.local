'use strict';
/* ردیف ۱۵۰ — «مشخصات مدرسه» در تنظیمات پنل مدیر.
 *
 * فرم مالک فقط «مکان و ادارهٔ مربوطه» + «مشخصات مدیر» را دارد (برای ساخت حساب مدیر).
 * بقیهٔ مشخصات (مقطع، نوع، جنسیت، شیفت، ظرفیت، تلفن‌ها، آمار، روزهای کاری،
 * پنجرهٔ موجه، قابلیت‌ها، شاخه/رشته، بوم) را خود مدیر در تنظیمات مدرسه پر می‌کند.
 *
 * قرارداد مشترک با Dart (packages/payesh_ui/lib/src/school_profile.dart):
 *   docs/cloud/contracts/school-profile-vectors.json
 * خطاها «کد» برمی‌گردانند؛ متن فارسی را هر سمت خودش می‌سازد.
 *
 * وابستگی‌ها:
 *   • مقطع «متوسطه دوم» ⇒ دست‌کم یک شاخه؛ رشته‌ها فقط از شاخه‌های انتخاب‌شده؛
 *     مقطع دیگر ⇒ شاخه/رشته خالی می‌شود.
 *   • شیفت «شب» یا «هر دو» ⇒ قابلیت «نوبت دوم / کلاس شبانه» خودکار روشن.
 *   • تعداد دانش‌آموزان ≤ ظرفیت.
 *   • دست‌کم یک روز کاری.
 */

const LEVELS = ['ابتدایی', 'متوسطه اول', 'متوسطه دوم'];
const GENDERS = ['پسرانه', 'دخترانه'];
const SHIFTS = ['صبح', 'بعدازظهر', 'شب', 'هر دو'];
const KINDS = ['عادی', 'علوم تجربی', 'ریاضی', 'فنی و حرفه‌ای'];
const SCHOOL_TYPES = ['governmental', 'exemplary', 'non_profit', 'sampad', 'shahed', 'exceptional', 'rural', 'boarding', 'vocational'];
const CAPS = ['has_tuition', 'has_dorm', 'has_iep', 'has_workshop', 'has_multigrade', 'has_second_term_exam', 'has_evening'];
const BRANCHES = {
  'نظری': ['ریاضی فیزیک', 'علوم تجربی', 'ادبیات و علوم انسانی', 'علوم و معارف اسلامی'],
  'فنی و حرفه‌ای': ['الکتروتکنیک', 'الکترونیک', 'مکانیک خودرو', 'کامپیوتر', 'حسابداری', 'ساختمان', 'گرافیک'],
  'کاردانش': ['تعمیر لوازم خانگی', 'طراحی دوخت', 'تأسیسات', 'صنایع غذایی'],
};
/* فیلدهایی که فقط مدیر (نه فرم مالک) تعیین می‌کند */
const FIELDS = ['level', 'type', 'school_type', 'gender', 'shift', 'capacity', 'landline', 'phone',
  'staff_count', 'student_count', 'work_days', 'excuse_window_minutes', 'capabilities',
  'branches', 'fields', 'boom_goals', 'public_goals'];
const MAX = { capacity: 20000, staff: 5000, excuse: 240, boom: 2000 };

function digits(v) {
  return String(v == null ? '' : v)
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[^0-9]/g, '');
}

function intOf(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  const t = String(v).trim().replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  if (t === '') return null;
  return /^\d{1,9}$/.test(t) ? Number(t) : NaN;
}

/* نیم‌رخ فعلی مدرسه (برای فرم مدیر) — همیشه همهٔ کلیدها با پیش‌فرض p2 */
function profileOf(s) {
  s = s || {};
  const caps = {};
  for (const k of CAPS) caps[k] = s.capabilities && (s.capabilities[k] === 1 || s.capabilities[k] === true) ? 1 : 0;
  return {
    name: s.name || '', code: s.code || '', province: s.province || '', county: s.county || '', district: s.district || '',
    level: LEVELS.includes(s.level) ? s.level : '',
    type: KINDS.includes(s.type) ? s.type : 'عادی',
    school_type: SCHOOL_TYPES.includes(s.school_type) ? s.school_type : 'governmental',
    gender: GENDERS.includes(s.gender) ? s.gender : '',
    shift: SHIFTS.includes(s.shift) ? s.shift : 'صبح',
    capacity: Number.isInteger(s.capacity) ? s.capacity : 300,
    landline: digits(s.landline), phone: digits(s.phone),
    staff_count: Number.isInteger(s.staff_count) ? s.staff_count : null,
    student_count: Number.isInteger(s.student_count) ? s.student_count : null,
    work_days: Array.isArray(s.work_days) && s.work_days.length ? s.work_days.filter(d => Number.isInteger(d)) : [0, 1, 2, 3, 4],
    excuse_window_minutes: Number.isInteger(s.excuse_window_minutes) ? s.excuse_window_minutes : 15,
    capabilities: caps,
    branches: Array.isArray(s.branches) ? s.branches.map(String) : [],
    fields: Array.isArray(s.fields) ? s.fields.map(String) : [],
    boom_goals: s.boom_goals || '', public_goals: !!s.public_goals,
    complete: !!(LEVELS.includes(s.level) && GENDERS.includes(s.gender)),
  };
}

/* اعتبارسنجی + نرمال‌سازی ورودی فرم مدیر ⇒ { patch } یا { error: کد } */
function validateProfile(body) {
  const b = body && typeof body === 'object' ? body : {};
  const level = String(b.level || '');
  if (!LEVELS.includes(level)) return { error: 'level' };
  const type = String(b.type || 'عادی');
  if (!KINDS.includes(type)) return { error: 'type' };
  const schoolType = String(b.school_type || 'governmental');
  if (!SCHOOL_TYPES.includes(schoolType)) return { error: 'school_type' };
  const gender = String(b.gender || '');
  if (!GENDERS.includes(gender)) return { error: 'gender' };
  const shift = String(b.shift || 'صبح');
  if (!SHIFTS.includes(shift)) return { error: 'shift' };
  const capacity = intOf(b.capacity);
  if (capacity == null || !(capacity >= 1 && capacity <= MAX.capacity)) return { error: 'capacity' };
  const staff = intOf(b.staff_count);
  if (staff != null && !(staff >= 0 && staff <= MAX.staff)) return { error: 'staff_count' };
  const students = intOf(b.student_count);
  if (students != null && !(students >= 0)) return { error: 'student_count' };
  if (students != null && students > capacity) return { error: 'over_capacity' };
  const landline = digits(b.landline);
  if (landline && !/^0\d{6,10}$/.test(landline)) return { error: 'landline' };
  const phone = digits(b.phone);
  if (phone && !/^09\d{9}$/.test(phone)) return { error: 'phone' };
  const days = Array.isArray(b.work_days) ? [...new Set(b.work_days.map(Number))].sort((x, y) => x - y) : [];
  if (!days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return { error: 'work_days' };
  const excuse = intOf(b.excuse_window_minutes);
  if (excuse == null || !(excuse >= 0 && excuse <= MAX.excuse)) return { error: 'excuse' };
  const caps = {};
  const rc = b.capabilities && typeof b.capabilities === 'object' ? b.capabilities : {};
  for (const k of Object.keys(rc)) if (!CAPS.includes(k)) return { error: 'capabilities' };
  for (const k of CAPS) caps[k] = rc[k] === 1 || rc[k] === true ? 1 : 0;
  if (shift === 'شب' || shift === 'هر دو') caps.has_evening = 1;
  let branches = [];
  let fields = [];
  if (level === 'متوسطه دوم') {
    branches = Array.isArray(b.branches) ? [...new Set(b.branches.map(String))] : [];
    if (!branches.length) return { error: 'branches' };
    if (branches.some(x => !BRANCHES[x])) return { error: 'branches' };
    fields = Array.isArray(b.fields) ? [...new Set(b.fields.map(String))] : [];
    const allowed = new Set(branches.flatMap(x => BRANCHES[x]));
    if (fields.some(f => !allowed.has(f))) return { error: 'fields' };
  }
  const boom = String(b.boom_goals || '');
  if (boom.length > MAX.boom) return { error: 'boom_goals' };
  return { patch: {
    level, type, school_type: schoolType, gender, shift, capacity,
    landline, phone, staff_count: staff, student_count: students,
    work_days: days, excuse_window_minutes: excuse, capabilities: caps,
    branches, fields, boom_goals: boom, public_goals: b.public_goals === true,
  } };
}

module.exports = { LEVELS, GENDERS, SHIFTS, KINDS, SCHOOL_TYPES, CAPS, BRANCHES, FIELDS, MAX, profileOf, validateProfile, digits };
