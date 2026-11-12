import 'package:flutter/foundation.dart';
import 'package:payesh_sync/payesh_sync.dart';

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
  }) => _write(
    (b) => id == null
        ? b.publish(title: title, body: body, severity: severity)
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
