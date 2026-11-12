// Row 128 — shared write path of the school-management waves (W6..W12).
//
// Every native page of row 128 (users, classes, schedule, follow-up, reports, …) reads the pulled
// local copy and writes through the SAME mechanics as the earlier waves (NoticeBoard, wave 4):
//   * the role gate mirrors server/policy.js `COLLECTIONS` exactly (fail-closed: an unknown
//     collection or role reads/writes nothing) — the server re-checks independently;
//   * the outbox op is queued BEFORE the local write (a full queue refuses with nothing written);
//   * `base_version` = stored version + ops of the same row still queued (optimistic concurrency
//     on the server, D‑28);
//   * one op is at most 64 KiB (server/tenancy.js `MAX_OP_BYTES`);
//   * new rows get a random id from a per-collection range inside [1e15, 3e15) — the servers take
//     client-chosen ids, and a collision answers with a version conflict (base 0), never a
//     silent overwrite.
// Nothing here talks to the network: writes work offline and AutoSync sends them later.
import 'dart:convert';
import 'dart:math';

import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_data/payesh_data.dart';

import 'outbox.dart';

/// Read/write roles of one collection (server/policy.js `COLLECTIONS`).
final class CollectionRule {
  const CollectionRule(this.writers, [this.readers]);
  final Set<String> writers;

  /// null = every role of `ROLES`.
  final Set<String>? readers;
}

/// Why a write or read was refused on the device (before anything is written).
base class RecordFailure implements Exception {
  const RecordFailure(this.code, this.messageFa, [this.detail]);

  /// Stable machine code (`not_allowed`, `not_reader`, `unknown`, `invalid`, `duplicate`,
  /// `too_large`, `confirm`, `in_use`, `offline`).
  final String code;
  final String messageFa;
  final Object? detail;

  @override
  String toString() =>
      'RecordFailure($code: $messageFa${detail == null ? '' : ' · $detail'})';
}

/// Result of one user action (may queue several ops, e.g. a student and its parent links).
final class RecordWrite {
  const RecordWrite(this.messageFa, {this.id, this.keys = const []});
  final String messageFa;
  final int? id;

  /// Outbox keys of the queued ops (empty = nothing changed).
  final List<String> keys;
  bool get queued => keys.isNotEmpty;
}

/// Local view of the school database for one signed-in user.
final class SchoolRecords {
  SchoolRecords({
    required this.engine,
    required this.outbox,
    required this.role,
    required this.uid,
    DateTime Function()? now,
    Random? random,
  }) : now = now ?? DateTime.now,
       _random = random ?? Random.secure();

  final DataEngine engine;
  final SqliteOutbox outbox;
  final String role;
  final int uid;
  final DateTime Function() now;
  final Random _random;

  /// server/policy.js `ROLES`.
  static const Set<String> roles = {
    'manager',
    'teacher',
    'parent',
    'student',
    'counselor',
    'guard',
  };

  /// server/policy.js `COLLECTIONS` (kept equal by test/records_test.dart, which parses
  /// policy.js).
  static const Map<String, CollectionRule> rules = {
    'schools': CollectionRule({'manager'}),
    'school_years': CollectionRule({'manager'}),
    'users': CollectionRule({'manager'}),
    'classes': CollectionRule({'manager'}),
    'subjects': CollectionRule({'manager'}),
    'lookups': CollectionRule({'manager'}),
    'schedule': CollectionRule({'manager'}),
    'bell_schedules': CollectionRule({'manager'}),
    'substitutions': CollectionRule({'manager'}),
    'attendance': CollectionRule({'manager', 'teacher'}),
    'grades': CollectionRule({'manager', 'teacher'}),
    'announcements': CollectionRule({'manager'}),
    'leaves': CollectionRule({'manager', 'teacher', 'parent', 'student'}),
    'parent_links': CollectionRule({'manager'}, {'manager', 'parent'}),
    'internships': CollectionRule({'manager', 'teacher'}),
    'staff_attendance': CollectionRule({'manager'}, {'manager'}),
    'staff_posts': CollectionRule({'manager'}, {'manager', 'teacher'}),
    'counselor_refs': CollectionRule(
      {'manager', 'counselor'},
      {'manager', 'counselor'},
    ),
    'counselor_notes': CollectionRule({'counselor', 'manager'}, {'counselor'}),
    'discipline': CollectionRule(
      {'manager', 'teacher', 'counselor'},
      {'manager', 'teacher', 'counselor', 'parent'},
    ),
    'homework': CollectionRule({'manager', 'teacher'}),
    'exams': CollectionRule({'manager'}),
    'calendar': CollectionRule({'manager'}),
    'app_settings': CollectionRule({'manager'}, {'manager'}),
    'import_issues': CollectionRule({'manager'}, {'manager'}),
    'conflicts': CollectionRule({}, {'manager'}),
  };

