'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ورود اطلاعات از اکسل — پیاده‌سازیِ کامل و هم‌رفتار با نسخهٔ p2
   (src/js/34-excel-import.js)

   چهار مرحله: انتخاب فایل ← نگاشت ستون‌ها ← بررسی خطاها ← ثبت نهایی
   چهار نوع فایل: دانش‌آموزان · دبیران · نمرات دورهٔ گذشته · حضور و غیاب

   اصل طراحی (همان اصل p2): مدرسه نباید فایلش را با قالب ما تطبیق دهد؛
   سامانه باید فایل موجود مدرسه را با هر ترتیب ستونی بفهمد.

   قواعدی که عیناً از p2 آمده‌اند:
     • نام و نام خانوادگی جدا یا یکی — هر دو حالت
     • تاریخ تولد شمسی (۱۳۹۰/۰۵/۱۲ یا ۱۳۹۰-۵-۱۲ یا میلادی)
     • جنسیت: پسر/دختر با همهٔ شکل‌های نوشتاری
     • کد ملی پدر و مادر جدا، با اعتبارسنجیِ رقم کنترلی
     • وضعیت حیات: هر عبارتی که «فوت/مرحوم/متوفی» داشته باشد
     • اعداد فارسی و معدلِ «۱۲/۸۸» (اسلش نقش ممیز دارد)
     • تحت پوشش: بله/خیر/دارد/آری
     • کلاس ناشناس ساخته می‌شود (با پایه و رشته)
     • کد ملی موجود ⇒ به‌روزرسانی، نه خطا
     • نمره و حضور با پیدا کردن دانش‌آموز و درسِ موجود ثبت می‌شوند
   ═══════════════════════════════════════════════════════════════════ */

/* ── فیلدهای قابل ورود: کلید، عنوان، الزامی، مترادف‌ها ────────────── */
const IMP_FIELDS = {
  students: [
    /* هویت — در فایل‌های واقعی مدرسه «نام» و «نام خانوادگی» جدا هستند */
    ['first_name', 'نام', 0, ['نام', 'نام دانش آموز', 'اسم']],
    ['last_name', 'نام خانوادگی', 0, ['نام خانوادگی', 'فامیل', 'فامیلی', 'نام فامیل']],
    ['full_name', 'نام و نام خانوادگی', 0, ['نام و نام خانوادگی', 'نام کامل', 'نام و نام‌خانوادگی']],
    ['national_id', 'کد ملی', 0, ['کد ملی', 'کدملی', 'شماره ملی', 'شماره‌ملی']],
    ['birth_date', 'تاریخ تولد', 0, ['تاریخ تولد', 'تولد', 'ت تولد']],
    ['gender', 'جنسیت', 0, ['جنسیت', 'جنس']],
    ['shenasname_serial', 'سریال شناسنامه', 0, ['سریال شناسنامه', 'سریال', 'شماره شناسنامه']],
    ['shenasname_seri', 'سری شناسنامه', 0, ['سری شناسنامه', 'سری']],
    /* تحصیلی */
    ['class_name', 'کلاس/شعبه در فایل (اختیاری)', 0, ['کلاس', 'نام کلاس', 'پایه و کلاس']],
    ['grade', 'پایه', 0, ['پایه', 'مقطع تحصیلی', 'سال تحصیلی', 'پایه تحصیلی']],
    ['field', 'رشته', 0, ['رشته', 'رشته تحصیلی', 'گرایش', 'رشته و گرایش']],
    ['last_gpa', 'معدل سال گذشته', 0, ['معدل سال گذشته', 'معدل قبلی', 'معدل']],
    ['failed_count', 'تعداد درس افتاده', 0, ['تعداد درس افتاده', 'درس افتاده', 'مردودی']],
    /* پدر */
    ['father_name', 'نام پدر', 0, ['نام پدر', 'پدر']],
    ['father_nid', 'کد ملی پدر', 0, ['کد ملی پدر', 'کدملی پدر', 'کد ملی ولی']],
    ['father_edu', 'تحصیلات پدر', 0, ['تحصیلات پدر', 'مدرک پدر']],
    ['father_alive', 'وضعیت حیات پدر', 0, ['وضعیت حیات پدر', 'حیات پدر']],
    ['father_job', 'شغل پدر', 0, ['شغل پدر', 'حرفه پدر']],
    ['father_phone', 'موبایل پدر', 0, ['موبایل پدر', 'شماره موبایل پدر', 'شماره همراه پدر', 'همراه پدر',
      'تلفن همراه پدر', 'تلفن پدر', 'شماره پدر', 'شماره تماس پدر', 'موبایل ۱', 'موبایل 1']],
    /* مادر */
    ['mother_name', 'نام مادر', 0, ['نام مادر', 'مادر']],
    ['mother_nid', 'کد ملی مادر', 0, ['کد ملی مادر', 'کدملی مادر']],
    ['mother_edu', 'تحصیلات مادر', 0, ['تحصیلات مادر', 'مدرک مادر']],
    ['mother_alive', 'وضعیت حیات مادر', 0, ['وضعیت حیات مادر', 'حیات مادر']],
    ['mother_job', 'شغل مادر', 0, ['شغل مادر', 'حرفه مادر']],
    ['mother_phone', 'موبایل مادر', 0, ['موبایل مادر', 'شماره موبایل مادر', 'شماره همراه مادر', 'همراه مادر',
      'تلفن همراه مادر', 'تلفن مادر', 'شماره مادر', 'شماره تماس مادر', 'موبایل ۲', 'موبایل 2']],
    /* سرپرست و خانواده */
    ['guardian', 'سرپرست دانش آموز', 0, ['سرپرست دانش آموز', 'سرپرست', 'ولی']],
    ['guardian_alive', 'وضعیت حیات', 0, ['وضعیت حیات', 'حیات']],
    ['guardian_phone', 'موبایل سرپرست', 0, ['موبایل سرپرست', 'شماره همراه سرپرست', 'همراه سرپرست',
      'موبایل ولی', 'شماره همراه ولی', 'همراه ولی', 'تلفن سرپرست', 'تلفن ولی']],
    ['sisters', 'تعداد خواهر', 0, ['تعداد خواهر', 'خواهر']],
    ['brothers', 'تعداد برادر', 0, ['تعداد برادر', 'برادر']],
    /* حمایتی */
    ['covered', 'تحت پوشش', 0, ['تحت پوشش', 'تحت‌پوشش']],
    ['org_type', 'نوع ارگان', 0, ['نوع ارگان', 'ارگان', 'نهاد حمایتی']],
    ['org_percent', 'درصد', 0, ['درصد', 'درصد حمایت']],
    ['talent', 'استعداد یابی', 0, ['استعداد یابی', 'استعدادیابی', 'استعداد']],
    /* تماس و نشانی */
    ['phone', 'موبایل دانش آموز', 0, ['موبایل دانش آموز', 'موبایل دانش‌آموز', 'همراه دانش آموز',
      'همراه دانش‌آموز', 'موبایل هنرجو', 'شماره همراه', 'تلفن همراه', 'شماره موبایل', 'همراه', 'موبایل', 'شماره تماس']],
    ['landline', 'شماره ثابت', 0, ['شماره ثابت', 'تلفن ثابت', 'ثابت', 'تلفن منزل']],
    ['residence', 'محل سکونت', 0, ['محل سکونت', 'سکونت', 'شهر یا روستا']],
    ['village', 'نام روستا', 0, ['نام روستا', 'روستا']],
    ['residence_status', 'وضعیت اقامت', 0, ['وضعیت اقامت', 'اقامت', 'تابعیت']],
    ['address', 'آدرس', 0, ['آدرس', 'نشانی', 'ادرس']],
  ],
  teachers: [
    ['first_name', 'نام', 0, ['نام', 'نام دبیر', 'نام معلم', 'اسم']],
    ['last_name', 'نام خانوادگی', 0, ['نام خانوادگی', 'فامیل', 'فامیلی']],
    ['full_name', 'نام و نام خانوادگی', 0, ['نام و نام خانوادگی', 'نام کامل']],
    ['national_id', 'کد ملی', 0, ['کد ملی', 'کدملی', 'شماره ملی']],
    ['phone', 'موبایل', 0, ['موبایل', 'تلفن همراه', 'شماره تماس', 'همراه']],
    ['subject', 'درس تخصصی', 0, ['درس', 'تخصص', 'رشته', 'درس تخصصی']],
    ['degree', 'مدرک تحصیلی', 0, ['مدرک', 'تحصیلات', 'مدرک تحصیلی']],
    ['address', 'آدرس', 0, ['آدرس', 'نشانی']],
  ],
  /* نمرات دورهٔ گذشته: دانش‌آموز با کد ملی یا نام پیدا می‌شود؛
     درس با نام در بانک درس‌های همین مدرسه تطبیق می‌یابد. */
  grades: [
    ['full_name', 'نام و نام خانوادگی', 0, ['نام', 'نام دانش آموز', 'اسم', 'نام و نام خانوادگی', 'نام کامل']],
    ['national_id', 'کد ملی', 0, ['کد ملی', 'کدملی', 'شماره ملی', 'شماره‌ملی']],
    ['class_name', 'کلاس', 0, ['کلاس', 'نام کلاس', 'پایه و کلاس']],
    ['subject', 'درس', 1, ['درس', 'نام درس', 'درس تحصیلی', 'برگه']],
    ['term', 'نوبت', 0, ['نوبت', 'ترم', 'نوبت تحصیلی', 'نیم‌سال']],
    ['exam_type', 'نوع آزمون', 0, ['نوع آزمون', 'آزمون', 'نوع برگه', 'برگه امتحان']],
    ['score', 'نمره', 1, ['نمره', 'نمره درس', 'امتیاز', 'نتیجه']],
    ['date', 'تاریخ آزمون', 0, ['تاریخ آزمون', 'تاریخ', 'تاریخ ثبت']],
  ],
  /* حضور و غیاب دورهٔ گذشته: تاریخ الزامی است؛ وضعیت فارسی/انگلیسی
     هر دو خوانده می‌شود و به چهار وضعیت سامانه تقلیل می‌یابد. */
  attendance: [
    ['full_name', 'نام و نام خانوادگی', 0, ['نام', 'نام دانش آموز', 'اسم', 'نام و نام خانوادگی', 'نام کامل']],
    ['national_id', 'کد ملی', 0, ['کد ملی', 'کدملی', 'شماره ملی', 'شماره‌ملی']],
    ['class_name', 'کلاس', 0, ['کلاس', 'نام کلاس', 'پایه و کلاس']],
    ['date', 'تاریخ', 1, ['تاریخ', 'تاریخ حضور', 'تاریغ']],
    ['status', 'وضعیت', 1, ['وضعیت', 'حضور و غیاب', 'حالت', 'حضور', 'غیبت']],
    ['note', 'توضیح', 0, ['توضیح', 'یادداشت', 'شرح', 'علت']],
  ],
};

