import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/helper/helper_jobs.dart';
import 'package:payesh_owner/src/helper/helper_node.dart';
import 'package:payesh_owner/src/helper/host_cpu.dart';
import 'package:payesh_owner/src/infra/connect_modes_card.dart';
import 'package:payesh_owner/src/local/central_server.dart';
import 'package:payesh_owner/src/local/local_platform.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'support/fake_bucket.dart';

/// ردیف ۱۶۵ — «حالت اتصال» (زیرساخت، ستون راست): مالک راه رسیدن کاربران بیرون از مدرسه را
/// انتخاب می‌کند؛ انتخاب در فهرست نشانی‌های دیتابیس (connect) می‌رود و نشانی‌های عمومی هر سرور
/// (Cloudflare / Tailscale / دستی) با چراغ وضعیت دیده می‌شوند. به‌علاوه: مصرف زندهٔ پردازنده و
/// گزارش کار لحظه‌ای همین دستگاه وقتی سرور کمکی است.
void main() {
  final t0 = DateTime.utc(2026, 11, 16, 8);
  final settings = S3Settings(
    endpoint: Uri.https('s3.example.test'),
    accessKey: 'ak',
    secretKey: 'sk',
    bucket: 'payesh-madrese',
  );
  String list({String? mode, List<String> urls = const []}) => jsonEncode({
    'v': 1,
    'kind': serversListKind,
    'at': '2026-11-16T07:59:00.000Z',
    'servers': [
      {
        'instance': 'dd9286ad1f5d3ccb',
        'school': null,
        'lan': ['http://192.168.1.120:8080'],
        'public_url': urls.isEmpty ? null : urls.first,
        'public_urls': urls,
        'version': '0.9.19',
        'at': '2026-11-16T07:59:00.000Z',
      },
    ],
    'central': {'url': 'https://c.example.ir', 'at': '2026-11-15T00:00:00Z'},
    if (mode != null) 'connect': {'mode': mode, 'at': '2026-11-15T00:00:00Z'},
  });

  group('list', () {
    test('C165-01 connect mode + every public address parsed (https only)', () {
      final p = parseServersList(
        list(
          mode: 'cloudflare',
          urls: [
            'https://x.trycloudflare.com',
            'https://reza.tailb692ba.ts.net',
            'http://plain.example',
          ],
        ),
      );
      expect(p.connectMode, 'cloudflare');
      expect(p.servers.single.publicUrls, [
        'https://x.trycloudflare.com',
        'https://reza.tailb692ba.ts.net',
      ]);
      expect(p.servers.single.version, '0.9.19');
      expect(parseServersList(list(mode: 'evil')).connectMode, 'auto');
      expect(parseServersList(list()).connectMode, 'auto');
      expect(publicUrlKind('https://x.trycloudflare.com'), 'cloudflare');
      expect(publicUrlKind('https://a.b.ts.net'), 'tailscale');
      expect(publicUrlKind('https://school.example.ir'), 'custom');
    });

    test('C165-02 publishConnectMode writes connect publicly, keeps servers + central', () async {
      final b = FakeBucket(() => t0)..putText(serversListKey, list());
      await publishConnectMode(settings, b.transport(), 'lan', now: () => t0);
      final doc = jsonDecode(b.text(serversListKey)!) as Map;
      expect(doc['connect'], {'mode': 'lan', 'at': t0.toIso8601String()});
      expect((doc['servers'] as List).length, 1);
      expect((doc['central'] as Map)['url'], 'https://c.example.ir');
      expect(b.putHeaders[serversListKey]?['x-amz-acl'], 'public-read');
      expect(
        () => publishConnectMode(settings, b.transport(), 'x'),
        throwsArgumentError,
      );
    });
  });

  group('ConnectModesCard', () {
    Future<FakeBucket> pump(
      WidgetTester tester, {
      String? mode,
      List<String> urls = const [],
      bool withDb = true,
      Set<String> down = const {},
    }) async {
      final b = FakeBucket(() => t0)
        ..putText(serversListKey, list(mode: mode, urls: urls));
      final secure = FakeSecureStore();
      if (withDb) await settings.save(secure);
      tester.view.physicalSize = const Size(620, 1500);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: PayeshUi.light(look: PayeshLook.nabd),
          home: Directionality(
            textDirection: TextDirection.rtl,
            child: Scaffold(
              body: SingleChildScrollView(
                child: ConnectModesCard(
                  secure: secure,
                  transportFactory: b.transport,
                  now: () => t0,
                  check: (e) async =>
                      down.any((d) => '${e['url']}'.startsWith(d))
                      ? const CheckOutcome(ok: false, errorCode: 'timeout')
                      : const CheckOutcome(ok: true, latencyMs: 87),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return b;
    }

    testWidgets(
      'C165-03 five modes, the saved one selected; addresses with live state',
      (tester) async {
        await pump(
          tester,
          mode: 'cloudflare',
          urls: ['https://x.trycloudflare.com'],
          down: {'https://c.example.ir'},
        );
        for (final m in connectModes) {
          expect(find.byKey(Key('connect-mode-$m')), findsOneWidget);
        }
        expect(
          find.descendant(
            of: find.byKey(const Key('connect-mode-cloudflare')),
            matching: find.byIcon(Icons.radio_button_checked),
          ),
          findsOneWidget,
        );
        expect(
          tester.widget<Text>(find.byKey(const Key('connect-status'))).data,
          'از هر اینترنتی وصل می‌شود.',
        );
        expect(
          find.byKey(const Key('connect-url-https://x.trycloudflare.com')),
          findsOneWidget,
        );
        expect(find.textContaining('در دسترس'), findsOneWidget);
        expect(find.text('جواب نداد'), findsOneWidget, reason: 'central down');
      },
    );

    testWidgets('C165-04 a tap saves the mode for every server', (
      tester,
    ) async {
      final b = await pump(tester);
      await tester.tap(find.byKey(const Key('connect-mode-tailscale')));
      await tester.pumpAndSettle();
      expect(parseServersList(b.text(serversListKey)).connectMode, 'tailscale');
      expect(
        tester.widget<Text>(find.byKey(const Key('connect-msg'))).data,
        contains('Tailscale Funnel'),
      );
    });

    testWidgets('C165-05 NEG no database ⇒ says so, nothing selectable', (
      tester,
    ) async {
      final b = await pump(tester, withDb: false);
      expect(find.byKey(const Key('connect-error')), findsOneWidget);
      await tester.tap(find.byKey(const Key('connect-mode-lan')));
      await tester.pumpAndSettle();
      expect(parseServersList(b.text(serversListKey)).connectMode, 'auto');
    });

    testWidgets(
      'C165-06 no public address yet ⇒ warns (not a false «connected»)',
      (tester) async {
        await pump(tester, down: {'https://c.example.ir'});
        expect(
          tester.widget<Text>(find.byKey(const Key('connect-status'))).data,
          isNot('از هر اینترنتی وصل می‌شود.'),
        );
      },
    );
  });

  group('live helper (this computer)', () {
    test('C165-07 CPU percent from two samples (/proc/stat shape)', () {
      expect(parseProcStat('cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3 4'), (
        idle: 800,
        total: 1000,
      ));
      expect(parseProcStat('nope'), isNull);
      final q = <CpuTimes>[
        (idle: 800, total: 1000),
        (idle: 850, total: 1100),
        (idle: 860, total: 1200),
      ];
      var i = 0;
      final m = HostCpuMeter(read: () => q[i++]);
      expect(m.sample(), isNull, reason: 'first sample only marks');
      expect(m.sample(), 50);
      expect(m.sample(), 90);
      expect(m.history, [50, 90]);
      expect(HostCpuMeter(read: () => null).sample(), isNull);
    });

    test('C165-08 activity log: repeats fold (×n), newest first, max 50', () {
      final node = HelperNode(
        helperId: 'h1',
        transport: () => throw StateError('no s3'),
        executor: JobExecutor(transport: () => throw StateError('no s3')),
        now: () => t0,
        host: 'REZA',
      );
      node.noteSubmitted(
        'storage.usage',
        const JobOutcome(ok: true, by: 'local'),
      );
      node.noteSubmitted(
        'storage.usage',
        const JobOutcome(ok: true, by: 'local'),
      );
      expect(node.activity.length, 1);
      expect(node.activity.first.count, 2);
      expect(node.activity.first.text, contains('محاسبهٔ مصرف فضای دیتابیس'));
      node.noteSubmitted(
        'bucket.gc',
        const JobOutcome(ok: false, by: 'local', error: 's3'),
      );
      expect(node.activity.first.ok, isFalse);
      expect(node.activity.first.text, contains('ناموفق'));
    });
  });
}
