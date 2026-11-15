// پشتیبان کامل دیتابیس مالک (ردیف ۱۵۵، ردیف ۱۶۲) — قالب و دو مقصد.
//
// قالب «محتوامحور» و افزایشی — یک پشتیبان اصلی و فقط تغییرها:
//   blobs/<sha[0:2]>/<sha>.gz   محتوای فشردهٔ هر فایل دیتابیس؛ هر محتوا فقط یک بار ذخیره می‌شود
//   snaps/<yyyyMMddTHHmmssZ>.json
//       • قدیمی‌ترین = «پشتیبان اصلی»: فهرست کامل (نام هر فایل ← [sha256, اندازه, زمان، ETag])؛
//       • هر دور بعدی فقط «تغییرها» نسبت به دور قبل: فایل‌های تازه/تغییرکرده + نام‌های پاک‌شده
//         (ردیف ۱۶۲؛ پیش از آن هر دور یک فهرست کامل ~۱ مگابایتی می‌ساخت).
// پس هر ۱۵ دقیقه فقط فایل‌های عوض‌شده خوانده و افزوده می‌شوند؛ هر لحظه با «پشتیبان اصلی +
// تغییرهای تا آن لحظه» کامل بازسازی می‌شود. نگه‌داری، دورهای کنار گذاشته را در دور بعدی ادغام
// می‌کند (هیچ لحظهٔ نگه‌داشته‌ای ناقص نمی‌شود) و فهرست‌های کامل قدیمی (قالب ۱) را به همین قالب
// فشرده می‌کند.
//
// مقصدها (هر دو همین قالب):
//   • دیسک همین سیستم  [DirBackupTarget]   — هر سیستم پنل مالک نسخهٔ کامل خودش را دارد؛
//   • خود دیتابیس     [BucketBackupTarget] — پیشوند جدای `payesh-owner-backup/` (با کلید روشن/خاموش).

import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

import '../local/s3_client.dart';

const String ownerBackupKind = 'payesh-owner-backup';

/// پیشوند پشتیبان روی دیتابیس؛ خودش هرگز در پشتیبان نمی‌آید.
const String bucketBackupRoot = 'payesh-owner-backup/';

/// بزرگ‌تر از این، خوانده نمی‌شود (گزارش می‌شود).
const int backupMaxObjectBytes = 256 << 20;

String sha256Hex(List<int> b) => sha256.convert(b).toString();

/// یک فایل در فهرست؛ [etag] اثر محتوای S3 برای تشخیص تغییرِ هم‌اندازه در همان ثانیه.
typedef BackupEntry = ({String sha, int size, int modifiedMs, String etag});

/// فهرست یک لحظه از کل دیتابیس.
final class BackupSnapshot {
  BackupSnapshot({
    required this.id,
    required this.at,
    required this.bucket,
    required this.objects,
    this.label = '',
  });

  /// همان نام فایل (`20261114T101500Z`).
  final String id;
  final DateTime at;
  final String bucket;
  final Map<String, BackupEntry> objects;

  /// مثلاً «پیش از بازیابی».
  final String label;

  int get count => objects.length;
  int get bytes => objects.values.fold(0, (a, e) => a + e.size);

  /// اثر انگشت محتوا (برای «تغییری نبود»).
  String get fingerprint {
    final keys = objects.keys.toList()..sort();
    return sha256Hex(
      utf8.encode([for (final k in keys) '$k=${objects[k]!.sha}'].join('\n')),
    );
  }

  static String idFor(DateTime t) {
    final u = t.toUtc();
    String two(int v) => v.toString().padLeft(2, '0');
    return '${u.year}${two(u.month)}${two(u.day)}T'
        '${two(u.hour)}${two(u.minute)}${two(u.second)}Z';
  }

  static final RegExp idRe = RegExp(r'^\d{8}T\d{6}Z$');

  Map<String, Object?> toJson() => {
    'v': 1,
    'kind': ownerBackupKind,
    'id': id,
    'at': at.toUtc().toIso8601String(),
    'bucket': bucket,
    'label': label,
    'count': count,
    'bytes': bytes,
    'objects': {for (final e in objects.entries) e.key: _entryJson(e.value)},
  };

