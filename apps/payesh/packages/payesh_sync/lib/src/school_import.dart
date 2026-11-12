// Row 128, wave W10 — bulk import from a spreadsheet (web client/import.js: forms `import-file`
// and `imp-fix`, actions import-open / import-check / import-back / imp-recheck /
// imp-branch-yes|no / import-apply). Same rules as the web client:
//   * no template: the header row is the fullest of the first five rows; columns are mapped by
//     title and synonyms, a father/mother/guardian column never maps to the student's field;
//   * students need the grades of the file (one grade = given to every row without one);
//     grade and branch are read from their columns or the class name; a branch that only LOOKS
//     like a defined one is never merged silently — the manager answers yes/no;
//   * class mode (≤ 9th) attaches/creates the class «grade»; field mode (≥ 10th) stores grade and
//     branch on the student and never creates a class;
//   * national id = exactly 10 digits and unique in the file and the school (an existing student
//     is UPDATED); a mobile is fixed to 11 digits «09…» when Excel ate the leading zero, and an
//     unfixable one blocks the row until the manager corrects it in place (`imp-fix`);
//   * a student's father/mother get parent accounts (re-used by national id / own mobile) and
//     parent links; grades and attendance find the existing student and subject;
//   * rows that were not created or are incomplete go to «نیازمند پیگیری» (`import_issues`).
// Unlike the web there is no server round-trip: everything is written local-first through the
// outbox (the web's own offline path, `importApplyLocal`), all-or-nothing for the queue.
import 'package:payesh_data/payesh_data.dart';

import 'attendance.dart' show AttendanceBook;
import 'classes.dart' show gradeLevel, normName;
import 'grades.dart' show GradeBook, GradeTerm;
import 'records.dart';
import 'sheet_reader.dart';
import 'users.dart' show roleFa;

typedef ImportField = (String key, String label, bool required, List<String>);

const Map<String, String> importKindFa = {
  'students': 'دانش‌آموزان (به‌همراه اولیا و رشته)',
  'teachers': 'دبیران',
  'grades': 'نمرات دورهٔ گذشته',
  'attendance': 'حضور و غیاب دورهٔ گذشته',
};

/// Web `IMP_FIELDS`.
const Map<String, List<ImportField>> importFields = {
  'students': [
    ('first_name', 'نام', false, ['نام', 'نام دانش آموز', 'اسم']),
    (
      'last_name',
      'نام خانوادگی',
      false,
      ['نام خانوادگی', 'فامیل', 'فامیلی', 'نام فامیل'],
    ),
    (
      'full_name',
      'نام و نام خانوادگی',
      false,
      ['نام و نام خانوادگی', 'نام کامل', 'نام و نام‌خانوادگی'],
    ),
    (
      'national_id',
      'کد ملی',
      false,
      ['کد ملی', 'کدملی', 'شماره ملی', 'شماره‌ملی'],
    ),
    ('birth_date', 'تاریخ تولد', false, ['تاریخ تولد', 'تولد', 'ت تولد']),
    ('gender', 'جنسیت', false, ['جنسیت', 'جنس']),
    (
      'shenasname_serial',
      'سریال شناسنامه',
      false,
      ['سریال شناسنامه', 'سریال', 'شماره شناسنامه'],
    ),
    ('shenasname_seri', 'سری شناسنامه', false, ['سری شناسنامه', 'سری']),
    (
      'class_name',
      'کلاس/شعبه در فایل (اختیاری)',
      false,
      ['کلاس', 'نام کلاس', 'پایه و کلاس'],
    ),
    (
      'grade',
      'پایه',
      false,
      ['پایه', 'مقطع تحصیلی', 'سال تحصیلی', 'پایه تحصیلی'],
    ),
    ('field', 'رشته', false, ['رشته', 'رشته تحصیلی', 'گرایش', 'رشته و گرایش']),
    (
      'last_gpa',
      'معدل سال گذشته',
      false,
      ['معدل سال گذشته', 'معدل قبلی', 'معدل'],
    ),
    (
      'failed_count',
      'تعداد درس افتاده',
      false,
      ['تعداد درس افتاده', 'درس افتاده', 'مردودی'],
    ),
    ('father_name', 'نام پدر', false, ['نام پدر', 'پدر']),
    (
      'father_nid',
      'کد ملی پدر',
      false,
      ['کد ملی پدر', 'کدملی پدر', 'کد ملی ولی'],
    ),
    ('father_edu', 'تحصیلات پدر', false, ['تحصیلات پدر', 'مدرک پدر']),
    ('father_alive', 'وضعیت حیات پدر', false, ['وضعیت حیات پدر', 'حیات پدر']),
    ('father_job', 'شغل پدر', false, ['شغل پدر', 'حرفه پدر']),
    (
      'father_phone',
      'موبایل پدر',
      false,
      [
        'موبایل پدر',
        'شماره موبایل پدر',
        'شماره همراه پدر',
        'همراه پدر',
        'تلفن همراه پدر', //
        'تلفن پدر', 'شماره پدر', 'شماره تماس پدر', 'موبایل ۱', 'موبایل 1',
      ],
    ),
    ('mother_name', 'نام مادر', false, ['نام مادر', 'مادر']),
    ('mother_nid', 'کد ملی مادر', false, ['کد ملی مادر', 'کدملی مادر']),
    ('mother_edu', 'تحصیلات مادر', false, ['تحصیلات مادر', 'مدرک مادر']),
    (
      'mother_alive',
      'وضعیت حیات مادر',
      false,
      ['وضعیت حیات مادر', 'حیات مادر'],
    ),
    ('mother_job', 'شغل مادر', false, ['شغل مادر', 'حرفه مادر']),
    (
      'mother_phone',
      'موبایل مادر',
      false,
      [
        'موبایل مادر',
        'شماره موبایل مادر',
        'شماره همراه مادر',
        'همراه مادر',
        'تلفن همراه مادر', //
        'تلفن مادر', 'شماره مادر', 'شماره تماس مادر', 'موبایل ۲', 'موبایل 2',
      ],
    ),
    (
      'guardian',
      'سرپرست دانش آموز',
      false,
      ['سرپرست دانش آموز', 'سرپرست', 'ولی'],
    ),
    ('guardian_alive', 'وضعیت حیات', false, ['وضعیت حیات', 'حیات']),
    (
      'guardian_phone',
      'موبایل سرپرست',
      false,
      [
        'موبایل سرپرست',
        'شماره همراه سرپرست',
        'همراه سرپرست',
        'موبایل ولی',
        'شماره همراه ولی', //
        'همراه ولی', 'تلفن سرپرست', 'تلفن ولی',
      ],
    ),
    ('sisters', 'تعداد خواهر', false, ['تعداد خواهر', 'خواهر']),
    ('brothers', 'تعداد برادر', false, ['تعداد برادر', 'برادر']),
    ('covered', 'تحت پوشش', false, ['تحت پوشش', 'تحت‌پوشش']),
    ('org_type', 'نوع ارگان', false, ['نوع ارگان', 'ارگان', 'نهاد حمایتی']),
    ('org_percent', 'درصد', false, ['درصد', 'درصد حمایت']),
    (
      'talent',
      'استعداد یابی',
      false,
      ['استعداد یابی', 'استعدادیابی', 'استعداد'],
    ),
    (
      'phone',
      'موبایل دانش‌آموز',
      false,
      [
        'موبایل دانش آموز',
        'موبایل دانش‌آموز',
        'همراه دانش آموز',
        'همراه دانش‌آموز', //
        'موبایل هنرجو',
        'شماره همراه',
        'تلفن همراه',
        'شماره موبایل',
        'همراه',
        'موبایل',
        'شماره تماس',
      ],
    ),
    (
      'landline',
      'شماره ثابت',
      false,
      ['شماره ثابت', 'تلفن ثابت', 'ثابت', 'تلفن منزل'],
    ),
    ('residence', 'محل سکونت', false, ['محل سکونت', 'سکونت', 'شهر یا روستا']),
    ('village', 'نام روستا', false, ['نام روستا', 'روستا']),
    (
      'residence_status',
      'وضعیت اقامت',
      false,
      ['وضعیت اقامت', 'اقامت', 'تابعیت'],
    ),
    ('address', 'آدرس', false, ['آدرس', 'نشانی', 'ادرس']),
  ],
  'teachers': [
    ('first_name', 'نام', false, ['نام', 'نام دبیر', 'نام معلم', 'اسم']),
    ('last_name', 'نام خانوادگی', false, ['نام خانوادگی', 'فامیل', 'فامیلی']),
    (
      'full_name',
      'نام و نام خانوادگی',
      false,
      ['نام و نام خانوادگی', 'نام کامل'],
    ),
    ('national_id', 'کد ملی', false, ['کد ملی', 'کدملی', 'شماره ملی']),
    ('phone', 'موبایل', false, ['موبایل', 'تلفن همراه', 'شماره تماس', 'همراه']),
    ('subject', 'درس تخصصی', false, ['درس', 'تخصص', 'رشته', 'درس تخصصی']),
    ('degree', 'مدرک تحصیلی', false, ['مدرک', 'تحصیلات', 'مدرک تحصیلی']),
    ('address', 'آدرس', false, ['آدرس', 'نشانی']),
  ],
  'grades': [
    (
      'full_name',
      'نام و نام خانوادگی',
      false,
      ['نام', 'نام دانش آموز', 'اسم', 'نام و نام خانوادگی', 'نام کامل'],
    ),
    (
      'national_id',
      'کد ملی',
      false,
      ['کد ملی', 'کدملی', 'شماره ملی', 'شماره‌ملی'],
    ),
    ('class_name', 'کلاس', false, ['کلاس', 'نام کلاس', 'پایه و کلاس']),
    ('subject', 'درس', true, ['درس', 'نام درس', 'درس تحصیلی', 'برگه']),
    ('term', 'نوبت', false, ['نوبت', 'ترم', 'نوبت تحصیلی', 'نیم‌سال']),
    (
      'exam_type',
      'نوع آزمون',
      false,
      ['نوع آزمون', 'آزمون', 'نوع برگه', 'برگه امتحان'],
    ),
    ('score', 'نمره', true, ['نمره', 'نمره درس', 'امتیاز', 'نتیجه']),
    ('date', 'تاریخ آزمون', false, ['تاریخ آزمون', 'تاریخ', 'تاریخ ثبت']),
  ],
  'attendance': [
    (
      'full_name',
      'نام و نام خانوادگی',
      false,
      ['نام', 'نام دانش آموز', 'اسم', 'نام و نام خانوادگی', 'نام کامل'],
    ),
    (
      'national_id',
      'کد ملی',
      false,
      ['کد ملی', 'کدملی', 'شماره ملی', 'شماره‌ملی'],
    ),
    ('class_name', 'کلاس', false, ['کلاس', 'نام کلاس', 'پایه و کلاس']),
    ('date', 'تاریخ', true, ['تاریخ', 'تاریخ حضور', 'تاریغ']),
    ('status', 'وضعیت', true, ['وضعیت', 'حضور و غیاب', 'حالت', 'حضور', 'غیبت']),
    ('note', 'توضیح', false, ['توضیح', 'یادداشت', 'شرح', 'علت']),
  ],
};

