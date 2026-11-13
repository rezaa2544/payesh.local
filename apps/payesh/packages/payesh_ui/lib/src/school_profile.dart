/// مشخصات مدرسه (ردیف ۱۵۰) — ثابت‌های p2 + اعتبارسنجی فرم «مشخصات مدرسه» در تنظیمات مدیر.
///
/// فرم مالک فقط «مکان و ادارهٔ مربوطه» + «مشخصات مدیر» را دارد؛ بقیه را مدیر پر می‌کند.
/// قرارداد مشترک با سرور مدرسه (server/school-profile.js):
/// docs/cloud/contracts/school-profile-vectors.json — هر دو سمت «کد خطا» می‌دهند.
library;

const List<String> schoolLevels = ['ابتدایی', 'متوسطه اول', 'متوسطه دوم'];
const List<String> schoolGenders = ['پسرانه', 'دخترانه'];
const List<String> schoolShifts = ['صبح', 'بعدازظهر', 'شب', 'هر دو'];
const List<String> schoolKindsFa = [
  'عادی',
  'علوم تجربی',
  'ریاضی',
  'فنی و حرفه‌ای',
];

/// p2 SCHOOL_TYPE_DEFS: شناسه، عنوان، قابلیت‌هایی که روشن می‌کند.
const List<(String, String, Set<String>)> schoolTypeDefs = [
  ('governmental', 'دولتی معمولی', {}),
  ('exemplary', 'نمونه دولتی (هیئت امنایی)', {'has_tuition'}),
  ('non_profit', 'غیردولتی / غیرانتفاعی', {'has_tuition', 'has_dorm'}),
  ('sampad', 'تیزهوشان (سمپاد)', {}),
  ('shahed', 'شاهد', {'has_tuition'}),
  ('exceptional', 'استثنایی', {'has_iep'}),
  ('rural', 'روستایی / عشایری', {'has_multigrade'}),
  ('boarding', 'شبانه‌روزی', {'has_tuition', 'has_dorm'}),
  ('vocational', 'هنرستان', {'has_tuition', 'has_workshop'}),
];

/// p2 CAP_DEFS.
const List<(String, String, String)> capDefs = [
  ('has_tuition', 'شهریه', 'مدرسه شهریه می‌گیرد — ماژول مالی و شهریه فعال است'),
  ('has_dorm', 'اسکان و خانه‌دانش‌آموزی', 'مدرسه بخش اسکان دارد'),
  (
    'has_iep',
    'پشتیبانی ویژه (IEP)',
    'طرح فردی یادگیری برای دانش‌آموزان نیازمند ویژه',
  ),
  (
    'has_workshop',
    'کارگاه و آزمایشگاه',
    'فضای عملی/فنی برای پروژه‌های کارگاهی',
  ),
  ('has_multigrade', 'کلاس‌های چندپایه', 'چند پایه در یک کلاس (روستایی/کوچک)'),
  ('has_second_term_exam', 'امتحان نوبت دوم', 'مدرسه امتحان نوبت دوم می‌گذارد'),
  (
    'has_evening',
    'نوبت دوم / کلاس شبانه',
    'برنامهٔ فشردهٔ بزرگسالان — کلاس‌های شبانه با تراکمِ هفتگیِ بالاتر',
  ),
];
const Map<String, int> capDefaults = {
  'has_tuition': 1,
  'has_dorm': 0,
  'has_iep': 0,
  'has_workshop': 0,
  'has_multigrade': 0,
  'has_second_term_exam': 1,
  'has_evening': 0,
};

/// قابلیت‌های پیش‌فرض یک نوع مدرسه (p2: CAP_DEFAULTS + سطر نوع).
Map<String, int> capsForType(String type) {
  final out = Map<String, int>.of(capDefaults);
  final row = schoolTypeDefs.where((d) => d.$1 == type).firstOrNull;
  for (final k in const [
    'has_tuition',
    'has_dorm',
    'has_iep',
    'has_multigrade',
    'has_workshop',
  ]) {
    out[k] = row != null && row.$3.contains(k) ? 1 : 0;
  }
  return out;
}

/// p2 BRANCHES (شاخه‌ها و رشته‌های متوسطه دوم).
const Map<String, List<String>> schoolBranches = {
  'نظری': [
    'ریاضی فیزیک',
    'علوم تجربی',
    'ادبیات و علوم انسانی',
    'علوم و معارف اسلامی',
  ],
  'فنی و حرفه‌ای': [
    'الکتروتکنیک',
    'الکترونیک',
    'مکانیک خودرو',
    'کامپیوتر',
    'حسابداری',
    'ساختمان',
    'گرافیک',
  ],
  'کاردانش': ['تعمیر لوازم خانگی', 'طراحی دوخت', 'تأسیسات', 'صنایع غذایی'],
};