  static BackupSnapshot? fromJson(Object? j) {
    if (j is! Map || j['v'] != 1 || j['kind'] != ownerBackupKind) return null;
    final id = '${j['id']}';
    final at = DateTime.tryParse('${j['at']}');
    final o = j['objects'];
    if (!idRe.hasMatch(id) || at == null || o is! Map) return null;
    final objects = <String, BackupEntry>{};
    for (final e in o.entries) {
      final v = _entryFrom(e.value);
      if (v == null) return null;
      objects['${e.key}'] = v;
    }
    return BackupSnapshot(
      id: id,
      at: at,
      bucket: '${j['bucket'] ?? ''}',
      objects: objects,
      label: '${j['label'] ?? ''}',
    );
  }
}

List<Object> _entryJson(BackupEntry e) => [e.sha, e.size, e.modifiedMs, e.etag];

final RegExp _shaRe = RegExp(r'^[0-9a-f]{64}$');

BackupEntry? _entryFrom(Object? v) {
  if (v is! List || v.length < 3) return null;
  final sha = '${v[0]}';
  if (!_shaRe.hasMatch(sha) || v[1] is! num || v[2] is! num) return null;
  return (
    sha: sha,
    size: (v[1] as num).toInt(),
    modifiedMs: (v[2] as num).toInt(),
    etag: v.length > 3 ? '${v[3]}' : '',
  );
}

/// ردیف ۱۶۲ — آنچه روی مقصد نوشته می‌شود: «پشتیبان اصلی» (کامل، [base] تهی) یا «تغییرها» نسبت به
/// فهرست [base]. [count]/[bytes] همیشه کل دیتابیسِ همان لحظه است و [fp] اثر انگشت کل آن لحظه
/// (برای «تغییری نبود» بی‌آنکه زنجیره خوانده شود).
final class BackupRecord {
  BackupRecord({
    required this.id,
    required this.at,
    required this.bucket,
    required this.changed,
    required this.count,
    required this.bytes,
    required this.fp,
    this.base,
    this.removed = const [],
    this.label = '',
    this.legacy = false,
  });

  final String id;
  final DateTime at;
  final String bucket;
  final String label;

  /// فهرست پیشین؛ null ⇒ همین «پشتیبان اصلی» (کامل) است.
  final String? base;

  /// پشتیبان اصلی: همهٔ فایل‌ها؛ تغییرها: فقط فایل‌های تازه یا تغییرکرده.
  final Map<String, BackupEntry> changed;

  /// نام فایل‌هایی که از لحظهٔ [base] به بعد پاک شده‌اند.
  final List<String> removed;
  final int count;
  final int bytes;
  final String fp;

  /// قالب ۱ (فهرست کامل هر دور) — نگه‌داری آن را به قالب تازه فشرده می‌کند.
  final bool legacy;

  bool get isMain => base == null;
  int get changedCount => changed.length;
  int get changedBytes => changed.values.fold(0, (a, e) => a + e.size);

  /// پشتیبان اصلی از یک لحظهٔ کامل.
  factory BackupRecord.main(BackupSnapshot s) => BackupRecord(
    id: s.id,
    at: s.at,
    bucket: s.bucket,
    label: s.label,
    changed: Map.of(s.objects),
    count: s.count,
    bytes: s.bytes,
    fp: s.fingerprint,
  );

  /// فقط تفاوت [next] با [parent].
  factory BackupRecord.delta(BackupSnapshot parent, BackupSnapshot next) {
    final changed = <String, BackupEntry>{};
    for (final e in next.objects.entries) {
      final p = parent.objects[e.key];
      if (p == null || p != e.value) changed[e.key] = e.value;
    }
    return BackupRecord(
      id: next.id,
      at: next.at,
      bucket: next.bucket,
      label: next.label,
      base: parent.id,
      changed: changed,
      removed: [
        for (final k in parent.objects.keys)
          if (!next.objects.containsKey(k)) k,
      ]..sort(),
      count: next.count,
      bytes: next.bytes,
      fp: next.fingerprint,
    );
  }

  /// وضع کامل این لحظه از وضع کامل [base].
  BackupSnapshot applyTo(BackupSnapshot? parent) {
    final o = isMain || parent == null
        ? <String, BackupEntry>{}
        : Map.of(parent.objects);
    for (final k in removed) {
      o.remove(k);
    }
    o.addAll(changed);
    return BackupSnapshot(
      id: id,
      at: at,
      bucket: bucket,
      objects: o,
      label: label,
    );
  }