/// Fields of the in-place fix form per kind (web `impFixCardHtml`): (key, label, numeric).
const Map<String, List<(String, String, bool)>> importFixFields = {
  'students': [
    ('full_name', 'نام و نام خانوادگی', false),
    ('national_id', 'کد ملی دانش‌آموز', true),
    ('phone', 'موبایل دانش‌آموز', true),
    ('father_nid', 'کد ملی پدر', true),
    ('father_phone', 'موبایل پدر', true),
    ('mother_nid', 'کد ملی مادر', true),
    ('mother_phone', 'موبایل مادر', true),
    ('guardian_phone', 'موبایل سرپرست', true),
    ('grade', 'پایه', false),
    ('field', 'رشته', false),
  ],
  'teachers': [
    ('full_name', 'نام و نام خانوادگی', false),
    ('national_id', 'کد ملی', true),
    ('phone', 'موبایل', true),
  ],
  'grades': [
    ('full_name', 'نام دانش‌آموز', false),
    ('national_id', 'کد ملی دانش‌آموز', true),
  ],
  'attendance': [
    ('full_name', 'نام دانش‌آموز', false),
    ('national_id', 'کد ملی دانش‌آموز', true),
  ],
};

const List<String> _ignoreCols = ['ردیف', 'شماره', 'رديف', '#', 'ش'];

/// Web `IMP_EXTRA_FIELDS`: stored on the user row as they are.
const List<String> importExtraFields = [
  'first_name', 'last_name', 'field', 'last_gpa', 'failed_count', //
  'father_name',
  'father_nid',
  'father_edu',
  'father_alive',
  'father_job',
  'father_phone',
  'mother_name',
  'mother_nid',
  'mother_edu',
  'mother_alive',
  'mother_job',
  'mother_phone',
  'guardian', 'guardian_alive', 'guardian_phone', 'sisters', 'brothers',
  'covered', 'org_type', 'org_percent', 'talent',
  'landline', 'residence', 'village', 'residence_status', 'address',
  'shenasname_serial', 'shenasname_seri', 'degree', 'gender',
];

const Map<String, String> _attMap = {
  'present': 'present', 'حاضر': 'present', 'حضور': 'present', 'پ': 'present', //
  'absent': 'absent', 'غایب': 'absent', 'غیبت': 'absent', 'غ': 'absent',
  'late': 'late', 'تأخیر': 'late', 'تاخیر': 'late', 'دیر': 'late', 'د': 'late',
  'excused': 'excused', 'موجه': 'excused', 'مرخصی': 'excused', 'م': 'excused',
};

/// Grades a student file can be scoped to (web step 1 check boxes).
const List<String> importGrades = [
  'دوازدهم',
  'یازدهم',
  'دهم',
  'نهم',
  'هشتم',
  'هفتم',
  'ششم',
  'پنجم',
  'چهارم',
  'سوم',
  'دوم',
  'اول', //
];

const Map<int, String> _gradeNum = {
  12: 'دوازدهم', 11: 'یازدهم', 10: 'دهم', 9: 'نهم', 8: 'هشتم', 7: 'هفتم', //
  6: 'ششم', 5: 'پنجم', 4: 'چهارم', 3: 'سوم', 2: 'دوم', 1: 'اول',
};

// ───────────────────────────────── text helpers ─────────────────────────────────

String _latin(Object? v) => '${v ?? ''}'.replaceAllMapped(
  RegExp('[۰-۹٠-٩]'),
  (m) => SchoolRecords.digitsOnly(m[0]),
);

String _faNum(int n) => n.toString().replaceAllMapped(
  RegExp('[0-9]'),
  (m) => '۰۱۲۳۴۵۶۷۸۹'[int.parse(m[0]!)],
);

/// Web `impNumFa`: «۱۲/۸۸» and «۱۲٫۸۸» are 12.88.
double? importNumber(Object? v) {
  var t = _latin(v)
      .replaceAll(RegExp('[٫،]'), '.')
      .replaceAll('/', '.')
      .replaceAll(RegExp(r'[^\d.]'), '');
  final parts = t.split('.');
  if (parts.length > 2) t = '${parts.first}.${parts.skip(1).join()}';
  if (t.isEmpty) return null;
  return double.tryParse(t);
}

/// Levenshtein distance (web `impLev`).
int importLev(String a, String b) {
  if (a == b) return 0;
  if (a.isEmpty) return b.length;
  if (b.isEmpty) return a.length;
  var prev = List<int>.generate(b.length + 1, (j) => j);
  var cur = List<int>.filled(b.length + 1, 0);
  for (var i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (var j = 1; j <= b.length; j++) {
      final cost = a[i - 1] == b[j - 1] ? 0 : 1;
      var m = prev[j] + 1;
      if (cur[j - 1] + 1 < m) m = cur[j - 1] + 1;
      if (prev[j - 1] + cost < m) m = prev[j - 1] + cost;
      cur[j] = m;
    }
    final t = prev;
    prev = cur;
    cur = t;
  }
  return prev[b.length];
}

