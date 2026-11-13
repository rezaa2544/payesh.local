// پشتیبان کامل و خودکار دیتابیس مالک (ردیف ۱۵۵).
//
// • هر ۱۵ دقیقه کل صندوقچه (همهٔ مدارس، پنل مالک، پرداخت‌ها، پشتیبانی، سیاست‌ها، به‌روزرسانی‌ها)
//   بررسی می‌شود و فقط فایل‌های عوض‌شده خوانده می‌شوند (افزایشی). اگر چیزی عوض نشده باشد،
//   فهرست تازه‌ای ساخته نمی‌شود.
// • مقصدها: دیسک همین سیستم (هر سیستم پنل مالک خودش) + خود دیتابیس (کلید روشن/خاموش).
//   کلیدها در سیاست زیرساخت هستند (`backup:auto`، `backup:db`) تا همهٔ سیستم‌های مالک یکسان پیروی کنند.
// • صندوقچهٔ خالی هرگز پشتیبان نمی‌شود (مثلاً پس از عوض کردن دیتابیس) تا پشتیبان خوب جایگزین نشود.
// • بازیابی/انتقال با یک کلیک: اول یک پشتیبان «پیش از بازیابی» از وضع فعلی، بعد همهٔ فایل‌های
//   آن لحظه (با بازبینی sha256) در دیتابیسِ تنظیم‌شده نوشته می‌شوند. فایل‌های تازه‌تر دست نمی‌خورند،
//   پس هیچ داده‌ای از دست نمی‌رود. برای انتقال: دیتابیس تازه را در «تنظیمات» وارد و «بازیابی» را بزنید.
// • جدا از پشتیبان روزانهٔ هر مدرسه (سرور مدرسه، پنل مدیر) است و جای آن را نمی‌گیرد.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:payesh_secure/payesh_secure.dart';

import '../infra/infra_policy.dart';
import '../local/s3_client.dart';
import 'backup_store.dart';

typedef BackupRunResult = ({
  bool ok,
  bool created,
  int count,
  int fetched,
  int skipped,
  String? snapshot,
  String? error,
});

typedef BackupRestoreResult = ({
  bool ok,
  int written,
  int same,
  int failed,
  int newer,
  String? safety,
  String? error,
});

/// یک فهرست برای نمایش.
typedef BackupItem = ({
  String id,
  DateTime at,
  int count,
  int bytes,
  String label,
  Set<String> targets,
});

class OwnerBackupEngine extends ChangeNotifier {
  OwnerBackupEngine({
    required this.secure,
    S3Transport Function()? s3Factory,
    this.localRoot,
    this.policy,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now,
       s3Factory = s3Factory ?? backupTransport;

  final SecureStore secure;

  /// انتقال با بدنهٔ خام کامل: انتقال پیش‌فرض متن را در ۶۴K نویسه می‌بُرد و برای
  /// فایل‌های دودویی و فهرست‌های بلند S3 مناسب نیست.
  final S3Transport Function() s3Factory;

  static S3Transport backupTransport() => IoS3Transport(
    maxBytes: backupMaxObjectBytes + (1 << 20),
    timeout: const Duration(minutes: 5),
  );

  /// پوشهٔ پشتیبان روی دیسک همین سیستم (null ⇒ فقط دیتابیس).
  final Future<Directory?> Function()? localRoot;

  /// سیاست زیرساخت برای کلیدهای سراسری؛ null ⇒ کلیدهای همین دستگاه.
  final InfraPolicyStore? policy;
  final DateTime Function() _now;

  static const Duration every = Duration(minutes: 15);
  static const String autoId = 'backup:auto';
  static const String dbId = 'backup:db';
  static const String statusKey = 'owner.backup.status';
  static const String flagsKey = 'owner.backup.flags';

  DateTime? lastCheck;
  DateTime? lastSuccess;
  String? lastSnapshot;
  String? lastError;
  bool running = false;

  /// پیشرفت دور جاری (پشتیبان یا بازیابی).
  int progressDone = 0;
  int progressTotal = 0;
  String phaseFa = '';
  List<BackupItem> items = const [];
  Map<String, int> usage = const {};

  bool _localAuto = true;
  bool _localDb = true;
  bool _loaded = false;
  Timer? _timer;
  Timer? _first;
  bool _disposed = false;
  Future<BackupRunResult>? _inflight;
  final Map<String, String> _latestFp = {};
  BackupSnapshot? _prev;
  DateTime? _lastGc;

  bool get autoOn => policy?.value.serviceOn(autoId) ?? _localAuto;
  bool get dbOn => policy?.value.serviceOn(dbId) ?? _localDb;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> _load() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final t = await secure.read(statusKey);
      if (t != null) {
        final m = jsonDecode(t) as Map;
        lastCheck = DateTime.tryParse('${m['check'] ?? ''}');
        lastSuccess = DateTime.tryParse('${m['ok'] ?? ''}');
        lastSnapshot = m['snap'] as String?;
        lastError = m['error'] as String?;
      }
      final f = await secure.read(flagsKey);
      if (f != null) {
        final m = jsonDecode(f) as Map;
        _localAuto = m['auto'] != false;
        _localDb = m['db'] != false;
      }
    } on Object {
      // پیش‌فرض‌ها
    }
  }

