import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';
import 'package:payesh_update/payesh_update.dart';

/// ردیف ۱۴۸: به‌روزرسانی پایدار برای همهٔ برنامه‌های نصبی — تلاش دوباره، ادامه، پیشرفت
/// بایتی، باز شدن دوباره پس از نصب، و چراغ زنده.

const schema = 'payesh-test-update/1';
const channel = UpdateChannel(
  id: 'test',
  schema: schema,
  manifest: 'https://updates.test/test-update.json',
  blobs: 'https://updates.test/files/',
  apk: 'https://updates.test/payesh-test.apk',
  exeName: 'payesh_test.exe',
  stagingFolder: 'PayeshTest',
  versionBase: '9.9',
  build: 7,
);

String sha(List<int> b) => sha256.convert(b).toString();

/// HTTP جعلی: [fail] بار اول برای هر نشانی خطای شبکه؛ پاسخ‌ها در چند تکه (onBytes).
final class FlakyHttp implements UpdateHttp {
  FlakyHttp({this.fail = 0, this.chunks = 4});
  final files = <String, List<int>>{};
  final hits = <String>[];
  final failures = <String, int>{};
  final int fail;
  final int chunks;
  final progress = <int>[];

  @override
  Future<List<int>?> get(
    Uri url, {
    int maxBytes = 1 << 30,
    void Function(int received)? onBytes,
  }) async {
    final k = url.replace(query: '').toString().replaceAll('?', '');
    hits.add(k);
    final n = failures.update(k, (v) => v + 1, ifAbsent: () => 1);
    if (n <= fail) throw const UpdateException('network', 'reset by peer');
    final b = files[k];
    if (b == null) return null;
    if (b.length > maxBytes) throw const UpdateException('bad_hash', 'big');
    final step = (b.length / chunks).ceil().clamp(1, 1 << 30);
    for (var i = step; i < b.length; i += step) {
      onBytes?.call(i);
      progress.add(i);
    }
    onBytes?.call(b.length);
    return b;
  }

  @override
  void close() {}
}

const fast = UpdateRetry(attempts: 4, base: Duration(milliseconds: 1));

