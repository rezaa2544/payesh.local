// Row 197 (Q06 / F38, F44) — «درِ مدرسه»: the guard's day at the gate.
//
// Two things the guard really does: write down who comes in and when they leave (the visitor
// log, collection `visitors`), and know which students may walk out early today because the
// school approved their leave (collection `leaves`, status `approved`, today). The guard reads
// leaves only through this page: the server sends it the date, hours and state of each leave —
// never the reason or the (medical) certificate (server/policy.js `leaveForGate`).
import 'package:payesh_data/payesh_data.dart';

import 'records.dart';

/// One row of `visitors`.
final class VisitorRow {
  const VisitorRow({required this.row, required this.queued});
  final EngineRow row;

  /// Still in the outbox (not on the school server yet).
  final bool queued;

  int get id => row.id;
  String get name => SchoolRecords.str(row.data['name']);
  String get phone => SchoolRecords.str(row.data['phone']);
  String get reason => SchoolRecords.str(row.data['reason']);
  String get host => SchoolRecords.str(row.data['host']);
  String get date => SchoolRecords.str(row.data['date']);
  String get inAt => SchoolRecords.str(row.data['in_at']);
  String get outAt => SchoolRecords.str(row.data['out_at']);
  bool get inside => outAt.isEmpty;
}

/// A student with an approved leave for today (what the guard needs at the gate).
final class EarlyExit {
  const EarlyExit({
    required this.leaveId,
    required this.studentId,
    required this.student,
    required this.className,
    required this.hours,
    required this.timeFrom,
    required this.timeTo,
  });
  final int leaveId;
  final int? studentId;
  final String student;
  final String className;

  /// An hourly leave (the student leaves during the day); false = the whole day.
  final bool hours;
  final String timeFrom;
  final String timeTo;
}

/// Same rules as server/policy.js `visitorIssue` (null = fine).
String? visitorIssue(Map<String, Object?> row) {
  final name = SchoolRecords.str(row['name']);
  if (name.isEmpty || name.length > 80) return 'visitor_name';
  if (SchoolRecords.str(row['phone']).replaceAll(RegExp(r'\D'), '').length >
      15) {
    return 'visitor_phone';
  }
  if (SchoolRecords.str(row['reason']).length > 200 ||
      SchoolRecords.str(row['host']).length > 80) {
    return 'visitor_too_long';
  }
  if (!RegExp(r'^\d{4}-\d{2}-\d{2}$')
      .hasMatch(SchoolRecords.str(row['date']))) {
    return 'bad_date';
  }
  final at = DateTime.tryParse(SchoolRecords.str(row['in_at']));
  if (at == null) return 'bad_time';
  final o = SchoolRecords.str(row['out_at']);
  if (o.isNotEmpty) {
    final out = DateTime.tryParse(o);
    if (out == null || out.isBefore(at)) return 'bad_time';
  }
  return null;
}

const Map<String, String> visitorIssueFa = {
  'visitor_name': 'نام مراجع را بنویسید (حداکثر ۸۰ حرف)',
  'visitor_phone': 'شمارهٔ تماس درست نیست',
  'visitor_too_long': 'علت مراجعه یا نام شخص موردنظر بیش از حد بلند است',
  'bad_date': 'تاریخ درست نیست',
  'bad_time': 'ساعت خروج نمی‌تواند پیش از ورود باشد',
};

final class GateBook {
  GateBook(this.db);
  final SchoolRecords db;

  static const String visitors = 'visitors';

  /// Today's visitors: those still inside first, then the latest arrival.
  Future<List<VisitorRow>> today() async {
    final day = db.today();
    final q = db.queuedIds(visitors);
    final rows = [
      for (final r in await db.allOrEmpty(visitors))
        if (SchoolRecords.str(r.data['date']) == day)
          VisitorRow(row: r, queued: q.contains(r.id)),
    ];
    rows.sort((a, b) {
      if (a.inside != b.inside) return a.inside ? -1 : 1;
      return b.inAt.compareTo(a.inAt);
    });
    return rows;
  }

  /// Students with an approved leave covering today — hourly leaves (they walk out during the
  /// day) first by their hour, then whole-day leaves; by name inside each group.
  Future<List<EarlyExit>> earlyExits() async {
    final day = db.today();
    final users = await db.allOrEmpty('users');
    final names = {
      for (final u in users) u.id: SchoolRecords.str(u.data['name']),
    };
    final classOf = {
      for (final u in users) u.id: SchoolRecords.asInt(u.data['class_id']),
    };
    final classNames = {
      for (final c in await db.allOrEmpty('classes'))
        c.id: SchoolRecords.str(c.data['name']),
    };
    final out = <EarlyExit>[];
    for (final l in await db.allOrEmpty('leaves')) {
      final d = l.data;
      if (SchoolRecords.str(d['status']) != 'approved') continue;
      final from = SchoolRecords.str(d['date']);
      final hours = SchoolRecords.str(d['kind']) == 'hours';
      final to = hours ? from : SchoolRecords.str(d['date_to']);
      final covers =
          from == day ||
          (to.isNotEmpty && from.compareTo(day) <= 0 && to.compareTo(day) >= 0);
      if (!covers) continue;
      final sid = SchoolRecords.asInt(d['student_id']);
      out.add(
        EarlyExit(
          leaveId: l.id,
          studentId: sid,
          student: names[sid] ?? '',
          className: classNames[classOf[sid]] ?? '',
          hours: hours,
          timeFrom: hours ? SchoolRecords.str(d['time_from']) : '',
          timeTo: hours ? SchoolRecords.str(d['time_to']) : '',
        ),
      );
    }
    out.sort((a, b) {
      if (a.hours != b.hours) return a.hours ? -1 : 1;
      final t = a.timeFrom.compareTo(b.timeFrom);
      if (t != 0) return t;
      return a.student.compareTo(b.student);
    });
    return out;
  }

  /// «ثبت ورود»: a visitor comes in now.
  Future<RecordWrite> checkIn({
    required String name,
    String phone = '',
    String reason = '',
    String host = '',
  }) async {
    final now = db.now().toUtc();
    final data = <String, Object?>{
      'name': name.trim(),
      if (phone.trim().isNotEmpty) 'phone': phone.trim(),
      if (reason.trim().isNotEmpty) 'reason': reason.trim(),
      if (host.trim().isNotEmpty) 'host': host.trim(),
      'date': db.today(),
      'in_at': now.toIso8601String(),
      'by_id': db.uid,
    };
    final issue = visitorIssue(data);
    if (issue != null) {
      throw RecordFailure(issue, visitorIssueFa[issue] ?? issue, visitors);
    }
    final id = await db.newId(visitors);
    final k = await db.put(visitors, id, data);
    return RecordWrite('ورود ${data['name']} ثبت شد', id: id, keys: [k]);
  }

  /// «ثبت خروج»: the visitor leaves now.
  Future<RecordWrite> checkOut(VisitorRow v) async {
    final data = {
      ...v.row.data,
      'out_at': db.now().toUtc().toIso8601String(),
      'out_by': db.uid,
    };
    final issue = visitorIssue(data);
    if (issue != null) {
      throw RecordFailure(issue, visitorIssueFa[issue] ?? issue, visitors);
    }
    final k = await db.put(visitors, v.id, data, prev: v.row);
    return RecordWrite('خروج ${v.name} ثبت شد', id: v.id, keys: [k]);
  }
}