const List<String> weekDays = [
  'شنبه',
  'یکشنبه',
  'دوشنبه',
  'سه‌شنبه',
  'چهارشنبه',
  'پنجشنبه',
  'جمعه',
];
const List<int> defaultWorkDays = [0, 1, 2, 3, 4];

/// سقف‌ها (همان MAX سرور).
const int maxCapacity = 20000;
const int maxStaff = 5000;
const int maxExcuseMinutes = 240;
const int maxBoomChars = 2000;

/// متن فارسی هر کد خطای [SchoolProfile.validate].
const Map<String, String> schoolProfileErrorsFa = {
  'level': 'مقطع را انتخاب کنید',
  'type': 'نوع را انتخاب کنید',
  'school_type': 'نوع مدرسه را انتخاب کنید',
  'gender': 'جنسیت مدرسه را انتخاب کنید',
  'shift': 'شیفت را انتخاب کنید',
  'capacity': 'ظرفیت باید عددی بین ۱ تا ۲۰٬۰۰۰ باشد',
  'staff_count': 'تعداد کارکنان باید عددی بین ۰ تا ۵٬۰۰۰ باشد',
  'student_count': 'تعداد دانش‌آموزان معتبر نیست',
  'over_capacity': 'تعداد دانش‌آموزان از ظرفیت مدرسه بیشتر است',
  'landline': 'تلفن ثابت باید با ۰ شروع شود (۷ تا ۱۱ رقم)',
  'phone': 'تلفن همراه رابط باید ۱۱ رقم و با ۰۹ شروع شود',
  'work_days': 'دست‌کم یک روز کاری انتخاب کنید',
  'excuse': 'پنجرهٔ موجه باید بین ۰ تا ۲۴۰ دقیقه باشد',
  'capabilities': 'قابلیت ناشناخته',
  'branches': 'برای متوسطه دوم دست‌کم یک شاخه (نظری، فنی و حرفه‌ای یا کاردانش) انتخاب کنید',
  'fields': 'رشته باید از شاخه‌های انتخاب‌شده باشد',
  'boom_goals': 'متن اهداف بوم حداکثر ۲٬۰۰۰ نویسه باشد',
};

String _digits(Object? v) {
  final b = StringBuffer();
  for (final r in '${v ?? ''}'.runes) {
    if (r >= 0x06F0 && r <= 0x06F9) {
      b.write(r - 0x06F0);
    } else if (r >= 0x0660 && r <= 0x0669) {
      b.write(r - 0x0660);
    } else if (r >= 0x30 && r <= 0x39) {
      b.writeCharCode(r);
    }
  }
  return b.toString();
}

/// null = خالی، -1 = نامعتبر.
int? _intOf(Object? v) {
  if (v == null) return null;
  if (v is int) return v;
  if (v is num) return v == v.truncate() ? v.toInt() : -1;
  final t = _digitsKeep('$v'.trim());
  if (t.isEmpty) return null;
  return RegExp(r'^\d{1,9}$').hasMatch(t) ? int.parse(t) : -1;
}

/// ارقام فارسی/عربی ← لاتین، بقیهٔ نویسه‌ها دست‌نخورده (برای تشخیص «abc»).
String _digitsKeep(String s) {
  final b = StringBuffer();
  for (final r in s.runes) {
    if (r >= 0x06F0 && r <= 0x06F9) {
      b.write(r - 0x06F0);
    } else if (r >= 0x0660 && r <= 0x0669) {
      b.write(r - 0x0660);
    } else {
      b.writeCharCode(r);
    }
  }
  return b.toString();
}

/// نتیجهٔ اعتبارسنجی: یا [error] (کد) یا [patch] نرمال‌شده.
final class SchoolProfileCheck {
  const SchoolProfileCheck.error(String this.error) : patch = null;
  const SchoolProfileCheck.ok(Map<String, Object?> this.patch) : error = null;
  final String? error;
  final Map<String, Object?>? patch;
  String? get messageFa =>
      error == null ? null : schoolProfileErrorsFa[error] ?? 'مقدار نامعتبر';
}

