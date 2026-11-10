// Row 75 / constitution clause 25 (D‑36): the native client's ONLY cloud data path is the
// Gateway. Static guard over every native package + app: no database driver, no object-storage
// SDK/endpoint, no direct DB URL — in source or in the resolved dependency graph.
import 'dart:io';

import 'package:test/test.dart';

final Directory payesh = Directory(
  Directory('../..').absolute.uri.normalizePath().toFilePath(),
);

Iterable<File> dartSources() sync* {
  for (final d in ['packages', 'app/lib']) {
    final dir = Directory('${payesh.path}/$d');
    if (!dir.existsSync()) continue;
    for (final e in dir.listSync(recursive: true)) {
      final p = e.path.replaceAll(r'\', '/');
      if (e is File &&
          p.endsWith('.dart') &&
          p.contains('/lib/') &&
          !p.contains('/.dart_tool/')) {
        yield e;
      }
    }
  }
}

void main() {
  final forbiddenSource = RegExp(
    r'''(postgres(ql)?://|mysql://|mongodb(\+srv)?://|redis://|package:(postgres|pg|mysql1|mysql_client|mongo_dart|redis|aws_|minio|s3)|arvanstorage|\.s3\.|amazonaws\.com)''',
    caseSensitive: false,
  );

  test('the scan actually covers the native sources', () {
    final files = dartSources().toList();
    expect(files.length, greaterThan(20));
    expect(files.any((f) => f.path.endsWith('gateway_transport.dart')), isTrue);
  });

  test('no DB driver / object storage / direct DB URL in native lib code', () {
    final hits = <String>[];
    for (final f in dartSources()) {
      final p = f.path.replaceAll(r'\', '/');
      final src = f.readAsStringSync();
      for (final m in forbiddenSource.allMatches(src)) {
        hits.add('$p: ${m.group(0)}');
      }
    }
    expect(hits, isEmpty);
  });

  test('cloud endpoints used by the client are exclusively /api/gw/v1/*', () {
    final gw = File(
      '${payesh.path}/packages/payesh_sync/lib/src/gateway_transport.dart',
    ).readAsStringSync();
    final paths = RegExp(r"'(/api/[^']+)'").allMatches(gw).map((m) => m[1]);
    expect(paths, isNotEmpty);
    expect(paths.every((p) => p!.startsWith('/api/gw/v1/')), isTrue);
  });

  test('resolved dependency graph has no DB / cloud-storage package', () {
    final lock = File('${payesh.path}/pubspec.lock').readAsStringSync();
    final names = RegExp(
      r'^  ([a-z0-9_]+):$',
      multiLine: true,
    ).allMatches(lock).map((m) => m[1]!).toList();
    expect(names, contains('crypto'));
    final bad = names.where(
      (n) => RegExp(
        r'^(postgres|postgresql.*|pg|mysql.*|mongo.*|redis.*|aws_.*|minio.*|s3.*|firebase.*|supabase.*|amplify.*)$',
      ).hasMatch(n),
    );
    expect(bad, isEmpty);
  });
}