  Map<String, Object?> toJson() => {
    'v': 2,
    'kind': ownerBackupKind,
    'id': id,
    'at': at.toUtc().toIso8601String(),
    'bucket': bucket,
    'label': label,
    'base': base,
    'count': count,
    'bytes': bytes,
    'fp': fp,
    'changed': {for (final e in changed.entries) e.key: _entryJson(e.value)},
    'removed': removed,
  };

  static BackupRecord? fromJson(Object? j) {
    if (j is! Map || j['kind'] != ownerBackupKind) return null;
    if (j['v'] == 1) {
      final s = BackupSnapshot.fromJson(j);
      if (s == null) return null;
      final r = BackupRecord.main(s);
      return BackupRecord(
        id: r.id,
        at: r.at,
        bucket: r.bucket,
        label: r.label,
        changed: r.changed,
        count: r.count,
        bytes: r.bytes,
        fp: r.fp,
        legacy: true,
      );
    }
    if (j['v'] != 2) return null;
    final id = '${j['id']}';
    final at = DateTime.tryParse('${j['at']}');
    final base = j['base'];
    final c = j['changed'];
    final r = j['removed'] ?? const <Object?>[];
    final fp = '${j['fp'] ?? ''}';
    if (!BackupSnapshot.idRe.hasMatch(id) ||
        at == null ||
        c is! Map ||
        r is! List ||
        !_shaRe.hasMatch(fp) ||
        (base != null &&
            (base is! String ||
                !BackupSnapshot.idRe.hasMatch(base) ||
                base.compareTo(id) >= 0))) {
      return null;
    }
    final changed = <String, BackupEntry>{};
    for (final e in c.entries) {
      final v = _entryFrom(e.value);
      if (v == null) return null;
      changed['${e.key}'] = v;
    }
    return BackupRecord(
      id: id,
      at: at,
      bucket: '${j['bucket'] ?? ''}',
      label: '${j['label'] ?? ''}',
      base: base as String?,
      changed: changed,
      removed: [for (final k in r) '$k'],
      count: (j['count'] as num?)?.toInt() ?? 0,
      bytes: (j['bytes'] as num?)?.toInt() ?? 0,
      fp: fp,
    );
  }
}

/// فشرده‌سازی محتوای هر فایل.
List<int> packBlob(List<int> raw) => gzip.encode(raw);
List<int> unpackBlob(List<int> packed) => gzip.decode(packed);

/// یک مقصد پشتیبان.
abstract interface class BackupTarget {
  /// «دیسک این سیستم» / «دیتابیس».
  String get id;
  String get titleFa;
  Future<bool> hasBlob(String sha);
  Future<void> putBlob(String sha, List<int> raw);

  /// محتوای خام؛ null اگر نباشد یا خراب باشد (sha نخواند).
  Future<List<int>?> getBlob(String sha);

  /// ردیف ۱۶۲: پشتیبان اصلی یا «تغییرها»؛ وضع کامل هر لحظه را [readState] می‌سازد.
  Future<void> putRecord(BackupRecord r);

  /// شناسهٔ فهرست‌ها، قدیمی‌ترین اول.
  Future<List<String>> listSnapshots();
  Future<BackupRecord?> getRecord(String id);
  Future<void> deleteSnapshot(String id);

  /// پاک کردن محتواهایی که هیچ فهرست نگه‌داشته‌ای به آن‌ها اشاره نمی‌کند؛ تعداد پاک‌شده.
  Future<int> gcBlobs(Set<String> keep);

  /// حجم اشغال‌شده (بایت، فشرده).
  Future<int> usedBytes();
}

List<int>? _verified(String sha, List<int>? packed) {
  if (packed == null) return null;
  try {
    final raw = unpackBlob(packed);
    return sha256Hex(raw) == sha ? raw : null;
  } on Object {
    return null;
  }
}

/// دیسک همین سیستم: `<پوشهٔ داده>/owner-backup/`.
final class DirBackupTarget implements BackupTarget {
  DirBackupTarget(this.root);
  final Directory root;

  @override
  String get id => 'disk';
  @override
  String get titleFa => 'دیسک این سیستم';

  File _blob(String sha) =>
      File('${root.path}/blobs/${sha.substring(0, 2)}/$sha.gz');
  File _snap(String id) => File('${root.path}/snaps/$id.json');

  @override
  Future<bool> hasBlob(String sha) => _blob(sha).exists();