const IMP_ENTITY_FA = {
  students: 'دانش‌آموزان (به‌همراه اولیا و رشته)',
  teachers: 'دبیران',
  grades: 'نمرات دورهٔ گذشته',
  attendance: 'حضور و غیاب دورهٔ گذشته',
};

/* ستون‌هایی که هرگز نباید نگاشت شوند (شماره ردیف و ستون‌های خالی) */
const IMP_IGNORE = ['ردیف', 'شماره', 'رديف', '#', 'ش'];

/* فیلدهای تکمیلی که مستقیم روی رکورد کاربر ذخیره می‌شوند */
const IMP_EXTRA_FIELDS = ['first_name', 'last_name', 'field', 'last_gpa', 'failed_count',
  'father_name', 'father_nid', 'father_edu', 'father_alive', 'father_job', 'father_phone',
  'mother_name', 'mother_nid', 'mother_edu', 'mother_alive', 'mother_job', 'mother_phone',
  'guardian', 'guardian_alive', 'guardian_phone', 'sisters', 'brothers',
  'covered', 'org_type', 'org_percent', 'talent',
  'landline', 'residence', 'village', 'residence_status', 'address',
  'shenasname_serial', 'shenasname_seri', 'degree', 'gender'];

/* وضعیت‌های حضور و غیاب: هر آنچه در فایل مدرسه بیاید،
   به چهار وضعیتِ واحدِ سامانه تقلیل می‌یابد */
const ATT_IMPORT_MAP = {
  present: 'present', 'حاضر': 'present', 'حضور': 'present', 'پ': 'present',
  absent: 'absent', 'غایب': 'absent', 'غیبت': 'absent', 'غ': 'absent',
  late: 'late', 'تأخیر': 'late', 'تاخیر': 'late', 'دیر': 'late', 'د': 'late',
  excused: 'excused', 'موجه': 'excused', 'مرخصی': 'excused', 'م': 'excused',
};

/* نوبت: هر شکلی که بیاید به دو نوبتِ واحد تقلیل می‌یابد */
function impTermMap(x) {
  const t = impNorm(impLatin(x));
  if (!t) return null;
  if (/اول|یکم|1$/.test(t)) return 'نوبت اول';
  if (/دوم|دویم|2$/.test(t)) return 'نوبت دوم';
  return null;
}

