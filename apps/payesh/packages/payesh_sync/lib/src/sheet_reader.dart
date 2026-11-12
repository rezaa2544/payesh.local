// Row 128, wave W10 — reads the spreadsheet of a bulk import (web client/lib/xlsx.js): an .xlsx
// (zip of XML parts, deflate via dart:io's raw zlib) or a CSV/TSV text whose separator is
// detected from the first line. No third-party package: the same small reader as the web.
import 'dart:convert';
import 'dart:io' show ZLibDecoder;
import 'dart:typed_data';

import 'records.dart';

/// One sheet: its name and rows of trimmed cell texts (missing cells are '').
final class Sheet {
  const Sheet(this.name, this.rows);
  final String name;
  final List<List<String>> rows;
}

final class SheetBook {
  const SheetBook(this.sheets);
  final List<Sheet> sheets;

  /// The first sheet that has rows (web: `book.sheets.find(sh => sh.rows.length)`).
  Sheet? get firstWithRows {
    for (final s in sheets) {
      if (s.rows.isNotEmpty) return s;
    }
    return sheets.isEmpty ? null : sheets.first;
  }
}

abstract final class SheetReader {
  /// An .xlsx by name or by the zip signature, else UTF-8 CSV text.
  static SheetBook read(String fileName, Uint8List bytes) {
    final zip = bytes.length > 4 && bytes[0] == 0x50 && bytes[1] == 0x4b;
    if (zip || fileName.toLowerCase().endsWith('.xlsx')) return xlsx(bytes);
    return csv(utf8.decode(bytes, allowMalformed: true));
  }

  static String xmlUnescape(String s) => s
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAllMapped(
        RegExp('&#x([0-9a-fA-F]+);'),
        (m) => String.fromCharCode(int.parse(m[1]!, radix: 16)),
      )
      .replaceAllMapped(
        RegExp(r'&#(\d+);'),
        (m) => String.fromCharCode(int.parse(m[1]!)),
      )
      .replaceAll('&amp;', '&');