/// مشخصات مدرسه‌ای که مدیر در تنظیمات تعیین می‌کند.
abstract final class SchoolProfile {
  /// همان validateProfile سرور (بایت‌به‌بایت با بردارهای مشترک).
  static SchoolProfileCheck validate(Map<String, Object?> b) {
    String str(String k, String d) =>
        b[k] == null || '${b[k]}'.isEmpty ? d : '${b[k]}';
    final level = str('level', '');
    if (!schoolLevels.contains(level)) {
      return const SchoolProfileCheck.error('level');
    }
    final type = str('type', 'عادی');
    if (!schoolKindsFa.contains(type)) {
      return const SchoolProfileCheck.error('type');
    }
    final st = str('school_type', 'governmental');
    if (!schoolTypeDefs.any((d) => d.$1 == st)) {
      return const SchoolProfileCheck.error('school_type');
    }
    final gender = str('gender', '');
    if (!schoolGenders.contains(gender)) {
      return const SchoolProfileCheck.error('gender');
    }
    final shift = str('shift', 'صبح');
    if (!schoolShifts.contains(shift)) {
      return const SchoolProfileCheck.error('shift');
    }
    final capacity = _intOf(b['capacity']);
    if (capacity == null || capacity < 1 || capacity > maxCapacity) {
      return const SchoolProfileCheck.error('capacity');
    }
    final staff = _intOf(b['staff_count']);
    if (staff != null && (staff < 0 || staff > maxStaff)) {
      return const SchoolProfileCheck.error('staff_count');
    }
    final students = _intOf(b['student_count']);
    if (students != null && students < 0) {
      return const SchoolProfileCheck.error('student_count');
    }
    if (students != null && students > capacity) {
      return const SchoolProfileCheck.error('over_capacity');
    }
    final landline = _digits(b['landline']);
    if (landline.isNotEmpty && !RegExp(r'^0\d{6,10}$').hasMatch(landline)) {
      return const SchoolProfileCheck.error('landline');
    }
    final phone = _digits(b['phone']);
    if (phone.isNotEmpty && !RegExp(r'^09\d{9}$').hasMatch(phone)) {
      return const SchoolProfileCheck.error('phone');
    }
    final wd = b['work_days'];
    final days = <int>{};
    var badDay = false;
    if (wd is List) {
      for (final d in wd) {
        final n = d is int
            ? d
            : (d is num && d == d.truncate() ? d.toInt() : -1);
        if (n < 0 || n > 6) badDay = true;
        days.add(n);
      }
    }
    if (days.isEmpty || badDay) {
      return const SchoolProfileCheck.error('work_days');
    }
    final excuse = _intOf(b['excuse_window_minutes']);
    if (excuse == null || excuse < 0 || excuse > maxExcuseMinutes) {
      return const SchoolProfileCheck.error('excuse');
    }
    final rc = b['capabilities'] is Map
        ? b['capabilities']! as Map
        : const <Object?, Object?>{};
    for (final k in rc.keys) {
      if (!capDefs.any((d) => d.$1 == k)) {
        return const SchoolProfileCheck.error('capabilities');
      }
    }
    final caps = <String, int>{
      for (final d in capDefs) d.$1: rc[d.$1] == 1 || rc[d.$1] == true ? 1 : 0,
    };
    if (shift == 'شب' || shift == 'هر دو') caps['has_evening'] = 1;
    var branches = <String>[];
    var fields = <String>[];
    if (level == 'متوسطه دوم') {
      branches = [
        ...{
          if (b['branches'] is List)
            for (final x in b['branches']! as List) '$x',
        },
      ];
      if (branches.isEmpty ||
          branches.any((x) => !schoolBranches.containsKey(x))) {
        return const SchoolProfileCheck.error('branches');
      }
      fields = [
        ...{
          if (b['fields'] is List)
            for (final x in b['fields']! as List) '$x',
        },
      ];
      final allowed = {for (final x in branches) ...schoolBranches[x]!};
      if (fields.any((f) => !allowed.contains(f))) {
        return const SchoolProfileCheck.error('fields');
      }
    }
    final boom = '${b['boom_goals'] ?? ''}';
    if (boom.length > maxBoomChars) {
      return const SchoolProfileCheck.error('boom_goals');
    }
    return SchoolProfileCheck.ok({
      'level': level,
      'type': type,
      'school_type': st,
      'gender': gender,
      'shift': shift,
      'capacity': capacity,
      'landline': landline,
      'phone': phone,
      'staff_count': staff,
      'student_count': students,
      'work_days': days.toList()..sort(),
      'excuse_window_minutes': excuse,
      'capabilities': caps,
      'branches': branches,
      'fields': fields,
      'boom_goals': boom,
      'public_goals': b['public_goals'] == true,
    });
  }
}