/// Web `impGradeCanon`: the grade named in a text («یازدهم» before «دهم»), '' = none.
String importGradeCanon(Object? text, List<String> known) {
  final t = normName(text);
  if (t.isEmpty) return '';
  final cands = <(String, String)>[
    for (final g in known)
      if (gradeLevel(g) > 0) (g, normName(g)),
    for (final g in [...importGrades, 'پیش دانشگاهی'])
      (g == 'پیش دانشگاهی' ? 'پیش‌دانشگاهی' : g, normName(g)),
  ]..sort((a, b) => b.$2.length.compareTo(a.$2.length));
  final tokens = t.split(' ');
  for (final c in cands) {
    if (c.$2.isNotEmpty && tokens.contains(c.$2)) return c.$1;
  }
  for (final c in cands) {
    if (c.$2.length > 2 && t.contains(c.$2)) return c.$1;
  }
  final m = RegExp(r'(?:^|\s)(\d{1,2})(?:\s|$)').firstMatch(_latin(t));
  return m == null ? '' : _gradeNum[int.parse(m[1]!)] ?? '';
}

/// Web `impBranchCanon`: (name, matched a definition, a definition it only looks like).
(String, bool, String) importBranchCanon(Object? text, List<String> known) {
  var raw = '${text ?? ''}'.replaceAll(RegExp(r'\s+'), ' ').trim();
  raw = raw
      .replaceFirst(RegExp(r'^رشتهٔ?\s*'), '')
      .replaceFirst(RegExp(r'\s*رشتهٔ?$'), '')
      .trim();
  final t = normName(raw);
  if (t.isEmpty) return ('', false, '');
  var best = '';
  var bestD = 999;
  for (final g in known) {
    final gn = normName(g);
    if (gn.isEmpty) continue;
    if (gn == t) return (g, true, '');
    final d = importLev(gn, t);
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  if (best.isNotEmpty) {
    final gn = normName(best);
    if (bestD <= 2 || gn.contains(t) || t.contains(gn)) {
      return (raw, false, best);
    }
  }
  return (raw, false, '');
}

String _stripGrade(String name, String grade) {
  final g = normName(grade).split(' ').where((x) => x.isNotEmpty).toList();
  final out = <String>[];
  for (final tok
      in name
          .replaceAll(RegExp(r'[()\[\]\-_/\\]'), ' ')
          .split(RegExp(r'\s+'))) {
    final t = normName(tok);
    if (t.isEmpty || RegExp(r'^\d{1,2}$').hasMatch(_latin(t))) continue;
    if (g.any((x) => x == t || x.contains(t) || t.contains(x))) continue;
    out.add(tok.trim());
  }
  return out.join(' ').trim();
}

/// Web `impJalaliToIso` / `impAnyDate`: «۱۳۹۰/۵/۱۲» or an ISO date → «2011-08-03», '' = unread.
String importDate(Object? v) {
  final s = _latin(v).trim();
  final m = RegExp(r'(\d{4})\D(\d{1,2})\D(\d{1,2})').firstMatch(s);
  if (m == null) return '';
  final y = int.parse(m[1]!), mo = int.parse(m[2]!), d = int.parse(m[3]!);
  String p(int n) => n.toString().padLeft(2, '0');
  if (y > 1200 && y < 1700) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    final g = _toGregorian(y, mo, d);
    return '${g.$1}-${p(g.$2)}-${p(g.$3)}';
  }
  return y > 1900 ? '$y-${p(mo)}-${p(d)}' : '';
}

