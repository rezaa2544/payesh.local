// Row 165 — the school app's look on the phone (owner screenshots of 0.2.168):
//   • the version pill no longer covers the AppBar (its strip is reserved above every page);
//   • the signed-in home is a grid of EQUAL tiles in short sections (was uneven buttons), with a
//     clean header card and no debug footer (`sync-v1`, «نسخهٔ بومی پایش»);
//   • a new version is a clear card with «نصب» — installed in the app (system installer), not
//     only a small orange light;
//   • «حافظهٔ ابری» with the school server out of reach: one calm sentence + «دوباره», never a
//     red bar over a page stuck on «در حال خواندن…».
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_app/src/update/app_update.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';
import 'package:payesh_update/payesh_update.dart';

import 'nav_support.dart';
import 'school_support.dart';
import 'system_wave12_test.dart' show FakeAdmin, open;

final _apk = List<int>.filled(64, 7);

/// Manifest (build 9) + the APK itself.
final class _Http implements UpdateHttp {
  _Http({this.build = 9});
  final int build;
  final hits = <String>[];

  @override
  Future<List<int>?> get(
    Uri url, {
    int maxBytes = 1 << 30,
    void Function(int received)? onBytes,
  }) async {
    hits.add(url.path.split('/').last);
    if (url.path.endsWith('/app-update.json')) {
      return utf8.encode(
        jsonEncode(<String, Object?>{
          'schema': appUpdateSchema,
          'build': build,
          'commit': 'c' * 40,
          'files': [
            {
              'path': 'payesh_app.exe',
              'sha256': 'b' * 64,
              'size': 10,
              'gz_size': 10,
            },
          ],
          'android': {
            'sha256': sha256.convert(_apk).toString(),
            'size': _apk.length,
          },
        }),
      );
    }
    if (url.path.endsWith('.apk')) {
      onBytes?.call(_apk.length);
      return _apk;
    }
    return null;
  }

  @override
  void close() {}
}

final class _Installer implements ApkInstaller {
  _Installer(this.dir);
  final Directory dir;
  final installed = <String>[];

  @override
  Future<Directory> cacheDir() async => dir;

  @override
  Future<String> install(File apk) async {
    installed.add(apk.uri.pathSegments.last);
    return 'started';
  }
}

Future<void> _seed(MemorySchool s) async {
  await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
}