  Future<void> _saveStatus() async {
    try {
      await secure.write(
        statusKey,
        jsonEncode({
          'check': lastCheck?.toUtc().toIso8601String(),
          'ok': lastSuccess?.toUtc().toIso8601String(),
          'snap': lastSnapshot,
          'error': lastError,
        }),
      );
    } on Object {
      // فقط تا بستن برنامه
    }
  }

  Future<void> _saveFlags() async {
    try {
      await secure.write(
        flagsKey,
        jsonEncode({'auto': _localAuto, 'db': _localDb}),
      );
    } on Object {
      // فقط تا بستن برنامه
    }
  }

  Future<void> setAuto(bool on) async {
    await _load();
    final p = policy;
    if (p != null) {
      await p.setService(autoId, on);
    } else {
      _localAuto = on;
      await _saveFlags();
    }
    _notify();
  }

  Future<void> setDb(bool on) async {
    await _load();
    final p = policy;
    if (p != null) {
      await p.setService(dbId, on);
    } else {
      _localDb = on;
      await _saveFlags();
    }
    _latestFp.remove('db');
    _notify();
  }

  /// هر ۱۵ دقیقه (اگر «پشتیبان خودکار» روشن باشد).
  void start({
    Duration? interval,
    Duration firstAfter = const Duration(seconds: 30),
  }) {
    if (_timer != null) return;
    _timer = Timer.periodic(interval ?? every, (_) => unawaited(_auto()));
    _first = Timer(firstAfter, () => unawaited(_auto()));
  }

  Future<void> _auto() async {
    if (_disposed) return;
    await _load();
    if (autoOn) await run();
  }

  Future<S3Settings?> _s3() async {
    try {
      final s = await S3Settings.load(secure);
      return s == null || s.bucket.isEmpty ? null : s;
    } on Object {
      return null;
    }
  }

  Future<List<BackupTarget>> _targets(S3Settings? s, {bool all = false}) async {
    final out = <BackupTarget>[];
    final d = await localRoot?.call();
    if (d != null) out.add(DirBackupTarget(d));
    if (s != null && (all || dbOn)) out.add(BucketBackupTarget(s, s3Factory));
    return out;
  }

  /// تمام شدن دور در جریان (اگر هست).
  Future<void> get idle async {
    final f = _inflight;
    if (f != null) await f;
  }

  /// یک دور پشتیبان (دورهای هم‌زمان یکی می‌شوند).
  Future<BackupRunResult> run({String label = ''}) =>
      _inflight ??= _run(label).whenComplete(() => _inflight = null);

  BackupRunResult _fail(String e) {
    lastError = e;
    return (
      ok: false,
      created: false,
      count: 0,
      fetched: 0,
      skipped: 0,
      snapshot: null,
      error: e,
    );
  }

