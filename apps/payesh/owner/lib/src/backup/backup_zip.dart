// ردیف ۱۶۶ — قالب «یک فایل جامع» پشتیبان: یک ZIP معمولی (با ویندوز/هر برنامهٔ فشرده‌سازی باز
// می‌شود). بدون وابستگی تازه: نوشتن/خواندن ZIP (Deflate خام از dart:io، CRC-32، UTF-8، ZIP64 برای
// بیش از ۶۵۵۳۵ فایل) همین‌جاست.

import 'dart:convert';
import 'dart:typed_data';

import 'package:payesh_core/io.dart';

final Uint32List _crcTable = () {
  final t = Uint32List(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) {
      c = (c & 1) != 0 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
}();

int crc32(List<int> data) {
  var c = 0xFFFFFFFF;
  for (final b in data) {
    c = _crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) & 0xFFFFFFFF;
}

final class _Central {
  _Central(
    this.name,
    this.method,
    this.crc,
    this.csize,
    this.usize,
    this.at,
    this.offset,
  );
  final List<int> name;
  final int method, crc, csize, usize, offset;
  final DateTime at;
}

(int, int) _dos(DateTime t) {
  final l = t.toLocal();
  final y = l.year < 1980 ? 1980 : (l.year > 2107 ? 2107 : l.year);
  final time = (l.hour << 11) | (l.minute << 5) | (l.second ~/ 2);
  final date = ((y - 1980) << 9) | (l.month << 5) | l.day;
  return (time, date);
}

/// ZIP در حافظه، فایل به فایل.
final class ZipWriter {
  final BytesBuilder _out = BytesBuilder(copy: false);
  final List<_Central> _dir = [];
  int _pos = 0;

  int get length => _pos;

  void _u16(BytesBuilder b, int v) => b.add([v & 0xFF, (v >> 8) & 0xFF]);
  void _u32(BytesBuilder b, int v) =>
      b.add([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]);
  void _u64(BytesBuilder b, int v) {
    _u32(b, v & 0xFFFFFFFF);
    _u32(b, v ~/ 0x100000000);
  }

  void _emit(BytesBuilder b) {
    final bytes = b.takeBytes();
    _out.add(bytes);
    _pos += bytes.length;
  }

  /// یک فایل؛ اگر فشرده‌سازی سودی نداشت، بی‌فشرده (stored).
  void add(String name, List<int> raw, {DateTime? at}) {
    final n = utf8.encode(name);
    final packed = ZLibEncoder(raw: true, level: 6).convert(raw);
    final stored = packed.length >= raw.length;
    final data = stored ? raw : packed;
    if (_pos > 0xFFFFFFFE || data.length > 0xFFFFFFFE) {
      throw const FileSystemException('پشتیبان بزرگ‌تر از ۴ گیگابایت است.');
    }
    final crc = crc32(raw);
    final when = at ?? DateTime.now();
    final (time, date) = _dos(when);
    final h = BytesBuilder(copy: false);
    _u32(h, 0x04034b50);
    _u16(h, 20);
    _u16(h, 0x0800); // نام UTF-8
    _u16(h, stored ? 0 : 8);
    _u16(h, time);
    _u16(h, date);
    _u32(h, crc);
    _u32(h, data.length);
    _u32(h, raw.length);
    _u16(h, n.length);
    _u16(h, 0);
    h.add(n);
    final offset = _pos;
    _emit(h);
    _out.add(data);
    _pos += data.length;
    _dir.add(
      _Central(n, stored ? 0 : 8, crc, data.length, raw.length, when, offset),
    );
  }

  Uint8List finish() {
    final cdStart = _pos;
    for (final e in _dir) {
      final (time, date) = _dos(e.at);
      final h = BytesBuilder(copy: false);
      _u32(h, 0x02014b50);
      _u16(h, 20);
      _u16(h, 20);
      _u16(h, 0x0800);
      _u16(h, e.method);
      _u16(h, time);
      _u16(h, date);
      _u32(h, e.crc);
      _u32(h, e.csize);
      _u32(h, e.usize);
      _u16(h, e.name.length);
      _u16(h, 0);
      _u16(h, 0);
      _u16(h, 0);
      _u16(h, 0);
      _u32(h, 0);
      _u32(h, e.offset);
      h.add(e.name);
      _emit(h);
    }
    final cdSize = _pos - cdStart;
    final many = _dir.length > 0xFFFE;
    final t = BytesBuilder(copy: false);
    if (many) {
      final z64 = _pos;
      _u32(t, 0x06064b50);
      _u64(t, 44);
      _u16(t, 45);
      _u16(t, 45);
      _u32(t, 0);
      _u32(t, 0);
      _u64(t, _dir.length);
      _u64(t, _dir.length);
      _u64(t, cdSize);
      _u64(t, cdStart);
      _u32(t, 0x07064b50);
      _u32(t, 0);
      _u64(t, z64);
      _u32(t, 1);
    }
    _u32(t, 0x06054b50);
    _u16(t, 0);
    _u16(t, 0);
    _u16(t, many ? 0xFFFF : _dir.length);
    _u16(t, many ? 0xFFFF : _dir.length);
    _u32(t, cdSize);
    _u32(t, cdStart);
    _u16(t, 0);
    _emit(t);
    return _out.takeBytes();
  }
}

/// خواندن ZIP؛ نام ← (روش، crc، اندازه‌ها، جای سرآیند محلی).
final class ZipReader {
  ZipReader._(this._b, this._entries);
  final Uint8List _b;
  final Map<String, ({int method, int crc, int csize, int usize, int offset})>
  _entries;

  Iterable<String> get names => _entries.keys;
  bool has(String name) => _entries.containsKey(name);

  static int _u16(Uint8List b, int o) => b[o] | (b[o + 1] << 8);
  static int _u32(Uint8List b, int o) =>
      b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  static int _u64(Uint8List b, int o) =>
      _u32(b, o) + _u32(b, o + 4) * 0x100000000;

  /// null ⇒ ZIP نیست یا خراب است.
  static ZipReader? parse(Uint8List b) {
    try {
      var e = b.length - 22;
      final stop = e - 0xFFFF < 0 ? 0 : e - 0xFFFF;
      while (e >= stop && _u32(b, e) != 0x06054b50) {
        e--;
      }
      if (e < stop) return null;
      var count = _u16(b, e + 10);
      var cdSize = _u32(b, e + 12);
      var cdStart = _u32(b, e + 16);
      if (count == 0xFFFF || cdStart == 0xFFFFFFFF) {
        final loc = e - 20;
        if (loc < 0 || _u32(b, loc) != 0x07064b50) return null;
        final z = _u64(b, loc + 8);
        if (_u32(b, z) != 0x06064b50) return null;
        count = _u64(b, z + 32);
        cdSize = _u64(b, z + 40);
        cdStart = _u64(b, z + 48);
      }
      if (cdStart + cdSize > b.length) return null;
      final out =
          <String, ({int method, int crc, int csize, int usize, int offset})>{};
      var p = cdStart;
      for (var i = 0; i < count; i++) {
        if (_u32(b, p) != 0x02014b50) return null;
        final method = _u16(b, p + 10);
        final crc = _u32(b, p + 16);
        final csize = _u32(b, p + 20);
        final usize = _u32(b, p + 24);
        final nl = _u16(b, p + 28), xl = _u16(b, p + 30), cl = _u16(b, p + 32);
        final offset = _u32(b, p + 42);
        final name = utf8.decode(
          b.sublist(p + 46, p + 46 + nl),
          allowMalformed: true,
        );
        out[name] = (
          method: method,
          crc: crc,
          csize: csize,
          usize: usize,
          offset: offset,
        );
        p += 46 + nl + xl + cl;
      }
      return ZipReader._(b, out);
    } on Object {
      return null;
    }
  }

  /// محتوای خام؛ null اگر نباشد یا CRC نخواند.
  List<int>? read(String name) {
    final e = _entries[name];
    if (e == null) return null;
    try {
      final h = e.offset;
      if (_u32(_b, h) != 0x04034b50) return null;
      final start = h + 30 + _u16(_b, h + 26) + _u16(_b, h + 28);
      final data = Uint8List.sublistView(_b, start, start + e.csize);
      final raw = switch (e.method) {
        0 => data,
        8 => ZLibDecoder(raw: true).convert(data),
        _ => null,
      };
      if (raw == null || raw.length != e.usize || crc32(raw) != e.crc) {
        return null;
      }
      return raw;
    } on Object {
      return null;
    }
  }
}
