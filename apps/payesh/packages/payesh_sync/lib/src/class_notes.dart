// Row 197 — Q12 (F19 / F21 / F27): the teacher's class notes — homework for a class and a
// discipline note (تشویق / تذکر / یادداشت) for one student — and what the student and the
// parent see of them. Same row shapes and limits as server/policy.js `classNoteIssue`; the
// server also checks that the class is the teacher's own (`out_of_scope`) and that a teacher
// only changes their own rows (`not_author`).
import 'package:payesh_data/payesh_data.dart';

import 'records.dart';

int? _int(Object? v) =>
    v is int ? v : (v is num ? v.toInt() : int.tryParse('${v ?? ''}'));

/// `discipline.kind` (server/policy.js `DISCIPLINE_KINDS`).
enum DisciplineKind {
  positive('positive', 'تشویق'),
  negative('negative', 'تذکر'),
  note('note', 'یادداشت');

  const DisciplineKind(this.wire, this.labelFa);
  final String wire;
  final String labelFa;

  static DisciplineKind of(Object? v) => values.firstWhere(
    (k) => k.wire == '$v',
    orElse: () => DisciplineKind.note,
  );
}

/// server/policy.js `NOTE_LIMITS`.
abstract final class ClassNoteLimits {
  static const int title = 200;
  static const int homeworkBody = 2000;
  static const int disciplineNote = 1000;
}

/// One homework row as the pages show it.
final class Homework {
  const Homework(this.row, {this.className = '', this.subjectName = ''});
  final EngineRow row;
  final String className;
  final String subjectName;
  int get id => row.id;
  int? get classId => _int(row.data['class_id']);
  int? get authorId => _int(row.data['author_id']);
  String get title => SchoolRecords.str(row.data['title']);
  String get body => SchoolRecords.str(row.data['body']);

  /// ISO day it is due (may be empty).
  String get due => SchoolRecords.str(row.data['due']);
  String get date => SchoolRecords.str(row.data['date']);
}

/// One discipline row as the pages show it.
final class DisciplineNote {
  const DisciplineNote(this.row, {this.studentName = ''});
  final EngineRow row;
  final String studentName;
  int get id => row.id;
  int? get studentId => _int(row.data['student_id']);
  DisciplineKind get kind => DisciplineKind.of(row.data['kind']);
  String get note => SchoolRecords.str(row.data['note']);
  String get date => SchoolRecords.str(row.data['date']);
}

final class ClassNotes {
  ClassNotes(this.db);
  final SchoolRecords db;

  bool get canWrite => db.role == 'manager' || db.role == 'teacher';

  static String? _day(String v) {
    final t = v.trim();
    if (t.isEmpty) return null;
    final ok =
        RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(t) &&
        DateTime.tryParse(t) != null;
    if (!ok) throw RecordFailure('bad_date', 'تاریخ درست نیست', t);
    return t;
  }

  /// The classes this user writes for: a teacher's timetable classes (+ their own class), the
  /// manager's every class. Sorted by name.
  Future<List<EngineRow>> myClasses() async {
    final classes = await db.allOrEmpty('classes');
    if (db.role == 'manager') {
      return classes.where((c) => c.data['kind'] != 'room').toList()..sort(
        (a, b) =>
            SchoolRecords.str(a.data['name'])
                .compareTo(SchoolRecords.str(b.data['name'])),
      );
    }
    final ids = <int>{};
    for (final s in await db.allOrEmpty('schedule')) {
      final t = _int(s.data['teacher_id']) ?? _int(s.data['ref2']);
      final c = _int(s.data['class_id']);
      if (t == db.uid && c != null) ids.add(c);
    }
    final me = await db.engine.get('users', db.uid);
    final own = _int(me?.data['class_id']);
    if (own != null) ids.add(own);
    return classes.where((c) => ids.contains(c.id)).toList()..sort(
      (a, b) =>
          SchoolRecords.str(a.data['name'])
              .compareTo(SchoolRecords.str(b.data['name'])),
    );
  }

  void _requireWriter() {
    if (!canWrite) {
      throw const RecordFailure(
        'not_allowed',
        'این کار برای نقش شما مجاز نیست',
      );
    }
  }

  Future<void> _requireMyClass(int classId) async {
    if (db.role == 'manager') return;
    if (!(await myClasses()).any((c) => c.id == classId)) {
      throw RecordFailure(
        'out_of_scope',
        'این کلاس در برنامهٔ شما نیست',
        classId,
      );
    }
  }

