// ردیف ۱۹۷-Q05 (F26): GitHub از شبکهٔ گوشی (همراه اول، با یا بی VPN) نمی‌رسد ⇒ مانیفست، فایل‌ها و
// APK از راه سرور مدرسه (`/api/update-relay/`)؛ همان هش‌ها بررسی می‌شوند؛ سرور مدرسهٔ قدیمی
// (بی‌رله) ⇒ GitHub مثل قبل.
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_update/payesh_update.dart';

const schema = 'payesh-app-update/1';
const channel = UpdateChannel(
  id: 'app',
  schema: schema,
  manifest: 'https://github.com/rezaa2544/payesh.local/releases/download/native-continuous/app-update.json',
  blobs:
      'https://github.com/rezaa2544/payesh.local/releases/download/app-files/',
  apk: 'https://github.com/rezaa2544/payesh.local/releases/download/native-continuous/payesh-native.apk',
  exeName: 'payesh_app.exe',
  stagingFolder: 'PayeshRelayTest',
  versionBase: '0.2',
  build: 235,
);

String sha(List<int> b) => sha256.convert(b).toString();

/// شبکه: GitHub فیلتر (هر درخواست به github.com ⇒ خطای شبکه)، سرور مدرسه در دسترس.
final class Net implements UpdateHttp {
  final files = <String, List<int>>{};
  final hits = <String>[];
  bool githubBlocked = true;

  @override
  Future<List<int>?> get(
    Uri url, {
    int maxBytes = 1 << 30,
    void Function(int received)? onBytes,
  }) async {
    final k = url.replace(query: '').toString().replaceAll('?', '');
    hits.add(k);
    if (githubBlocked && url.host == 'github.com') {
      throw const UpdateException('network', 'Connection reset by peer');
    }
    final b = files[k];
    if (b == null) return null;
    onBytes?.call(b.length);
    return b;
  }

  @override
  void close() {}
}

final class FakeInstaller implements ApkInstaller {
  FakeInstaller(this.dir);
  final Directory dir;
  File? installed;

  @override
  Future<Directory> cacheDir() async => dir;

  @override
  Future<String> install(File apk) async {
    installed = apk;
    return 'started';
  }
}