  Future<BackupRunResult> _run(String label) async {
    await _load();
    running = true;
    phaseFa = 'فهرست کردن فایل‌های دیتابیس…';
    progressDone = 0;
    progressTotal = 0;
    _notify();
    final now = _now();
    lastCheck = now;
    BackupRunResult res;
    try {
      res = await _backup(now, label);
      if (res.ok) {
        lastError = null;
        lastSuccess = now;
        if (res.snapshot != null) lastSnapshot = res.snapshot;
      }
    } on S3Failure catch (e) {
      res = _fail(e.messageFa);
    } on Object catch (e) {
      res = _fail('$e');
    }
    running = false;
    phaseFa = '';
    await _saveStatus();
    _notify();
    unawaited(refresh());
    return res;
  }

  Future<BackupRunResult> _backup(DateTime now, String label) async {
    final s = await _s3();
    if (s == null) {
      return _fail('دیتابیس در «تنظیمات» وصل نیست؛ پشتیبان ساخته نشد.');
    }
    final targets = await _targets(s);
    if (targets.isEmpty) return _fail('هیچ مقصدی برای پشتیبان روشن نیست.');
    final t = s3Factory();
    List<S3Object> objs;
    bool truncated;
    try {
      (objs, truncated) = await s3ListObjects(s, t, '', maxPages: 500);
    } finally {
      t.close();
    }
    if (truncated) {
      return _fail(
        'تعداد فایل‌ها بیش از حد فهرست است؛ پشتیبان ناقص ساخته نشد.',
      );
    }
    objs = [
      for (final o in objs)
        if (!o.key.startsWith(bucketBackupRoot)) o,
    ];
    if (objs.isEmpty) {
      // صندوقچهٔ خالی (مثلاً دیتابیس تازه) هرگز جای پشتیبان خوب را نمی‌گیرد
      return (
        ok: true,
        created: false,
        count: 0,
        fetched: 0,
        skipped: 0,
        snapshot: null,
        error: null,
      );
    }
    _prev ??= await _latestOf(targets);
    final prev = _prev?.bucket == s.bucket ? _prev : null;
    progressTotal = objs.length;
    phaseFa = 'خواندن فایل‌های تازه یا تغییرکرده…';
    _notify();
    final entries = <String, BackupEntry>{};
    var fetched = 0;
    var skipped = 0;
    for (final o in objs) {
      final ms = o.modified?.millisecondsSinceEpoch ?? 0;
      final p = prev?.objects[o.key];
      // بدون تغییر = همان اندازه، همان زمان و (اگر S3 داد) همان ETag
      BackupEntry? e =
          p != null &&
              p.size == o.size &&
              p.modifiedMs == ms &&
              p.etag == o.etag
          ? p
          : null;
      List<int>? raw;
      if (e != null) {
        // بدون تغییر: فقط مطمئن شو هر مقصد محتوایش را دارد
        final sha = e.sha;
        for (final tg in targets) {
          if (await tg.hasBlob(sha)) continue;
          raw ??= await _fromTargets(targets, sha) ?? await _get(s, o.key);
          if (raw == null) break;
          if (sha256Hex(raw) != sha) {
            e = null; // محتوای دیتابیس با فهرست قبلی نمی‌خواند ⇒ دوباره
            break;
          }
          await tg.putBlob(sha, raw);
        }
      }
      if (e == null) {
        if (o.size > backupMaxObjectBytes) {
          skipped++;
          progressDone++;
          continue;
        }
        raw = await _get(s, o.key);
        if (raw == null) {
          progressDone++;
          continue; // میان فهرست و خواندن پاک شد
        }
        fetched++;
        final sha = sha256Hex(raw);
        e = (sha: sha, size: raw.length, modifiedMs: ms, etag: o.etag);
        for (final tg in targets) {
          if (!await tg.hasBlob(sha)) await tg.putBlob(sha, raw);
        }
      }
      entries[o.key] = e;
      progressDone++;
      if (progressDone % 25 == 0) _notify();
    }
    var at = now;
    final snap0 = BackupSnapshot(
      id: BackupSnapshot.idFor(at),
      at: at,
      bucket: s.bucket,
      objects: entries,
      label: label,
    );
    final fp = snap0.fingerprint;
    phaseFa = 'ثبت فهرست…';
    _notify();
    // یک شناسه برای همهٔ مقصدها (بزرگ‌تر از تازه‌ترین فهرستِ هر مقصد)
    final need = <BackupTarget>[];
    String? newest;
    for (final tg in targets) {
      final ids = await tg.listSnapshots();
      final latest = ids.isEmpty ? null : ids.last;
      if (latest != null && (newest == null || latest.compareTo(newest) > 0)) {
        newest = latest;
      }
      _latestFp[tg.id] ??= latest == null
          ? ''
          : (await tg.getSnapshot(latest))?.fingerprint ?? '';
      if (label.isNotEmpty || _latestFp[tg.id] != fp) need.add(tg);
    }
    String? written;
    if (need.isNotEmpty) {
      var id = snap0.id;
      while (newest != null && id.compareTo(newest) <= 0) {
        at = at.add(const Duration(seconds: 1));
        id = BackupSnapshot.idFor(at);
      }
      final snap = BackupSnapshot(
        id: id,
        at: at,
        bucket: s.bucket,
        objects: entries,
        label: label,
      );
      for (final tg in need) {
        await tg.putSnapshot(snap);
        _latestFp[tg.id] = fp;
      }
      written = id;
      _prev = snap;
    }
    _prev ??= snap0;
    if (_lastGc == null ||
        now.difference(_lastGc!) > const Duration(hours: 24)) {
      phaseFa = 'پاک‌سازی پشتیبان‌های قدیمی…';
      _notify();
      for (final tg in targets) {
        await _retain(tg, now);
      }
      _lastGc = now;
    }
    return (
      ok: true,
      created: written != null,
      count: entries.length,
      fetched: fetched,
      skipped: skipped,
      snapshot: written,
      error: skipped > 0
          ? '$skipped فایل بزرگ‌تر از ${backupMaxObjectBytes >> 20} مگابایت پشتیبان نشد.'
          : null,
    );
  }

