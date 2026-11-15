import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/infra/server_panel.dart';
import 'package:payesh_owner/src/local/central_server.dart';
import 'package:payesh_owner/src/local/cloud_control.dart';
import 'package:payesh_owner/src/local/local_platform.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'support/fake_bucket.dart';

/// ردیف ۱۶۴ — «تعریف سرور»: یک دیتابیس برای همه، و نشانی عمومی‌ای که همهٔ برنامه‌ها از هر
/// اینترنتی از راه آن وصل می‌شوند (سرور مرکزی مالک، یا تونل رایگان سرور پایش).
void main() {
  final t0 = DateTime.utc(2026, 11, 15, 22);
  final settings = S3Settings(
    endpoint: Uri.https('s3.example.test'),
    accessKey: 'ak',
    secretKey: 'sk',
    bucket: 'payesh-madrese',
  );

  String listWith(Map<String, Object?> extra) => jsonEncode({
    'v': 1,
    'kind': serversListKind,
    'at': '2026-11-15T21:00:00.000Z',
    'servers': [
      {
        'instance': 'dd9286ad1f5d3ccb',
        'school': null,
        'lan': ['http://192.168.1.120:8080'],
        'public_url': null,
        'version': '0.9.18',
        'at': '2026-11-15T21:00:00.000Z',
      },
    ],
    ...extra,
  });

  group('normalizeCentral', () {
    test('S164-01 only plain https origins', () {
      expect(
        normalizeCentral(' https://Server.Example.ir/ ').toString(),
        'https://server.example.ir',
      );
      expect(
        normalizeCentral('https://a.example.ir:8443').toString(),
        'https://a.example.ir:8443',
      );
      for (final bad in [
        '',
        'http://server.example.ir',
        'https://u:p@server.example.ir',
        'https://server.example.ir/api',
        'https://server.example.ir/?x=1',
        'ftp://server.example.ir',
        'server.example.ir',
      ]) {
        expect(normalizeCentral(bad), isNull, reason: bad);
      }
    });
  });

  group('publishCentral', () {
    test('S164-02 writes `central` publicly, keeps the servers rows, removes on null', () async {
      final b = FakeBucket(() => t0)..putText(serversListKey, listWith({}));
      final t = b.transport();
      await publishCentral(
        settings,
        t,
        Uri.parse('https://server.example.ir'),
        now: () => t0,
      );
      final doc = jsonDecode(b.text(serversListKey)!) as Map;
      expect(doc['kind'], serversListKind);
      expect((doc['central'] as Map)['url'], 'https://server.example.ir');
      expect(
        ((doc['servers'] as List).single as Map)['instance'],
        'dd9286ad1f5d3ccb',
      );
      expect(b.putHeaders[serversListKey]!['x-amz-acl'], 'public-read');
      expect(
        b.putHeaders[serversListKey]!['authorization'],
        contains('x-amz-acl'),
        reason: 'the ACL header is signed',
      );
      final parsed = parseServersList(b.text(serversListKey));
      expect(parsed.central.toString(), 'https://server.example.ir');
      expect(parsed.servers.single.lan, 1);

      await publishCentral(settings, t, null, now: () => t0);
      final doc2 = jsonDecode(b.text(serversListKey)!) as Map;
      expect(doc2.containsKey('central'), isFalse);
      expect((doc2['servers'] as List), hasLength(1));
    });

    test(
      'S164-03 no list yet ⇒ a fresh, valid list with only central',
      () async {
        final b = FakeBucket(() => t0);
        await publishCentral(
          settings,
          b.transport(),
          Uri.parse('https://server.example.ir'),
          now: () => t0,
        );
        final p = parseServersList(b.text(serversListKey));
        expect(p.central.toString(), 'https://server.example.ir');
        expect(p.servers, isEmpty);
      },
    );
  });

  group('Follower (server ack)', () {
    test('S164-04 public address and the Tailscale approval link only', () {
      final f = Follower.fromJson(
        jsonEncode({
          'v': 1,
          'server_id': 'a1b2c3d4e5f60718',
          'host': 'REZA',
          'rev': 3,
          'ok': true,
          'at': '2026-11-15T21:00:00Z',
          'public_url': null,
          'tunnel': {
            'ok': false,
            'error': 'funnel_not_enabled',
            'enable_url':
                'https://login.tailscale.com/f/funnel?node=n2Uw2YhHb811CNTRL',
          },
        }),
      )!;
      expect(f.publicUrl, isNull);
      expect(f.tunnelEnableUrl, contains('login.tailscale.com/f/funnel'));
      expect(f.tunnelError, 'funnel_not_enabled');
      final evil = Follower.fromJson(
        jsonEncode({
          'v': 1,
          'server_id': 'x',
          'rev': 1,
          'public_url': 'http://1.2.3.4',
          'tunnel': {'enable_url': 'https://evil.example/f/funnel'},
        }),
      )!;
      expect(evil.tunnelEnableUrl, isNull);
      expect(evil.publicUrl, isNull);
    });
  });

  group('ServerDefinitionPanel', () {
    Future<(FakeBucket, FakeSecureStore, List<Uri>)> pump(
      WidgetTester tester, {
      Future<CheckOutcome> Function(Map<String, Object?>)? check,
      bool withDb = true,
    }) async {
      final b = FakeBucket(() => t0)
        ..putText(serversListKey, listWith({}))
        ..putText(
          '${ackPrefix}a1b2c3d4e5f60718.json',
          jsonEncode({
            'v': 1,
            'server_id': 'a1b2c3d4e5f60718',
            'host': 'REZA',
            'rev': 3,
            'ok': true,
            'at': '2026-11-15T21:00:00Z',
            'version': '0.9.18',
            'tunnel': {
              'ok': false,
              'error': 'funnel_not_enabled',
              'enable_url':
                  'https://login.tailscale.com/f/funnel?node=n2Uw2YhHb811CNTRL',
            },
          }),
        );
      final secure = FakeSecureStore();
      if (withDb) await settings.save(secure);
      final opened = <Uri>[];
      tester.view.physicalSize = const Size(900, 1400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: PayeshUi.light(look: PayeshLook.nabd),
          home: Directionality(
            textDirection: TextDirection.rtl,
            child: Scaffold(
              body: SingleChildScrollView(
                child: ServerDefinitionPanel(
                  secure: secure,
                  transportFactory: b.transport,
                  now: () => t0,
                  openUrl: (u) async => opened.add(u),
                  check:
                      check ??
                      (_) async => const CheckOutcome(ok: true, latencyMs: 42),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return (b, secure, opened);
    }

    String text(WidgetTester tester, String key) =>
        tester.widget<Text>(find.byKey(Key(key))).data!;

    testWidgets(
      'S164-05 LAN only ⇒ says so (red), offers the one-time tunnel approval',
      (tester) async {
        final (_, _, opened) = await pump(tester);
        expect(text(tester, 'server-reach'), contains('فقط در شبکهٔ داخلی'));
        final approve = find.byKey(
          const Key('server-tunnel-approve-a1b2c3d4e5f60718'),
        );
        expect(approve, findsOneWidget);
        await tester.tap(approve);
        await tester.pumpAndSettle();
        expect(opened.single.host, 'login.tailscale.com');
      },
    );

    testWidgets(
      'S164-06 bad address refused; good address saved, announced, tested, cleared',
      (tester) async {
        final (b, _, _) = await pump(tester);
        await tester.enterText(
          find.byKey(const Key('server-url')),
          'http://server.example.ir',
        );
        await tester.tap(find.byKey(const Key('server-save')));
        await tester.pumpAndSettle();
        expect(text(tester, 'server-msg'), contains('درست نیست'));
        expect(parseServersList(b.text(serversListKey)).central, isNull);

        await tester.enterText(
          find.byKey(const Key('server-url')),
          'https://server.example.ir',
        );
        await tester.tap(find.byKey(const Key('server-save')));
        await tester.pumpAndSettle();
        expect(text(tester, 'server-msg'), contains('اعلام شد'));
        expect(
          parseServersList(b.text(serversListKey)).central.toString(),
          'https://server.example.ir',
        );
        expect(text(tester, 'server-reach'), contains('سرور مرکزی'));

        await tester.tap(find.byKey(const Key('server-test')));
        await tester.pumpAndSettle();
        expect(text(tester, 'server-msg'), contains('جواب داد'));

        await tester.tap(find.byKey(const Key('server-clear')));
        await tester.pumpAndSettle();
        expect(parseServersList(b.text(serversListKey)).central, isNull);
        expect(text(tester, 'server-msg'), contains('حذف شد'));
      },
    );

    testWidgets('S164-07 no database yet ⇒ asks for «تعریف دیتابیس» first', (
      tester,
    ) async {
      await pump(tester, withDb: false);
      expect(text(tester, 'server-load-error'), contains('تعریف دیتابیس'));
      await tester.enterText(
        find.byKey(const Key('server-url')),
        'https://server.example.ir',
      );
      await tester.tap(find.byKey(const Key('server-save')));
      await tester.pumpAndSettle();
      expect(text(tester, 'server-msg'), contains('تعریف دیتابیس'));
    });

    testWidgets(
      'S164-08 server does not answer ⇒ red message with the reason',
      (tester) async {
        await pump(
          tester,
          check: (_) async =>
              const CheckOutcome(ok: false, errorCode: 'dns_failed'),
        );
        await tester.enterText(
          find.byKey(const Key('server-url')),
          'https://server.example.ir',
        );
        await tester.tap(find.byKey(const Key('server-test')));
        await tester.pumpAndSettle();
        expect(text(tester, 'server-msg'), contains('dns_failed'));
      },
    );
  });
}
