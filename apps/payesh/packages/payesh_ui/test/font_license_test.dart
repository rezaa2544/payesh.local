import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('bundled Vazirmatn is unmodified (SHA256SUMS) and ships with its OFL-1.1 licence', () {
    final sums = File('fonts/SHA256SUMS')
        .readAsLinesSync()
        .where((l) => l.trim().isNotEmpty);
    final names = <String>[];
    for (final l in sums) {
      final [hash, name] = l.split(RegExp(r'\s+'));
      names.add(name);
      expect(
        sha256.convert(File('fonts/$name').readAsBytesSync()).toString(),
        hash,
        reason: name,
      );
    }
    expect(
      names,
      containsAll([
        'Vazirmatn-Regular.ttf',
        'Vazirmatn-Medium.ttf',
        'Vazirmatn-Bold.ttf',
        'OFL.txt',
      ]),
    );
    final ofl = File('fonts/OFL.txt').readAsStringSync();
    expect(ofl, contains('SIL Open Font License, Version 1.1'));
    expect(ofl, contains('Vazirmatn Project Authors'));
    final ttfs = Directory('fonts')
        .listSync()
        .where((e) => e.path.endsWith('.ttf'));
    expect(ttfs.length, 3, reason: 'every bundled font is listed and hashed');
    final pub = File('pubspec.yaml').readAsStringSync();
    for (final w in ['Regular', 'Medium', 'Bold']) {
      expect(pub, contains('fonts/Vazirmatn-$w.ttf'));
    }
  });
}