  Future<List<int>?> _get(S3Settings s, String key) async {
    final t = s3Factory();
    try {
      return await s3GetBytes(s, t, key);
    } finally {
      t.close();
    }
  }

  Future<List<int>?> _fromTargets(
    List<BackupTarget> targets,
    String sha,
  ) async {
    for (final tg in targets) {
      try {
        final b = await tg.getBlob(sha);
        if (b != null) return b;
      } on Object {
        // مقصد بعدی
      }
    }
    return null;
  }

  Future<BackupSnapshot?> _latestOf(List<BackupTarget> targets) async {
    for (final tg in targets) {
      try {
        final ids = await tg.listSnapshots();
        if (ids.isNotEmpty) return await tg.getSnapshot(ids.last);
      } on Object {
        // مقصد بعدی
      }
    }
    return null;
  }

  Future<void> _retain(BackupTarget tg, DateTime now) async {
    final ids = await tg.listSnapshots();
    final keep = backupKeep(ids, now);
    for (final id in ids) {
      if (!keep.contains(id)) await tg.deleteSnapshot(id);
    }
    final shas = <String>{};
    for (final id in keep) {
      final sn = await tg.getSnapshot(id);
      if (sn == null) return; // فهرست خراب ⇒ هیچ محتوایی پاک نمی‌شود
      shas.addAll(sn.objects.values.map((e) => e.sha));
    }
    await tg.gcBlobs(shas);
  }

