// Row 74, wave 3 — native grade entry (teacher / manager). Same semantics as the web client's
// `PAGES.grades` + `actGradeSave` (client/pages.js), checked against the Gateway contract:
//   * the sheet is one (class, subject, term); roster = users with role `student` and the same
//     `class_id` (inactive students hidden);
//   * a score is 0..20 (Persian digits accepted); an empty field is skipped, an unchanged score
//     is skipped;
//   * a teacher's grade is `pending`, a manager's `approved` — approval belongs to the manager
//     (server/policy.js, and since this wave also the Gateway: `approval_denied`);
//   * a workshop subject stores `kind: practical` + `practical_score`, any other `midterm`;
//   * every write goes to the local database first and then to the durable outbox
//     (offline-first); the Gateway (`/api/gw/v1/push`) is the only cloud path (row 75 / D‑36).
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_data/payesh_data.dart';

import 'attendance.dart';
import 'outbox.dart';

/// The three terms of the web client's grade page (stored as the same Persian text in `term`).
enum GradeTerm {
  first('نوبت اول'),
  second('نوبت دوم'),
  finalTerm('پایانی');

  const GradeTerm(this.wire);

  /// Value stored in the record (`term`) — also the label.
  final String wire;

  static GradeTerm? fromWire(Object? v) {
    for (final t in values) {
      if (t.wire == v) return t;
    }
    return null;
  }
}

/// Review state of a stored grade (web badge «تأییدشده / در انتظار / جدید»).
enum GradeState {
  fresh('جدید'),
  pending('در انتظار'),
  approved('تأییدشده');

  const GradeState(this.labelFa);
  final String labelFa;
}

/// Why a grade action was refused on the device (before anything is written).
enum GradeError {
  notAllowed,
  unknownClass,
  unknownSubject,
  notInClass,
  badScore;

  String get messageFa => switch (this) {
    GradeError.notAllowed => 'ثبت نمره فقط برای معلم و مدیر مجاز است',
    GradeError.unknownClass => 'این کلاس در فهرست کلاس‌های شما نیست',
    GradeError.unknownSubject => 'این درس در فهرست درس‌ها نیست',
    GradeError.notInClass => 'این دانش‌آموز در فهرست این کلاس نیست',
    GradeError.badScore => 'نمرهٔ نامعتبر برای یکی از دانش‌آموزان',
  };
}

final class GradeFailure implements Exception {
  const GradeFailure(this.kind, [this.detail]);
  final GradeError kind;

  /// For [GradeError.badScore]: the student id whose field is invalid.
  final Object? detail;
  String get messageFa => kind.messageFa;
  @override
  String toString() =>
      'GradeFailure(${kind.name}${detail == null ? '' : ': $detail'})';
}

final class GradeSubject {
  const GradeSubject({
    required this.id,
    required this.name,
    this.workshop = false,
  });
  final int id;
  final String name;

  /// Workshop subject: the score is the practical score (web «درس کارگاهی — نمرهٔ عملی»).
  final bool workshop;
}

/// One student of the sheet with what is stored for (class, subject, term).
final class GradeEntry {
  const GradeEntry({
    required this.studentId,
    required this.name,
    this.score,
    this.recordId,
    this.version = 0,
    this.state = GradeState.fresh,
  });
  final int studentId;
  final String name;

  /// Stored score (`practical_score` when present, else `score`), or null.
  final num? score;
  final int? recordId;
  final int version;
  final GradeState state;
}

final class GradeSaveResult {
  const GradeSaveResult({
    required this.written,
    required this.unchanged,
    required this.keys,
  });

  /// Grades written locally and queued for the Gateway.
  final int written;

  /// Filled fields skipped because the stored score is the same.
  final int unchanged;

  /// Outbox idempotency keys of the queued ops (one per written grade).
  final List<String> keys;

  /// Same message as the web toast.
  String get messageFa =>
      written == 0 ? 'تغییری نبود' : '$written نمره ذخیره شد';
}

/// Grade entry on the device. Reads the pulled local copy (users, classes, schedule, subjects,
/// grades) and writes through [outbox]; nothing here talks to the network.
final class GradeBook {
  GradeBook({
    required this.engine,
    required this.outbox,
    required this.role,
    required this.uid,
  });

  final DataEngine engine;
  final SqliteOutbox outbox;
  final String role;
  final int uid;

  static const String collection = 'grades';

