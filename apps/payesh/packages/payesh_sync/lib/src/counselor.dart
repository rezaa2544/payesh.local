// Row 187 — the counselor's referral queue (the p2 definition, src/js/47-counselor.js).
//
// The manager (and the معاون, who has the manager's access) refers a student; the counselor
// sees only that queue: name, grade/branch, reason and the attendance pattern of the last 30
// days — never grades or the full record (server/policy.js scopes the counselor to the referred
// students). Statuses: `open` → `handled` (with an optional note).
import 'package:payesh_data/payesh_data.dart';

import 'classes.dart' show rosterStudent;
import 'class_notes.dart' show ClassNotes;
import 'records.dart';

/// One row of `counselor_refs` with what the queue shows about the student.
final class CounselorRef {
  const CounselorRef({
    required this.row,
    required this.studentName,
    required this.cohort,
    required this.absent,
    required this.late,
    required this.earlyExit,
  });
  final EngineRow row;
  final String studentName;

  /// «پایه · رشته» of the student (empty when unknown).
  final String cohort;
  final int absent;
  final int late;
  final int earlyExit;

  int get id => row.id;
  int? get studentId => _int(row.data['student_id']);
  String get reason => SchoolRecords.str(row.data['reason']);
  String get note => SchoolRecords.str(row.data['note']);
  String get referredAt => SchoolRecords.str(row.data['referred_at']);
  bool get open => SchoolRecords.str(row.data['status']) != 'handled';
}

int? _int(Object? v) =>
    v is int ? v : (v is num ? v.toInt() : int.tryParse('$v'));

final class CounselorQueue {
  CounselorQueue(this.db, {DateTime Function()? now})
    : now = now ?? DateTime.now;
  final SchoolRecords db;
  final DateTime Function() now;

  static const String refs = 'counselor_refs';

  /// The manager refers; the counselor handles (server/policy.js `counselor_refs`).
  /// Row 197 (Q12 / F19): the teacher refers their own students too (server/policy.js).
  bool get canRefer => db.role == 'manager' || db.role == 'teacher';
  bool get canHandle => db.role == 'manager' || db.role == 'counselor';

  /// Open referrals first, then the newest.
  Future<List<CounselorRef>> list() async {
    final rows = await db.allOrEmpty(refs);
    final users = {for (final u in await db.allOrEmpty('users')) u.id: u};
    final att = await db.allOrEmpty('attendance');
    final since = now()
        .toUtc()
        .subtract(const Duration(days: 30))
        .toIso8601String()
        .substring(0, 10);
    final out = <CounselorRef>[];
    for (final r in rows) {
      final sid = _int(r.data['student_id']);
      final u = sid == null ? null : users[sid];
      final mine = att.where(
        (a) =>
            _int(a.data['student_id']) == sid &&
            SchoolRecords.str(a.data['date']).compareTo(since) >= 0,
      );
      int n(String st) =>
          mine.where((a) => SchoolRecords.str(a.data['status']) == st).length;
      out.add(
        CounselorRef(
          row: r,
          studentName: SchoolRecords.str(u?.data['name']),
          cohort: [
            SchoolRecords.str(u?.data['grade']),
            SchoolRecords.str(u?.data['branch']),
          ].where((s) => s.isNotEmpty).join(' · '),
          absent: n('absent'),
          late: n('late'),
          earlyExit: n('early_exit'),
        ),
      );
    }
    out.sort((a, b) {
      if (a.open != b.open) return a.open ? -1 : 1;
      return b.referredAt.compareTo(a.referredAt);
    });
    return out;
  }

  /// Active students this user can refer, by name — every student for the manager, only
  /// the students of the teacher's own classes for a teacher (server `out_of_scope`).
  Future<List<EngineRow>> students() async {
    final all = await db.allOrEmpty('users');
    final Set<int>? mine = db.role == 'teacher'
        ? (await ClassNotes(db).myClasses()).map((c) => c.id).toSet()
        : null;
    final s = all
        .where((u) => rosterStudent(u.data))
        .where((u) => mine == null || mine.contains(_cid(u.data['class_id'])))
        .toList();
    s.sort(
      (a, b) =>
          SchoolRecords.str(a.data['name'])
              .compareTo(SchoolRecords.str(b.data['name'])),
    );
    return s;
  }

  Future<RecordWrite> refer(int studentId, String reason) async {
    final why = reason.trim();
    if (why.isEmpty) {
      throw RecordFailure('reason', 'علت ارجاع را بنویسید', refs);
    }
    if (!canRefer) {
      throw RecordFailure(
        'not_allowed',
        'این کار برای نقش شما مجاز نیست',
        refs,
      );
    }
    if (db.role == 'teacher' &&
        !(await students()).any((u) => u.id == studentId)) {
      throw RecordFailure(
        'out_of_scope',
        'این دانش‌آموز در کلاس‌های شما نیست',
        refs,
      );
    }
    final id = await db.newId(refs);
    final k = await db.put(refs, id, {
      'student_id': studentId,
      'reason': why,
      'status': 'open',
      'referred_by': db.uid,
      'referred_at': now().toUtc().toIso8601String(),
      'school_id': 1,
    });
    return RecordWrite('به صف مشاور ارجاع شد', id: id, keys: [k]);
  }

  Future<RecordWrite> handle(CounselorRef ref, String note) async {
    final k = await db.put(refs, ref.id, {
      ...ref.row.data,
      'status': 'handled',
      'note': note.trim(),
      'handled_by': db.uid,
      'handled_at': now().toUtc().toIso8601String(),
    }, prev: ref.row);
    return RecordWrite('ارجاع پیگیری شد', id: ref.id, keys: [k]);
  }
}

int? _cid(Object? v) =>
    v is int ? v : (v is num ? v.toInt() : int.tryParse('${v ?? ''}'));
