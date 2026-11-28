import 'package:flutter/foundation.dart';
import 'package:payesh_data/payesh_data.dart' show EngineRow;
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

/// Where the notices of the signed-in user come from (row 74, wave 4). The production source is
/// the same encrypted local database + outbox + Gateway as attendance and grades
/// (attendance_wiring.dart); tests pass an in-memory one.
abstract interface class NoticeSource {
  /// The notice board for this user, or null when the device has no local database yet.
  Future<NoticeBoard?> noticeBoardFor({required String role, required int uid});

  /// New ops were queued: send them soon (AutoSync.notifyEnqueued).
  void queued();

  /// Fires after local data changed (e.g. a pull finished); the open page re-reads.
  Listenable get changed;
}

/// State of the notices page: the list (every role) and, for a manager, publish / edit /
/// delete. Same flow as the web client's `#/announcements`; writing never needs the network.
class NoticesController extends ChangeNotifier {
  NoticesController({
    required this.source,
    required this.role,
    required this.uid,
  }) {
    source.changed.addListener(_reload);
  }

  final NoticeSource source;
  final String role;
  final int uid;

  NoticeBoard? _board;
  bool _disposed = false;

  bool loading = true;
  bool busy = false;
  String? error;
  String? notice;
  List<Notice> notices = const [];

  /// Error of the last publish/edit attempt (shown inside the editor, which stays open).
  String? formError;

  bool get canWrite => NoticeBoard.writers.contains(role);

  /// Row 197 (F19): school-wide notices and days off are the manager's; a teacher writes only
  /// class notices for their own classes and changes only their own.
  bool get canWriteSchool => role == 'manager';
  bool canChange(Notice n) =>
      role == 'manager' || (role == 'teacher' && n.authorId == uid);

  /// The classes a teacher may address (empty for the manager, who may also pick one).
  List<EngineRow> classes = const [];
  String className(int? id) {
    for (final c in classes) {
      if (c.id == id) return SchoolRecords.str(c.data['name']);
    }
    return '';
  }

  /// Row 197 Q10: upcoming days off (manager list) and today's / tomorrow's (everyone's banner).
  List<DayOff> daysOff = const [];
  DayOff? todayOff;
  DayOff? tomorrowOff;

  /// Error of the last «اعلام تعطیلی» attempt (shown in its form).
  String? dayOffError;

  /// The day the controller treats as today (tests pin it).
  DateTime Function() now = DateTime.now;

  // UTC day, like SchoolRecords.today() and the web client's todayISO()
  String _iso(DateTime t) => _ymd(t.toUtc());
  String _ymd(DateTime t) =>
      '${t.year.toString().padLeft(4, '0')}-${t.month.toString().padLeft(2, '0')}-${t.day.toString().padLeft(2, '0')}';
  String get today => _iso(now());
  String get tomorrow => _iso(now().add(const Duration(days: 1)));

  SchoolRecords? _records(NoticeBoard b) =>
      SchoolRecords(engine: b.engine, outbox: b.outbox, role: role, uid: uid);

  Future<void> _loadDays(NoticeBoard b) async {
    final db = _records(b)!;
    todayOff = await dayOffOn(db, today);
    tomorrowOff = await dayOffOn(db, tomorrow);
    daysOff = canWriteSchool
        ? await SchoolCalendar(db).upcoming(today)
        : const [];
    classes = canWrite ? await ClassNotes(db).myClasses() : const [];
  }

  /// Announces a day off (calendar row + important notice + internal exams moved). Returns
  /// null when refused (message in [dayOffError]).
  Future<DayOffResult?> announceDayOff({
    required String date,
    required DayOffKind kind,
    required String reason,
    String? examsTo,
    bool notify = true,
  }) async {
    final b = _board;
    if (b == null || busy) return null;
    busy = true;
    dayOffError = null;
    notice = null;
    _emit();
    DayOffResult? res;
    try {
      res = await SchoolCalendar(_records(b)!).announce(
        date: date,
        kind: kind,
        reason: reason,
        examsTo: examsTo,
        notify: notify,
        today: today,
        jdate: (iso) => faDigits(JalaliDate.fromIso(iso)?.slash ?? iso),
      );
      notice = '${kind.labelFa} ${res.messageFa}';
      source.queued();
      notices = await b.list();
      await _loadDays(b);
    } on RecordFailure catch (e) {
      dayOffError = e.messageFa;
    } on SyncFailure catch (e) {
      dayOffError = _syncMessage(e);
    }
    busy = false;
    _emit();
    return res;
  }

  /// Cancels an announced day off (the notice already went out and stays).
  Future<void> cancelDayOff(int id) async {
    final b = _board;
    if (b == null || busy) return;
    busy = true;
    error = null;
    _emit();
    try {
      await SchoolCalendar(_records(b)!).cancel(id);
      notice = 'اعلام تعطیلی لغو شد';
      source.queued();
      await _loadDays(b);
    } on RecordFailure catch (e) {
      error = e.messageFa;
    } on SyncFailure catch (e) {
      error = _syncMessage(e);
    }
    busy = false;
    _emit();
  }

  void _emit() {
    if (!_disposed) notifyListeners();
  }

  Future<void> load() async {
    loading = true;
    error = null;
    _emit();
    try {
      final b = _board ??= await source.noticeBoardFor(role: role, uid: uid);
      if (b == null) {
        error = 'پایگاه محلی هنوز آماده نیست';
      } else {
        notices = await b.list();
        await _loadDays(b);
      }
    } on NoticeFailure catch (e) {
      error = e.messageFa;
    } on Object {
      error = 'خواندن دادهٔ محلی ناموفق بود';
    }
    loading = false;
    _emit();
  }

  void _reload() {
    if (!busy && !_disposed) load();
  }

  String _syncMessage(SyncFailure e) => e.code?.wire == 'queue_full'
      ? 'صف ارسال پر است — پیش از ثبت تازه، اتصال را برقرار کنید'
      : 'ذخیره ناموفق بود';

  Future<NoticeWriteResult?> _write(
    Future<NoticeWriteResult> Function(NoticeBoard b) op, {
    required bool form,
  }) async {
    final b = _board;
    if (b == null || busy) return null;
    busy = true;
    error = null;
    formError = null;
    notice = null;
    _emit();
    NoticeWriteResult? res;
    try {
      res = await op(b);
      notice = res.messageFa;
      if (res.key != null) source.queued();
      notices = await b.list();
    } on NoticeFailure catch (e) {
      if (form) {
        formError = e.messageFa;
      } else {
        error = e.messageFa;
      }
    } on SyncFailure catch (e) {
      if (form) {
        formError = _syncMessage(e);
      } else {
        error = _syncMessage(e);
      }
    }
    busy = false;
    _emit();
    return res;
  }

  /// Publishes (when [id] is null) or edits. Returns null when refused (message in
  /// [formError]); the editor stays open with the text the user typed.
  Future<NoticeWriteResult?> submit({
    int? id,
    required String title,
    required String body,
    required NoticeSeverity severity,
    int? classId,
  }) => _write(
    (b) => id == null
        ? b.publish(
            title: title,
            body: body,
            severity: severity,
            classId: classId,
          )
        : b.edit(id: id, title: title, body: body, severity: severity),
    form: true,
  );

  Future<NoticeWriteResult?> delete(int id) =>
      _write((b) => b.delete(id), form: false);

  /// The editor was closed without saving: forget its error.
  void clearForm() {
    formError = null;
    _emit();
  }

  @override
  void dispose() {
    _disposed = true;
    source.changed.removeListener(_reload);
    super.dispose();
  }
}
