// Row 169 (D-50): the pure-Dart codecs used by the 32-bit Windows edition must be
// byte-compatible with dart:io's native zlib in both directions.
import 'dart:convert';
import 'dart:io' as io;
import 'dart:math';
import 'dart:typed_data';

import 'package:payesh_core/src/io/zlib_dart.dart';
import 'package:test/test.dart';

List<Uint8List> samples() {
  final r = Random(169);
  return [
    Uint8List(0),
    Uint8List.fromList([7]),
    Uint8List.fromList(utf8.encode('سلام پایش ' * 500)),
    Uint8List.fromList(List.generate(70000, (_) => r.nextInt(256))),
    Uint8List.fromList(List.generate(200000, (i) => (i * 7) % 13)),
    Uint8List.fromList(
      utf8.encode(
        jsonEncode({
          for (var i = 0; i < 3000; i++)
            'k$i': {'name': 'دانش‌آموز $i', 'v': i * 3},
        }),
      ),
    ),
  ];
}

void main() {
  test('Z-01 checksums match known vectors', () {
    expect(crc32(ascii.encode('123456789')), 0xcbf43926);
    expect(adler32(ascii.encode('Wikipedia')), 0x11e60398);
  });

  test('Z-02 raw deflate → dart:io inflate (levels 0 and 6)', () {
    for (final s in samples()) {
      for (final level in [0, 6]) {
        final packed = deflateRaw(s, level: level);
        expect(io.ZLibDecoder(raw: true).convert(packed), s);
      }
    }
  });

  test('Z-03 dart:io deflate (all strategies) → pure inflate', () {
    for (final s in samples()) {
      for (final level in [1, 6, 9]) {
        for (final strategy in [
          io.ZLibOption.strategyDefault,
          io.ZLibOption.strategyFixed,
          io.ZLibOption.strategyHuffmanOnly,
          io.ZLibOption.strategyRle,
        ]) {
          final packed = io.ZLibEncoder(
            raw: true,
            level: level,
            strategy: strategy,
          ).convert(s);
          expect(inflateRaw(packed).$1, s);
        }
      }
    }
  });

  test('Z-04 zlib + gzip wrappers interoperate', () {
    for (final s in samples()) {
      expect(io.zlib.decode(zlibEncode(s)), s);
      expect(zlibDecode(io.zlib.encode(s)), s);
      expect(io.gzip.decode(gzipEncode(s)), s);
      expect(gzipDecode(io.gzip.encode(s)), s);
      expect(const DartZLibCodec(gzip: true).decode(io.gzip.encode(s)), s);
      expect(io.gzip.decode(const DartZLibCodec(gzip: true).encode(s)), s);
      expect(const DartZLibCodec(raw: true).decode(deflateRaw(s)), s);
    }
  });

  test('Z-05 compression actually compresses repetitive data', () {
    final s = samples()[2];
    expect(deflateRaw(s).length, lessThan(s.length ~/ 10));
  });

  test('Z-06 corrupt input is rejected, never silently accepted', () {
    final good = io.gzip.encode(samples()[2]);
    final flipped = Uint8List.fromList(good)..[good.length - 6] ^= 0xff;
    expect(() => gzipDecode(flipped), throwsFormatException);
    expect(
      () => gzipDecode(good.sublist(0, good.length ~/ 2)),
      throwsFormatException,
    );
    expect(() => zlibDecode([1, 2, 3, 4, 5, 6]), throwsFormatException);
    expect(() => inflateRaw([0xff]), throwsFormatException);
    final z = io.zlib.encode(samples()[2]);
    expect(
      () => zlibDecode(Uint8List.fromList(z)..[z.length - 1] ^= 1),
      throwsFormatException,
    );
  });

  test('Z-07 concatenated gzip members decode like dart:io', () {
    final a = utf8.encode('first '), b = utf8.encode('second');
    final both = [...io.gzip.encode(a), ...io.gzip.encode(b)];
    expect(utf8.decode(gzipDecode(both)), 'first second');
  });
}
