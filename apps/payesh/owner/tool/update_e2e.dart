// آزمون سرتاسری به‌روزرسانی درجای پنل مالک روی Windows واقعی (CI، owner-windows).
//
//   dart run tool/update_e2e.dart --manifest <owner-update.json> --blobs <dir> \
//        --install <installed app dir> --staging <dir> --pid <running payesh_owner.exe pid>
//
// همان کد برنامه (planUpdate ⇐ downloadUpdate ⇐ launchApply) با «HTTP» از فایل‌های محلی:
// فقط فایل‌های تغییرکرده دانلود و بررسی می‌شوند، اسکریپت اعمال جدا اجرا می‌شود و منتظر بسته
// شدن برنامه می‌ماند. نتیجه را خود CI از result.json می‌خواند.
// Last line: OWNER-UPDATE-E2E-STAGED changed=N download=B total=T

import 'dart:io';

import 'package:payesh_owner/src/update/owner_update.dart';

final class _FileHttp implements UpdateHttp {
  _FileHttp(this.manifest, this.blobs);
  final File manifest;
  final Directory blobs;

  @override
  Future<List<int>?> get(
    Uri url, {
    int maxBytes = 1 << 30,
    void Function(int received)? onBytes,
  }) async {
    final File f = url.path.endsWith('owner-update.json')
        ? manifest
        : File(
            '${blobs.path}${Platform.pathSeparator}${url.pathSegments.last}',
          );
    if (!f.existsSync()) return null;
    final b = f.readAsBytesSync();
    if (b.length > maxBytes) throw const UpdateException('network', 'too big');
    return b;
  }

  @override
  void close() {}
}

Future<void> main(List<String> argv) async {
  final a = <String, String>{};
  for (var i = 0; i + 1 < argv.length; i += 2) {
    a[argv[i].replaceFirst('--', '')] = argv[i + 1];
  }
  for (final k in ['manifest', 'blobs', 'install', 'staging', 'pid']) {
    if (!a.containsKey(k)) {
      stderr.writeln('missing --$k');
      exit(64);
    }
  }
  final http = _FileHttp(File(a['manifest']!), Directory(a['blobs']!));
  final m = await fetchManifest(
    http,
    url: Uri.parse('https://e2e.invalid/owner-update.json'),
    schema: ownerUpdateSchema,
  );
  final plan = await planUpdate(m, Directory(a['install']!));
  if (plan.upToDate) {
    stdout.writeln('OWNER-UPDATE-E2E-FAIL nothing changed');
    exit(1);
  }
  final staged = await downloadUpdate(
    plan,
    http: http,
    stagingRoot: Directory(a['staging']!),
    blobBase: Uri.parse('https://e2e.invalid/files/'),
  );
  for (final f in plan.changed) {
    stdout.writeln('changed: ${f.path} ${f.size} B (gz ${f.gzSize} B)');
  }
  final script = await launchApply(
    staged: staged,
    installDir: a['install']!,
    appPid: int.parse(a['pid']!),
    exeName: ownerExe,
    log: stdout.writeln,
  );
  stdout.writeln('script: ${script.path}');
  stdout.writeln(
    'OWNER-UPDATE-E2E-STAGED changed=${plan.changed.length} '
    'download=${plan.downloadBytes} total=${plan.totalBytes}',
  );
}