  /// Id ranges of rows created by row-128 pages: slot i = [1e15 + i·1e14, 1e15 + (i+1)·1e14).
  /// Disjoint from family (3e15..), attendance (4e15..), grades (5e15..) and notices (9e15..).
  static const List<String> idSlots = [
    'users',
    'parent_links',
    'classes',
    'subjects',
    'lookups',
    'schedule',
    'bell_schedules',
    'substitutions',
    'discipline',
    'import_issues',
    'app_settings',
  ];
  static const int idFloor = 1000000000000000;
  static const int idSlotSpan = 100000000000000;

  static int idBaseOf(String collection) {
    final i = idSlots.indexOf(collection);
    if (i < 0) throw ArgumentError('no id range for $collection');
    return idFloor + i * idSlotSpan;
  }

  /// Gateway per-op payload ceiling (server/tenancy.js `MAX_OP_BYTES`).
  static const int maxOpBytes = 64 * 1024;

  bool canRead(String collection) {
    final r = rules[collection];
    if (r == null || !roles.contains(role)) return false;
    return r.readers == null || r.readers!.contains(role);
  }

  bool canWrite(String collection) =>
      rules[collection]?.writers.contains(role) ?? false;

  void requireRead(String collection) {
    if (!canRead(collection)) {
      throw RecordFailure(
        'not_reader',
        'نقش شما به این بخش دسترسی ندارد',
        collection,
      );
    }
  }

  void requireWrite(String collection) {
    if (!canWrite(collection)) {
      throw RecordFailure(
        'not_allowed',
        'این کار برای نقش شما مجاز نیست',
        collection,
      );
    }
  }

  /// UTC day (web `todayISO()`).
  String today() => now().toUtc().toIso8601String().substring(0, 10);

  static int? asInt(Object? v) => switch (v) {
    final int i => i,
    final double d when d == d.truncateToDouble() => d.toInt(),
    final String s => int.tryParse(s.trim()),
    _ => null,
  };

  static String str(Object? v) => v == null ? '' : '$v'.trim();

  /// Every live row of [collection] (paged, tombstones skipped). Unreadable → refused.
  Future<List<EngineRow>> all(String collection) async {
    requireRead(collection);
    final out = <EngineRow>[];
    for (var off = 0; ; off += 500) {
      final page = await engine.list(collection, limit: 500, offset: off);
      out.addAll(page.where((r) => r.data['deleted'] != true));
      if (page.length < 500) return out;
    }
  }

  /// Like [all] but an unreadable collection reads as empty (for optional joins).
  Future<List<EngineRow>> allOrEmpty(String collection) =>
      canRead(collection) ? all(collection) : Future.value(const []);

  Future<EngineRow?> get(String collection, int id) async {
    requireRead(collection);
    final r = await engine.get(collection, id);
    return r == null || r.data['deleted'] == true ? null : r;
  }

  Future<EngineRow> existing(String collection, int id, String whatFa) async {
    final r = await get(collection, id);
    if (r == null) {
      throw RecordFailure(
        'unknown',
        '$whatFa پیدا نشد — صفحه را دوباره باز کنید',
        id,
      );
    }
    return r;
  }

