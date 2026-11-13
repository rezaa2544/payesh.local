// به‌روزرسانی پنل مالک در برنامه: بررسی، دریافت فقط تغییرات (آینهٔ آروان ⇐ GitHub)، اعمال.

import 'dart:async';
import 'dart:io';

import 'package:payesh_secure/payesh_secure.dart';

import '../local/s3_client.dart';
import 'owner_update.dart';

/// آینهٔ صندوقچهٔ آروان برای فایل‌های فشردهٔ به‌روزرسانی.
final class S3UpdateMirror implements UpdateMirror {
  S3UpdateMirror(this.s3, this.transport);
  final S3Settings s3;
  final S3Transport Function() transport;

  @override
  Future<List<int>?> get(String blob) async {
    final t = transport();
    try {
      return await s3GetBytes(s3, t, '$mirrorPrefix$blob');
    } finally {
      t.close();
    }
  }

  @override
  Future<void> put(String blob, List<int> gz) async {
    final t = transport();
    try {
      await s3PutBytes(s3, t, '$mirrorPrefix$blob', gz);
    } finally {
      t.close();
    }
  }
}

enum UpdatePhase {
  idle,
  checking,
  ready,
  upToDate,
  downloading,
  staged,
  failed,
}

final class OwnerUpdater {
  OwnerUpdater({
    required this.secure,
    UpdateHttp Function()? http,
    S3Transport Function()? mirrorTransport,
    Directory? installDir,
    Directory? stagingRoot,
    this.manifestUrl,
    this.blobBase,
    this.windows,
    this.launcher,
    int? currentBuild,
  }) : currentBuild = currentBuild ?? ownerBuild,
       http = http ?? IoUpdateHttp.new,
       mirrorTransport =
           mirrorTransport ??
           (() => IoS3Transport(
             maxBytes: 256 * 1024 * 1024,
             timeout: const Duration(minutes: 2),
           )),
       installDir = installDir ?? File(Platform.resolvedExecutable).parent,
       stagingRoot = stagingRoot ?? _defaultStaging();

  final SecureStore secure;
  final UpdateHttp Function() http;
  final S3Transport Function() mirrorTransport;
  final Directory installDir;
  final Directory stagingRoot;
  final Uri? manifestUrl;
  final Uri? blobBase;
  final Future<void> Function(StagedUpdate staged)? launcher;

  /// شمارهٔ ساخت همین برنامه (پیش‌فرض [ownerBuild]؛ آزمون‌ها عوضش می‌کنند).
  final int currentBuild;

  /// null ⇒ Platform.isWindows.
  final bool? windows;
  bool get isWindows => windows ?? Platform.isWindows;

  static Directory _defaultStaging() {
    final base =
        Platform.environment['LOCALAPPDATA'] ?? Directory.systemTemp.path;
    return Directory(
      '$base${Platform.pathSeparator}PayeshOwner${Platform.pathSeparator}update',
    );
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
  bool get available => plan != null && !plan!.upToDate;

  void _set(UpdatePhase p, {String? err}) {
    phase = p;
    error = err;
    if (!_changes.isClosed) _changes.add(null);
  }

  /// نتیجهٔ به‌روزرسانی قبلی (پس از راه‌اندازی دوباره).
  void readLastApply() {
    try {
      final r = takeApplyResult(stagingRoot);
      if (r != null) {
        lastApply = r;
        if (!_changes.isClosed) _changes.add(null);
      }
    } on Object {
      // دفعهٔ بعد
    }
  }

  Future<UpdateMirror?> _mirror() async {
    try {
      final s = await S3Settings.load(secure);
      if (s == null || s.bucket.isEmpty) return null;
      return S3UpdateMirror(s, mirrorTransport);
    } on Object {
      return null;
    }
  }

  Future<void> check() async {
    if (phase == UpdatePhase.checking || phase == UpdatePhase.downloading) {
      return;
    }
    _set(UpdatePhase.checking);
    final h = http();
    try {
      final m = await fetchManifest(h, url: manifestUrl);
      if (!isWindows) {
        // اندروید: بستهٔ کامل (APK) لازم است؛ فقط اعلام
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
    if (p == null || p.upToDate || !isWindows) return;
    _set(UpdatePhase.downloading);
    progressDone = 0;
    progressTotal = p.downloadBytes;
    final h = http();
    try {
      staged = await downloadUpdate(
        p,
        http: h,
        stagingRoot: stagingRoot,
        mirror: await _mirror(),
        blobBase: blobBase,
        onProgress: (d, t) {
          progressDone = d;
          progressTotal = t;
          if (!_changes.isClosed) _changes.add(null);
        },
      );
      _set(UpdatePhase.staged);
    } on UpdateException catch (e) {
      _set(UpdatePhase.failed, err: e.messageFa);
    } on Object catch (e) {
      _set(UpdatePhase.failed, err: 'دریافت به‌روزرسانی ممکن نشد: $e');
    } finally {
      h.close();
    }
  }

  /// اعمال: اسکریپت جدا اجرا می‌شود و برنامه بسته می‌شود.
  Future<void> applyAndRestart() async {
    final s = staged;
    if (s == null) return;
    final l = launcher;
    if (l != null) {
      await l(s);
      return;
    }
    try {
      await launchApply(staged: s, installDir: installDir.path, appPid: pid);
    } on UpdateException catch (e) {
      // اسکریپت شروع نشد: برنامه باز می‌ماند و به‌روزرسانی آماده می‌ماند.
      _set(UpdatePhase.failed, err: e.messageFa);
      return;
    }
    exit(0);
  }

  Future<void> dispose() => _changes.close();
}
