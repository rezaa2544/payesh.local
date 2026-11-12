import 'package:flutter/foundation.dart';
import 'package:payesh_sync/payesh_sync.dart';

/// Where the attendance data of the signed-in user comes from (row 74, wave 2). The production
/// source is the encrypted local database + outbox + Gateway (attendance_wiring.dart); tests
/// pass an in-memory one.
abstract interface class AttendanceSource {
  /// The book for this user, or null when the device has no local database yet.
  Future<AttendanceBook?> bookFor({required String role, required int uid});

  /// New ops were queued: send them soon (AutoSync.notifyEnqueued).
  void queued();

  /// Fires after local data changed (e.g. a pull finished); the open page re-reads.
  Listenable get changed;
}

/// State of the attendance page: class list → roster sheet → save. Same flow as the web
/// client's teacher home + `#/attendance/<class>` page; saving never needs the network.
class AttendanceController extends ChangeNotifier {
  AttendanceController({
    required this.source,
    required this.role,
    required this.uid,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now {
    source.changed.addListener(_reload);
  }

  final AttendanceSource source;
  final String role;
  final int uid;
  final DateTime Function() _now;

  AttendanceBook? _book;
  bool _disposed = false;

  bool loading = true;
  bool busy = false;
  String? error;
  String? notice;
  List<AttendanceClass> classes = const [];
  Map<int, bool> recorded = const {};
  AttendanceClass? open;
  List<RosterEntry> roster = const [];
  final Map<int, AttendanceStatus> draft = {};

  /// The day being recorded (web `todayISO()` rule: UTC calendar day).
  String get date => AttendanceBook.dateOf(_now());

  AttendanceStatus statusOf(RosterEntry r) =>
      draft[r.studentId] ?? r.recorded ?? AttendanceStatus.present;

  int get changes => roster.where((r) => statusOf(r) != r.recorded).length;

  void _emit() {
    if (!_disposed) notifyListeners();
  }

  Future<void> load() async {
    loading = true;
    error = null;
    _emit();
    try {
      final b = _book ??= await source.bookFor(role: role, uid: uid);
      if (b == null) {
        error = 'پایگاه محلی هنوز آماده نیست';
      } else {
        classes = await b.classes();
        final d = date;
        recorded = {for (final c in classes) c.id: await b.recorded(c.id, d)};
        if (open != null) await _loadRoster(open!.id);
      }
    } on AttendanceFailure catch (e) {
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

  Future<void> _loadRoster(int classId) async {
    roster = await _book!.roster(classId, date);
    draft.removeWhere((sid, _) => !roster.any((r) => r.studentId == sid));
  }

  Future<void> openClass(AttendanceClass c) async {
    final b = _book;
    if (b == null) return;
    open = c;
    draft.clear();
    notice = null;
    error = null;
    busy = true;
    _emit();
    try {
      await _loadRoster(c.id);
    } on AttendanceFailure catch (e) {
      error = e.messageFa;
      open = null;
    }
    busy = false;
    _emit();
  }

  void closeClass() {
    open = null;
    roster = const [];
    draft.clear();
    error = null;
    _emit();
  }

  void mark(int studentId, AttendanceStatus s) {
    draft[studentId] = s;
    notice = null;
    _emit();
  }

  /// Writes the changes locally and queues them; the badge shows them until the Gateway
  /// confirms. Returns null when refused (the message is in [error]).
  Future<AttendanceSaveResult?> save() async {
    final b = _book;
    final c = open;
    if (b == null || c == null || busy) return null;
    busy = true;
    error = null;
    _emit();
    AttendanceSaveResult? res;
    try {
      res = await b.save(classId: c.id, date: date, marks: Map.of(draft));
      draft.clear();
      notice = res.messageFa;
      if (res.written > 0) source.queued();
      await _loadRoster(c.id);
      recorded = {...recorded, c.id: roster.any((r) => r.recorded != null)};
    } on AttendanceFailure catch (e) {
      error = e.messageFa;
    } on SyncFailure catch (e) {
      error = e.code?.wire == 'queue_full'
          ? 'صف ارسال پر است — پیش از ثبت تازه، اتصال را برقرار کنید'
          : 'ذخیره ناموفق بود';
    }
    busy = false;
    _emit();
    return res;
  }

  @override
  void dispose() {
    _disposed = true;
    source.changed.removeListener(_reload);
    super.dispose();
  }
}
