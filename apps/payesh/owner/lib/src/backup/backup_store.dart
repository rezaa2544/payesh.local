// پشتیبان کامل دیتابیس مالک — ردیف ۱۵۵، ردیف ۱۶۲، و ردیف ۱۶۶: «یک فایل جامع».
//
// ردیف ۱۶۶ (درخواست مالک): به‌جای فهرست بلندِ پشتیبان‌های ۱۵ دقیقه‌ای، همیشه فقط یک فایل پشتیبان
// جامع روی هر مقصد هست و هر تغییر در همان فایل ادغام می‌شود:
//   payesh-owner-backup.zip
//     payesh-backup.json   فهرست کامل (نام هر فایل دیتابیس ← [sha256, اندازه, زمان، ETag]) + زمان،
//                          صندوقچه، تعداد و حجم
//     data/<نام فایل>      محتوای هر فایل دیتابیس (ZIP معمولی؛ با ویندوز هم باز می‌شود)
// هر دور فقط فایل‌های تازه/تغییرکرده از دیتابیس خوانده می‌شوند؛ بقیه از همان فایل پشتیبان برداشته
// می‌شوند، فایل‌های پاک‌شده کنار می‌روند و فایل تازه به‌صورت اتمی جای فایل قبلی را می‌گیرد (روی دیسک:
// فایل موقت ← تغییر نام؛ روی دیتابیس: یک PUT روی همان کلید). اگر چیزی عوض نشده باشد، چیزی نوشته
// نمی‌شود.
//
// مقصدها (هر دو همین یک فایل):
//   • دیسک همین سیستم  [DirBackupTarget]   `<پوشهٔ داده>/owner-backup/payesh-owner-backup.zip`
//   • خود دیتابیس     [BucketBackupTarget] `payesh-owner-backup/payesh-owner-backup.zip`
// هر دو با «حذف» پاک می‌شوند. قالب قدیمی (blobs/ و snaps/ ردیف ۱۵۵–۱۶۲) پس از نخستین نوشتن موفق
// فایل جامع روی همان مقصد پاک می‌شود.

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import '../local/s3_client.dart';
import 'backup_zip.dart';

const String ownerBackupKind = 'payesh-owner-backup';

/// پیشوند پشتیبان روی دیتابیس؛ خودش هرگز در پشتیبان نمی‌آید.
const String bucketBackupRoot = 'payesh-owner-backup/';

/// نام همان یک فایل.
const String backupFileName = 'payesh-owner-backup.zip';

/// فهرست داخل فایل.
const String backupManifestName = 'payesh-backup.json';

/// بزرگ‌تر از این، خوانده نمی‌شود (گزارش می‌شود).
const int backupMaxObjectBytes = 256 << 20;

String sha256Hex(List<int> b) => sha256.convert(b).toString();

/// یک فایل در فهرست؛ [etag] اثر محتوای S3 برای تشخیص تغییرِ هم‌اندازه در همان ثانیه.
typedef BackupEntry = ({String sha, int size, int modifiedMs, String etag});

/// فهرست کامل دیتابیس در یک لحظه.
final class BackupSnapshot {
  BackupSnapshot({
    required this.at,
    required this.bucket,
    required this.objects,
  });

  final DateTime at;
  final String bucket;
  final Map<String, BackupEntry> objects;

  int get count => objects.length;
  int get bytes => objects.values.fold(0, (a, e) => a + e.size);

  /// اثر انگشت محتوا و صندوقچه (برای «تغییری نبود»؛ پس از انتقال، صندوقچهٔ تازه هم تغییر است).
  String get fingerprint {
    final keys = objects.keys.toList()..sort();
    return sha256Hex(
      utf8.encode(
        [bucket, for (final k in keys) '$k=${objects[k]!.sha}'].join('\n'),
      ),
    );
  }

  /// شناسهٔ نمایشی زمان (`20261114T101500Z`).
  static String idFor(DateTime t) {
    final u = t.toUtc();
    String two(int v) => v.toString().padLeft(2, '0');
    return '${u.year}${two(u.month)}${two(u.day)}T'
        '${two(u.hour)}${two(u.minute)}${two(u.second)}Z';
  }

