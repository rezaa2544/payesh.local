// Row 197 (Q12 / F21) — the school's exam calendar.
//
//   exams { date: YYYY-MM-DD, kind: internal | national, subject_id?, class_id?, grade?,
//           branch?, title, moved_from? }
//
// * Only the manager adds or removes an exam (server/policy.js `exams: write manager`).
// * Everyone reads them (read 'all'); a student sees the exams of their own class, of their
//   cohort (پایه × رشته) and the school-wide ones (no class and no grade) — on their home
//   («امتحان‌های پیش رو») and in «پروندهٔ من».
// * A national (نهایی) exam is the education office's: a sudden day off never moves it
//   (school_calendar.dart), and the list marks it.
import 'package:payesh_data/payesh_data.dart' show EngineRow;

import 'records.dart';

enum ExamKind {
  internal('داخلی'),
  national('نهایی');

  const ExamKind(this.labelFa);
  final String labelFa;

  static ExamKind of(Object? v) => v == 'national' ? national : internal;
}

final class ExamLimits {
  static const int title = 200;
}

final class Exam {
  const Exam(this.row, {this.subjectName = '', this.className = ''});
  final EngineRow row;
  final String subjectName;
  final String className;

  int get id => row.id;
  String get date => SchoolRecords.str(row.data['date']);
  ExamKind get kind => ExamKind.of(row.data['kind']);
  String get title => SchoolRecords.str(row.data['title']);
  int? get classId => SchoolRecords.asInt(row.data['class_id']);
  String get grade => SchoolRecords.str(row.data['grade']).trim();
  String get branch => SchoolRecords.str(row.data['branch']).trim();
  String get movedFrom => SchoolRecords.str(row.data['moved_from']);

  /// What the list shows as the exam's name: «ریاضی — میان‌نوبت» / «ریاضی» / the title.
  String get label {
    final s = subjectName.trim(), t = title.trim();
    if (s.isEmpty) return t.isEmpty ? 'امتحان' : t;
    return t.isEmpty || t == s ? s : '$s — $t';
  }

  /// Who sits it: the class, the cohort, or «همهٔ مدرسه».
  String get audience {
    if (className.isNotEmpty) return className;
    if (grade.isNotEmpty) return branch.isEmpty ? grade : '$grade · $branch';
    return 'همهٔ مدرسه';
  }

  /// Is this exam for a student of [classId] / [grade] × [branch]?
  bool isFor({int? classId, String grade = '', String branch = ''}) {
    final c = this.classId;
    if (c != null) return classId != null && c == classId;
    if (this.grade.isEmpty) return true; // school-wide
    if (this.grade != grade.trim()) return false;
    return this.branch.isEmpty || this.branch == branch.trim();
  }
}

final class SchoolExams {
  SchoolExams(this.db);
  final SchoolRecords db;

  bool get canWrite => db.role == 'manager';

  static String _day(String v) {
    final t = v.trim();
    final ok =
        RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(t) &&
        DateTime.tryParse(t) != null;
    if (!ok) throw RecordFailure('bad_date', 'تاریخ امتحان درست نیست', v);
    return t;
  }

  /// Adds an exam (manager only). Either [subjectId] or [title] names it; [classId] or
  /// [grade] (+ optional [branch]) narrows who sits it, neither = the whole school.
  Future<RecordWrite> add({
    required String date,
    ExamKind kind = ExamKind.internal,
    int? subjectId,
    int? classId,
    String grade = '',
    String branch = '',
    String title = '',
    required String today,
  }) async {
    if (!canWrite) {
      throw const RecordFailure('not_allowed', 'افزودن امتحان فقط با مدیر است');
    }
    final d = _day(date);
    if (d.compareTo(today) < 0) {
      throw const RecordFailure('bad_date', 'تاریخ امتحان گذشته است');
    }
    final t = title.trim();
    if (subjectId == null && t.isEmpty) {
      throw const RecordFailure(
        'text_required',
        'درس یا عنوان امتحان را بنویسید',
      );
    }
    if (t.length > ExamLimits.title) {
      throw const RecordFailure(
        'text_too_long',
        'عنوان امتحان بیش از حد بلند است',
      );
    }
    final id = await db.newId('exams');
    final k = await db.put('exams', id, {
      'date': d,
      'kind': kind.name,
      'subject_id': ?subjectId,
      'class_id': ?classId,
      if (classId == null && grade.trim().isNotEmpty) 'grade': grade.trim(),
      if (classId == null &&
          grade.trim().isNotEmpty &&
          branch.trim().isNotEmpty)
        'branch': branch.trim(),
      'title': t,
      'created_by': db.uid,
      'school_id': 1,
    });
    return RecordWrite('امتحان ثبت شد', id: id, keys: [k]);
  }

  Future<RecordWrite> delete(Exam e) async {
    if (!canWrite) {
      throw const RecordFailure('not_allowed', 'حذف امتحان فقط با مدیر است');
    }
    final k = await db.del('exams', e.row);
    return RecordWrite('امتحان حذف شد', id: e.id, keys: [k]);
  }

  /// Exams from [from] on (every one when null), soonest first.
  Future<List<Exam>> list({String? from}) async {
    final classes = {for (final c in await db.allOrEmpty('classes')) c.id: c};
    final subjects = {for (final s in await db.allOrEmpty('subjects')) s.id: s};
    final out = <Exam>[
      for (final r in await db.allOrEmpty('exams'))
        if (from == null ||
            SchoolRecords.str(r.data['date']).compareTo(from) >= 0)
          Exam(
            r,
            subjectName: SchoolRecords.str(
              subjects[SchoolRecords.asInt(r.data['subject_id'])]?.data['name'],
            ),
            className: SchoolRecords.str(
              classes[SchoolRecords.asInt(r.data['class_id'])]?.data['name'],
            ),
          ),
    ];
    out.sort((a, b) {
      final c = a.date.compareTo(b.date);
      return c != 0 ? c : a.id.compareTo(b.id);
    });
    return out;
  }

  /// The upcoming exams one student sits.
  Future<List<Exam>> upcomingFor({
    required String from,
    int? classId,
    String grade = '',
    String branch = '',
  }) async => [
    for (final e in await list(from: from))
      if (e.isFor(classId: classId, grade: grade, branch: branch)) e,
  ];
}