  Set<int> queuedIds(String collection) => {
    for (final o in outbox.list())
      if (o.collection == collection && o.id != null) o.id!,
  };

  int _queued(String collection, int id) => outbox
      .list()
      .where((o) => o.collection == collection && o.id == id)
      .length;

  int _rand(int span) {
    final hi = _random.nextInt(1 << 32);
    final lo = _random.nextInt(1 << 32);
    return ((hi << 32) | lo) % span;
  }

  Future<int> newId(String collection) async {
    final base = idBaseOf(collection);
    var id = base + _rand(idSlotSpan);
    for (var i = 0; i < 8 && await engine.get(collection, id) != null; i++) {
      id = base + _rand(idSlotSpan);
    }
    return id;
  }

  Future<String> _enqueue(
    String collection,
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

  /// A user action that queues [ops] ops is refused up front when the queue cannot take them
  /// all (no half-done action: e.g. a student without its parent link).
  void requireRoom(int ops) {
    final free = outbox.stats().free;
    if (free < ops) {
      throw SyncFailure('queue_full', code: PayeshErrorCode.queueFull);
    }
  }

  /// Checks the role and the op size; nothing is written.
  void precheck(String collection, Map<String, Object?>? data) {
    requireWrite(collection);
    if (data != null) {
      final bytes = utf8.encode(jsonEncode(data)).length;
      if (bytes > maxOpBytes) {
        throw RecordFailure('too_large', 'این ردیف بیش از حد بزرگ است', bytes);
      }
    }
  }

  /// Fields a device never sends back: credentials (server/sync.js keeps the stored ones when
  /// they are absent — a stale copy would otherwise revert a password change) and the row
  /// version (sent as `base_version`).
  static const Set<String> neverSent = {
    '_version',
    'password_hash',
    'phone_hash',
    'password_enc',
    'password_plain',
    'password',
    '__password_verifier',
  };

  /// Creates ([prev] null, base 0) or replaces a row: outbox first, then the local copy.
  Future<String> put(
    String collection,
    int id,
    Map<String, Object?> data, {
    EngineRow? prev,
  }) async {
    final row = {
      for (final e in data.entries)
        if (!neverSent.contains(e.key)) e.key: e.value,
      'id': id,
    };
    precheck(collection, row);
    final base = prev == null ? 0 : prev.version + _queued(collection, id);
    final k = await _enqueue(collection, 'put', id, row, base);
    await engine.put(collection, id, row, version: prev?.version ?? 0);
    return k;
  }

  /// Deletes a stored row (the server keeps a tombstone; other devices drop it on pull).
  Future<String> del(String collection, EngineRow prev) async {
    precheck(collection, null);
    final k = await _enqueue(
      collection,
      'del',
      prev.id,
      null,
      prev.version + _queued(collection, prev.id),
    );
    await engine.del(collection, prev.id);
    return k;
  }

  /// Persian/Arabic digits → ASCII, everything else dropped (web `digitsOnly`).
  static String digitsOnly(Object? v) {
    final b = StringBuffer();
    for (final r in '${v ?? ''}'.runes) {
      if (r >= 0x30 && r <= 0x39) {
        b.writeCharCode(r);
      } else if (r >= 0x6F0 && r <= 0x6F9) {
        b.writeCharCode(0x30 + r - 0x6F0);
      } else if (r >= 0x660 && r <= 0x669) {
        b.writeCharCode(0x30 + r - 0x660);
      }
    }
    return b.toString();
  }

  /// Any mobile form → 11 digits `09…` (web `mobile11`).
  static String mobile11(Object? v) {
    var d = digitsOnly(v);
    if (d.isEmpty) return '';
    if (d.startsWith('0098')) {
      d = d.substring(4);
    } else if (d.startsWith('98') && d.length >= 12) {
      d = d.substring(2);
    }
    if (RegExp(r'^9\d{9}$').hasMatch(d)) return '0$d';
    if (RegExp(r'^989\d{9}$').hasMatch(d)) return '0${d.substring(2)}';
    return d;
  }
}