  /// Roles that may write grades (server/policy.js `COLLECTIONS.grades.write`).
  static const Set<String> writers = {'manager', 'teacher'};

  bool get canWrite => writers.contains(role);

  /// Status a new or edited grade is written with: only a manager approves.
  String get writeStatus => role == 'manager' ? 'approved' : 'pending';

  static final RegExp _score = RegExp(r'^\d{1,3}(\.\d{1,3})?$');

  /// Web `norm()` + `Number()` for a score field: Persian/Arabic digits are accepted (and the
  /// Persian decimal separator «٫»); empty → null (skipped); anything else that is not a
  /// plain decimal in 0..20 is refused. Stricter than `Number()` on purpose (no `0x10`, `1e1`).
  static num? parseScore(String raw, {int studentId = 0}) {
    final s = raw
        .trim()
        .replaceAllMapped(
          RegExp('[۰-۹]'),
          (m) => '${m[0]!.codeUnitAt(0) - 0x06F0}',
        )
        .replaceAllMapped(
          RegExp('[٠-٩]'),
          (m) => '${m[0]!.codeUnitAt(0) - 0x0660}',
        )
        .replaceAll('٫', '.');
    if (s.isEmpty) return null;
    if (!_score.hasMatch(s)) {
      throw GradeFailure(GradeError.badScore, studentId);
    }
    final v = double.parse(s);
    if (v < 0 || v > 20) throw GradeFailure(GradeError.badScore, studentId);
    return v == v.truncateToDouble() ? v.toInt() : v;
  }

  /// Reserved id range for grades created by the native client: the Gateway takes client-chosen
  /// positive ids (no temp-id remap), so the id is derived from (class, subject, term,
  /// student). Two devices entering the same grade write the SAME record: the second one meets
  /// a version conflict and goes to human review (D‑28) instead of creating a duplicate. A hash
  /// collision cannot overwrite silently either (base version 0 ≠ stored version ⇒ conflict).
  /// Range [idBase, idBase + idSpan) stays below 2^53 (safe for the JavaScript server).
  static const int idBase = 5000000000000000;
  static const int idSpan = 4000000000000000;

  static int recordId({
    required int classId,
    required int subjectId,
    required GradeTerm term,
    required int studentId,
  }) {
    final key = 'payesh-grade-v1|$classId|$subjectId|${term.wire}|$studentId';
    final h = sha256.convert(utf8.encode(key)).bytes;
    var v = 0;
    for (var i = 0; i < 7; i++) {
      v = (v << 8) | h[i]; // 56 bits: never negative in a 64-bit int
    }
    return idBase + v % idSpan;
  }

  static int? _int(Object? v) => switch (v) {
    final int i => i,
    final double d when d == d.truncateToDouble() => d.toInt(),
    final String s => int.tryParse(s.trim()),
    _ => null,
  };

  static num? _num(Object? v) => switch (v) {
    final num n => n,
    final String s => num.tryParse(s.trim()),
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
    if (!canWrite) throw GradeFailure(GradeError.notAllowed, role);
  }

  /// Same class rule as attendance (and as `server/scope.js`): a teacher's schedule classes
  /// plus their own class; a manager sees every class.
  Future<List<AttendanceClass>> classes() async {
    _requireWriter();
    return AttendanceBook(
      engine: engine,
      outbox: outbox,
      role: role,
      uid: uid,
    ).classes();
  }

  /// Every subject, sorted by name (the web page lists all subjects).
  Future<List<GradeSubject>> subjects() async {
    _requireWriter();
    final out =
        [
          for (final s in await _all('subjects'))
            if (s.data['deleted'] != true)
              GradeSubject(
                id: s.id,
                name: _name(s.data, s.id, 'درس'),
                workshop: s.data['workshop'] == true,
              ),
        ]..sort((a, b) {
          final c = a.name.compareTo(b.name);
          return c != 0 ? c : a.id.compareTo(b.id);
        });
    return out;
  }

  /// Web default: the subject of the class's first schedule row, else the first subject.
  Future<GradeSubject?> defaultSubject(int classId) async {
    final all = await subjects();
    if (all.isEmpty) return null;
    final rows = await engine.byRef('schedule', 'class_id', classId);
    for (final r in rows) {
      final sid = _int(r.data['subject_id']);
      for (final s in all) {
        if (s.id == sid) return s;
      }
    }
    return all.first;
  }

  Future<GradeSubject> _requireSubject(int subjectId) async {
    for (final s in await subjects()) {
      if (s.id == subjectId) return s;
    }
    throw GradeFailure(GradeError.unknownSubject, subjectId);
  }

