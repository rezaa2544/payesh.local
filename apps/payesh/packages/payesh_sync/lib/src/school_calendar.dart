// Row 197 (Q10 / F36) — a sudden day off: the school is closed («تعطیل») or teaches remotely
// («غیرحضوری») — air pollution, an energy shortage, an epidemic; usually announced the evening
// before. Web twin: client/pages.js `dayOffOf` / `dayOffCard` + client/app.js form `dayoff`;
// server twin: server/school-calendar.js.
//
//   calendar { date: YYYY-MM-DD, kind: closed | remote, reason, exams_to?: YYYY-MM-DD }
//
// The real effect:
//   * no absence that day — attendance refuses «غایب/تأخیر» for that date (the server answers
//     `day_off`); a closed day takes no attendance at all, a remote day only «حاضر/موجه»;
//   * parents are told — an «important» notice goes to everyone with the reason;
//   * exams move — the internal exams of that day go to `exams_to`; a national (نهایی) exam
//     is not the school's to move and is only reported.
import 'records.dart';

/// Kind of a day off.
enum DayOffKind {
  closed('تعطیل'),
  remote('غیرحضوری');

  const DayOffKind(this.labelFa);
  final String labelFa;

  static DayOffKind? fromWire(Object? v) {
    for (final k in values) {
      if (k.name == v) return k;
    }
    return null;
  }
}

/// One announced day off.
final class DayOff {
  const DayOff({
    required this.id,
    required this.date,
    required this.kind,
    required this.reason,
    this.examsTo,
  });
  final int id;
  final String date;
  final DayOffKind kind;
  final String reason;
  final String? examsTo;

  static DayOff? of(int id, Map<String, Object?> d) {
    final k = DayOffKind.fromWire(d['kind']);
    final date = isoDay(d['date']);
    if (k == null || date == null) return null;
    final to = SchoolRecords.str(d['exams_to']);
    return DayOff(
      id: id,
      date: date,
      kind: k,
      reason: SchoolRecords.str(d['reason']),
      examsTo: to.isEmpty ? null : to,
    );
  }
}

/// `YYYY-MM-DD` when [v] is a real calendar day, else null.
String? isoDay(Object? v) {
  final s = '${v ?? ''}';
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(s);
  if (m == null) return null;
  final y = int.parse(m[1]!), mo = int.parse(m[2]!), d = int.parse(m[3]!);
  final t = DateTime.utc(y, mo, d);
  return t.year == y && t.month == mo && t.day == d ? s : null;
}

/// Shape of a calendar row; null when valid (server/school-calendar.js `dayOffIssue`).
String? dayOffIssue(Map<String, Object?> row) {
  final date = isoDay(row['date']);
  if (date == null) return 'bad_date';
  if (DayOffKind.fromWire(row['kind']) == null) return 'bad_kind';
  final reason = SchoolRecords.str(row['reason']);
  if (reason.isEmpty) return 'reason_required';
  if (reason.length > 300) return 'reason_too_long';
  final to = SchoolRecords.str(row['exams_to']);
  if (to.isNotEmpty) {
    final t = isoDay(to);
    if (t == null) return 'bad_date';
    if (t.compareTo(date) <= 0) return 'bad_range';
  }
  return null;
}

/// The day off of [date], or null.
Future<DayOff?> dayOffOn(SchoolRecords db, String date) async {
  for (final r in await db.allOrEmpty('calendar')) {
    final d = DayOff.of(r.id, r.data);
    if (d != null && d.date == date) return d;
  }
  return null;
}

/// What announcing a day off did.
final class DayOffResult {
  const DayOffResult({
    required this.id,
    required this.moved,
    required this.national,
    required this.noticeId,
  });
  final int id;

  /// Internal exams moved to `exams_to`.
  final int moved;

  /// National exams on that day (not moved — the office decides).
  final int national;

  /// The notice sent to everyone, or null when [notify] was off.
  final int? noticeId;

