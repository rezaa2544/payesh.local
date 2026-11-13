// کنترل به‌روزرسانی در برنامه (پنل مالک و برنامهٔ مدرسه): بررسی ⇐ دریافت (با پیشرفت زنده) ⇐
// نصب ⇐ باز شدن دوبارهٔ خودکار.
//   • ویندوز: فقط فایل‌های تغییرکرده (delta.dart)، اعمال پس از بسته شدن برنامه و باز شدن دوباره؛
//   • اندروید: APK کامل درون برنامه، نصب‌کنندهٔ سیستم، باز شدن دوباره پس از نصب.

import 'dart:async';
import 'dart:io';

import 'apk.dart';
import 'delta.dart';

/// مشخصات انتشار یک برنامهٔ نصبی.
final class UpdateChannel {
  const UpdateChannel({
    required this.id,
    required this.schema,
    required this.manifest,
    required this.blobs,
    required this.apk,
    required this.exeName,
    required this.stagingFolder,
    required this.versionBase,
    required this.build,
  });

  /// `owner` یا `app`.
  final String id;
  final String schema;
  final String manifest;
  final String blobs;
  final String apk;
  final String exeName;

  /// پوشه در `%LOCALAPPDATA%` برای فایل‌های موقت به‌روزرسانی.
  final String stagingFolder;

  /// دو بخش اول نسخه (pubspec)؛ بخش سوم شمارهٔ ساخت CI است.
  final String versionBase;

  /// شمارهٔ ساخت همین برنامه (CI: `--dart-define=...=<run_number>`).
  final int build;

  Uri get manifestUrl => Uri.parse(manifest);
  Uri get blobBase => Uri.parse(blobs);
  Uri get apkUrl => Uri.parse(apk);

  /// نسخهٔ نمایشی یک ساخت: `<versionBase>.<build>`.
  String versionOf(int b) => '$versionBase.$b';
  String get version => versionOf(build);
}

enum UpdatePhase {
  idle,
  checking,
  ready,
  upToDate,
  downloading,
  staged,

  /// اعمال/نصب شروع شده (ویندوز: اسکریپت اعمال در راه است؛ اندروید: نصب‌کنندهٔ سیستم).
  applying,
  failed,
}

class AppUpdater {
  AppUpdater({
    required this.channel,
    UpdateHttp Function()? http,
    Directory? installDir,
    Directory? stagingRoot,
    this.manifestUrl,
    this.blobBase,
    this.windows,
    this.launcher,
    this.mirror,
    this.apkInstaller,
    this.openUrl,
    this.retry = const UpdateRetry(),
    this.exitApp,
    int? currentBuild,
  }) : currentBuild = currentBuild ?? channel.build,
       http = http ?? IoUpdateHttp.new,
       installDir = installDir ?? File(Platform.resolvedExecutable).parent,
       stagingRoot = stagingRoot ?? defaultStaging(channel.stagingFolder);

  final UpdateChannel channel;
  final UpdateHttp Function() http;
  final Directory installDir;
  final Directory stagingRoot;
  final Uri? manifestUrl;
  final Uri? blobBase;
  final Future<void> Function(StagedUpdate staged)? launcher;

  /// آینهٔ اختیاری فایل‌ها (پنل مالک: صندوقچهٔ آروان).
  final Future<UpdateMirror?> Function()? mirror;

  /// اندروید: نصب درون برنامه. null ⇒ [openUrl] (مرورگر).
  final ApkInstaller? apkInstaller;
  final Future<void> Function(Uri url)? openUrl;
  final UpdateRetry retry;

  /// بستن برنامه پس از شروع اسکریپت اعمال (پیش‌فرض `exit(0)`).
  final void Function()? exitApp;

  /// شمارهٔ ساخت همین برنامه (پیش‌فرض از [channel]؛ آزمون‌ها عوضش می‌کنند).
  final int currentBuild;

  /// null ⇒ Platform.isWindows.
  final bool? windows;
  bool get isWindows => windows ?? Platform.isWindows;

  Uri get _manifestUrl => manifestUrl ?? channel.manifestUrl;
  Uri get _blobBase => blobBase ?? channel.blobBase;

  static Directory defaultStaging(String folder) {
    final base =
        Platform.environment['LOCALAPPDATA'] ?? Directory.systemTemp.path;
    final sep = Platform.pathSeparator;
    return Directory('$base$sep$folder${sep}update');
  }