  /// فهرست‌های همهٔ مقصدها (برای صفحه) + حجم اشغال‌شده.
  Future<void> refresh() async {
    await _load();
    final s = await _s3();
    final byId = <String, BackupItem>{};
    final use = <String, int>{};
    for (final tg in await _targets(s)) {
      try {
        for (final id in await tg.listSnapshots()) {
          final cur = byId[id];
          if (cur != null) {
            byId[id] = (
              id: cur.id,
              at: cur.at,
              count: cur.count,
              bytes: cur.bytes,
              label: cur.label,
              targets: {...cur.targets, tg.id},
            );
            continue;
          }
          final sn = await tg.getSnapshot(id);
          if (sn == null) continue;
          byId[id] = (
            id: id,
            at: sn.at,
            count: sn.count,
            bytes: sn.bytes,
            label: sn.label,
            targets: {tg.id},
          );
        }
        use[tg.id] = await tg.usedBytes();
      } on Object {
        // مقصد در دسترس نیست
      }
    }
    items = byId.values.toList()..sort((a, b) => b.id.compareTo(a.id));
    usage = use;
    _notify();
  }

  /// بازیابی کامل یک لحظه در دیتابیسِ تنظیم‌شده (همان دیتابیس یا دیتابیس تازه برای انتقال).
  Future<BackupRestoreResult> restore(String id) async {
    BackupRestoreResult fail(String e) => (
      ok: false,
      written: 0,
      same: 0,
      failed: 0,
      newer: 0,
      safety: null,
      error: e,
    );
    await _load();
    final s = await _s3();
    if (s == null) return fail('اول دیتابیس مقصد را در «تنظیمات» وصل کنید.');
    final targets = await _targets(s, all: true);
    BackupSnapshot? snap;
    for (final tg in targets) {
      try {
        snap = await tg.getSnapshot(id);
      } on Object {
        snap = null;
      }
      if (snap != null) break;
    }
    if (snap == null) return fail('این پشتیبان پیدا نشد.');
    // ۱) پشتیبان «پیش از بازیابی» از وضع فعلی ⇒ هیچ داده‌ای از دست نمی‌رود
    // دور در جریان اول تمام شود تا پشتیبان «پیش از بازیابی» تازه و برچسب‌دار باشد
    final busy = _inflight;
    if (busy != null) await busy;
    final pre = await run(label: 'پیش از بازیابی');
    if (!pre.ok) return fail('پشتیبان پیش از بازیابی ساخته نشد: ${pre.error}');
    final current = pre.count == 0 ? <String, BackupEntry>{} : _prev!.objects;
    running = true;
    phaseFa = 'بازیابی…';
    progressDone = 0;
    progressTotal = snap.count;
    _notify();
    var written = 0, same = 0, failed = 0;
    try {
      for (final e in snap.objects.entries) {
        if (current[e.key]?.sha == e.value.sha) {
          same++;
        } else {
          final raw = await _fromTargets(targets, e.value.sha);
          if (raw == null) {
            failed++;
          } else {
            final t = s3Factory();
            try {
              await s3PutBytes(
                s,
                t,
                e.key,
                raw,
                contentType: e.key.endsWith('.json')
                    ? 'application/json'
                    : 'application/octet-stream',
              );
            } finally {
              t.close();
            }
            written++;
          }
        }
        progressDone++;
        if (progressDone % 25 == 0) _notify();
      }
    } on S3Failure catch (e) {
      running = false;
      phaseFa = '';
      _notify();
      return fail(e.messageFa);
    }
    final newer = current.keys
        .where((k) => !snap!.objects.containsKey(k))
        .length;
    running = false;
    phaseFa = '';
    _prev = null; // دور بعد وضع تازه را از نو می‌سنجد
    _latestFp.clear();
    _notify();
    // وضع تازه بی‌درنگ پشتیبان می‌شود (پس از انتقال: نسخهٔ روی دیتابیس تازه هم)
    unawaited(run());
    return (
      ok: failed == 0,
      written: written,
      same: same,
      failed: failed,
      newer: newer,
      safety: pre.snapshot,
      error: failed > 0 ? '$failed فایل در هیچ مقصدی سالم پیدا نشد.' : null,
    );
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _first?.cancel();
    super.dispose();
  }
}
