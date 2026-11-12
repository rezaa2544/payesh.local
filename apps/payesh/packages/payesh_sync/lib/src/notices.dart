// Row 74, wave 4 — native notices (announcements). Same semantics as the web client's
// `PAGES.announcements` + `actAnnAdd` / the `ann` form handler / `ann-delete` (client/pages.js,
// client/app.js), checked against the Gateway contract:
//   * every role reads (server/policy.js `announcements: { write: ['manager'], read: 'all' }`);
//     only a manager publishes, edits or deletes (a teacher/parent/student write is refused on
//     the device and, independently, by the Gateway with `role_denied`);
//   * newest first (`sortBy(date).reverse()`), the date is the UTC day (`todayISO`) and an edit
//     keeps the original date;
//   * title and body are required (trimmed, like the web form); severity is one of
//     normal / info / important (unknown stored values read as normal, like the web badge);
//   * an edit keeps the other stored fields (`Object.assign(existing, row)`), the author becomes
//     the editor (same as the web client);
//   * every write goes to the local database first and then to the durable outbox
//     (offline-first); the Gateway (`/api/gw/v1/push`) is the only cloud path (row 75 / D‑36).
import 'dart:convert';
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';

import 'outbox.dart';

/// Importance of a notice (web select «عادی / اطلاع‌رسانی / مهم»).
enum NoticeSeverity {
  normal('عادی'),
  info('اطلاع‌رسانی'),
  important('مهم');

  const NoticeSeverity(this.labelFa);
  final String labelFa;

  /// Value stored in the record (`severity`).
  String get wire => name;

  /// Unknown or missing values read as [normal] (web: anything else gets the plain badge).
  static NoticeSeverity fromWire(Object? v) {
    for (final s in values) {
      if (s.wire == v) return s;
    }
    return NoticeSeverity.normal;
  }
}

/// Why a notice action was refused on the device (before anything is written).
enum NoticeError {
  notAllowed,
  notReader,
  emptyTitle,
  emptyBody,
  tooLarge,
  unknownNotice;

  String get messageFa => switch (this) {
    NoticeError.notAllowed => 'انتشار و ویرایش اطلاعیه فقط برای مدیر مجاز است',
    NoticeError.notReader => 'نقش شما به اطلاعیه‌ها دسترسی ندارد',
    NoticeError.emptyTitle => 'عنوان اطلاعیه را بنویسید',
    NoticeError.emptyBody => 'متن اطلاعیه را بنویسید',
    NoticeError.tooLarge => 'متن اطلاعیه بیش از حد بلند است',
    NoticeError.unknownNotice =>
      'این اطلاعیه پیدا نشد — صفحه را دوباره باز کنید',
  };
}

final class NoticeFailure implements Exception {
  const NoticeFailure(this.kind, [this.detail]);
  final NoticeError kind;
  final Object? detail;
  String get messageFa => kind.messageFa;
  @override
  String toString() =>
      'NoticeFailure(${kind.name}${detail == null ? '' : ': $detail'})';
}

/// One stored notice as the page shows it.
final class Notice {
  const Notice({
    required this.id,
    required this.title,
    required this.body,
    required this.severity,
    required this.date,
    this.authorId,
    this.version = 0,
    this.queued = false,
  });
  final int id;
  final String title;
  final String body;
  final NoticeSeverity severity;

  /// ISO day (`YYYY-MM-DD`), shown as Jalali.
  final String date;
  final int? authorId;
  final int version;

  /// A change of this notice is still in the outbox (not yet confirmed by the Gateway).
  final bool queued;
}

/// Result of a publish / edit / delete.
final class NoticeWriteResult {
  const NoticeWriteResult({required this.id, this.key, required this.action});
  final int id;

  /// Outbox idempotency key of the queued op; null when nothing changed.
  final String? key;
  final NoticeAction action;

  String get messageFa => switch (action) {
    NoticeAction.published => 'اطلاعیه منتشر شد',
    NoticeAction.edited => 'اطلاعیه ویرایش شد',
    NoticeAction.deleted => 'اطلاعیه حذف شد',
    NoticeAction.unchanged => 'تغییری نبود',
  };
}

enum NoticeAction { published, edited, deleted, unchanged }