  Map<String, Object?> toJson() => {
    'v': 3,
    'kind': ownerBackupKind,
    'at': at.toUtc().toIso8601String(),
    'bucket': bucket,
    'count': count,
    'bytes': bytes,
    'fp': fingerprint,
    'objects': {
      for (final e in objects.entries)
        e.key: [e.value.sha, e.value.size, e.value.modifiedMs, e.value.etag],
    },
  };

  static final RegExp _shaRe = RegExp(r'^[0-9a-f]{64}$');

  static BackupSnapshot? fromJson(Object? j) {
    if (j is! Map || j['v'] != 3 || j['kind'] != ownerBackupKind) return null;
    final at = DateTime.tryParse('${j['at']}');
    final o = j['objects'];
    if (at == null || o is! Map) return null;
    final objects = <String, BackupEntry>{};
    for (final e in o.entries) {
      final v = e.value;
      if (v is! List || v.length < 3) return null;
      final sha = '${v[0]}';
      if (!_shaRe.hasMatch(sha) || v[1] is! num || v[2] is! num) return null;
      objects['${e.key}'] = (
        sha: sha,
        size: (v[1] as num).toInt(),
        modifiedMs: (v[2] as num).toInt(),
        etag: v.length > 3 ? '${v[3]}' : '',
      );
    }
    return BackupSnapshot(
      at: at,
      bucket: '${j['bucket'] ?? ''}',
      objects: objects,
    );
  }
}

/// همان یک فایل، باز شده: فهرست + دسترسی به محتوای هر فایل (با بازبینی sha256).
final class BackupArchive {
  BackupArchive._(this.snapshot, this._zip, this.size);

  final BackupSnapshot snapshot;
  final ZipReader _zip;

  /// حجم خود فایل پشتیبان (فشرده).
  final int size;

  static String dataName(String key) => 'data/$key';

  /// null ⇒ فایل پشتیبان نیست یا خراب است.
  static BackupArchive? parse(Uint8List bytes) {
    final z = ZipReader.parse(bytes);
    if (z == null) return null;
    final m = z.read(backupManifestName);
    if (m == null) return null;
    try {
      final s = BackupSnapshot.fromJson(jsonDecode(utf8.decode(m)));
      return s == null ? null : BackupArchive._(s, z, bytes.length);
    } on Object {
      return null;
    }
  }

  /// محتوای خام [key]؛ null اگر نباشد یا خراب باشد.
  List<int>? content(String key) {
    final e = snapshot.objects[key];
    if (e == null) return null;
    final raw = _zip.read(dataName(key));
    return raw != null && sha256Hex(raw) == e.sha ? raw : null;
  }

  /// فایل تازه از فهرست [s] و محتوای هر فایل.
  static Uint8List build(
    BackupSnapshot s,
    List<int> Function(String key) contentOf,
  ) {
    final w = ZipWriter();
    final keys = s.objects.keys.toList()..sort();
    for (final k in keys) {
      final e = s.objects[k]!;
      w.add(
        dataName(k),
        contentOf(k),
        at: DateTime.fromMillisecondsSinceEpoch(
          e.modifiedMs > 0 ? e.modifiedMs : s.at.millisecondsSinceEpoch,
        ),
      );
    }
    w.add(
      backupManifestName,
      utf8.encode(const JsonEncoder.withIndent(' ').convert(s.toJson())),
      at: s.at,
    );
    return w.finish();
  }
}

/// آنچه صفحه از هر نسخه نشان می‌دهد.
typedef BackupFileInfo = ({
  String target,
  DateTime at,
  int count,
  int bytes,
  int size,
  String bucket,
  String fp,
});

BackupFileInfo infoOf(String target, BackupArchive a) => (
  target: target,
  at: a.snapshot.at,
  count: a.snapshot.count,
  bytes: a.snapshot.bytes,
  size: a.size,
  bucket: a.snapshot.bucket,
  fp: a.snapshot.fingerprint,
);

