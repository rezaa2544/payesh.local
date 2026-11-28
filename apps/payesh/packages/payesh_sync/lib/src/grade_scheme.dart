// Row 197 Q08/Q09 (F34, F35) — the three ways a grade is given in Iranian schools, the same
// rules as server/grade-scheme.js (web twin in client/pages.js `gradeSchemeOf`):
//   * numeric — 0..20, نوبت اول / نوبت دوم / پایانی (متوسطه اول و دوم، دروس عمومی هنرستان);
//   * modular (ارزشیابی پودمانی) — دروس شایستگی هنرستان فنی‌وحرفه‌ای و کاردانش: ۵ پودمان مستقل؛
//     نمرهٔ هر پودمان = شایستگی (۱ عدم احراز، ۲ احراز، ۳ بالاتر از حد انتظار) × ۵ + مستمر (۰ تا ۵،
//     گام ۰٫۵). قبولی هر پودمان ۱۲؛ درس وقتی قبول است که هر ۵ پودمان ≥ ۱۲ باشد و نمرهٔ درس میانگین
//     پودمان‌هاست؛ وگرنه «ناتمام» و فقط پودمان‌های ناتمام دوباره ارزشیابی می‌شوند (تک‌ماده ندارد);
//   * descriptive (ارزشیابی کیفی‌ـ‌توصیفی) — دورهٔ ابتدایی: خیلی خوب / خوب / قابل قبول / نیاز به
//     تلاش بیشتر، بی‌نمرهٔ عددی.
import 'records.dart';
import 'school_structure.dart' show levelOf;

enum GradeScheme {
  numeric('نمرهٔ ۰ تا ۲۰'),
  modular('ارزشیابی پودمانی'),
  descriptive('ارزشیابی کیفی‌ـ‌توصیفی');

  const GradeScheme(this.labelFa);
  final String labelFa;
}

/// The four levels of descriptive assessment, best first (stored as this text in `level`).
const List<String> descriptiveLevels = [
  'خیلی خوب',
  'خوب',
  'قابل قبول',
  'نیاز به تلاش بیشتر',
];

/// Competency levels of a module (stored as 1/2/3 in `competency`).
const Map<int, String> competencyLevels = {
  1: 'عدم احراز شایستگی',
  2: 'احراز شایستگی',
  3: 'بالاتر از حد انتظار',
};

const int moduleCount = 5;
const num modulePass = 12;

/// School types whose competency (workshop) subjects are assessed by modules.
const Set<String> modularSchoolTypes = {'vocational', 'kardanesh'};

/// Which scheme a subject of this school is graded with. [school] is `schools/1`, [subject]
/// the subject row. An explicit `modular: true/false` on the subject wins; otherwise a
/// workshop subject of a هنرستان (فنی‌وحرفه‌ای / کاردانش) is modular. Every subject of an
/// ابتدایی school is descriptive.
GradeScheme gradeSchemeOf(
  Map<String, Object?>? school,
  Map<String, Object?>? subject,
) {
  if (levelOf(school?['level']) == 'ابتدایی') return GradeScheme.descriptive;
  final m = subject?['modular'];
  if (m == true) return GradeScheme.modular;
  if (m == false) return GradeScheme.numeric;
  final t = SchoolRecords.str(school?['school_type']);
  if (modularSchoolTypes.contains(t) && subject?['workshop'] == true) {
    return GradeScheme.modular;
  }
  return GradeScheme.numeric;
}

const String _fa = '۰۱۲۳۴۵۶۷۸۹';
String _faNum(Object n) =>
    '$n'.replaceAllMapped(RegExp('[0-9]'), (m) => _fa[int.parse(m[0]!)]);

/// The `term` text of module [k] (1..5): «پودمان ۱».
String moduleTerm(int k) => 'پودمان ${_faNum(k)}';

/// Module number of a `term` text, or null.
int? moduleOfTerm(Object? term) {
  final t = SchoolRecords.str(
    term,
  ).replaceAllMapped(RegExp('[۰-۹]'), (m) => '${m[0]!.codeUnitAt(0) - 0x06F0}');
  final m = RegExp(r'^پودمان\s*([1-5])$').firstMatch(t);
  return m == null ? null : int.parse(m[1]!);
}

/// Score of a module: competency × 5 + continuous.
num moduleScore(int competency, num continuous) {
  final v = competency * 5 + continuous;
  return v == v.truncateToDouble() ? v.toInt() : v;
}