  UpdatePhase phase = UpdatePhase.idle;
  UpdatePlan? plan;
  StagedUpdate? staged;
  String? error;
  int progressDone = 0;
  int progressTotal = 0;
  ApplyResult? lastApply;
  final _changes = StreamController<void>.broadcast();
  Stream<void> get changes => _changes.stream;

  /// نسخهٔ تازه هست (ویندوز: فایل تغییرکرده؛ اندروید: ساخت بالاتر ⇒ بستهٔ کامل).
  bool get available {
    final p = plan;
    if (p == null) return false;
    if (isWindows) return !p.upToDate;
    return currentBuild > 0 && p.manifest.build > currentBuild;
  }

  /// در حال کار (چراغ «زنده»).
  bool get busy =>
      phase == UpdatePhase.checking ||
      phase == UpdatePhase.downloading ||
      phase == UpdatePhase.applying;

  /// پیشرفت دریافت ۰..۱ (null ⇒ نامعلوم).
  double? get progress => phase == UpdatePhase.downloading && progressTotal > 0
      ? (progressDone / progressTotal).clamp(0.0, 1.0)
      : null;

  void _emit() {
    if (!_changes.isClosed) _changes.add(null);
  }

  void _set(UpdatePhase p, {String? err}) {
    phase = p;
    error = err;
    _emit();
  }

  DateTime _lastTick = DateTime.fromMillisecondsSinceEpoch(0);
  void _progress(int d, int t) {
    progressDone = d;
    progressTotal = t;
    // حداکثر ~۱۰ بار در ثانیه بازسازی رابط
    final now = DateTime.now();
    if (d >= t || now.difference(_lastTick).inMilliseconds >= 100) {
      _lastTick = now;
      _emit();
    }
  }

  /// نتیجهٔ به‌روزرسانی قبلی (پس از راه‌اندازی دوباره).
  void readLastApply() {
    try {
      final r = takeApplyResult(
        stagingRoot,
        installDir: isWindows ? installDir : null,
      );
      if (r != null) {
        lastApply = r;
        _emit();
      }
    } on Object {
      // دفعهٔ بعد
    }
  }

  Future<void> check() async {
    if (busy) return;
    _set(UpdatePhase.checking);
    final h = http();
    try {
      final m = await fetchManifest(
        h,
        url: _manifestUrl,
        schema: channel.schema,
        retry: retry,
      );
      if (!isWindows) {
        // اندروید: بستهٔ کامل (APK) لازم است
        plan = UpdatePlan(m, const []);
        _set(
          currentBuild > 0 && m.build > currentBuild
              ? UpdatePhase.ready
              : UpdatePhase.upToDate,
        );
        return;
      }
      final p = await planUpdate(m, installDir);
      plan = p;
      _set(p.upToDate ? UpdatePhase.upToDate : UpdatePhase.ready);
    } on UpdateException catch (e) {
      _set(UpdatePhase.failed, err: e.messageFa);
    } on Object catch (e) {
      _set(UpdatePhase.failed, err: 'بررسی به‌روزرسانی ممکن نشد: $e');
    } finally {
      h.close();
    }
  }

  Future<void> download() async {
    final p = plan;
    if (p == null || p.upToDate || !isWindows || busy) return;
    progressDone = 0;
    progressTotal = p.downloadBytes;
    _set(UpdatePhase.downloading);
    final h = http();
    try {
      staged = await downloadUpdate(
        p,
        http: h,
        stagingRoot: stagingRoot,
        mirror: await _mirror(),
        blobBase: _blobBase,
        retry: retry,
        onProgress: _progress,
      );
      progressDone = progressTotal;
      _set(UpdatePhase.staged);
    } on UpdateException catch (e) {
      _set(UpdatePhase.failed, err: e.messageFa);
    } on Object catch (e) {
      _set(UpdatePhase.failed, err: 'دریافت به‌روزرسانی ممکن نشد: $e');
    } finally {
      h.close();
    }
  }

  Future<UpdateMirror?> _mirror() async {
    final m = mirror;
    if (m == null) return null;
    try {
      return await m();
    } on Object {
      return null;
    }
  }

