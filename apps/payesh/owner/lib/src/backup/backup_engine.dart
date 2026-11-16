// پشتیبان کامل و خودکار دیتابیس مالک (ردیف ۱۵۵؛ ردیف ۱۶۶: «یک فایل جامع»).
//
// • هر ۱۵ دقیقه کل صندوقچه (همهٔ مدارس، پنل مالک، پرداخت‌ها، پشتیبانی، سیاست‌ها، به‌روزرسانی‌ها)
//   بررسی می‌شود و فقط فایل‌های عوض‌شده از دیتابیس خوانده می‌شوند (افزایشی).
// • ردیف ۱۶۶: روی هر مقصد همیشه فقط یک فایل پشتیبان جامع هست (`payesh-owner-backup.zip`)؛ هر
//   تغییر در همان فایل ادغام می‌شود (بقیهٔ محتوا از خود فایل) و فایل تازه اتمی جای قبلی را می‌گیرد.
//   اگر چیزی عوض نشده باشد، چیزی نوشته نمی‌شود. فهرست بلند پشتیبان‌های ۱۵ دقیقه‌ای حذف شد.
// • مقصدها: دیسک همین سیستم (هر سیستم پنل مالک خودش) + خود دیتابیس (کلید روشن/خاموش). کلیدها در
//   سیاست زیرساخت هستند (`backup:auto`، `backup:db`) تا همهٔ سیستم‌های مالک یکسان پیروی کنند.
// • هر نسخه (دیسک / دیتابیس) با «حذف» پاک می‌شود؛ با پشتیبان خودکار روشن، دور بعد از نو ساخته می‌شود.
// • صندوقچهٔ خالی هرگز پشتیبان نمی‌شود (مثلاً پس از عوض کردن دیتابیس) و پشتیبانِ دیتابیسی دیگر
//   خودکار بازنویسی نمی‌شود (فقط با «پشتیبان‌گیری اکنون»)، تا پشتیبان خوب از دست نرود.
// • بازیابی/انتقال با یک کلیک: همهٔ فایل‌های پشتیبان (با بازبینی sha256) در دیتابیسِ تنظیم‌شده
//   نوشته می‌شوند؛ فایل‌هایی که در پشتیبان نیستند (تازه‌تر) دست نمی‌خورند. برای انتقال: دیتابیس
//   تازه را در «تنظیمات» وارد و «بازیابی» را بزنید.
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
  String? error,
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

  /// ردیف ۱۶۶: همان یک فایل روی هر مقصد (دیسک، دیتابیس) — برای صفحه.
  List<BackupFileInfo> files = const [];

  /// مقصدهایی که در «بازخوانی» خوانده نشدند (مثلاً دیتابیس قطع) ⇒ پیام.
  Map<String, String> fileErrors = const {};

  bool _localAuto = true;
  bool _localDb = true;
  bool _loaded = false;
  Timer? _timer;
  Timer? _first;
  bool _disposed = false;
  Future<BackupRunResult>? _inflight;

  /// اثر انگشت فایلِ هر مقصد (`disk`/`db`) تا «بدون تغییر» بی‌خواندن فایل دانسته شود؛ '' = نیست.
  final Map<String, String> _fp = {};

  /// آخرین فایل خوانده/نوشته‌شده (منبع محتوای فایل‌های بدون تغییر).
  BackupArchive? _base;

  /// ETag فایل روی دیتابیس که [files] از آن ساخته شد (بازخوانی ارزان).
  String? _dbEtag;
  BackupFileInfo? _dbInfo;

  /// پس از بازیابی در دیتابیس تازه: پشتیبانِ صندوقچهٔ قبلی را می‌شود با این صندوقچه نوشت.
  String? _adopt;
  int _refreshGen = 0;

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
    _fp.remove('db');
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

  /// یک دور پشتیبان (دورهای هم‌زمان یکی می‌شوند). [force] ⇒ پشتیبانِ دیتابیسی دیگر هم با
  /// همین دیتابیس جایگزین می‌شود (دکمهٔ «پشتیبان‌گیری اکنون»).
  Future<BackupRunResult> run({bool force = false}) =>
      _inflight ??= _run(force).whenComplete(() => _inflight = null);

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

  Future<BackupRunResult> _run(bool force) async {
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
      res = await _backup(now, force);
      if (res.ok) {
        lastError = null;
        lastSuccess = now;
        if (res.snapshot != null) lastSnapshot = res.snapshot;
      }
    } on S3Failure catch (e) {
      res = _fail(e.messageFa);
    } on FileSystemException catch (e) {
      res = _fail('نوشتن فایل پشتیبان روی دیسک نشد: ${e.message}');
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

  /// فایل پشتیبان یک مقصد، باز شده؛ null اگر نباشد یا خراب باشد.
  Future<BackupArchive?> _open(BackupTarget tg) async {
    try {
      final b = await tg.read();
      return b == null ? null : BackupArchive.parse(b);
    } on Object {
      return null;
    }
  }

  /// منبع محتوا: آخرین فایل در حافظه، وگرنه فایل دیسک، وگرنه فایل دیتابیس.
  Future<BackupArchive?> _baseOf(List<BackupTarget> targets) async {
    if (_base != null) return _base;
    for (final tg in targets) {
      final a = await _open(tg);
      if (a != null) {
        _fp[tg.id] = a.snapshot.fingerprint;
        return _base = a;
      }
    }
    return null;
  }

  /// اثر انگشت فایل فعلی مقصد ('' = نیست/خراب).
  Future<String> _fpOf(BackupTarget tg) async {
    final known = _fp[tg.id];
    if (known != null) return known;
    if (tg is BucketBackupTarget && await tg.head() == null) {
      return _fp[tg.id] = '';
    }
    final a = await _open(tg);
    return _fp[tg.id] = a?.snapshot.fingerprint ?? '';
  }

  Future<BackupRunResult> _backup(DateTime now, bool force) async {
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
    final base = await _baseOf(targets);
    if (base != null &&
        base.snapshot.bucket.isNotEmpty &&
        base.snapshot.bucket != s.bucket &&
        !force &&
        _adopt != s.bucket) {
      return _fail(
        'فایل پشتیبان مال دیتابیس «${base.snapshot.bucket}» است و خودکار با دیتابیس '
        '«${s.bucket}» جایگزین نمی‌شود. برای انتقال، «بازیابی» را بزنید؛ برای جایگزینی، '
        '«پشتیبان‌گیری اکنون».',
      );
    }
    // (پشتیبانِ دیتابیسی دیگر بالاتر رد شد مگر با «اکنون» یا پس از بازیابی) ⇒ منبع همان فایل
    final prev = base;
    progressTotal = objs.length;
    phaseFa = 'خواندن فایل‌های تازه یا تغییرکرده…';
    _notify();
    final entries = <String, BackupEntry>{};
    final fresh = <String, List<int>>{};
    var fetched = 0;
    var skipped = 0;
    for (final o in objs) {
      final ms = o.modified?.millisecondsSinceEpoch ?? 0;
      final p = prev?.snapshot.objects[o.key];
      // بدون تغییر = همان اندازه، همان زمان و (اگر S3 داد) همان ETag — محتوا از خود فایل پشتیبان
      final same =
          p != null &&
          p.size == o.size &&
          p.modifiedMs == ms &&
          p.etag == o.etag;
      if (same) {
        entries[o.key] = p;
      } else if (o.size > backupMaxObjectBytes) {
        skipped++;
      } else {
        final raw = await _get(s, o.key);
        if (raw != null) {
          fetched++;
          fresh[o.key] = raw;
          entries[o.key] = (
            sha: sha256Hex(raw),
            size: raw.length,
            modifiedMs: ms,
            etag: o.etag,
          );
        } // null ⇒ میان فهرست و خواندن پاک شد
      }
      progressDone++;
      if (progressDone % 25 == 0) _notify();
    }
    final snap = BackupSnapshot(at: now, bucket: s.bucket, objects: entries);
    final fp = snap.fingerprint;
    final need = <BackupTarget>[
      for (final tg in targets)
        if (await _fpOf(tg) != fp) tg,
    ];
    if (need.isEmpty) {
      return (
        ok: true,
        created: false,
        count: entries.length,
        fetched: fetched,
        skipped: skipped,
        snapshot: null,
        error: skipped > 0 ? _skippedFa(skipped) : null,
      );
    }
    phaseFa = 'ادغام تغییرها در فایل پشتیبان…';
    _notify();
    // محتوای بدون تغییر از خود فایل؛ اگر آنجا خراب بود، دوباره از دیتابیس
    for (final k in entries.keys.toList()) {
      if (fresh.containsKey(k)) continue;
      final raw = prev?.content(k) ?? await _get(s, k);
      if (raw == null) {
        entries.remove(k);
        continue;
      }
      if (sha256Hex(raw) != entries[k]!.sha) {
        fetched++;
        final e = entries[k]!;
        entries[k] = (
          sha: sha256Hex(raw),
          size: raw.length,
          modifiedMs: e.modifiedMs,
          etag: e.etag,
        );
      }
      fresh[k] = raw;
    }
    final out = BackupSnapshot(at: now, bucket: s.bucket, objects: entries);
    final bytes = BackupArchive.build(out, (k) => fresh[k]!);
    final archive = BackupArchive.parse(bytes);
    if (archive == null) {
      return _fail('فایل پشتیبان ساخته شد ولی بازبینی آن نخواند؛ نوشته نشد.');
    }
    phaseFa = 'نوشتن فایل پشتیبان…';
    _notify();
    final outFp = out.fingerprint;
    for (final tg in need) {
      await tg.write(bytes);
      _fp[tg.id] = outFp;
    }
    _base = archive;
    _adopt = null;
    _dbEtag = null;
    return (
      ok: true,
      created: true,
      count: entries.length,
      fetched: fetched,
      skipped: skipped,
      snapshot: BackupSnapshot.idFor(now),
      error: skipped > 0 ? _skippedFa(skipped) : null,
    );
  }

  static String _skippedFa(int n) =>
      '$n فایل بزرگ‌تر از ${backupMaxObjectBytes >> 20} مگابایت پشتیبان نشد.';

  Future<List<int>?> _get(S3Settings s, String key) async {
    final t = s3Factory();
    try {
      return await s3GetBytes(s, t, key);
    } finally {
      t.close();
    }
  }

  /// همان یک فایلِ هر مقصد (برای صفحه).
  Future<void> refresh() async {
    final gen = ++_refreshGen;
    await _load();
    final s = await _s3();
    final out = <BackupFileInfo>[];
    final errs = <String, String>{};
    for (final tg in await _targets(s, all: true)) {
      try {
        if (tg is BucketBackupTarget) {
          final h = await tg.head();
          if (h == null) {
            _dbEtag = null;
            _dbInfo = null;
            _fp[tg.id] = '';
            continue;
          }
          if (_dbEtag != h.etag || _dbInfo == null) {
            final a = await _open(tg);
            if (a == null) {
              errs[tg.id] = 'فایل پشتیبان روی دیتابیس خراب است.';
              continue;
            }
            _dbEtag = h.etag;
            _dbInfo = infoOf(tg.id, a);
            _fp[tg.id] = a.snapshot.fingerprint;
          }
          out.add(_dbInfo!);
        } else {
          final a = await _open(tg);
          if (a == null) {
            if ((await tg.read()) != null) {
              errs[tg.id] = 'فایل پشتیبان روی این دیسک خراب است.';
            } else {
              _fp[tg.id] = '';
            }
            continue;
          }
          _fp[tg.id] = a.snapshot.fingerprint;
          out.add(infoOf(tg.id, a));
        }
      } on S3Failure catch (e) {
        errs[tg.id] = e.messageFa;
      } on Object catch (e) {
        errs[tg.id] = '$e';
      }
    }
    if (gen != _refreshGen) return; // بازخوانی تازه‌تری در راه است
    files = out;
    fileErrors = errs;
    _notify();
  }

  /// پاک کردن فایل پشتیبانِ یک مقصد (`disk` / `db`)؛ null = انجام شد، وگرنه پیام خطا.
  Future<String?> deleteBackup(String target) async {
    await _load();
    await idle;
    final s = await _s3();
    final tg = [
      for (final x in await _targets(s, all: true))
        if (x.id == target) x,
    ].firstOrNull;
    if (tg == null) {
      return target == 'db'
          ? 'دیتابیس در «تنظیمات» وصل نیست.'
          : 'پوشهٔ پشتیبان روی این دستگاه نیست.';
    }
    try {
      await tg.delete();
    } on S3Failure catch (e) {
      return e.messageFa;
    } on Object catch (e) {
      return '$e';
    }
    _fp[target] = '';
    if (target == 'db') {
      _dbEtag = null;
      _dbInfo = null;
    }
    if (_base != null) {
      // منبع محتوا اگر همین نسخه بود، دور بعد از نسخهٔ دیگر یا از دیتابیس خوانده می‌شود
      _base = null;
    }
    await refresh();
    return null;
  }

  /// بازیابی کامل از فایل پشتیبانِ [target] (`disk` / `db`) در دیتابیسِ تنظیم‌شده (همان دیتابیس
  /// یا دیتابیس تازه برای انتقال). محتوای خراب یک نسخه از نسخهٔ دیگر برداشته می‌شود.
  Future<BackupRestoreResult> restore(String target) async {
    BackupRestoreResult fail(String e) =>
        (ok: false, written: 0, same: 0, failed: 0, newer: 0, error: e);
    await _load();
    final s = await _s3();
    if (s == null) return fail('اول دیتابیس مقصد را در «تنظیمات» وصل کنید.');
    await idle;
    final targets = await _targets(s, all: true);
    final ordered = [
      ...targets.where((t) => t.id == target),
      ...targets.where((t) => t.id != target),
    ];
    final opened = <BackupArchive>[];
    for (final tg in ordered) {
      final a = await _open(tg);
      if (a != null) opened.add(a); // نسخهٔ خراب/نبوده ⇒ نسخهٔ دیگر
    }
    if (opened.isEmpty) return fail('این پشتیبان پیدا نشد.');
    final snap = opened.first.snapshot;
    running = true;
    phaseFa = 'بازیابی…';
    progressDone = 0;
    progressTotal = snap.count;
    _notify();
    var written = 0, same = 0, failed = 0, newer = 0;
    try {
      final t = s3Factory();
      List<S3Object> objs;
      try {
        (objs, _) = await s3ListObjects(s, t, '', maxPages: 500);
      } finally {
        t.close();
      }
      final current = {
        for (final o in objs)
          if (!o.key.startsWith(bucketBackupRoot)) o.key: o,
      };
      for (final e in snap.objects.entries) {
        final c = current[e.key];
        if (c != null &&
            c.size == e.value.size &&
            c.etag.isNotEmpty &&
            c.etag == e.value.etag) {
          same++;
        } else {
          List<int>? raw;
          for (final a in opened) {
            final r = a.content(e.key);
            if (r != null && sha256Hex(r) == e.value.sha) {
              raw = r;
              break;
            }
          }
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
      newer = current.keys.where((k) => !snap.objects.containsKey(k)).length;
    } on S3Failure catch (e) {
      running = false;
      phaseFa = '';
      _notify();
      return fail(e.messageFa);
    }
    running = false;
    phaseFa = '';
    // پس از انتقال، همین پشتیبان با دیتابیس تازه ادامه می‌یابد
    _adopt = s.bucket;
    _base = null;
    _fp.clear();
    _dbEtag = null;
    _notify();
    unawaited(run());
    return (
      ok: failed == 0,
      written: written,
      same: same,
      failed: failed,
      newer: newer,
      error: failed > 0 ? '$failed فایل در هیچ نسخه‌ای سالم پیدا نشد.' : null,
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
