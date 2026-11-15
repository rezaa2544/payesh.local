import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

/// Row 163 — the school server is found with nothing typed on the login screen.
final class _ProbeOnly implements LanAccessApi {
  _ProbeOnly(this.answers);

  /// host → answer (a LanServerInfo, an error, or a Completer to hold the reply).
  final Map<String, Object> answers;
  final probed = <String>[];

  @override
  Future<LanServerInfo> probe(Uri server) async {
    probed.add(server.host);
    final a = answers[server.host];
    if (a is Completer<LanServerInfo>) return a.future;
    if (a is LanServerInfo) return a;
    throw a ?? const LanAccessFailure(LanAccessError.unreachable);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

LanServerInfo _info(String host) => LanServerInfo(
  server: Uri.parse('http://$host:8080'),
  setupDone: true,
  headless: false,
  schoolName: 'آینده سازان',
);

void main() {
  final now = DateTime.utc(2026, 11, 15, 10);

  group('SchoolServerEntry.fromJson', () {
    test('DF-01 keeps private LAN addresses and https public address only', () {
      final e = SchoolServerEntry.fromJson({
        'instance': 'dd9286ad1f5d3ccb',
        'school': 'آینده سازان',
        'lan': [
          'http://192.168.1.120:8080',
          'http://8.8.8.8:8080',
          42,
          'http://10.10.1.1:8080',
        ],
        'public_url': 'https://School.Example.ir',
        'at': now.toIso8601String(),
      })!;
      expect(e.school, 'آینده سازان');
      expect(e.lan.map((u) => u.host), ['192.168.1.120', '10.10.1.1']);
      expect(e.publicUrl.toString(), 'https://school.example.ir');
    });

    test('DF-02 NEG: no instance / no time / no usable address ⇒ skipped', () {
      final at = now.toIso8601String();
      expect(SchoolServerEntry.fromJson('x'), isNull);
      expect(
        SchoolServerEntry.fromJson({
          'lan': ['http://192.168.1.2'],
          'at': at,
        }),
        isNull,
      );
      expect(
        SchoolServerEntry.fromJson({
          'instance': 'a',
          'lan': ['http://192.168.1.2'],
        }),
        isNull,
      );
      expect(
        SchoolServerEntry.fromJson({
          'instance': 'a',
          'lan': ['http://1.2.3.4'],
          'public_url': 'http://plain.example.ir',
          'at': at,
        }),
        isNull,
      );
    });
  });

  group('SchoolDirectoryClient (real HTTP)', () {
    late HttpServer server;
    var status = 200;
    var body = '';
    final seenHeaders = <String?>[];

    setUp(() async {
      status = 200;
      seenHeaders.clear();
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) {
        seenHeaders.add(req.headers.value(HttpHeaders.cacheControlHeader));
        req.response
          ..statusCode = status
          ..write(body);
        unawaited(req.response.close());
      });
    });
    tearDown(() => server.close(force: true));

    SchoolDirectoryClient client() => SchoolDirectoryClient(
      url: Uri.parse('http://127.0.0.1:${server.port}/pub/school-servers.json'),
      client: HttpClient(),
      now: () => now,
    );

    test(
      'DF-03 freshest first, stale rows skipped, LAN before public',
      () async {
        body = jsonEncode({
          'v': 1,
          'kind': 'payesh-school-servers',
          'servers': [
            {
              'instance': 'old',
              'lan': ['http://192.168.9.9:8080'],
              'at': now.subtract(const Duration(days: 11)).toIso8601String(),
            },
            {
              'instance': 'b',
              'lan': ['http://192.168.1.50:8080'],
              'public_url': 'https://b.example.ir',
              'at': now.subtract(const Duration(hours: 2)).toIso8601String(),
            },
            {
              'instance': 'a',
              'lan': ['http://192.168.1.120:8080'],
              'public_url': 'https://a.example.ir',
              'at': now.subtract(const Duration(minutes: 3)).toIso8601String(),
            },
          ],
        });
        final c = client();
        final list = await c.entries();
        expect(list.map((e) => e.instance), ['a', 'b']);
        expect((await c.candidates()).map((u) => u.host), [
          '192.168.1.120',
          '192.168.1.50',
          'a.example.ir',
          'b.example.ir',
        ]);
        expect(seenHeaders.first, 'no-cache');
      },
    );

    test('DF-04 NEG: 403 / not JSON / other kind ⇒ no candidates', () async {
      status = 403;
      body = '<Error>AccessDenied</Error>';
      expect(await client().candidates(), isEmpty);
      status = 200;
      body = 'not json';
      expect(await client().candidates(), isEmpty);
      body = jsonEncode({'kind': 'other', 'servers': <Object>[]});
      expect(await client().candidates(), isEmpty);
    });

    test('DF-05 no list in this build (no PAYESH_SERVERS_URL) ⇒ no request, no candidates', () async {
      expect(SchoolDirectoryClient.defaultUrl, isNull);
      final c = SchoolDirectoryClient(client: HttpClient());
      expect(await c.candidates(), isEmpty);
      expect(seenHeaders, isEmpty);
    });
  });

  group('firstAnswering', () {
    test(
      'DF-06 asks all at once; the first that answers wins, failures ignored',
      () async {
        final slow = Completer<LanServerInfo>();
        final api = _ProbeOnly({
          '192.168.1.120': slow,
          '192.168.1.50': _info('192.168.1.50'),
        });
        final r = await firstAnswering(api, [
          Uri.parse('http://192.168.1.120:8080'),
          Uri.parse('http://10.0.0.9:8080'),
          Uri.parse('http://192.168.1.50:8080'),
        ]);
        expect(r?.server.host, '192.168.1.50');
        expect(api.probed, ['192.168.1.120', '10.0.0.9', '192.168.1.50']);
        slow.complete(_info('192.168.1.120'));
      },
    );

    test('DF-07 NEG: none answers / empty list ⇒ null', () async {
      final api = _ProbeOnly({});
      expect(
        await firstAnswering(api, [Uri.parse('http://10.0.0.9:8080')]),
        isNull,
      );
      expect(await firstAnswering(api, const []), isNull);
    });
  });
}
