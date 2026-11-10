import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// Loads the REAL bundled Vazirmatn (and the SDK's Material icons) into the test engine, so
/// goldens show actual Persian shaping instead of the Ahem test font.
Future<void> loadPayeshFonts() async {
  Future<ByteData> f(String p) async {
    final file = File(p);
    if (!file.existsSync()) fail('font missing: $p');
    return ByteData.sublistView(Uint8List.fromList(file.readAsBytesSync()));
  }

  final vazir = FontLoader('packages/payesh_ui/Vazirmatn');
  for (final w in ['Regular', 'Medium', 'Bold']) {
    vazir.addFont(f('fonts/Vazirmatn-$w.ttf'));
  }
  await vazir.load();
  // flutter_tester lives in <flutter>/bin/cache/artifacts/engine/<platform>/
  final artifacts = File(Platform.resolvedExecutable).parent.parent.parent.path;
  final icons = FontLoader('MaterialIcons')
    ..addFont(f('$artifacts/material_fonts/MaterialIcons-Regular.otf'));
  await icons.load();
}

/// Golden comparator that tolerates sub-pixel anti-aliasing noise between Linux hosts
/// (≤ 0.5 % of pixels). Layout, text, RTL and colour changes are far above this.
class TolerantComparator extends LocalFileComparator {
  TolerantComparator(super.testFile);

  static const double maxDiff = 0.005;

  @override
  Future<bool> compare(Uint8List imageBytes, Uri golden) async {
    final r = await GoldenFileComparator.compareLists(
      imageBytes,
      await getGoldenBytes(golden),
    );
    if (r.passed || r.diffPercent <= maxDiff) {
      r.dispose();
      return true;
    }
    final msg = await generateFailureOutput(r, golden, basedir);
    r.dispose();
    throw FlutterError(msg);
  }
}