/* ── ابزارهای متن و عدد ──────────────────────────────────────────── */
/** یکسان‌سازی نویسه‌های عربی/فارسی برای مقایسهٔ عنوان ستون‌ها */
function impNorm(x) {
  return String(x == null ? '' : x)
    .replace(/[ىي]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/\u200c/g, '')
    .replace(/[_\-.:،؛/\\()\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}
/** تبدیل ارقام فارسی و عربی به لاتین */
function impLatin(x) {
  return String(x == null ? '' : x)
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}
/**
 * خواندن عدد اعشاری از متن فارسی.
 * در فایل‌های واقعی مدرسه معدل به شکل «۱۲/۸۸» یا «۱۲٫۸۸» نوشته می‌شود؛
 * یعنی ممیز با اسلش یا ممیز فارسی، نه نقطهٔ لاتین.
 */
function impNumFa(x) {
  let t = impLatin(x).replace(/[٫،]/g, '.').replace(/\//g, '.').replace(/[^\d.]/g, '');
  const parts = t.split('.');
  if (parts.length > 2) t = parts[0] + '.' + parts.slice(1).join('');
  return t === '' ? null : Number(t);
}

/* ══════════════ پایه و رشته — کلاس هیچ‌وقت از رشته ساخته نمی‌شود ══════
   قاعدهٔ ثابت سامانه: «کلاس = پایه + رشته».
   در فایل‌های واقعی مدرسه ستون «رشته» پُر است و ستون «پایه» خالی؛ نسخهٔ
   قبلی همان رشته را نام کلاس می‌کرد و بعد در صفحهٔ کلاس‌ها رشته‌ها به‌جای
   کلاس‌ها می‌نشستند و پایه‌ها «بدون استفاده» می‌ماندند. اینجا:
     • پایه از ستون پایه، و اگر نبود از داخل نام کلاس خوانده می‌شود
     • رشته با تعریف‌های موجود تطبیق داده می‌شود (اشتباه تایپی ⇒ همان رشته)
     • اگر پایه پیدا نشود، کلاسی ساخته نمی‌شود؛ دانش‌آموز بی‌کلاس ثبت
       می‌شود و در «نیازمند پیگیری» می‌آید تا مدیر کاملش کند.
   ═══════════════════════════════════════════════════════════════════ */
const IMP_GRADE_WORDS = ['پیش‌دانشگاهی', 'پیش دانشگاهی',
  'دوازدهم', 'یازدهم', 'دهم', 'نهم', 'هشتم', 'هفتم', 'ششم', 'پنجم', 'چهارم', 'سوم', 'دوم', 'اول'];
const IMP_GRADE_NUM = { 12: 'دوازدهم', 11: 'یازدهم', 10: 'دهم', 9: 'نهم', 8: 'هشتم', 7: 'هفتم', 6: 'ششم', 5: 'پنجم', 4: 'چهارم', 3: 'سوم', 2: 'دوم', 1: 'اول' };

/** فاصلهٔ ویرایشی (لِوِنشتاین) برای تشخیص اشتباه تایپی در نام رشته */
function impLev(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}

/** پایه را از هر متنی بشناس (واژه، عدد ۱۰/۱۱/۱۲، یا تعریف‌های مدیر) */
/* پایه فقط یک عدد ۱..۱۲ است. «الکترونیک» یا «ریاضی» هرگز پایه نیست —
   این تابع جلوی همان اشتباهی را می‌گیرد که رشته را به‌جای پایه ثبت می‌کرد. */
function impGradeLevel(txt) {
  const t = impNorm(txt).replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  if (!t) return 0;
  const fa = { 'اول': 1, 'دوم': 2, 'سوم': 3, 'چهارم': 4, 'پنجم': 5, 'ششم': 6, 'هفتم': 7, 'هشتم': 8, 'نهم': 9, 'دهم': 10, 'یازدهم': 11, 'دوازدهم': 12 };
  for (const w of Object.keys(fa)) if (t === w || t.indexOf(w) > -1) return fa[w];
  const m = t.match(/(?:^|\s)(\d{1,2})(?:\s|$)/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return Number(m[1]);
  return 0;
}
function impGradeCanon(txt, known) {
  const t = impNorm(txt);
  if (!t) return '';
  /* «یازدهم» شامل «دهم» است؛ اول بلندترین‌ها بررسی می‌شوند.
     از فهرست تعریف‌ها فقط نام‌هایی که واقعاً پایه‌اند پذیرفته می‌شوند. */
  const cands = [];
  for (const g of (known || [])) if (impGradeLevel(g)) cands.push({ src: g, key: impNorm(g) });
  for (const g of IMP_GRADE_WORDS) cands.push({ src: impNorm(g) === 'پیش دانشگاهی' ? 'پیش‌دانشگاهی' : g, key: impNorm(g) });
  cands.sort((a, b) => b.key.length - a.key.length);
  const tokens = t.split(' ');
  for (const c of cands) if (c.key && tokens.indexOf(c.key) > -1) return c.src;
  for (const c of cands) if (c.key && c.key.length > 2 && t.indexOf(c.key) > -1) return c.src;
  const m = t.match(/(?:^|\s)(\d{1,2})(?:\s|$)/);
  if (m && IMP_GRADE_NUM[Number(m[1])]) return IMP_GRADE_NUM[Number(m[1])];
  return '';
}

/** رشته را با تعریف‌های موجود تطبیق بده؛ اشتباه تایپیِ نزدیک ⇒ همان رشته */
function impBranchCanon(txt, known) {
  let raw = String(txt || '').replace(/\s+/g, ' ').trim();
  if (!raw) return { name: '', matched: false, near: '' };
  raw = raw.replace(/^رشتهٔ?\s*/i, '').replace(/\s*رشتهٔ?$/i, '').trim();
  const t = impNorm(raw);
  if (!t) return { name: '', matched: false, near: '' };
  let best = '', bestD = 999;
  for (const g of (known || [])) {
    const gn = impNorm(g);
    if (!gn) continue;
    if (gn === t) return { name: g, matched: true, near: '' };
    const d = impLev(gn, t);
    if (d < bestD) { bestD = d; best = g; }
  }
  if (best) {
    const gn = impNorm(best);
    if (bestD <= 2 || gn.indexOf(t) > -1 || t.indexOf(gn) > -1) return { name: best, matched: true, near: '' };
    return { name: raw, matched: false, near: best };
  }
  return { name: raw, matched: false, near: '' };
}

/** پایه/رشته‌ای که تازه دیده شده را در تعریف‌ها ثبت کن (بدون تکرار) */
function impEnsureLookup(kind, name) {
  const nm = String(name || '').trim();
  if (!nm) return null;
  const found = list('lookups').find(l => String(l.kind) === String(kind) && impNorm(l.name) === impNorm(nm));
  if (found) return found;
  return putLocal('lookups', { kind, name: nm, order: list('lookups').filter(l => String(l.kind) === String(kind)).length + 1, school_id: 1 });
}

/** نام پایه را از نام کلاس جدا کن و بقیه را برگردان («دهم گرافیک» ⇒ «گرافیک») */
function impStripGrade(name, grade) {
  const gTokens = impNorm(grade).split(' ').filter(Boolean);
  const out = [];
  for (const tok of String(name).replace(/[()\[\]\-_/\\]/g, ' ').split(/\s+/)) {
    const t = impNorm(tok);
    if (!t) continue;
    if (/^\d{1,2}$/.test(t)) continue;
    if (gTokens.some(g => g === t || g.indexOf(t) > -1 || t.indexOf(g) > -1)) continue;
    out.push(String(tok).trim());
  }
  return out.join(' ').trim();
}

/**
 * از یک ردیف فایل، «پایه»، «رشته» و «نام کلاس» را درمی‌آورد.
 * خروجی: { grade, branch, name, matched, near, bare }
 *   name === '' یعنی پایه پیدا نشد ⇒ کلاس ساخته نمی‌شود.
 *   bare === true یعنی هرچه در ستون کلاس بود، خودش یک رشته است.
 */
function impPlaceOf(o, ctx) {
  const grades = (ctx && ctx.grades) || [];
  const branches = (ctx && ctx.branches) || [];
  const cname = String(o.class_name || '').replace(/\s+/g, ' ').trim();
  const only = (ctx && ctx.onlyGrades) || [];
  /* رشتهٔ با غلط تایپی، قبل از هر کاری به نام درست برگردانده می‌شود */
  let branchTxt = String(o.field || '').trim();
  if (branchTxt && ctx && ctx.aliasBranch && ctx.aliasBranch[impNorm(branchTxt)]) {
    branchTxt = ctx.aliasBranch[impNorm(branchTxt)];
    o = Object.assign({}, o, { field: branchTxt });
  }
  let grade = impGradeCanon(String(o.grade || ''), grades);
  if (!grade && cname) grade = impGradeCanon(cname, grades);
  /* فایل ستون پایه ندارد ولی مدیر گفته «این فایل فقط دهم است» */
  if (!grade && only.length === 1) grade = only[0];

  let bc = impBranchCanon(branchTxt, branches);
  if (!bc.name && cname) bc = impBranchCanon(impStripGrade(cname, grade), branches);

  const branch = bc.name || '';
  /* اگر «پایه» با «رشته» یکی شد، یعنی فایل رشته را در ستون پایه گذاشته —
     پایه بی‌اعتبار است و کلاس ساخته نمی‌شود (می‌رود به «نیازمند پیگیری»). */
  if (grade && branch && impNorm(grade) === impNorm(branch)) grade = '';
  const name = grade ? (grade + (branch ? ' ' + branch : '')).trim() : '';
  return {
    grade, branch, name,
    mode: impGradeLevel(grade) >= 10 ? 'field' : 'class',
    grade_level: impGradeLevel(grade),
    matched: !!bc.matched,
    near: bc.near || '',
    bare: !grade && !!branch,
  };
}

/* ── تاریخ شمسی ← میلادی (همان الگوریتم p2) ───────────────────────── */
const _impDiv = (a, b) => Math.floor(a / b);
function impToGregorian(jy, jm, jd) {
  let gy = jy <= 979 ? 621 : 1600;
  jy -= jy <= 979 ? 0 : 979;
  let days = 365 * jy + _impDiv(jy, 33) * 8 + _impDiv((jy % 33) + 3, 4) + 78 + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  gy += 400 * _impDiv(days, 146097); days %= 146097;
  if (days > 36524) { gy += 100 * _impDiv(--days, 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * _impDiv(days, 1461); days %= 1461;
  if (days > 365) { gy += _impDiv(days - 1, 365); days = (days - 1) % 365; }
  let gd = days + 1;
  const sal = [0, 31, ((gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 1;
  for (; gm <= 12 && gd > sal[gm]; gm++) gd -= sal[gm];
  return [gy, gm, gd];
}
const _impPad = n => String(n).padStart(2, '0');
/** «۱۳۹۰/۵/۱۲» یا «1390-05-12» ← «2011-08-03»؛ خروجی خالی = خوانده نشد */
function impJalaliToIso(v) {
  if (!v) return '';
  const s = impLatin(v);
  const m = s.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
  if (!m) return '';
  const jy = Number(m[1]), jm = Number(m[2]), jd = Number(m[3]);
  if (!(jy > 1200 && jy < 1700) || jm < 1 || jm > 12 || jd < 1 || jd > 31) return '';
  const g = impToGregorian(jy, jm, jd);
  return g[0] + '-' + _impPad(g[1]) + '-' + _impPad(g[2]);
}
/** تاریخ فایل: شمسی، یا میلادیِ آماده */
function impAnyDate(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return '';
  const iso = impJalaliToIso(raw);
  if (iso) return iso;
  const m = impLatin(raw).match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
  if (m && Number(m[1]) > 1900) return m[1] + '-' + _impPad(Number(m[2])) + '-' + _impPad(Number(m[3]));
  return '';
}

/** «2011-08-03» ← «1390/05/12» (برای پرکردن فرم با تاریخ خوانا) */
function impIsoToJalali(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return '';
  const j = toJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return j[0] + '/' + _impPad(j[1]) + '/' + _impPad(j[2]);
}

/* کد ملی ایران: ۱۰ رقم با رقم کنترلی */
function impValidNid(v) {
  const s = impLatin(v).replace(/\D/g, '');
  if (!/^\d{10}$/.test(s) || /^(\d)\1{9}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(s[i]) * (10 - i);
  const r = sum % 11;
  const check = Number(s[9]);
  return (r < 2 && check === r) || (r >= 2 && check === 11 - r);
}

function impFields(entity) { return IMP_FIELDS[entity] || IMP_FIELDS.students; }

/* ── حدس هوشمند نگاشت ستون‌ها بر پایهٔ عنوان و مترادف‌ها ────────────── */
/* «نسبتِ» ستون: پدر، مادر، سرپرست یا خودِ دانش‌آموز.
   بدون این تشخیص، «شماره تماس پدر» به موبایل دانش‌آموز نگاشت می‌شد و
   شمارهٔ پدر گم می‌شد — همان چیزی که در «مشخصات کامل» خالی دیده شد. */
function impRelOf(nh) {
  const t = String(nh || '');
  if (/مادر/.test(t)) return 'mother';
  if (/پدر/.test(t)) return 'father';
  if (/(سرپرست|قیم|ولی)/.test(t)) return 'guardian';
  if (/(دانش ?آموز|هنرجو)/.test(t)) return 'student';
  return '';
}
function impKeyRel(key) {
  if (/^father_/.test(key)) return 'father';
  if (/^mother_/.test(key)) return 'mother';
  if (/^guardian/.test(key)) return 'guardian';
  return '';
}
function impRelOk(rel, keyRel) {
  if (rel === keyRel) return true;
  if (rel === 'guardian' && keyRel === 'father') return true;   /* «ولی» در این مدرسه همان پدر است */
  if (rel === 'father' && keyRel === 'guardian') return true;
  return false;
}

function impAutoMap(headers, entity) {
  entity = entity || (S.imp && S.imp.kind) || 'students';
  const fields = impFields(entity);
  const out = {}, used = {};
  /* فایل‌های مدرسه معمولاً دو ستون هم‌نام «وضعیت حیات» دارند: اولی مال پدر و
     دومی مال مادر. بدون این قاعده، هر دو به یک فیلد می‌رفتند و دومی گم می‌شد. */
  const aliveCols = [];
  (headers || []).forEach((h, i) => {
    const nh = impNorm(h);
    if (!nh) return;
    if (nh.indexOf('حیات') > -1 && nh.indexOf('پدر') < 0 && nh.indexOf('مادر') < 0) aliveCols.push(i);
  });
  const aliveOrder = ['father_alive', 'mother_alive', 'guardian_alive'];
  aliveCols.forEach((idx, k) => {
    if (k >= aliveOrder.length) return;
    out[idx] = aliveOrder[k];
    used[aliveOrder[k]] = true;
  });
  (headers || []).forEach((h, i) => {
    if (out[i]) return;
    const nh = impNorm(h);
    if (!nh) { out[i] = ''; return; }
    /* ستون شماره ردیف داده نیست؛ نگاشت نمی‌شود */
    if (IMP_IGNORE.indexOf(nh) > -1) { out[i] = ''; return; }
    const rel = impRelOf(nh);
    let best = '', score = 0;
    fields.forEach(fld => {
      const key = fld[0];
      if (used[key]) return;
      const kr = impKeyRel(key);
      if (rel && kr && !impRelOk(rel, kr)) return;   /* ستون «پدر» نباید به فیلد «مادر» برود */
      [fld[1]].concat(fld[3]).forEach(sy => {
        const ns = impNorm(sy);
        if (!ns) return;
        let sc = 0;
        if (nh === ns) sc = 100;
        else if (nh.indexOf(ns) > -1 || ns.indexOf(nh) > -1) sc = 70 + Math.min(20, ns.length);
        /* ستون «موبایل پدر» هرگز نباید «موبایل خودِ دانش‌آموز» شود */
        if (sc && rel && !kr) sc -= 36;
        if (sc > score) { score = sc; best = key; }
      });
    });
    out[i] = score >= 70 ? best : '';
    if (out[i]) used[best] = true;
  });
  return out;
}

/* ── تبدیل سطرها به دادهٔ استاندارد ───────────────────────────────── */
function impMapped() {
  const imp = S.imp || {};
  const map = imp.map || [];
  const firstDataRow = (Number(imp.headerRow) || 0) + 1 || 1;   /* شمارهٔ سطرِ دادهٔ اول در فایل */
  return (imp.rows || []).map((row, idx) => {
    const o = { _row: idx + (firstDataRow > 1 ? firstDataRow : 1) };
    map.forEach((key, col) => {
      if (!key) return;
      const val = row[col] == null ? '' : String(row[col]).trim();
      if (val === '') return;
      o[key] = val;
    });
    return o;
  }).filter(o => Object.keys(o).length > 1);
}

/* ── بررسی کامل: خطا (ثبت نمی‌شود) و هشدار (ثبت می‌شود، ولی بدانید) ── */
function impCheck() {
  const imp = S.imp || {};
  const entity = imp.kind || 'students';
  const users = list('users');
  const classes = list('classes');
  const clsByName = Object.create(null);
  classes.forEach(c => { clsByName[impNorm(c.name)] = c; });

  const seen = Object.create(null);          /* کد ملی تکراری در همین فایل */
  const stuByNid = Object.create(null), stuByName = Object.create(null);
  if (entity === 'grades' || entity === 'attendance') {
    users.forEach(u => {
      if (u.role !== 'student') return;
      if (u.national_id) stuByNid[impLatin(u.national_id).replace(/\D/g, '')] = u;
      const nm = impNorm(u.name || u.full_name || '');
      if (nm) (stuByName[nm] = stuByName[nm] || []).push(u);
    });
  }
  const out = [];
  const newClasses = [];
  /* تعریف‌های پایه و رشته برای تطبیق — اشتباه تایپی رشته، رشتهٔ تازه نمی‌سازد */
  const defs = list('lookups');
  const gctx = {
    grades: defs.filter(l => String(l.kind) === 'grade').map(l => l.name),
    branches: defs.filter(l => String(l.kind) === 'branch').map(l => l.name),
  };
  if (!gctx.branches.length) gctx.branches = [...new Set(classes.map(c => String(c.branch || '')).filter(Boolean))];
  if (!gctx.grades.length) gctx.grades = [...new Set(classes.map(c => String(c.grade || '')).filter(Boolean))];
  gctx.onlyGrades = ((S.impGrades || (S.imp && S.imp.grades)) || []).filter(Boolean);

  /* ── اصلاح غلط تایپی رشته ───────────────────────────────────────
     «کرافیک» یک حرف با «گرافیک» فاصله دارد. اول شمارش تکرار در همین فایل،
     بعد تطبیق با تعاریف موجود، و آخر خوشه‌بندی مقادیر خود فایل: پرتکرارترین
     نگه داشته می‌شود و بقیه به آن اصلاح می‌شوند. هر اصلاح گزارش می‌شود. */
  gctx.aliasBranch = Object.create(null);
  gctx.branchFixes = [];
  if (entity === 'students') {
    const rawVals = [];
    try {
      impMapped().forEach(o => {
        const v = String(o.field || '').trim();
        if (v) rawVals.push(v);
      });
    } catch (e) { /* بی‌صدا */ }
    const freq = new Map();
    rawVals.forEach(v => { const k = impNorm(v); freq.set(k, (freq.get(k) || 0) + 1); });
    const defsNorm = new Map(gctx.branches.map(b => [impNorm(b), b]));
    /* مقادیری که دقیقاً در تعاریف هستند، مرجع‌اند */
    const anchors = [...freq.keys()].filter(k => defsNorm.has(k));
    const others = [...freq.keys()].filter(k => !defsNorm.has(k));
    others.sort((a, b) => (freq.get(b) || 0) - (freq.get(a) || 0));
    for (const k of others) {
      let best = '', bestD = 999;
      const pool = anchors.concat([...freq.keys()].filter(x => x !== k && !others.includes(x)));
      for (const a of pool) {
        if (a === k) continue;
        const d = impLev(a, k);
        if (d < bestD) { bestD = d; best = a; }
      }
      if (best && bestD <= 2) {
        gctx.aliasBranch[k] = defsNorm.get(best) || best;
        const orig = rawVals.find(v => impNorm(v) === k) || k;
        const to = (defsNorm.get(best) || rawVals.find(v => impNorm(v) === best) || best);
        gctx.branchFixes.push({ from: orig, to });
        anchors.push(best);            /* تا اصلاح‌های بعدی به همین بچسبند */
      } else {
        anchors.push(k);
      }
    }
  }

  impMapped().forEach(o => {
    const errors = [], warns = [], data = {};

    /* نام و نام خانوادگی: جدا یا یکی — در نبود نام کامل از دو ستون ساخته می‌شود */
    const fn = String(o.first_name || '').replace(/\s+/g, ' ').trim();
    const ln = String(o.last_name || '').replace(/\s+/g, ' ').trim();
    data.full_name = String(o.full_name || '').replace(/\s+/g, ' ').trim() || (fn + ' ' + ln).trim();
    data.name = data.full_name;
    if (fn) data.first_name = fn;
    if (ln) data.last_name = ln;
    if ((entity === 'students' || entity === 'teachers') && data.full_name.length < 3) {
      errors.push('نام و نام خانوادگی الزامی است');
    }

    const nid = impLatin(o.national_id || '').replace(/\D/g, '');
    if (nid) {
      if (!impValidNid(nid)) errors.push('کد ملی «' + nid + '» معتبر نیست');
      else if (seen[nid] && entity !== 'grades' && entity !== 'attendance') errors.push('کد ملی در همین فایل تکراری است');
      else {
        seen[nid] = true;
        const owner = users.find(u => impLatin(u.national_id || '').replace(/\D/g, '') === nid);
        if (owner) {
          if (owner.role === 'student' || entity === 'teachers') {
            warns.push('قبلاً ثبت شده — به‌روزرسانی می‌شود');
            data.existing_id = owner.id;
          } else {
            errors.push('کد ملی متعلق به «' + (owner.name || '') + '» با نقش ' + (ROLE_FA[owner.role] || owner.role) + ' است');
          }
        }
        data.national_id = nid;
      }
    } else warns.push('بدون کد ملی');

    /* موبایل دانش‌آموز و پدر جدا نگه داشته می‌شوند */
    const ph = impLatin(o.phone || '').replace(/\D/g, '');
    if (ph && /^09\d{9}$/.test(ph)) data.phone = ph;
    else if (ph) warns.push('موبایل دانش‌آموز نامعتبر است');
    const fph = impLatin(o.father_phone || '').replace(/\D/g, '');
    if (fph && /^09\d{9}$/.test(fph)) data.father_phone = fph;
    else if (fph) warns.push('موبایل پدر نامعتبر است');
    if (data.phone) {
      const taken = users.find(u => impLatin(u.phone || '').replace(/\D/g, '') === data.phone
        && Number(u.id) !== Number(data.existing_id || 0));
      if (taken) errors.push('این شمارهٔ همراه برای «' + (taken.name || '') + '» ثبت شده است');
    }

    if (entity === 'students') {
      /* کلاس = پایه + رشته. رشته به‌تنهایی هرگز کلاس نمی‌شود. */
      const place = impPlaceOf(o, gctx);
      const cls = place.name ? clsByName[impNorm(place.name)] : null;
      if (cls) {
        data.class_id = cls.id;
      } else if (place.name) {
        data.new_class = place.name;
        data.new_grade = place.grade;
        data.new_branch = place.branch;
        if (newClasses.indexOf(place.name) < 0) newClasses.push(place.name);
        warns.push('کلاس «' + place.name + '» ساخته می‌شود');
        if (place.branch && !place.matched) {
          warns.push(place.near
            ? 'رشتهٔ «' + place.branch + '» شبیه «' + place.near + '» است — اگر اشتباه تایپی است در صفحهٔ کلاس‌ها ادغام کنید'
            : 'رشتهٔ «' + place.branch + '» تازه تعریف می‌شود');
        }
      } else if (place.bare) {
        data.class_id = null;
        data.followup_reason = 'پایه در فایل نبود (رشته: ' + place.branch + ')';
        warns.push('کلاس ساخته نشد: ' + data.followup_reason + ' — در «نیازمند پیگیری» کامل کنید');
      } else warns.push('بدون کلاس');

      if (o.birth_date) {
        const iso = impAnyDate(o.birth_date);
        if (iso) data.birth_date = iso;
        else warns.push('تاریخ تولد خوانده نشد');
      }
      const g = impNorm(o.gender);
      data.gender = /پسر|مذکر|مرد/.test(g) ? 'پسر' : /دختر|مونث|مؤنث|زن/.test(g) ? 'دختر' : '';

      ['father_nid', 'mother_nid'].forEach(k => {
        const v = impLatin(o[k] || '').replace(/\D/g, '');
        if (v && impValidNid(v)) data[k] = v;
        else if (v) warns.push('کد ملی ' + (k === 'father_nid' ? 'پدر' : 'مادر') + ' نامعتبر است');
      });
      data.father_name = String(o.father_name || '').trim();
      data.mother_name = String(o.mother_name || '').trim();

      /* شمارهٔ مادر جدا از پدر نگه داشته می‌شود */
      const mph = impLatin(o.mother_phone || '').replace(/\D/g, '');
      if (mph && /^09\d{9}$/.test(mph)) data.mother_phone = mph;
      else if (mph) warns.push('موبایل مادر نامعتبر است');
      const gph = impLatin(o.guardian_phone || '').replace(/\D/g, '');
      if (gph && /^09\d{9}$/.test(gph)) data.guardian_phone = gph;
      else if (gph) warns.push('موبایل سرپرست نامعتبر است');

      /* هر ولی باید یک راه ورود داشته باشد: شمارهٔ همراه، وگرنه کد ملی */
      const who = [['پدر', 'father_name', 'father_nid', 'father_phone'],
        ['مادر', 'mother_name', 'mother_nid', 'mother_phone']];
      who.forEach(([fa2, nm, nidKey, phKey]) => {
        const has = String(data[nm] || '').trim() || data[nidKey] || data[phKey];
        if (!has) return;
        if (!data[nm]) data[nm] = fa2 + ' ' + String(data.full_name || '').trim();
        if (!data[nidKey] && !data[phKey]) {
          warns.push('برای ' + fa2 + ' نه شمارهٔ همراه هست نه کد ملی — بعداً در «کاربران ← ویرایش» کامل کنید');
        }
      });
      /* یک شماره برای دو ولی نمی‌تواند دو نام کاربری باشد */
      if (data.father_phone && data.mother_phone && data.father_phone === data.mother_phone) {
        warns.push('شمارهٔ همراه پدر و مادر یکی است — مادر با کد ملی وارد می‌شود');
        delete data.mother_phone;
      }

      /* اطلاعات تکمیلی — بدون اعتبارسنجی سخت‌گیرانه، چون اختیاری‌اند */
      ['father_edu', 'mother_edu', 'father_job', 'mother_job', 'guardian',
        'field', 'residence', 'village', 'residence_status', 'address',
        'shenasname_serial', 'shenasname_seri', 'talent', 'org_type'].forEach(k => {
        const v = String(o[k] || '').trim();
        if (v) data[k] = v;
      });

      /* وضعیت حیات: هر عبارتی که «فوت» داشته باشد یعنی درگذشته */
      ['father_alive', 'mother_alive', 'guardian_alive'].forEach(k => {
        const v = impNorm(o[k]);
        if (!v) return;
        data[k] = /فوت|مرحوم|متوفی/.test(v) ? 'فوت' : 'در قید حیات';
      });

      /* اعداد */
      ['sisters', 'brothers', 'failed_count', 'org_percent'].forEach(k => {
        const n = impNumFa(o[k]);
        if (n !== null && !isNaN(n)) data[k] = n;
      });
      /* معدل در فایل واقعی به شکل «۱۲/۸۸» است — اسلش نقش ممیز دارد */
      const gpa = impNumFa(o.last_gpa);
      if (gpa !== null && !isNaN(gpa)) {
        if (gpa >= 0 && gpa <= 20) data.last_gpa = gpa;
        else warns.push('معدل «' + String(o.last_gpa) + '» خارج از بازهٔ ۰ تا ۲۰ است');
      }

      /* تحت پوشش: بلی/خیر */
      const cov = impNorm(o.covered);
      if (cov) data.covered = /بل[ىی]|بله|دارد|آر[ىی]/.test(cov) ? 1 : 0;

      /* شمارهٔ ثابت */
      const land = impLatin(o.landline || '').replace(/\D/g, '');
      if (land) data.landline = land;

      data.role = 'student';
    } else if (entity === 'teachers') {
      data.subject = String(o.subject || '').trim();
      ['degree', 'address'].forEach(k => {
        const v = String(o[k] || '').trim();
        if (v) data[k] = v;
      });
      data.role = 'teacher';
    } else {
      /* نمرات و حضور و غیاب: دانش‌آموز از پیش هست — فقط پیدا می‌شود.
         کد ملی اولویت دارد؛ وگرنه نام (با کلاس برای رفع ابهام). */
      let stu = data.national_id ? stuByNid[data.national_id] : null;
      if (!stu && data.full_name) {
        let cands = stuByName[impNorm(data.full_name)] || [];
        if (o.class_name) {
          const cn = impNorm(o.class_name);
          const inCls = cands.filter(u => impNorm((byId('classes', u.class_id) || {}).name || '') === cn);
          if (inCls.length) cands = inCls;
        }
        if (cands.length === 1) stu = cands[0];
        else if (cands.length > 1) errors.push('چند دانش‌آموز «' + data.full_name + '» هست — کد ملی بنویسید');
      }
      if (!stu) {
        errors.push(data.national_id
          ? 'دانش‌آموز با کد ملی «' + data.national_id + '» در این مدرسه نیست'
          : 'دانش‌آموز «' + (data.full_name || '؟') + '» در این مدرسه پیدا نشد');
      }
      if (stu) {
        data.student_id = stu.id;
        data.class_id = stu.class_id || ((clsByName[impNorm(o.class_name || '')] || {}).id) || null;
      }
      if (entity === 'grades') {
        const subjTxt = String(o.subject || '').trim();
        if (!subjTxt) errors.push('نام درس الزامی است');
        else {
          const want = impNorm(subjTxt);
          const subs = list('subjects');
          let su = subs.find(x => impNorm(x.name) === want);
          if (!su) su = subs.find(x => impNorm(x.name).indexOf(want) > -1 || want.indexOf(impNorm(x.name)) > -1);
          if (su) data.subject_id = su.id;
          else errors.push('درس «' + subjTxt + '» در بانک درس‌های این مدرسه نیست');
        }
        const sc = impNumFa(o.score);
        if (sc === null || isNaN(sc)) errors.push('نمره خوانده نشد');
        else if (sc < 0 || sc > 20) errors.push('نمره «' + String(o.score) + '» خارج از بازهٔ ۰ تا ۲۰ است');
        else data.score = sc;
        if (o.term) {
          data.term = impTermMap(o.term) || 'نوبت اول';
          if (!impTermMap(o.term)) warns.push('نوبت «' + String(o.term) + '» خوانده نشد — «نوبت اول» می‌شود');
        }
        data.exam_type = String(o.exam_type || '').trim() || 'کلاسی';
        if (o.date) {
          const iso = impAnyDate(o.date);
          if (iso) data.date = iso; else warns.push('تاریخ آزمون خوانده نشد');
        }
      } else {
        if (!o.date) errors.push('تاریخ الزامی است');
        else {
          const iso = impAnyDate(o.date);
          if (iso) data.date = iso;
          else errors.push('تاریخ «' + String(o.date) + '» خوانده نشد');
        }
        const stRaw = String(o.status == null ? '' : o.status);
        const stKey = ATT_IMPORT_MAP[impNorm(stRaw)] || ATT_IMPORT_MAP[stRaw.trim()];
        if (!stKey) errors.push('وضعیت «' + stRaw + '» شناخته نمی‌شود (حاضر/غایب/تأخیر/موجه)');
        else data.status = stKey;
        data.note = String(o.note || '').trim();
      }
    }

    out.push({ row: o._row, data, errors, warns, ok: errors.length === 0 });
  });

  S.impNewClasses = newClasses;
  S.impBranchFixes = gctx.branchFixes || [];
  return out;
}

/* ── پیام فارسی خطاهای سرور ──────────────────────────────────────── */
function impErrorText(code) {
  const map = {
    missing_name: 'نام ندارد',
    bad_national_id: 'کد ملی معتبر نیست',
    duplicate_national_id: 'کد ملی تکراری است',
    duplicate_phone: 'شمارهٔ همراه تکراری است',
    class_not_found: 'کلاس پیدا نشد',
    subject_not_found: 'درس پیدا نشد',
    student_not_found: 'دانش‌آموز پیدا نشد',
    bad_date: 'تاریخ معتبر نیست',
    bad_status: 'وضعیت نامعتبر',
    bad_score: 'نمره معتبر نیست',
    no_rows: 'سطر قابل ثبتی نبود',
  };
  return map[code] || String(code || 'خطا');
}

/* ══════════════ نما: چهار مرحله ══════════════ */
function impStat(ico, num, label, tone) {
  return `<div class="card tight" style="margin:0"><div class="row" style="gap:8px">
    <span style="font-size:20px">${ico}</span>
    <div><b style="font-size:17px;color:${tone === 'red' ? 'var(--red)' : tone === 'green' ? 'var(--green)' : 'inherit'}">${fa(num)}</b>
    <div class="small muted">${esc(label)}</div></div></div></div>`;
}

/* ── پیگیری: ردیف‌هایی که کامل نشدند در یک فهرست جدا می‌مانند ────────
   «خطا» یعنی اصلاً ساخته نشد، «مشخصات ناقص» یعنی ساخته شد ولی چیزی
   کم دارد (مثلاً موبایل ولی نامعتبر است). هر دو باید بعداً اصلاح شوند. */
const IMP_FOLLOW_RE = /نامعتبر|بدون کد ملی|نه شمارهٔ همراه|بدون شماره/;

function impNeedsFollowUp(check) {
  if (!check) return false;
  if ((check.errors || []).length) return true;
  return (check.warns || []).some(w => IMP_FOLLOW_RE.test(String(w)));
}

/* ذخیرهٔ فهرست پیگیری (روی دستگاه و در صف همگام‌سازی؛ مدیر همه‌جا می‌بیند) */
function impSaveIssues(checks, kind, fileName, serverErrors) {
  const byRow = new Map();
  (serverErrors || []).forEach(e => {
    const n = Number(e && e.row);
    if (!n) return;
    if (!byRow.has(n)) byRow.set(n, []);
    byRow.get(n).push(impErrorText(e.error) + (e.name ? ' — ' + e.name : ''));
  });
  const picked = (checks || []).filter(c => impNeedsFollowUp(c) || byRow.has(Number(c.row)));
  const existing = list('import_issues');
  const keyOf = (nid, name) => impNorm(nid || '') + '|' + impNorm(name || '');
  const seen = new Set(existing.filter(r => r.status !== 'done').map(r => keyOf(r.national_id, r.name)));
  let added = 0;
  picked.forEach(c => {
    const name = c.data.full_name || c.data.name || '';
    const nid = impLatin(c.data.national_id || '').replace(/\D/g, '');
    const key = keyOf(nid, name);
    if (seen.has(key)) return;
    seen.add(key);
    const reasons = (c.errors || []).concat(c.warns || []).concat(byRow.get(Number(c.row)) || []);
    putLocal('import_issues', {
      kind: kind || 'students', name, national_id: nid,
      phone: impLatin(c.data.phone || '').replace(/\D/g, ''),
      row_no: Number(c.row) || 0, file_name: fileName || '',
      reasons, data: c.data, status: 'open', school_id: 1,
    });
    added += 1;
  });
  return { added, total: picked.length };
}

function impStepHtml() {
  const imp = S.imp || { step: 1, kind: 'students' };
  const steps = ['انتخاب فایل', 'نگاشت ستون‌ها', 'بررسی و خطاها', 'ثبت نهایی'];
  const bar = `<div class="row" style="gap:6px;justify-content:space-between;margin-bottom:10px">
    ${steps.map((t, i) => `<div class="row" style="gap:6px;flex:1;min-width:0">
      <span style="width:24px;height:24px;border-radius:50%;display:grid;place-items:center;flex:none;font-weight:800;font-size:12px;background:${i < imp.step ? 'var(--primary)' : 'var(--soft)'};color:${i < imp.step ? '#fff' : 'var(--muted)'}">${fa(i + 1)}</span>
      <b class="small" style="color:${i === imp.step - 1 ? 'var(--primary)' : 'var(--muted)'}">${esc(t)}</b></div>`).join('')}
  </div>`;

  if (imp.step === 1) {
    /* پایه‌ها را از مدیر می‌پرسیم: خیلی از فایل‌های مدرسه ستون پایه ندارند
       (یک فایل برای همهٔ دهم‌ها، یا یک فایل برای کل مدرسه). */
    const scopeGrades = (typeof IMP_GRADE_WORDS !== 'undefined' ? IMP_GRADE_WORDS : [])
      .filter(g => impGradeLevel(g)).map(g => (impNorm(g) === 'پیش دانشگاهی' ? 'پیش‌دانشگاهی' : g));
    const chosen = (S.imp && S.imp.grades) || [];
    const gradeBox = imp.kind === 'students' ? `
      <div class="field" style="margin-top:6px">
        <span>این فایل شامل چه پایه‌هایی است؟ <span class="muted">(اگر ستون پایه در فایل نباشد، همین پایه به همهٔ سطرها داده می‌شود)</span></span>
        <div class="row" style="flex-wrap:wrap;gap:6px 14px;margin-top:6px">
          ${scopeGrades.map(g => `<label class="row" style="gap:6px;align-items:center;min-width:96px">
            <input type="checkbox" name="imp-grade" value="${esc(g)}" ${chosen.indexOf(g) > -1 ? 'checked' : ''}> <span class="small">${esc(g)}</span></label>`).join('')}
        </div>
        <div class="small muted" style="margin-top:6px;line-height:2">اگر فقط یک پایه تیک بخورد، همان به همهٔ سطرهای بی‌پایه داده می‌شود.
        اگر چند پایه تیک بخورد (فایل کل مدرسه)، هر دانش‌آموزی که پایه‌اش در فایل نبود در «نیازمند پیگیری» می‌آید تا پایه‌اش انتخاب شود.</div>
      </div>` : '';
    return `${bar}<form data-form="import-file">
      <div class="small muted" style="margin-bottom:8px;line-height:2">✅ نیازی به قالب آماده نیست؛ همان فایل موجود مدرسه با هر ترتیب ستونی قابل استفاده است.<br>
      ✅ ردیف تیتر خودکار تشخیص داده می‌شود و ستون‌ها هوشمند نگاشت می‌شوند.<br>
      ✅ تاریخ شمسی، اعداد فارسی، معدلِ «۱۲/۸۸» و شماره‌های ناقص خودکار اصلاح یا گزارش می‌شوند.</div>
      <label class="field"><span>نوع اطلاعات</span>
        <select class="input" name="kind">
          ${Object.keys(IMP_ENTITY_FA).map(k => `<option value="${k}" ${imp.kind === k ? 'selected' : ''}>${esc(IMP_ENTITY_FA[k])}</option>`).join('')}
        </select></label>
      ${gradeBox}
      <label class="field"><span>فایل اکسل یا CSV</span>
        <input class="input" type="file" name="file" accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"></label>
      <button class="btn primary block" style="margin-top:10px">بعدی — نگاشت ستون‌ها</button>
    </form>`;
  }

  if (imp.step === 2) {
    const fields = impFields(imp.kind);
    const map = imp.map || [];
    const mapped = map.filter(Boolean).length;
    const preview = (imp.rows || []).slice(0, 2);
    return `${bar}<div class="row between" style="margin-bottom:8px">
        <div class="small muted">«${esc(imp.fileName || '')}» — برگهٔ «${esc(imp.sheetName || '')}» با ${fa((imp.rows || []).length)} سطر</div>
        <span class="badge purple">${fa(mapped)} ستون نگاشت شد</span></div>
      <div style="max-height:46vh;overflow:auto"><table><thead><tr><th>ستون فایل</th><th>نمونه</th><th>فیلد سامانه</th></tr></thead><tbody>
        ${(imp.headers || []).map((h, i) => `<tr${map[i] ? ' style="background:var(--soft)"' : ''}>
          <td class="small"><b>${esc(h || ('ستون ' + fa(i + 1)))}</b></td>
          <td class="small muted">${esc(preview.map(r => r[i]).filter(v => String(v || '').trim()).join(' · ') || '—').slice(0, 30)}</td>
          <td><select class="input" data-imp-map="${i}" style="min-width:180px">
            <option value="">— نادیده بگیر —</option>
            ${fields.map(f => `<option value="${f[0]}" ${map[i] === f[0] ? 'selected' : ''}>${esc(f[1])}${f[2] ? ' *' : ''}</option>`).join('')}
          </select></td></tr>`).join('')}
      </tbody></table></div>
      <div class="row" style="margin-top:10px;gap:8px">
        <button class="btn ghost" data-act="import-back">مرحلهٔ قبل</button>
        <button class="btn primary grow" data-act="import-check">بررسی ${fa((imp.rows || []).length)} سطر</button>
      </div>`;
  }

  if (imp.step === 3) {
    const checks = imp.checks || [];
    const ok = checks.filter(c => !c.errors.length);
    const bad = checks.filter(c => c.errors.length);
    const follow = checks.filter(impNeedsFollowUp);
    const updates = ok.filter(c => c.data.existing_id).length;
    const newCls = S.impNewClasses || [];

    /* یک جدول برای هر گروه — خطادارها جدا، تا بتوان سراغشان رفت */
    const rowsHtml = (list, tone) => `<div class="table-wrap" style="max-height:34vh;overflow:auto"><table><thead><tr>
        <th>سطر</th><th>نام</th><th>کد ملی</th><th>کلاس / درس</th><th>پیام‌ها</th></tr></thead><tbody>
        ${list.map(c => `<tr${tone === 'red' ? ' style="background:#fef2f2"' : ''}>
          <td class="small">${fa(c.row)}</td>
          <td><b>${esc(c.data.full_name || '—')}</b></td>
          <td class="small ltr">${esc(c.data.national_id || '—')}</td>
          <td class="small">${esc(c.data.new_class || (byId('classes', c.data.class_id) || {}).name || (byId('subjects', c.data.subject_id) || {}).name || '—')}</td>
          <td class="small">${c.errors.map(e => '<div style="color:#b91c1c">⛔ ' + esc(e) + '</div>').join('')}
            ${c.warns.map(w => '<div class="muted">⚠️ ' + esc(w) + '</div>').join('')}</td>
        </tr>`).join('')}
      </tbody></table></div>`;

    const incomplete = follow.filter(c => !c.errors.length);
    const fixes = S.impBranchFixes || [];
    const fixesBox = fixes.length ? `<div class="banner info" style="margin-bottom:8px;display:block">
      <b>✍️ غلط تایپی اصلاح شد</b>
      <div class="small muted" style="margin-top:4px;line-height:2">
        ${fixes.slice(0, 6).map(f => `«${esc(f.from)}» ← <b>${esc(f.to)}</b>`).join(' · ')}
        ${fixes.length > 6 ? ' · و ' + fa(fixes.length - 6) + ' مورد دیگر' : ''}
      </div>
    </div>` : '';

    return `${bar}${fixesBox}
      <div class="grid g4" style="margin-bottom:10px">
        ${impStat('📋', checks.length, 'کل ردیف‌ها')}
        ${impStat('✅', ok.length, 'آمادهٔ ثبت', 'green')}
        ${impStat('⛔', bad.length, 'ثبت نمی‌شوند', 'red')}
        ${impStat('🕒', follow.length, 'نیازمند پیگیری', 'amber')}
      </div>

      ${bad.length ? `<div class="card tight" style="margin-bottom:10px;border-color:#fecaca">
        <div class="row between" style="margin-bottom:6px">
          <b style="color:#b91c1c">⛔ ${fa(bad.length)} ردیف ثبت نمی‌شود — این‌ها جدا نگه داشته می‌شوند</b>
        </div>
        <div class="small muted" style="margin-bottom:8px">این ردیف‌ها در پایان در بخش «نیازمند پیگیری» (صفحهٔ کاربران) می‌مانند تا یکی‌یکی اصلاح و ساخته شوند.</div>
        ${rowsHtml(bad.slice(0, 300), 'red')}
      </div>` : ''}

      ${incomplete.length ? `<div class="card tight" style="margin-bottom:10px">
        <div class="row between" style="margin-bottom:6px">
          <b>⚠️ ${fa(incomplete.length)} ردیف ثبت می‌شود ولی مشخصاتش کامل نیست</b>
        </div>
        <div class="small muted" style="margin-bottom:8px">مثلاً شمارهٔ همراهِ ولی نامعتبر یا خالی است. این‌ها هم برای پیگیری نگه داشته می‌شوند.</div>
        ${rowsHtml(incomplete.slice(0, 300), 'amber')}
      </div>` : ''}

      <div class="card tight" style="margin-bottom:10px">
        <div class="row between" style="margin-bottom:6px">
          <b>✅ ${fa(ok.length)} ردیف آمادهٔ ثبت${updates ? ' — ' + fa(updates) + ' به‌روزرسانی' : ''}</b>
        </div>
        ${newCls.length ? `<div class="small" style="margin-bottom:6px">🏛️ کلاس‌های جدید ساخته می‌شوند: <b>${esc(newCls.join('، '))}</b></div>` : ''}
        ${ok.length ? rowsHtml(ok.slice(0, 40), 'green') : '<div class="small muted">ردیف سالمی نیست.</div>'}
        ${ok.length > 40 ? `<div class="small muted">۴۰ ردیف اول نمایش داده شد؛ همهٔ آن‌ها ثبت می‌شوند.</div>` : ''}
      </div>

      <div class="row" style="margin-top:10px;gap:8px">
        <button class="btn ghost" data-act="import-back">بازگشت به نگاشت</button>
        <button class="btn primary grow" data-act="import-apply" ${ok.length ? '' : 'disabled'}>
          ${ok.length ? 'ثبت ' + fa(ok.length) + ' ردیف' : 'ردیفی برای ثبت نیست'}
        </button>
      </div>
      ${follow.length ? `<div class="small muted" style="margin-top:8px">${fa(follow.length)} ردیف پس از ثبت، در «کاربران ← نیازمند پیگیری» برای اصلاح می‌ماند.</div>` : ''}
    `;
  }

  const res = imp.result || { created: 0, updated: 0, parents: 0, classes: 0, errors: [] };
  const openIssues = list('import_issues').filter(r => r.status !== 'done').length;
  const unit = imp.kind === 'grades' ? 'نمره' : imp.kind === 'attendance' ? 'حضور' : 'کاربر';
  return `${bar}<div class="center" style="padding:16px 0">
      <div style="font-size:40px">🎉</div>
      <h3 style="margin:8px 0 14px">ورود اطلاعات کامل شد</h3>
      <div class="grid g4" style="margin-bottom:8px">
        ${imp.kind === 'students'
          ? impStat('🎓', res.students || 0, 'دانش‌آموز وارد شد', 'green')
          : impStat('➕', res.marks || res.created || 0, unit + ' وارد شد', 'green')}
        ${imp.kind === 'students'
          ? impStat('👨‍👩‍👦', res.parents || 0, 'حساب ولی (پدر و مادر)', '')
          : impStat('♻️', res.updated || 0, 'به‌روزرسانی', '')}
        ${imp.kind === 'students'
          ? impStat('♻️', res.updated || 0, 'به‌روزرسانی', '')
          : impStat('🏛️', res.classes || 0, 'گروه (پایه + رشته)', '')}
        ${impStat('🏛️', res.classes || 0, 'گروه ساخته‌شده', '')}
      </div>
      ${imp.kind === 'students' ? `<div class="small" style="margin-bottom:10px;line-height:2">
        🎓 دانش‌آموز واردشده: <b>${fa(res.students || 0)}</b> نفر ·
        👨‍👩‍👦 اولیا ساخته‌شده: <b>${fa(res.parents || 0)}</b> حساب (پدر و مادر) ·
        🧑‍🏫 دبیر و کادر: <b>${fa(res.staff || 0)}</b> ·
        ♻️ به‌روزرسانی: <b>${fa(res.updated || 0)}</b> ·
        🏛️ گروه تازه: <b>${fa(res.classes || 0)}</b>
      </div>` : ''}
      ${(res.errors || []).length ? `<div class="small" style="color:#b91c1c;margin-bottom:8px">${fa(res.errors.length)} ردیف ثبت نشد:
        ${esc(res.errors.slice(0, 8).map(e => 'سطر ' + fa(e.row) + ': ' + impErrorText(e.error)).join(' · '))}</div>` : ''}
      <div class="small muted">نام کاربری هر نفر شمارهٔ همراه اوست و رمزش کد ملی؛ برای دانش‌آموز و پدر و مادر هر سه حساب ساخته شد.
        اگر کسی شمارهٔ همراه نداشت، نام کاربری‌اش کد ملی اوست. همه در «کاربران» با رمزشان دیده می‌شوند.</div>
      ${(res.warnings || []).length ? `<div class="small muted" style="margin-top:6px">⚠️ ${fa(res.warnings.length)} مورد نیاز به تکمیل دارد:
        ${esc((res.warnings || []).slice(0, 6).map(w => w.name || '').join('، '))}</div>` : ''}
      ${S.impSavedIssues ? `<div class="small" style="margin-top:6px;color:#b45309">🕒 ${fa(S.impSavedIssues)} ردیف در «کاربران ← نیازمند پیگیری» ذخیره شد تا بعداً کامل شوند.</div>` : ''}
      ${openIssues ? `<div class="small muted" style="margin-top:4px">در کل ${fa(openIssues)} ردیف نیازمند پیگیری در فهرست مانده است.</div>` : ''}
      <div class="row" style="margin-top:14px;gap:8px;justify-content:center">
        <button class="btn ghost" data-act="import-open">فایل بعدی</button>
        ${openIssues ? '<button class="btn" data-act="issues-open">🕒 فهرست پیگیری</button>' : ''}
        <button class="btn primary" data-act="modal-close">تمام</button>
      </div></div>`;
}

function actImport() {
  S.imp = { step: 1, kind: (S.imp && S.imp.kind) || 'students' };
  S.impGrades = [];                    /* پایه‌های فایل قبلی پاک می‌شود */
  S.impSavedIssues = 0;
  S.modalTitle = 'ورود دسته‌ای از اکسل';
  modal(impStepHtml());
}
function renderImportStep() {
  S.modalTitle = 'ورود دسته‌ای از اکسل';
  modal(impStepHtml());
}

/* ══════════════ ثبت روی همین دستگاه (گوشی / نبود مدرسه) ══════════════
   همان قواعد سرور، ولی با نوشتن در صف همگام‌سازی. */
async function importApplyLocal(rows, kind, onProgress) {
  const created = [];
  const errors = [];
  let updated = 0, parents = 0, classes = 0, students = 0, staff = 0, marks = 0;
  const classMap = new Map(list('classes').map(c => [impNorm(c.name), c]));

  const findStudent = r => {
    if (r.national_id) {
      const byNid = list('users').find(u => u.role === 'student' && impLatin(u.national_id || '').replace(/\D/g, '') === r.national_id);
      if (byNid) return byNid;
    }
    const nm = impNorm(r.full_name || r.name || '');
    if (!nm) return null;
    const cands = list('users').filter(u => u.role === 'student' && impNorm(u.name || '') === nm);
    return cands.length === 1 ? cands[0] : null;
  };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    if (typeof onProgress === 'function') onProgress(i, rows.length);
    if (i % 25 === 24) await new Promise(res => setTimeout(res, 0));  /* صفحه قفل نکند */
    try {
      if (kind === 'grades' || kind === 'attendance') {
        const stu = findStudent(r);
        if (!stu) { errors.push({ row: r._row || i + 2, error: 'student_not_found' }); continue; }
        if (kind === 'grades') {
          const subj = list('subjects').find(s => impNorm(s.name) === impNorm(r.subject_name || ''))
            || list('subjects').find(s => Number(s.id) === Number(r.subject_id));
          if (!subj) { errors.push({ row: r._row || i + 2, error: 'subject_not_found' }); continue; }
          putLocal('grades', {
            student_id: stu.id, class_id: stu.class_id || null, subject_id: subj.id,
            term: r.term || 'نوبت اول', exam_type: r.exam_type || 'کلاسی',
            score: Number(r.score), max_score: 20, date: r.date || null, source: 'import', school_id: 1,
          });
        } else {
          putLocal('attendance', {
            student_id: stu.id, class_id: stu.class_id || null, date: r.date,
            status: r.status, note: r.note || '', source: 'import', school_id: 1,
          });
        }
        created.push({ id: stu.id });
        marks += 1;
        continue;
      }

      const name = String(r.full_name || r.name || '').trim();
      if (!name) { errors.push({ row: r._row || i + 2, error: 'missing_name' }); continue; }
      let classId = Number(r.class_id) || null;
      /* گروه ثبت‌نام = پایه + رشته. پایه از ردیف یا از پاسخ «این فایل چه
         پایه‌هایی است؟» گرفته می‌شود؛ رشته هم از خود فایل. */
      if (kind === 'students' && !classId) {
        const scopeGrade = (S.impGrades && S.impGrades.length === 1) ? S.impGrades[0] : '';
        const g0 = String(r.new_grade || scopeGrade || '').trim();
        const b0 = String(r.new_branch || '').trim();
        if (g0) { r.new_grade = g0; r.new_class = (g0 + (b0 ? ' ' + b0 : '')).trim(); r.new_branch = b0; delete r.followup_reason; }
      }
      if (kind === 'students' && !classId && r.new_class && r.new_grade) {
        const key = impNorm(r.new_class);
        let cls = classMap.get(key);
        if (!cls) {
          impEnsureLookup('grade', r.new_grade);
          if (r.new_branch) impEnsureLookup('branch', r.new_branch);
          const mode = impGradeLevel(r.new_grade) >= 10 ? 'field' : 'class';
          cls = putLocal('classes', {
            name: r.new_class, grade: r.new_grade || '',
            branch: mode === 'field' ? (r.new_branch || '') : '',
            mode, grade_level: impGradeLevel(r.new_grade), kind: 'group',
            capacity: 30, school_id: 1,
          });
          classMap.set(key, cls);
          classes += 1;
        }
        classId = cls.id;
      }
      const row = {
        name, role: kind === 'teachers' ? 'teacher' : 'student',
        national_id: r.national_id || '', phone: r.phone || '',
        class_id: classId, active: 1, school_id: 1,
      };
      if (kind === 'students' && !classId && r.followup_reason) row.followup_reason = r.followup_reason;
      IMP_EXTRA_FIELDS.forEach(k => { if (r[k] !== undefined && r[k] !== '' && r[k] !== null) row[k] = r[k]; });
      if (r.birth_date) row.birth_date = r.birth_date;
      if (r.father_nid) row.father_nid = r.father_nid;
      if (r.mother_nid) row.mother_nid = r.mother_nid;

      const existing = Number(r.existing_id) ? byId('users', Number(r.existing_id)) : null;
      const u = existing
        ? putLocal('users', Object.assign({}, existing, row, { id: existing.id }))
        : putLocal('users', row);
      if (existing) updated += 1;
      else {
        created.push(u);
        if (row.role === 'student') students += 1; else staff += 1;
      }

      if (kind === 'students') {
        [[r.father_nid, r.father_name, 'پدر', r.father_phone], [r.mother_nid, r.mother_name, 'مادر', r.mother_phone]]
          .forEach(([pnid, pname, rel, pphone]) => {
            if (!pnid && !pname && !pphone) return;
            const digits = x => impLatin(x || '').replace(/\D/g, '');
            let parent = pnid
              ? list('users').find(x => x.role === 'parent' && digits(x.national_id) === pnid)
              : null;
            if (!parent && pphone) {
              const cand = list('users').find(x => digits(x.phone) === pphone);
              /* همان حساب فقط اگر از آنِ همین ولی باشد (کد ملی هم‌خوان) */
              if (cand && cand.role === 'parent' && (!pnid || !digits(cand.national_id) || digits(cand.national_id) === pnid)) parent = cand;
            }
            if (!parent) {
              /* شماره فقط اگر آزاد است؛ اگر نبود، نام کاربری با کد ملی می‌شود */
              const free = pphone && !list('users').some(x => digits(x.phone) === pphone) ? pphone : '';
              parent = putLocal('users', {
                name: pname || (rel + ' ' + name), role: 'parent',
                national_id: pnid || '', phone: free, active: 1, school_id: 1,
              });
              parents += 1;
            }
            const linked = list('parent_links').some(l => Number(l.parent_id) === Number(parent.id) && Number(l.student_id) === Number(u.id));
            if (!linked) putLocal('parent_links', { parent_id: parent.id, student_id: u.id, relation: rel, school_id: 1 });
          });
      }
    } catch (e) {
      errors.push({ row: r._row || i + 2, error: String((e && e.message) || e) });
    }
  }
  if (typeof onProgress === 'function') onProgress(rows.length, rows.length);
  return {
    created: created.length, updated, parents, classes, errors,
    students: kind === 'students' ? students : 0,
    staff: kind === 'students' ? staff : created.length,
    marks: kind === 'grades' || kind === 'attendance' ? created.length : 0,
  };
}

/* در دسترسِ آزمون‌ها و app.js */
window.IMP_FIELDS = IMP_FIELDS;
window.IMP_ENTITY_FA = IMP_ENTITY_FA;
window.IMP_EXTRA_FIELDS = IMP_EXTRA_FIELDS;
window.impAutoMap = impAutoMap;
window.impCheck = impCheck;
window.impMapped = impMapped;
window.impStepHtml = impStepHtml;
window.impNeedsFollowUp = impNeedsFollowUp;
window.impSaveIssues = impSaveIssues;
window.actImport = actImport;
window.renderImportStep = renderImportStep;
window.importApplyLocal = importApplyLocal;
window.impErrorText = impErrorText;
window.impValidNid = impValidNid;
window.impJalaliToIso = impJalaliToIso;
window.impIsoToJalali = impIsoToJalali;
window.impNumFa = impNumFa;
window.impNorm = impNorm;
window.impLatin = impLatin;
