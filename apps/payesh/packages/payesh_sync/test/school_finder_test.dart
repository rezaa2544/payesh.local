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
      useDomain: false,
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

    test('DF-08 row 164: the owner\'s central server (from any internet) comes first', () async {
      body = jsonEncode({
        'v': 1,
        'kind': 'payesh-school-servers',
        'central': {
          'url': 'https://Server.Example.ir/',
          'at': '2026-11-15T22:00:00Z',
        },
        'servers': [
          {
            'instance': 'a',
            'lan': ['http://192.168.1.120:8080'],
            'public_url': 'https://reza.tailb692ba.ts.net',
            'at': now.subtract(const Duration(minutes: 3)).toIso8601String(),
          },
        ],
      });
      final c = client();
      expect((await c.candidates()).map((u) => u.toString()), [
        'https://server.example.ir',
        'http://192.168.1.120:8080',
        'https://reza.tailb692ba.ts.net',
      ]);
      expect(c.central.toString(), 'https://server.example.ir');
      // only a central and no rows ⇒ still usable
      body = jsonEncode({
        'v': 1,
        'kind': 'payesh-school-servers',
        'central': {'url': 'https://server.example.ir'},
        'servers': <Object>[],
      });
      expect((await c.candidates()).single.host, 'server.example.ir');
    });

    test('DF-09 NEG row 164: central must be plain https', () async {
      for (final bad in [
        'http://server.example.ir',
        'https://u:p@server.example.ir',
        'ftp://x',
        '',
        42,
      ]) {
        expect(
          SchoolDirectoryClient.centralOf({'url': bad}),
          isNull,
          reason: '$bad',
        );
      }
      expect(SchoolDirectoryClient.centralOf(null), isNull);
      expect(SchoolDirectoryClient.centralOf('https://x.ir'), isNull);
      body = jsonEncode({
        'v': 1,
        'kind': 'payesh-school-servers',
        'central': {'url': 'http://server.example.ir'},
        'servers': <Object>[],
      });
      final c = client();
      expect(await c.candidates(), isEmpty);
      expect(c.central, isNull);
    });

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
      final c = SchoolDirectoryClient(client: HttpClient(), useDomain: false);
      expect(await c.candidates(), isEmpty);
      expect(seenHeaders, isEmpty);
    });

    test('DF-170 row 170: the domain copy is read first; down / invalid ⇒ the baked list', () async {
      expect(
        SchoolDirectoryClient.defaultDomainUrl.toString(),
        'https://payeshschool.ir/payesh/pub/school-servers.json',
      );
      final dom = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => dom.close(force: true));
      var domStatus = 200;
      var domBody = '';
      final hits = <String>[];
      dom.listen((req) {
        hits.add(req.uri.path);
        req.response
          ..statusCode = domStatus
          ..write(domBody);
        unawaited(req.response.close());
      });
      String list(String instance, String lan) => jsonEncode({
        'v': 1,
        'kind': 'payesh-school-servers',
        'servers': [
          {
            'instance': instance,
            'lan': [lan],
            'at': now.subtract(const Duration(minutes: 1)).toIso8601String(),
          },
        ],
      });
      domBody = list('moved', 'http://192.168.7.7:8080');
      body = list('baked', 'http://192.168.1.10:8080');
      final domPort = dom.port;
      SchoolDirectoryClient c() => SchoolDirectoryClient(
        url: Uri.parse(
          'http://127.0.0.1:${server.port}/pub/school-servers.json',
        ),
        domain: Uri.parse(
          'http://127.0.0.1:$domPort/payesh/pub/school-servers.json',
        ),
        client: HttpClient(),
        now: () => now,
      );
      expect((await c().entries()).single.instance, 'moved');
      expect(
        seenHeaders,
        isEmpty,
        reason: 'the baked list is not asked when the domain answers',
      );
      domStatus = 404;
      expect((await c().entries()).single.instance, 'baked');
      domStatus = 200;
      domBody = '<html>parked domain</html>';
      expect((await c().entries()).single.instance, 'baked');
      await dom.close(force: true);
      expect(
        (await c().entries()).single.instance,
        'baked',
        reason: 'domain down',
      );
      expect(hits, everyElement('/payesh/pub/school-servers.json'));
    });

    group('row 171 — reachable from any network', () {
      String list(String instance, {String? central}) => jsonEncode({
        'v': 1,
        'kind': 'payesh-school-servers',
        if (central != null)
          'central': {'url': central, 'at': now.toIso8601String()},
        'servers': [
          {
            'instance': instance,
            'lan': ['http://192.168.1.101:8080'],
            'public_url': 'https://$instance.example.ir',
            'at': now.subtract(const Duration(minutes: 1)).toIso8601String(),
          },
        ],
      });

      test('DF-171a defaults: GitHub copy of the list and the central server on the project domain', () {
        expect(
          SchoolDirectoryClient.defaultMirrorUrl.toString(),
          'https://raw.githubusercontent.com/rezaa2544/payesh.local/directory/school-servers.json',
        );
        expect(
          SchoolDirectoryClient.defaultCentral.toString(),
          'https://app.payeshschool.ir',
        );
        final prod = SchoolDirectoryClient(client: HttpClient());
        expect(prod.mirrorUrl, SchoolDirectoryClient.defaultMirrorUrl);
        expect(prod.fallbackCentral, SchoolDirectoryClient.defaultCentral);
        final off = SchoolDirectoryClient(
          client: HttpClient(),
          useDomain: false,
        );
        expect(off.mirrorUrl, isNull);
        expect(off.fallbackCentral, isNull);
      });

      test('DF-171b domain and database copy down (a phone abroad) ⇒ the GitHub copy is read', () async {
        final mir = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        addTearDown(() => mir.close(force: true));
        final hits = <String>[];
        mir.listen((req) {
          hits.add(req.uri.path);
          req.response.write(list('abroad'));
          unawaited(req.response.close());
        });
        final dead = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        final deadPort = dead.port;
        await dead.close(force: true);
        final c = SchoolDirectoryClient(
          url: Uri.parse('http://127.0.0.1:$deadPort/pub/school-servers.json'),
          domain: Uri.parse(
            'http://127.0.0.1:$deadPort/payesh/pub/school-servers.json',
          ),
          mirror: Uri.parse(
            'http://127.0.0.1:${mir.port}/directory/school-servers.json',
          ),
          central: Uri.parse('https://central.example.ir'),
          client: HttpClient(),
          now: () => now,
        );
        expect((await c.entries()).single.instance, 'abroad');
        expect(hits, ['/directory/school-servers.json']);
        expect((await c.candidates()).map((u) => u.toString()), [
          'https://central.example.ir',
          'http://192.168.1.101:8080',
          'https://abroad.example.ir',
        ], reason: 'no central in the list ⇒ the built-in one first');
      });

      test('DF-171c the list has its own central ⇒ it is first, the built-in one is still tried last; no list at all ⇒ the built-in one alone', () async {
        body = list('pc', central: 'https://owner.example.ir');
        final c = SchoolDirectoryClient(
          url: Uri.parse(
            'http://127.0.0.1:${server.port}/pub/school-servers.json',
          ),
          useDomain: false,
          central: Uri.parse('https://central.example.ir'),
          client: HttpClient(),
          now: () => now,
        );
        expect((await c.candidates()).map((u) => u.toString()), [
          'https://owner.example.ir',
          'http://192.168.1.101:8080',
          'https://pc.example.ir',
          'https://central.example.ir',
        ]);
        final none = SchoolDirectoryClient(
          useDomain: false,
          central: Uri.parse('https://central.example.ir'),
          client: HttpClient(),
        );
        expect((await none.candidates()).map((u) => u.toString()), [
          'https://central.example.ir',
        ]);
      });
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
