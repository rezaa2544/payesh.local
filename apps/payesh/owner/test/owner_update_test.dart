import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/update/owner_update.dart';
import 'package:payesh_owner/src/update/update_service.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'support/fake_bucket.dart';

/// به‌روزرسانی پنل مالک (ADR 126 §۱۲): فقط فایل‌های تغییرکرده دانلود می‌شوند.
final class FakeHttp implements UpdateHttp {
  final files = <String, List<int>>{};
  final hits = <String>[];

  @override
  Future<List<int>?> get(Uri url, {int maxBytes = 1 << 30}) async {
    final k = url.replace(query: '').toString().replaceAll('?', '');
    hits.add(k);
    final b = files[k];
    if (b != null && b.length > maxBytes) {
      throw const UpdateException('network', 'too big');
    }
    return b;
  }

  @override
  void close() {}
}

final class MemMirror implements UpdateMirror {
  final blobs = <String, List<int>>{};
  int gets = 0;

  @override
  Future<List<int>?> get(String blob) async {
    gets++;
    return blobs[blob];
  }

  @override
  Future<void> put(String blob, List<int> gz) async => blobs[blob] = gz;
}

String sha(List<int> b) => sha256.convert(b).toString();

void main() {
  late Directory tmp;
  late Directory install;
  late Directory staging;
  final manifestUrl = Uri.parse('https://updates.test/owner-update.json');
  final blobBase = Uri.parse('https://updates.test/files/');

  // نسخهٔ جدید: app.so عوض شده، یک دارایی تازه اضافه شده، exe همان است
  final exe = utf8.encode('EXE-v1' * 1000);
  final soOld = utf8.encode('SO-v1' * 5000);
  final soNew = utf8.encode('SO-v2' * 5000);
  final asset = utf8.encode('{"new":true}');

  Map<String, Object?> entry(String path, List<int> raw) => {
    'path': path,
    'sha256': sha(raw),
    'size': raw.length,
    'gz_size': gzip.encode(raw).length,
  };

  Map<String, Object?> manifest() => {
    'schema': ownerUpdateSchema,
    'build': 140,
    'commit': 'a' * 40,
    'files': [
      entry('payesh_owner.exe', exe),
      entry('data/app.so', soNew),
      entry('data/flutter_assets/new.json', asset),
    ],
    'android': {'sha256': 'b' * 64, 'size': 30000000},
  };

  FakeHttp http() {
    final h = FakeHttp()
      ..files[manifestUrl.toString()] = utf8.encode(jsonEncode(manifest()));
    for (final raw in [exe, soNew, asset]) {
      h.files[blobBase.resolve('${sha(raw)}.gz').toString()] = gzip.encode(raw);
    }
    return h;
  }

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('owner-upd-');
    install = Directory('${tmp.path}/install')..createSync();
    staging = Directory('${tmp.path}/staging');
    File('${install.path}/payesh_owner.exe').writeAsBytesSync(exe);
    File('${install.path}/data/app.so')
      ..parent.createSync(recursive: true)
      ..writeAsBytesSync(soOld);
  });

  tearDown(() => tmp.deleteSync(recursive: true));

  group('مانیفست', () {
    test('معتبر', () {
      final m = OwnerUpdateManifest.parse(jsonEncode(manifest()));
      expect(m.build, 140);
      expect(m.files, hasLength(3));
      expect(m.apk!.size, 30000000);
      expect(m.totalBytes, exe.length + soNew.length + asset.length);
    });

    for (final (why, mutate) in <(String, void Function(Map<String, Object?>))>[
      ('schema', (m) => m['schema'] = 'other/1'),
      ('build', (m) => m['build'] = 0),
      ('commit', (m) => m['commit'] = 'xyz'),
      ('files empty', (m) => m['files'] = <Object?>[]),
      (
        'path ..',
        (m) => (m['files']! as List)[0] = {
          ...entry('x', exe),
          'path': '../evil.exe',
        },
      ),
      (
        'absolute path',
        (m) => (m['files']! as List)[0] = {
          ...entry('x', exe),
          'path': 'C:/Windows/x.dll',
        },
      ),
      (
        'duplicate (case-insensitive)',
        (m) => (m['files']! as List)[0] = {
          ...entry('x', exe),
          'path': 'DATA/app.so',
        },
      ),
      (
        'sha',
        (m) => (m['files']! as List)[0] = {...entry('x', exe), 'sha256': 'zz'},
      ),
      ('android', (m) => m['android'] = {'sha256': 'b' * 64, 'size': 0}),
    ]) {
      test('رد: $why', () {
        final m = manifest();
        mutate(m);
        expect(
          () => OwnerUpdateManifest.parse(jsonEncode(m)),
          throwsA(
            isA<UpdateException>().having(
              (e) => e.code,
              'code',
              'bad_manifest',
            ),
          ),
        );
      });
    }

    test('رد: JSON خراب', () {
      expect(
        () => OwnerUpdateManifest.parse('{'),
        throwsA(isA<UpdateException>()),
      );
    });
  });

  group('فقط تغییرات', () {
    test('طرح: فقط app.so و فایل تازه؛ exe دانلود نمی‌شود', () async {
      final m = await fetchManifest(http(), url: manifestUrl);
      final p = await planUpdate(m, install);
      expect(p.changed.map((f) => f.path), [
        'data/app.so',
        'data/flutter_assets/new.json',
      ]);
      expect(
        p.downloadBytes,
        gzip.encode(soNew).length + gzip.encode(asset).length,
      );
      expect(p.downloadBytes, lessThan(p.totalBytes));
    });

    test('دریافت از GitHub، پر کردن آینهٔ آروان، بار دوم از آینه', () async {
      final h = http();
      final mirror = MemMirror();
      final p = await planUpdate(
        await fetchManifest(h, url: manifestUrl),
        install,
      );
      final progress = <int>[];
      final s = await downloadUpdate(
        p,
        http: h,
        stagingRoot: staging,
        mirror: mirror,
        blobBase: blobBase,
        onProgress: (d, t) => progress.add(d),
      );
      expect(s.fromOrigin, 2);
      expect(s.fromMirror, 0);
      expect(progress.last, p.downloadBytes);
      expect(mirror.blobs.keys, {'${sha(soNew)}.gz', '${sha(asset)}.gz'});
      expect(File('${s.files.path}/data/app.so').readAsBytesSync(), soNew);
      expect(h.hits.where((u) => u.contains(sha(exe))), isEmpty);
      final plan = jsonDecode(
        File('${s.dir.path}/plan.json').readAsStringSync(),
      ) as Map<String, Object?>;
      expect(plan['build'], 140);

      // دستگاه دوم: همه از آینه
      final h2 = http();
      final s2 = await downloadUpdate(
        p,
        http: h2,
        stagingRoot: Directory('${tmp.path}/staging2'),
        mirror: mirror,
        blobBase: blobBase,
      );
      expect(s2.fromMirror, 2);
      expect(s2.fromOrigin, 0);
      expect(h2.hits, isEmpty);
    });

    test(
      'آینهٔ دستکاری‌شده نادیده گرفته می‌شود؛ GitHub دستکاری‌شده ⇒ هیچ تغییری',
      () async {
        final h = http();
        final mirror = MemMirror()
          ..blobs['${sha(soNew)}.gz'] = gzip.encode(utf8.encode('evil'));
        final p = await planUpdate(
          await fetchManifest(h, url: manifestUrl),
          install,
        );
        final s = await downloadUpdate(
          p,
          http: h,
          stagingRoot: staging,
          mirror: mirror,
          blobBase: blobBase,
        );
        expect(s.fromOrigin, 2);
        expect(File('${s.files.path}/data/app.so').readAsBytesSync(), soNew);

        h.files[blobBase.resolve('${sha(soNew)}.gz').toString()] = gzip.encode(
          utf8.encode('evil'),
        );
        await expectLater(
          downloadUpdate(p, http: h, stagingRoot: staging, blobBase: blobBase),
          throwsA(
            isA<UpdateException>().having((e) => e.code, 'code', 'bad_hash'),
          ),
        );
        // نسخهٔ نصب‌شده دست‌نخورده
        expect(File('${install.path}/data/app.so').readAsBytesSync(), soOld);
      },
    );

    test('آینهٔ صندوقچهٔ آروان (S3)', () async {
      final bucket = FakeBucket(() => DateTime.utc(2026, 11, 13));
      final m = S3UpdateMirror(
        S3Settings(
          endpoint: Uri.https('s3.example.test'),
          accessKey: 'ak',
          secretKey: 'sk',
          bucket: 'payesh-madrese',
        ),
        bucket.transport,
      );
      expect(await m.get('x.gz'), isNull);
      final gz = gzip.encode(soNew);
      await m.put('x.gz', gz);
      expect(bucket.objects.keys, contains('payesh/updates/owner/x.gz'));
      expect(await m.get('x.gz'), gz);
    });

    test('اسکریپت اعمال: پشتیبان، بررسی هش، بازگشت خودکار', () async {
      final h = http();
      final p = await planUpdate(
        await fetchManifest(h, url: manifestUrl),
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
        installDir: r'C:\Users\رضا\AppData\Local\Programs\PayeshOwner',
      );
      expect(ps, contains(r"'data\app.so'"));
      expect(ps, contains(sha(soNew)));
      expect(ps, isNot(contains(sha(exe))));
      expect(ps, contains('Wait-Process -Id \$AppPid'));
      expect(ps, contains('Get-Sha256'));
      expect(ps, isNot(contains('Get-FileHash')));
      expect(ps, contains('PSModulePath'));
      expect(ps, contains('Restore-Backup'));
      expect(ps, contains(r'$build = 140'));
      expect(ps, contains('رضا'));
    });

    test('اجرا: برنامه فقط با دیدن نشانهٔ شروع بسته می‌شود؛ روش دوم؛ شکست ⇐ launch', () async {
      final h = http();
      final p = await planUpdate(
        await fetchManifest(h, url: manifestUrl),
        install,
      );
      final s = await downloadUpdate(
        p,
        http: h,
        stagingRoot: staging,
        blobBase: blobBase,
      );
      final calls = <List<String>>[];
      final lines = <String>[];
      // روش اول شروع نمی‌شود (مثل powershell بی‌کنسول)، روش دوم نشانه را می‌نویسد.
      final script = await launchApply(
        staged: s,
        installDir: install.path,
        appPid: 4242,
        startTimeout: const Duration(milliseconds: 400),
        log: lines.add,
        starter: (exe, args, {mode = ProcessStartMode.normal}) async {
          expect(mode, ProcessStartMode.detached);
          calls.add([exe, ...args]);
          if (exe == 'cmd.exe' && !args.contains('-WindowStyle')) {
            File('${s.dir.path}/apply.log').writeAsStringSync('start\n');
          }
          return null;
        },
      );
      expect(script.existsSync(), isTrue);
      expect(script.readAsBytesSync().take(3), [0xEF, 0xBB, 0xBF]);
      final ps = script.readAsStringSync();
      expect(ps, contains("\$ProgressPreference = 'SilentlyContinue'"));
      expect(ps, contains('apply.lock'));
      expect(ps, contains('trap {'));
      expect(calls, hasLength(2));
      expect(calls[0].take(9), [
        'cmd.exe',
        '/d',
        '/c',
        'start',
        '',
        '/min',
        'powershell.exe',
        '-WindowStyle',
        'Hidden',
      ]);
      expect(
        calls[0],
        containsAllInOrder(['-File', script.path, '-AppPid', '4242']),
      );
      expect(calls[1].take(7), [
        'cmd.exe',
        '/d',
        '/c',
        'start',
        '',
        '/min',
        'powershell.exe',
      ]);
      expect(calls[1], isNot(contains('-WindowStyle')));
      expect(lines.last, 'apply launched via cmd-start-min');

      // هیچ روشی شروع نشد ⇐ UpdateException('launch')؛ نشانهٔ قبلی پاک شده بود.
      final err = await launchApply(
        staged: s,
        installDir: install.path,
        appPid: 4242,
        startTimeout: const Duration(milliseconds: 200),
        starter: (exe, args, {mode = ProcessStartMode.normal}) async {
          if (exe == 'cmd.exe') throw const ProcessException('cmd.exe', []);
          return null;
        },
      ).then<Object?>((_) => null, onError: (Object e) => e);
      expect(err, isA<UpdateException>());
      final ue = err! as UpdateException;
      expect(ue.code, 'launch');
      expect(ue.messageFa, contains('باز می‌ماند'));
      expect(File('${s.dir.path}/cancel').existsSync(), isTrue);
      expect(script.readAsStringSync(), contains("Join-Path \$stage 'cancel'"));
      expect(
        script.readAsStringSync(),
        contains('app still running; nothing changed'),
      );
    });

    test('نتیجهٔ اعمال قبلی خوانده و پاک می‌شود', () {
      final d = Directory('${staging.path}/140')..createSync(recursive: true);
      File('${d.path}/result.json').writeAsStringSync(
        jsonEncode({
          'ok': false,
          'build': 140,
          'rolled_back': true,
          'message': 'new build exited early (1)',
        }),
      );
      final r = takeApplyResult(staging)!;
      expect(r.ok, isFalse);
      expect(r.rolledBack, isTrue);
      expect(r.build, 140);
      expect(d.existsSync(), isFalse);
      expect(takeApplyResult(staging), isNull);
    });
  });

  group('OwnerUpdater', () {
    test('بررسی ⇐ دریافت ⇐ اعمال (ویندوز)', () async {
      final h = http();
      StagedUpdate? launched;
      final u = OwnerUpdater(
        secure: FakeSecureStore(),
        http: () => h,
        installDir: install,
        stagingRoot: staging,
        manifestUrl: manifestUrl,
        blobBase: blobBase,
        windows: true,
        launcher: (s) async => launched = s,
      );
      await u.check();
      expect(u.phase, UpdatePhase.ready);
      expect(u.available, isTrue);
      expect(u.plan!.changed, hasLength(2));
      await u.download();
      expect(u.phase, UpdatePhase.staged);
      expect(u.progressDone, u.progressTotal);
      await u.applyAndRestart();
      expect(launched!.plan.manifest.build, 140);
      await u.dispose();
    });

    test('به‌روز ⇒ upToDate؛ شبکه قطع ⇒ پیام فارسی', () async {
      File('${install.path}/data/app.so').writeAsBytesSync(soNew);
      File('${install.path}/data/flutter_assets/new.json')
        ..parent.createSync(recursive: true)
        ..writeAsBytesSync(asset);
      final h = http();
      final u = OwnerUpdater(
        secure: FakeSecureStore(),
        http: () => h,
        installDir: install,
        stagingRoot: staging,
        manifestUrl: manifestUrl,
        windows: true,
      );
      await u.check();
      expect(u.phase, UpdatePhase.upToDate);
      h.files.clear();
      await u.check();
      expect(u.phase, UpdatePhase.failed);
      expect(u.error, contains('به سرور به‌روزرسانی نرسیدیم'));
      await u.dispose();
    });
  });
}