  @override
  Future<void> putBlob(String sha, List<int> raw) async {
    final f = _blob(sha);
    await f.parent.create(recursive: true);
    // نوشتن اتمی: اول فایل موقت، بعد تغییر نام
    final tmp = File('${f.path}.tmp');
    await tmp.writeAsBytes(packBlob(raw), flush: true);
    await tmp.rename(f.path);
  }

  @override
  Future<List<int>?> getBlob(String sha) async {
    final f = _blob(sha);
    if (!await f.exists()) return null;
    return _verified(sha, await f.readAsBytes());
  }

  @override
  Future<void> putRecord(BackupRecord r) async {
    final f = _snap(r.id);
    await f.parent.create(recursive: true);
    final tmp = File('${f.path}.tmp');
    await tmp.writeAsString(jsonEncode(r.toJson()), flush: true);
    await tmp.rename(f.path);
  }

  @override
  Future<List<String>> listSnapshots() async {
    final d = Directory('${root.path}/snaps');
    if (!await d.exists()) return [];
    final out = <String>[];
    await for (final e in d.list()) {
      final n = e.uri.pathSegments.last;
      if (n.endsWith('.json')) {
        final id = n.substring(0, n.length - 5);
        if (BackupSnapshot.idRe.hasMatch(id)) out.add(id);
      }
    }
    return out..sort();
  }

  @override
  Future<BackupRecord?> getRecord(String id) async {
    if (!BackupSnapshot.idRe.hasMatch(id)) return null;
    final f = _snap(id);
    if (!await f.exists()) return null;
    try {
      return BackupRecord.fromJson(jsonDecode(await f.readAsString()));
    } on Object {
      return null;
    }
  }

  @override
  Future<void> deleteSnapshot(String id) async {
    if (!BackupSnapshot.idRe.hasMatch(id)) return;
    final f = _snap(id);
    if (await f.exists()) await f.delete();
  }

  @override
  Future<int> gcBlobs(Set<String> keep) async {
    final d = Directory('${root.path}/blobs');
    if (!await d.exists()) return 0;
    var n = 0;
    await for (final e in d.list(recursive: true)) {
      if (e is! File) continue;
      final name = e.uri.pathSegments.last;
      final sha = name.endsWith('.gz')
          ? name.substring(0, name.length - 3)
          : '';
      if (sha.isEmpty || !keep.contains(sha)) {
        await e.delete();
        n++;
      }
    }
    return n;
  }

  @override
  Future<int> usedBytes() async {
    if (!await root.exists()) return 0;
    var n = 0;
    await for (final e in root.list(recursive: true)) {
      if (e is File) n += await e.length();
    }
    return n;
  }
}

/// خود دیتابیس: پیشوند `payesh-owner-backup/` در همان صندوقچه.
final class BucketBackupTarget implements BackupTarget {
  BucketBackupTarget(this.s3, this.transport);
  final S3Settings s3;
  final S3Transport Function() transport;

  /// sha‌های موجود (یک بار فهرست، بعد در حافظه).
  Set<String>? _blobs;

  @override
  String get id => 'db';
  @override
  String get titleFa => 'دیتابیس';

  String _blobKey(String sha) =>
      '${bucketBackupRoot}blobs/${sha.substring(0, 2)}/$sha.gz';
  String _snapKey(String id) => '${bucketBackupRoot}snaps/$id.json';

  Future<T> _with<T>(Future<T> Function(S3Transport t) f) async {
    final t = transport();
    try {
      return await f(t);
    } finally {
      t.close();
    }
  }

  Future<Set<String>> _known() async {
    final k = _blobs;
    if (k != null) return k;
    final (objs, _) = await _with(
      (t) => s3ListObjects(s3, t, '${bucketBackupRoot}blobs/', maxPages: 500),
    );
    return _blobs = {
      for (final o in objs)
        if (o.key.endsWith('.gz'))
          o.key.substring(o.key.lastIndexOf('/') + 1, o.key.length - 3),
    };
  }

  @override
  Future<bool> hasBlob(String sha) async => (await _known()).contains(sha);

  @override
  Future<void> putBlob(String sha, List<int> raw) async {
    await _with((t) => s3PutBytes(s3, t, _blobKey(sha), packBlob(raw)));
    (await _known()).add(sha);
  }

  @override
  Future<List<int>?> getBlob(String sha) async =>
      _verified(sha, await _with((t) => s3GetBytes(s3, t, _blobKey(sha))));