/// Same rules as server `gradeIssue` (null = fine): a modular grade row has `competency` 1..3,
/// `continuous` 0..5 in steps of 0.5 and `score` = competency × 5 + continuous; a descriptive
/// row has one of [descriptiveLevels] and no score; a numeric score is 0..20.
String? gradeRowIssue(Map<String, Object?> row) {
  final kind = SchoolRecords.str(row['kind']);
  final score = row['score'];
  num? n(Object? v) => v is num ? v : num.tryParse('${v ?? ''}'.trim());
  if (kind == 'descriptive') {
    if (!descriptiveLevels.contains(SchoolRecords.str(row['level']))) {
      return 'bad_level';
    }
    if (score != null && '$score'.trim().isNotEmpty) return 'bad_level';
    return null;
  }
  if (kind == 'module') {
    if (moduleOfTerm(row['term']) == null) return 'bad_module';
    final c = n(row['competency']);
    final m = n(row['continuous']);
    if (c == null || ![1, 2, 3].contains(c)) return 'bad_module';
    if (m == null || m < 0 || m > 5 || (m * 2) != (m * 2).truncateToDouble()) {
      return 'bad_module';
    }
    final s = n(score);
    if (s == null || s != c * 5 + m) return 'bad_module';
    return null;
  }
  if (score != null && '$score'.trim().isNotEmpty) {
    final s = n(score);
    if (s == null || s < 0 || s > 20) return 'bad_score';
  }
  return null;
}

/// Persian text of a grade refusal.
String gradeIssueFa(String code) => switch (code) {
  'bad_level' => 'ارزشیابی توصیفی فقط یکی از «خیلی خوب، خوب، قابل قبول، نیاز به تلاش بیشتر» است',
  'bad_module' => 'نمرهٔ پودمان: شایستگی ۱ تا ۳ و مستمر ۰ تا ۵ (گام ۰٫۵) — نمره = شایستگی × ۵ + مستمر',
  'bad_score' => 'نمره باید بین ۰ تا ۲۰ باشد',
  _ => 'نمرهٔ نامعتبر',
};

/// The result of one competency subject from its five module scores (null = not assessed yet).
final class ModuleResult {
  const ModuleResult(this.scores);

  /// Score of module 1..5 (index 0..4), null when not given yet.
  final List<num?> scores;

  /// Modules (1-based) given and below the pass mark — they are re-assessed.
  List<int> get failed => [
    for (var i = 0; i < scores.length; i++)
      if (scores[i] != null && scores[i]! < modulePass) i + 1,
  ];

  /// Modules (1-based) not assessed yet.
  List<int> get missing => [
    for (var i = 0; i < scores.length; i++)
      if (scores[i] == null) i + 1,
  ];

  /// Every module given and ≥ 12.
  bool get passed => missing.isEmpty && failed.isEmpty;

  /// Course grade: the average of the five modules, only when passed (never a fake 0).
  num? get average {
    if (!passed) return null;
    final sum = scores.fold<num>(0, (a, b) => a + b!);
    final v = (sum / scores.length * 100).round() / 100;
    return v == v.truncateToDouble() ? v.toInt() : v;
  }

  /// «قبول — ۱۵٫۴» / «ناتمام (پودمان ۲، ۴)» / «در حال ارزشیابی (۳ از ۵ پودمان)».
  String get labelFa {
    if (passed) return 'قبول — ${_faNum(average!).replaceAll('.', '٫')}';
    if (failed.isNotEmpty) {
      return 'ناتمام (${failed.map((k) => 'پودمان ${_faNum(k)}').join('، ')})';
    }
    return 'در حال ارزشیابی (${_faNum(scores.length - missing.length)} از ${_faNum(scores.length)} پودمان)';
  }
}

/// A grade row's score that counts in an average: numeric grades only — a descriptive level
/// has no number and a module counts through its course result ([ModuleResult]).
num? averageScore(Map<String, Object?> row) {
  final k = SchoolRecords.str(row['kind']);
  if (k == 'descriptive' || k == 'module') return null;
  final s = row['score'];
  if (s is num) return s;
  return num.tryParse('${s ?? ''}'.trim());
}

/// Row 197 F20/F24: the mean of the given scores, or null when there is none — a student
/// with no grade has «—», never «معدل ۰٫۰».
double? averageOf(Iterable<num?> scores) {
  final v = scores.whereType<num>().toList();
  if (v.isEmpty) return null;
  return v.fold<num>(0, (a, b) => a + b) / v.length;
}

/// What a grade row shows: the level of a descriptive grade, else its score («—» if none).
String gradeValueText(Map<String, Object?> row) {
  if (SchoolRecords.str(row['kind']) == 'descriptive') {
    final l = SchoolRecords.str(row['level']);
    return l.isEmpty ? '—' : l;
  }
  final s = row['score'];
  if (s == null || '$s'.trim().isEmpty) return '—';
  return _faNum('$s').replaceAll('.', '٫');
}