  String get messageFa =>
      'ثبت شد'
      '${moved > 0 ? ' · ${_fa(moved)} امتحان منتقل شد' : ''}'
      '${national > 0 ? ' · ${_fa(national)} امتحان نهایی جابه‌جا نمی‌شود (با اداره هماهنگ کنید)' : ''}';
}

String _fa(int n) =>
    '$n'.replaceAllMapped(RegExp(r'\d'), (m) => '۰۱۲۳۴۵۶۷۸۹'[int.parse(m[0]!)]);

/// Manager actions on the calendar (same records as the web).
final class SchoolCalendar {
  SchoolCalendar(this.db);
  final SchoolRecords db;

  /// Upcoming days off (today on), by date.
  Future<List<DayOff>> upcoming(String today) async {
    final out = <DayOff>[
      for (final r in await db.allOrEmpty('calendar'))
        if (DayOff.of(r.id, r.data) case final d?
            when d.date.compareTo(today) >= 0)
          d,
    ];
    out.sort((a, b) => a.date.compareTo(b.date));
    return out;
  }

  /// Announces [date] as [kind]: the calendar row, the notice to everyone (when [notify]) and
  /// the internal exams of that day moved to [examsTo].
  Future<DayOffResult> announce({
    required String date,
    required DayOffKind kind,
    required String reason,
    String? examsTo,
    bool notify = true,
    required String today,
    required String Function(String iso) jdate,
  }) async {
    final row = <String, Object?>{
      'date': date,
      'kind': kind.name,
      'reason': reason.trim(),
      'exams_to': (examsTo ?? '').isEmpty ? null : examsTo,
      'created_by': db.uid,
    };
    final issue = dayOffIssue(row);
    if (issue != null) {
      throw RecordFailure('invalid', switch (issue) {
        'bad_date' => 'روز را درست انتخاب کنید',
        'reason_required' => 'علت را بنویسید',
        'reason_too_long' => 'علت بیش از حد بلند است',
        'bad_range' => 'روز تازهٔ امتحان باید بعد از روز تعطیل باشد',
        _ => 'نوع را انتخاب کنید',
      });
    }
    if (await dayOffOn(db, date) != null) {
      throw const RecordFailure('invalid', 'برای این روز قبلاً اعلام شده است');
    }
    final id = await db.newId('calendar');
    await db.put('calendar', id, row);
    var moved = 0, national = 0;
    for (final ex in await db.allOrEmpty('exams')) {
      if (SchoolRecords.str(ex.data['date']) != date) continue;
      if (SchoolRecords.str(ex.data['kind']) == 'national') {
        national++;
        continue;
      }
      if (row['exams_to'] == null) continue;
      await db.put('exams', ex.id, {
        ...ex.data,
        'date': examsTo,
        'moved_from': date,
      }, prev: ex);
      moved++;
    }
    int? noticeId;
    if (notify) {
      noticeId = await db.newId('announcements');
      await db.put('announcements', noticeId, {
        'title': '${kind.labelFa} — ${jdate(date)}',
        'body':
            '${reason.trim()}\n'
            '${kind == DayOffKind.closed ? 'مدرسه در این روز تعطیل است.' : 'کلاس‌ها در این روز به‌صورت غیرحضوری (مجازی) برگزار می‌شود.'}'
            '${moved > 0 ? '\nامتحان‌های این روز به ${jdate(examsTo!)} منتقل شد.' : ''}',
        'severity': 'important',
        'date': today,
        'kind': 'day_off',
        'day': date,
        'author_id': db.uid,
      });
    }
    return DayOffResult(
      id: id,
      moved: moved,
      national: national,
      noticeId: noticeId,
    );
  }

  /// Cancels a day off (the notice stays — it was sent).
  Future<String> cancel(int id) async {
    final prev = await db.existing('calendar', id, 'این روز');
    return db.del('calendar', prev);
  }
}