  /// Column letters → 0-based index («AB» → 27).
  static int colIndex(String ref) {
    final m = RegExp('^([A-Za-z]+)').firstMatch(ref);
    if (m == null) return -1;
    var n = 0;
    for (final c in m[1]!.toUpperCase().codeUnits) {
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  static Never _bad(String msg) => throw RecordFailure('invalid', msg);

  static Map<String, (int, int, int)> _entries(ByteData dv, int len) {
    var eocd = -1;
    final min = len - 66000 < 0 ? 0 : len - 66000;
    for (var i = len - 22; i >= min; i--) {
      if (dv.getUint32(i, Endian.little) == 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) {
      _bad('این فایل یک بایگانی zip معتبر نیست (xlsx خراب یا رمزدار است).');
    }
    final count = dv.getUint16(eocd + 10, Endian.little);
    var off = dv.getUint32(eocd + 16, Endian.little);
    final out = <String, (int, int, int)>{};
    for (var i = 0; i < count; i++) {
      if (off + 46 > len || dv.getUint32(off, Endian.little) != 0x02014b50) {
        break;
      }
      final method = dv.getUint16(off + 10, Endian.little);
      final comp = dv.getUint32(off + 20, Endian.little);
      final nameLen = dv.getUint16(off + 28, Endian.little);
      final extra = dv.getUint16(off + 30, Endian.little);
      final comment = dv.getUint16(off + 32, Endian.little);
      final local = dv.getUint32(off + 42, Endian.little);
      final name = utf8.decode(
        dv.buffer.asUint8List(dv.offsetInBytes + off + 46, nameLen),
        allowMalformed: true,
      );
      out[name] = (method, comp, local);
      off += 46 + nameLen + extra + comment;
    }
    return out;
  }

  static SheetBook xlsx(Uint8List u8) {
    final dv = ByteData.sublistView(u8);
    final entries = _entries(dv, u8.length);
    String? get(String name) {
      final e = entries[name];
      if (e == null) return null;
      final (method, comp, local) = e;
      final nameLen = dv.getUint16(local + 26, Endian.little);
      final extra = dv.getUint16(local + 28, Endian.little);
      final start = local + 30 + nameLen + extra;
      if (start + comp > u8.length) _bad('فایل اکسل ناقص است.');
      final raw = Uint8List.sublistView(u8, start, start + comp);
      final List<int> bytes;
      if (method == 0) {
        bytes = raw;
      } else if (method == 8) {
        try {
          bytes = ZLibDecoder(raw: true).convert(raw);
        } on FormatException {
          _bad('فایل اکسل خراب است و باز نمی‌شود.');
        }
      } else {
        _bad('روش فشرده‌سازی این فایل پشتیبانی نمی‌شود (روش $method).');
      }
      return utf8.decode(bytes, allowMalformed: true);
    }

    final shared = <String>[];
    final ss = get('xl/sharedStrings.xml');
    if (ss != null) {
      for (final m in RegExp(r'<si\b[^>]*>([\s\S]*?)</si>').allMatches(ss)) {
        shared.add(_texts(m[1]!));
      }
    }
    final rels = <String, String>{};
    final rx = get('xl/_rels/workbook.xml.rels') ?? '';
    for (final m in RegExp(r'<Relationship\b([^>]*)/?>').allMatches(rx)) {
      final id = RegExp(r'\bId="([^"]+)"').firstMatch(m[1]!)?[1];
      final t = RegExp(r'\bTarget="([^"]+)"').firstMatch(m[1]!)?[1];
      if (id != null && t != null) {
        rels[id] = t
            .replaceFirst(RegExp(r'^/?xl/'), '')
            .replaceFirst(RegExp(r'^\./'), '');
      }
    }
    final list = <(String, String)>[];
    final wb = get('xl/workbook.xml') ?? '';
    for (final m in RegExp(r'<sheet\b([^>]*)/?>').allMatches(wb)) {
      final name = RegExp(r'\bname="([^"]*)"').firstMatch(m[1]!)?[1];
      final rid = RegExp(r'\br:id="([^"]+)"').firstMatch(m[1]!)?[1] ?? '';
      list.add((
        name == null ? 'برگهٔ ${list.length + 1}' : xmlUnescape(name),
        rid,
      ));
    }
    if (list.isEmpty) list.add(('برگهٔ ۱', ''));
    final sheets = <Sheet>[];
    for (final (name, rid) in list) {
      final target = rels[rid] ?? 'worksheets/sheet${sheets.length + 1}.xml';
      final path = target.startsWith('xl/') ? target : 'xl/$target';
      final xml =
          get(path) ?? get('xl/worksheets/sheet${sheets.length + 1}.xml');
      if (xml == null) continue;
      sheets.add(Sheet(name, _sheet(xml, shared)));
    }
    if (sheets.isEmpty) _bad('هیچ برگه‌ای در این فایل اکسل پیدا نشد.');
    return SheetBook(sheets);
  }

  static String _texts(String body) => [
    for (final t in RegExp(r'<t\b[^>]*>([\s\S]*?)</t>').allMatches(body))
      xmlUnescape(t[1]!),
  ].join();

  static List<List<String>> _sheet(String xml, List<String> shared) {
    final rows = <int, List<String>>{};
    var maxRow = 0;
    final rowRe = RegExp(r'<row\b([^>]*)>([\s\S]*?)</row>');
    final cellRe = RegExp(r'<c\b([^>]*?)(?:/>|>([\s\S]*?)</c>)');
    final vRe = RegExp(r'<v>([\s\S]*?)</v>');
    for (final rm in rowRe.allMatches(xml)) {
      final n =
          int.tryParse(RegExp(r'\br="(\d+)"').firstMatch(rm[1]!)?[1] ?? '') ??
          maxRow + 1;
      final cells = <String>[];
      for (final cm in cellRe.allMatches(rm[2]!)) {
        final attrs = cm[1] ?? '';
        final body = cm[2] ?? '';
        final ref =
            RegExp(
              r'\br="([A-Z]+\d+)"',
              caseSensitive: false,
            ).firstMatch(attrs)?[1] ??
            '';
        final type = RegExp(r'\bt="([^"]+)"').firstMatch(attrs)?[1] ?? 'n';
        final v = vRe.firstMatch(body)?[1] ?? '';
        final value = switch (type) {
          's' => () {
            final i = int.tryParse(v.trim());
            return i != null && i >= 0 && i < shared.length ? shared[i] : '';
          }(),
          'inlineStr' => _texts(body),
          'str' => xmlUnescape(v),
          'b' => v.trim() == '1' ? '1' : '0',
          _ => v,
        };
        final idx = ref.isEmpty ? cells.length : colIndex(ref);
        if (idx < 0) continue;
        while (cells.length <= idx) {
          cells.add('');
        }
        cells[idx] = value.trim();
      }
      rows[n] = cells;
      if (n > maxRow) maxRow = n;
    }
    return [for (var i = 1; i <= maxRow; i++) rows[i] ?? <String>[]];
  }

  /// CSV/TSV; the separator (comma, semicolon or tab) is the most frequent one of line 1.
  static SheetBook csv(String text) {
    final src = text.startsWith('\uFEFF') ? text.substring(1) : text;
    final first = src.split(RegExp(r'\r?\n')).first;
    var sep = ',';
    var best = 0;
    for (final s in [',', ';', '\t']) {
      final c = s.allMatches(first).length;
      if (c > best) {
        best = c;
        sep = s;
      }
    }
    final rows = <List<String>>[];
    var row = <String>[];
    final cell = StringBuffer();
    var quoted = false;
    for (var i = 0; i < src.length; i++) {
      final ch = src[i];
      if (quoted) {
        if (ch == '"' && i + 1 < src.length && src[i + 1] == '"') {
          cell.write('"');
          i++;
        } else if (ch == '"') {
          quoted = false;
        } else {
          cell.write(ch);
        }
      } else if (ch == '"') {
        quoted = true;
      } else if (ch == sep) {
        row.add(cell.toString());
        cell.clear();
      } else if (ch == '\n') {
        row.add(cell.toString());
        rows.add(row);
        row = <String>[];
        cell.clear();
      } else if (ch != '\r') {
        cell.write(ch);
      }
    }
    if (cell.isNotEmpty || row.isNotEmpty) {
      row.add(cell.toString());
      rows.add(row);
    }
    return SheetBook([Sheet('CSV', rows)]);
  }
}