(int, int, int) _toGregorian(int jy0, int jm, int jd) {
  var jy = jy0;
  var gy = jy <= 979 ? 621 : 1600;
  jy -= jy <= 979 ? 0 : 979;
  var days =
      365 * jy +
      (jy ~/ 33) * 8 +
      ((jy % 33) + 3) ~/ 4 +
      78 +
      jd +
      (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  gy += 400 * (days ~/ 146097);
  days %= 146097;
  if (days > 36524) {
    days--;
    gy += 100 * (days ~/ 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * (days ~/ 1461);
  days %= 1461;
  if (days > 365) {
    gy += (days - 1) ~/ 365;
    days = (days - 1) % 365;
  }
  var gd = days + 1;
  final leap = (gy % 4 == 0 && gy % 100 != 0) || gy % 400 == 0;
  final sal = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  var gm = 1;
  for (; gm <= 12 && gd > sal[gm]; gm++) {
    gd -= sal[gm];
  }
  return (gy, gm, gd);
}

bool importValidNid(Object? v) =>
    RegExp(r'^\d{10}$').hasMatch(SchoolRecords.digitsOnly(v));

String _mobilePart(String part) {
  var t = _latin(part).trim();
  if (t.isEmpty) return '';
  final dec = RegExp(r'^(\d+)[.,]0+$').firstMatch(t);
  if (dec != null) t = dec[1]!;
  final sci = t.replaceAll(RegExp(r'\s'), '');
  if (RegExp(r'^\d+(?:\.\d+)?e\+?\d+$', caseSensitive: false).hasMatch(sci)) {
    final n = double.tryParse(sci);
    if (n != null && n > 0) t = n.round().toString();
  }
  var d = t.replaceAll(RegExp(r'\D'), '');
  if (d.isEmpty || RegExp(r'^0+$').hasMatch(d)) return '';
  if (d.startsWith('0098')) {
    d = d.substring(4);
  } else if (d.startsWith('98') && d.length >= 12) {
    d = d.substring(2);
  }
  if (RegExp(r'^09\d{9}$').hasMatch(d)) return d;
  if (RegExp(r'^9\d{9}$').hasMatch(d)) return '0$d';
  if (RegExp(r'^989\d{9}$').hasMatch(d)) return '0${d.substring(2)}';
  return '';
}

/// Web `impPickMobile`: the first valid mobile of a cell → (value, leading zero added).
(String, bool) importPickMobile(Object? raw) {
  final txt = '${raw ?? ''}';
  final whole = _mobilePart(txt.replaceAll(RegExp(r'[\s\-().]'), ''));
  if (whole.isNotEmpty) {
    final dw = _latin(txt).replaceAll(RegExp(r'\D'), '');
    return (whole, !dw.startsWith('09') && !RegExp(r'^(0098|98)').hasMatch(dw));
  }
  for (final part in txt.split(RegExp(r'[\s,،;؛/\\|\-–—]+'))) {
    if (part.isEmpty) continue;
    final v = _mobilePart(part);
    if (v.isEmpty) continue;
    final d = _latin(part)
        .replaceAll(RegExp(r'\D'), '')
        .replaceFirst(RegExp(r'^0098|^98(?=\d{10})'), '');
    return (v, !d.startsWith('09') && !RegExp(r'^0098|^98').hasMatch(d));
  }
  return ('', false);
}

/// Web `impMobileFix` + `impPhoneMsg`: (complete value or null, Persian message).
(String?, String) importMobileFix(String who, Object? raw) {
  final txt = '${raw ?? ''}'.trim();
  final (v, _) = importPickMobile(txt);
  if (v.isNotEmpty) return (v, '');
  var d = _latin(txt).replaceAll(RegExp(r'\D'), '');
  if (d.startsWith('0098')) {
    d = d.substring(4);
  } else if (d.startsWith('98') && d.length >= 11) {
    d = d.substring(2);
  }
  final guess = d.startsWith('9') ? '0$d' : d;
  final head = 'موبایل $who «$txt»';
  if (RegExp(r'^09\d{9}$').hasMatch(guess)) {
    return (guess, '$head با صفرِ اول «$guess» می‌شود — ثبت می‌شود.');
  }
  if (guess.isNotEmpty) {
    return (
      null,
      '$head ${_faNum(d.length)} رقم است؛ با صفرِ اول «$guess» می‌شود و هنوز یک رقم کم دارد '
          '(باید ۱۱ رقم و با ۰۹ شروع شود) — همین‌جا کاملش کنید.',
    );
  }
  return (
    null,
    '$head خوانده نشد — باید ۱۱ رقم و با ۰۹ شروع شود؛ همین‌جا درستش کنید.',
  );
}

String _relOf(String nh) {
  if (nh.contains('مادر')) return 'mother';
  if (nh.contains('پدر')) return 'father';
  if (RegExp('(سرپرست|قیم|ولی)').hasMatch(nh)) return 'guardian';
  if (RegExp('(دانش ?آموز|هنرجو)').hasMatch(nh)) return 'student';
  return '';
}

String _keyRel(String key) => key.startsWith('father_')
    ? 'father'
    : key.startsWith('mother_')
    ? 'mother'
    : key.startsWith('guardian')
    ? 'guardian'
    : '';

bool _relOk(String rel, String kr) =>
    rel == kr ||
    (rel == 'guardian' && kr == 'father') ||
    (rel == 'father' && kr == 'guardian');

/// Web `impAutoMap`: column index → field key ('' = ignored).
List<String> importAutoMap(List<String> headers, String kind) {
  final fields = importFields[kind] ?? importFields['students']!;
  final out = List<String?>.filled(headers.length, null);
  final used = <String>{};
  var alive = 0;
  const aliveOrder = ['father_alive', 'mother_alive', 'guardian_alive'];
  if (kind == 'students') {
    for (var i = 0; i < headers.length; i++) {
      final nh = normName(headers[i]);
      if (nh.contains('حیات') && !nh.contains('پدر') && !nh.contains('مادر')) {
        if (alive < aliveOrder.length) {
          out[i] = aliveOrder[alive];
          used.add(aliveOrder[alive]);
          alive++;
        }
      }
    }
  }
  for (var i = 0; i < headers.length; i++) {
    if (out[i] != null) continue;
    final nh = normName(headers[i]);
    if (nh.isEmpty || _ignoreCols.contains(nh)) {
      out[i] = '';
      continue;
    }
    final rel = _relOf(nh);
    var best = '';
    var score = 0;
    for (final (key, label, _, syn) in fields) {
      if (used.contains(key)) continue;
      final kr = _keyRel(key);
      if (rel.isNotEmpty && kr.isNotEmpty && !_relOk(rel, kr)) continue;
      for (final sy in [label, ...syn]) {
        final ns = normName(sy);
        if (ns.isEmpty) continue;
        var sc = 0;
        if (nh == ns) {
          sc = 100;
        } else if (nh.contains(ns) || ns.contains(nh)) {
          sc = 70 + (ns.length < 20 ? ns.length : 20);
        }
        if (sc > 0 &&
            (rel == 'father' || rel == 'mother' || rel == 'guardian') &&
            kr.isEmpty) {
          sc -= 36;
        }
        if (sc > 0 && rel == 'student' && kr.isEmpty) sc += 30;
        if (sc > score) {
          score = sc;
          best = key;
        }
      }
    }
    out[i] = score >= 70 ? best : '';
    if (out[i]!.isNotEmpty) used.add(best);
  }
  if (kind == 'students' && !used.contains('phone')) {
    for (var i = 0; i < headers.length; i++) {
      if ((out[i] ?? '').isNotEmpty) continue;
      final nh = normName(headers[i]);
      if (!RegExp('(موبایل|همراه)').hasMatch(nh)) continue;
      final rel = _relOf(nh);
      if (rel == 'father' || rel == 'mother' || rel == 'guardian') continue;
      out[i] = 'phone';
      break;
    }
  }
  return [for (final o in out) o ?? ''];
}

// ───────────────────────────────── session and review ─────────────────────────────────

/// The wizard state (web `S.imp`): file, mapping, in-place fixes and branch answers.
final class ImportSession {
  ImportSession({
    required this.kind,
    required this.fileName,
    required this.sheetName,
    required this.headers,
    required this.rows,
    required this.map,
    this.headerRow = 0,
    this.grades = const [],
  });

  /// Step 1 (`import-file`): picks the sheet, finds the header row, guesses the mapping.
  factory ImportSession.fromBook(
    SheetBook book, {
    required String kind,
    required String fileName,
    List<String> grades = const [],
  }) {
    if (!importKindFa.containsKey(kind)) {
      throw RecordFailure('invalid', 'نوع «$kind» شناخته نیست');
    }
    if (kind == 'students' && grades.isEmpty) {
      throw const RecordFailure(
        'invalid',
        'اول پایه را انتخاب کنید — بدون پایه، دانش‌آموز و کلاسش ساخته نمی‌شود',
      );
    }
    final sheet = book.firstWithRows;
    if (sheet == null || sheet.rows.isEmpty) {
      throw const RecordFailure('invalid', 'این فایل هیچ سطری ندارد');
    }
    final all = [
      for (final r in sheet.rows)
        if (r.any((c) => c.trim().isNotEmpty)) r,
    ];
    if (all.isEmpty) {
      throw const RecordFailure('invalid', 'در این فایل سطر داده‌ای نیست');
    }
    final width = all.fold(0, (m, r) => r.length > m ? r.length : m);
    var hi = 0;
    var bestCells = 0;
    for (var i = 0; i < all.length && i < 5; i++) {
      final n = all[i].where((c) => c.trim().isNotEmpty).length;
      if (n > bestCells) {
        bestCells = n;
        hi = i;
      }
    }
    final first = [
      for (var i = 0; i < width; i++)
        i < all[hi].length ? all[hi][i].trim() : '',
    ];
    final guess = importAutoMap(first, kind);
    final hasHeader = guess.any((g) => g.isNotEmpty);
    final rows = hasHeader ? all.sublist(hi + 1) : all;
    if (rows.isEmpty) {
      throw const RecordFailure('invalid', 'در این فایل سطر داده‌ای نیست');
    }
    return ImportSession(
      kind: kind,
      fileName: fileName,
      sheetName: sheet.name,
      headers: [
        for (var i = 0; i < width; i++)
          hasHeader && first[i].isNotEmpty ? first[i] : 'ستون ${_faNum(i + 1)}',
      ],
      rows: rows,
      map: hasHeader ? guess : List.filled(width, ''),
      headerRow: hasHeader ? hi + 1 : 0,
      grades: grades,
    );
  }

  final String kind;
  final String fileName;
  final String sheetName;
  final List<String> headers;
  final List<List<String>> rows;

  /// Column → field key, editable in step 2.
  final List<String> map;
  final int headerRow;
  final List<String> grades;

  /// `imp-fix`: row index → field → corrected value ('' clears).
  final Map<int, Map<String, String>> edits = {};

  /// `imp-branch-yes|no`: file branch → defined branch it means ('' = a different branch).
  final Map<String, String> branchAsk = {};

  int get mapped => map.where((m) => m.isNotEmpty).length;

  /// Form `imp-fix`: the corrected values of one row; then the whole file is checked again.
  /// Unlike the web form an emptied field clears the value (so a wrong optional number can be
  /// removed instead of blocking the row).
  void fix(int idx, Map<String, String> values) {
    final cur = {...?edits[idx]};
    for (final e in values.entries) {
      cur[e.key] = e.value.trim();
    }
    edits[idx] = cur;
  }

  /// Value shown in the fix form (edit, else the file's value; mobiles with the zero added).
  String fixValue(ImportRow r, String key) {
    final v =
        edits[r.idx]?[key] ?? r.raw[key] ?? SchoolRecords.str(r.data[key]);
    if (v.trim().isEmpty || !key.endsWith('phone')) return v;
    final (fx, _) = importMobileFix('', v);
    if (fx != null) return fx;
    var d = _latin(v).replaceAll(RegExp(r'\D'), '');
    if (d.startsWith('9')) d = '0$d';
    return d.isEmpty ? v : d;
  }

  /// Web `impMapped`: one map of field → text per non-empty row, with the manager's edits.
  List<(int row, int idx, Map<String, String>)> mappedRows() {
    final out = <(int, int, Map<String, String>)>[];
    final firstData = headerRow + 1;
    for (var idx = 0; idx < rows.length; idx++) {
      final o = <String, String>{};
      for (var col = 0; col < map.length; col++) {
        final key = map[col];
        if (key.isEmpty || col >= rows[idx].length) continue;
        final v = rows[idx][col].trim();
        if (v.isNotEmpty) o[key] = v;
      }
      for (final e in (edits[idx] ?? const <String, String>{}).entries) {
        final v = e.value.trim();
        if (v.isEmpty) {
          o.remove(e.key);
        } else {
          o[e.key] = v;
        }
      }
      if (o.isEmpty) continue;
      out.add((idx + (firstData > 1 ? firstData : 1), idx, o));
    }
    return out;
  }
}

/// One checked row of step 3.
final class ImportRow {
  ImportRow(this.row, this.idx, this.raw, this.data);
  final int row;
  final int idx;
  final Map<String, String> raw;
  final Map<String, Object?> data;
  final List<String> errors = [];
  final List<String> warns = [];

  /// Must be corrected here before the row is ready (also listed in [warns]).
  final List<String> blocks = [];

  bool get bad => errors.isNotEmpty;
  bool get needsFix => !bad && blocks.isNotEmpty;
  bool get ready => !bad && blocks.isEmpty;

  /// Web `impNeedsFollowUp`.
  bool get followUp =>
      errors.isNotEmpty ||
      blocks.isNotEmpty ||
      warns.any(
        (w) =>
            RegExp('نامعتبر|بدون کد ملی|نه شمارهٔ همراه|بدون شماره')
                .hasMatch(w),
      );

  String get name => SchoolRecords.str(data['full_name']);
}

final class ImportReview {
  const ImportReview({
    required this.rows,
    required this.newClasses,
    required this.branchFixes,
    required this.branchAsk,
    required this.phonesFixed,
  });
  final List<ImportRow> rows;
  final List<String> newClasses;
  final List<(String, String)> branchFixes;

  /// Branches that only look like a defined one: (from, to) waiting for yes/no.
  final List<(String, String)> branchAsk;
  final int phonesFixed;

  List<ImportRow> get ready => [
    for (final r in rows)
      if (r.ready) r,
  ];
  List<ImportRow> get todo => [
    for (final r in rows)
      if (!r.ready) r,
  ];
  int get badCount => rows.where((r) => r.bad).length;
  int get followCount => rows.where((r) => r.followUp).length;
  int get updates => ready.where((r) => r.data['existing_id'] != null).length;
}

final class ImportResult {
  ImportResult();
  int created = 0;
  int updated = 0;
  int parents = 0;
  int classes = 0;
  int students = 0;
  int staff = 0;
  int marks = 0;
  int savedIssues = 0;
  int openIssues = 0;
  final List<(int, String)> errors = [];

  /// Outbox keys of the queued ops.
  final List<String> keys = [];

  String get summaryFa {
    final b = StringBuffer();
    if (marks > 0) {
      b.write('${_faNum(marks)} ردیف ثبت شد');
    } else {
      b.write('${_faNum(created)} کاربر ثبت شد');
    }
    if (updated > 0) b.write(' · ${_faNum(updated)} به‌روزرسانی');
    if (parents > 0) b.write(' · ${_faNum(parents)} حساب ولی');
    if (classes > 0) b.write(' · ${_faNum(classes)} کلاس تازه');
    if (savedIssues > 0) {
      b.write(' · ${_faNum(savedIssues)} ردیف در «نیازمند پیگیری» ماند');
    }
    return b.toString();
  }
}

/// Web `impErrorText`.
const Map<String, String> importErrorFa = {
  'missing_name': 'نام ندارد',
  'student_not_found': 'دانش‌آموز پیدا نشد',
  'subject_not_found': 'درس پیدا نشد',
};

final class _Op {
  _Op(this.collection, this.id, this.data, this.prev);
  final String collection;
  final int id;
  final Map<String, Object?> data;
  final EngineRow? prev;
}

final class SchoolImport {
  SchoolImport(this.db);
  final SchoolRecords db;

  static String _s(Object? v) => SchoolRecords.str(v);
  static int? _int(Object? v) => SchoolRecords.asInt(v);
  static String _d(Object? v) => SchoolRecords.digitsOnly(v);

  void _requireManager() {
    if (db.role != 'manager') {
      throw const RecordFailure(
        'not_allowed',
        'ورود دسته‌ای فقط برای مدیر است',
      );
    }
  }

  /// Step 3 (`import-check` / `imp-recheck`): every rule of the web `impCheck`.
  Future<ImportReview> check(ImportSession s) async {
    _requireManager();
    final users = await db.allOrEmpty('users');
    final classes = await db.allOrEmpty('classes');
    final lookups = await db.allOrEmpty('lookups');
    final subjects = await db.allOrEmpty('subjects');
    final kind = s.kind;
    var phones = 0;
    final clsByName = {for (final c in classes) normName(c.data['name']): c};
    final stuByNid = <String, EngineRow>{};
    final stuByName = <String, List<EngineRow>>{};
    for (final u in users) {
      if (u.data['role'] != 'student') continue;
      final nid = _d(u.data['national_id']);
      if (nid.isNotEmpty) stuByNid[nid] = u;
      final nm = normName(u.data['name']);
      if (nm.isNotEmpty) (stuByName[nm] ??= []).add(u);
    }
    var grades = [
      for (final l in lookups)
        if (l.data['kind'] == 'grade') _s(l.data['name']),
    ];
    var branches = [
      for (final l in lookups)
        if (l.data['kind'] == 'branch') _s(l.data['name']),
    ];
    if (branches.isEmpty) {
      branches = {
        for (final c in classes)
          if (_s(c.data['branch']).isNotEmpty) _s(c.data['branch']),
      }.toList();
    }
    if (grades.isEmpty) {
      grades = {
        for (final c in classes)
          if (_s(c.data['grade']).isNotEmpty) _s(c.data['grade']),
      }.toList();
    }
    final mapped = s.mappedRows();

    // branches not in the definitions: ask, never merge silently
    final alias = <String, String>{};
    final fixes = <(String, String)>[];
    final asks = <(String, String)>[];
    if (kind == 'students') {
      final defs = {for (final b in branches) normName(b): b};
      final seenB = <String>{};
      for (final (_, _, o) in mapped) {
        final v = (o['field'] ?? '').trim();
        final k = normName(v);
        if (k.isEmpty || !seenB.add(k) || defs.containsKey(k)) continue;
        var best = '';
        var bestD = 999;
        for (final e in defs.entries) {
          final d = importLev(e.key, k);
          if (d < bestD) {
            bestD = d;
            best = e.value;
          }
        }
        final ask = s.branchAsk[v];
        if (ask == null && best.isNotEmpty && bestD <= 2) asks.add((v, best));
        if (ask != null && ask.isNotEmpty) {
          alias[k] = ask;
          fixes.add((v, ask));
        }
      }
    }

    final seen = <String, (int, String, String, String)>{};
    final newClasses = <String>[];
    final newBranches = <String>{};
    final out = <ImportRow>[];
    for (final (rowNo, idx, o0) in mapped) {
      var o = o0;
      final data = <String, Object?>{};
      final r = ImportRow(rowNo, idx, o0, data);
      void fixIt(String m) {
        r.blocks.add(m);
        r.warns.add(m);
      }

      String sp(String? v) => (v ?? '').replaceAll(RegExp(r'\s+'), ' ').trim();
      final fn = sp(o['first_name']);
      final ln = sp(o['last_name']);
      final full = sp(o['full_name']).isNotEmpty
          ? sp(o['full_name'])
          : '$fn $ln'.trim();
      data['full_name'] = full;
      data['name'] = full;
      if (fn.isNotEmpty) data['first_name'] = fn;
      if (ln.isNotEmpty) data['last_name'] = ln;
      if ((kind == 'students' || kind == 'teachers') && full.length < 3) {
        r.errors.add('نام و نام خانوادگی الزامی است');
      }

      final nidRaw = (o['national_id'] ?? '').trim();
      final nid = _d(nidRaw);
      if (nid.isNotEmpty) {
        if (!importValidNid(nid)) {
          r.errors.add(
            'کد ملی «$nidRaw» معتبر نیست — باید دقیقاً ۱۰ رقم باشد (این مقدار ${_faNum(nid.length)} رقم است)',
          );
        } else if (seen.containsKey(nid) &&
            kind != 'grades' &&
            kind != 'attendance') {
          final (fr, fnm, fg, ff) = seen[nid]!;
          final place = [
            if (fg.isNotEmpty) 'پایهٔ $fg',
            if (ff.isNotEmpty) 'رشتهٔ $ff',
          ];
          r.errors.add(
            'کد ملی «$nid» تکراری است — همین کد در سطر ${_faNum(fr)} برای «${fnm.isEmpty ? '؟' : fnm}»'
            '${place.isEmpty ? '' : ' — ${place.join('، ')}'} هم آمده است؛ '
            'کد ملی شناسهٔ یکتای هر شخص است و دو نفر نمی‌توانند یک کد داشته باشند.',
          );
        } else {
          seen[nid] = (rowNo, full, '', '');
          EngineRow? owner;
          for (final u in users) {
            if (_d(u.data['national_id']) == nid) owner = u;
          }
          if (owner != null && (kind == 'students' || kind == 'teachers')) {
            if (owner.data['role'] == 'student' || kind == 'teachers') {
              r.warns.add('قبلاً ثبت شده — به‌روزرسانی می‌شود');
              data['existing_id'] = owner.id;
            } else {
              r.errors.add(
                'کد ملی متعلق به «${_s(owner.data['name'])}» با نقش '
                '${roleFa[owner.data['role']] ?? _s(owner.data['role'])} است — این کد برای نقش دیگری ثبت شده',
              );
            }
          }
          data['national_id'] = nid;
        }
      } else {
        r.warns.add('بدون کد ملی');
      }

      void mobile(String key, String who) {
        final raw = o[key] ?? '';
        final (v, fixed) = importPickMobile(raw);
        if (v.isNotEmpty) {
          data[key] = v;
          if (fixed) phones++;
        } else if (raw.trim().isNotEmpty) {
          final (fx, msg) = importMobileFix(who, raw);
          if (fx != null) {
            data[key] = fx;
            phones++;
          } else {
            fixIt(msg);
          }
        }
      }

      mobile('phone', 'دانش‌آموز');
      if (kind == 'students') mobile('father_phone', 'پدر');
      final ph = _s(data['phone']);
      if (ph.isNotEmpty) {
        for (final u in users) {
          if (_d(u.data['phone']) == ph && u.id != _int(data['existing_id'])) {
            r.errors.add(
              'این شمارهٔ همراه برای «${_s(u.data['name'])}» با نقش '
              '${roleFa[u.data['role']] ?? _s(u.data['role'])} ثبت شده است — هر شماره یک حساب دارد',
            );
            break;
          }
        }
      }

      if (kind == 'students') {
        var branchTxt = (o['field'] ?? '').trim();
        if (branchTxt.isNotEmpty && alias.containsKey(normName(branchTxt))) {
          branchTxt = alias[normName(branchTxt)]!;
          o = {...o, 'field': branchTxt};
        }
        final cname = sp(o['class_name']);
        var grade = importGradeCanon(o['grade'], grades);
        if (grade.isEmpty && cname.isNotEmpty) {
          grade = importGradeCanon(cname, grades);
        }
        if (grade.isEmpty && s.grades.length == 1) grade = s.grades.first;
        var bc = importBranchCanon(branchTxt, branches);
        if (bc.$1.isEmpty && cname.isNotEmpty) {
          bc = importBranchCanon(_stripGrade(cname, grade), branches);
        }
        final branch = bc.$1;
        if (grade.isNotEmpty &&
            branch.isNotEmpty &&
            normName(grade) == normName(branch)) {
          grade = '';
        }
        final place = grade.isEmpty
            ? ''
            : '$grade${branch.isEmpty ? '' : ' $branch'}';
        final level = gradeLevel(grade);
        data['grade'] = grade;
        if (branch.isNotEmpty) data['field'] = branch;
        final cls = place.isEmpty ? null : clsByName[normName(place)];
        if (cls != null &&
            _s(cls.data['kind']) != 'group' &&
            _s(cls.data['kind']) != 'room') {
          data['class_id'] = cls.id;
        } else if (level >= 10 && grade.isNotEmpty) {
          data['class_id'] = null;
          data['new_grade'] = grade;
          data['new_branch'] = branch;
          if (branch.isNotEmpty &&
              !bc.$2 &&
              !alias.containsKey(normName(branch))) {
            if (newBranches.add(normName(branch))) {
              r.warns.add('رشتهٔ «$branch» به فهرست رشته‌ها اضافه می‌شود');
            }
          }
        } else if (place.isNotEmpty) {
          data['new_class'] = place;
          data['new_grade'] = grade;
          data['new_branch'] = branch;
          if (!newClasses.contains(place)) newClasses.add(place);
          r.warns.add('کلاس «$place» ساخته می‌شود');
        } else if (branch.isNotEmpty) {
          data['class_id'] = null;
          data['followup_reason'] = 'پایه در فایل نبود (رشته: $branch)';
          r.warns.add(
            'کلاس ساخته نشد: ${data['followup_reason']} — در «نیازمند پیگیری» کامل کنید',
          );
        } else {
          r.warns.add('بدون کلاس');
        }
        if (branch.isNotEmpty &&
            bc.$3.isNotEmpty &&
            (s.branchAsk[(o0['field'] ?? '').trim()] ?? '').isEmpty) {
          r.warns.add(
            'رشتهٔ «$branch» شبیه «${bc.$3}» است — بالای همین صفحه تأیید یا رد کنید',
          );
        }

        final bd = o['birth_date'];
        if (bd != null) {
          final iso = importDate(bd);
          if (iso.isNotEmpty) {
            data['birth_date'] = iso;
          } else {
            r.warns.add(
              'تاریخ تولد «${bd.trim()}» خوانده نشد — در «مشخصات کامل» درستش کنید',
            );
          }
        }
        final g = normName(o['gender']);
        data['gender'] = RegExp('پسر|مذکر|مرد').hasMatch(g)
            ? 'پسر'
            : RegExp('دختر|مونث|مؤنث|زن').hasMatch(g)
            ? 'دختر'
            : '';
        for (final (k, who) in [
          ('father_nid', 'پدر'),
          ('mother_nid', 'مادر'),
        ]) {
          final rawV = (o[k] ?? '').trim();
          final v = _d(rawV);
          if (v.isNotEmpty && importValidNid(v)) {
            data[k] = v;
          } else if (v.isNotEmpty) {
            fixIt(
              'کد ملی $who «$rawV» معتبر نیست — باید دقیقاً ۱۰ رقم باشد (این مقدار ${_faNum(v.length)} رقم است)؛ همین‌جا اصلاحش کنید.',
            );
          }
        }
        data['father_name'] = (o['father_name'] ?? '').trim();
        data['mother_name'] = (o['mother_name'] ?? '').trim();
        mobile('mother_phone', 'مادر');
        mobile('guardian_phone', 'سرپرست');
        for (final (who, nm, nk, pk) in [
          ('پدر', 'father_name', 'father_nid', 'father_phone'),
          ('مادر', 'mother_name', 'mother_nid', 'mother_phone'),
        ]) {
          final has =
              _s(data[nm]).isNotEmpty || data[nk] != null || data[pk] != null;
          if (!has) continue;
          if (_s(data[nm]).isEmpty) data[nm] = '$who $full';
          if (data[nk] == null && data[pk] == null) {
            r.warns.add(
              'برای $who نه شمارهٔ همراه هست نه کد ملی — بعداً در «کاربران ← ویرایش» کامل کنید',
            );
          }
        }
        if (data['father_phone'] != null &&
            data['father_phone'] == data['mother_phone']) {
          r.warns.add(
            'شمارهٔ همراه پدر و مادر یکی است — مادر با کد ملی وارد می‌شود',
          );
          data.remove('mother_phone');
        }
        for (final k in const [
          'father_edu', 'mother_edu', 'father_job', 'mother_job', 'guardian', //
          'residence', 'village', 'residence_status', 'address',
          'shenasname_serial', 'shenasname_seri', 'talent', 'org_type',
        ]) {
          final v = (o[k] ?? '').trim();
          if (v.isNotEmpty) data[k] = v;
        }
        for (final k in const [
          'father_alive',
          'mother_alive',
          'guardian_alive',
        ]) {
          final v = normName(o[k]);
          if (v.isEmpty) continue;
          data[k] = RegExp('فوت|مرحوم|متوفی').hasMatch(v)
              ? 'فوت'
              : 'در قید حیات';
        }
        for (final k in const [
          'sisters',
          'brothers',
          'failed_count',
          'org_percent',
        ]) {
          final n = importNumber(o[k]);
          if (n != null) data[k] = n == n.truncateToDouble() ? n.toInt() : n;
        }
        final gpa = importNumber(o['last_gpa']);
        if (gpa != null) {
          if (gpa >= 0 && gpa <= 20) {
            data['last_gpa'] = gpa;
          } else {
            r.warns.add('معدل «${o['last_gpa']}» خارج از بازهٔ ۰ تا ۲۰ است');
          }
        }
        final cov = normName(o['covered']);
        if (cov.isNotEmpty) {
          data['covered'] = RegExp('بل[ىی]|بله|دارد|آر[ىی]').hasMatch(cov)
              ? 1
              : 0;
        }
        final land = _d(
          (o['landline'] ?? '')
              .split(RegExp(r'[\s,،;؛/\\|]+'))
              .firstWhere((x) => x.isNotEmpty, orElse: () => ''),
        );
        if (land.isNotEmpty) data['landline'] = land;
        data['role'] = 'student';
      } else if (kind == 'teachers') {
        data['subject'] = (o['subject'] ?? '').trim();
        for (final k in const ['degree', 'address']) {
          final v = (o[k] ?? '').trim();
          if (v.isNotEmpty) data[k] = v;
        }
        data['role'] = 'teacher';
      } else {
        EngineRow? stu = nid.isNotEmpty ? stuByNid[nid] : null;
        if (stu == null && full.isNotEmpty) {
          var cands = stuByName[normName(full)] ?? const <EngineRow>[];
          final cn = normName(o['class_name']);
          if (cn.isNotEmpty) {
            final inCls = [
              for (final u in cands)
                if (normName(
                      classes
                          .where((c) => c.id == _int(u.data['class_id']))
                          .map((c) => c.data['name'])
                          .firstOrNull,
                    ) ==
                    cn)
                  u,
            ];
            if (inCls.isNotEmpty) cands = inCls;
          }
          if (cands.length == 1) {
            stu = cands.first;
          } else if (cands.length > 1) {
            r.errors.add('چند دانش‌آموز «$full» هست — کد ملی بنویسید');
          }
        }
        if (stu == null) {
          r.errors.add(
            nid.isNotEmpty && importValidNid(nid)
                ? 'دانش‌آموز با کد ملی «$nid» پیدا نشد — چنین کدی در این مدرسه نیست'
                : 'دانش‌آموز «${full.isEmpty ? '؟' : full}» در این مدرسه پیدا نشد',
          );
        } else {
          data['student_id'] = stu.id;
          data['class_id'] =
              _int(stu.data['class_id']) ??
              clsByName[normName(o['class_name'])]?.id;
        }
        if (kind == 'grades') {
          final subj = (o['subject'] ?? '').trim();
          if (subj.isEmpty) {
            r.errors.add('نام درس الزامی است');
          } else {
            final want = normName(subj);
            EngineRow? su;
            for (final x in subjects) {
              if (normName(x.data['name']) == want) su = x;
            }
            su ??= subjects.where((x) {
              final n = normName(x.data['name']);
              return n.isNotEmpty && (n.contains(want) || want.contains(n));
            }).firstOrNull;
            if (su != null) {
              data['subject_id'] = su.id;
            } else {
              r.errors.add('درس «$subj» در بانک درس‌های این مدرسه نیست');
            }
          }
          final sc = importNumber(o['score']);
          if (sc == null) {
            r.errors.add('نمره خوانده نشد');
          } else if (sc < 0 || sc > 20) {
            r.errors.add('نمره «${o['score']}» خارج از بازهٔ ۰ تا ۲۰ است');
          } else {
            data['score'] = sc;
          }
          final t = normName(_latin(o['term']));
          final term = t.isEmpty
              ? GradeTerm.first
              : RegExp(r'اول|یکم|1$').hasMatch(t)
              ? GradeTerm.first
              : RegExp(r'دوم|دویم|2$').hasMatch(t)
              ? GradeTerm.second
              : null;
          if (term == null) {
            r.warns.add('نوبت «${o['term']}» خوانده نشد — «نوبت اول» می‌شود');
          }
          data['term'] = (term ?? GradeTerm.first).wire;
          data['exam_type'] = (o['exam_type'] ?? '').trim().isEmpty
              ? 'کلاسی'
              : o['exam_type']!.trim();
          if (o['date'] != null) {
            final iso = importDate(o['date']);
            if (iso.isNotEmpty) {
              data['date'] = iso;
            } else {
              r.warns.add('تاریخ آزمون خوانده نشد');
            }
          }
        } else {
          final dt = o['date'];
          if (dt == null) {
            r.errors.add('تاریخ الزامی است');
          } else {
            final iso = importDate(dt);
            if (iso.isNotEmpty) {
              data['date'] = iso;
            } else {
              r.errors.add('تاریخ «$dt» خوانده نشد');
            }
          }
          final st = o['status'] ?? '';
          final key = _attMap[normName(st)] ?? _attMap[st.trim()];
          if (key == null) {
            r.errors.add('وضعیت «$st» شناخته نمی‌شود (حاضر/غایب/تأخیر/موجه)');
          } else {
            data['status'] = key;
          }
          data['note'] = (o['note'] ?? '').trim();
        }
      }
      if (nid.isNotEmpty && seen[nid]?.$1 == rowNo) {
        seen[nid] = (rowNo, full, _s(data['grade']), _s(data['field']));
      }
      out.add(r);
    }
    return ImportReview(
      rows: out,
      newClasses: newClasses,
      branchFixes: fixes,
      branchAsk: asks,
      phonesFixed: phones,
    );
  }

  /// `import-apply`: writes the ready rows (all-or-nothing for the queue), then saves the rows
  /// that need follow-up to `import_issues`.
  Future<ImportResult> apply(ImportSession s, ImportReview review) async {
    _requireManager();
    final ready = review.ready;
    if (ready.isEmpty) {
      throw const RecordFailure(
        'invalid',
        'سطر سالمی برای ثبت نیست — اول ایرادها را اصلاح کنید',
      );
    }
    final kind = s.kind;
    final res = ImportResult();
    final ops = <_Op>[];
    final users = {for (final u in await db.allOrEmpty('users')) u.id: u};
    final lookups = [for (final l in await db.allOrEmpty('lookups')) l.data];
    final links = [for (final l in await db.allOrEmpty('parent_links')) l.data];
    final classes = <String, int>{
      for (final c in await db.allOrEmpty('classes'))
        if (_s(c.data['kind']) != 'group' && _s(c.data['kind']) != 'room')
          normName(c.data['name']): c.id,
    };
    final newUsers = <int, Map<String, Object?>>{};
    Iterable<(int, Map<String, Object?>)> allUsers() sync* {
      for (final u in users.values) {
        yield (u.id, newUsers[u.id] ?? u.data);
      }
      for (final e in newUsers.entries) {
        if (!users.containsKey(e.key)) yield (e.key, e.value);
      }
    }

    final ids = <int>{};
    Future<int> fresh(String c) async {
      var id = await db.newId(c);
      while (!ids.add(id)) {
        id = await db.newId(c);
      }
      return id;
    }

    Future<void> ensureLookup(String k, String name) async {
      final nm = name.trim();
      if (nm.isEmpty) return;
      if (lookups.any(
        (l) => l['kind'] == k && normName(l['name']) == normName(nm),
      )) {
        return;
      }
      final row = {
        'kind': k,
        'name': nm,
        'order': lookups.where((l) => l['kind'] == k).length + 1,
      };
      lookups.add(row);
      ops.add(_Op('lookups', await fresh('lookups'), row, null));
    }

    for (final r in ready) {
      final d = r.data;
      if (kind == 'grades' || kind == 'attendance') {
        final stu = _int(d['student_id'])!;
        final cls = _int(d['class_id']);
        if (kind == 'grades') {
          final term = GradeTerm.fromWire(d['term']) ?? GradeTerm.first;
          final subj = _int(d['subject_id'])!;
          final id = GradeBook.recordId(
            classId: cls ?? 0,
            subjectId: subj,
            term: term,
            studentId: stu,
          );
          ops.add(
            _Op('grades', id, {
              'student_id': stu,
              'class_id': cls,
              'subject_id': subj,
              'term': term.wire,
              'exam_type': d['exam_type'],
              'score': d['score'],
              'max_score': 20,
              'date': d['date'],
              'source': 'import',
            }, await db.get('grades', id)),
          );
        } else {
          final id = AttendanceBook.recordId(stu, _s(d['date']));
          ops.add(
            _Op('attendance', id, {
              'student_id': stu,
              'class_id': cls,
              'date': d['date'],
              'status': d['status'],
              'note': d['note'] ?? '',
              'source': 'import',
            }, await db.get('attendance', id)),
          );
        }
        res.marks++;
        res.created++;
        continue;
      }
      final name = _s(d['full_name']);
      if (name.isEmpty) {
        res.errors.add((r.row, 'missing_name'));
        continue;
      }
      var classId = _int(d['class_id']);
      var newGrade = _s(d['new_grade']);
      final newBranch = _s(d['new_branch']);
      var newClass = _s(d['new_class']);
      if (kind == 'students' && classId == null) {
        final g0 = newGrade.isNotEmpty
            ? newGrade
            : (s.grades.length == 1 ? s.grades.first : '');
        if (g0.isNotEmpty) {
          newGrade = g0;
          newClass = '$g0${newBranch.isEmpty ? '' : ' $newBranch'}';
        }
      }
      final field = kind == 'students' && gradeLevel(newGrade) >= 10;
      String? followup;
      if (kind == 'students' && classId == null && newClass.isNotEmpty) {
        var cid = classes[normName(newClass)];
        if (cid == null && !field) {
          await ensureLookup('grade', newGrade);
          cid = await fresh('classes');
          ops.add(
            _Op('classes', cid, {
              'name': newClass,
              'grade': newGrade,
              'branch': '',
              'mode': 'class',
              'kind': 'class',
              'grade_level': gradeLevel(newGrade),
              'capacity': 30,
            }, null),
          );
          classes[normName(newClass)] = cid;
          res.classes++;
        }
        if (cid != null) classId = cid;
      }
      if (field) {
        await ensureLookup('grade', newGrade);
        if (newBranch.isNotEmpty) await ensureLookup('branch', newBranch);
      }
      final row = <String, Object?>{
        'name': name,
        'role': kind == 'teachers' ? 'teacher' : 'student',
        'national_id': _s(d['national_id']),
        'phone': _s(d['phone']),
        'class_id': classId,
        'active': true,
      };
      if (kind == 'students') {
        if (newGrade.isNotEmpty) row['grade'] = newGrade;
        if (newBranch.isNotEmpty) row['field'] = newBranch;
        if (classId == null && newClass.isNotEmpty && !field) {
          followup =
              'کلاس «$newClass» هنوز ساخته نشده — مدیر باید کلاس را دستی بسازد';
        }
        if (classId == null &&
            followup == null &&
            newGrade.isEmpty &&
            d['followup_reason'] != null) {
          followup = _s(d['followup_reason']);
        }
        if (followup != null) row['followup_reason'] = followup;
      }
      for (final k in importExtraFields) {
        final v = d[k];
        if (v != null && v != '') row[k] = v;
      }
      if (_s(d['birth_date']).isNotEmpty) row['birth_date'] = d['birth_date'];
      if (kind == 'teachers' && _s(d['subject']).isNotEmpty) {
        row['subject'] = d['subject'];
      }
      final exId = _int(d['existing_id']);
      final existing = exId == null ? null : users[exId];
      final int uid;
      if (existing != null) {
        uid = existing.id;
        final merged = {...existing.data, ...row};
        newUsers[uid] = merged;
        ops.add(_Op('users', uid, merged, existing));
        res.updated++;
      } else {
        uid = await fresh('users');
        newUsers[uid] = row;
        ops.add(_Op('users', uid, row, null));
        res.created++;
        if (row['role'] == 'student') {
          res.students++;
        } else {
          res.staff++;
        }
      }
      if (kind != 'students') continue;
      for (final (pnid, pname, rel, pphone) in [
        (
          _s(d['father_nid']),
          _s(d['father_name']),
          'پدر',
          _s(d['father_phone']),
        ),
        (
          _s(d['mother_nid']),
          _s(d['mother_name']),
          'مادر',
          _s(d['mother_phone']),
        ),
      ]) {
        if (pnid.isEmpty && pname.isEmpty && pphone.isEmpty) continue;
        int? pid;
        if (pnid.isNotEmpty) {
          for (final (id, u) in allUsers()) {
            if (u['role'] == 'parent' && _d(u['national_id']) == pnid) pid = id;
          }
        }
        if (pid == null && pphone.isNotEmpty) {
          for (final (id, u) in allUsers()) {
            if (_d(u['phone']) != pphone) continue;
            final cn = _d(u['national_id']);
            if (u['role'] == 'parent' &&
                (pnid.isEmpty || cn.isEmpty || cn == pnid)) {
              pid = id;
            }
            break;
          }
        }
        if (pid == null) {
          final free =
              pphone.isNotEmpty &&
                  !allUsers().any((e) => _d(e.$2['phone']) == pphone)
              ? pphone
              : '';
          pid = await fresh('users');
          final p = <String, Object?>{
            'name': pname.isEmpty ? '$rel $name' : pname,
            'role': 'parent',
            'national_id': pnid,
            'phone': free,
            'active': true,
          };
          newUsers[pid] = p;
          ops.add(_Op('users', pid, p, null));
          res.parents++;
        }
        final linked = links.any(
          (l) => _int(l['parent_id']) == pid && _int(l['student_id']) == uid,
        );
        if (!linked) {
          final l = {'parent_id': pid, 'student_id': uid, 'relation': rel};
          links.add(l);
          ops.add(_Op('parent_links', await fresh('parent_links'), l, null));
        }
      }
    }

    // follow-up list (web impSaveIssues): not created, blocked, or incomplete rows
    final errRows = <int, List<String>>{};
    for (final (row, code) in res.errors) {
      (errRows[row] ??= []).add(importErrorFa[code] ?? code);
    }
    final existing = await db.allOrEmpty('import_issues');
    String key(Object? nid, Object? name) =>
        '${normName(nid)}|${normName(name)}';
    final open = {
      for (final i in existing)
        if (i.data['status'] != 'done')
          key(i.data['national_id'], i.data['name']),
    };
    for (final c in review.rows) {
      if (!c.followUp && !errRows.containsKey(c.row)) continue;
      final nid = _d(c.data['national_id']);
      if (!open.add(key(nid, c.name))) continue;
      ops.add(
        _Op('import_issues', await fresh('import_issues'), {
          'kind': kind,
          'name': c.name,
          'national_id': nid,
          'phone': _d(c.data['phone']),
          'row_no': c.row,
          'file_name': s.fileName,
          'reasons': [...c.errors, ...c.warns, ...?errRows[c.row]],
          'data': {
            for (final e in c.data.entries)
              if (e.value != null) e.key: e.value,
          },
          'status': 'open',
        }, null),
      );
      res.savedIssues++;
    }
    db.requireRoom(ops.length);
    for (final o in ops) {
      res.keys.add(await db.put(o.collection, o.id, o.data, prev: o.prev));
    }
    res.openIssues = (await db.allOrEmpty('import_issues'))
        .where((i) => i.data['status'] != 'done')
        .length;
    return res;
  }
}