void main() {
  testWidgets(
    'H165-01 home (row 172): a phone gets the web panel itself — the dashboard page, the web '
    '`.bottomnav`, no tile grid, no native header and no debug footer',
    (tester) async {
      tester.view.physicalSize = const Size(412, 1800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await bootSchool(tester, role: 'manager', seed: _seed);
      expect(find.byKey(const Key('pulse-shell')), findsOneWidget);
      expect(find.byKey(const Key('pulse-bottomnav')), findsOneWidget);
      expect(find.byKey(const Key('session-header')), findsNothing);
      expect(find.byKey(const Key('home-grid')), findsNothing);
      expect(find.text('کار روزانه'), findsNothing);
      expect(find.byKey(const Key('pulse-page-home')), findsOneWidget);
      expect(find.byKey(const Key('dash-topbar')), findsOneWidget);
      // row 180 design 2: four pages and «بیشتر» on a phone
      for (final k in ['home', 'users', 'followup', 'classes', 'more']) {
        expect(navOf(k), findsOneWidget, reason: k);
      }
      expect(find.text('sync-v1'), findsNothing);
      expect(find.text('نسخهٔ بومی پایش'), findsNothing);
      expect(find.byKey(const Key('home-footer')), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'H165-02 the version strip is reserved: the pill never covers the AppBar title',
    (tester) async {
      await tester.pumpWidget(
        PayeshMaterialApp(
          overlay: const Text('0.2.999', key: Key('pill')),
          home: Scaffold(
            appBar: AppBar(title: const Text('حافظهٔ ابری', key: Key('t'))),
            body: const SizedBox(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final pill = tester.getRect(find.byKey(const Key('pill')));
      final title = tester.getRect(find.byKey(const Key('t')));
      expect(pill.overlaps(title), isFalse);
      expect(pill.bottom, lessThanOrEqualTo(title.top));
      // the AppBar paints its colour behind the strip (no gap), its toolbar starts below it
      expect(
        tester.getSize(find.byType(AppBar)).height,
        greaterThanOrEqualTo(kToolbarHeight + 32),
      );
    },
  );

  testWidgets(
    'H165-03 new version ⇒ the web version bar (row 172) says so with «دانلود و نصب»; tap ⇒ APK downloaded, hash-checked and handed to the system installer (no browser)',
    (tester) async {
      tester.view.physicalSize = const Size(412, 1800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final http = _Http();
      final dir = Directory.systemTemp.createTempSync('upd-165-');
      addTearDown(() => dir.deleteSync(recursive: true));
      final inst = _Installer(dir);
      final opened = <Uri>[];
      final u = AppUpdater(
        channel: appChannel,
        http: () => http,
        windows: false,
        currentBuild: 5,
        retry: UpdateRetry.none,
        apkInstaller: inst,
        stagingRoot: dir,
      );
      final src = MemorySchool();
      await tester.runAsync(() => _seed(src));
      final c = SessionController(
        api: FakeAccess([FakeAccess.session('manager')]),
        accounts: SchoolAccountStore(await savedSchool(role: 'manager')),
        flags: ClientFlags.parse(school: 'users,server'),
        now: () => today,
      );
      addTearDown(c.dispose);
      await tester.pumpWidget(
        PayeshApp(
          session: c,
          school: src,
          today: () => today,
          updater: u,
          openUrl: (url) async => opened.add(url),
        ),
      );
      await c.start();
      for (var i = 0; i < 6; i++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 20)),
        );
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(find.byKey(const Key('update-bar-install')), findsNothing);
      // Row 177: no bar at all until a new version is found
      expect(find.byKey(const Key('update-bar')), findsNothing);
      expect(
        find.byKey(const Key('update-bar-none'), skipOffstage: false),
        findsOneWidget,
      );
      await tester.runAsync(u.check);
      await tester.pump();
      expect(u.phase, UpdatePhase.ready);
      expect(
        barText(tester),
        'نسخهٔ ${appChannel.versionOf(5)} — نسخهٔ تازهٔ ${appChannel.versionOf(9)} موجود است',
      );
      await tester.runAsync(() async {
        await tester.tap(find.byKey(const Key('update-bar-install')));
        for (var i = 0; i < 50 && inst.installed.isEmpty; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 20));
        }
      });
      await tester.pump();
      expect(inst.installed, ['payesh-update-9.apk']);
      expect(opened, isEmpty, reason: 'never the browser');
      expect(http.hits, ['app-update.json', 'payesh-native.apk']);
      expect(u.phase, UpdatePhase.applying);
      expect(barText(tester), contains('در حال دانلود'));
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'H177-01 after the update (the app runs the published build) the bar is gone — no '
    '«برنامه به‌روز است»; the version pill sits in the top-left corner of the window',
    (tester) async {
      tester.view.physicalSize = const Size(1568, 880);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final dir = Directory.systemTemp.createTempSync('h177');
      addTearDown(() => dir.deleteSync(recursive: true));
      final http = _Http(build: 9);
      final u = AppUpdater(
        channel: appChannel,
        http: () => http,
        windows: false,
        currentBuild: 9,
        retry: UpdateRetry.none,
        stagingRoot: dir,
      );
      final src = MemorySchool();
      await tester.runAsync(() => _seed(src));
      final c = SessionController(
        api: FakeAccess([FakeAccess.session('manager')]),
        accounts: SchoolAccountStore(await savedSchool(role: 'manager')),
        flags: ClientFlags.parse(school: 'users,server'),
        now: () => today,
      );
      addTearDown(c.dispose);
      await tester.pumpWidget(
        PayeshApp(session: c, school: src, today: () => today, updater: u),
      );
      await c.start();
      for (var i = 0; i < 6; i++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 20)),
        );
        await tester.pump(const Duration(milliseconds: 100));
      }
      await tester.runAsync(u.check);
      await tester.pump();
      expect(u.phase, UpdatePhase.upToDate);
      expect(find.byKey(const Key('update-bar')), findsNothing);
      expect(find.textContaining('برنامه به‌روز است'), findsNothing);
      expect(find.text('بررسی آپدیت'), findsNothing);
      // the pill: top-left corner, inside the reserved strip
      final pill = tester.getRect(find.byKey(const Key('app-version')));
      expect(pill.left, lessThan(80));
      expect(pill.bottom, lessThanOrEqualTo(44));
      expect(
        tester.widget<Text>(find.byKey(const Key('app-version'))).data,
        u.channel.version,
      );
      // a tap on the pill still checks by hand
      await tester.runAsync(() async {
        await tester.tap(find.byKey(const Key('update-light')));
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pump();
      expect(http.hits.where((h) => h == 'app-update.json'), hasLength(2));
      expect(find.byKey(const Key('update-bar')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'H165-04 NEG «حافظهٔ ابری» with the school server out of reach: calm sentence + «دوباره», no red bar, not stuck on «در حال خواندن…»; back online ⇒ the card',
    (tester) async {
      final admin = FakeAdmin()..online = false;
      await open(tester, 'cloud', admin: admin);
      await tester.pumpAndSettle();
      expect(textOf(tester, 'cld-none'), startsWith('سرور مدرسه جواب نداد'));
      expect(find.text('در حال خواندن تنظیمات…'), findsNothing);
      expect(find.byKey(const Key('cld-error')), findsNothing);
      // Row 172: like the web page, the phone and CORS cards always show.
      expect(find.byKey(const Key('cld-phone-card')), findsOneWidget);
      admin.online = true;
      await tapKey(tester, 'cld-retry');
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('cld-card')), findsOneWidget);
      expect(find.byKey(const Key('cld-none')), findsNothing);
      expect(find.byKey(const Key('cld-phone-card')), findsOneWidget);
    },
  );
}

/// Row 172: the plain text of the web `.updbar` («vX — …»).
String barText(WidgetTester tester) => tester
    .widget<Text>(find.byKey(const Key('update-bar-text')))
    .textSpan!
    .toPlainText();
