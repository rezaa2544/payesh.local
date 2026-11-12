// Row 74, wave 2 — native attendance (teacher). Same semantics as the web client's
// `actAttendanceSave` (client/pages.js), checked against the Gateway contract:
//   * roster = users with role `student` and the same `class_id`;
//   * the default status is `present`; a student whose stored status is unchanged is skipped;
//   * every write goes to the local database first and then to the durable outbox (offline-first);
//     the Gateway (`/api/gw/v1/push`) is the only cloud path (row 75 / D‑36).
import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_data/payesh_data.dart';

import 'outbox.dart';

/// The five attendance states of the web client (`ATT_LABEL`) and the server
/// (`server/policy.js` `ATT_STATUS`).
enum AttendanceStatus {
  present('present', 'حاضر'),
  absent('absent', 'غایب'),
  late('late', 'تأخیر'),
  earlyExit('early_exit', 'خروج'),
  excused('excused', 'موجه');

  const AttendanceStatus(this.wire, this.labelFa);

  /// Value stored in the record (`status`).
  final String wire;

  /// Persian chip label (same words as the web client).
  final String labelFa;

  /// Unknown or missing values are `null` — never silently mapped to a state.
  static AttendanceStatus? fromWire(Object? v) {
    for (final s in values) {
      if (s.wire == v) return s;
    }
    return null;
  }
}

/// Why an attendance action was refused on the device (before anything is written).
enum AttendanceError {
  notAllowed,
  badDate,
  unknownClass,
  notInClass,
  badStudent;

  String get messageFa => switch (this) {
    AttendanceError.notAllowed =>
      'ثبت حضور و غیاب فقط برای معلم و مدیر مجاز است',
    AttendanceError.badDate => 'تاریخ نامعتبر است',
    AttendanceError.unknownClass => 'این کلاس در فهرست کلاس‌های شما نیست',
    AttendanceError.notInClass => 'این دانش‌آموز در فهرست این کلاس نیست',
    AttendanceError.badStudent => 'شناسهٔ دانش‌آموز نامعتبر است',
  };
}

final class AttendanceFailure implements Exception {
  const AttendanceFailure(this.kind, [this.detail]);
  final AttendanceError kind;
  final Object? detail;
  String get messageFa => kind.messageFa;
  @override
  String toString() =>
      'AttendanceFailure(${kind.name}${detail == null ? '' : ': $detail'})';
}

final class AttendanceClass {
  const AttendanceClass({required this.id, required this.name});
  final int id;
  final String name;
}

/// One student of the roster with what is stored for [AttendanceBook] date.
final class RosterEntry {
  const RosterEntry({
    required this.studentId,
    required this.name,
    this.recorded,
    this.recordId,
    this.version = 0,
    this.note = '',
  });
  final int studentId;
  final String name;

  /// Status already stored for the day (pulled from the server or saved here), or null.
  final AttendanceStatus? recorded;
  final int? recordId;
  final int version;
  final String note;
}

final class AttendanceSaveResult {
  const AttendanceSaveResult({
    required this.written,
    required this.unchanged,
    required this.keys,
  });

  /// Records written locally and queued for the Gateway.
  final int written;

  /// Students skipped because their stored status did not change.
  final int unchanged;

  /// Outbox idempotency keys of the queued ops (one per written record).
  final List<String> keys;

  /// Same message as the web toast.
  String get messageFa =>
      written == 0 ? 'تغییری نبود' : '$written رکورد ذخیره شد';
}

/// Teacher attendance on the device. Reads the pulled local copy (users, classes, schedule,
/// attendance) and writes through [outbox]; nothing here talks to the network.
final class AttendanceBook {
  AttendanceBook({
    required this.engine,
    required this.outbox,
    required this.role,
    required this.uid,
  });

  final DataEngine engine;
  final SqliteOutbox outbox;
  final String role;
  final int uid;

  static const String collection = 'attendance';

  /// Roles that may write attendance (server/policy.js `COLLECTIONS.attendance.write`).
  static const Set<String> writers = {'manager', 'teacher'};

  bool get canWrite => writers.contains(role);

