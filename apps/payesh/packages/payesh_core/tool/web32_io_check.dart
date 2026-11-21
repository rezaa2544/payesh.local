// Row 169 (D-50) — conformance of package:payesh_core/io.dart when compiled to JavaScript
// (the 32-bit Windows edition). Run:
//   dart compile js -O1 -o /tmp/io_check.js tool/web32_io_check.dart
//   node tool/web32_io_check.mjs /tmp/io_check.js
// The .mjs runner provides a tiny HTTP server (PAYESH_CHECK_HTTP) and prints the result.
// Every check prints "IO-OK <id>" or "IO-FAIL <id> <reason>"; the last line is
// "WEB32-IO-OK n" or "WEB32-IO-FAIL n".
// ignore_for_file: avoid_print, avoid_dynamic_calls
import 'dart:convert';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'dart:typed_data';

import 'package:payesh_core/io.dart';
import 'package:payesh_core/web_host.dart';

var _ok = 0, _fail = 0;

Future<void> check(String id, Future<void> Function() body) async {
  try {
    await body();
    _ok++;
    print('IO-OK $id');
  } catch (e) {
    _fail++;
    print('IO-FAIL $id $e');
  }
}

void eq(Object? a, Object? b, [String what = '']) {
  if (jsonEncode(a, toEncodable: (o) => '$o') !=
      jsonEncode(b, toEncodable: (o) => '$o')) {
    throw StateError('$what: $a != $b');
  }
}