/// Notices on the device. Reads the pulled local copy and writes through [outbox]; nothing
/// here talks to the network.
final class NoticeBoard {
  NoticeBoard({
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

  static const String collection = 'announcements';

  /// Roles that may read (server/policy.js `ROLES`, `read: 'all'`). Unknown roles read nothing.
  static const Set<String> readers = {
    'manager',
    'teacher',
    'parent',
    'student',
    'counselor',
    'guard',
  };

  /// Roles that may write (server/policy.js `COLLECTIONS.announcements.write`).
  static const Set<String> writers = {'manager'};

  /// Gateway per-op payload ceiling (server/tenancy.js `MAX_OP_BYTES`).
  static const int maxOpBytes = 64 * 1024;

  bool get canRead => readers.contains(role);
  bool get canWrite => writers.contains(role);

  /// Reserved id range for notices created by the native client. The Gateway takes
  /// client-chosen positive ids (no temp-id remap) and a notice has no natural key, so the id
  /// is random in [idBase, idBase + idSpan): above the grade range (5e15..9e15), below 2^53
  /// (safe for the JavaScript server). A collision cannot overwrite silently: a new notice is
  /// sent with base version 0, so an existing record answers with a version conflict.
  static const int idBase = 9000000000000000;
  static const int idSpan = 7199254740991; // idBase + idSpan == 2^53 - 1

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

  Future<List<EngineRow>> _all() async {
    final out = <EngineRow>[];
    for (var off = 0; ; off += 500) {
      final page = await engine.list(collection, limit: 500, offset: off);
      out.addAll(page);
      if (page.length < 500) return out;
    }
  }

  Set<int> _queuedIds() => {
    for (final o in outbox.list())
      if (o.collection == collection && o.id != null) o.id!,
  };

  int _queued(int id) => outbox
      .list()
      .where((o) => o.collection == collection && o.id == id)
      .length;

  Notice _of(EngineRow r, Set<int> queued) => Notice(
    id: r.id,
    title: '${r.data['title'] ?? ''}',
    body: '${r.data['body'] ?? ''}',
    severity: NoticeSeverity.fromWire(r.data['severity']),
    date: '${r.data['date'] ?? ''}',
    authorId: _int(r.data['author_id']),
    version: r.version,
    queued: queued.contains(r.id),
  );

  /// Every notice, newest first (date descending; same date: higher id first).
  Future<List<Notice>> list() async {
    if (!canRead) throw NoticeFailure(NoticeError.notReader, role);
    final queued = _queuedIds();
    final out = [
      for (final r in await _all())
        if (r.data['deleted'] != true) _of(r, queued),
    ];
    out.sort((a, b) {
      final c = b.date.compareTo(a.date);
      return c != 0 ? c : b.id.compareTo(a.id);
    });
    return out;
  }

  void _requireWriter() {
    if (!canWrite) throw NoticeFailure(NoticeError.notAllowed, role);
  }

  (String, String) _clean(String title, String body) {
    final t = title.trim();
    final b = body.trim();
    if (t.isEmpty) throw const NoticeFailure(NoticeError.emptyTitle);
    if (b.isEmpty) throw const NoticeFailure(NoticeError.emptyBody);
    return (t, b);
  }

  void _requireSize(Map<String, Object?> data) {
    final bytes = utf8.encode(jsonEncode(data)).length;
    if (bytes > maxOpBytes) {
      throw NoticeFailure(NoticeError.tooLarge, bytes);
    }
  }

  Future<String> _enqueue(
    String type,
    int id,
    Map<String, Object?>? data,
    int base,
  ) async {
    final q = outbox.enqueue({
      'collection': collection,
      'type': type,
      'id': id,
      'data': ?data,
      'base_version': base,
    });
    // a full queue refuses here, before the local write (all-or-nothing for one op)
    if (!q.ok) throw SyncFailure(q.error?.wire ?? 'queue_full', code: q.error);
    return q.k!;
  }

  /// Publishes a new notice dated today. Every check runs before anything is written.
  Future<NoticeWriteResult> publish({
    required String title,
    required String body,
    NoticeSeverity severity = NoticeSeverity.normal,
  }) async {
    _requireWriter();
    final (t, b) = _clean(title, body);
    var id = _newId();
    for (var i = 0; i < 8 && await engine.get(collection, id) != null; i++) {
      id = _newId();
    }
    final data = <String, Object?>{
      'id': id,
      'title': t,
      'body': b,
      'severity': severity.wire,
      'date': today(),
      'author_id': uid,
    };
    _requireSize(data);
    final k = await _enqueue('put', id, data, 0);
    await engine.put(collection, id, data, version: 0);
    return NoticeWriteResult(id: id, key: k, action: NoticeAction.published);
  }

  Future<EngineRow> _existing(int id) async {
    final r = await engine.get(collection, id);
    if (r == null || r.data['deleted'] == true) {
      throw NoticeFailure(NoticeError.unknownNotice, id);
    }
    return r;
  }

  /// Edits a stored notice: keeps its date and the other stored fields; an unchanged notice
  /// is not written again.
  Future<NoticeWriteResult> edit({
    required int id,
    required String title,
    required String body,
    required NoticeSeverity severity,
  }) async {
    _requireWriter();
    final (t, b) = _clean(title, body);
    final r = await _existing(id);
    final cur = _of(r, const {});
    if (cur.title == t &&
        cur.body == b &&
        '${r.data['severity'] ?? ''}' == severity.wire) {
      return NoticeWriteResult(id: id, action: NoticeAction.unchanged);
    }
    final stored = '${r.data['date'] ?? ''}';
    final data = <String, Object?>{
      ...r.data,
      'id': id,
      'title': t,
      'body': b,
      'severity': severity.wire,
      'date': stored.isEmpty ? today() : stored,
      'author_id': uid,
    };
    _requireSize(data);
    final k = await _enqueue('put', id, data, r.version + _queued(id));
    await engine.put(collection, id, data, version: r.version);
    return NoticeWriteResult(id: id, key: k, action: NoticeAction.edited);
  }

  /// Deletes a stored notice (the Gateway records a tombstone; other devices drop it on pull).
  Future<NoticeWriteResult> delete(int id) async {
    _requireWriter();
    final r = await _existing(id);
    final k = await _enqueue('del', id, null, r.version + _queued(id));
    await engine.del(collection, id);
    return NoticeWriteResult(id: id, key: k, action: NoticeAction.deleted);
  }
}
