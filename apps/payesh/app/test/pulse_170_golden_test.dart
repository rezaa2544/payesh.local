// Row 170 — golden screenshots of the «نبض» panel (option A) in the installed app: the manager's
// dashboard on a Windows-size window (sidebar on the right) and on a phone, REAL Vazirmatn.
// Regenerate intentionally with
//   flutter test --update-goldens test/pulse_170_golden_test.dart
@Tags(['golden'])
library;

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'school_support.dart';
import 'reports_wave11_test.dart' show seed;

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

Future<void> _boot(WidgetTester tester) async {
  await bootSchool(
    tester,
    role: 'manager',
    seed: (s) async {
      await seed(s, teacher: 11);
      await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
    },
  );
  await settle(tester);
}

void main() {
  setUpAll(() async {
    await _fonts();
    goldenFileComparator = _Tolerant(
      Uri.parse('test/pulse_170_golden_test.dart'),
    );
  });

  testWidgets('golden pulse_170_wide', (tester) async {
    tester.view.physicalSize = const Size(1366, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await _boot(tester);
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/pulse_170_wide.png'),
    );
  });

  testWidgets('golden pulse_170_phone', (tester) async {
    tester.view.physicalSize = const Size(1080, 2280);
    tester.view.devicePixelRatio = 2.625;
    addTearDown(tester.view.reset);
    await _boot(tester);
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/pulse_170_phone.png'),
    );
  });
}
