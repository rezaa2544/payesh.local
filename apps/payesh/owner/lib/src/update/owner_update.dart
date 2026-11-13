// به‌روزرسانی درجای پنل مالک (ویندوز): فقط فایل‌های تغییرکرده دانلود می‌شوند —
// همان روش پنل کاربران (server/update.js):
//   ۱) مانیفست منتشرشده (owner-update.json در owner-continuous) خوانده می‌شود؛
//   ۲) SHA-256 هر فایل نصب‌شده با مانیفست مقایسه می‌شود؛
//   ۳) فقط فایل‌های متفاوت (فشرده، gzip) دانلود و ابتدا در پوشهٔ موقت گذاشته می‌شوند —
//      اول از آینهٔ صندوقچهٔ آروان (payesh/updates/owner/<sha>.gz، داخل ایران سریع‌تر)، اگر
//      نبود از GitHub؛ پس از دانلود از GitHub، نسخه‌ای در آینه گذاشته می‌شود تا سیستم‌های دیگر
//      از آروان بگیرند؛
//   ۴) هش و اندازهٔ همه بررسی می‌شود؛ اگر یکی ناجور بود هیچ‌چیز اعمال نمی‌شود؛
//   ۵) پس از بسته شدن برنامه، اسکریپت PowerShell فایل‌ها را جایگزین می‌کند (نسخهٔ قبلی در
//      پشتیبان می‌ماند)، هش‌ها را دوباره بررسی می‌کند و برنامه را باز می‌کند؛ اگر نسخهٔ تازه
//      بالا نیاید، نسخهٔ قبلی برگردانده می‌شود.
// اعتماد: مانیفست فقط از GitHub (TLS) خوانده می‌شود، هرگز از آینه؛ آینه فقط فایل‌هایی را
// می‌دهد که هششان باید با همان مانیفست یکی باشد.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

const String ownerUpdateSchema = 'payesh-owner-update/1';
const String ownerRepo = 'rezaa2544/payesh.local';
final Uri defaultManifestUrl = Uri.parse(
  'https://github.com/$ownerRepo/releases/download/owner-continuous/owner-update.json',
);
final Uri defaultBlobBase = Uri.parse(
  'https://github.com/$ownerRepo/releases/download/owner-files/',
);
const String mirrorPrefix = 'payesh/updates/owner/';

/// شمارهٔ ساخت همین برنامه (CI: `--dart-define=PAYESH_OWNER_BUILD=<run_number>`).
const int ownerBuild = int.fromEnvironment('PAYESH_OWNER_BUILD');

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

  String get messageFa => switch (code) {
    'bad_manifest' => 'فهرست به‌روزرسانی معتبر نیست.',
    'network' => 'به سرور به‌روزرسانی نرسیدیم. اتصال اینترنت را بررسی کنید.',
    'bad_hash' => 'فایل دریافت‌شده با فهرست یکی نبود؛ هیچ تغییری اعمال نشد. دوباره امتحان کنید.',
    'io' => 'نوشتن فایل‌های به‌روزرسانی روی دیسک ممکن نشد.',
    'launch' => 'اجرای نصب‌کنندهٔ به‌روزرسانی ممکن نشد؛ برنامه باز می‌ماند و چیزی تغییر نکرد. دوباره امتحان کنید یا نصب‌کنندهٔ کامل را اجرا کنید.',
    _ => 'به‌روزرسانی ممکن نشد ($code).',
  };
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

final class OwnerUpdateManifest {
  const OwnerUpdateManifest({
    required this.build,
    required this.commit,
    required this.files,
    this.apk,
  });

  final int build;
  final String commit;
  final List<UpdateFile> files;
  final ApkInfo? apk;

  int get totalBytes => files.fold(0, (a, f) => a + f.size);

  /// تجزیهٔ سخت‌گیرانه: هر چیز ناشناخته یا مسیر خطرناک ⇒ [UpdateException].
  static OwnerUpdateManifest parse(String text) {
    Never bad(String why) => throw UpdateException('bad_manifest', why);
    final Object? j;
    try {
      j = jsonDecode(text);
    } on FormatException {
      bad('json');
    }
    if (j is! Map<String, Object?>) bad('root');
    if (j['schema'] != ownerUpdateSchema) bad('schema');
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
    return OwnerUpdateManifest(
      build: build,
      commit: commit,
      files: files,
      apk: apk,
    );
  }
}

