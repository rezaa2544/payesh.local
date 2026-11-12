// Row 126: the native owner app must not lose anything of the retired WebView panel.
// Re-derives texts, pages, roles and permissions from apps/owner-panel/web/app.js (via
// tools/owner-native-texts.mjs) and compares them with the Dart tables.
import 'dart:convert';
import 'dart:io';

import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:test/test.dart';

void main() {
  final root = Directory.current.uri.resolve('../../../../').toFilePath();
  final script = File('${root}tools/owner-native-texts.mjs');
  final webApp = File('${root}apps/owner-panel/web/app.js');

  test(
    'errors, pages, roles and caps equal the web panel',
    () async {
      final r = await Process.run('node', [script.path]);
      expect(r.exitCode, 0, reason: '${r.stderr}');
      final j = jsonDecode(r.stdout as String) as Map<String, Object?>;
      expect(j['api'], OwnerApi.prefix);
      expect(Map<String, Object?>.from(j['errors']! as Map), ownerErrors);
      final pages = [
        for (final p in j['pages']! as List<Object?>)
          ((p! as Map)['id'] as String, (p as Map)['title'] as String),
      ];
      expect(pages, ownerPages);
      final roles = Map<String, Object?>.from(j['roles']! as Map);
      expect(roles, {for (final r in OwnerRole.values) r.wire: r.label});
      final caps = Map<String, Object?>.from(j['caps']! as Map);
      for (final role in OwnerRole.values) {
        final want = List<String>.from(caps[role.wire]! as List)..sort();
        final got = OwnerCaps.of(role).granted.toList()..sort();
        expect(got, want, reason: role.wire);
      }
    },
    skip: webApp.existsSync()
        ? false
        : 'web panel source removed — parity is pinned by the Dart tables',
  );
}