void main() {
  final school = Uri.parse('https://abc-def.trycloudflare.com');
  final lan = Uri.parse('http://192.168.1.10:8080');
  final exe = utf8.encode('EXE-236' * 900);
  final so = utf8.encode('SO-236' * 4000);
  final apk = utf8.encode('APK-236' * 3000);
  late Directory tmp;
  late Directory install;

  Map<String, Object?> manifest() => {
    'schema': schema,
    'build': 236,
    'commit': 'c' * 40,
    'files': [
      for (final (p, raw) in [('payesh_app.exe', exe), ('data/app.so', so)])
        {
          'path': p,
          'sha256': sha(raw),
          'size': raw.length,
          'gz_size': gzip.encode(raw).length,
        },
    ],
    'android': {'sha256': sha(apk), 'size': apk.length},
  };

  /// همان فایل‌ها هم روی GitHub و هم (بایت‌به‌بایت) روی رلهٔ [server].
  Net net({Uri? server}) {
    final n = Net();
    void put(Uri gh, List<int> b) {
      n.files[gh.toString()] = b;
      if (server != null) n.files[relayUri(server, gh).toString()] = b;
    }

    put(channel.manifestUrl, utf8.encode(jsonEncode(manifest())));
    for (final raw in [exe, so]) {
      put(channel.blobBase.resolve('${sha(raw)}.gz'), gzip.encode(raw));
    }
    put(channel.apkUrl, apk);
    return n;
  }

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('payesh-relay-');
    install = Directory('${tmp.path}/install')..createSync();
    File('${install.path}/payesh_app.exe').writeAsBytesSync(utf8.encode('old'));
  });
  tearDown(() => tmp.deleteSync(recursive: true));

  test('relayUri: نشانی GitHub ⇒ همان نام روی سرور مدرسه', () {
    expect(
      relayUri(school, channel.manifestUrl).toString(),
      'https://abc-def.trycloudflare.com/api/update-relay/native-continuous/app-update.json',
    );
    expect(
      relayUri(lan, channel.blobBase).toString(),
      'http://192.168.1.10:8080/api/update-relay/app-files/',
    );
    expect(
      relayUri(school, channel.apkUrl).toString(),
      endsWith('/api/update-relay/native-continuous/payesh-native.apk'),
    );
    expect(relayUri(school, Uri.parse('file:///c:/u/app-update.json')), isNull);
    expect(relayUri(school, Uri.parse('https://updates.test/x.json')), isNull);
  });

  test('کنترل منفی: GitHub فیلتر و بی‌رله ⇒ «به سرور به‌روزرسانی نرسیدیم» (رفتار پیش از Q05)', () async {
    final n = net();
    final u = AppUpdater(
      channel: channel,
      http: () => n,
      windows: false,
      currentBuild: 235,
      retry: UpdateRetry.none,
      installDir: install,
      stagingRoot: Directory('${tmp.path}/st0'),
    );
    await u.check();
    expect(u.phase, UpdatePhase.failed);
    expect(u.error, contains('نرسیدیم'));
    await u.dispose();
  });

  test(
    'اندروید، GitHub فیلتر: مانیفست و APK از راه سرور مدرسه؛ هش بررسی و نصب',
    () async {
      final n = net(server: school);
      final inst = FakeInstaller(Directory('${tmp.path}/cache')..createSync());
      final u = AppUpdater(
        channel: channel,
        http: () => n,
        windows: false,
        currentBuild: 235,
        retry: UpdateRetry.none,
        apkInstaller: inst,
        installDir: install,
        stagingRoot: Directory('${tmp.path}/st1'),
        relays: () async => [school],
      );
      await u.check();
      expect(u.phase, UpdatePhase.ready);
      expect(u.relaySource, school);
      expect(u.apkUrl.toString(), relayUri(school, channel.apkUrl).toString());
      await u.tap();
      expect(inst.installed, isNotNull);
      expect(sha(inst.installed!.readAsBytesSync()), sha(apk));
      // هیچ‌چیز از GitHub خواسته نشد
      expect(n.hits.where((h) => h.contains('github.com')), isEmpty);
      await u.dispose();
    },
  );

  test('ویندوز، GitHub فیلتر: فایل‌های تغییرکرده از راه سرور مدرسه و آماده برای اعمال', () async {
    final n = net(server: lan);
    final u = AppUpdater(
      channel: channel,
      http: () => n,
      windows: true,
      currentBuild: 235,
      retry: UpdateRetry.none,
      installDir: install,
      stagingRoot: Directory('${tmp.path}/st2'),
      launcher: (s) async {},
      relays: () async => [lan],
    );
    await u.check();
    expect(u.phase, UpdatePhase.ready);
    await u.download();
    expect(u.phase, UpdatePhase.staged);
    expect(u.staged!.plan.changed.length, 2);
    expect(n.hits.where((h) => h.contains('github.com')), isEmpty);
    expect(
      n.hits
          .where(
            (h) => h.startsWith(
              'http://192.168.1.10:8080/api/update-relay/app-files/',
            ),
          )
          .length,
      2,
    );
    await u.dispose();
  });

  test('رلهٔ دست‌کاری‌شده (APK با هش دیگر) ⇒ نصب نمی‌شود', () async {
    final n = net(server: school);
    n.files[relayUri(school, channel.apkUrl).toString()] = utf8.encode('evil');
    final inst = FakeInstaller(Directory('${tmp.path}/cache4')..createSync());
    final u = AppUpdater(
      channel: channel,
      http: () => n,
      windows: false,
      currentBuild: 235,
      retry: UpdateRetry.none,
      apkInstaller: inst,
      installDir: install,
      stagingRoot: Directory('${tmp.path}/st4'),
      relays: () async => [school],
    );
    await u.check();
    await u.tap();
    expect(inst.installed, isNull);
    expect(u.phase, UpdatePhase.failed);
    await u.dispose();
  });

  test(
    'سرور مدرسهٔ قدیمی (بی‌رله ⇒ 404) و GitHub باز ⇒ همان GitHub مثل قبل',
    () async {
      final n = net()..githubBlocked = false;
      final u = AppUpdater(
        channel: channel,
        http: () => n,
        windows: false,
        currentBuild: 235,
        retry: UpdateRetry.none,
        installDir: install,
        stagingRoot: Directory('${tmp.path}/st3'),
        relays: () async => [school, school, Uri.parse('ftp://x')],
      );
      await u.check();
      expect(u.phase, UpdatePhase.ready);
      expect(u.relaySource, isNull);
      expect(u.apkUrl, channel.apkUrl);
      // هر سرور فقط یک بار (تکراری حذف؛ ftp نادیده)
      expect(n.hits.where((h) => h.contains('trycloudflare')).length, 1);
      await u.dispose();
    },
  );

  test('رله هنگام دریافت فایل‌ها قطع شد ⇒ ادامه از GitHub', () async {
    final n = net(server: lan)..githubBlocked = false;
    final u = AppUpdater(
      channel: channel,
      http: () => n,
      windows: true,
      currentBuild: 235,
      retry: UpdateRetry.none,
      installDir: install,
      stagingRoot: Directory('${tmp.path}/st5'),
      launcher: (s) async {},
      relays: () async => [lan],
    );
    await u.check();
    expect(u.relaySource, lan);
    n.files.removeWhere((k, _) => k.contains('/api/update-relay/app-files/'));
    await u.download();
    expect(u.phase, UpdatePhase.staged);
    expect(u.relaySource, isNull);
    await u.dispose();
  });
}
