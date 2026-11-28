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
import 'classes.dart' show gradeLevel, groupKey, normName, sameGrade;
import 'grades.dart' show GradeBook, GradeTerm;
import 'records.dart';
import 'school_structure.dart' show SchoolStructure;
import 'sheet_reader.dart';
import 'users.dart' show nidRestoreZeros, roleFa;

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

/// Row 201 — branches the owner says are one and the same (file name → defined name). Keys
/// are compared with [groupKey], so spaces / ZWNJ / letter forms do not matter. Only used when
/// the target is a branch of the school (or of the same file).
const Map<String, String> importBranchAliases = {
  'برق': 'الکتروتکنیک',
  'برق صنعتی': 'الکتروتکنیک',
  'برقکار': 'الکتروتکنیک',
  'الکتروتکنیک صنعتی': 'الکتروتکنیک',
  'معماری': 'نقشه کشی',
  'نقشه کشی معماری': 'نقشه کشی',
  'نقشه کشی ساختمان': 'نقشه کشی',
};

/// Row 201: «تعمیر موتور موتور» / «تعمیر موتورموتور» → «تعمیر موتور» — a word written twice
/// (with or without a space) is written once.
String importBranchCollapse(Object? text) {
  final out = <String>[];
  for (var t in normName(text).split(' ')) {
    if (t.isEmpty) continue;
    if (t.length >= 4 && t.length.isEven) {
      final h = t.length ~/ 2;
      if (t.substring(0, h) == t.substring(h)) t = t.substring(0, h);
    }
    // «موتورموتور» glued to the previous word's copy: «موتور موتورموتور»
    if (out.isNotEmpty && t.startsWith(out.last) && t != out.last) {
      final rest = t.substring(out.last.length);
      if (rest == out.last) t = out.last;
    }
    if (out.isNotEmpty && out.last == t) continue;
    out.add(t);
  }
  return out.join(' ');
}