Future<void> main() async {
  final mem = MemoryHost();
  WebHost.instance = mem;
  await prepareWebHost();
  eq(isWeb32, true, 'isWeb32');

  await check('P-01 Platform from host', () async {
    eq(Platform.isWindows, true);
    eq(Platform.isAndroid, false);
    eq(Platform.pathSeparator, r'\');
    eq(Platform.environment['LOCALAPPDATA'], r'C:\Users\web\AppData\Local');
    eq(Platform.operatingSystem, 'windows');
    eq(pid, 4242);
  });

  final base = r'C:\Users\web\AppData\Local\Payesh';
  await check('F-01 Directory create/exists/list', () async {
    final d = Directory(base);
    eq(d.existsSync(), false);
    d.createSync(recursive: true);
    eq(d.existsSync(), true);
    eq(await Directory('$base\\sub').exists(), false);
    Directory('$base\\sub').createSync();
    File('$base\\a.txt').writeAsStringSync('سلام');
    final names = d.listSync().map((e) => e.path).toList()..sort();
    eq(names, ['$base\\a.txt', '$base\\sub']);
    eq(d.listSync().whereType<File>().length, 1);
    eq(d.listSync().whereType<Directory>().length, 1);
  });

  await check('F-02 File read/write/append/length/rename/delete', () async {
    final f = File('$base\\b.bin');
    await f.writeAsBytes([1, 2, 3]);
    await f.writeAsBytes([4], mode: FileMode.append);
    eq(f.readAsBytesSync(), [1, 2, 3, 4]);
    eq(f.lengthSync(), 4);
    eq(File('$base\\a.txt').readAsStringSync(), 'سلام');
    final g = f.renameSync('$base\\c.bin');
    eq(f.existsSync(), false);
    eq(g.existsSync(), true);
    g.deleteSync();
    eq(g.existsSync(), false);
    eq(f.parent.path, base);
    eq(FileSystemEntity.typeSync(base), FileSystemEntityType.directory);
    eq(FileSystemEntity.isDirectorySync('$base\\nothing'), false);
  });

  await check('F-03 missing file → PathNotFoundException', () async {
    try {
      File('$base\\missing').readAsBytesSync();
      throw StateError('no error');
    } on PathNotFoundException catch (e) {
      eq(e.osError?.errorCode, 2);
    }
    try {
      await File('$base\\missing').delete();
      throw StateError('no error');
    } on FileSystemException {
      // expected
    }
  });

  await check('F-04 RandomAccessFile + openRead/openWrite', () async {
    final f = File('$base\\r.bin');
    final raf = f.openSync(mode: FileMode.write);
    raf.writeFromSync([9, 8, 7, 6, 5]);
    raf.setPositionSync(1);
    eq(raf.readSync(2), [8, 7]);
    raf.truncateSync(3);
    eq(raf.lengthSync(), 3);
    raf.closeSync();
    eq(f.readAsBytesSync(), [9, 8, 7]);
    final s = f.openWrite(mode: FileMode.append);
    s.add([1]);
    s.write('x');
    await s.close();
    eq(await f.openRead().expand((c) => c).toList(), [9, 8, 7, 1, 120]);
    eq(await f.openRead(1, 3).expand((c) => c).toList(), [8, 7]);
  });

  await check('F-05 temp dir + recursive delete', () async {
    final t = Directory.systemTemp.createTempSync('payesh');
    File('${t.path}\\x').writeAsStringSync('1');
    t.deleteSync(recursive: true);
    eq(t.existsSync(), false);
  });

  await check('Z-01 gzip/zlib round trip', () async {
    final data = utf8.encode('پایش ' * 300);
    eq(gzip.decode(gzip.encode(data)), data);
    eq(
      ZLibDecoder(raw: true).convert(ZLibEncoder(raw: true).convert(data)),
      data,
    );
    // A real gzip stream made by dart:io on the VM ('hello ' ×6 + 'ab').
    final native = base64.decode(
      'H4sIAAAAAAAAA8tIzcnJV8jASyYmAQCQXR5CJgAAAA==',
    );
    eq(utf8.decode(gzip.decode(native)).length, 38);
  });

  await check('N-01 InternetAddress parsing', () async {
    final a = InternetAddress.tryParse('192.168.1.20')!;
    eq(a.type == InternetAddressType.IPv4, true);
    eq(a.rawAddress, [192, 168, 1, 20]);
    eq(InternetAddress.tryParse('300.1.1.1'), null);
    eq(InternetAddress.tryParse('school.local'), null);
    eq(InternetAddress.tryParse('fe80::1')!.isLinkLocal, true);
    eq(InternetAddress.tryParse('127.0.0.1')!.isLoopback, true);
  });

  await check('S-01 SecurityContext hands PEMs to the host', () async {
    final c = SecurityContext(withTrustedRoots: true);
    c.setTrustedCertificatesBytes(
      utf8.encode(
        '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
      ),
    );
    eq(mem.trusted.length, 1);
  });

  await check(
    'X-01 Process without shell → ProcessResult with error',
    () async {
      final r = await Process.run('reg', ['query', 'x']);
      eq(r.exitCode, 1);
    },
  );

  await check('O-01 stdout goes to the host log', () async {
    stdout.writeln('hello log');
    eq(mem.logs.last, '[out] hello log');
  });

  final http = globalContext.getProperty<JSString?>('PAYESH_CHECK_HTTP'.toJS);
  if (http != null) {
    final base = Uri.parse(http.toDart);
    await check(
      'H-01 HttpClient GET (fetch) + headers + body stream',
      () async {
        final c = HttpClient()..connectionTimeout = const Duration(seconds: 5);
        final req = await c.getUrl(base.resolve('/hello?x=1'));
        req.headers.set('x-payesh', 'yes');
        final res = await req.close();
        eq(res.statusCode, 200);
        eq(res.headers.value('x-echo'), 'yes');
        eq(res.headers.contentType?.mimeType, 'application/json');
        final body = await res.transform(utf8.decoder).join();
        eq(jsonDecode(body)['path'], '/hello?x=1');
        c.close();
      },
    );
    await check('H-02 HttpClient POST body + status codes', () async {
      final c = HttpClient();
      final req = await c.postUrl(base.resolve('/echo'));
      req.headers.contentType = ContentType.json;
      req.write(jsonEncode({'name': 'پایش'}));
      final res = await req.close();
      eq(res.statusCode, 201);
      final got = jsonDecode(await utf8.decodeStream(res));
      eq(got['body'], {'name': 'پایش'});
      final nf = await (await c.getUrl(base.resolve('/404'))).close();
      eq(nf.statusCode, 404);
      await nf.drain<void>();
    });
    await check('H-03 large binary download streams in chunks', () async {
      final c = HttpClient();
      final res = await (await c.getUrl(base.resolve('/big'))).close();
      eq(res.contentLength, 3000000);
      var n = 0, chunks = 0, sum = 0;
      await for (final b in res) {
        n += b.length;
        chunks++;
        for (final x in b) {
          sum = (sum + x) & 0xffffff;
        }
      }
      eq(n, 3000000);
      if (chunks < 2) throw StateError('not streamed');
      eq(sum, _bigSum());
    });
    await check('H-04 connection failure → SocketException', () async {
      final c = HttpClient()..connectionTimeout = const Duration(seconds: 3);
      try {
        await (await c.getUrl(Uri.parse('http://127.0.0.1:1/'))).close();
        throw StateError('no error');
      } on SocketException {
        // expected
      }
    });
    await check('H-05 timeout → SocketException', () async {
      final c = HttpClient()
        ..connectionTimeout = const Duration(milliseconds: 300);
      try {
        await (await c.getUrl(base.resolve('/slow'))).close();
        throw StateError('no error');
      } on SocketException catch (e) {
        if (!e.message.contains('timed out')) rethrow;
      }
    });
  }
  print(_fail == 0 ? 'WEB32-IO-OK $_ok' : 'WEB32-IO-FAIL $_fail');
}

int _bigSum() {
  var s = 0;
  final b = Uint8List(3000000);
  for (var i = 0; i < b.length; i++) {
    s = (s + (i * 31) % 251) & 0xffffff;
  }
  return s;
}