void main() {
  late Directory tmp;
  late Directory install;
  late Directory staging;
  final manifestUrl = channel.manifestUrl;
  final blobBase = channel.blobBase;

  final exe = utf8.encode('EXE-v1' * 1000);
  final soOld = utf8.encode('SO-v1' * 5000);
  final soNew = utf8.encode('SO-v2' * 5000);
  final asset = utf8.encode('{"new":true}');
  final apk = utf8.encode('APK-v8' * 4000);

  Map<String, Object?> entry(String path, List<int> raw) => {
    'path': path,
    'sha256': sha(raw),
    'size': raw.length,
    'gz_size': gzip.encode(raw).length,
  };

  Map<String, Object?> manifest() => {
    'schema': schema,
    'build': 8,
    'commit': 'b' * 40,
    'files': [
      entry('payesh_test.exe', exe),
      entry('data/app.so', soNew),
      entry('data/flutter_assets/new.json', asset),
    ],
    'android': {'sha256': sha(apk), 'size': apk.length},
  };

  FlakyHttp http({int fail = 0}) {
    final h = FlakyHttp(fail: fail);
    h.files[manifestUrl.toString()] = utf8.encode(jsonEncode(manifest()));
    for (final raw in [exe, soNew, asset]) {
      h.files[blobBase.resolve('${sha(raw)}.gz').toString()] = gzip.encode(raw);
    }
    h.files[channel.apkUrl.toString()] = apk;
    return h;
  }

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('payesh-update-');
    install = Directory('${tmp.path}/install')..createSync();
    staging = Directory('${tmp.path}/staging');
    File('${install.path}/payesh_test.exe').writeAsBytesSync(exe);
    File('${install.path}/data/app.so')
      ..parent.createSync(recursive: true)
      ..writeAsBytesSync(soOld);
  });

  tearDown(() => tmp.deleteSync(recursive: true));

  group('پایداری دریافت', () {
    test('قطع شبکه ⇒ تلاش دوباره و موفق (مانیفست و هر فایل)', () async {
      final h = http(fail: 2);
      final retries = <int>[];
      final m = await fetchManifest(
        h,
        url: manifestUrl,
        schema: schema,
        retry: fast,
      );
      final p = await planUpdate(m, install);
      final s = await downloadUpdate(
        p,
        http: h,
        stagingRoot: staging,
        blobBase: blobBase,
        retry: fast,
      );
      expect(s.fromOrigin, 2);
      expect(File('${s.files.path}/data/app.so').readAsBytesSync(), soNew);
      // هر نشانی دو بار شکست، بار سوم موفق
      expect(h.failures.values, everyElement(3));
      await fast.run((i) async {
        retries.add(i);
        if (i < 3) throw const UpdateException('network');
        return 0;
      });
      expect(retries, [1, 2, 3]);
    });

    test('تلاش‌ها تمام ⇒ همان خطا؛ خطای غیرگذرا ⇒ بی‌درنگ', () async {
      final h = http(fail: 10);
      await expectLater(
        fetchManifest(h, url: manifestUrl, schema: schema, retry: fast),
        throwsA(
          isA<UpdateException>().having((e) => e.code, 'code', 'network'),
        ),
      );
      expect(h.failures[manifestUrl.toString()], 4);
      var n = 0;
      await expectLater(
        fast.run<int>((_) async {
          n++;
          throw const UpdateException('bad_manifest');
        }),
        throwsA(isA<UpdateException>()),
      );
      expect(n, 1);
      expect(const UpdateRetry().delay(1), const Duration(seconds: 2));
      expect(const UpdateRetry().delay(3), const Duration(seconds: 8));
      expect(const UpdateRetry().delay(9), const Duration(seconds: 20));
    });

    test('۴۰۴ لحظهٔ انتشار مانیفست ⇒ دوباره و موفق', () async {
      final h = http();
      final body = h.files.remove(manifestUrl.toString())!;
      var calls = 0;
      final m = await fast.run((_) async {
        calls++;
        if (calls == 2) h.files[manifestUrl.toString()] = body;
        return fetchManifest(
          h,
          url: manifestUrl,
          schema: schema,
          retry: UpdateRetry.none,
        );
      });
      expect(m.build, 8);
      expect(calls, 2);
    });

    test('ادامه: فایل‌های سالم دریافت قبلی دوباره دانلود نمی‌شوند', () async {
      final h = http();
      final p = await planUpdate(
        await fetchManifest(h, url: manifestUrl, schema: schema),
        install,
      );
      // دریافت اول وسط کار قطع شد: app.so کامل، فایل دوم نه (فقط .part)
      final files = Directory('${staging.path}/8/files');
      File('${files.path}/data/app.so')
        ..parent.createSync(recursive: true)
        ..writeAsBytesSync(soNew);
      File('${files.path}/data/flutter_assets/new.json.part')
          .createSync(recursive: true);
      // باقی‌ماندهٔ اعمال قبلی پاک می‌شود
      File('${staging.path}/8/result.json').writeAsStringSync('{}');
      h.hits.clear();
      final s = await downloadUpdate(
        p,
        http: h,
        stagingRoot: staging,
        blobBase: blobBase,
      );
      expect(s.resumed, 1);
      expect(s.fromOrigin, 1);
      expect(h.hits, [blobBase.resolve('${sha(asset)}.gz').toString()]);
      expect(File('${staging.path}/8/result.json').existsSync(), isFalse);
      expect(
        File('${files.path}/data/flutter_assets/new.json').readAsBytesSync(),
        asset,
      );

      // فایل ماندهٔ خراب (هم‌اندازه، هش دیگر) ⇒ دوباره دانلود
      File('${files.path}/data/app.so')
          .writeAsBytesSync(utf8.encode('SO-v3' * 5000));
      h.hits.clear();
      final s2 = await downloadUpdate(
        p,
        http: h,
        stagingRoot: staging,
        blobBase: blobBase,
      );
      expect(s2.resumed, 1);
      expect(h.hits, [blobBase.resolve('${sha(soNew)}.gz').toString()]);
      expect(File('${files.path}/data/app.so').readAsBytesSync(), soNew);
    });

    test('پیشرفت بایت‌به‌بایت، صعودی و تا انتها', () async {
      final h = http();
      final p = await planUpdate(
        await fetchManifest(h, url: manifestUrl, schema: schema),
        install,
      );
      final seen = <int>[];
      await downloadUpdate(
        p,
        http: h,
        stagingRoot: staging,
        blobBase: blobBase,
        onProgress: (d, t) {
          expect(t, p.downloadBytes);
          seen.add(d);
        },
      );
      expect(seen.first, 0);
      expect(seen.last, p.downloadBytes);
      // میان‌راهی‌ها پیش از پایان هر فایل (نه فقط ۰ و ۱۰۰٪)
      final firstGz = p.changed.first.gzSize;
      expect(seen.where((d) => d > 0 && d < firstGz), isNotEmpty);
      for (var i = 1; i < seen.length; i++) {
        expect(seen[i], greaterThanOrEqualTo(seen[i - 1]));
      }
    });

    test(
      'IoUpdateHttp: پاسخ بریده ⇒ network (گذرا)؛ file:// برای آزمون محلی',
      () async {
        // TestWidgetsFlutterBinding همهٔ HttpClientها را جعلی (۴۰۰) می‌کند؛ اینجا شبکهٔ واقعی محلی
        final saved = HttpOverrides.current;
        HttpOverrides.global = null;
        addTearDown(() => HttpOverrides.global = saved);
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        var n = 0;
        server.listen((r) async {
          n++;
          r.response.contentLength = 1000;
          if (n == 1) {
            final sock = await r.response.detachSocket();
            sock.add(List.filled(400, 1));
            await sock.flush();
            sock.destroy();
            return;
          }
          r.response.add(List.filled(1000, 2));
          await r.response.close();
        });
        final io = IoUpdateHttp(timeout: const Duration(seconds: 5));
        final url = Uri.parse('http://127.0.0.1:${server.port}/x');
        final got = <int>[];
        final b = await fast.run((_) => io.get(url, onBytes: got.add));
        expect(b, hasLength(1000));
        expect(n, 2);
        expect(got.last, 1000);
        io.close();
        await server.close(force: true);

        final f = File('${tmp.path}/m.json')..writeAsStringSync('{"a":1}');
        final io2 = IoUpdateHttp();
        expect(
          utf8.decode((await io2.get(f.uri.replace(query: 't=1')))!),
          '{"a":1}',
        );
        expect(await io2.get(File('${tmp.path}/none').uri), isNull);
        io2.close();
      },
    );
  });

  group('اعمال و باز شدن دوباره (ویندوز)', () {
    test(
      'اسکریپت: همهٔ نمونه‌ها بسته، فایل قفل کنار، باز شدن دوباره در هر حالت',
      () async {
        final h = http();
        final p = await planUpdate(
          await fetchManifest(h, url: manifestUrl, schema: schema),
          install,
        );
        final s = await downloadUpdate(
          p,
          http: h,
          stagingRoot: staging,
          blobBase: blobBase,
        );
        final ps = applyScript(
          staged: s,
          installDir: r'C:\Users\رضا\AppData\Local\Programs\PayeshNative',
          exeName: 'payesh_test.exe',
        );
        expect(ps, contains(r"$exeBase = 'payesh_test'"));
        expect(ps, contains('function Get-AppProcs'));
        expect(
          ps,
          contains(
            "Rename-Item -LiteralPath \$dst -NewName ((Split-Path -Leaf \$dst) + '.old-'",
          ),
        );
        expect(ps, contains('-WindowStyle Normal -PassThru'));
        expect(ps, contains('explorer.exe'));
        expect(ps, contains('relaunched_pid'));
        expect(ps, contains('MainWindowHandle'));
        expect(ps, contains('staged file corrupted'));
        // پس از خطای کپی، بازگشت و پس از سلامت ناموفق: هر بار برنامه دوباره باز می‌شود
        final starts = RegExp(r'Start-App').allMatches(ps).length;
        expect(starts, greaterThanOrEqualTo(4));
        final copyFail = ps.substring(ps.indexOf('Write-Log "copy failed'));
        expect(
          copyFail.indexOf('Start-App'),
          lessThan(copyFail.indexOf('Write-Result')),
        );
        expect(ps, contains('-lt 40'));
      },
    );

    test('نتیجه: last-apply.json ماندگار + پاک کردن فایل‌های کنارگذاشته', () {
      final d = Directory('${staging.path}/8')..createSync(recursive: true);
      File('${d.path}/result.json').writeAsStringSync(
        jsonEncode({
          'ok': true,
          'build': 8,
          'rolled_back': false,
          'message': 'ok',
          'relaunched_pid': 4321,
          'window': true,
        }),
      );
      final old = File('${install.path}/data/app.so.old-8-3')
        ..writeAsStringSync('x');
      final keep = File('${install.path}/data/app.so.older')
        ..writeAsStringSync('y');
      final r = takeApplyResult(staging, installDir: install)!;
      expect(r.ok, isTrue);
      expect(r.relaunched, isTrue);
      expect(r.window, isTrue);
      expect(d.existsSync(), isFalse);
      expect(old.existsSync(), isFalse);
      expect(keep.existsSync(), isTrue);
      final last = jsonDecode(
        File('${staging.path}/last-apply.json').readAsStringSync(),
      );
      expect((last as Map)['relaunched_pid'], 4321);
    });

    test(
      'یک لمس: بررسی؛ لمس بعد: دریافت ⇒ نصب ⇒ بسته شدن (اسکریپت باز می‌کند)',
      () async {
        final h = http(fail: 1);
        StagedUpdate? launched;
        final u = AppUpdater(
          channel: channel,
          http: () => h,
          installDir: install,
          stagingRoot: staging,
          windows: true,
          retry: fast,
          launcher: (s) async => launched = s,
        );
        await u.tap();
        expect(u.phase, UpdatePhase.ready);
        await u.tap();
        expect(launched!.plan.manifest.build, 8);
        expect(u.phase, UpdatePhase.applying);
        expect(u.busy, isTrue);
        await u.dispose();
      },
    );

    test('خطای دریافت ⇒ لمس دوباره همان‌جا ادامه می‌دهد (نه بررسی از نو)', () async {
      final h = http();
      final u = AppUpdater(
        channel: channel,
        http: () => h,
        installDir: install,
        stagingRoot: staging,
        windows: true,
        retry: UpdateRetry.none,
        launcher: (s) async {},
      );
      await u.check();
      final blob = blobBase.resolve('${sha(asset)}.gz').toString();
      final saved = h.files.remove(blob)!;
      await u.tap();
      expect(u.phase, UpdatePhase.failed);
      expect(u.available, isTrue);
      h.files[blob] = saved;
      h.hits.clear();
      await u.tap();
      expect(u.phase, UpdatePhase.applying);
      // مانیفست دوباره خوانده نشد و app.so (سالم از بار اول) دوباره دانلود نشد
      expect(h.hits, [blob]);
      expect(u.staged!.resumed, 1);
      await u.dispose();
    });

    test('اسکریپت شروع نشد ⇒ برنامه باز می‌ماند، پیام فارسی', () async {
      final h = http();
      var exited = false;
      final u = AppUpdater(
        channel: channel,
        http: () => h,
        installDir: install,
        stagingRoot: staging,
        windows: true,
        retry: UpdateRetry.none,
        exitApp: () => exited = true,
      );
      await u.check();
      await u.download();
      expect(u.phase, UpdatePhase.staged);
      // بدون PowerShell (لینوکس) ⇒ هیچ روشی نشانهٔ شروع نمی‌نویسد
      await expectLater(
        launchApply(
          staged: u.staged!,
          installDir: install.path,
          appPid: 1,
          exeName: channel.exeName,
          startTimeout: const Duration(milliseconds: 50),
          starter: (e, a, {mode = ProcessStartMode.normal}) async => null,
        ),
        throwsA(isA<UpdateException>().having((e) => e.code, 'code', 'launch')),
      );
      expect(exited, isFalse);
      await u.dispose();
    });
  });

  group('اندروید: APK درون برنامه', () {
    test('دریافت با پیشرفت و بررسی هش ⇒ نصب‌کنندهٔ سیستم', () async {
      final h = http(fail: 1);
      final inst = FakeInstaller(Directory('${tmp.path}/cache'));
      final ticks = <int>[];
      final u = AppUpdater(
        channel: channel,
        http: () => h,
        windows: false,
        currentBuild: 7,
        retry: fast,
        apkInstaller: inst,
        stagingRoot: staging,
        installDir: install,
      );
      final sub = u.changes.listen((_) {
        if (u.phase == UpdatePhase.downloading) ticks.add(u.progressDone);
      });
      await u.tap();
      expect(u.phase, UpdatePhase.ready);
      await u.tap();
      expect(inst.installed!.readAsBytesSync(), apk);
      expect(inst.installed!.path, endsWith('payesh-update-8.apk'));
      expect(u.phase, UpdatePhase.applying);
      expect(ticks.last, apk.length);
      // دوباره (مثلاً نصب لغو شد): همان فایل، بدون دانلود
      h.hits.clear();
      u.phase = UpdatePhase.ready;
      await u.tap();
      expect(h.hits, isEmpty);
      await sub.cancel();
      await u.dispose();
    });

    test(
      'اجازهٔ نصب نیست ⇒ آماده با راهنما؛ هش ناجور ⇒ خطا و نصب نمی‌شود',
      () async {
        final h = http();
        final inst = FakeInstaller(Directory('${tmp.path}/cache'))
          ..answer = 'needs_permission';
        final u = AppUpdater(
          channel: channel,
          http: () => h,
          windows: false,
          currentBuild: 7,
          retry: UpdateRetry.none,
          apkInstaller: inst,
          stagingRoot: staging,
          installDir: install,
        );
        await u.check();
        await u.tap();
        expect(u.phase, UpdatePhase.ready);
        expect(u.error, contains('نصب برنامه‌های ناشناس'));

        inst.installed = null;
        inst.answer = 'started';
        File('${tmp.path}/cache/payesh-update-8.apk').deleteSync();
        h.files[channel.apkUrl.toString()] = utf8.encode('EVIL' * 6000);
        await u.tap();
        expect(u.phase, UpdatePhase.failed);
        expect(inst.installed, isNull);
        await u.dispose();
      },
    );

    test(
      'ساخت تازه‌تر نیست ⇒ به‌روز؛ بدون نصب‌کنندهٔ بومی ⇒ صفحهٔ دانلود',
      () async {
        final h = http();
        final opened = <Uri>[];
        final u = AppUpdater(
          channel: channel,
          http: () => h,
          windows: false,
          currentBuild: 8,
          retry: UpdateRetry.none,
          openUrl: (x) async => opened.add(x),
          stagingRoot: staging,
          installDir: install,
        );
        await u.check();
        expect(u.phase, UpdatePhase.upToDate);
        final v = AppUpdater(
          channel: channel,
          http: () => h,
          windows: false,
          currentBuild: 7,
          retry: UpdateRetry.none,
          openUrl: (x) async => opened.add(x),
          stagingRoot: staging,
          installDir: install,
        );
        await v.check();
        await v.tap();
        expect(opened, [channel.apkUrl]);
        await u.dispose();
        await v.dispose();
      },
    );
  });

  group('چراغ زنده', () {
    Future<void> pump(WidgetTester t, AppUpdater u) => t.pumpWidget(
      MaterialApp(
        theme: PayeshUi.light(),
        home: Directionality(
          textDirection: TextDirection.rtl,
          child: Scaffold(
            body: Center(child: UpdateLight(updater: u)),
          ),
        ),
      ),
    );

    testWidgets(
      'آرام ⇒ بدون پویانمایی؛ دریافت ⇒ هاله می‌تپد و حلقه پر می‌شود',
      (tester) async {
        final u = AppUpdater(
          channel: channel,
          http: http,
          windows: true,
          installDir: install,
          stagingRoot: staging,
        );
        await pump(tester, u);
        await tester.pumpAndSettle(); // بی‌پایان نیست
        expect(find.text('9.9.7'), findsOneWidget);
        expect(find.byKey(const ValueKey('status-dot-pulse')), findsNothing);
        expect(find.byType(CircularProgressIndicator), findsNothing);

        // دریافت با ۰٪ ⇒ حلقهٔ چرخان (نه حلقهٔ صفرِ نامرئی) + تپش
        u
          ..phase = UpdatePhase.downloading
          ..progressDone = 0
          ..progressTotal = 1000;
        // ignore: invalid_use_of_protected_member
        tester.state(find.byType(UpdateLight)).setState(() {});
        await tester.pump(const Duration(milliseconds: 50));
        expect(find.byKey(const ValueKey('status-dot-pulse')), findsOneWidget);
        var ring = tester.widget<CircularProgressIndicator>(
          find.byType(CircularProgressIndicator),
        );
        expect(ring.value, isNull);
        final dot = find.byKey(const ValueKey('status-dot-pulse'));
        final s1 = tester.getSize(
          find.descendant(of: dot, matching: find.byType(Container)),
        );
        await tester.pump(const Duration(milliseconds: 500));
        final s2 = tester.getSize(
          find.descendant(of: dot, matching: find.byType(Container)),
        );
        expect(s2.width, isNot(s1.width)); // واقعاً حرکت می‌کند

        u.progressDone = 420;
        // ignore: invalid_use_of_protected_member
        tester.state(find.byType(UpdateLight)).setState(() {});
        await tester.pump(const Duration(milliseconds: 50));
        ring = tester.widget<CircularProgressIndicator>(
          find.byType(CircularProgressIndicator),
        );
        expect(ring.value, closeTo(0.42, 1e-9));
        final tip = tester.widget<Tooltip>(find.byType(Tooltip));
        expect(tip.message, 'در حال دریافت ۴۲٪');
        // هنوز فقط نسخه؛ بدون نوشتهٔ اضافی
        expect(tester.widgetList<Text>(find.byType(Text)).map((t) => t.data), [
          '9.9.7',
        ]);

        // نصب ⇒ همچنان زنده؛ تمام ⇒ آرام
        u.phase = UpdatePhase.applying;
        // ignore: invalid_use_of_protected_member
        tester.state(find.byType(UpdateLight)).setState(() {});
        await tester.pump(const Duration(milliseconds: 50));
        expect(find.byKey(const ValueKey('status-dot-pulse')), findsOneWidget);
        expect(find.byKey(const Key('update-light-applying')), findsOneWidget);
        u.phase = UpdatePhase.upToDate;
        // ignore: invalid_use_of_protected_member
        tester.state(find.byType(UpdateLight)).setState(() {});
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('status-dot-pulse')), findsNothing);
        await u.dispose();
      },
    );

    testWidgets('«کاهش حرکت» سیستم ⇒ تپش نه، حلقهٔ پیشرفت بله', (tester) async {
      await tester.pumpWidget(
        const MediaQuery(
          data: MediaQueryData(disableAnimations: true),
          child: Directionality(
            textDirection: TextDirection.rtl,
            child: Center(
              child: StatusDot(color: Colors.orange, busy: true, progress: 0.5),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(tester.hasRunningAnimations, isFalse);
    });
  });

  group('بررسی خودکار + برچسب‌ها + کانال بومی', () {
    testWidgets('AutoUpdateCheck: نتیجهٔ قبلی، بررسی پس از first و هر every', (
      tester,
    ) async {
      final h = http();
      final u = AppUpdater(
        channel: channel,
        http: () => h,
        windows: false,
        currentBuild: 8,
        retry: UpdateRetry.none,
        stagingRoot: staging,
        installDir: install,
      );
      // نتیجهٔ اعمال قبلی (پس از باز شدن دوباره) خوانده می‌شود
      File('${staging.path}/8/result.json')
        ..parent.createSync(recursive: true)
        ..writeAsStringSync(
          '{"ok":true,"build":8,"rolled_back":false,"message":"ok","relaunched_pid":42,"window":true}',
        );
      await tester.pumpWidget(
        MaterialApp(
          theme: PayeshUi.light(),
          home: AutoUpdateCheck(
            updater: u,
            first: const Duration(seconds: 2),
            every: const Duration(minutes: 1),
            child: Material(child: UpdateLight(updater: u)),
          ),
        ),
      );
      expect(u.lastApply?.ok, isTrue);
      expect(u.lastApply?.relaunched, isTrue);
      expect(u.lastApply?.window, isTrue);
      expect(File('${staging.path}/last-apply.json').existsSync(), isTrue);
      expect(h.hits, isEmpty);
      await tester.pump(const Duration(seconds: 2));
      await tester.pump(const Duration(milliseconds: 10));
      expect(h.hits.length, 1);
      expect(u.phase, UpdatePhase.upToDate);
      await tester.pump(const Duration(minutes: 1));
      await tester.pump(const Duration(milliseconds: 10));
      expect(h.hits.length, 2);
      // بسته شد ⇒ زمان‌سنج متوقف
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 2));
      expect(h.hits.length, 2);
      await u.dispose();
    });

    testWidgets(
      'هر حالت رنگ/برچسب خودش را دارد؛ اندروید بدون نصب‌کننده ⇒ مرورگر',
      (tester) async {
        final opened = <Uri>[];
        final u = AppUpdater(
          channel: channel,
          http: http,
          windows: false,
          currentBuild: 7,
          retry: UpdateRetry.none,
          stagingRoot: staging,
          installDir: install,
        );
        await tester.pumpWidget(
          MaterialApp(
            theme: PayeshUi.light(),
            home: Scaffold(
              body: Center(
                child: UpdateLight(
                  updater: u,
                  openUrl: (x) async => opened.add(x),
                ),
              ),
            ),
          ),
        );
        String tip() => tester.widget<Tooltip>(find.byType(Tooltip)).message!;
        expect(tip(), 'بررسی به‌روزرسانی');
        await tester.tap(find.byKey(const Key('update-light')));
        await tester.pump(const Duration(milliseconds: 20));
        await tester.pump(const Duration(milliseconds: 20));
        expect(u.phase, UpdatePhase.ready);
        expect(tip(), contains('9.9.8'));
        await tester.tap(find.byKey(const Key('update-light')));
        await tester.pump(const Duration(milliseconds: 20));
        expect(opened, [channel.apkUrl]);
        final labels = <UpdatePhase, String>{};
        for (final p in [
          UpdatePhase.checking,
          UpdatePhase.applying,
          UpdatePhase.failed,
          UpdatePhase.upToDate,
        ]) {
          u
            ..phase = p
            ..error = p == UpdatePhase.failed ? 'خطا' : null;
          // ignore: invalid_use_of_protected_member
          tester.state(find.byType(UpdateLight)).setState(() {});
          await tester.pump(const Duration(milliseconds: 20));
          expect(find.byKey(Key('update-light-${p.name}')), findsOneWidget);
          labels[p] = tip();
        }
        expect(labels[UpdatePhase.checking], 'در حال بررسی');
        expect(labels[UpdatePhase.applying], contains('دوباره باز می‌شود'));
        expect(labels[UpdatePhase.failed], 'خطا — برای تلاش دوباره لمس کنید');
        expect(labels[UpdatePhase.upToDate], 'به‌روز است');
        await tester.pumpWidget(const SizedBox());
        await u.dispose();
      },
    );

    test('runUpdateNow: به‌روز ⇒ کاری نمی‌کند؛ پوشهٔ پیش‌فرض', () async {
      final h = http();
      final u = AppUpdater(
        channel: channel,
        http: () => h,
        windows: false,
        currentBuild: 8,
        retry: UpdateRetry.none,
        stagingRoot: staging,
        installDir: install,
      );
      await runUpdateNow(u);
      expect(u.phase, UpdatePhase.upToDate);
      expect(
        AppUpdater.defaultStaging('PayeshTest').path,
        endsWith('PayeshTest${Platform.pathSeparator}update'),
      );
      await u.dispose();
    });

    test('ChannelApkInstaller: پاسخ‌ها و خطاهای کانال بومی', () async {
      TestWidgetsFlutterBinding.ensureInitialized();
      const ch = MethodChannel('ir.payesh/update-test');
      final m =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      Object? answer;
      final calls = <MethodCall>[];
      m.setMockMethodCallHandler(ch, (c) async {
        calls.add(c);
        final a = answer;
        if (a is PlatformException) throw a;
        return a;
      });
      addTearDown(() => m.setMockMethodCallHandler(ch, null));
      const inst = ChannelApkInstaller(ch);
      answer = tmp.path;
      expect((await inst.cacheDir()).path, tmp.path);
      answer = null;
      await expectLater(
        inst.cacheDir(),
        throwsA(isA<UpdateException>().having((e) => e.code, 'code', 'io')),
      );
      answer = 'started';
      expect(
        await inst.install(File('${tmp.path}/payesh-update-8.apk')),
        'started',
      );
      expect(calls.last.method, 'installApk');
      expect(
        (calls.last.arguments as Map)['path'],
        '${tmp.path}/payesh-update-8.apk',
      );
      answer = null;
      expect(await inst.install(File('x')), 'error');
      answer = PlatformException(code: 'update', message: 'boom');
      await expectLater(
        inst.install(File('x')),
        throwsA(
          isA<UpdateException>().having((e) => e.code, 'code', 'install'),
        ),
      );
      m.setMockMethodCallHandler(ch, null);
      await expectLater(
        inst.install(File('x')),
        throwsA(
          isA<UpdateException>().having((e) => e.code, 'code', 'install'),
        ),
      );
    });
  });

  test('آرگومان‌های --update-from / --update-now', () {
    final a = UpdateArgs.parse(['--update-from', '/tmp/u', '--update-now']);
    expect(a.now, isTrue);
    expect(
      a.manifest('owner-update.json')!.toFilePath(),
      '/tmp/u/owner-update.json',
    );
    expect(a.blobs('owner-files').toString(), endsWith('/owner-files/'));
    expect(
      a.blobs('owner-files')!.resolve('ab.gz').toFilePath(),
      '/tmp/u/owner-files/ab.gz',
    );
    const none = UpdateArgs();
    expect(UpdateArgs.parse(const []).now, isFalse);
    expect(none.manifest('x'), isNull);
  });
}

final class FakeInstaller implements ApkInstaller {
  FakeInstaller(this.dir);
  final Directory dir;
  File? installed;
  String answer = 'started';

  @override
  Future<Directory> cacheDir() async => dir;

  @override
  Future<String> install(File apk) async {
    if (answer == 'started') installed = apk;
    return answer;
  }
}