  @override
  Future<void> putRecord(BackupRecord r) => _with(
    (t) => s3PutBytes(
      s3,
      t,
      _snapKey(r.id),
      utf8.encode(jsonEncode(r.toJson())),
      contentType: 'application/json',
    ),
  );

  @override
  Future<List<String>> listSnapshots() async {
    final (objs, _) = await _with(
      (t) => s3ListObjects(s3, t, '${bucketBackupRoot}snaps/', maxPages: 20),
    );
    return [
      for (final o in objs)
        if (o.key.endsWith('.json'))
          o.key.substring(o.key.lastIndexOf('/') + 1, o.key.length - 5),
    ].where(BackupSnapshot.idRe.hasMatch).toList()..sort();
  }

  @override
  Future<BackupRecord?> getRecord(String id) async {
    if (!BackupSnapshot.idRe.hasMatch(id)) return null;
    final b = await _with((t) => s3GetBytes(s3, t, _snapKey(id)));
    if (b == null) return null;
    try {
      return BackupRecord.fromJson(jsonDecode(utf8.decode(b)));
    } on Object {
      return null;
    }
  }

  @override
  Future<void> deleteSnapshot(String id) async {
    if (!BackupSnapshot.idRe.hasMatch(id)) return;
    await _with((t) => s3Delete(s3, t, _snapKey(id)));
  }

  @override
  Future<int> gcBlobs(Set<String> keep) async {
    final known = await _known();
    final drop = known.where((s) => !keep.contains(s)).toList();
    for (final sha in drop) {
      await _with((t) => s3Delete(s3, t, _blobKey(sha)));
      known.remove(sha);
    }
    return drop.length;
  }

  @override
  Future<int> usedBytes() async {
    final (objs, _) = await _with(
      (t) => s3ListObjects(s3, t, bucketBackupRoot, maxPages: 500),
    );
    return objs.fold<int>(0, (a, o) => a + o.size);
  }
}

/// نگه‌داری: همهٔ ۴۸ ساعت اخیر؛ سپس تازه‌ترینِ هر روز تا ۳۰ روز؛ سپس تازه‌ترینِ هر ماه تا ۱۲ ماه.
/// تازه‌ترین فهرست همیشه می‌ماند.
Set<String> backupKeep(List<String> ids, DateTime now) {
  DateTime? at(String id) => DateTime.tryParse(
    '${id.substring(0, 4)}-${id.substring(4, 6)}-${id.substring(6, 8)}T'
    '${id.substring(9, 11)}:${id.substring(11, 13)}:${id.substring(13, 15)}Z',
  );
  final sorted = [...ids]..sort();
  final keep = <String>{};
  if (sorted.isNotEmpty) keep.add(sorted.last);
  final day = <String, String>{};
  final month = <String, String>{};
  for (final id in sorted) {
    final t = at(id);
    if (t == null) continue;
    final age = now.toUtc().difference(t);
    if (age <= const Duration(hours: 48)) {
      keep.add(id);
    } else if (age <= const Duration(days: 30)) {
      day[id.substring(0, 8)] = id; // مرتب ⇒ آخری تازه‌ترین است
    } else if (age <= const Duration(days: 366)) {
      month[id.substring(0, 6)] = id;
    }
  }
  return keep
    ..addAll(day.values)
    ..addAll(month.values);
}

/// ردیف ۱۶۲ — وضع کامل لحظهٔ [id] = پشتیبان اصلی + تغییرهای تا آن لحظه؛ null اگر حلقه‌ای از
/// زنجیره نباشد یا خراب باشد. [known] (اگر داده شود) وضع کامل یک لحظهٔ میانی است تا از آنجا
/// ادامه یابد و زنجیره از اول خوانده نشود.
Future<BackupSnapshot?> readState(
  BackupTarget tg,
  String id, {
  BackupSnapshot? known,
  Map<String, BackupRecord>? cache,
}) async {
  final chain = <BackupRecord>[];
  String? cur = id;
  BackupSnapshot? start;
  while (cur != null) {
    if (known != null && known.id == cur) {
      start = known;
      break;
    }
    final r = cache?[cur] ?? await tg.getRecord(cur);
    if (r == null || chain.length > 5000) return null;
    chain.add(r);
    cur = r.base;
  }
  var state = start;
  for (final r in chain.reversed) {
    state = r.applyTo(state);
  }
  return state;
}