  /// اعمال: اسکریپت جدا اجرا می‌شود و برنامه بسته می‌شود؛ اسکریپت پس از جایگزینی برنامه را
  /// دوباره باز می‌کند.
  Future<void> applyAndRestart() async {
    final s = staged;
    if (s == null || phase == UpdatePhase.applying) return;
    _set(UpdatePhase.applying);
    final l = launcher;
    if (l != null) {
      await l(s);
      return;
    }
    try {
      await launchApply(
        staged: s,
        installDir: installDir.path,
        appPid: pid,
        exeName: channel.exeName,
      );
    } on UpdateException catch (e) {
      // اسکریپت شروع نشد: برنامه باز می‌ماند و به‌روزرسانی آماده می‌ماند.
      _set(UpdatePhase.failed, err: e.messageFa);
      return;
    } on Object catch (e) {
      _set(UpdatePhase.failed, err: 'اعمال به‌روزرسانی ممکن نشد: $e');
      return;
    }
    (exitApp ?? () => exit(0))();
  }

  /// اندروید: دانلود APK (با پیشرفت) و باز کردن نصب‌کنندهٔ سیستم.
  Future<void> installApk() async {
    final p = plan;
    if (p == null || isWindows || busy) return;
    final apk = p.manifest.apk;
    final inst = apkInstaller;
    if (apk == null || inst == null) {
      // بدون اطلاعات APK یا نصب‌کنندهٔ بومی: صفحهٔ دانلود
      await openUrl?.call(channel.apkUrl);
      return;
    }
    progressDone = 0;
    progressTotal = apk.size;
    _set(UpdatePhase.downloading);
    final h = http();
    try {
      final file = await downloadApk(
        apk: apk,
        url: channel.apkUrl,
        http: h,
        dir: await inst.cacheDir(),
        build: p.manifest.build,
        retry: retry,
        onProgress: _progress,
      );
      _set(UpdatePhase.applying);
      final r = await inst.install(file);
      if (r == 'needs_permission') {
        _set(
          UpdatePhase.ready,
          err: const UpdateException('install_permission').messageFa,
        );
      } else if (r != 'started') {
        throw UpdateException('install', r);
      }
    } on UpdateException catch (e) {
      _set(UpdatePhase.failed, err: e.messageFa);
    } on Object catch (e) {
      _set(UpdatePhase.failed, err: 'نصب نسخهٔ تازه ممکن نشد: $e');
    } finally {
      h.close();
    }
  }

  /// یک لمس روی چراغ: بررسی، یا اگر نسخهٔ تازه هست، دریافت + نصب + باز شدن دوباره.
  Future<void> tap() async {
    switch (phase) {
      case UpdatePhase.checking ||
          UpdatePhase.downloading ||
          UpdatePhase.applying:
        return;
      case UpdatePhase.staged:
        await applyAndRestart();
      case UpdatePhase.ready:
        if (!isWindows) {
          await installApk();
          return;
        }
        await download();
        if (phase == UpdatePhase.staged) await applyAndRestart();
      case UpdatePhase.failed when available:
        // خطای دریافت/نصب: لمس دوباره همان‌جا ادامه می‌دهد (فایل‌های سالم دوباره دانلود نمی‌شوند)
        if (!isWindows) {
          await installApk();
          return;
        }
        if (staged != null && staged!.plan == plan) {
          await applyAndRestart();
          return;
        }
        await download();
        if (phase == UpdatePhase.staged) await applyAndRestart();
      case UpdatePhase.idle || UpdatePhase.upToDate || UpdatePhase.failed:
        await check();
    }
  }

  Future<void> dispose() => _changes.close();
}

/// پشتیبانی و آزمون سرتاسری روی همین رایانه (CI): `--update-from <dir>` مانیفست و فایل‌ها را
/// از پوشهٔ محلی می‌خواند و `--update-now` بلافاصله بررسی، دریافت، نصب و باز شدن دوباره را
/// اجرا می‌کند — همان مسیر لمس چراغ، با برنامهٔ واقعی.
final class UpdateArgs {
  const UpdateArgs({this.from, this.now = false});
  final String? from;
  final bool now;

  static UpdateArgs parse(List<String> args) {
    String? from;
    for (var i = 0; i < args.length; i++) {
      if (args[i] == '--update-from' && i + 1 < args.length) from = args[i + 1];
    }
    return UpdateArgs(from: from, now: args.contains('--update-now'));
  }

  Uri? manifest(String fileName) =>
      from == null ? null : Uri.file('$from${Platform.pathSeparator}$fileName');

  Uri? blobs(String folder) => from == null
      ? null
      : Uri.directory('$from${Platform.pathSeparator}$folder');
}

/// `--update-now`: بررسی و اگر نسخهٔ تازه هست، همان کار لمس چراغ (تا نصب و باز شدن دوباره).
Future<void> runUpdateNow(AppUpdater u) async {
  await u.check();
  if (u.phase == UpdatePhase.ready) await u.tap();
}
