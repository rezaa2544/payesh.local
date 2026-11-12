import 'package:flutter/foundation.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

/// Where the parents pages of the signed-in user come from (row 74, wave 5). The production
/// source is the same encrypted local database + outbox + Gateway as attendance, grades and
/// notices (attendance_wiring.dart); tests pass an in-memory one.
abstract interface class FamilySource {
  /// The parents book for this user, or null when the device has no local database yet.
  Future<FamilyBook?> familyBookFor({required String role, required int uid});

  /// New ops were queued: send them soon (AutoSync.notifyEnqueued).
  void queued();

  /// Fires after local data changed (e.g. a pull finished); the open page re-reads.
  Listenable get changed;
}

/// Parses the Jalali day typed in the leave form (`۱۴۰۵/۰۸/۲۱`, `1405-8-21`, …) to ISO; null
/// when it is not a real day (e.g. ۱۴۰۵/۰۷/۳۱ — the seventh month has 30 days).
String? jalaliToIso(String text) {
  final j = JalaliDate.parse(text);
  if (j == null) return null;
  final iso = j.toIso();
  final back = JalaliDate.fromIso(iso);
  if (back == null ||
      back.year != j.year ||
      back.month != j.month ||
      back.day != j.day) {
    return null;
  }
  return iso;
}

/// State of the parents pages: the children (home), one child page, and the leave requests
/// with the request form. Same flow as the web client's `#/home` (parent), `#/child/<id>` and
/// `#/leaves`; sending a request never needs the network.
class FamilyController extends ChangeNotifier {
  FamilyController({
    required this.source,
    required this.role,
    required this.uid,
  }) {
    source.changed.addListener(_reload);
  }

  final FamilySource source;
  final String role;
  final int uid;

  FamilyBook? _book;
  bool _disposed = false;

  bool loading = true;
  bool busy = false;
  String? error;
  String? notice;
  List<ChildSummary> children = const [];
  List<LeaveRequest> leaves = const [];

  /// The open child page (null when none is open or it could not be read).
  ChildRecord? child;
  int? _childId;
  String? childError;

  /// Error of the last request attempt (shown inside the form, which stays open).
  String? formError;

  /// Today's (UTC) day in Jalali digits — the default of the request form (web: `todayISO()`).
  String get todayJalali =>
      JalaliDate.fromIso(_book?.today())?.formatShort() ?? '';

  void _emit() {
    if (!_disposed) notifyListeners();
  }

  Future<FamilyBook?> _ready() async =>
      _book ??= await source.familyBookFor(role: role, uid: uid);

  Future<void> load() async {
    loading = true;
    error = null;
    _emit();
    try {
      final b = await _ready();
      if (b == null) {
        error = 'پایگاه محلی هنوز آماده نیست';
      } else {
        children = await b.children();
        leaves = await b.leaveRequests();
        if (_childId != null) child = await b.child(_childId!);
      }
    } on FamilyFailure catch (e) {
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

  /// Opens the page of a linked child; any other id is refused (no fallback child).
  Future<void> openChild(int id) async {
    _childId = id;
    child = null;
    childError = null;
    _emit();
    try {
      final b = await _ready();
      if (b == null) {
        childError = 'پایگاه محلی هنوز آماده نیست';
      } else {
        child = await b.child(id);
      }
    } on FamilyFailure catch (e) {
      childError = e.messageFa;
    } on Object {
      childError = 'خواندن دادهٔ محلی ناموفق بود';
    }
    _emit();
  }

  void closeChild() {
    _childId = null;
    child = null;
    childError = null;
  }

  /// Sends a leave request. Returns null when refused (message in [formError]); the form
  /// stays open with what the user typed.
  Future<LeaveWriteResult?> requestLeave({
    required int? studentId,
    required String jalaliDay,
    required String reason,
  }) async {
    final b = _book;
    if (b == null || busy) return null;
    formError = null;
    notice = null;
    if (studentId == null) {
      formError = 'دانش‌آموز را انتخاب کنید';
      _emit();
      return null;
    }
    final iso = jalaliToIso(jalaliDay);
    if (iso == null) {
      formError = FamilyError.badDate.messageFa;
      _emit();
      return null;
    }
    busy = true;
    _emit();
    LeaveWriteResult? res;
    try {
      res = await b.requestLeave(
        studentId: studentId,
        date: iso,
        reason: reason,
      );
      notice = res.messageFa;
      source.queued();
      leaves = await b.leaveRequests();
    } on FamilyFailure catch (e) {
      formError = e.messageFa;
    } on SyncFailure catch (e) {
      formError = e.code?.wire == 'queue_full'
          ? 'صف ارسال پر است — پیش از ثبت تازه، اتصال را برقرار کنید'
          : 'ذخیره ناموفق بود';
    }
    busy = false;
    _emit();
    return res;
  }

  /// The form was closed without sending: forget its error.
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
