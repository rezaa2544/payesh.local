import 'package:flutter/foundation.dart';
import 'package:payesh_sync/payesh_sync.dart';

/// Where the grade data of the signed-in user comes from (row 74, wave 3). The production
/// source is the same encrypted local database + outbox + Gateway as attendance
/// (attendance_wiring.dart); tests pass an in-memory one.
abstract interface class GradeSource {
  /// The grade book for this user, or null when the device has no local database yet.
  Future<GradeBook?> gradeBookFor({required String role, required int uid});

  /// New ops were queued: send them soon (AutoSync.notifyEnqueued).
  void queued();

  /// Fires after local data changed (e.g. a pull finished); the open page re-reads.
  Listenable get changed;
}

/// State of the grade page: class list → (subject, term) sheet → save. Same flow as the web
/// client's `#/grades` page; saving never needs the network.
class GradesController extends ChangeNotifier {
  GradesController({
    required this.source,
    required this.role,
    required this.uid,
  }) {
    source.changed.addListener(_reload);
  }

  final GradeSource source;
  final String role;
  final int uid;

  GradeBook? _book;
  bool _disposed = false;

  bool loading = true;
  bool busy = false;
  String? error;
  String? notice;
  List<AttendanceClass> classes = const [];
  List<GradeSubject> subjects = const [];
  AttendanceClass? open;
  GradeSubject? subject;
  GradeTerm term = GradeTerm.first;
  List<GradeEntry> sheet = const [];

  /// Field text per student as typed (only fields the user touched).
  final Map<int, String> draft = {};

  /// Student whose field was refused by the last save (highlighted on the sheet).
  int? invalid;

  /// Text shown in a student's field: the draft, else the stored score.
  String valueOf(GradeEntry e) =>
      draft[e.studentId] ?? (e.score == null ? '' : '${e.score}');

  /// Fields whose text differs from what is stored (not yet validated).
  int get changes => sheet.where((e) {
    final d = draft[e.studentId];
    if (d == null || d.trim().isEmpty) return false;
    return d.trim() != (e.score == null ? '' : '${e.score}');
  }).length;

  void _emit() {
    if (!_disposed) notifyListeners();
  }

  Future<void> load() async {
    loading = true;
    error = null;
    _emit();
    try {
      final b = _book ??= await source.gradeBookFor(role: role, uid: uid);
      if (b == null) {
        error = 'پایگاه محلی هنوز آماده نیست';
      } else {
        classes = await b.classes();
        subjects = await b.subjects();
        if (open != null) await _loadSheet();
      }
    } on GradeFailure catch (e) {
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

  Future<void> _loadSheet() async {
    final s = subject;
    final c = open;
    if (s == null || c == null) {
      sheet = const [];
      return;
    }
    sheet = await _book!.sheet(classId: c.id, subjectId: s.id, term: term);
    draft.removeWhere((sid, _) => !sheet.any((e) => e.studentId == sid));
  }

  Future<void> _select(Future<void> Function() change) async {
    if (_book == null) return;
    notice = null;
    error = null;
    invalid = null;
    busy = true;
    _emit();
    try {
      await change();
      await _loadSheet();
    } on GradeFailure catch (e) {
      error = e.messageFa;
    }
    busy = false;
    _emit();
  }

  Future<void> openClass(AttendanceClass c) => _select(() async {
    open = c;
    draft.clear();
    subject = await _book!.defaultSubject(c.id);
  });

  Future<void> chooseSubject(GradeSubject s) => _select(() async {
    subject = s;
    draft.clear();
  });

  Future<void> chooseTerm(GradeTerm t) => _select(() async {
    term = t;
    draft.clear();
  });

  void closeClass() {
    open = null;
    sheet = const [];
    draft.clear();
    error = null;
    invalid = null;
    _emit();
  }

  void edit(int studentId, String text) {
    draft[studentId] = text;
    notice = null;
    if (invalid == studentId) invalid = null;
    _emit();
  }

  /// Writes the changed grades locally and queues them; the badge shows them until the Gateway
  /// confirms. Returns null when refused (the message is in [error]).
  Future<GradeSaveResult?> save() async {
    final b = _book;
    final c = open;
    final s = subject;
    if (b == null || c == null || s == null || busy) return null;
    busy = true;
    error = null;
    invalid = null;
    _emit();
    GradeSaveResult? res;
    try {
      res = await b.save(
        classId: c.id,
        subjectId: s.id,
        term: term,
        inputs: Map.of(draft),
      );
      draft.clear();
      notice = res.messageFa;
      if (res.written > 0) source.queued();
      await _loadSheet();
    } on GradeFailure catch (e) {
      error = e.messageFa;
      if (e.kind == GradeError.badScore && e.detail is int) {
        invalid = e.detail! as int;
        final who = sheet.where((x) => x.studentId == invalid);
        if (who.isNotEmpty) error = '${e.messageFa}: ${who.first.name}';
      }
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
