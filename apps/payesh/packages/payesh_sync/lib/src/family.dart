// Row 74, wave 5 — native parents pages. Same semantics as the web client's `parentHome`,
// `PAGES.child`, `PAGES.leaves` (parent view) and `actLeaveAdd` / the `leave` form handler
// (client/pages.js, client/app.js), checked against the Gateway contract:
//   * a parent sees exactly the children linked by `parent_links` (parent_id = own id);
//     server/policy.js and server/scope.js scope the pull the same way;
//   * home card: class name, average of the APPROVED grades, attendance = present / all
//     records (rounded); badges green ≥ 15 / amber ≥ 10 / red, and green ≥ 90 % / amber;
//   * child page: every grade with its review state (تأییدشده / در انتظار), the latest 12
//     attendance records (newest first), internships;
//   * leave request: one linked child, a date (default: the UTC day, `todayISO`) and an
//     optional trimmed reason; it is always sent as `pending` — approval is the school's
//     (server/policy.js downgrades silently; the Gateway refuses anything else with
//     `approval_denied`, wave 5);
//   * every write goes to the durable outbox and then to the local database (offline-first);
//     the Gateway (`/api/gw/v1/push`) is the only cloud path (row 75 / D‑36).
import 'dart:convert';
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';

import 'attendance.dart';
import 'outbox.dart';

/// Review state of a leave request (web badge «تأییدشده / رد شده / در انتظار»).
enum LeaveState {
  pending('در انتظار'),
  approved('تأییدشده'),
  rejected('رد شده');

  const LeaveState(this.labelFa);
  final String labelFa;

  /// Anything but approved / rejected reads as pending (same as the web badge).
  static LeaveState fromWire(Object? v) => switch (v) {
    'approved' => LeaveState.approved,
    'rejected' => LeaveState.rejected,
    _ => LeaveState.pending,
  };
}

/// Why a parents-page action was refused on the device (before anything is written).
enum FamilyError {
  notParent,
  notLinked,
  badDate,
  tooLarge;

  String get messageFa => switch (this) {
    FamilyError.notParent => 'این صفحه فقط برای ولی دانش‌آموز است',
    FamilyError.notLinked => 'این دانش‌آموز به حساب شما متصل نیست',
    FamilyError.badDate => 'تاریخ را درست انتخاب کنید',
    FamilyError.tooLarge => 'علت بیش از حد بلند است',
  };
}

final class FamilyFailure implements Exception {
  const FamilyFailure(this.kind, [this.detail]);
  final FamilyError kind;
  final Object? detail;
  String get messageFa => kind.messageFa;
  @override
  String toString() =>
      'FamilyFailure(${kind.name}${detail == null ? '' : ': $detail'})';
}

/// One linked child as the home card shows it.
final class ChildSummary {
  const ChildSummary({
    required this.id,
    required this.name,
    required this.className,
    required this.average,
    required this.attendancePercent,
    required this.approvedGrades,
    required this.attendanceRecords,
  });
  final int id;
  final String name;
  final String className;

  /// Average of the approved grades; null when there is none (shown as «—», not 0).
  final double? average;

  /// Present / all attendance records, rounded; null when there is no record.
  final int? attendancePercent;
  final int approvedGrades;
  final int attendanceRecords;
}

final class ChildGrade {
  const ChildGrade({
    required this.id,
    required this.subject,
    required this.term,
    required this.score,
    this.practicalScore,
    required this.approved,
  });
  final int id;

  /// Subject name; «—» when the subject is not on the device (web: same).
  final String subject;
  final String term;
  final num score;
  final num? practicalScore;
  final bool approved;
}

final class ChildAttendance {
  const ChildAttendance({
    required this.id,
    required this.date,
    required this.status,
    required this.raw,
  });
  final int id;
  final String date;

  /// Null for an unknown stored value; the page then shows [raw] (web: same).
  final AttendanceStatus? status;
  final String raw;
}

final class ChildInternship {
  const ChildInternship({
    required this.id,
    required this.date,
    required this.hours,
    required this.location,
    required this.approved,
  });
  final int id;
  final String date;
  final num? hours;
  final String location;
  final bool approved;
}

/// The child page.
final class ChildRecord {
  const ChildRecord({
    required this.summary,
    required this.grades,
    required this.attendance,
    required this.internships,
  });
  final ChildSummary summary;

  /// Every grade of the child (approved and pending), in stored order.
  final List<ChildGrade> grades;

  /// The latest [FamilyBook.recentAttendance] records, newest first.
  final List<ChildAttendance> attendance;
  final List<ChildInternship> internships;
}

/// One leave request of a linked child.
final class LeaveRequest {
  const LeaveRequest({
    required this.id,
    required this.studentId,
    required this.studentName,
    required this.date,
    required this.reason,
    required this.state,
    this.queued = false,
  });
  final int id;
  final int studentId;
  final String studentName;
  final String date;
  final String reason;
  final LeaveState state;

  /// The request is still in the outbox (not yet confirmed by the Gateway).
  final bool queued;
}

final class LeaveWriteResult {
  const LeaveWriteResult({required this.id, required this.key});
  final int id;
  final String key;