  Future<void> _requireClass(int classId) async {
    if (!(await classes()).any((c) => c.id == classId)) {
      throw GradeFailure(GradeError.unknownClass, classId);
    }
  }

  /// Students of [classId] with what is stored for ([subjectId], [term]).
  Future<List<GradeEntry>> sheet({
    required int classId,
    required int subjectId,
    required GradeTerm term,
  }) async {
    _requireWriter();
    await _requireClass(classId);
    await _requireSubject(subjectId);
    // existing grades of the sheet; with duplicates the lowest id wins
    final existing = <int, EngineRow>{};
    for (final g in await engine.byRef(collection, 'class_id', classId)) {
      final sid = _int(g.data['student_id']);
      if (sid == null || _int(g.data['subject_id']) != subjectId) continue;
      if ('${g.data['term']}' != term.wire) continue;
      final prev = existing[sid];
      if (prev == null || g.id < prev.id) existing[sid] = g;
    }
    final out = <GradeEntry>[];
    for (final u in await engine.byRef('users', 'class_id', classId)) {
      if (u.data['role'] != 'student') continue;
      if (u.data['active'] == false || u.data['deleted'] == true) continue;
      final ex = existing[u.id];
      out.add(
        GradeEntry(
          studentId: u.id,
          name: _name(u.data, u.id, 'دانش‌آموز'),
          score: ex == null
              ? null
              : _num(ex.data['practical_score']) ?? _num(ex.data['score']),
          recordId: ex?.id,
          version: ex?.version ?? 0,
          state: ex == null
              ? GradeState.fresh
              : ex.data['status'] == 'approved'
              ? GradeState.approved
              : GradeState.pending,
        ),
      );
    }
    out.sort((a, b) {
      final c = a.name.compareTo(b.name);
      return c != 0 ? c : a.studentId.compareTo(b.studentId);
    });
    return out;
  }

  int _queued(int id) => outbox
      .list()
      .where((o) => o.collection == collection && o.id == id)
      .length;

  /// Saves the filled fields of one sheet. [inputs] maps student id → raw field text. Every
  /// check (role, class, subject, student, every score, queue room) runs before the first
  /// write: one invalid field refuses the whole save and nothing is written. (The web client
  /// skips the invalid field with a toast and saves the rest; the device never half-saves.)
  Future<GradeSaveResult> save({
    required int classId,
    required int subjectId,
    required GradeTerm term,
    required Map<int, String> inputs,
  }) async {
    final subject = await _requireSubject(subjectId);
    final list = await sheet(
      classId: classId,
      subjectId: subjectId,
      term: term,
    );
    final byStudent = {for (final e in list) e.studentId: e};
    for (final sid in inputs.keys) {
      if (!byStudent.containsKey(sid)) {
        throw GradeFailure(GradeError.notInClass, sid);
      }
    }
    final plan = <(GradeEntry, num, int)>[];
    var unchanged = 0;
    for (final e in list) {
      final raw = inputs[e.studentId];
      if (raw == null) continue;
      final score = parseScore(raw, studentId: e.studentId);
      if (score == null) continue;
      if (e.score != null && e.score! == score) {
        unchanged++;
        continue;
      }
      plan.add((
        e,
        score,
        e.recordId ??
            recordId(
              classId: classId,
              subjectId: subjectId,
              term: term,
              studentId: e.studentId,
            ),
      ));
    }
    final active = outbox
        .list()
        .where((o) => o.state != OpState.blocked)
        .length;
    if (active + plan.length > outbox.config.capacity) {
      // all-or-nothing: never queue half a sheet
      throw const SyncFailure('queue_full', code: PayeshErrorCode.queueFull);
    }
    final keys = <String>[];
    for (final (e, score, id) in plan) {
      final data = <String, Object?>{
        'id': id,
        'student_id': e.studentId,
        'class_id': classId,
        'subject_id': subjectId,
        'term': term.wire,
        'kind': subject.workshop ? 'practical' : 'midterm',
        'score': score,
        'status': writeStatus,
        if (subject.workshop) 'practical_score': score,
      };
      final base = e.version + _queued(id);
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
      await engine.put(collection, id, data, version: e.version);
      keys.add(q.k!);
    }
    return GradeSaveResult(
      written: keys.length,
      unchanged: unchanged,
      keys: keys,
    );
  }
}
