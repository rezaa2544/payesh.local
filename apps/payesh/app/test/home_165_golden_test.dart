// Row 165 — golden screenshots of the redesigned school-app home and «حافظهٔ ابری» on a phone,
// rendered with the REAL bundled Vazirmatn (not Ahem). Regenerate intentionally with
//   flutter test --update-goldens test/home_165_golden_test.dart
@Tags(['golden'])
library;

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'school_support.dart';
import 'system_wave12_test.dart' show FakeAdmin, open;

Future<void> _fonts() async {
  Future<ByteData> f(String p) async {
    final file = File(p);
    if (!file.existsSync()) fail('font missing: $p');
    return ByteData.sublistView(Uint8List.fromList(file.readAsBytesSync()));
  }

  for (final family in ['Vazirmatn', 'packages/payesh_ui/Vazirmatn']) {
    final l = FontLoader(family);
    for (final w in ['Regular', 'Medium', 'Bold']) {
      l.addFont(f('../packages/payesh_ui/fonts/Vazirmatn-$w.ttf'));
    }
    await l.load();
  }
  final artifacts = File(Platform.resolvedExecutable).parent.parent.parent.path;
  final icons = FontLoader('MaterialIcons')
    ..addFont(f('$artifacts/material_fonts/MaterialIcons-Regular.otf'));
  await icons.load();
}

/// Tolerates sub-pixel anti-aliasing noise between Linux hosts (≤ 0.5 % of pixels).
class _Tolerant extends LocalFileComparator {
  _Tolerant(super.testFile);

  @override
  Future<bool> compare(Uint8List imageBytes, Uri golden) async {
    final r = await GoldenFileComparator.compareLists(
      imageBytes,
      await getGoldenBytes(golden),
    );
    if (r.passed || r.diffPercent <= 0.005) {
      r.dispose();
      return true;
    }
    final msg = await generateFailureOutput(r, golden, basedir);
    r.dispose();
    throw FlutterError(msg);
  }
}

Future<void> _seed(MemorySchool s) async {
  await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
}

void _phone(WidgetTester tester, Brightness b) {
  tester.view.physicalSize = const Size(1080, 2280);
  tester.view.devicePixelRatio = 2.625;
  tester.platformDispatcher.platformBrightnessTestValue = b;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
}

void main() {
  setUpAll(() async {
    await _fonts();
    goldenFileComparator = _Tolerant(
      Uri.parse('test/home_165_golden_test.dart'),
    );
  });

  for (final b in Brightness.values) {
    testWidgets('golden home_165_${b.name}', (tester) async {
      _phone(tester, b);
      await bootSchool(
        tester,
        role: 'manager',
        seed: _seed,
        school: 'users,accounts,classes,schedule,followup,reports,server,attendance-report',
      );
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('goldens/home_165_${b.name}.png'),
      );
    });
  }

  testWidgets('golden cloud_165_offline_dark', (tester) async {
    _phone(tester, Brightness.dark);
    await open(tester, 'cloud', admin: FakeAdmin()..online = false);
    await tester.pumpAndSettle();
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/cloud_165_offline_dark.png'),
    );
  });

  testWidgets('golden cloud_165_dark', (tester) async {
    _phone(tester, Brightness.dark);
    await open(tester, 'cloud');
    await tester.pumpAndSettle();
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/cloud_165_dark.png'),
    );
  });
}