  static final RegExp _isoDate = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$');

  /// The web client's `todayISO()` = `toISOString().slice(0, 10)`: the UTC calendar day. Both
  /// clients must agree on the key of "today", so the native client uses the same rule.
  static String dateOf(DateTime t) =>
      t.toUtc().toIso8601String().substring(0, 10);

  static DateTime? _parseDate(String date) {
    final m = _isoDate.firstMatch(date);
    if (m == null) return null;
    final y = int.parse(m[1]!), mo = int.parse(m[2]!), d = int.parse(m[3]!);
    final dt = DateTime.utc(y, mo, d);
    return dt.year == y && dt.month == mo && dt.day == d ? dt : null;
  }

  static final DateTime _epoch = DateTime.utc(2020);

  /// Reserved id range for attendance records created by the native client: the Gateway takes
  /// client-chosen positive ids (it has no temp-id remap), so the id is derived from
  /// (day, student). Two devices marking the same student on the same day therefore write the
  /// SAME record: the second one meets a version conflict and goes to human review (D‑28)
  /// instead of creating a duplicate. Stays below 2^53 (safe for the JavaScript server).
  static const int idBase = 4000000000000000;
  static const int maxStudentId = 9999999999;
  static const int maxDay = 99999;

  static int recordId(int studentId, String date) {
    if (studentId < 1 || studentId > maxStudentId) {
      throw AttendanceFailure(AttendanceError.badStudent, studentId);
    }
    final d = _parseDate(date);
    if (d == null) throw AttendanceFailure(AttendanceError.badDate, date);
    final day = d.difference(_epoch).inDays;
    if (day < 0 || day > maxDay) {
      throw AttendanceFailure(AttendanceError.badDate, date);
    }
    return idBase + day * 10000000000 + studentId;
  }

  static int? _int(Object? v) => switch (v) {
    final int i => i,
    final double d when d == d.truncateToDouble() => d.toInt(),
    final String s => int.tryParse(s.trim()),
    _ => null,
  };

  static String _name(Map<String, Object?> d, int id, String fallback) {
    final n = '${d['name'] ?? ''}'.trim();
    return n.isEmpty ? '$fallback $id' : n;
  }

  Future<List<EngineRow>> _all(String col) async {
    final out = <EngineRow>[];
    for (var off = 0; ; off += 500) {
      final page = await engine.list(col, limit: 500, offset: off);
      out.addAll(page);
      if (page.length < 500) return out;
    }
  }

  void _requireWriter() {
    if (!canWrite) throw AttendanceFailure(AttendanceError.notAllowed, role);
  }

  /// Classes this user takes attendance for: a teacher's classes from the schedule
  /// (`teacher_id`) plus their own `class_id`; a manager sees every class.
  Future<List<AttendanceClass>> classes() async {
    _requireWriter();
    final ids = <int>{};
    final names = <int, String>{};
    for (final c in await _all('classes')) {
      names[c.id] = _name(c.data, c.id, 'کلاس');
      if (role == 'manager') ids.add(c.id);
    }
    if (role == 'teacher') {
      for (final s in await engine.byRef('schedule', 'teacher_id', uid)) {
        final cid = _int(s.data['class_id']);
        if (cid != null && cid > 0) ids.add(cid);
      }
      final me = await engine.get('users', uid);
      final own = _int(me?.data['class_id']);
      if (own != null && own > 0) ids.add(own);
    }
    final out =
        [
          for (final id in ids)
            AttendanceClass(id: id, name: names[id] ?? 'کلاس $id'),
        ]..sort((a, b) {
          final c = a.name.compareTo(b.name);
          return c != 0 ? c : a.id.compareTo(b.id);
        });
    return out;
  }

  Future<void> _requireClass(int classId) async {
    if (!(await classes()).any((c) => c.id == classId)) {
      throw AttendanceFailure(AttendanceError.unknownClass, classId);
    }
  }