  /// Web toast: «درخواست ثبت شد — اگر مدرسه خاموش باشد، خودکار می‌رسد».
  String get messageFa => 'درخواست ثبت شد — اگر اتصال نباشد، خودکار می‌رسد';
}

/// The parents pages on the device. Reads the pulled local copy and writes leave requests
/// through [outbox]; nothing here talks to the network.
final class FamilyBook {
  FamilyBook({
    required this.engine,
    required this.outbox,
    required this.role,
    required this.uid,
    DateTime Function()? now,
    Random? random,
  }) : _now = now ?? DateTime.now,
       _random = random ?? Random.secure();

  final DataEngine engine;
  final SqliteOutbox outbox;
  final String role;
  final int uid;
  final DateTime Function() _now;
  final Random _random;

  static const String leaves = 'leaves';

  /// Web child page: `att.slice(0, 12)`.
  static const int recentAttendance = 12;

  /// Gateway per-op payload ceiling (server/tenancy.js `MAX_OP_BYTES`).
  static const int maxOpBytes = 64 * 1024;

  /// Reserved id range for leave requests created by the native client. The Gateway takes
  /// client-chosen positive ids (no temp-id remap) and a request has no natural key (a parent
  /// may ask twice for the same day), so the id is random in [idBase, idBase + idSpan): below
  /// the attendance range (4e15..5e15) and 2^53. A collision cannot overwrite silently: a new
  /// request is sent with base version 0, so an existing record answers with a conflict.
  static const int idBase = 3000000000000000;
  static const int idSpan = 1000000000000000;

  bool get isParent => role == 'parent';

  /// UTC day, same as the web client's `todayISO()`.
  String today() => _now().toUtc().toIso8601String().substring(0, 10);

  int _newId() {
    final hi = _random.nextInt(1 << 32);
    final lo = _random.nextInt(1 << 32);
    return idBase + ((hi << 32) | lo) % idSpan;
  }

  static int? _int(Object? v) => switch (v) {
    final int i => i,
    final double d when d == d.truncateToDouble() => d.toInt(),
    final String s => int.tryParse(s.trim()),
    _ => null,
  };

  /// Web `Number(x || 0)`: a missing or non-numeric value counts as 0.
  static num _num(Object? v) => switch (v) {
    final num n => n,
    final String s => num.tryParse(s.trim()) ?? 0,
    _ => 0,
  };

  static num? _numOrNull(Object? v) => switch (v) {
    final num n => n,
    final String s => num.tryParse(s.trim()),
    _ => null,
  };

  static bool _live(EngineRow? r) => r != null && r.data['deleted'] != true;

  void _requireParent() {
    if (!isParent) throw FamilyFailure(FamilyError.notParent, role);
  }

  Future<List<EngineRow>> _all(String collection) async {
    final out = <EngineRow>[];
    for (var off = 0; ; off += 500) {
      final page = await engine.list(collection, limit: 500, offset: off);
      out.addAll(page);
      if (page.length < 500) return out;
    }
  }

  Future<List<EngineRow>> _ofStudent(String collection, int sid) async => [
    for (final r in await engine.byRef(collection, 'student_id', sid))
      if (_live(r) && _int(r.data['student_id']) == sid) r,
  ]..sort((a, b) => a.id.compareTo(b.id));

  /// Linked children in link order (one card per child even if linked twice).
  Future<List<EngineRow>> _children() async {
    final links = [
      for (final l in await _all('parent_links'))
        if (_live(l) && _int(l.data['parent_id']) == uid) l,
    ]..sort((a, b) => a.id.compareTo(b.id));
    final seen = <int>{};
    final out = <EngineRow>[];
    for (final l in links) {
      final sid = _int(l.data['student_id']);
      if (sid == null || !seen.add(sid)) continue;
      final u = await engine.get('users', sid);
      if (_live(u)) out.add(u!);
    }
    return out;
  }

  Future<EngineRow> _linked(int studentId) async {
    for (final k in await _children()) {
      if (k.id == studentId) return k;
    }
    throw FamilyFailure(FamilyError.notLinked, studentId);
  }

  Future<String> _className(EngineRow kid) async {
    final cid = _int(kid.data['class_id']);
    final c = cid == null ? null : await engine.get('classes', cid);
    return _live(c) ? '${c!.data['name'] ?? ''}' : '';
  }

  Future<ChildSummary> _summary(
    EngineRow kid,
    List<EngineRow> grades,
    List<EngineRow> att,
  ) async {
    final approved = [
      for (final g in grades)
        if (g.data['status'] == 'approved') _num(g.data['score']),
    ];
    final present = att.where((a) => a.data['status'] == 'present').length;
    return ChildSummary(
      id: kid.id,
      name: '${kid.data['name'] ?? ''}',
      className: await _className(kid),
      average: approved.isEmpty
          ? null
          : approved.fold<num>(0, (a, b) => a + b) / approved.length,
      attendancePercent: att.isEmpty
          ? null
          : (present * 100 / att.length).round(),
      approvedGrades: approved.length,
      attendanceRecords: att.length,
    );
  }

