// ردیف ۱۴۸: اپ مدرسه هم به‌روزرسانی درون برنامه دارد — همان هستهٔ پنل مالک (payesh_update):
// نسخه + چراغ بالای همهٔ صفحه‌ها (حتی پیش از ورود)، چراغ زنده هنگام کار، و در اندروید بستهٔ
// کامل با مرورگر سیستم (برنامهٔ مدرسه مجوز نصب بسته ندارد).
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_app/src/update/app_update.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_update/payesh_update.dart';

import 'login_wave1_test.dart' show FakeAccess;

/// HTTP جعلی: فقط مانیفست (build ۶)؛ هر درخواست ثبت می‌شود.
final class ManifestHttp implements UpdateHttp {
  ManifestHttp(this.build);
  final int build;
  final hits = <Uri>[];

  @override
  Future<List<int>?> get(
    Uri url, {
    int maxBytes = 1 << 30,
    void Function(int received)? onBytes,
  }) async {
    hits.add(url);
    if (!url.path.endsWith('/app-update.json')) return null;
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
        'android': {'sha256': 'a' * 64, 'size': 10},
      }),
    );
  }

  @override
  void close() {}
}

void main() {
  test('کانال اپ مدرسه: native-continuous/app-update.json + app-files، exe و نسخهٔ pubspec', () {
    expect(appChannel.schema, 'payesh-app-update/1');
    expect(
      appChannel.manifestUrl.toString(),
      'https://github.com/rezaa2544/payesh.local/releases/download/native-continuous/app-update.json',
    );
    expect(
      appChannel.blobBase.toString(),
      'https://github.com/rezaa2544/payesh.local/releases/download/app-files/',
    );
    expect(
      appChannel.apkUrl.path,
      endsWith('/native-continuous/payesh-native.apk'),
    );
    expect(appChannel.exeName, 'payesh_app.exe');
    expect(appChannel.stagingFolder, 'PayeshNative');
    // دو بخش اول نسخه = pubspec و همان «--build-name=0.2.<run>» در CI
    final pub = File('pubspec.yaml').readAsStringSync();
    final m = RegExp(
      r'^version:\s*(\d+\.\d+)\.',
      multiLine: true,
    ).firstMatch(pub);
    expect(m?.group(1), appVersionBase);
    final ci = File('../../../.github/workflows/native-client.yml')
        .readAsStringSync();
    for (final kind in ['apk', 'appbundle', 'windows']) {
      expect(
        ci,
        contains(
          'flutter build $kind --release ${kind == 'windows' ? '' : r'--build-number=${{ github.run_number }} '}'
          '--build-name=$appVersionBase.\${{ github.run_number }} --dart-define=PAYESH_APP_BUILD=\${{ github.run_number }}',
        ),
      );
    }
    // اپ مدرسه هرگز مجوز نصب بسته نمی‌خواهد (سیاست Google Play) — فقط گیرندهٔ «پس از نصب»
    final mf = File('android/app/src/main/AndroidManifest.xml')
        .readAsStringSync();
    expect(mf, isNot(contains('permission.REQUEST_INSTALL_PACKAGES"')));
    expect(mf, contains('android.intent.action.MY_PACKAGE_REPLACED'));
  });

  testWidgets(
    'نسخه + چراغ بالای صفحهٔ ورود؛ اندروید: لمس ⇒ بستهٔ کامل در مرورگر',
    (tester) async {
      tester.view.physicalSize = const Size(900, 1800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final http = ManifestHttp(6);
      final opened = <Uri>[];
      final u = AppUpdater(
        channel: appChannel,
        http: () => http,
        windows: false,
        currentBuild: 5,
        retry: UpdateRetry.none,
        stagingRoot: Directory.systemTemp.createTempSync('app-upd-'),
      );
      final c = SessionController(
        api: FakeAccess(),
        accounts: SchoolAccountStore(FakeSecureStore()),
        flags: ClientFlags.parse(),
      );
      addTearDown(c.dispose);
      await tester.pumpWidget(
        PayeshApp(
          session: c,
          updater: u,
          openUrl: (url) async => opened.add(url),
        ),
      );
      await c.start();
      await tester.pump(const Duration(milliseconds: 200));
      // روی صفحهٔ ورود، پیش از هر کاری: فقط نسخه و چراغ
      expect(find.byKey(const Key('update-light')), findsOneWidget);
      expect(find.byKey(const Key('app-version')), findsOneWidget);
      expect(find.text(appChannel.version), findsOneWidget);
      expect(find.byKey(const Key('update-light-idle')), findsOneWidget);

      // لمس اول ⇒ بررسی ⇒ نسخهٔ تازه آماده (رنگ چراغ عوض می‌شود)
      await tester.tap(find.byKey(const Key('update-light')));
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 50));
      expect(u.phase, UpdatePhase.ready);
      expect(find.byKey(const Key('update-light-ready')), findsOneWidget);
      expect(http.hits.single.path, appChannel.manifestUrl.path);

      // لمس دوم ⇒ بستهٔ کامل اپ مدرسه در مرورگر سیستم
      await tester.tap(find.byKey(const Key('update-light')));
      await tester.pump(const Duration(milliseconds: 50));
      expect(opened, [appChannel.apkUrl]);

      // بررسی خودکار (۳۰ ثانیه پس از باز شدن) هم اجرا می‌شود و چیزی نصب نمی‌کند
      await tester.pump(const Duration(seconds: 31));
      await tester.pump(const Duration(milliseconds: 50));
      expect(http.hits.length, 2);
      expect(opened.length, 1);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('بدون updater (ساخت محلی/آزمون‌ها): چراغی نیست', (tester) async {
    final c = SessionController(
      api: FakeAccess(),
      accounts: SchoolAccountStore(FakeSecureStore()),
      flags: ClientFlags.parse(),
    );
    addTearDown(c.dispose);
    await tester.pumpWidget(PayeshApp(session: c));
    await c.start();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.byKey(const Key('update-light')), findsNothing);
  });
}