  /// Students of [classId] (role `student`, same `class_id`) with what is stored for [date].
  Future<List<RosterEntry>> roster(int classId, String date) async {
    _requireWriter();
    if (_parseDate(date) == null) {
      throw AttendanceFailure(AttendanceError.badDate, date);
    }
    await _requireClass(classId);
    // existing records of the day; with duplicates the lowest id wins (same rule as the web
    // client's dup-attendance repair in client/diag.js)
    final existing = <int, EngineRow>{};
    for (final a in await engine.byRef(collection, 'class_id', classId)) {
      final sid = _int(a.data['student_id']);
      if (sid == null || '${a.data['date']}' != date) continue;
      final prev = existing[sid];
      if (prev == null || a.id < prev.id) existing[sid] = a;
    }
    final out = <RosterEntry>[];
    for (final u in await engine.byRef('users', 'class_id', classId)) {
      if (u.data['role'] != 'student') continue;
      if (u.data['active'] == false || u.data['deleted'] == true) continue;
      final ex = existing[u.id];
      out.add(
        RosterEntry(
          studentId: u.id,
          name: _name(u.data, u.id, 'دانش‌آموز'),
          recorded: ex == null
              ? null
              : AttendanceStatus.fromWire(ex.data['status']),
          recordId: ex?.id,
          version: ex?.version ?? 0,
          note: '${ex?.data['note'] ?? ''}',
        ),
      );
    }
    out.sort((a, b) {
      final c = a.name.compareTo(b.name);
      return c != 0 ? c : a.studentId.compareTo(b.studentId);
    });
    return out;
  }

  /// True when at least one student of [classId] has a record for [date] (web badge
  /// «ثبت شده / ثبت نشده»).
  Future<bool> recorded(int classId, String date) async =>
      (await roster(classId, date)).any((r) => r.recorded != null);

  /// Ops of this record still on the device; each will raise the server version by one when
  /// it is applied, so a new edit is based on `version + queued` (never a self-conflict).
  int _queued(int id) => outbox
      .list()
      .where((o) => o.collection == collection && o.id == id)
      .length;

  /// Saves the day's attendance of [classId]. [marks] holds the statuses the teacher changed;
  /// every other student keeps the stored status or defaults to present. All checks run
  /// before the first write: a refused save writes nothing.
  Future<AttendanceSaveResult> save({
    required int classId,
    required String date,
    Map<int, AttendanceStatus> marks = const {},
  }) async {
    final list = await roster(classId, date);
    final inClass = {for (final r in list) r.studentId};
    for (final sid in marks.keys) {
      if (!inClass.contains(sid)) {
        throw AttendanceFailure(AttendanceError.notInClass, sid);
      }
    }
    final plan = <(RosterEntry, AttendanceStatus, int)>[];
    var unchanged = 0;
    for (final r in list) {
      final status =
          marks[r.studentId] ?? r.recorded ?? AttendanceStatus.present;
      if (r.recorded == status) {
        unchanged++;
        continue;
      }
      plan.add((r, status, r.recordId ?? recordId(r.studentId, date)));
    }
    final active = outbox
        .list()
        .where((o) => o.state != OpState.blocked)
        .length;
    if (active + plan.length > outbox.config.capacity) {
      // all-or-nothing: never queue half a class
      throw const SyncFailure('queue_full', code: PayeshErrorCode.queueFull);
    }
    final keys = <String>[];
    for (final (r, status, id) in plan) {
      final data = <String, Object?>{
        'id': id,
        'student_id': r.studentId,
        'class_id': classId,
        'date': date,
        'status': status.wire,
        'note': r.note,
        'source': 'teacher',
      };
      final base = r.version + _queued(id);
      final q = outbox.enqueue({
        'collection': collection,
        'type': 'put',
        'id': id,
        'data': data,
        'base_version': base,
      });
      if (!q.ok) {
        throw SyncFailure(q.error?.wire ?? 'queue_full', code: q.error);
      }
      // the local copy keeps the server version it is based on; the next pull replaces it
      await engine.put(collection, id, data, version: r.version);
      keys.add(q.k!);
    }
    return AttendanceSaveResult(
      written: keys.length,
      unchanged: unchanged,
      keys: keys,
    );
  }
}