/// یک مقصد پشتیبان: همیشه فقط یک فایل.
abstract interface class BackupTarget {
  /// `disk` / `db`.
  String get id;
  String get titleFa;

  /// بایت‌های فایل؛ null اگر نباشد.
  Future<Uint8List?> read();

  /// جایگزینی اتمی فایل (و پاک کردن قالب قدیمی همین مقصد).
  Future<void> write(Uint8List bytes);

  /// پاک کردن فایل پشتیبان (و هر چه از قالب قدیمی مانده)؛ true اگر چیزی پاک شد.
  Future<bool> delete();

  /// نشانی کوتاه برای نمایش.
  String get whereFa;
}

/// دیسک همین سیستم: `<پوشهٔ داده>/owner-backup/payesh-owner-backup.zip`.
final class DirBackupTarget implements BackupTarget {
  DirBackupTarget(this.root);
  final Directory root;

  @override
  String get id => 'disk';
  @override
  String get titleFa => 'دیسک این سیستم';

  File get file => File('${root.path}${Platform.pathSeparator}$backupFileName');

  @override
  String get whereFa => file.path;

  @override
  Future<Uint8List?> read() async {
    final f = file;
    return await f.exists() ? await f.readAsBytes() : null;
  }

  @override
  Future<void> write(Uint8List bytes) async {
    await root.create(recursive: true);
    final f = file;
    final tmp = File('${f.path}.tmp');
    await tmp.writeAsBytes(bytes, flush: true);
    await tmp.rename(f.path);
    await _dropLegacy();
  }

  Future<bool> _dropLegacy() async {
    var any = false;
    for (final n in ['blobs', 'snaps']) {
      final d = Directory('${root.path}/$n');
      if (await d.exists()) {
        await d.delete(recursive: true);
        any = true;
      }
    }
    return any;
  }

  @override
  Future<bool> delete() async {
    var any = await _dropLegacy();
    for (final f in [file, File('${file.path}.tmp')]) {
      if (await f.exists()) {
        await f.delete();
        any = true;
      }
    }
    return any;
  }
}

/// خود دیتابیس: `payesh-owner-backup/payesh-owner-backup.zip` در همان صندوقچه.
final class BucketBackupTarget implements BackupTarget {
  BucketBackupTarget(this.s3, this.transport, {this.retry});
  final S3Settings s3;
  final S3Transport Function() transport;

  /// تلاش دوباره برای هر گام نوشتن (هر تکه جدا)؛ null ⇒ یک بار.
  final Future<void> Function(Future<void> Function() step)? retry;

  static const String key = '$bucketBackupRoot$backupFileName';

  @override
  String get id => 'db';
  @override
  String get titleFa => 'دیتابیس';
  @override
  String get whereFa => '${s3.bucket}/$key';

  Future<T> _with<T>(Future<T> Function(S3Transport t) f) async {
    final t = transport();
    try {
      return await f(t);
    } finally {
      t.close();
    }
  }

  @override
  Future<Uint8List?> read() async {
    final b = await _with((t) => s3GetBytes(s3, t, key));
    return b == null ? null : Uint8List.fromList(b);
  }

  /// فایل روی دیتابیس هست؟ (اندازه و ETag، بی‌آنکه خوانده شود.)
  Future<S3Object?> head() async {
    final (objs, _) = await _with(
      (t) => s3ListObjects(s3, t, bucketBackupRoot, maxPages: 500),
    );
    for (final o in objs) {
      if (o.key == key) return o;
    }
    return null;
  }

  /// فایل بزرگ تکه‌ای (۸ مگابایتی) نوشته می‌شود تا روی اینترنت کند هیچ درخواستی از مهلت نگذرد و
  /// قطع شدن یک تکه فقط همان تکه را دوباره بفرستد.
  @override
  Future<void> write(Uint8List bytes) async {
    final run = retry ?? (f) => f();
    if (bytes.length > s3PartBytes) {
      await s3PutMultipart(
        s3,
        transport,
        key,
        bytes,
        contentType: 'application/zip',
        retry: run,
      );
    } else {
      await run(
        () => _with(
          (t) => s3PutBytes(s3, t, key, bytes, contentType: 'application/zip'),
        ),
      );
    }
    try {
      await _dropLegacy();
    } on Object {
      // پاک کردن قالب قدیمی بهترین‌تلاش است؛ دور بعد دوباره امتحان می‌شود
    }
  }

