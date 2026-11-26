// ردیف ۱۹۵ — ساختار آموزشی مدرسه بر پایهٔ مقطع (p2 `26-curriculum.js` و `18-modals.js`):
//   * ابتدایی (اول تا ششم) و متوسطه اول (هفتم تا نهم) = «کلاس‌محور»: کلاس‌ها ثابت‌اند، هر کلاس اتاق
//     و دبیر پایه دارد، رشته ندارد و برنامهٔ هفتگی برای هر کلاس جدا چیده می‌شود؛
//   * متوسطه دوم (دهم تا دوازدهم، شاخهٔ نظری / فنی و حرفه‌ای / کاردانش) = «رشته‌محور»: محور اصلی
//     «پایه × رشته» است، رشته فقط از شاخه‌های اعلام‌شدهٔ مدرسه، و مدیر کلاس/کارگاهِ هر زنگ را در
//     برنامهٔ هفتگی تعیین می‌کند.
// مقطع از مشخصات مدرسه (schools/1 `level`) خوانده می‌شود؛ اگر هنوز پر نشده باشد، از داده حدس زده
// می‌شود (کلاسِ رشته‌محور یا پایهٔ دهم به بالا ⇒ رشته‌محور).
import 'records.dart';
import 'classes.dart' show gradeLevel, normName;

/// p2 `LEVELS`.
const List<String> schoolLevelsFa = ['ابتدایی', 'متوسطه اول', 'متوسطه دوم'];

/// p2 `GRADES_OF_LEVEL`.
const Map<String, List<String>> levelGrades = {
  'ابتدایی': ['اول', 'دوم', 'سوم', 'چهارم', 'پنجم', 'ششم'],
  'متوسطه اول': ['هفتم', 'هشتم', 'نهم'],
  'متوسطه دوم': ['دهم', 'یازدهم', 'دوازدهم'],
};

/// p2 `BRANCHES` (شاخه‌ها و رشته‌های متوسطه دوم) — همان `schoolBranches` در payesh_ui.
const Map<String, List<String>> levelBranches = {
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

/// مقطعِ یک متن («متوسطهٔ دوم»، «متوسطه دوم»، «دبستان»…) یا '' اگر شناخته نشد.
String levelOf(Object? text) {
  final t = normName(text).replaceAll('ٔ', '');
  if (t.isEmpty) return '';
  if (t.contains('دوم') && t.contains('متوسطه')) return 'متوسطه دوم';
  if (t.contains('اول') && t.contains('متوسطه')) return 'متوسطه اول';
  if (t.contains('ابتدا') || t.contains('دبستان')) return 'ابتدایی';
  return '';
}

/// مقطعِ یک پایه (۱–۶ ابتدایی، ۷–۹ متوسطه اول، ۱۰–۱۲ متوسطه دوم) یا ''.
String levelOfGrade(Object? grade) {
  final n = gradeLevel(grade);
  if (n == 0) return '';
  return n <= 6 ? 'ابتدایی' : (n <= 9 ? 'متوسطه اول' : 'متوسطه دوم');
}

final class SchoolStructure {
  const SchoolStructure({
    required this.level,
    required this.fieldBased,
    this.branches = const [],
    this.fields = const [],
  });

  /// مقطع اعلام‌شدهٔ مدرسه یا '' (هنوز تعیین نشده).
  final String level;

  /// true = رشته‌محور (متوسطه دوم)، false = کلاس‌محور (ابتدایی / متوسطه اول).
  final bool fieldBased;

  /// شاخه‌ها و رشته‌های اعلام‌شده در مشخصات مدرسه (فقط متوسطه دوم).
  final List<String> branches;
  final List<String> fields;

  bool get classBased => !fieldBased;

  /// برچسب فارسی برای نوار راهنما.
  String get modeFa => fieldBased ? 'رشته‌محور' : 'کلاس‌محور';

  /// پایه‌های مقطع (خالی اگر مقطع تعیین نشده).
  List<String> get grades => levelGrades[level] ?? const [];

  /// رشته‌های مجاز: رشته‌های تیک‌خورده، وگرنه همهٔ رشته‌های شاخه‌های اعلام‌شده.
  List<String> get allowedFields {
    if (fields.isNotEmpty) return fields;
    return [for (final b in branches) ...?levelBranches[b]];
  }

  /// آیا [grade] در مقطع مدرسه هست؟ (مقطعِ نامعلوم = همه مجاز)
  bool gradeFits(String grade) {
    if (level.isEmpty) return true;
    return levelOfGrade(grade) == level;
  }

  /// آیا [field] جزو رشته‌های اعلام‌شدهٔ مدرسه است؟ (بدون اعلام = همه مجاز)
  bool fieldFits(String field) {
    final allowed = allowedFields;
    if (allowed.isEmpty) return true;
    final k = normName(field);
    return allowed.any((x) => normName(x) == k);
  }

  static Future<SchoolStructure> read(SchoolRecords db) async {
    final s = (await db.get('schools', 1))?.data ?? const {};
    final level = levelOf(s['level']);
    List<String> list(Object? v) => [
      if (v is List)
        for (final x in v)
          if (SchoolRecords.str(x).isNotEmpty) SchoolRecords.str(x),
    ];
    final branches = list(s['branches']);
    final fields = list(s['fields']);
    if (level.isNotEmpty) {
      return SchoolStructure(
        level: level,
        fieldBased: level == 'متوسطه دوم',
        branches: branches,
        fields: fields,
      );
    }
    // مقطع هنوز تعیین نشده: از داده حدس می‌زنیم (رفتار پیش از ردیف ۱۹۵ حفظ می‌شود)
    var field = branches.isNotEmpty;
    if (!field) {
      for (final c in await db.allOrEmpty('classes')) {
        if (c.data['kind'] == 'room') continue;
        final mode = SchoolRecords.str(c.data['mode']);
        if (mode == 'field' ||
            (mode.isEmpty &&
                (SchoolRecords.str(c.data['branch']).isNotEmpty ||
                    gradeLevel(c.data['grade'] ?? c.data['name']) >= 10))) {
          field = true;
          break;
        }
      }
    }
    return SchoolStructure(
      level: '',
      fieldBased: field,
      branches: branches,
      fields: fields,
    );
  }
}
