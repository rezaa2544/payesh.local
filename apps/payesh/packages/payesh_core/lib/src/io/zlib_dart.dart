// Pure-Dart DEFLATE (RFC 1951) + zlib (RFC 1950) + gzip (RFC 1952) — row 169 (D-50).
//
// dart:io's zlib is a native filter, so `ZLibDecoder`, `ZLibEncoder` and `gzip` throw on the
// 32-bit Windows edition (the same Flutter code compiled to JavaScript). This file gives that
// edition the same codecs. Native builds keep dart:io's codecs (package:payesh_core/io.dart).
// Output of the encoder is standard DEFLATE (fixed Huffman codes + LZ77), readable by every
// inflater; the decoder reads any valid stream (stored, fixed and dynamic blocks).
import 'dart:convert';
import 'dart:typed_data';

/// Thrown for a corrupt/truncated compressed stream (dart:io throws a FormatException-like
/// `ZLibException`-free error too; callers catch `FormatException`/`Object`).
final class DeflateFormatException extends FormatException {
  const DeflateFormatException(super.message);
}

// ---------------------------------------------------------------------------------------------
// Checksums

final Uint32List _crcTable = (() {
  final t = Uint32List(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) {
      c = (c & 1) != 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();

/// CRC-32 (IEEE 802.3) of [data], as used by gzip and ZIP.
int crc32(List<int> data, [int crc = 0]) {
  var c = crc ^ 0xffffffff;
  for (final b in data) {
    c = _crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) & 0xffffffff;
}

/// Adler-32 of [data], as used by the zlib wrapper.
int adler32(List<int> data) {
  var a = 1, b = 0;
  var i = 0;
  while (i < data.length) {
    final end = i + 3800 < data.length ? i + 3800 : data.length;
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) & 0xffffffff;
}

// ---------------------------------------------------------------------------------------------
// Tables

const List<int> _lenBase = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, //
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const List<int> _lenExtra = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, //
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const List<int> _distBase = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, //
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385,
  24577,
];
const List<int> _distExtra = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, //
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const List<int> _clOrder = [
  16,
  17,
  18,
  0,
  8,
  7,
  9,
  6,
  10,
  5,
  11,
  4,
  12,
  3,
  13,
  2,
  14,
  1,
  15,
];

// ---------------------------------------------------------------------------------------------
// Inflate

final class _Huffman {
  _Huffman(List<int> lengths) {
    for (final l in lengths) {
      counts[l]++;
    }
    counts[0] = 0;
    final offs = Uint16List(16);
    for (var i = 1; i < 16; i++) {
      offs[i] = offs[i - 1] + counts[i - 1];
    }
    for (var s = 0; s < lengths.length; s++) {
      if (lengths[s] != 0) symbols[offs[lengths[s]]++] = s;
    }
  }

  final Uint16List counts = Uint16List(16);
  final Uint16List symbols = Uint16List(320);
}

final class _BitReader {
  _BitReader(this.data, this.pos);
  final List<int> data;
  int pos;
  int _bitBuf = 0;
  int _bitCnt = 0;

  int bits(int n) {
    while (_bitCnt < n) {
      if (pos >= data.length) {
        throw const DeflateFormatException('unexpected end of deflate data');
      }
      _bitBuf |= data[pos++] << _bitCnt;
      _bitCnt += 8;
    }
    final v = _bitBuf & ((1 << n) - 1);
    _bitBuf >>>= n;
    _bitCnt -= n;
    return v;
  }

  void alignToByte() {
    _bitBuf = 0;
    _bitCnt = 0;
  }

  int decode(_Huffman h) {
    var code = 0, first = 0, index = 0;
    for (var len = 1; len < 16; len++) {
      code |= bits(1);
      final count = h.counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw const DeflateFormatException('invalid Huffman code');
  }
}

final class _Out {
  Uint8List buf = Uint8List(1 << 16);
  int len = 0;

  void _grow(int need) {
    if (len + need <= buf.length) return;
    var n = buf.length * 2;
    while (n < len + need) {
      n *= 2;
    }
    buf = Uint8List(n)..setRange(0, len, buf);
  }

  void byte(int b) {
    if (len == buf.length) _grow(1);
    buf[len++] = b;
  }

  void bytes(List<int> src, int start, int end) {
    _grow(end - start);
    buf.setRange(len, len + end - start, src, start);
    len += end - start;
  }

  void copy(int dist, int n) {
    if (dist > len) throw const DeflateFormatException('distance too far back');
    _grow(n);
    for (var i = 0; i < n; i++) {
      buf[len] = buf[len - dist];
      len++;
    }
  }

  Uint8List take() => Uint8List.sublistView(buf, 0, len);
}

_Huffman? _fixedLit;
_Huffman? _fixedDist;

/// Inflates raw DEFLATE [data] from [start]; returns the bytes and the offset just after the
/// last block (so wrappers can read their trailers).
(Uint8List, int) inflateRaw(List<int> data, [int start = 0]) {
  final r = _BitReader(data, start);
  final out = _Out();
  var last = 0;
  while (last == 0) {
    last = r.bits(1);
    final type = r.bits(2);
    if (type == 0) {
      r.alignToByte();
      if (r.pos + 4 > data.length) {
        throw const DeflateFormatException('truncated stored block');
      }
      final len = data[r.pos] | (data[r.pos + 1] << 8);
      final nlen = data[r.pos + 2] | (data[r.pos + 3] << 8);
      if (len != (~nlen & 0xffff)) {
        throw const DeflateFormatException('stored block length mismatch');
      }
      r.pos += 4;
      if (r.pos + len > data.length) {
        throw const DeflateFormatException('truncated stored block');
      }
      out.bytes(data, r.pos, r.pos + len);
      r.pos += len;
    } else if (type == 1 || type == 2) {
      _Huffman lit, dist;
      if (type == 1) {
        lit = _fixedLit ??= _Huffman([
          for (var i = 0; i < 288; i++)
            i < 144
                ? 8
                : i < 256
                ? 9
                : i < 280
                ? 7
                : 8,
        ]);
        dist = _fixedDist ??= _Huffman(List.filled(30, 5));
      } else {
        final hlit = r.bits(5) + 257;
        final hdist = r.bits(5) + 1;
        final hclen = r.bits(4) + 4;
        final cl = List<int>.filled(19, 0);
        for (var i = 0; i < hclen; i++) {
          cl[_clOrder[i]] = r.bits(3);
        }
        final clh = _Huffman(cl);
        final lens = List<int>.filled(hlit + hdist, 0);
        var i = 0;
        while (i < hlit + hdist) {
          final sym = r.decode(clh);
          if (sym < 16) {
            lens[i++] = sym;
            continue;
          }
          var rep = 0, val = 0;
          if (sym == 16) {
            if (i == 0) {
              throw const DeflateFormatException('repeat with no code');
            }
            val = lens[i - 1];
            rep = 3 + r.bits(2);
          } else if (sym == 17) {
            rep = 3 + r.bits(3);
          } else {
            rep = 11 + r.bits(7);
          }
          if (i + rep > hlit + hdist) {
            throw const DeflateFormatException('too many code lengths');
          }
          for (var k = 0; k < rep; k++) {
            lens[i++] = val;
          }
        }
        lit = _Huffman(lens.sublist(0, hlit));
        dist = _Huffman(lens.sublist(hlit));
      }
      for (;;) {
        final sym = r.decode(lit);
        if (sym < 256) {
          out.byte(sym);
        } else if (sym == 256) {
          break;
        } else {
          final li = sym - 257;
          if (li >= 29) throw const DeflateFormatException('bad length code');
          final len = _lenBase[li] + r.bits(_lenExtra[li]);
          final di = r.decode(dist);
          if (di >= 30) throw const DeflateFormatException('bad distance code');
          out.copy(_distBase[di] + r.bits(_distExtra[di]), len);
        }
      }
    } else {
      throw const DeflateFormatException('invalid block type');
    }
  }
  return (out.take(), r.pos);
}

// ---------------------------------------------------------------------------------------------
// Deflate (fixed Huffman + greedy LZ77 with a hash chain)

final class _BitWriter {
  final _Out out = _Out();
  int _buf = 0;
  int _cnt = 0;

  void bits(int value, int n) {
    _buf |= value << _cnt;
    _cnt += n;
    while (_cnt >= 8) {
      out.byte(_buf & 0xff);
      _buf >>>= 8;
      _cnt -= 8;
    }
  }

  /// Huffman codes are sent most-significant bit first.
  void code(int code, int len) {
    var rev = 0;
    for (var i = 0; i < len; i++) {
      rev = (rev << 1) | ((code >>> i) & 1);
    }
    bits(rev, len);
  }

  void flush() {
    if (_cnt > 0) out.byte(_buf & 0xff);
    _buf = 0;
    _cnt = 0;
  }
}

void _lit(_BitWriter w, int sym) {
  if (sym < 144) {
    w.code(0x30 + sym, 8);
  } else if (sym < 256) {
    w.code(0x190 + sym - 144, 9);
  } else if (sym < 280) {
    w.code(sym - 256, 7);
  } else {
    w.code(0xc0 + sym - 280, 8);
  }
}

void _match(_BitWriter w, int len, int dist) {
  var li = 28;
  while (_lenBase[li] > len) {
    li--;
  }
  _lit(w, 257 + li);
  w.bits(len - _lenBase[li], _lenExtra[li]);
  var di = 29;
  while (_distBase[di] > dist) {
    di--;
  }
  w.code(di, 5);
  w.bits(dist - _distBase[di], _distExtra[di]);
}

/// Raw DEFLATE of [data]. [level] 0 = stored blocks only; anything else = LZ77 + fixed codes.
Uint8List deflateRaw(List<int> data, {int level = 6}) {
  final w = _BitWriter();
  if (level == 0 || data.isEmpty) {
    var i = 0;
    do {
      final n = data.length - i > 65535 ? 65535 : data.length - i;
      w.bits(i + n >= data.length ? 1 : 0, 1);
      w.bits(0, 2);
      w.flush();
      w.out
        ..byte(n & 0xff)
        ..byte(n >> 8)
        ..byte(~n & 0xff)
        ..byte((~n >> 8) & 0xff)
        ..bytes(data, i, i + n);
      i += n;
    } while (i < data.length);
    return w.out.take();
  }
  const window = 32768, hashSize = 1 << 15, maxChain = 64;
  final head = Int32List(hashSize)..fillRange(0, hashSize, -1);
  final prev = Int32List(window);
  final n = data.length;
  int hash(int i) =>
      ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (hashSize - 1);
  void insert(int i) {
    if (i + 2 >= n) return;
    final h = hash(i);
    prev[i & (window - 1)] = head[h];
    head[h] = i;
  }

  w.bits(1, 1); // single final block
  w.bits(1, 2); // fixed Huffman
  var i = 0;
  while (i < n) {
    var bestLen = 0, bestDist = 0;
    if (i + 2 < n) {
      var cand = head[hash(i)];
      var chain = maxChain;
      final maxLen = n - i < 258 ? n - i : 258;
      while (cand >= 0 && i - cand <= window && chain-- > 0) {
        if (data[cand + bestLen] == data[i + bestLen]) {
          var l = 0;
          while (l < maxLen && data[cand + l] == data[i + l]) {
            l++;
          }
          if (l > bestLen) {
            bestLen = l;
            bestDist = i - cand;
            if (l == maxLen) break;
          }
        }
        final p = prev[cand & (window - 1)];
        if (p >= cand) break;
        cand = p;
      }
    }
    if (bestLen >= 3) {
      _match(w, bestLen, bestDist);
      for (var k = 0; k < bestLen; k++) {
        insert(i + k);
      }
      i += bestLen;
    } else {
      _lit(w, data[i]);
      insert(i);
      i++;
    }
  }
  _lit(w, 256);
  w.flush();
  return w.out.take();
}

// ---------------------------------------------------------------------------------------------
// Wrappers

/// zlib (RFC 1950) or raw DEFLATE.
Uint8List zlibEncode(List<int> data, {bool raw = false, int level = 6}) {
  final body = deflateRaw(data, level: level);
  if (raw) return body;
  final a = adler32(data);
  return Uint8List.fromList([
    0x78, 0x9c, ...body, //
    (a >>> 24) & 0xff, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff,
  ]);
}

Uint8List zlibDecode(List<int> data, {bool raw = false}) {
  if (raw) return inflateRaw(data).$1;
  if (data.length < 6 ||
      (data[0] & 0x0f) != 8 ||
      ((data[0] << 8) | data[1]) % 31 != 0) {
    throw const DeflateFormatException('not a zlib stream');
  }
  if ((data[1] & 0x20) != 0) {
    throw const DeflateFormatException('zlib preset dictionary not supported');
  }
  final (out, end) = inflateRaw(data, 2);
  if (end + 4 > data.length) {
    throw const DeflateFormatException('truncated zlib');
  }
  final a =
      (data[end] << 24) |
      (data[end + 1] << 16) |
      (data[end + 2] << 8) |
      data[end + 3];
  if ((a & 0xffffffff) != adler32(out)) {
    throw const DeflateFormatException('zlib checksum mismatch');
  }
  return out;
}

Uint8List gzipEncode(List<int> data, {int level = 6}) {
  final body = deflateRaw(data, level: level);
  final c = crc32(data), n = data.length;
  return Uint8List.fromList([
    0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff, ...body, //
    c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff,
    n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff,
  ]);
}

/// Decodes every concatenated gzip member (like dart:io's `gzip.decode`).
Uint8List gzipDecode(List<int> data) {
  final out = BytesBuilder(copy: false);
  var p = 0;
  do {
    if (p + 18 > data.length ||
        data[p] != 0x1f ||
        data[p + 1] != 0x8b ||
        data[p + 2] != 8) {
      throw const DeflateFormatException('not a gzip stream');
    }
    final flg = data[p + 3];
    p += 10;
    if ((flg & 4) != 0) p += 2 + (data[p] | (data[p + 1] << 8));
    if ((flg & 8) != 0) {
      while (data[p] != 0) {
        p++;
      }
      p++;
    }
    if ((flg & 16) != 0) {
      while (data[p] != 0) {
        p++;
      }
      p++;
    }
    if ((flg & 2) != 0) p += 2;
    final (body, end) = inflateRaw(data, p);
    if (end + 8 > data.length) {
      throw const DeflateFormatException('truncated gzip');
    }
    final c =
        data[end] |
        (data[end + 1] << 8) |
        (data[end + 2] << 16) |
        (data[end + 3] << 24);
    if ((c & 0xffffffff) != crc32(body)) {
      throw const DeflateFormatException('gzip checksum mismatch');
    }
    out.add(body);
    p = end + 8;
  } while (p < data.length && data[p] == 0x1f);
  return out.takeBytes();
}

// ---------------------------------------------------------------------------------------------
// dart:io-shaped codecs (used by io_web.dart; also usable/tested on the VM)

final class DartZLibEncoder extends Converter<List<int>, List<int>> {
  const DartZLibEncoder({this.raw = false, this.level = 6, this.gzip = false});
  final bool raw;
  final int level;
  final bool gzip;
  @override
  List<int> convert(List<int> input) => gzip
      ? gzipEncode(input, level: level)
      : zlibEncode(input, raw: raw, level: level);
}

final class DartZLibDecoder extends Converter<List<int>, List<int>> {
  const DartZLibDecoder({this.raw = false, this.gzip = false});
  final bool raw;
  final bool gzip;
  @override
  List<int> convert(List<int> input) =>
      gzip ? gzipDecode(input) : zlibDecode(input, raw: raw);
}

final class DartZLibCodec extends Codec<List<int>, List<int>> {
  const DartZLibCodec({this.raw = false, this.level = 6, this.gzip = false});
  final bool raw;
  final int level;
  final bool gzip;
  @override
  DartZLibEncoder get encoder =>
      DartZLibEncoder(raw: raw, level: level, gzip: gzip);
  @override
  DartZLibDecoder get decoder => DartZLibDecoder(raw: raw, gzip: gzip);
}