  /// Home: one summary per linked child.
  Future<List<ChildSummary>> children() async {
    _requireParent();
    return [
      for (final k in await _children())
        await _summary(
          k,
          await _ofStudent('grades', k.id),
          await _ofStudent('attendance', k.id),
        ),
    ];
  }

  /// Child page of a linked child; any other student is refused (never a fallback child).
  Future<ChildRecord> child(int studentId) async {
    _requireParent();
    final kid = await _linked(studentId);
    final grades = await _ofStudent('grades', kid.id);
    final att = await _ofStudent('attendance', kid.id);
    final subjects = <int, String>{};
    for (final g in grades) {
      final sid = _int(g.data['subject_id']);
      if (sid == null || subjects.containsKey(sid)) continue;
      final s = await engine.get('subjects', sid);
      subjects[sid] = _live(s) ? '${s!.data['name'] ?? ''}' : '';
    }
    final recent = [...att]
      ..sort((a, b) {
        final c = '${b.data['date'] ?? ''}'.compareTo(
          '${a.data['date'] ?? ''}',
        );
        return c != 0 ? c : b.id.compareTo(a.id);
      });
    return ChildRecord(
      summary: await _summary(kid, grades, att),
      grades: [
        for (final g in grades)
          ChildGrade(
            id: g.id,
            subject: switch (subjects[_int(g.data['subject_id'])]) {
              final String n when n.isNotEmpty => n,
              _ => '—',
            },
            term: '${g.data['term'] ?? ''}',
            score: _num(g.data['score']),
            practicalScore: _numOrNull(g.data['practical_score']),
            approved: g.data['status'] == 'approved',
          ),
      ],
      attendance: [
        for (final a in recent.take(recentAttendance))
          ChildAttendance(
            id: a.id,
            date: '${a.data['date'] ?? ''}',
            status: AttendanceStatus.fromWire(a.data['status']),
            raw: '${a.data['status'] ?? ''}',
          ),
      ],
      internships: [
        for (final i in await _ofStudent('internships', kid.id))
          ChildInternship(
            id: i.id,
            date: '${i.data['date'] ?? ''}',
            hours: _numOrNull(i.data['hours']),
            location: '${i.data['location'] ?? ''}',
            approved: i.data['status'] == 'approved',
          ),
      ],
    );
  }

  /// Leave requests of the linked children, newest day first (same day: higher id first).
  Future<List<LeaveRequest>> leaveRequests() async {
    _requireParent();
    final kids = {for (final k in await _children()) k.id: k};
    final queued = {
      for (final o in outbox.list())
        if (o.collection == leaves && o.id != null) o.id!,
    };
    final out = <LeaveRequest>[];
    for (final k in kids.values) {
      for (final l in await _ofStudent(leaves, k.id)) {
        out.add(
          LeaveRequest(
            id: l.id,
            studentId: k.id,
            studentName: '${k.data['name'] ?? ''}',
            date: '${l.data['date'] ?? ''}',
            reason: '${l.data['reason'] ?? ''}',
            state: LeaveState.fromWire(l.data['status']),
            queued: queued.contains(l.id),
          ),
        );
      }
    }
    out.sort((a, b) {
      final c = b.date.compareTo(a.date);
      return c != 0 ? c : b.id.compareTo(a.id);
    });
    return out;
  }

  static final RegExp _isoDay = RegExp(r'^\d{4}-\d{2}-\d{2}$');

  /// A real calendar day `YYYY-MM-DD` (no 2026-02-30).
  static bool validDay(String d) {
    if (!_isoDay.hasMatch(d)) return false;
    final t = DateTime.tryParse('${d}T00:00:00Z');
    return t != null && t.toIso8601String().substring(0, 10) == d;
  }

  /// Sends a leave request for a linked child. Every check runs before anything is written;
  /// the request is always `pending`.
  Future<LeaveWriteResult> requestLeave({
    required int studentId,
    String? date,
    String reason = '',
  }) async {
    _requireParent();
    await _linked(studentId);
    final day = (date == null || date.trim().isEmpty) ? today() : date.trim();
    if (!validDay(day)) throw FamilyFailure(FamilyError.badDate, day);
    var id = _newId();
    for (var i = 0; i < 8 && await engine.get(leaves, id) != null; i++) {
      id = _newId();
    }
    final data = <String, Object?>{
      'id': id,
      'student_id': studentId,
      'date': day,
      'reason': reason.trim(),
      'status': 'pending',
      'by_id': uid,
    };
    final bytes = utf8.encode(jsonEncode(data)).length;
    if (bytes > maxOpBytes) throw FamilyFailure(FamilyError.tooLarge, bytes);
    final q = outbox.enqueue({
      'collection': leaves,
      'type': 'put',
      'id': id,
      'data': data,
      'base_version': 0,
    });
    // a full queue refuses here, before the local write
    if (!q.ok) throw SyncFailure(q.error?.wire ?? 'queue_full', code: q.error);
    await engine.put(leaves, id, data, version: 0);
    return LeaveWriteResult(id: id, key: q.k!);
  }
}
