// کنترل به‌روزرسانی در برنامه (پنل مالک و برنامهٔ مدرسه): بررسی ⇐ دریافت (با پیشرفت زنده) ⇐
// نصب ⇐ باز شدن دوبارهٔ خودکار.
//   • ویندوز: فقط فایل‌های تغییرکرده (delta.dart)، اعمال پس از بسته شدن برنامه و باز شدن دوباره؛
//   • اندروید: APK کامل درون برنامه، نصب‌کنندهٔ سیستم، باز شدن دوباره پس از نصب.

import 'dart:async';

import 'package:payesh_core/io.dart';

import 'apk.dart';
import 'channel.dart';
import 'delta.dart';

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
    this.relays,
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

  /// ردیف ۱۹۷-Q05 (F26): سرورهای مدرسه‌ای که این دستگاه می‌شناسد. هر سرور پایش همان فایل‌های
  /// انتشار GitHub را بایت‌به‌بایت از `/api/update-relay/` جلو می‌گذارد (server/update-relay.js)؛
  /// روی شبکه‌ای که GitHub فیلتر است (دادهٔ همراه، VPN با مسیر direct بی‌DNS) همین راه همیشه
  /// کار می‌کند. اول سرورهای مدرسه، بعد GitHub. همهٔ هش‌ها مثل قبل بررسی می‌شوند.
  final Future<List<Uri>> Function()? relays;

  /// سرور مدرسه‌ای که آخرین مانیفست از آن آمد (null ⇒ GitHub)؛ فایل‌ها و APK هم از همان.
  Uri? relaySource;

  /// نشانی APK همان منبعی که مانیفست از آن آمد.
  Uri get apkUrl {
    final r = relaySource;
    return (r == null ? null : relayUri(r, channel.apkUrl)) ?? channel.apkUrl;
  }

  Future<List<Uri>> _relayList() async {
    final f = relays;
    // --update-from (پوشهٔ محلی) و نشانی‌های غیر GitHub رله ندارند
    if (f == null ||
        relayUri(Uri.parse('http://127.0.0.1/'), _manifestUrl) == null) {
      return const [];
    }
    try {
      final seen = <String>{};
      return [
        for (final u in await f().timeout(const Duration(seconds: 5)))
          if ((u.scheme == 'http' || u.scheme == 'https') &&
              u.host.isNotEmpty &&
              seen.add(u.origin))
            u,
      ];
    } on Object {
      return const [];
    }
  }

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
    return _androidNewer(p.manifest);
  }

  /// اندروید: ساخت بالاتر **و** بستهٔ APK همان ساخت منتشر شده باشد (بدون APK ⇒ به‌روز می‌ماند،
  /// نه چراغ «آماده» با پیوندی که وجود ندارد).
  bool _androidNewer(UpdateManifest m) =>
      currentBuild > 0 && m.build > currentBuild && m.apk != null;

  /// ردیف ۱۷۵: اندروید ۱۲+ نسخهٔ تازه را بدون صفحهٔ نصب‌کننده نصب می‌کند (به‌روزرسانی خودِ
  /// برنامه با همان کلید)؛ اندروید برنامه را برای جایگزینی می‌بندد.
  bool silentInstall = false;

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
      final m = await _fetchFromAny(h);
      if (!isWindows) {
        // اندروید: بستهٔ کامل (APK) لازم است
        plan = UpdatePlan(m, const []);
        _set(_androidNewer(m) ? UpdatePhase.ready : UpdatePhase.upToDate);
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

  /// ردیف ۱۹۷-Q05: اول سرورهای مدرسه (هر کدام حداکثر ۲ تلاش کوتاه)، بعد GitHub.
  Future<UpdateManifest> _fetchFromAny(UpdateHttp h) async {
    final quick = UpdateRetry(
      attempts: retry.attempts < 2 ? retry.attempts : 2,
      base: retry.base,
      max: retry.max,
    );
    for (final r in await _relayList()) {
      final url = relayUri(r, _manifestUrl);
      if (url == null) continue;
      try {
        final m = await fetchManifest(
          h,
          url: url,
          schema: channel.schema,
          retry: quick,
        );
        relaySource = r;
        return m;
      } on Object {
        continue;
      }
    }
    final m = await fetchManifest(
      h,
      url: _manifestUrl,
      schema: channel.schema,
      retry: retry,
    );
    relaySource = null;
    return m;
  }

  Future<void> download() async {
    final p = plan;
    if (p == null || p.upToDate || !isWindows || busy) return;
    progressDone = 0;
    progressTotal = p.downloadBytes;
    _set(UpdatePhase.downloading);
    final h = http();
    try {
      final mirror = await _mirror();
      Future<StagedUpdate> from(Uri base) => downloadUpdate(
        p,
        http: h,
        stagingRoot: stagingRoot,
        mirror: mirror,
        blobBase: base,
        retry: retry,
        onProgress: _progress,
      );
      final r = relaySource;
      final viaRelay = r == null ? null : relayUri(r, _blobBase);
      if (viaRelay == null) {
        staged = await from(_blobBase);
      } else {
        try {
          staged = await from(viaRelay);
        } on UpdateException {
          // سرور مدرسه همین لحظه نرسید ⇒ GitHub (فایل‌های رسیده دوباره دریافت نمی‌شوند)
          relaySource = null;
          staged = await from(_blobBase);
        }
      }
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
      await openUrl?.call(apkUrl);
      return;
    }
    progressDone = 0;
    progressTotal = apk.size;
    _set(UpdatePhase.downloading);
    final h = http();
    try {
      final dir = await inst.cacheDir();
      Future<File> from(Uri url) => downloadApk(
        apk: apk,
        url: url,
        http: h,
        dir: dir,
        build: p.manifest.build,
        retry: retry,
        onProgress: _progress,
      );
      final File file;
      if (relaySource == null) {
        file = await from(channel.apkUrl);
      } else {
        File? got;
        try {
          got = await from(apkUrl);
        } on UpdateException {
          relaySource = null;
        }
        file = got ?? await from(channel.apkUrl);
      }
      _set(UpdatePhase.applying);
      final r = await inst.install(file);
      if (r == 'needs_permission') {
        _set(
          UpdatePhase.ready,
          err: const UpdateException('install_permission').messageFa,
        );
      } else if (r == 'silent') {
        silentInstall = true;
        _emit();
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

  /// ردیف ۱۹۸-U2: پیش‌تر هیچ مسیری خودکار نصب نمی‌کرد — زمان‌سنج‌ها فقط [check] می‌زدند و
  /// تا کاربر «دانلود و نصب» را لمس نمی‌کرد هیچ اتفاقی نمی‌افتاد (گوشی روی 0.2.224 ماند،
  /// درحالی‌که 0.2.231 منتشر شده بود). حالا هر بررسی خودکار تا آخر می‌رود و پنهان است:
  ///   • اندروید: دریافت APK + نصب بی‌صفحه (نشست PackageInstaller، USER_ACTION_NOT_REQUIRED)؛
  ///     اگر اندروید باز هم تأیید خواست (نصب نخست از مرورگر/کابل)، فقط یک بار در هر اجرا.
  ///   • ویندوز: دریافت فقط فایل‌های تغییرکرده در پس‌زمینه؛ اعمال (بستن و باز شدن دوباره)
  ///     فقط وقتی [idle] بگوید کاربر مشغول نیست — تا وسط کار پنجره بسته نشود.
  /// شکست ⇒ دور بعدی دوباره (فایل‌های سالم دوباره دانلود نمی‌شوند).
  Future<void> autoUpdate({bool Function()? idle}) async {
    if (busy || _autoRunning) return;
    _autoRunning = true;
    try {
      if (phase != UpdatePhase.staged) await check();
      if (!available && phase != UpdatePhase.staged) return;
      if (!isWindows) {
        if (apkInstaller == null) return; // بی‌نصب‌کنندهٔ بومی: فقط چراغ
        final b = plan?.manifest.build;
        if (silentInstall && _autoApkBuild == b) return; // نصب پنهان در راه است
        // تأیید سیستم یک بار نشان داده شد
        if (_autoPromptedBuild == b && b != null) return;
        await installApk();
        if (silentInstall) {
          _autoApkBuild = b;
        } else if (phase == UpdatePhase.applying) {
          _autoPromptedBuild = b;
        }
        return;
      }
      if (phase != UpdatePhase.staged ||
          staged == null ||
          staged!.plan != plan) {
        await download();
      }
      if (phase == UpdatePhase.staged && (idle == null || idle())) {
        await applyAndRestart();
      }
    } finally {
      _autoRunning = false;
    }
  }

  bool _autoRunning = false;
  int? _autoApkBuild;
  int? _autoPromptedBuild;

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
