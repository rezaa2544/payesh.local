// به‌روزرسانی درجای برنامه‌های نصبی ویندوز (پنل مالک و برنامهٔ مدرسه): فقط فایل‌های
// تغییرکرده دانلود می‌شوند — همان روش پنل کاربران (server/update.js):
//   ۱) مانیفست منتشرشده (مثلاً owner-update.json در owner-continuous) خوانده می‌شود؛
//   ۲) SHA-256 هر فایل نصب‌شده با مانیفست مقایسه می‌شود؛
//   ۳) فقط فایل‌های متفاوت (فشرده، gzip) دانلود و ابتدا در پوشهٔ موقت گذاشته می‌شوند —
//      اول از آینهٔ اختیاری (صندوقچهٔ آروان)، اگر نبود از GitHub؛
//   ۴) هش و اندازهٔ همه بررسی می‌شود؛ اگر یکی ناجور بود هیچ‌چیز اعمال نمی‌شود؛
//   ۵) پس از بسته شدن برنامه، اسکریپت PowerShell فایل‌ها را جایگزین می‌کند (نسخهٔ قبلی در
//      پشتیبان می‌ماند)، هش‌ها را دوباره بررسی می‌کند و برنامه را باز می‌کند؛ اگر نسخهٔ تازه
//      بالا نیاید، نسخهٔ قبلی برگردانده می‌شود.
// اعتماد: مانیفست فقط از GitHub (TLS) خوانده می‌شود، هرگز از آینه؛ آینه فقط فایل‌هایی را
// می‌دهد که هششان باید با همان مانیفست یکی باشد.
//
// ردیف ۱۴۸ (پایداری):
//   • هر درخواست با چند تلاش دوباره و فاصلهٔ رو به افزایش (شبکهٔ ناپایدار، ۴۰۴ کوتاهِ لحظهٔ
//     انتشار، دانلود نیمه‌کاره)؛
//   • ادامه از همان‌جا: فایل‌هایی که قبلاً کامل و درست دریافت شده‌اند دوباره دانلود نمی‌شوند؛
//   • پیشرفت بایت‌به‌بایت (نه فقط پس از هر فایل) تا چراغ نوار بالا پر شدن را نشان دهد؛
//   • اسکریپت اعمال: صبر برای بسته شدن همهٔ نمونه‌های برنامه، کنار گذاشتن فایل قفل‌شده با
//     تغییر نام، تلاش‌های بیشتر، و باز کردن دوبارهٔ برنامه با پنجرهٔ معمولی (و روش دوم اگر
//     اولی نشد) — پس از هر نتیجه‌ای (موفق، بازگشت، خطا) برنامه دوباره باز می‌شود.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

const int _maxFileBytes = 256 * 1024 * 1024;
const int _maxFiles = 4000;
final RegExp _shaRe = RegExp(r'^[0-9a-f]{64}$');
final RegExp _pathRe = RegExp(r'^[A-Za-z0-9._+\-]+(/[A-Za-z0-9._+\-]+)*$');

final class UpdateException implements Exception {
  const UpdateException(this.code, [this.detail = '']);
  final String code;
  final String detail;
  @override
  String toString() => detail.isEmpty ? code : '$code: $detail';

  /// خطاهای گذرا که تلاش دوباره ممکن است درستشان کند.
  bool get transient => code == 'network' || code == 'bad_hash';

  String get messageFa => switch (code) {
    'bad_manifest' => 'فهرست به‌روزرسانی معتبر نیست.',
    'network' => 'به سرور به‌روزرسانی نرسیدیم. اتصال اینترنت را بررسی کنید.',
    'bad_hash' => 'فایل دریافت‌شده با فهرست یکی نبود؛ هیچ تغییری اعمال نشد. دوباره امتحان کنید.',
    'io' => 'نوشتن فایل‌های به‌روزرسانی روی دیسک ممکن نشد.',
    'launch' => 'اجرای نصب‌کنندهٔ به‌روزرسانی ممکن نشد؛ برنامه باز می‌ماند و چیزی تغییر نکرد. دوباره امتحان کنید یا نصب‌کنندهٔ کامل را اجرا کنید.',
    'install' => 'نصب نسخهٔ تازه شروع نشد. دوباره لمس کنید.',
    'install_permission' => 'اجازهٔ «نصب برنامه‌های ناشناس» برای این برنامه را در صفحهٔ بازشده روشن کنید و دوباره لمس کنید.',
    _ => 'به‌روزرسانی ممکن نشد ($code).',
  };
}

