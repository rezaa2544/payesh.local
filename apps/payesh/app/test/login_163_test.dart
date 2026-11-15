// Row 163 — NO server address on the login screen. The app finds the school server by itself:
// the remembered server and this computer, then (when a school server is installed here but not
// running) it starts it, then the address-only list in the owner's database. The card says
// whether the school database is connected and offers «تلاش دوباره». Real controller + real
// screens, scripted school server, scripted directory / local starter; LocalSchoolServer with
// scripted file system and processes.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/login/local_server.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'lan_mode_127_test.dart' hide main;
import 'login_162_test.dart' hide main;

const _down = LanAccessFailure(LanAccessError.unreachable);

final class FakeDirectory implements SchoolDirectoryApi {
  FakeDirectory(this.lists);

  /// One answer per call (a list of addresses or an error); the last one repeats.
  final List<Object> lists;
  var calls = 0;

  @override
  Future<List<Uri>> candidates() async {
    final a = lists[calls < lists.length ? calls : lists.length - 1];
    calls++;
    if (a is List<Uri>) return a;
    throw a;
  }
}

String pillText(WidgetTester tester) =>
    tester.widget<Text>(find.byKey(const Key('lan-connection-text'))).data!;

void main() {
  group('login without a server address', () {
    testWidgets(
      'L163-01 nothing remembered, nothing here: the owner database list gives the school server; the card says «وصل به دیتابیس مدرسه» and one press signs in',
      (tester) async {
        final store = FakeSecureStore();
        final dir = FakeDirectory([
          [lanServer],
        ]);
        final lan = FakeLan()
          ..probes.addAll([_down, info162()])
          ..logins.add(lanSession());
        final c = await bootProd(tester, lan, store: store, directory: dir);
        expect(find.byKey(const Key('lan-server')), findsNothing);
        expect(find.textContaining('نشانی'), findsNothing);
        expect(pillText(tester), 'وصل به دیتابیس مدرسه · هنرستان شهید آزمون');
        expect(find.byKey(const Key('lan-retry')), findsNothing);
        expect(dir.calls, 1);
        expect(
          await store.read(LanKeys.lastServer),
          'http://192.168.1.10:8080',
        );
        await typeAndTap(tester, {
          'lan-phone': '09121234567',
          'lan-password': '0012345678',
        }, 'lan-login');
        expect(c.state, isA<SignedIn>());
        expect(lan.calls, [
          'probe:127.0.0.1:8080',
          'probe:192.168.1.10:8080',
          'login:09121234567:0012345678',
        ]);
      },
    );

    testWidgets(
      'L163-02 school server installed on this computer but off: the app starts it and connects to it (the list is not needed)',
      (tester) async {
        var starts = 0;
        final dir = FakeDirectory([
          [lanServer],
        ]);
        final lan = FakeLan()..probes.addAll([_down, info162()]);
        final c = await bootProd(
          tester,
          lan,
          directory: dir,
          startLocal: () async {
            starts++;
            return true;
          },
        );
        expect(starts, 1);
        expect(dir.calls, 0);
        expect((c.state as NeedLan).info, isNotNull);
        expect(lan.calls, ['probe:127.0.0.1:8080', 'probe:127.0.0.1:8080']);
        expect(find.byKey(const Key('lan-connection')), findsOneWidget);
      },
    );

    testWidgets(
      'L163-03 NEG nothing answers: red line + «تلاش دوباره»; a press says why (nothing sent); retry finds the server, then login works',
      (tester) async {
        final dir = FakeDirectory([
          const SocketException('offline'),
          [lanServer],
        ]);
        final lan = FakeLan()
          ..probes.addAll([_down, _down, _down, info162()])
          ..logins.add(lanSession());
        final c = await bootProd(
          tester,
          lan,
          directory: dir,
          startLocal: () async => false,
        );
        expect((c.state as NeedLan).notFound, isTrue);
        expect(pillText(tester), 'اتصال به دیتابیس مدرسه برقرار نشد');
        expect(find.byKey(const Key('lan-retry')), findsOneWidget);
        // a press searches once more, then tells why — no login is sent
        await typeAndTap(tester, {
          'lan-phone': '09121234567',
          'lan-password': '0012345678',
        }, 'lan-login');
        expect(errorText(tester), SessionController.lanNotFoundFa);
        expect(lan.calls.where((x) => x.startsWith('login')), isEmpty);
        // what was typed stays
        expect(
          tester
              .widget<TextField>(find.byKey(const Key('lan-phone')))
              .controller!
              .text,
          '09121234567',
        );
        await tester.tap(find.byKey(const Key('lan-retry')));
        await tester.pumpAndSettle();
        expect(pillText(tester), startsWith('وصل به دیتابیس مدرسه'));
        await typeAndTap(tester, {'lan-password': '0012345678'}, 'lan-login');
        expect(c.state, isA<SignedIn>());
        expect(lan.calls.last, 'login:09121234567:0012345678');
      },
    );

    testWidgets(
      'L163-04 the login card on a phone and on a wide screen: brand, method tabs, no address',
      (tester) async {
        for (final size in const [Size(390, 844), Size(1280, 800)]) {
          tester.view.physicalSize = size;
          tester.view.devicePixelRatio = 1;
          final lan = FakeLan()..probes.add(info162());
          await bootProd(tester, lan);
          expect(find.byKey(const Key('login-title')), findsOneWidget);
          expect(find.text('نام کاربری و رمز'), findsOneWidget);
          expect(find.text('شماره و کد پیامکی'), findsOneWidget);
          expect(find.byKey(const Key('lan-server')), findsNothing);
          expect(tester.takeException(), isNull);
        }
        tester.view.reset();
      },
    );
  });

  group('LocalSchoolServer', () {
    const pf = r'C:\Program Files';
    final env = {
      'ProgramFiles': pf,
      'ProgramData': r'C:\ProgramData',
      'LOCALAPPDATA': r'C:\Users\u\AppData\Local',
    };

    test('LS-01 not Windows / nothing installed ⇒ nothing started', () async {
      final runs = <String>[];
      expect(
        await LocalSchoolServer(
          env: env,
          windows: false,
          exists: (_) => true,
          run: (e, a) async {
            runs.add(e);
            return ProcessResult(0, 0, '', '');
          },
        ).start(),
        isFalse,
      );
      expect(
        await LocalSchoolServer(
          env: env,
          windows: true,
          exists: (_) => false,
        ).start(),
        isFalse,
      );
      expect(runs, isEmpty);
    });

    test(
      'LS-02 Payesh Data Service installed ⇒ its boot task is run',
      () async {
        final runs = <String>[];
        final ok = await LocalSchoolServer(
          env: env,
          windows: true,
          exists: (p) => p == '$pf\\PayeshDataService\\server\\start.js',
          run: (e, a) async {
            runs.add('$e ${a.join(' ')}');
            return ProcessResult(0, 0, '', '');
          },
          spawn: (e, a, c, v) async => fail('no spawn expected'),
        ).start();
        expect(ok, isTrue);
        expect(runs, ['schtasks.exe /Run /TN PayeshDataService']);
      },
    );

    test('LS-03 school system of payesh.iss ⇒ its own node runs server\\start.js on 8080 with the window\'s data folder', () async {
      final spawned = <(String, List<String>, String, Map<String, String>)>[];
      final files = {
        '$pf\\Payesh\\server\\start.js',
        '$pf\\Payesh\\runtime\\node.exe',
        r'C:\ProgramData\Payesh\data\payesh.sqlite',
      };
      final s = LocalSchoolServer(
        env: env,
        windows: true,
        exists: files.contains,
        run: (e, a) async => ProcessResult(0, 1, '', 'no task'),
        spawn: (e, a, c, v) async => spawned.add((e, a, c, v)),
      );
      expect(s.schoolSystem, '$pf\\Payesh');
      expect(s.dataService, isNull);
      expect(await s.start(), isTrue);
      expect(spawned, hasLength(1));
      final (exe, args, cwd, vars) = spawned.single;
      expect(exe, '$pf\\Payesh\\runtime\\node.exe');
      expect(args.last, r'server\start.js');
      expect(cwd, '$pf\\Payesh');
      expect(vars['PORT'], '8080');
      expect(vars['PAYESH_DATA'], r'C:\ProgramData\Payesh\data');
      expect(vars['PAYESH_TUNNEL_AUTO'], '1');
      expect(vars.containsKey('PAYESH_HEADLESS'), isFalse);
    });

    test(
      'LS-04 data service task fails ⇒ its node is started headless',
      () async {
        final spawned = <Map<String, String>>[];
        final files = {
          '$pf\\PayeshDataService\\server\\start.js',
          '$pf\\PayeshDataService\\node.exe',
        };
        final ok = await LocalSchoolServer(
          env: env,
          windows: true,
          exists: files.contains,
          run: (e, a) async => throw const ProcessException('schtasks', []),
          spawn: (e, a, c, v) async => spawned.add(v),
        ).start();
        expect(ok, isTrue);
        expect(spawned.single['PAYESH_HEADLESS'], '1');
      },
    );

    test('LS-05 data folder: PAYESH_DATA, then ProgramData, then per-user', () {
      LocalSchoolServer s(Map<String, String> e, Set<String> f) =>
          LocalSchoolServer(env: e, windows: true, exists: f.contains);
      expect(s({...env, 'PAYESH_DATA': r'D:\pd'}, {}).dataDir(), r'D:\pd');
      expect(
        s(env, {
          r'C:\Users\u\AppData\Local\Payesh\data\payesh.sqlite',
        }).dataDir(),
        r'C:\Users\u\AppData\Local\Payesh\data',
      );
      expect(s(env, {}).dataDir(), r'C:\ProgramData\Payesh\data');
    });

    test(
      'LS-06 NEG no node next to the server ⇒ false, spawn errors ⇒ false',
      () async {
        expect(
          await LocalSchoolServer(
            env: env,
            windows: true,
            exists: (p) => p == '$pf\\Payesh\\server\\start.js',
          ).start(),
          isFalse,
        );
        expect(
          await LocalSchoolServer(
            env: env,
            windows: true,
            exists: (p) => p.startsWith('$pf\\Payesh\\'),
            spawn: (e, a, c, v) async =>
                throw const ProcessException('node', []),
          ).start(),
          isFalse,
        );
      },
    );
  });
}