  /// A homework for [classId]; [due] is an ISO day or empty.
  Future<RecordWrite> addHomework({
    required int classId,
    required String title,
    String body = '',
    String due = '',
    int? subjectId,
  }) async {
    _requireWriter();
    final t = title.trim();
    final b = body.trim();
    if (t.isEmpty) {
      throw const RecordFailure('text_required', 'عنوان تکلیف را بنویسید');
    }
    if (t.length > ClassNoteLimits.title ||
        b.length > ClassNoteLimits.homeworkBody) {
      throw const RecordFailure(
        'text_too_long',
        'متن تکلیف بیش از حد بلند است',
      );
    }
    final d = _day(due);
    await _requireMyClass(classId);
    final id = await db.newId('homework');
    final k = await db.put('homework', id, {
      'class_id': classId,
      'title': t,
      'body': b,
      'due': ?d,
      'subject_id': ?subjectId,
      'date': db.today(),
      'author_id': db.uid,
      'school_id': 1,
    });
    return RecordWrite('تکلیف ثبت شد', id: id, keys: [k]);
  }

  Future<RecordWrite> deleteHomework(Homework h) async {
    _requireWriter();
    if (db.role != 'manager' && h.authorId != db.uid) {
      throw const RecordFailure(
        'not_author',
        'فقط تکلیف‌های خودتان را می‌توانید حذف کنید',
      );
    }
    final k = await db.del('homework', h.row);
    return RecordWrite('تکلیف حذف شد', id: h.id, keys: [k]);
  }

  /// Homework of [classIds] (null = every class this user may read), newest due first.
  Future<List<Homework>> homework({Set<int>? classIds}) async {
    final classes = {for (final c in await db.allOrEmpty('classes')) c.id: c};
    final subjects = {for (final s in await db.allOrEmpty('subjects')) s.id: s};
    final out = <Homework>[
      for (final r in await db.allOrEmpty('homework'))
        if (classIds == null || classIds.contains(_int(r.data['class_id'])))
          Homework(
            r,
            className: SchoolRecords.str(
              classes[_int(r.data['class_id'])]?.data['name'],
            ),
            subjectName: SchoolRecords.str(
              subjects[_int(r.data['subject_id'])]?.data['name'],
            ),
          ),
    ];
    out.sort((a, b) {
      final c = (b.due.isEmpty ? b.date : b.due).compareTo(
        a.due.isEmpty ? a.date : a.due,
      );
      return c != 0 ? c : b.id.compareTo(a.id);
    });
    return out;
  }

  /// A discipline note for one student of [classId].
  Future<RecordWrite> addDiscipline({
    required int studentId,
    required int classId,
    required DisciplineKind kind,
    required String note,
  }) async {
    _requireWriter();
    final n = note.trim();
    if (n.isEmpty) {
      throw const RecordFailure('text_required', 'متن یادداشت را بنویسید');
    }
    if (n.length > ClassNoteLimits.disciplineNote) {
      throw const RecordFailure(
        'text_too_long',
        'متن یادداشت بیش از حد بلند است',
      );
    }
    await _requireMyClass(classId);
    final id = await db.newId('discipline');
    final k = await db.put('discipline', id, {
      'student_id': studentId,
      'class_id': classId,
      'kind': kind.wire,
      'note': n,
      'date': db.today(),
      'author_id': db.uid,
      'school_id': 1,
    });
    return RecordWrite('یادداشت انضباطی ثبت شد', id: id, keys: [k]);
  }

  /// Discipline notes (of [studentIds], or every readable one), newest first.
  Future<List<DisciplineNote>> discipline({Set<int>? studentIds}) async {
    final users = {for (final u in await db.allOrEmpty('users')) u.id: u};
    final out = <DisciplineNote>[
      for (final r in await db.allOrEmpty('discipline'))
        if (studentIds == null ||
            studentIds.contains(_int(r.data['student_id'])))
          DisciplineNote(
            r,
            studentName: SchoolRecords.str(
              users[_int(r.data['student_id'])]?.data['name'],
            ),
          ),
    ];
    out.sort((a, b) {
      final c = b.date.compareTo(a.date);
      return c != 0 ? c : b.id.compareTo(a.id);
    });
    return out;
  }
}