/// Row 201: what a branch name most likely means — (defined name, why). `why` is
/// * `same` — the same name (spaces / ZWNJ / letter forms aside),
/// * `repeat` — a word written twice («تعمیر موتور موتور» → «تعمیر موتور»),
/// * `alias` — a known synonym («برق صنعتی» → «الکتروتکنیک»),
/// * `typo` — at most two letters differ (asked, never merged by itself),
/// * `contains` — one name inside the other (asked),
/// * '' — nothing like it (a new branch; asked too).
/// The first three are certain and applied by the import; the rest are asked.
(String, String) importBranchGuess(Object? text, List<String> known) {
  var raw = '${text ?? ''}'.replaceAll(RegExp(r'\s+'), ' ').trim();
  raw = raw
      .replaceFirst(RegExp(r'^رشتهٔ?\s*'), '')
      .replaceFirst(RegExp(r'\s*رشتهٔ?$'), '')
      .trim();
  final k = groupKey(raw);
  if (k.isEmpty) return ('', '');
  String? find(String key) {
    for (final g in known) {
      if (groupKey(g) == key) return g;
    }
    return null;
  }

  final same = find(k);
  if (same != null) return (same, 'same');
  final col = importBranchCollapse(raw);
  final rep = find(groupKey(col));
  if (rep != null) return (rep, 'repeat');
  for (final cand in {raw, col}) {
    final ck = groupKey(cand);
    for (final e in importBranchAliases.entries) {
      if (groupKey(e.key) != ck) continue;
      final to = find(groupKey(e.value));
      if (to != null) return (to, 'alias');
    }
  }
  var best = '';
  var bestD = 999;
  final ck = groupKey(col);
  for (final g in known) {
    final gk = groupKey(g);
    if (gk.isEmpty) continue;
    final d = importLev(gk, ck);
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  if (best.isEmpty) return ('', '');
  if (bestD <= 2) return (best, 'typo');
  final gk = groupKey(best);
  for (final g in known) {
    final x = groupKey(g);
    if (x.length >= 3 && (x.contains(ck) || ck.contains(x))) {
      return (g, 'contains');
    }
  }
  if (gk.length >= 3 && (gk.contains(ck) || ck.contains(gk))) {
    return (best, 'contains');
  }
  return ('', '');
}

/// Row 201: is [why] (from [importBranchGuess]) sure enough to apply without asking?
bool importBranchSure(String why) =>
    why == 'same' || why == 'repeat' || why == 'alias';

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
  t = excelNumberText(t); // row 197 F3: «91887514.390000001» → «91887514.39»
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
/// Row 202 — common branch names of Iranian schools (هنرستان / کاردانش / نظری), so a column of
/// «گرافیک · معماری» is a رشته even when the school has not defined those yet.
const List<String> importBranchWords = [
  'ریاضی',
  'تجربی',
  'انسانی',
  'معارف',
  'علوم',
  'الکترونیک',
  'الکتروتکنیک',
  'برق', //
  'مکانیک',
  'مکاترونیک',
  'تعمیر',
  'موتور',
  'خودرو',
  'نقشه',
  'معماری',
  'گرافیک',
  'حسابداری',
  'کامپیوتر',
  'رایانه',
  'شبکه',
  'نرم افزار',
  'تاسیسات',
  'تأسیسات',
  'ساختمان',
  'عمران',
  'صنایع',
  'چوب',
  'فتوگرافیک',
  'پویانمایی',
  'انیمیشن',
  'طراحی',
  'دوخت',
  'پوشاک',
  'تربیت بدنی',
  'کودکیاری',
  'بهداشت',
  'ماشین',
  'جوشکاری',
  'متالورژی',
  'سرامیک',
  'شیمی',
  'نساجی',
  'کشاورزی',
  'دامپروری',
  'باغبانی',
  'هتلداری',
  'گردشگری',
  'آشپزی',
  'مدیریت',
  'بازرگانی',
  'امور اداری',
  'سینما',
  'موسیقی',
  'نقاشی',
  'هنر',
  'فناوری',
  'الکتروموتور',
  'سردخانه',
  'تبرید',
  'ابزار',
  'صنعتی', 'کنترل', 'چاپ', 'زیبایی', 'آرایش', 'پیراپزشکی',
];

String _cv(String v) => normName(_latin(v));

/// Row 202 (owner: «اکسل با هر شکلی… به صورت هوش مصنوعی و خودکار تشخیص داده بشه»): a
/// field for each column the titles did not map, judged from its values — the column has
/// no title (`ستون ۵۴`) or a title the synonyms do not know. Returns column → field key; a
/// key already in [map] is never given twice, and a column with a known «ردیف» title, an
/// empty column or a column whose values say nothing is left alone (the manager still
/// chooses in step 2). [branches] / [grades] are the school's own definitions.
Map<int, String> importContentMap(
  List<String> headers,
  List<List<String>> rows,
  List<String> map,
  String kind, {
  List<String> branches = const [],
  List<String> grades = const [],
}) {
  final allowed = {
    for (final f in importFields[kind] ?? const <ImportField>[]) f.$1,
  };
  final used = {...map.where((m) => m.isNotEmpty)};
  final cur = [...map];
  final out = <int, String>{};
  final width = map.length;
  final sample = rows.length > 400 ? rows.sublist(0, 400) : rows;
  List<String> vals(int c) => [
    for (final r in sample)
      if (c < r.length)
        if (r[c].trim().isNotEmpty &&
            !RegExp(r'^[\-–—_.\s]+$').hasMatch(r[c].trim()))
          r[c].trim(),
  ];
  double ratio(List<String> v, bool Function(String) t) =>
      v.isEmpty ? 0 : v.where(t).length / v.length;
  bool give(int c, String key) {
    if (!allowed.contains(key) || used.contains(key)) return false;
    used.add(key);
    cur[c] = key;
    out[c] = key;
    return true;
  }

  bool giveFirst(int c, List<String> keys) => keys.any((k) => give(c, k));
  // the person a column belongs to, from the columns around it (پدر / مادر / سرپرست)
  String relNear(int c) {
    for (final d in const [-1, 1, -2, 2]) {
      final j = c + d;
      if (j < 0 || j >= width) continue;
      final k = cur[j];
      for (final r in const ['father', 'mother', 'guardian']) {
        if (k.startsWith(r)) return r;
      }
      final h = normName(j < headers.length ? headers[j] : '');
      if (h.contains('مادر')) return 'mother';
      if (h.contains('پدر')) return 'father';
      if (RegExp('سرپرست|ولی').hasMatch(h)) return 'guardian';
    }
    return '';
  }

  bool isMobile(String v) {
    final d = SchoolRecords.digitsOnly(v);
    return RegExp(r'^(0|98|0098)?9\d{9}$').hasMatch(d) &&
        !RegExp('[a-zA-Z]').hasMatch(v);
  }

  bool isNid(String v) {
    final t = _latin(v).replaceAll(RegExp(r'[\s\-]'), '');
    return RegExp(r'^\d{8,10}$').hasMatch(t) && !t.startsWith('09');
  }

  bool isLand(String v) {
    final d = SchoolRecords.digitsOnly(
      _latin(v).replaceAll(RegExp(r'[\s\-]'), ''),
    );
    return (RegExp(r'^0[1-8]\d{9}$').hasMatch(d) ||
            RegExp(r'^[2-8]\d{7}$').hasMatch(d)) &&
        !RegExp(r'[^\d\s\-+()۰-۹]').hasMatch(v);
  }

  bool inSet(String v, Set<String> set) =>
      set.contains(_cv(v).replaceAll(' ', ''));
  bool has(String v, String re) => RegExp(re).hasMatch(_cv(v));
  final names = <int>[];
  // pass 1: what a column is by itself (رشته, سرپرست, محل سکونت …); pass 2: the columns of a
  // person (موبایل, کد ملی, حیات, تحصیلات, شغل), whose owner comes from the columns around
  // them — so «در قید حیات» next to «والدین / فقط پدر» is the guardian's
  for (final pass in const [1, 2]) {
    for (var c = 0; c < width; c++) {
      if (map[c].isNotEmpty || out.containsKey(c)) continue;
      final h = normName(c < headers.length ? headers[c] : '');
      if (_ignoreCols.contains(h)) continue;
      final v = vals(c);
      if (v.isEmpty) continue;
      // a «ردیف» column without its title: 1, 2, 3, …
      final ints = [for (final x in v) int.tryParse(_latin(x))];
      if (v.length >= 3 && ints.every((n) => n != null && n < 100000)) {
        var seq = true;
        for (var i = 1; i < ints.length && seq; i++) {
          seq = ints[i]! == ints[i - 1]! + 1;
        }
        if (seq) continue;
      }
      const sure = 0.6;
      final rel = relNear(c);
      if (ratio(v, isMobile) >= sure) {
        if (pass == 1) continue;
        giveFirst(c, [
          if (rel.isNotEmpty) '${rel}_phone',
          'phone', 'father_phone', 'mother_phone', 'guardian_phone', //
        ]);
        continue;
      }
      if (ratio(v, isNid) >= sure) {
        if (pass == 1) continue;
        if (kind == 'students' || kind == 'teachers') {
          giveFirst(c, [
            if (rel == 'father' || rel == 'mother') '${rel}_nid',
            'national_id', 'father_nid', 'mother_nid', //
          ]);
        } else {
          give(c, 'national_id');
        }
        continue;
      }
      if (ratio(v, isLand) >= sure) {
        give(c, 'landline');
        continue;
      }
      if (ratio(
            v,
            (x) =>
                RegExp(r'\d{4}\D\d{1,2}\D\d{1,2}').hasMatch(_latin(x)) &&
                importDate(x).isNotEmpty,
          ) >=
          sure) {
        giveFirst(c, ['birth_date', 'date']);
        continue;
      }
      if (ratio(
            v,
            (x) => inSet(x, const {
              'پسر',
              'دختر',
              'مذکر',
              'مونث',
              'مؤنث',
              'مرد',
              'زن',
            }),
          ) >=
          sure) {
        give(c, 'gender');
        continue;
      }
      if (ratio(v, (x) => has(x, 'حیات|فوت|متوفی|مرحوم|زنده|درگذشت')) >= sure) {
        if (pass == 1) continue;
        giveFirst(c, [
          if (rel.isNotEmpty) '${rel}_alive',
          'father_alive', 'mother_alive', 'guardian_alive', //
        ]);
        continue;
      }
      if (ratio(
            v,
            (x) => has(
              x,
              '^(فقط )?(والدین|پدر|مادر|قیم|ولی|پدربزرگ|مادربزرگ|پدر و مادر|برادر|خواهر|عمو|دایی|خود|سایر|هر دو)\$',
            ),
          ) >=
          sure) {
        give(c, 'guardian');
        continue;
      }
      if (ratio(
            v,
            (x) => inSet(x, const {
              'شهر',
              'روستا',
              'شهری',
              'روستایی',
              'عشایر',
              'عشایری',
              'حاشیهشهر',
            }),
          ) >=
          sure) {
        give(c, 'residence');
        continue;
      }
      if (ratio(
            v,
            (x) => inSet(x, const {
              'بلی',
              'بله',
              'خیر',
              'دارد',
              'ندارد',
              'آری',
              'اری',
              'هست',
              'نیست',
              'نه',
            }),
          ) >=
          sure) {
        give(c, 'covered');
        continue;
      }
      if (ratio(
            v,
            (x) => has(
              x,
              '^(ایرانی|اتباع|افغانی|افغانستانی|افغان|عراقی|پاکستانی|غیر ایرانی|مهاجر|خارجی)\$',
            ),
          ) >=
          sure) {
        give(c, 'residence_status');
        continue;
      }
      if (ratio(v, (x) => has(x, 'کمیته|امداد|بهزیستی|شاهد|ایثارگر|بنیاد')) >=
          sure) {
        give(c, 'org_type');
        continue;
      }
      if (ratio(
            v,
            (x) => has(
              x,
              'دیپلم|لیسانس|کارشناسی|سیکل|ابتدایی|بیسواد|بی سواد|دکتر|ارشد|راهنمایی|متوسطه|حوزوی|نهضت',
            ),
          ) >=
          sure) {
        if (pass == 1) continue;
        giveFirst(c, [
          if (rel == 'father' || rel == 'mother') '${rel}_edu',
          'father_edu', 'mother_edu', 'degree', //
        ]);
        continue;
      }
      if (ratio(
            v,
            (x) => has(
              x,
              '^(آزاد|ازاد|کارمند|کارگر|خانه ?دار|بازنشسته|کشاورز|راننده|فرهنگی|نظامی|بیکار|مغازه ?دار|دامدار|معلم|کاسب|پزشک|مهندس|فوت شده)\$',
            ),
          ) >=
          sure) {
        if (pass == 1) continue;
        final mom = ratio(v, (x) => has(x, 'خانه ?دار')) >= 0.5;
        giveFirst(c, [
          if (rel == 'father' || rel == 'mother') '${rel}_job',
          if (mom) 'mother_job',
          'father_job', 'mother_job', //
        ]);
        continue;
      }
      if (ratio(
            v,
            (x) => has(x, '^(حاضر|غایب|تاخیر|تأخیر|موجه|غیبت|غیر موجه)'),
          ) >=
          sure) {
        give(c, 'status');
        continue;
      }
      final nums = [
        for (final x in v) double.tryParse(_latin(x).replaceAll('/', '.')),
      ];
      if (nums.every((n) => n != null && n >= 0 && n <= 20) &&
          ratio(v, (x) => RegExp(r'[./]\d').hasMatch(_latin(x))) >= 0.3) {
        giveFirst(c, ['last_gpa', 'score']);
        continue;
      }
      if (ratio(v, (x) => RegExp(r'^\d{1,3}\s*[%٪]$').hasMatch(_latin(x))) >=
          sure) {
        give(c, 'org_percent');
        continue;
      }
      // پایه («دهم») / کلاس («دهم الکترونیک ۲»)
      final gradeOnly = ratio(v, (x) {
        final t = _cv(x).replaceAll('پایه', '').trim();
        return gradeLevel(t) > 0 &&
            t.split(' ').length <= 1 &&
            (grades.isEmpty ||
                importGradeCanon(t, grades).isNotEmpty ||
                gradeLevel(t) > 0);
      });
      if (gradeOnly >= sure &&
          v.any((x) => !RegExp(r'^\d+$').hasMatch(_latin(x).trim()))) {
        give(c, 'grade');
        continue;
      }
      bool branchy(String x) {
        final t = _cv(x);
        if (t.isEmpty || RegExp(r'\d').hasMatch(t) && gradeLevel(t) == 0) {
          return false;
        }
        if (branches.any((b) {
          final nb = normName(b);
          return nb.isNotEmpty && (t == nb || t.contains(nb) || nb.contains(t));
        })) {
          return true;
        }
        return importBranchWords.any((w) => t.contains(normName(w)));
      }

      if (ratio(
                v,
                (x) =>
                    gradeLevel(_cv(x)) > 0 &&
                    branchy(
                      x.replaceAll(
                        RegExp('دهم|یازدهم|دوازدهم|نهم|هشتم|هفتم'),
                        '',
                      ),
                    ),
              ) >=
              sure ||
          ratio(
                v,
                (x) =>
                    gradeLevel(_cv(x)) > 0 &&
                    RegExp(r'\d').hasMatch(_latin(x)) &&
                    _cv(x).split(' ').length >= 2,
              ) >=
              sure) {
        give(c, 'class_name');
        continue;
      }
      if (ratio(v, branchy) >= 0.5) {
        giveFirst(c, ['field', 'subject']);
        continue;
      }
      if (ratio(
            v,
            (x) =>
                _cv(x).split(' ').length >= 3 &&
                has(
                  x,
                  'خیابان|کوچه|بلوار|پلاک|میدان|محله|شهرک|روستای|بن ?بست|خ |ک |کوی|جاده|نبش',
                ),
          ) >=
          0.3) {
        give(c, 'address');
        continue;
      }
      if (h.isEmpty &&
          ratio(
                v,
                (x) =>
                    RegExp(r'^[\u0600-\u06FF\u200c ]{2,40}$')
                        .hasMatch(x.trim()),
              ) >=
              0.8) {
        if (pass == 2) names.add(c);
      }
    }
  }
  // names last: «نام و نام خانوادگی» / «نام» + «نام خانوادگی», then the father and the mother
  final hasName = {'full_name', 'first_name', 'last_name'}.any(used.contains);
  for (final c in names) {
    final v = vals(c);
    final words = v.isEmpty
        ? 0
        : v.map((x) => _cv(x).split(' ').length).reduce((a, b) => a + b) /
              v.length;
    final distinct = v.map(_cv).toSet().length / v.length;
    // a few repeated words: not names
    if (v.length >= 4 && distinct < 0.3) continue;
    if (c > 0 && cur[c - 1] == 'residence') {
      give(c, 'village');
      continue;
    }
    if (!hasName &&
        !used.contains('first_name') &&
        !used.contains('full_name')) {
      if (words >= 1.8) {
        give(c, 'full_name');
      } else {
        give(c, 'first_name');
      }
      continue;
    }
    if (!hasName &&
        used.contains('first_name') &&
        !used.contains('last_name')) {
      give(c, 'last_name');
      continue;
    }
    if (kind == 'students' && words < 1.8) {
      final rel = relNear(c);
      giveFirst(c, [
        if (rel == 'father' || rel == 'mother') '${rel}_name',
        'father_name', 'mother_name', //
      ]);
    }
  }
  return out;
}

/// Row 202: a cell that is data, never a column title — a long number (national id, mobile)
/// or a date.
bool _dataLike(String c) =>
    RegExp(r'\d{5}').hasMatch(_latin(c)) ||
    RegExp(r'\d{4}\D\d{1,2}\D\d{1,2}').hasMatch(_latin(c));

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
    this.detected = const {},
  });

  /// Step 1 (`import-file`): picks the sheet, finds the header row, guesses the mapping.
  factory ImportSession.fromBook(
    SheetBook book, {
    required String kind,
    required String fileName,
    List<String> grades = const [],
    List<String> branches = const [],
  }) {
    if (!importKindFa.containsKey(kind)) {
      throw RecordFailure('invalid', 'نوع «$kind» شناخته نیست');
    }
    if (kind == 'students' && grades.isEmpty) {
      throw const RecordFailure(
        'invalid',
        'اول پایه را انتخاب کنید — بدون پایه، دانش‌آموز ثبت نمی‌شود',
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
    // row 202: the title row is the one whose cells are most like titles (a data row has
    // more filled cells when the last titles are empty — the owner's file); without any
    // title-like row the file has no titles and every row is data
    var hi = 0;
    var bestTitles = 0;
    var bestCells = 0;
    for (var i = 0; i < all.length && i < 5; i++) {
      final row = [
        for (var c = 0; c < width; c++)
          c < all[i].length ? all[i][c].trim() : '',
      ];
      // a row with a long number or a date in it is data, never the titles
      final t = row.any(_dataLike)
          ? 0
          : importAutoMap(row, kind).where((g) => g.isNotEmpty).length;
      final n = row.where((c) => c.isNotEmpty).length;
      if (t > bestTitles ||
          (t == bestTitles && bestTitles == 0 && n > bestCells)) {
        bestTitles = t;
        bestCells = n;
        hi = i;
      }
    }
    final first = [
      for (var i = 0; i < width; i++)
        i < all[hi].length ? all[hi][i].trim() : '',
    ];
    final guess = importAutoMap(first, kind);
    // row 202: a first row of DATA is not a title row even when one of its cells looks like
    // a title («فقط پدر» ⇒ «پدر») — numbers and dates say it is data
    final hasHeader = guess.any((g) => g.isNotEmpty) && !first.any(_dataLike);
    final rows = hasHeader ? all.sublist(hi + 1) : all;
    if (rows.isEmpty) {
      throw const RecordFailure('invalid', 'در این فایل سطر داده‌ای نیست');
    }
    final headers = [
      for (var i = 0; i < width; i++)
        hasHeader && first[i].isNotEmpty ? first[i] : 'ستون ${_faNum(i + 1)}',
    ];
    final map = hasHeader ? guess : List.filled(width, '');
    // row 202: the columns the titles did not map are judged from their values
    final found = importContentMap(
      [for (var i = 0; i < width; i++) hasHeader ? first[i] : ''],
      rows,
      map,
      kind,
      branches: branches,
      grades: grades,
    );
    for (final e in found.entries) {
      map[e.key] = e.value;
    }
    return ImportSession(
      kind: kind,
      fileName: fileName,
      sheetName: sheet.name,
      headers: headers,
      rows: rows,
      map: map,
      headerRow: hasHeader ? hi + 1 : 0,
      grades: grades,
      detected: found.keys.toSet(),
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

  /// Row 202: columns mapped from their VALUES (no or unknown title) — step 2 marks them
  /// «🤖 از روی محتوا» so the manager can check the guess.
  final Set<int> detected;

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

  /// Row 202: field → what is wrong with it (red outline in the fix forms).
  Map<String, String> get problems =>
      importProblemFields([...errors, ...blocks, ...warns]);
}

/// Row 194 — p2 `41-class-placement.js` `PLACE_DEFAULTS` / `placeSettings`: the rules of the
/// automatic class placement. Both optional rules are OFF by default (small and village schools
/// are mixed; some schools deliberately separate siblings). Kept on the school row (`schools/1`
/// `place_rules`).
final class PlaceRules {
  const PlaceRules({
    this.autoDistribute = true,
    this.separateGender = false,
    this.keepSiblings = false,
  });

  /// The saved rules; in a boys' or girls' school «تفکیک جنسیتی» is meaningless and is off.
  factory PlaceRules.of(Object? raw, {bool mixed = true}) {
    final m = raw is Map ? raw : const <String, Object?>{};
    return PlaceRules(
      autoDistribute: m['autoDistribute'] != false,
      separateGender: mixed && m['separateGender'] == true,
      keepSiblings: m['keepSiblings'] == true,
    );
  }

  /// «توزیع خودکار میان شعبه‌ها».
  final bool autoDistribute;

  /// «تفکیک جنسیتی شعبه‌ها».
  final bool separateGender;

  /// «خواهر و برادر هم‌کلاس شوند» (by the father's or mother's national code only).
  final bool keepSiblings;

  Map<String, Object?> toJson() => {
    'autoDistribute': autoDistribute,
    'separateGender': separateGender,
    'keepSiblings': keepSiblings,
  };
}

/// p2 `isMixedSchool`: only a «پسرانه» or «دخترانه» school is single-gender.
bool importMixedSchool(Object? gender) {
  final g = SchoolRecords.str(gender).trim();
  return g != 'پسرانه' && g != 'دخترانه';
}

/// One line of p2 `impCapTable` («نتیجهٔ کلاس‌بندی پیش از ثبت»).
final class ImportCap {
  const ImportCap({
    required this.id,
    required this.name,
    required this.before,
    required this.added,
    required this.cap,
  });
  final int id;
  final String name;
  final int before;
  final int added;
  final int cap;
  int get after => before + added;
  bool get over => after > cap;
}

/// A class a manual row could go to: id, name, students now, capacity.
typedef ImportSeat = ({int id, String name, int n, int cap});

/// One row of p2 `impManualBlock` («نیازمند بررسی دستی»): every section of its grade is full.
final class ImportManual {
  const ImportManual({
    required this.row,
    required this.name,
    required this.wanted,
    required this.candidates,
  });
  final int row;
  final String name;
  final String wanted;
  final List<ImportSeat> candidates;
}

final class _Occ {
  _Occ(this.cap);
  int cap;
  int n = 0;
  int boys = 0;
  int girls = 0;
}

final class ImportReview {
  const ImportReview({
    required this.rows,
    required this.newClasses,
    required this.branchFixes,
    required this.branchAsk,
    this.branchNew = const [],
    this.branchChoices = const [],
    required this.phonesFixed,
    this.capRows = const [],
    this.manualRows = const [],
    this.rules = const PlaceRules(),
    this.mixed = true,
  });
  final List<ImportRow> rows;

  /// Row 194 (p2 `capRows`): every class that receives students, before → after vs capacity.
  final List<ImportCap> capRows;

  /// Row 194 (p2 `manualRows`): rows set aside because every section was full.
  final List<ImportManual> manualRows;
  final PlaceRules rules;
  final bool mixed;

  /// p2 `counts.auto`: ready rows the system placed in a section by itself.
  int get autoCount =>
      rows.where((r) => r.ready && r.data['auto_placed'] == true).length;
  final List<String> newClasses;
  final List<(String, String)> branchFixes;

  /// Branches that only look like a defined one: (from, to) waiting for yes/no.
  final List<(String, String)> branchAsk;

  /// Row 201: branches of the file that look like nothing defined — asked before they are
  /// added («رشتهٔ تازه است» / «همان … است»).
  final List<String> branchNew;

  /// Row 201: the school's branches an asked name can be put under (the «همان …» menu).
  final List<String> branchChoices;

  /// Row 201: questions still waiting for the owner (the import is not saved before them).
  int get pendingAsks => branchAsk.length + branchNew.length;
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

  /// Row 204: a field school — [classes] are new «پایه و رشته» groups.
  bool fieldBased = false;
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
    if (classes > 0) {
      b.write(
        ' · ${_faNum(classes)} ${fieldBased ? 'پایه و رشتهٔ تازه' : 'کلاس تازه'}',
      );
    }
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

/// Row 202 — text of a reason with ZWNJ as a space, one form of ی/ک and no hamza mark, so
/// «دانش‌آموز», «دانش آموز» and «شمارهٔ» / «شماره» are matched alike.
String _reasonText(String r) => r
    .replaceAll('\u200c', ' ')
    .replaceAll(RegExp('[ىي]'), 'ی')
    .replaceAll('ك', 'ک')
    .replaceAll('\u0654', '')
    .replaceAll(RegExp(r'\s+'), ' ');

/// Row 202 (owner: «قسمت‌های مشکل‌دار باید با کادر قرمز مشخص بشن»): the fields of the user
/// form a reason of the import is about — empty for a reason that only informs («قبلاً ثبت
/// شده — به‌روزرسانی می‌شود», «کلاس … ساخته می‌شود»). The keys are the import keys
/// ([importFields]): `full_name`, `national_id`, `phone`, `father_nid`, … , `grade`, `field`.
/// Old follow-up rows only kept their sentences, so this works from the text alone.
List<String> importReasonFields(String reason) {
  final t = _reasonText(reason);
  final flat = t.replaceAll(' ', '');
  if (flat.contains('بهروزرسانیمیشود') ||
      flat.contains('ساختهمیشود') ||
      flat.contains('اضافهمیشود') ||
      RegExp(r'ثبتمیشود\.?$').hasMatch(flat)) {
    // «… با صفرِ اول «09…» می‌شود — ثبت می‌شود.» is a fix already made, not a problem
    return const [];
  }
  final out = <String>[];
  void add(String k) {
    if (!out.contains(k)) out.add(k);
  }

  for (final (who, nid, ph) in const [
    ('پدر', 'father_nid', 'father_phone'),
    ('مادر', 'mother_nid', 'mother_phone'),
  ]) {
    if (RegExp('برای $who نه شماره').hasMatch(t)) {
      add(ph);
      add(nid);
    }
    if (t.contains('کد ملی $who')) add(nid);
    if (RegExp('(موبایل|همراه|تلفن) $who').hasMatch(t) &&
        !t.contains('پدر و مادر یکی')) {
      add(ph);
    }
  }
  if (t.contains('پدر و مادر یکی')) add('mother_phone');
  if (RegExp('(موبایل|همراه|تلفن) سرپرست').hasMatch(t)) add('guardian_phone');
  if (RegExp('(موبایل|همراه) دانش ?آموز').hasMatch(t) ||
      t.contains('این شماره همراه برای') ||
      RegExp('^بدون شماره').hasMatch(t)) {
    add('phone');
  }
  if (out.isEmpty &&
      (RegExp('^کد ملی «').hasMatch(t) ||
          t.startsWith('بدون کد ملی') ||
          t.startsWith('کد ملی متعلق') ||
          t.contains('با کد ملی «'))) {
    add('national_id');
  }
  if (t.startsWith('نام و نام خانوادگی') ||
      t.startsWith('نام ندارد') ||
      t.startsWith('چند دانش آموز')) {
    add('full_name');
  }
  if (t.contains('تاریخ تولد')) add('birth_date');
  if (t.contains('معدل')) add('last_gpa');
  if (t.contains('جنسیت')) add('gender');
  if (RegExp('^رشته «|رشته: ').hasMatch(t) && !t.contains('پایه در فایل')) {
    add('field');
  }
  if (t.contains('پایه در فایل نبود') ||
      t.startsWith('کلاس ساخته نشد') ||
      t.startsWith('پایه ثبت نشد') ||
      t.startsWith('بدون کلاس') ||
      t.startsWith('بدون پایه') ||
      t.contains('شعبه های')) {
    add('grade');
  }
  return out;
}

/// Row 202: the value of the file a reason quotes («کد ملی مادر «38409918467» معتبر نیست» ⇒
/// 38409918467), '' when it quotes none — old follow-up rows did not keep the wrong value
/// itself, so the fix form shows it from the sentence.
String importReasonValue(String reason) =>
    RegExp('«([^»]*)»').firstMatch(reason)?.group(1)?.trim() ?? '';

/// Row 203: is [value] now right for the import field [key] (a follow-up row being fixed)?
/// A national id is 10 digits (or 8–9 whose dropped zeros give a valid check digit), a mobile
/// 11 digits from 09, a name at least 3 letters; any other field just has to be filled in.
bool importFieldOk(String key, String value) {
  final v = value.trim();
  if (key == 'national_id' || key.endsWith('_nid')) {
    final d = SchoolRecords.digitsOnly(v);
    return d.length == 10 || nidRestoreZeros(d).isNotEmpty;
  }
  if (key == 'phone' || key.endsWith('_phone')) {
    return RegExp(r'^09\d{9}$').hasMatch(SchoolRecords.mobile11(v));
  }
  if (key == 'full_name' || key == 'name') {
    return v.replaceAll(RegExp(r'\s'), '').length >= 2 &&
        !RegExp(r'\d').hasMatch(v);
  }
  return v.isNotEmpty;
}

/// Row 202: field → the reasons about it, for one checked row or follow-up row.
Map<String, String> importProblemFields(Iterable<String> reasons) {
  final out = <String, String>{};
  for (final r in reasons) {
    for (final k in importReasonFields(r)) {
      out[k] = out.containsKey(k) ? '${out[k]}\n$r' : r;
    }
  }
  return out;
}

final class _Op {
  _Op(this.collection, this.id, this.data, this.prev);
  final String collection;
  final int id;
  final Map<String, Object?> data;
  final EngineRow? prev;
}

final class SchoolImport {
  SchoolImport(this.db, {this.onProgress});
  final SchoolRecords db;

  /// Row 202 (owner: «موقع ثبت نهایی برنامه قفل می‌شود»): [apply] reports (stage, done,
  /// total) — stage `prepare` per file row, then `write` per saved record — and pauses between
  /// steps so the wizard can show «در حال ثبت … از …» instead of freezing.
  final void Function(String stage, int done, int total)? onProgress;

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
    // row 204: a field school (رشته‌محور) names its groups «پایه و رشته», never «کلاس»
    final field = (await SchoolStructure.read(db)).fieldBased;
    final users = await db.allOrEmpty('users');
    // row 202: national id / mobile → users, built once (the check ran a full scan per row)
    final usersByNid = <String, List<EngineRow>>{};
    final usersByPhone = <String, List<EngineRow>>{};
    final usersById = <int, EngineRow>{};
    for (final u in users) {
      usersById[u.id] = u;
      final n = _d(u.data['national_id']);
      if (n.isNotEmpty) (usersByNid[n] ??= []).add(u);
      final p = _d(u.data['phone']);
      if (p.isNotEmpty) (usersByPhone[p] ??= []).add(u);
    }
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

    // Row 194 — p2 automatic placement: the school's rules and the classes' occupancy, counted
    // in memory and updated with every placement (re-reading the database would put every row
    // of the file into the same class, as none of them is saved yet).
    final school = (await db.get('schools', 1))?.data ?? const {};
    final mixed = importMixedSchool(school['gender']);
    final rules = PlaceRules.of(school['place_rules'], mixed: mixed);
    bool isClass(EngineRow c) =>
        _s(c.data['kind']) != 'group' && _s(c.data['kind']) != 'room';
    final occ = <int, _Occ>{
      for (final c in classes)
        if (isClass(c)) c.id: _Occ(_int(c.data['capacity']) ?? 30),
    };
    for (final u in users) {
      if (u.data['role'] != 'student' || u.data['active'] == false) continue;
      final o = occ[_int(u.data['class_id'])];
      if (o == null) continue;
      o.n++;
      if (_s(u.data['gender']) == 'پسر') o.boys++;
      if (_s(u.data['gender']) == 'دختر') o.girls++;
    }
    final famCls = <String, (int, String)>{};
    final manualRows = <ImportManual>[];

    // Row 201 — branches not in the definitions. The sure ones (the same name written another
    // way, a word written twice, a known synonym) go under the defined branch by themselves and
    // are listed; a typo, one name inside the other and a brand-new name are ASKED — nothing is
    // merged or added silently. A definition that is itself a repeat / synonym of another one
    // (made by an older import, e.g. «تعمیر موتور موتور») is not a target.
    final alias = <String, String>{};
    final fixes = <(String, String)>[];
    final asks = <(String, String)>[];
    final newAsks = <String>[];
    final choices = <String>[];
    if (kind == 'students') {
      final known = [
        for (final b in branches)
          if (!importBranchSure(
            importBranchGuess(b, [
              for (final x in branches)
                if (groupKey(x) != groupKey(b)) x,
            ]).$2,
          ))
            b,
      ];
      final fileVals = <String>[];
      final seenB = <String>{};
      for (final (_, _, o) in mapped) {
        final v = (o['field'] ?? '').trim();
        if (normName(v).isNotEmpty && seenB.add(normName(v))) fileVals.add(v);
      }
      // other names of the same file that are clean themselves («تعمیر موتور» next to
      // «تعمیر موتور موتور» when the school has no definitions yet)
      final cleanFile = [
        for (final f in fileVals)
          if (importBranchCollapse(f) == normName(f)) f,
      ];
      choices.addAll(known);
      for (final v in fileVals) {
        final k = normName(v);
        final exact = branches.any((b) => normName(b) == k);
        final ask = s.branchAsk[v];
        if (ask != null) {
          if (ask.isNotEmpty && normName(ask) != k) {
            alias[k] = ask;
            fixes.add((v, ask));
          }
          continue;
        }
        final targets = [
          ...known,
          for (final f in cleanFile)
            if (normName(f) != k &&
                !known.any((b) => groupKey(b) == groupKey(f)))
              f,
        ];
        final (to, why) = importBranchGuess(v, targets);
        if (why == 'same') {
          if (normName(to) != k) alias[k] = to;
          continue;
        }
        if (exact && !importBranchSure(why)) continue;
        if (importBranchSure(why)) {
          alias[k] = to;
          fixes.add((v, to));
        } else if (to.isNotEmpty) {
          asks.add((v, to));
        } else {
          newAsks.add(v);
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

      // row 203: Excel drops the leading zeros of a national id («441659330» was
      // «0441659330»); with the zeros back and a valid check digit it is taken as it is
      for (final (k, who) in const [
        ('national_id', ''),
        ('father_nid', ' پدر'),
        ('mother_nid', ' مادر'),
      ]) {
        final z = nidRestoreZeros(o[k]);
        if (z.isEmpty) continue;
        r.warns.add(
          'صفرِ اولِ کد ملی$who «${(o[k] ?? '').trim()}» در اکسل افتاده بود — «$z» ثبت می‌شود.',
        );
        o = {...o, k: z};
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
          owner = usersByNid[nid]?.last;
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
        for (final u in usersByPhone[ph] ?? const <EngineRow>[]) {
          if (u.id != _int(data['existing_id'])) {
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
        // a section the file names itself («دهم الکترونیک ۲») is always respected
        var cls = cname.isEmpty ? null : clsByName[normName(cname)];
        if (cls != null && isClass(cls)) {
          if (_s(cls.data['grade']).isNotEmpty) {
            data['grade'] = _s(cls.data['grade']);
          }
          if (_s(cls.data['branch']).isNotEmpty) {
            data['field'] = _s(cls.data['branch']);
          } else if (!bc.$2) {
            data.remove('field');
          }
        } else {
          cls = place.isEmpty ? null : clsByName[normName(place)];
        }
        var manual = false;
        // p2 `pickBranch`: only when matching failed — the least-filled section with room
        if ((cls == null || !isClass(cls)) &&
            rules.autoDistribute &&
            grade.isNotEmpty) {
          final cands = [
            for (final c in classes)
              if (isClass(c) &&
                  sameGrade(c.data['grade'], grade) &&
                  normName(c.data['branch']) == normName(branch))
                c,
          ]..sort((a, b) => a.id.compareTo(b.id));
          if (cands.isNotEmpty) {
            final g0 = normName(o['gender']);
            final gender = RegExp('پسر|مذکر|مرد').hasMatch(g0)
                ? 'پسر'
                : RegExp('دختر|مونث|مؤنث|زن').hasMatch(g0)
                ? 'دختر'
                : '';
            final fam = [
              _d(o['father_nid']),
              _d(o['mother_nid']),
            ].where((x) => x.length == 10).firstOrNull;
            bool fits(EngineRow c) {
              final x = occ[c.id]!;
              if (x.n >= x.cap) return false;
              if (rules.separateGender && gender.isNotEmpty) {
                if (gender == 'پسر' && x.girls > x.boys) return false;
                if (gender == 'دختر' && x.boys > x.girls) return false;
              }
              return true;
            }

            final open = cands.where(fits).toList();
            EngineRow? picked;
            if (rules.keepSiblings && fam != null) {
              final f = famCls[fam];
              if (f != null && normName(f.$2) == normName(grade)) {
                picked = open.where((c) => c.id == f.$1).firstOrNull;
              }
            }
            if (picked == null && open.isNotEmpty) {
              picked = open.reduce(
                (a, b) => occ[b.id]!.n < occ[a.id]!.n ? b : a,
              );
            }
            if (picked != null) {
              cls = picked;
              data['auto_placed'] = true;
            } else {
              manual = true;
              data['needs_manual'] = true;
              manualRows.add(
                ImportManual(
                  row: rowNo,
                  name: full,
                  wanted: place,
                  candidates: [
                    for (final c in cands)
                      (
                        id: c.id,
                        name: _s(c.data['name']),
                        n: occ[c.id]!.n,
                        cap: occ[c.id]!.cap,
                      ),
                  ],
                ),
              );
              fixIt('همهٔ شعبه‌های «$place» پر است — نیازمند بررسی دستی');
            }
          }
        }
        if (manual) {
          data['class_id'] = null;
        } else if (cls != null && isClass(cls)) {
          data['class_id'] = cls.id;
          final x = occ[cls.id];
          final same =
              _int(
                usersById[_int(data['existing_id']) ?? -1]?.data['class_id'],
              ) ==
              cls.id;
          if (x != null && !same) {
            x.n++;
            final g1 = normName(o['gender']);
            if (RegExp('پسر|مذکر|مرد').hasMatch(g1)) x.boys++;
            if (RegExp('دختر|مونث|مؤنث|زن').hasMatch(g1)) x.girls++;
          }
          if (rules.keepSiblings) {
            for (final k in ['father_nid', 'mother_nid']) {
              final v = _d(o[k]);
              if (v.length == 10) famCls.putIfAbsent(v, () => (cls!.id, grade));
            }
          }
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
          r.warns.add(
            field
                ? 'پایه و رشتهٔ «$place» ثبت می‌شود'
                : 'کلاس «$place» ساخته می‌شود',
          );
        } else if (branch.isNotEmpty) {
          data['class_id'] = null;
          data['followup_reason'] = 'پایه در فایل نبود (رشته: $branch)';
          r.warns.add(
            '${field ? 'پایه ثبت نشد' : 'کلاس ساخته نشد'}: ${data['followup_reason']} — در «نیازمند پیگیری» کامل کنید',
          );
        } else {
          r.warns.add(field ? 'بدون پایه و رشته' : 'بدون کلاس');
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
    // p2 `capRows`: class / now / added / total / capacity — the ready rows only
    final added = <int, int>{};
    for (final r in out) {
      if (!r.ready) continue;
      final cid = _int(r.data['class_id']);
      if (cid == null || !occ.containsKey(cid)) continue;
      final ex = usersById[_int(r.data['existing_id']) ?? -1];
      if (ex != null && _int(ex.data['class_id']) == cid) continue;
      added[cid] = (added[cid] ?? 0) + 1;
    }
    final now = <int, int>{};
    for (final u in users) {
      if (u.data['role'] != 'student' || u.data['active'] == false) continue;
      final cid = _int(u.data['class_id']);
      if (cid != null) now[cid] = (now[cid] ?? 0) + 1;
    }
    final capRows = [
      for (final e in added.entries)
        ImportCap(
          id: e.key,
          name: _s(classes.firstWhere((c) => c.id == e.key).data['name']),
          before: now[e.key] ?? 0,
          added: e.value,
          cap: occ[e.key]!.cap,
        ),
    ]..sort((a, b) => a.name.compareTo(b.name));
    return ImportReview(
      rows: out,
      newClasses: newClasses,
      branchFixes: fixes,
      branchAsk: asks,
      branchNew: newAsks,
      branchChoices: choices,
      phonesFixed: phones,
      capRows: capRows,
      manualRows: manualRows,
      rules: rules,
      mixed: mixed,
    );
  }

  /// p2 `place-rules-save`: the placement rules of this school.
  Future<RecordWrite> savePlaceRules(PlaceRules r) async {
    _requireManager();
    final prev = await db.get('schools', 1);
    final k = await db.put('schools', 1, {
      ...?prev?.data,
      'place_rules': r.toJson(),
    }, prev: prev);
    return RecordWrite('قواعد کلاس‌بندی ذخیره شد', id: 1, keys: [k]);
  }

  /// p2 `imp-raise-cap`: the capacity only goes up with the manager's explicit number — the
  /// system never raises it by itself (or a 55-student class is found months later).
  Future<RecordWrite> raiseCapacity(int classId, int cap) async {
    _requireManager();
    final prev = await db.existing('classes', classId, 'این کلاس');
    final cur = _int(prev.data['capacity']) ?? 30;
    if (cap < 1) {
      throw const RecordFailure('invalid', 'ظرفیت معتبر وارد کنید');
    }
    if (cap < cur) {
      throw const RecordFailure(
        'invalid',
        'ظرفیت تازه نباید کمتر از ظرفیت فعلی باشد',
      );
    }
    final k = await db.put('classes', classId, {
      ...prev.data,
      'capacity': cap,
    }, prev: prev);
    return RecordWrite(
      'ظرفیت «${_s(prev.data['name'])}» به ${_faNum(cap)} نفر رسید',
      id: classId,
      keys: [k],
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
    final res = ImportResult()
      ..fieldBased = (await SchoolStructure.read(db)).fieldBased;
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
    // row 202: the users by mobile / national id, kept current as rows are added — scanning
    // every user three times per parent made a 300-student file take seconds. [pos] keeps the
    // order of the old scan (stored users first, then the new ones) so the same one wins.
    final pos = <int, int>{};
    final cur = <int, Map<String, Object?>>{};
    final byPhone = <String, Set<int>>{};
    final byNid = <String, Set<int>>{};
    void index(int id, Map<String, Object?> u) {
      final old = cur[id];
      if (old != null) {
        byPhone[_d(old['phone'])]?.remove(id);
        byNid[_d(old['national_id'])]?.remove(id);
      }
      pos.putIfAbsent(id, () => pos.length);
      cur[id] = u;
      final ph = _d(u['phone']);
      if (ph.isNotEmpty) (byPhone[ph] ??= {}).add(id);
      final n = _d(u['national_id']);
      if (n.isNotEmpty) (byNid[n] ??= {}).add(id);
    }

    for (final u in users.values) {
      index(u.id, u.data);
    }
    void setUser(int id, Map<String, Object?> u) {
      newUsers[id] = u;
      index(id, u);
    }

    final linkKeys = {
      for (final l in links) '${_int(l['parent_id'])}|${_int(l['student_id'])}',
    };

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

    var prepared = 0;
    onProgress?.call('prepare', 0, ready.length);
    for (final r in ready) {
      if (onProgress != null) {
        prepared++;
        if (prepared % 25 == 0) {
          onProgress!('prepare', prepared, ready.length);
          await Future<void>.delayed(Duration.zero);
        }
      }
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
        setUser(uid, merged);
        ops.add(_Op('users', uid, merged, existing));
        res.updated++;
      } else {
        uid = await fresh('users');
        setUser(uid, row);
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
          // the last parent with this national id (as the old full scan)
          for (final id in byNid[pnid] ?? const <int>{}) {
            if (cur[id]!['role'] != 'parent') continue;
            if (pid == null || pos[id]! > pos[pid]!) pid = id;
          }
        }
        final phoneOwners = pphone.isEmpty
            ? const <int>{}
            : (byPhone[pphone] ?? const <int>{});
        if (pid == null && phoneOwners.isNotEmpty) {
          // the first user with this mobile decides (as the old scan's `break`)
          final first = phoneOwners.reduce(
            (a, b) => pos[a]! <= pos[b]! ? a : b,
          );
          final u = cur[first]!;
          final cn = _d(u['national_id']);
          if (u['role'] == 'parent' &&
              (pnid.isEmpty || cn.isEmpty || cn == pnid)) {
            pid = first;
          }
        }
        if (pid == null) {
          final free = pphone.isNotEmpty && phoneOwners.isEmpty ? pphone : '';
          pid = await fresh('users');
          final p = <String, Object?>{
            'name': pname.isEmpty ? '$rel $name' : pname,
            'role': 'parent',
            'national_id': pnid,
            'phone': free,
            'active': true,
          };
          setUser(pid, p);
          ops.add(_Op('users', pid, p, null));
          res.parents++;
        }
        if (linkKeys.add('$pid|$uid')) {
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
          // row 202: which fields are wrong and what the file had in them, so the fix form
          // shows every value of the student and outlines the wrong ones in red
          'fields': importProblemFields([
            ...c.errors,
            ...c.warns,
            ...?errRows[c.row],
          ]),
          'raw': {
            for (final e in c.raw.entries)
              if (e.value.trim().isNotEmpty) e.key: e.value.trim(),
          },
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
    // row 202: chunked — one commit per 100 records instead of two per record (300 students
    // took ~5.5 s and froze the screen), with progress between the chunks
    res.keys.addAll(
      await db.putAll([
        for (final o in ops) (o.collection, o.id, o.data, o.prev),
      ], onProgress: (d, t) => onProgress?.call('write', d, t)),
    );
    res.openIssues = (await db.allOrEmpty('import_issues'))
        .where((i) => i.data['status'] != 'done')
        .length;
    return res;
  }
}