final class UpdatePlan {
  const UpdatePlan(this.manifest, this.changed);
  final OwnerUpdateManifest manifest;
  final List<UpdateFile> changed;

  bool get upToDate => changed.isEmpty;
  int get downloadBytes => changed.fold(0, (a, f) => a + f.gzSize);
  int get totalBytes => manifest.totalBytes;
}

/// مقایسهٔ فایل‌های نصب‌شده با مانیفست (هش در Isolate جدا).
Future<UpdatePlan> planUpdate(
  OwnerUpdateManifest m,
  Directory installDir,
) async {
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
  /// null ⇒ ۴۰۴.
  Future<List<int>?> get(Uri url, {int maxBytes});
  void close();
}

final class IoUpdateHttp implements UpdateHttp {
  IoUpdateHttp({SecurityContext? context, Duration? timeout})
    : _timeout = timeout ?? const Duration(seconds: 60),
      _client = HttpClient(context: context)
        ..connectionTimeout = const Duration(seconds: 20);
  final HttpClient _client;
  final Duration _timeout;

  @override
  Future<List<int>?> get(Uri url, {int maxBytes = _maxFileBytes}) async {
    try {
      final req = await _client.getUrl(url).timeout(_timeout);
      req.followRedirects = true; // GitHub ⇒ objects.githubusercontent.com
      req.maxRedirects = 5;
      final res = await req.close().timeout(_timeout);
      if (res.statusCode == 404) {
        await res.drain<void>();
        return null;
      }
      if (res.statusCode != 200) {
        await res.drain<void>();
        throw UpdateException('network', 'HTTP ${res.statusCode}');
      }
      final b = BytesBuilder(copy: false);
      await for (final c in res.timeout(_timeout)) {
        b.add(c);
        if (b.length > maxBytes) {
          throw const UpdateException('bad_hash', 'too large');
        }
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

/// آینهٔ صندوقچه: خواندن/نوشتن `payesh/updates/owner/<sha>.gz`.
abstract interface class UpdateMirror {
  Future<List<int>?> get(String blob);
  Future<void> put(String blob, List<int> gz);
}

/// خواندن مانیفست از GitHub.
Future<OwnerUpdateManifest> fetchManifest(UpdateHttp http, {Uri? url}) async {
  final u = url ?? defaultManifestUrl;
  final b = await http.get(
    u.replace(
      queryParameters: {'t': '${DateTime.now().millisecondsSinceEpoch}'},
    ),
    maxBytes: 4 * 1024 * 1024,
  );
  if (b == null) throw const UpdateException('network', 'manifest 404');
  return OwnerUpdateManifest.parse(utf8.decode(b));
}

/// به‌روزرسانیِ آماده (همهٔ فایل‌ها دانلود و بررسی شده‌اند).
final class StagedUpdate {
  const StagedUpdate(this.plan, this.dir, this.fromMirror, this.fromOrigin);
  final UpdatePlan plan;
  final Directory dir;
  final int fromMirror;
  final int fromOrigin;
  Directory get files => Directory('${dir.path}${Platform.pathSeparator}files');
}

/// دانلود فقط فایل‌های تغییرکرده در `stagingRoot/<build>/files` و بررسی هش همه.
Future<StagedUpdate> downloadUpdate(
  UpdatePlan plan, {
  required UpdateHttp http,
  required Directory stagingRoot,
  UpdateMirror? mirror,
  Uri? blobBase,
  void Function(int doneBytes, int totalBytes)? onProgress,
}) async {
  final base = blobBase ?? defaultBlobBase;
  final dir = Directory(
    '${stagingRoot.path}${Platform.pathSeparator}${plan.manifest.build}',
  );
  try {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
    dir.createSync(recursive: true);
  } on FileSystemException catch (e) {
    throw UpdateException('io', '$e');
  }
  var done = 0, fromMirror = 0, fromOrigin = 0;
  for (final f in plan.changed) {
    List<int>? gz;
    var mirrored = false;
    if (mirror != null) {
      try {
        gz = await mirror.get(f.blob);
        mirrored = gz != null;
      } on Object {
        gz = null;
      }
    }
    List<int>? raw = gz == null ? null : _gunzipChecked(gz, f);
    if (raw == null) {
      mirrored = false;
      gz = await http.get(base.resolve(f.blob), maxBytes: f.gzSize + 1024);
      if (gz == null) throw UpdateException('network', '${f.blob} 404');
      raw = _gunzipChecked(gz, f);
      if (raw == null) throw UpdateException('bad_hash', f.path);
      if (mirror != null) {
        try {
          await mirror.put(f.blob, gz);
        } on Object {
          // آینه اختیاری است
        }
      }
    }
    try {
      final out = File(
        '${dir.path}${Platform.pathSeparator}files${Platform.pathSeparator}${_native(f.path)}',
      );
      out.parent.createSync(recursive: true);
      out.writeAsBytesSync(raw, flush: true);
    } on FileSystemException catch (e) {
      throw UpdateException('io', '$e');
    }
    if (mirrored) {
      fromMirror++;
    } else {
      fromOrigin++;
    }
    done += f.gzSize;
    onProgress?.call(done, plan.downloadBytes);
  }
  File('${dir.path}${Platform.pathSeparator}plan.json').writeAsStringSync(
    jsonEncode({
      'build': plan.manifest.build,
      'commit': plan.manifest.commit,
      'files': [
        for (final f in plan.changed) {'path': f.path, 'sha256': f.sha256},
      ],
    }),
  );
  return StagedUpdate(plan, dir, fromMirror, fromOrigin);
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
  String exeName = 'payesh_owner.exe',
  int healthSeconds = 15,
}) {
  final files = staged.plan.changed;
  final b = StringBuffer()
    ..writeln(
      '# Payesh owner panel — in-place update to build ${staged.plan.manifest.build}',
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
    ..writeln('\$build = ${staged.plan.manifest.build}')
    ..writeln('\$files = @(');
  for (final f in files) {
    b.writeln(
      '  @{ p = ${_psQuote(f.path.replaceAll('/', r'\'))}; h = ${_psQuote(f.sha256)} }',
    );
  }
  b
    ..writeln(')')
    ..writeln(r'''
$ProgressPreference = 'SilentlyContinue'
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
function Write-Result([bool]$ok, [string]$msg, [bool]$rolledBack) {
  Write-Log "result ok=$ok rolled_back=$rolledBack $msg"
  $o = [ordered]@{ ok = $ok; build = $build; rolled_back = $rolledBack; message = $msg; at = (Get-Date).ToUniversalTime().ToString('o') }
  [System.IO.File]::WriteAllText($resultFile, ($o | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
}
function Restore-Backup($list) {
  foreach ($f in $list) {
    $dst = Join-Path $install $f.p; $bak = Join-Path $backup $f.p
    try {
      if (Test-Path -LiteralPath $bak) { Copy-Item -LiteralPath $bak -Destination $dst -Force }
      elseif ($f.isNew -and (Test-Path -LiteralPath $dst)) { Remove-Item -LiteralPath $dst -Force }
    } catch { }
  }
}
$done = @()
# هر خطای پیش‌بینی‌نشده: بازگشت + نتیجه (هرگز بی‌نتیجه نمی‌ماند)
trap {
  Write-Log "trap: $_"
  try { Restore-Backup $done } catch { }
  try { Write-Result $false ("unexpected: " + $_) $true } catch { }
  try { Start-Process -FilePath $exe -WorkingDirectory $install } catch { }
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
Write-Log 'app closed; copying'
Start-Sleep -Milliseconds 700
try {
  foreach ($f in $files) {
    $dst = Join-Path $install $f.p; $src = Join-Path $staged $f.p; $bak = Join-Path $backup $f.p
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bak) | Out-Null
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    $f.isNew = -not (Test-Path -LiteralPath $dst)
    if (-not $f.isNew) { Copy-Item -LiteralPath $dst -Destination $bak -Force }
    $done += $f
    for ($i = 0; $i -lt 20; $i++) {
      try { Copy-Item -LiteralPath $src -Destination $dst -Force; break }
      catch { if ($i -eq 19) { throw }; Start-Sleep -Milliseconds 500 }
    }
  }
  foreach ($f in $files) {
    $h = (Get-FileHash -LiteralPath (Join-Path $install $f.p) -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $f.h) { throw "hash mismatch after copy: $($f.p)" }
  }
} catch {
  Restore-Backup $done
  Write-Result $false $_.Exception.Message $true
  try { Start-Process -FilePath $exe -WorkingDirectory $install } catch { }
  exit 1
}
# بررسی سلامت: نسخهٔ تازه باید بالا بیاید و زنده بماند؛ وگرنه بازگشت خودکار
try {
  Write-Log 'copied and verified; health check'
  $p = Start-Process -FilePath $exe -WorkingDirectory $install -PassThru''')
    ..writeln('  Start-Sleep -Seconds $healthSeconds')
    ..writeln(r'''  $p.Refresh()
  if ($p.HasExited -and $p.ExitCode -ne 0) { throw "new build exited early ($($p.ExitCode))" }
} catch {
  Restore-Backup $done
  Write-Result $false $_.Exception.Message $true
  try { Start-Process -FilePath $exe -WorkingDirectory $install } catch { }
  exit 2
}
Write-Result $true 'ok' $false
exit 0''');
  return b.toString();
}

/// اجرای یک فرایند (برای آزمون جایگزین‌پذیر؛ امضای سازگار با [Process.start]).
typedef ProcessStarter = Future<Object?> Function(
  String executable,
  List<String> arguments, {
  ProcessStartMode mode,
});

/// نوشتن اسکریپت (UTF-8 با BOM) و اجرای جدا از برنامه. پس از این، برنامه باید بسته شود.
///
/// برنامه فقط وقتی بسته می‌شود که خط «start» اسکریپت در `apply.log` دیده شود. اگر روش اول
/// (`powershell.exe` جدا و بی‌پنجره) در [startTimeout] شروع نشد، روش دوم (`cmd start /min`)
/// امتحان می‌شود؛ اسکریپت قفل دارد و دو نمونه هم‌زمان اجرا نمی‌شوند. اگر هیچ‌کدام شروع نشد
/// [UpdateException] با کد `launch` (برنامه باز می‌ماند و چیزی تغییر نکرده).
Future<File> launchApply({
  required StagedUpdate staged,
  required String installDir,
  required int appPid,
  String exeName = 'payesh_owner.exe',
  int healthSeconds = 15,
  ProcessStarter starter = Process.start,
  Duration startTimeout = const Duration(seconds: 20),
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
  final ps = [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script.path,
    '-AppPid',
    '$appPid',
  ];
  final attempts = <(String, List<String>)>[
    ('powershell-detached', ps),
    ('cmd-start-min', ['cmd.exe', '/d', '/c', 'start', '', '/min', ...ps]),
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
  const ApplyResult(this.ok, this.build, this.rolledBack, this.message);
  final bool ok;
  final int build;
  final bool rolledBack;
  final String message;
}

/// خواندن و پاک کردن نتیجهٔ اعمال‌های قبلی در [stagingRoot] (و پوشه‌های موقت).
ApplyResult? takeApplyResult(Directory stagingRoot) {
  if (!stagingRoot.existsSync()) return null;
  ApplyResult? last;
  for (final d in stagingRoot.listSync().whereType<Directory>()) {
    final f = File('${d.path}${Platform.pathSeparator}result.json');
    if (!f.existsSync()) continue;
    try {
      final j = jsonDecode(f.readAsStringSync()) as Map<String, Object?>;
      final r = ApplyResult(
        j['ok'] == true,
        j['build'] is int ? j['build']! as int : 0,
        j['rolled_back'] == true,
        '${j['message'] ?? ''}',
      );
      if (last == null || r.build > last.build) last = r;
      d.deleteSync(recursive: true);
    } on Object {
      // فایل نیمه‌کاره: دفعهٔ بعد
    }
  }
  return last;
}