/// سیاست تلاش دوباره: [attempts] بار، فاصله‌ها base، ۲×base، ۴×base … (حداکثر [max]).
final class UpdateRetry {
  const UpdateRetry({
    this.attempts = 4,
    this.base = const Duration(seconds: 2),
    this.max = const Duration(seconds: 20),
  });

  /// بدون تلاش دوباره (آزمون‌ها).
  static const UpdateRetry none = UpdateRetry(attempts: 1, base: Duration.zero);

  final int attempts;
  final Duration base;
  final Duration max;

  Duration delay(int failed) {
    final ms = base.inMilliseconds * math.pow(2, failed - 1);
    return Duration(milliseconds: math.min(ms.toInt(), max.inMilliseconds));
  }

  /// [fn] را اجرا می‌کند؛ خطای گذرا ⇒ دوباره (تا [attempts] بار).
  Future<T> run<T>(
    Future<T> Function(int attempt) fn, {
    void Function(int attempt, Object error)? onRetry,
  }) async {
    for (var i = 1; ; i++) {
      try {
        return await fn(i);
      } on UpdateException catch (e) {
        if (!e.transient || i >= attempts) rethrow;
        onRetry?.call(i, e);
      }
      final d = delay(i);
      if (d > Duration.zero) await Future<void>.delayed(d);
    }
  }
}

final class UpdateFile {
  const UpdateFile(this.path, this.sha256, this.size, this.gzSize);
  final String path;
  final String sha256;
  final int size;
  final int gzSize;
  String get blob => '$sha256.gz';
}

final class ApkInfo {
  const ApkInfo(this.sha256, this.size);
  final String sha256;
  final int size;
}

final class UpdateManifest {
  const UpdateManifest({
    required this.build,
    required this.commit,
    required this.files,
    this.apk,
    this.schema = '',
  });

  final int build;
  final String commit;
  final List<UpdateFile> files;
  final ApkInfo? apk;
  final String schema;

  int get totalBytes => files.fold(0, (a, f) => a + f.size);

  /// تجزیهٔ سخت‌گیرانه: هر چیز ناشناخته یا مسیر خطرناک ⇒ [UpdateException].
  static UpdateManifest parse(String text, {required String schema}) {
    Never bad(String why) => throw UpdateException('bad_manifest', why);
    final Object? j;
    try {
      j = jsonDecode(text);
    } on FormatException {
      bad('json');
    }
    if (j is! Map<String, Object?>) bad('root');
    if (j['schema'] != schema) bad('schema');
    final build = j['build'];
    if (build is! int || build <= 0) bad('build');
    final commit = j['commit'];
    if (commit is! String || !RegExp(r'^[0-9a-f]{40}$').hasMatch(commit)) {
      bad('commit');
    }
    final list = j['files'];
    if (list is! List || list.isEmpty || list.length > _maxFiles) bad('files');
    final seen = <String>{};
    final files = <UpdateFile>[];
    for (final f in list) {
      if (f is! Map<String, Object?>) bad('file');
      final path = f['path'], sha = f['sha256'], size = f['size'];
      final gz = f['gz_size'];
      if (path is! String ||
          !_pathRe.hasMatch(path) ||
          path.split('/').any((p) => p == '.' || p == '..') ||
          !seen.add(path.toLowerCase())) {
        bad('path');
      }
      if (sha is! String || !_shaRe.hasMatch(sha)) bad('sha256');
      if (size is! int || size < 0 || size > _maxFileBytes) bad('size');
      if (gz is! int || gz <= 0 || gz > _maxFileBytes) bad('gz_size');
      files.add(UpdateFile(path, sha, size, gz));
    }
    ApkInfo? apk;
    final a = j['android'];
    if (a != null) {
      if (a is! Map<String, Object?>) bad('android');
      final sha = a['sha256'], size = a['size'];
      if (sha is! String ||
          !_shaRe.hasMatch(sha) ||
          size is! int ||
          size <= 0) {
        bad('android');
      }
      apk = ApkInfo(sha, size);
    }
    return UpdateManifest(
      build: build,
      commit: commit,
      files: files,
      apk: apk,
      schema: schema,
    );
  }
}

final class UpdatePlan {
  const UpdatePlan(this.manifest, this.changed);
  final UpdateManifest manifest;
  final List<UpdateFile> changed;

  bool get upToDate => changed.isEmpty;
  int get downloadBytes => changed.fold(0, (a, f) => a + f.gzSize);
  int get totalBytes => manifest.totalBytes;
}