  Future<bool> _dropLegacy() async {
    final (objs, _) = await _with(
      (t) => s3ListObjects(s3, t, bucketBackupRoot, maxPages: 500),
    );
    var any = false;
    for (final o in objs) {
      if (o.key == key) continue;
      await _with((t) => s3Delete(s3, t, o.key));
      any = true;
    }
    return any;
  }

  @override
  Future<bool> delete() async {
    final had = await head() != null;
    if (had) await _with((t) => s3Delete(s3, t, key));
    return await _dropLegacy() || had;
  }
}

/// قالب قدیمی روی دیسک (`blobs/` + `snaps/`، ردیف ۱۵۵–۱۶۲) — فقط برای ساختن نخستین فایل جامع
/// بی‌آنکه همهٔ فایل‌ها دوباره از دیتابیس دانلود شوند. فهرست از زنجیرهٔ snaps بازسازی می‌شود و
/// محتوای هر فایل فقط وقتی برداشته می‌شود که sha256 آن بخواند (هر ناهمخوانی ⇒ دانلود از دیتابیس).
final class LegacyDiskBackup {
  LegacyDiskBackup._(this.root, this.objects);
  final Directory root;

  /// آخرین وضع شناخته‌شده: نام فایل ← [sha256، اندازه، زمان، ETag].
  final Map<String, BackupEntry> objects;

  static final RegExp _shaRe = RegExp(r'^[0-9a-f]{64}$');

  static BackupEntry? _entry(Object? v) {
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

  /// null ⇒ قالب قدیمی روی این دیسک نیست.
  static Future<LegacyDiskBackup?> open(Directory root) async {
    final d = Directory('${root.path}${Platform.pathSeparator}snaps');
    if (!await d.exists()) return null;
    final recs = <(String, Map<Object?, Object?>)>[];
    try {
      await for (final f in d.list()) {
        if (f is! File || !f.path.endsWith('.json')) continue;
        try {
          final j = jsonDecode(await f.readAsString());
          if (j is Map && j['kind'] == ownerBackupKind) {
            recs.add(('${j['id'] ?? f.uri.pathSegments.last}', j));
          }
        } on Object {
          // فهرست خراب ⇒ نادیده
        }
      }
    } on FileSystemException {
      return null;
    }
    recs.sort((a, b) => a.$1.compareTo(b.$1));
    Map<String, BackupEntry>? cur;
    for (final (_, j) in recs) {
      final full = j['v'] == 1;
      final o = full ? j['objects'] : j['changed'];
      if (o is! Map) continue;
      if (full || j['base'] == null || cur == null) cur = {};
      final removed = j['removed'];
      if (!full && removed is List) {
        for (final k in removed) {
          cur.remove('$k');
        }
      }
      for (final e in o.entries) {
        final v = _entry(e.value);
        if (v != null) cur['${e.key}'] = v;
      }
    }
    if (cur == null || cur.isEmpty) return null;
    return LegacyDiskBackup._(root, cur);
  }

  /// محتوای خام یک sha از `blobs/`؛ null اگر نباشد یا sha نخواند.
  Future<List<int>?> content(String sha) async {
    if (!_shaRe.hasMatch(sha)) return null;
    final sep = Platform.pathSeparator;
    final f = File(
      '${root.path}${sep}blobs$sep${sha.substring(0, 2)}$sep$sha.gz',
    );
    try {
      if (!await f.exists()) return null;
      final raw = gzip.decode(await f.readAsBytes());
      return sha256Hex(raw) == sha ? raw : null;
    } on Object {
      return null;
    }
  }
}
