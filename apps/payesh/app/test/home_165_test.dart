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

import 'school_support.dart';
import 'system_wave12_test.dart' show FakeAdmin, open;

final _apk = List<int>.filled(64, 7);

/// Manifest (build 9) + the APK itself.
final class _Http implements UpdateHttp {
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
          'build': 9,
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
    'H165-01 home: equal tiles in sections, clean header, no debug footer',
    (tester) async {
      tester.view.physicalSize = const Size(412, 1800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await bootSchool(tester, role: 'manager', seed: _seed);
      expect(find.byKey(const Key('session-header')), findsOneWidget);
      expect(find.byKey(const Key('session-school')), findsOneWidget);
      expect(find.byKey(const Key('home-grid')), findsOneWidget);
      expect(find.text('کار روزانه'), findsOneWidget);
      expect(find.text('مدیریت مدرسه'), findsOneWidget);
      expect(find.text('سیستم و حساب'), findsOneWidget);
      final keys = [
        'adm-home',
        'adm-followup',
        'adm-users',
        'adm-students',
        'adm-classes',
        'adm-schedule',
      ];
      final sizes = {for (final k in keys) tester.getSize(find.byKey(Key(k)))};
      expect(sizes, hasLength(1), reason: 'every tile has the same size');
      // 3 per row on a phone
      final w = sizes.single.width;
      expect(w, greaterThan(100));
      expect(w, lessThan(412 / 3));
      // the old debug block is gone; today stays as a quiet footer
      expect(find.text('sync-v1'), findsNothing);
      expect(find.text('نسخهٔ بومی پایش'), findsNothing);
      expect(find.byKey(const Key('home-footer')), findsOneWidget);
      expect(find.byKey(const Key('home-today')), findsOneWidget);
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
    'H165-03 new version ⇒ a card with «نصب» on the home; tap ⇒ APK downloaded, hash-checked and handed to the system installer (no browser)',
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
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byKey(const Key('update-banner')), findsNothing);
      await tester.runAsync(u.check);
      await tester.pump();
      expect(u.phase, UpdatePhase.ready);
      expect(find.byKey(const Key('update-banner')), findsOneWidget);
      expect(
        find.text('نسخهٔ ${appChannel.versionOf(9)} آماده است'),
        findsOneWidget,
      );
      await tester.runAsync(() async {
        await tester.tap(find.byKey(const Key('update-banner-install')));
        for (var i = 0; i < 50 && inst.installed.isEmpty; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 20));
        }
      });
      await tester.pump();
      expect(inst.installed, ['payesh-update-9.apk']);
      expect(opened, isEmpty, reason: 'never the browser');
      expect(http.hits, ['app-update.json', 'payesh-native.apk']);
      expect(u.phase, UpdatePhase.applying);
      expect(
        textOf(tester, 'update-banner-text'),
        contains('نصب‌کنندهٔ اندروید باز شد'),
      );
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
      expect(find.byKey(const Key('cld-phone-card')), findsNothing);
      admin.online = true;
      await tapKey(tester, 'cld-retry');
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('cld-card')), findsOneWidget);
      expect(find.byKey(const Key('cld-none')), findsNothing);
      expect(find.byKey(const Key('cld-phone-card')), findsOneWidget);
    },
  );
}