/// مقایسهٔ فایل‌های نصب‌شده با مانیفست (هش در Isolate جدا).
Future<UpdatePlan> planUpdate(UpdateManifest m, Directory installDir) async {
  final root = installDir.path;
  final want = [for (final f in m.files) (f.path, f.sha256, f.size)];
  final changedPaths = await Isolate.run(() {
    final out = <String>{};
    for (final (path, sha, size) in want) {
      final file = File('$root${Platform.pathSeparator}${_native(path)}');
      if (!file.existsSync() || file.lengthSync() != size) {
        out.add(path);
        continue;
      }
      if (sha256.convert(file.readAsBytesSync()).toString() != sha) {
        out.add(path);
      }
    }
    return out;
  });
  return UpdatePlan(m, [
    for (final f in m.files)
      if (changedPaths.contains(f.path)) f,
  ]);
}

String _native(String p) => Platform.isWindows ? p.replaceAll('/', r'\') : p;

/// دریافت HTTP (در آزمون‌ها جعلی).
abstract interface class UpdateHttp {
  /// null ⇒ ۴۰۴. [onBytes] پس از هر تکهٔ رسیده با مجموع بایت‌های همین درخواست.
  Future<List<int>?> get(
    Uri url, {
    int maxBytes,
    void Function(int received)? onBytes,
  });
  void close();
}

final class IoUpdateHttp implements UpdateHttp {
  IoUpdateHttp({SecurityContext? context, Duration? timeout})
    : _timeout = timeout ?? const Duration(seconds: 60),
      _client = HttpClient(context: context)
        ..connectionTimeout = const Duration(seconds: 20)
        ..idleTimeout = const Duration(seconds: 15);
  final HttpClient _client;
  final Duration _timeout;

  @override
  Future<List<int>?> get(
    Uri url, {
    int maxBytes = _maxFileBytes,
    void Function(int received)? onBytes,
  }) async {
    // file:// فقط برای آزمون سرتاسری (--update-from روی همین رایانه)
    if (url.scheme == 'file') {
      final f = File(Uri(scheme: 'file', path: url.path).toFilePath());
      if (!f.existsSync()) return null;
      final b = await f.readAsBytes();
      if (b.length > maxBytes) {
        throw const UpdateException('bad_hash', 'too large');
      }
      onBytes?.call(b.length);
      return b;
    }
    try {
      final req = await _client.getUrl(url).timeout(_timeout);
      req.followRedirects = true; // GitHub ⇒ objects.githubusercontent.com
      req.maxRedirects = 5;
      req.headers.set(HttpHeaders.userAgentHeader, 'payesh-updater/2');
      req.headers.set(HttpHeaders.cacheControlHeader, 'no-cache');
      final res = await req.close().timeout(_timeout);
      if (res.statusCode == 404) {
        await res.drain<void>().catchError((_) {});
        return null;
      }
      if (res.statusCode != 200) {
        await res.drain<void>().catchError((_) {});
        throw UpdateException('network', 'HTTP ${res.statusCode}');
      }
      final expected = res.contentLength;
      final b = BytesBuilder(copy: false);
      await for (final c in res.timeout(_timeout)) {
        b.add(c);
        if (b.length > maxBytes) {
          throw const UpdateException('bad_hash', 'too large');
        }
        onBytes?.call(b.length);
      }
      // اتصالِ بریده که بی‌خطا بسته شد ⇒ دانلود ناقص (دوباره)
      if (expected >= 0 && b.length != expected) {
        throw UpdateException('network', 'short read ${b.length}/$expected');
      }
      return b.takeBytes();
    } on UpdateException {
      rethrow;
    } on Object catch (e) {
      throw UpdateException('network', '$e');
    }
  }

  @override
  void close() => _client.close(force: true);
}

/// آینهٔ اختیاری (صندوقچهٔ آروان): خواندن/نوشتن `<prefix><sha>.gz`.
abstract interface class UpdateMirror {
  Future<List<int>?> get(String blob);
  Future<void> put(String blob, List<int> gz);
}

/// خواندن مانیفست (با تلاش دوباره؛ ۴۰۴ کوتاه هنگام انتشار هم دوباره امتحان می‌شود).
Future<UpdateManifest> fetchManifest(
  UpdateHttp http, {
  required Uri url,
  required String schema,
  UpdateRetry retry = const UpdateRetry(),
}) => retry.run((_) async {
  final b = await http.get(
    url.replace(
      queryParameters: {
        ...url.queryParameters,
        't': '${DateTime.now().millisecondsSinceEpoch}',
      },
    ),
    maxBytes: 4 * 1024 * 1024,
  );
  if (b == null) throw const UpdateException('network', 'manifest 404');
  final String text;
  try {
    text = utf8.decode(b);
  } on FormatException {
    // پاسخ بریده/خراب: گذرا
    throw const UpdateException('network', 'manifest bytes');
  }
  return UpdateManifest.parse(text, schema: schema);
});

/// به‌روزرسانیِ آماده (همهٔ فایل‌ها دانلود و بررسی شده‌اند).
final class StagedUpdate {
  const StagedUpdate(
    this.plan,
    this.dir,
    this.fromMirror,
    this.fromOrigin, [
    this.resumed = 0,
  ]);
  final UpdatePlan plan;
  final Directory dir;
  final int fromMirror;
  final int fromOrigin;

  /// فایل‌هایی که از دریافت قبلی (نیمه‌تمام) سالم مانده بودند و دوباره دانلود نشدند.
  final int resumed;
  Directory get files => Directory('${dir.path}${Platform.pathSeparator}files');
}

/// دانلود فقط فایل‌های تغییرکرده در `stagingRoot/<build>/files` و بررسی هش همه.
///
/// اگر دریافت قبلی همین ساخت نیمه‌کاره مانده باشد، فایل‌های سالمش نگه داشته می‌شوند.
Future<StagedUpdate> downloadUpdate(
  UpdatePlan plan, {
  required UpdateHttp http,
  required Directory stagingRoot,
  required Uri blobBase,
  UpdateMirror? mirror,
  UpdateRetry retry = const UpdateRetry(),
  void Function(int doneBytes, int totalBytes)? onProgress,
}) async {
  final sep = Platform.pathSeparator;
  final dir = Directory('${stagingRoot.path}$sep${plan.manifest.build}');
  try {
    dir.createSync(recursive: true);
    // باقی‌ماندهٔ اعمالِ قبلی (پشتیبان، نتیجه، نشانه‌ها) هرگز با دریافت تازه قاطی نشود
    for (final n in [
      'backup',
      'apply.log',
      'apply.ps1',
      'apply.lock',
      'cancel',
      'result.json',
      'plan.json',
    ]) {
      final e = FileSystemEntity.typeSync('${dir.path}$sep$n');
      if (e == FileSystemEntityType.directory) {
        Directory('${dir.path}$sep$n').deleteSync(recursive: true);
      } else if (e != FileSystemEntityType.notFound) {
        File('${dir.path}$sep$n').deleteSync();
      }
    }
  } on FileSystemException catch (e) {
    throw UpdateException('io', '$e');
  }
  final total = plan.downloadBytes;
  var done = 0, fromMirror = 0, fromOrigin = 0, resumed = 0;
  onProgress?.call(0, total);
  for (final f in plan.changed) {
    final out = File('${dir.path}${sep}files$sep${_native(f.path)}');
    // ادامه: فایلِ کامل و درستِ دریافت قبلی
    if (await _stagedOk(out, f)) {
      resumed++;
      done += f.gzSize;
      onProgress?.call(done, total);
      continue;
    }
    var mirrored = false;
    final raw = await retry.run((attempt) async {
      List<int>? gz;
      mirrored = false;
      if (mirror != null) {
        try {
          gz = await mirror.get(f.blob);
          mirrored = gz != null;
        } on Object {
          gz = null;
        }
      }
      var r = gz == null ? null : _gunzipChecked(gz, f);
      if (r == null) {
        mirrored = false;
        gz = await http.get(
          blobBase.resolve(f.blob),
          maxBytes: f.gzSize + 1024,
          onBytes: (n) => onProgress?.call(done + math.min(n, f.gzSize), total),
        );
        if (gz == null) throw UpdateException('network', '${f.blob} 404');
        r = _gunzipChecked(gz, f);
        if (r == null) throw UpdateException('bad_hash', f.path);
        if (mirror != null) {
          try {
            await mirror.put(f.blob, gz);
          } on Object {
            // آینه اختیاری است
          }
        }
      }
      return r;
    });
    try {
      out.parent.createSync(recursive: true);
      // اول در .part، بعد تغییر نام: فایل نیمه‌نوشته هرگز «کامل» دیده نمی‌شود
      final part = File('${out.path}.part');
      part.writeAsBytesSync(raw, flush: true);
      if (out.existsSync()) out.deleteSync();
      part.renameSync(out.path);
    } on FileSystemException catch (e) {
      throw UpdateException('io', '$e');
    }
    if (mirrored) {
      fromMirror++;
    } else {
      fromOrigin++;
    }
    done += f.gzSize;
    onProgress?.call(done, total);
  }
  File('${dir.path}${sep}plan.json').writeAsStringSync(
    jsonEncode({
      'build': plan.manifest.build,
      'commit': plan.manifest.commit,
      'files': [
        for (final f in plan.changed) {'path': f.path, 'sha256': f.sha256},
      ],
    }),
  );
  return StagedUpdate(plan, dir, fromMirror, fromOrigin, resumed);
}

Future<bool> _stagedOk(File out, UpdateFile f) async {
  try {
    if (!out.existsSync() || out.lengthSync() != f.size) return false;
    final h = (await sha256.bind(out.openRead()).first).toString();
    return h == f.sha256;
  } on Object {
    return false;
  }
}

List<int>? _gunzipChecked(List<int> gz, UpdateFile f) {
  try {
    final raw = gzip.decode(gz);
    if (raw.length != f.size) return null;
    if (sha256.convert(raw).toString() != f.sha256) return null;
    return raw;
  } on Object {
    return null;
  }
}

String _psQuote(String s) => "'${s.replaceAll("'", "''")}'";

/// اسکریپت PowerShell جایگزینی (پس از بسته شدن برنامه). UTF-8 با BOM ذخیره می‌شود تا
/// مسیرهای فارسی در Windows PowerShell 5.1 درست خوانده شوند.
String applyScript({
  required StagedUpdate staged,
  required String installDir,
  required String exeName,
  int healthSeconds = 15,
}) {
  final files = staged.plan.changed;
  final b = StringBuffer()
    ..writeln(
      '# Payesh — in-place update of $exeName to build ${staged.plan.manifest.build}',
    )
    ..writeln('param([int]\$AppPid = 0)')
    ..writeln("\$ErrorActionPreference = 'Stop'")
    ..writeln('\$install = ${_psQuote(installDir)}')
    ..writeln('\$stage = ${_psQuote(staged.dir.path)}')
    ..writeln("\$staged = Join-Path \$stage 'files'")
    ..writeln("\$backup = Join-Path \$stage 'backup'")
    ..writeln("\$resultFile = Join-Path \$stage 'result.json'")
    ..writeln("\$logFile = Join-Path \$stage 'apply.log'")
    ..writeln('\$exe = Join-Path \$install ${_psQuote(exeName)}')
    ..writeln(
      '\$exeBase = ${_psQuote(exeName.replaceAll(RegExp(r'\.exe$', caseSensitive: false), ''))}',
    )
    ..writeln('\$build = ${staged.plan.manifest.build}')
    ..writeln('\$healthSeconds = $healthSeconds')
    ..writeln('\$files = @(');
  for (final f in files) {
    b.writeln(
      '  @{ p = ${_psQuote(f.path.replaceAll('/', r'\'))}; h = ${_psQuote(f.sha256)} }',
    );
  }
  b
    ..writeln(')')
    ..write(_applyBody);
  return b.toString();
}

const String _applyBody = r'''
$ProgressPreference = 'SilentlyContinue'
# اگر از محیط PowerShell 7 اجرا شده باشیم، مسیر ماژول‌های آن برای Windows PowerShell 5.1 ناسازگار است
try {
  $env:PSModulePath = (@((Join-Path $PSHOME 'Modules'), [Environment]::GetEnvironmentVariable('PSModulePath', 'User'), [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')) | Where-Object { $_ }) -join [System.IO.Path]::PathSeparator
} catch { }
function Get-Sha256([string]$path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $fs = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
  try { return ([System.BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '').ToLower() }
  finally { $fs.Dispose(); $sha.Dispose() }
}
function Write-Log([string]$m) {
  try { [System.IO.File]::AppendAllText($logFile, ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $m + "`r`n"), (New-Object System.Text.UTF8Encoding($false))) } catch { }
}
# نشانهٔ شروع (برنامه تا دیدن این خط بسته نمی‌شود)
Write-Log "start pid=$PID ps=$($PSVersionTable.PSVersion) app=$AppPid"
# فقط یک نمونه: اگر روش دوم هم اجرا شد، نمونهٔ دوم بی‌صدا کنار می‌رود
try { $lock = [System.IO.File]::Open((Join-Path $stage 'apply.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch { Write-Log 'another apply is running; exit'; exit 0 }
$cancel = Join-Path $stage 'cancel'
if (Test-Path -LiteralPath $cancel) { Write-Log 'cancelled by the app; nothing changed'; exit 0 }
$script:relaunched = $null
function Write-Result([bool]$ok, [string]$msg, [bool]$rolledBack) {
  Write-Log "result ok=$ok rolled_back=$rolledBack $msg"
  $rp = 0; $win = $false
  if ($script:relaunched) { try { $script:relaunched.Refresh(); $rp = $script:relaunched.Id; $win = ($script:relaunched.MainWindowHandle -ne [IntPtr]::Zero) } catch { } }
  $o = [ordered]@{ ok = $ok; build = $build; rolled_back = $rolledBack; message = $msg; relaunched_pid = $rp; window = $win; at = (Get-Date).ToUniversalTime().ToString('o') }
  [System.IO.File]::WriteAllText($resultFile, ($o | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
}
# باز کردن دوبارهٔ برنامه: پنجرهٔ معمولی؛ اگر نشد، از راه Explorer (مثل دوبار کلیک)
function Start-App {
  for ($i = 0; $i -lt 3; $i++) {
    try {
      $script:relaunched = Start-Process -FilePath $exe -WorkingDirectory $install -WindowStyle Normal -PassThru
      Write-Log "relaunched pid=$($script:relaunched.Id)"
      return $script:relaunched
    } catch { Write-Log "relaunch attempt $i failed: $_"; Start-Sleep -Milliseconds 800 }
  }
  try { Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList ('"' + $exe + '"'); Write-Log 'relaunched via explorer' } catch { Write-Log "explorer relaunch failed: $_" }
  return $null
}
function Restore-Backup($list) {
  foreach ($f in $list) {
    $dst = Join-Path $install $f.p; $bak = Join-Path $backup $f.p
    try {
      if (Test-Path -LiteralPath $bak) {
        for ($i = 0; $i -lt 20; $i++) {
          try { Copy-Item -LiteralPath $bak -Destination $dst -Force; break }
          catch {
            if ($i -eq 0) { try { Rename-Item -LiteralPath $dst -NewName ((Split-Path -Leaf $dst) + '.old-rb-' + $build + '-' + (Get-Random)) -Force } catch { } }
            Start-Sleep -Milliseconds 500
          }
        }
      }
      elseif ($f.isNew -and (Test-Path -LiteralPath $dst)) { Remove-Item -LiteralPath $dst -Force }
    } catch { Write-Log "restore failed: $($f.p): $_" }
  }
}
# همهٔ نمونه‌های همین برنامه (از همین پوشه)، نه فقط نمونه‌ای که اسکریپت را اجرا کرد
function Get-AppProcs {
  @(Get-Process -Name $exeBase -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and ([System.IO.Path]::GetFullPath($_.Path) -ieq [System.IO.Path]::GetFullPath($exe)) } catch { $false }
  })
}
$done = @()
# هر خطای پیش‌بینی‌نشده: بازگشت + نتیجه + باز کردن دوباره (هرگز بی‌نتیجه و بی‌برنامه نمی‌ماند)
trap {
  Write-Log "trap: $_"
  try { Restore-Backup $done } catch { }
  try { if (-not $script:relaunched) { Start-App | Out-Null } } catch { }
  try { Write-Result $false ("unexpected: " + $_) $true } catch { }
  exit 3
}
if ($AppPid -gt 0) {
  try { Wait-Process -Id $AppPid -Timeout 120 -ErrorAction SilentlyContinue } catch { }
}
if (Test-Path -LiteralPath $cancel) { Write-Log 'cancelled by the app; nothing changed'; exit 0 }
if ($AppPid -gt 0 -and (Get-Process -Id $AppPid -ErrorAction SilentlyContinue)) {
  Write-Result $false 'app still running; nothing changed' $false
  exit 4
}
# نمونه‌های دیگرِ باز (پنجرهٔ دوم): تا ۳۰ ثانیه صبر، بعد بسته می‌شوند تا فایل‌ها آزاد شوند
for ($i = 0; $i -lt 60 -and (Get-AppProcs).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 }
$others = Get-AppProcs
if ($others.Count -gt 0) {
  Write-Log "closing $($others.Count) other instance(s)"
  $others | ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch { } }
  Start-Sleep -Seconds 1
}
Write-Log 'app closed; copying'
Start-Sleep -Milliseconds 700
try {
  foreach ($f in $files) {
    $dst = Join-Path $install $f.p; $src = Join-Path $staged $f.p; $bak = Join-Path $backup $f.p
    if ((Get-Sha256 $src) -ne $f.h) { throw "staged file corrupted: $($f.p)" }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bak) | Out-Null
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    $f.isNew = -not (Test-Path -LiteralPath $dst)
    if (-not $f.isNew) { Copy-Item -LiteralPath $dst -Destination $bak -Force }
    $done += $f
    $copied = $false
    for ($i = 0; $i -lt 40 -and -not $copied; $i++) {
      try { Copy-Item -LiteralPath $src -Destination $dst -Force; $copied = $true }
      catch {
        # فایل قفل (آنتی‌ویروس، نمایه‌ساز، پردازهٔ دیگر): تغییر نام فایل در حال استفاده مجاز است ⇒ کنار، و کپی تازه
        if ($i -eq 3 -or $i -eq 15) {
          try { Rename-Item -LiteralPath $dst -NewName ((Split-Path -Leaf $dst) + '.old-' + $build + '-' + $i) -Force; Write-Log "moved locked file aside: $($f.p)" } catch { }
        }
        if ($i -eq 39) { throw }
        Start-Sleep -Milliseconds 500
      }
    }
  }
  foreach ($f in $files) {
    $h = Get-Sha256 (Join-Path $install $f.p)
    if ($h -ne $f.h) { throw "hash mismatch after copy: $($f.p)" }
  }
} catch {
  Write-Log "copy failed: $_"
  Restore-Backup $done
  Start-App | Out-Null
  Write-Result $false $_.Exception.Message $true
  exit 1
}
# بررسی سلامت: نسخهٔ تازه باید بالا بیاید و زنده بماند؛ وگرنه بازگشت خودکار و باز کردن نسخهٔ قبلی
try {
  Write-Log 'copied and verified; health check'
  $p = Start-App
  if (-not $p) { throw 'relaunch failed' }
  $window = $false
  for ($i = 0; $i -lt ($healthSeconds * 2); $i++) {
    Start-Sleep -Milliseconds 500
    $p.Refresh()
    if ($p.HasExited) { break }
    if (-not $window -and $p.MainWindowHandle -ne [IntPtr]::Zero) { $window = $true; Write-Log "window up after $([int]($i / 2))s" }
  }
  $p.Refresh()
  if ($p.HasExited -and $p.ExitCode -ne 0) { throw "new build exited early ($($p.ExitCode))" }
} catch {
  Write-Log "health check failed: $_"
  Restore-Backup $done
  $script:relaunched = $null
  Start-App | Out-Null
  Write-Result $false $_.Exception.Message $true
  exit 2
}
# پاک‌سازی فایل‌های کنارگذاشته (اگر هنوز قفل‌اند، برنامه در اجرای بعد پاکشان می‌کند)
Get-ChildItem -LiteralPath $install -Recurse -File -Filter '*.old-*' -ErrorAction SilentlyContinue | ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force } catch { } }
Write-Result $true 'ok' $false
exit 0
''';

/// اجرای یک فرایند (برای آزمون جایگزین‌پذیر؛ امضای سازگار با [Process.start]).
typedef ProcessStarter = Future<Object?> Function(
  String executable,
  List<String> arguments, {
  ProcessStartMode mode,
});

/// نوشتن اسکریپت (UTF-8 با BOM) و اجرای جدا از برنامه. پس از این، برنامه باید بسته شود.
///
/// برنامه فقط وقتی بسته می‌شود که خط «start» اسکریپت در `apply.log` دیده شود. اگر روش اول
/// (`cmd start /min` با پنجرهٔ پنهان) در [startTimeout] شروع نشد، روش‌های بعدی امتحان می‌شوند؛
/// اسکریپت قفل دارد و دو نمونه هم‌زمان اجرا نمی‌شوند. اگر هیچ‌کدام شروع نشد
/// [UpdateException] با کد `launch` (برنامه باز می‌ماند و چیزی تغییر نکرده).
Future<File> launchApply({
  required StagedUpdate staged,
  required String installDir,
  required int appPid,
  required String exeName,
  int healthSeconds = 15,
  ProcessStarter starter = Process.start,
  Duration startTimeout = const Duration(seconds: 30),
  void Function(String line)? log,
}) async {
  final sep = Platform.pathSeparator;
  final script = File('${staged.dir.path}${sep}apply.ps1');
  final marker = File('${staged.dir.path}${sep}apply.log');
  final cancel = File('${staged.dir.path}${sep}cancel');
  for (final f in [
    marker,
    cancel,
    File('${staged.dir.path}${sep}result.json'),
  ]) {
    if (f.existsSync()) f.deleteSync();
  }
  script.writeAsBytesSync([
    0xEF,
    0xBB,
    0xBF,
    ...utf8.encode(
      applyScript(
        staged: staged,
        installDir: installDir,
        exeName: exeName,
        healthSeconds: healthSeconds,
      ),
    ),
  ]);
  final sysRoot = Platform.environment['SystemRoot'] ?? r'C:\Windows';
  final psFull = '$sysRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  final psExe = File(psFull).existsSync() ? psFull : 'powershell.exe';
  List<String> ps(String exe) => [
    exe,
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script.path,
    '-AppPid',
    '$appPid',
  ];
  // روش اول: کنسول تازهٔ کوچک‌شده که PowerShell بلافاصله پنهانش می‌کند (powershell جدا و
  // بی‌کنسول در Windows PowerShell 5.1 اصلاً شروع نمی‌شود؛ در CI دیده شد).
  final start = ['cmd.exe', '/d', '/c', 'start', '', '/min'];
  final p = ps(psExe);
  final attempts = <(String, List<String>)>[
    (
      'cmd-start-hidden',
      [...start, p.first, '-WindowStyle', 'Hidden', ...p.sublist(1)],
    ),
    ('cmd-start-min', [...start, ...p]),
    ('powershell-detached', p),
  ];
  for (final (via, cmd) in attempts) {
    try {
      await starter(cmd.first, cmd.sublist(1), mode: ProcessStartMode.detached);
    } on Object catch (e) {
      log?.call('apply launch $via failed: $e');
      continue;
    }
    final until = DateTime.now().add(startTimeout);
    while (DateTime.now().isBefore(until)) {
      if (marker.existsSync() && marker.lengthSync() > 0) {
        log?.call('apply launched via $via');
        return script;
      }
      await Future<void>.delayed(const Duration(milliseconds: 200));
    }
    log?.call(
      'apply launch $via: no start marker in ${startTimeout.inSeconds}s',
    );
  }
  // اسکریپتی که دیرتر بالا بیاید با دیدن این فایل بدون هیچ تغییری کنار می‌رود.
  cancel.writeAsStringSync(
    'cancelled ${DateTime.now().toUtc().toIso8601String()}',
  );
  throw const UpdateException('launch', 'apply script did not start');
}

/// نتیجهٔ آخرین اعمال (پس از باز شدن دوبارهٔ برنامه).
final class ApplyResult {
  const ApplyResult(
    this.ok,
    this.build,
    this.rolledBack,
    this.message, {
    this.relaunched = false,
    this.window = false,
  });
  final bool ok;
  final int build;
  final bool rolledBack;
  final String message;

  /// اسکریپت برنامه را دوباره باز کرد و پنجره‌اش دیده شد.
  final bool relaunched;
  final bool window;
}

/// خواندن و پاک کردن نتیجهٔ اعمال‌های قبلی در [stagingRoot] (و پوشه‌های موقت).
///
/// آخرین نتیجه در `stagingRoot/last-apply.json` نگه داشته می‌شود (تشخیص و آزمون سرتاسری).
/// با [installDir]، فایل‌های کنارگذاشتهٔ `*.old-*` (قفل‌شده هنگام اعمال) هم پاک می‌شوند.
ApplyResult? takeApplyResult(Directory stagingRoot, {Directory? installDir}) {
  if (installDir != null) _sweepOld(installDir);
  if (!stagingRoot.existsSync()) return null;
  ApplyResult? last;
  String? lastRaw;
  for (final d in stagingRoot.listSync().whereType<Directory>()) {
    final f = File('${d.path}${Platform.pathSeparator}result.json');
    if (!f.existsSync()) continue;
    try {
      final raw = f.readAsStringSync();
      final j = jsonDecode(raw) as Map<String, Object?>;
      final r = ApplyResult(
        j['ok'] == true,
        j['build'] is int ? j['build']! as int : 0,
        j['rolled_back'] == true,
        '${j['message'] ?? ''}',
        relaunched:
            (j['relaunched_pid'] is int) && (j['relaunched_pid']! as int) > 0,
        window: j['window'] == true,
      );
      if (last == null || r.build > last.build) {
        last = r;
        lastRaw = raw;
      }
      d.deleteSync(recursive: true);
    } on Object {
      // فایل نیمه‌کاره: دفعهٔ بعد
    }
  }
  if (lastRaw != null) {
    try {
      File('${stagingRoot.path}${Platform.pathSeparator}last-apply.json')
          .writeAsStringSync(lastRaw);
    } on Object {
      // فقط برای تشخیص
    }
  }
  return last;
}

void _sweepOld(Directory installDir) {
  try {
    if (!installDir.existsSync()) return;
    final old = RegExp(r'\.old-(rb-)?\d+-\d+$');
    for (final e in installDir.listSync(recursive: true)) {
      if (e is File && old.hasMatch(e.path)) {
        try {
          e.deleteSync();
        } on Object {
          // هنوز قفل: دفعهٔ بعد
        }
      }
    }
  } on Object {
    // اختیاری
  }
}
