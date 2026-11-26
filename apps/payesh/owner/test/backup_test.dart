import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/backup/backup_engine.dart';
import 'package:payesh_owner/src/backup/backup_store.dart';
import 'package:payesh_owner/src/backup/backup_zip.dart';
import 'package:payesh_owner/src/guard/guard_engine.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/menu.dart';
import 'package:payesh_owner/src/net/resilience.dart';
import 'package:payesh_owner/src/pages/backup_page.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'support/fake_bucket.dart';

/// ردیف ۱۵۵: پشتیبان کامل، خودکار و افزایشی دیتابیس مالک + بازیابی/انتقال یک‌کلیکی.
/// ردیف ۱۶۶: «یک فایل جامع» روی هر مقصد که هر تغییر در آن ادغام می‌شود؛ حذف روی دیسک و دیتابیس.
void main() {
  final t0 = DateTime.utc(2026, 11, 14, 10);

  group('قالب یک فایل جامع (ZIP)', () {
    test('CRC-32 و ZIP: رفت‌وبرگشت، نام فارسی، فشرده/بی‌فشرده، خرابی رد', () {
      expect(crc32(utf8.encode('123456789')), 0xCBF43926);
      final w = ZipWriter()
        ..add('data/payesh/schools/registry.json', utf8.encode('{"v":1}' * 50))
        ..add('data/payesh/مدرسه/۱.json', utf8.encode('سلام'))
        ..add('data/empty', const []);
      final z = w.finish();
      final r = ZipReader.parse(z)!;
      expect(r.names, hasLength(3));
      expect(utf8.decode(r.read('data/payesh/مدرسه/۱.json')!), 'سلام');
      expect(
        utf8.decode(r.read('data/payesh/schools/registry.json')!),
        '{"v":1}' * 50,
      );
      expect(r.read('data/empty'), isEmpty);
      expect(r.read('nope'), isNull);
      // یک بایت خراب در دادهٔ فشرده ⇒ CRC نمی‌خواند
      final bad = Uint8List.fromList(z);
      bad[30 + 33 + 2] ^= 0xFF; // دادهٔ فشردهٔ نخستین فایل
      final rb = ZipReader.parse(bad);
      expect(
        rb == null ||
            rb.read('data/payesh/schools/registry.json') == null ||
            rb.read('data/payesh/مدرسه/۱.json') == null,
        isTrue,
      );
      expect(ZipReader.parse(Uint8List.fromList([1, 2, 3])), isNull);
    });

    test('ZIP64: بیش از ۶۵۵۳۵ فایل', () {
      final w = ZipWriter();
      for (var i = 0; i < 65600; i++) {
        w.add('f$i', const [1]);
      }
      final r = ZipReader.parse(w.finish())!;
      expect(r.names.length, 65600);
      expect(r.read('f65599'), [1]);
    });

    test(
      'فایل پشتیبان: فهرست + محتوا با بازبینی sha256؛ فایل غیرپشتیبان رد',
      () {
        final objs = {'payesh/a.json': 'A', 'payesh/b.bin': 'BB'};
        final snap = BackupSnapshot(
          at: t0,
          bucket: 'payesh-madrese',
          objects: {
            for (final e in objs.entries)
              e.key: (
                sha: sha256Hex(utf8.encode(e.value)),
                size: e.value.length,
                modifiedMs: t0.millisecondsSinceEpoch,
                etag: '"e"',
              ),
          },
        );
        final bytes = BackupArchive.build(snap, (k) => utf8.encode(objs[k]!));
        final a = BackupArchive.parse(bytes)!;
        expect(a.snapshot.count, 2);
        expect(a.snapshot.bytes, 3);
        expect(a.snapshot.bucket, 'payesh-madrese');
        expect(a.snapshot.fingerprint, snap.fingerprint);
        expect(utf8.decode(a.content('payesh/b.bin')!), 'BB');
        expect(a.content('payesh/none'), isNull);
        final z = ZipReader.parse(bytes)!;
        expect(
          z.names,
          containsAll([backupManifestName, 'data/payesh/a.json']),
        );
        // ZIP بدون فهرست ⇒ پشتیبان نیست
        expect(
          BackupArchive.parse((ZipWriter()..add('x', const [1])).finish()),
          isNull,
        );
      },
    );
  });

  group('موتور پشتیبان در برابر صندوقچهٔ جعلی', () {
    setUpAll(() => s3RetryPolicy = RetryPolicy.none);
    tearDownAll(() => s3RetryPolicy = const RetryPolicy());
    late DateTime clock;
    late FakeBucket bucket;
    late FakeSecureStore secure;
    late Directory dir;
    late OwnerBackupEngine eng;

    Future<void> useBucket(FakeBucket b) => S3Settings(
      endpoint: Uri.https('s3.example.test'),
      accessKey: 'ak',
      secretKey: 'sk',
      bucket: b.bucket,
    ).save(secure);

    setUp(() async {
      EndpointRoutes.reset();
      clock = t0;
      bucket = FakeBucket(() => clock);
      secure = FakeSecureStore();
      dir = Directory.systemTemp.createTempSync('owner-backup-');
      await useBucket(bucket);
      eng = OwnerBackupEngine(
        secure: secure,
        s3Factory: () => bucket.transport(),
        localRoot: () async => dir,
        now: () => clock,
        retryDelay: Duration.zero,
      );
    });
    tearDown(() {
      eng.dispose();
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });

    File diskFile() => File('${dir.path}/$backupFileName');
    BackupArchive? diskArchive() => diskFile().existsSync()
        ? BackupArchive.parse(diskFile().readAsBytesSync())
        : null;
    BackupArchive? dbArchive() {
      final b = bucket.objects[BucketBackupTarget.key];
      return b == null ? null : BackupArchive.parse(b);
    }

    List<String> diskFiles() => [
      for (final e in dir.listSync(recursive: true))
        if (e is File) e.path.substring(dir.path.length + 1),
    ];

    test('ردیف ۱۶۶: همیشه یک فایل جامع؛ هر تغییر در همان فایل ادغام می‌شود؛ دیسک + دیتابیس', () async {
      // صندوقچهٔ خالی ⇒ هیچ فایلی
      var r = await eng.run();
      expect((r.ok, r.created, r.count), (true, false, 0));
      expect(diskFile().existsSync(), isFalse);

      bucket
        ..putText('payesh/schools/registry.json', '{"v":1}')
        ..putText('payesh/data/core.json', '{"a":1}')
        ..putText('payesh/data/person/7.json', 'ZIP');
      r = await eng.run();
      expect((r.ok, r.created, r.count, r.fetched), (true, true, 3, 3));
      expect(diskFiles(), [backupFileName], reason: 'فقط یک فایل');
      expect(bucket.keysUnder(bucketBackupRoot).toList(), [
        BucketBackupTarget.key,
      ], reason: 'روی دیتابیس هم فقط یک فایل');
      var a = diskArchive()!;
      expect(a.snapshot.bucket, 'payesh-madrese');
      expect(utf8.decode(a.content('payesh/data/person/7.json')!), 'ZIP');
      expect(dbArchive()!.snapshot.fingerprint, a.snapshot.fingerprint);
      expect(eng.lastError, isNull);

      // بدون تغییر ⇒ هیچ خواندن و هیچ نوشتنی
      clock = clock.add(const Duration(minutes: 15));
      final gets = bucket.log.where((l) => l.startsWith('GET /payesh/')).length;
      final puts = bucket.log.where((l) => l.startsWith('PUT ')).length;
      final stamp = diskFile().lastModifiedSync();
      r = await eng.run();
      expect((r.ok, r.created, r.fetched), (true, false, 0));
      expect(
        bucket.log.where((l) => l.startsWith('GET /payesh/')).length,
        gets,
      );
      expect(bucket.log.where((l) => l.startsWith('PUT ')).length, puts);
      expect(diskFile().lastModifiedSync(), stamp);

      // یک تغییر + یک حذف ⇒ فقط همان یکی دانلود؛ همان یک فایل به‌روز می‌شود
      // ردیف ۱۹۸: نسخهٔ دیتابیس روزی یک بار ⇒ برای دیدن آن، یک روز جلو
      clock = clock.add(OwnerBackupEngine.dbEvery);
      bucket.putText('payesh/schools/registry.json', '{"v":2}');
      bucket.objects.remove('payesh/data/person/7.json');
      r = await eng.run();
      expect((r.created, r.fetched, r.count), (true, 1, 2));
      expect(diskFiles(), [backupFileName]);
      a = diskArchive()!;
      expect(a.snapshot.count, 2);
      expect(
        a.snapshot.objects.keys,
        isNot(contains('payesh/data/person/7.json')),
      );
      expect(
        utf8.decode(a.content('payesh/schools/registry.json')!),
        '{"v":2}',
      );
      expect(utf8.decode(a.content('payesh/data/core.json')!), '{"a":1}');
      expect(dbArchive()!.snapshot.fingerprint, a.snapshot.fingerprint);
      expect(bucket.keysUnder(bucketBackupRoot), hasLength(1));

      // تغییرِ هم‌اندازه در همان ثانیه ⇒ با ETag دیده می‌شود
      clock = clock.add(OwnerBackupEngine.dbEvery);
      bucket.putText('payesh/data/core.json', '{"a":9}', at: clock);
      r = await eng.run();
      expect((r.created, r.fetched), (true, 1));
      expect(
        utf8.decode(diskArchive()!.content('payesh/data/core.json')!),
        '{"a":9}',
      );

      // دیتابیس خاموش ⇒ فقط دیسک
      await eng.setDb(false);
      expect(eng.dbOn, isFalse);
      clock = clock.add(const Duration(minutes: 15));
      final dbFp = dbArchive()!.snapshot.fingerprint;
      bucket.putText('payesh/data/core.json', '{"a":2}');
      r = await eng.run();
      expect(r.created, isTrue);
      expect(dbArchive()!.snapshot.fingerprint, dbFp);
      expect(diskArchive()!.snapshot.fingerprint, isNot(dbFp));
      // دوباره روشن ⇒ نسخهٔ دیتابیس از روی فایل (بی‌دانلود دوباره) به‌روز می‌شود
      await eng.setDb(true);
      r = await eng.run();
      expect((r.created, r.fetched), (true, 0));
      expect(
        dbArchive()!.snapshot.fingerprint,
        diskArchive()!.snapshot.fingerprint,
      );

      // کلیدها ماندگارند
      await eng.setDb(false);
      final again = OwnerBackupEngine(
        secure: secure,
        s3Factory: () => bucket.transport(),
      );
      await again.refresh();
      expect(again.dbOn, isFalse);
      expect(again.autoOn, isTrue);
      expect(again.lastSuccess, clock);
      again.dispose();
      await eng.setAuto(false);
      expect(eng.autoOn, isFalse);

      await eng.refresh();
      expect([for (final f in eng.files) f.target], ['disk', 'db']);
      expect(eng.files.first.count, 2);
      expect(eng.files.first.size, diskFile().lengthSync());
    });

    test('ردیف ۱۹۸: updates/ و پرونده‌های گذرا در پشتیبان نیستند؛ دیتابیس روزی یک بار؛ بی‌دانلود دوباره', () async {
      expect(backupSkipsKey('payesh/updates/owner/abc.gz'), isTrue);
      expect(backupSkipsKey('payesh/helpers/6a69.json'), isTrue);
      expect(backupSkipsKey('payesh/jobs/req/1.json'), isTrue);
      expect(backupSkipsKey('payesh/realtime/x.json'), isTrue);
      expect(backupSkipsKey('payesh/h/s-177dd0b62048/realtime/x.json'), isTrue);
      expect(backupSkipsKey('payesh/h/s-177dd0b62048/data/core.json'), isFalse);
      expect(backupSkipsKey('payesh/data/person/updates/1.json'), isFalse);
      expect(backupSkipsKey('payesh/schools/registry.json'), isFalse);
      bucket
        ..putText('payesh/schools/registry.json', 'R')
        ..putText('payesh/data/core.json', 'C')
        ..putText('payesh/updates/owner/big.gz', 'BIN' * 1000)
        ..putText('payesh/helpers/6a69.json', 'H');
      var r = await eng.run();
      expect((r.ok, r.created, r.count), (true, true, 2));
      expect(dbArchive()!.snapshot.objects.keys.toSet(), {
        'payesh/schools/registry.json',
        'payesh/data/core.json',
      });
      int puts() => bucket.log
          .where(
            (l) =>
                l.startsWith('PUT /$bucketBackupRoot') ||
                l.startsWith('POST /$bucketBackupRoot'),
          )
          .length;
      int zipGets() => bucket.log
          .where((l) => l.startsWith('GET /${BucketBackupTarget.key}'))
          .length;
      final p0 = puts();
      final g0 = zipGets();
      // «بازخوانی» پس از نوشتن: فایل ۱۰۰ مگابایتی دوباره دانلود نمی‌شود
      await eng.refresh();
      expect(zipGets(), g0);
      expect([for (final f in eng.files) f.target], ['disk', 'db']);

      // ۹۶ دور (یک روز، هر ۱۵ دقیقه یک تغییر) ⇒ دیسک هر بار، دیتابیس صفر بار
      for (var i = 0; i < 95; i++) {
        clock = clock.add(OwnerBackupEngine.every);
        bucket.putText('payesh/data/core.json', 'C$i');
        r = await eng.run();
        expect(r.created, isTrue);
      }
      expect(puts(), p0, reason: 'کمتر از یک روز ⇒ هیچ نوشتنی روی دیتابیس');
      expect(
        utf8.decode(diskArchive()!.content('payesh/data/core.json')!),
        'C94',
      );
      clock = clock.add(OwnerBackupEngine.every);
      r = await eng.run();
      expect(puts(), greaterThan(p0), reason: 'پس از یک روز ⇒ یک نوشتن');
      expect(
        dbArchive()!.snapshot.fingerprint,
        diskArchive()!.snapshot.fingerprint,
      );
      // «پشتیبان‌گیری اکنون» همیشه دیتابیس را هم می‌نویسد
      final p1 = puts();
      clock = clock.add(OwnerBackupEngine.every);
      bucket.putText('payesh/data/core.json', 'NOW');
      r = await eng.run(force: true);
      expect(puts(), greaterThan(p1));
      expect(
        utf8.decode(dbArchive()!.content('payesh/data/core.json')!),
        'NOW',
      );

      // باز شدن دوبارهٔ برنامه (موتور تازه با همان وضعیت): فایل دیتابیس دانلود نمی‌شود
      final g1 = zipGets();
      final again = OwnerBackupEngine(
        secure: secure,
        s3Factory: () => bucket.transport(),
        now: () => clock,
        retryDelay: Duration.zero,
      );
      await again.refresh();
      expect(zipGets(), g1, reason: 'ETag همان است ⇒ از وضعیت ذخیره‌شده');
      expect(again.files.single.target, 'db');
      expect(again.files.single.count, 2);
      again.dispose();
    });

    test('ردیف ۱۶۶: قالب قدیمی (blobs/ و snaps/) پس از نخستین فایل جامع پاک می‌شود', () async {
      Directory('${dir.path}/snaps').createSync(recursive: true);
      File('${dir.path}/snaps/20261101T000000Z.json').writeAsStringSync('{}');
      Directory('${dir.path}/blobs/ab').createSync(recursive: true);
      File('${dir.path}/blobs/ab/x.gz').writeAsBytesSync([1]);
      bucket
        ..putText('${bucketBackupRoot}snaps/20261101T000000Z.json', '{}')
        ..putText('${bucketBackupRoot}blobs/ab/x.gz', 'x')
        ..putText('payesh/a.json', 'A');
      final r = await eng.run();
      expect(r.created, isTrue);
      expect(diskFiles(), [backupFileName]);
      expect(bucket.keysUnder(bucketBackupRoot).toList(), [
        BucketBackupTarget.key,
      ]);
      expect(bucket.objects.containsKey('payesh/a.json'), isTrue);
    });

    test('ردیف ۱۶۶: حذف پشتیبان روی دیسک و روی دیتابیس؛ دور بعد از نو ساخته می‌شود', () async {
      bucket
        ..putText('payesh/a.json', 'A')
        ..putText('payesh/b.json', 'B');
      await eng.run();
      await eng.refresh();
      expect(eng.files, hasLength(2));

      expect(await eng.deleteBackup('db'), isNull);
      expect(bucket.keysUnder(bucketBackupRoot), isEmpty);
      expect(diskFile().existsSync(), isTrue);
      expect([for (final f in eng.files) f.target], ['disk']);

      expect(await eng.deleteBackup('disk'), isNull);
      expect(diskFile().existsSync(), isFalse);
      expect(eng.files, isEmpty);
      // دادهٔ اصلی دیتابیس دست نخورد
      expect(bucket.text('payesh/a.json'), 'A');

      // با پشتیبان خودکار، دور بعد هر دو از نو ساخته می‌شوند (کامل)
      clock = clock.add(const Duration(minutes: 15));
      final r = await eng.run();
      expect((r.created, r.count), (true, 2));
      expect(diskArchive()!.snapshot.count, 2);
      expect(dbArchive()!.snapshot.count, 2);

      // بدون دیتابیس ⇒ پیام روشن برای حذف نسخهٔ دیتابیس
      await S3Settings.clear(secure);
      expect(await eng.deleteBackup('db'), contains('تنظیمات'));
    });

    test('بازیابی یک‌کلیکی از فایل جامع؛ فایل تازه‌تر دست نمی‌خورد؛ محتوای خراب از نسخهٔ دیگر', () async {
      bucket
        ..putText('payesh/schools/registry.json', 'R1')
        ..putText('payesh/data/core.json', 'C1');
      await eng.run();
      await eng.setAuto(false);
      clock = clock.add(const Duration(minutes: 15));
      bucket
        ..putText('payesh/schools/registry.json', 'R2-خراب')
        ..putText('payesh/support/new.json', 'N');
      bucket.objects.remove('payesh/data/core.json');
      final r = await eng.restore('disk');
      expect(r.ok, isTrue);
      expect((r.written, r.same, r.failed, r.newer), (2, 0, 0, 1));
      expect(bucket.text('payesh/schools/registry.json'), 'R1');
      expect(bucket.text('payesh/data/core.json'), 'C1');
      expect(bucket.text('payesh/support/new.json'), 'N');
      await eng.idle;

      // فایل دیسک خراب ⇒ از نسخهٔ دیتابیس
      diskFile().writeAsBytesSync([1, 2, 3]);
      bucket.objects.remove('payesh/data/core.json');
      final r2 = await eng.restore('disk');
      expect(r2.ok, isTrue, reason: '${r2.error}');
      expect(bucket.text('payesh/data/core.json'), 'C1');
      await eng.idle;
      // هیچ نسخه‌ای نیست ⇒ پیام
      await eng.deleteBackup('disk');
      await eng.deleteBackup('db');
      expect((await eng.restore('db')).error, contains('پیدا نشد'));
    });

    test('انتقال به دیتابیس تازه: صندوقچهٔ خالی جای پشتیبان را نمی‌گیرد؛ پس از بازیابی همان فایل ادامه می‌یابد', () async {
      bucket
        ..putText('payesh/schools/registry.json', 'R')
        ..putText('payesh/data/person/1.json', 'P');
      await eng.run();
      final before = diskArchive()!.snapshot.fingerprint;
      // دیتابیس تازه (صندوقچهٔ دیگر)
      final fresh = FakeBucket(() => clock, bucket: 'payesh-new');
      bucket = fresh;
      await useBucket(fresh);
      clock = clock.add(const Duration(minutes: 15));
      final r0 = await eng.run();
      expect((r0.ok, r0.count, r0.created), (true, 0, false));
      expect(diskArchive()!.snapshot.fingerprint, before);
      final r = await eng.restore('disk');
      expect(r.ok, isTrue);
      expect(r.written, 2);
      expect(fresh.text('payesh/schools/registry.json'), 'R');
      expect(fresh.text('payesh/data/person/1.json'), 'P');
      await eng.idle;
      // پس از انتقال، همان یک فایل حالا مال دیتابیس تازه است (روی دیتابیس تازه هم)
      expect(diskArchive()!.snapshot.bucket, 'payesh-new');
      expect(
        BackupArchive.parse(fresh.objects[BucketBackupTarget.key]!),
        isNotNull,
      );
    });

    test('دیتابیسِ دیگرِ پُر: پشتیبان خودکار بازنویسی نمی‌شود؛ «اکنون» (force) جایگزین می‌کند', () async {
      bucket.putText('payesh/a.json', 'A');
      await eng.run();
      final other = FakeBucket(() => clock, bucket: 'payesh-other');
      other.putText('payesh/z.json', 'Z');
      bucket = other;
      await useBucket(other);
      final r = await eng.run();
      expect(r.ok, isFalse);
      expect(r.error, contains('payesh-madrese'));
      expect(diskArchive()!.snapshot.bucket, 'payesh-madrese');
      final f = await eng.run(force: true);
      expect((f.ok, f.created), (true, true));
      expect(diskArchive()!.snapshot.bucket, 'payesh-other');
      expect(diskArchive()!.snapshot.objects.keys, ['payesh/z.json']);
    });

    test(
      'دیتابیس قطع ⇒ خطا و هشدار نگهبان؛ بدون دیتابیس ⇒ پیام روشن',
      () async {
        bucket.putText('payesh/a.json', 'A');
        bucket.down = true;
        final r = await eng.run();
        expect(r.ok, isFalse);
        expect(eng.lastError, isNotNull);
        final g = GuardEngine(secure: secure, backup: eng, now: () => clock);
        await g.run();
        final f = g.findings.singleWhere((x) => x.check == 'backup');
        expect(f.level, GuardLevel.warning);
        bucket.down = false;
        await eng.run();
        await g.run();
        expect(g.findings.where((x) => x.check == 'backup'), isEmpty);
        // یک ساعت بدون موفقیت ⇒ هشدار
        clock = clock.add(const Duration(hours: 2));
        await g.run();
        expect(g.findings.single.titleFa, contains('به‌روز نیست'));
        g.dispose();

        await S3Settings.clear(secure);
        final r2 = await eng.run();
        expect(r2.error, contains('تنظیمات'));
        expect((await eng.restore('disk')).error, contains('تنظیمات'));
        final none = OwnerBackupEngine(
          secure: secure,
          s3Factory: () => bucket.transport(),
        );
        expect((await none.run()).error, contains('تنظیمات'));
        none.dispose();
      },
    );

    test('۲۰۰ دور با تغییر: باز هم فقط یک فایل روی هر مقصد', () async {
      for (var i = 0; i < 40; i++) {
        bucket.putText('payesh/day.json', 'day $i');
        if (i.isEven) bucket.putText('payesh/n$i.json', 'n');
        await eng.run();
        clock = clock.add(const Duration(minutes: 15));
      }
      expect(diskFiles(), [backupFileName]);
      expect(bucket.keysUnder(bucketBackupRoot), hasLength(1));
      final a = diskArchive()!;
      expect(a.snapshot.count, 21);
      expect(utf8.decode(a.content('payesh/day.json')!), 'day 39');
    });

    test('ردیف ۱۶۶ (رایانهٔ مدرسه): قطع لحظه‌ای اینترنت ⇒ تلاش دوباره، دور ادامه می‌یابد', () async {
      bucket
        ..putText('payesh/a.json', 'A')
        ..putText('payesh/b.json', 'B');
      var fails = 0;
      bucket.failWhen = (m, k) =>
          m == 'GET' && k == 'payesh/b.json' && fails++ < 2;
      final r = await eng.run();
      expect(r.ok, isTrue, reason: r.error);
      expect(r.created, isTrue);
      expect(fails, 3);
      expect(utf8.decode(diskArchive()!.content('payesh/b.json')!), 'B');
    });

    test('ردیف ۱۶۶ (رایانهٔ مدرسه): دور ناتمام ⇒ دور بعد فایل‌های دانلودشده را دوباره نمی‌گیرد', () async {
      for (var i = 0; i < 20; i++) {
        bucket.putText('payesh/f$i.json', 'v$i');
      }
      bucket.failWhen = (m, k) => m == 'GET' && k == 'payesh/f9.json';
      final r1 = await eng.run();
      expect(r1.ok, isFalse);
      expect(diskFile().existsSync(), isFalse);
      expect(eng.lastError, isNotNull);
      bucket
        ..failWhen = null
        ..log.clear();
      final r2 = await eng.run();
      expect(r2.ok, isTrue, reason: r2.error);
      expect(r2.created, isTrue);
      final gets = [
        for (final l in bucket.log)
          if (l.startsWith('GET /payesh/')) l,
      ];
      // فقط فایل‌هایی که دور قبل نرسیدند (f9 و بعد از آن به ترتیب فهرست)
      expect(gets, isNot(contains('GET /payesh/f0.json')));
      expect(gets, contains('GET /payesh/f9.json'));
      expect(diskArchive()!.snapshot.count, 20);
    });

    test('ردیف ۱۶۶ (رایانهٔ مدرسه): نخستین فایل جامع از قالب قدیمی همین دیسک، بی‌دانلود دوباره', () async {
      bucket
        ..putText('payesh/a.json', 'A' * 5000)
        ..putText('payesh/b.json', 'B-new')
        ..putText('payesh/c.json', 'C');
      final settings = await S3Settings.load(secure);
      final (objs, _) = await s3ListObjects(settings!, bucket.transport(), '');
      List<Object> entry(String key, List<int> raw) {
        final o = objs.firstWhere((x) => x.key == key);
        return [
          sha256Hex(raw),
          raw.length,
          o.modified!.millisecondsSinceEpoch,
          o.etag,
        ];
      }

      void blob(List<int> raw) {
        final sha = sha256Hex(raw);
        final f = File('${dir.path}/blobs/${sha.substring(0, 2)}/$sha.gz')
          ..parent.createSync(recursive: true);
        f.writeAsBytesSync(gzip.encode(raw));
      }

      final a = utf8.encode('A' * 5000);
      final c = utf8.encode('C');
      blob(a);
      blob(c);
      // c: محتوای blob خراب ⇒ باید از دیتابیس خوانده شود
      final cSha = sha256Hex(c);
      File('${dir.path}/blobs/${cSha.substring(0, 2)}/$cSha.gz')
          .writeAsBytesSync(gzip.encode(utf8.encode('X')));
      Directory('${dir.path}/snaps').createSync(recursive: true);
      File('${dir.path}/snaps/20261101T000000Z.json').writeAsStringSync(
        jsonEncode({
          'v': 2,
          'kind': ownerBackupKind,
          'id': '20261101T000000Z',
          'base': null,
          'changed': {
            'payesh/a.json': entry('payesh/a.json', a),
            'payesh/c.json': entry('payesh/c.json', c),
            'payesh/gone.json': entry('payesh/a.json', a),
          },
        }),
      );
      File('${dir.path}/snaps/20261101T001500Z.json').writeAsStringSync(
        jsonEncode({
          'v': 2,
          'kind': ownerBackupKind,
          'id': '20261101T001500Z',
          'base': '20261101T000000Z',
          'changed': <String, Object>{},
          'removed': ['payesh/gone.json'],
        }),
      );
      final legacy = await LegacyDiskBackup.open(dir);
      expect(legacy!.objects.keys.toSet(), {'payesh/a.json', 'payesh/c.json'});

      bucket.log.clear();
      final r = await eng.run();
      expect(r.ok, isTrue, reason: r.error);
      expect(r.created, isTrue);
      expect(bucket.log, isNot(contains('GET /payesh/a.json')));
      expect(bucket.log, contains('GET /payesh/b.json'));
      expect(bucket.log, contains('GET /payesh/c.json'));
      final arc = diskArchive()!;
      expect(arc.snapshot.count, 3);
      expect(utf8.decode(arc.content('payesh/a.json')!), 'A' * 5000);
      expect(utf8.decode(arc.content('payesh/c.json')!), 'C');
      expect(diskFiles(), [backupFileName]); // قالب قدیمی پس از نوشتن پاک شد
    });

    test('ردیف ۱۶۶ (رایانهٔ مدرسه): فایل بزرگ روی دیتابیس تکه‌ای (۸ مگابایتی) نوشته می‌شود؛ تکهٔ قطع‌شده دوباره', () async {
      final rnd = Random(166);
      final big = Uint8List.fromList(
        List<int>.generate(s3PartBytes + 3000000, (_) => rnd.nextInt(256)),
      );
      bucket.objects['payesh/big.bin'] = big;
      bucket.modified['payesh/big.bin'] = clock;
      bucket.putText('payesh/a.json', 'A');
      var partFails = 0;
      bucket.failWhen = (m, k) =>
          m == 'PUT' && k == BucketBackupTarget.key && partFails++ == 1;
      final r = await eng.run();
      expect(r.ok, isTrue, reason: r.error);
      expect(bucket.log.where((l) => l.contains('?uploads')), hasLength(1));
      expect(
        bucket.log.where(
          (l) => l.startsWith('PUT /${BucketBackupTarget.key}?'),
        ),
        hasLength(2), // دو تکهٔ موفق
      );
      expect(partFails, 3); // یک تکه یک بار قطع شد و دوباره رفت
      expect(bucket.uploads, isEmpty);
      final db = dbArchive()!;
      expect(db.snapshot.count, 2);
      expect(db.content('payesh/big.bin'), big);
      expect(diskArchive()!.snapshot.fingerprint, db.snapshot.fingerprint);
    });

    test('ردیف ۱۶۶ (رایانهٔ مدرسه): تکه‌ها نرسید ⇒ بارگذاری لغو، فایل قبلی دیتابیس دست‌نخورده', () async {
      bucket.putText('payesh/a.json', 'A');
      expect((await eng.run()).ok, isTrue);
      final before = bucket.objects[BucketBackupTarget.key];
      final rnd = Random(7);
      bucket.objects['payesh/big.bin'] = Uint8List.fromList(
        List<int>.generate(s3PartBytes + 1000, (_) => rnd.nextInt(256)),
      );
      bucket.modified['payesh/big.bin'] = clock;
      clock = clock.add(OwnerBackupEngine.dbEvery);
      bucket.failWhen = (m, k) => m == 'PUT' && k == BucketBackupTarget.key;
      final r = await eng.run();
      expect(r.ok, isFalse);
      expect(bucket.uploads, isEmpty); // لغو شد
      expect(bucket.objects[BucketBackupTarget.key], before);
      // دیسک همان دور نوشته شد
      expect(diskArchive()!.snapshot.count, 2);
      bucket.failWhen = null;
      final r2 = await eng.run();
      expect(r2.ok, isTrue, reason: r2.error);
      expect(dbArchive()!.snapshot.count, 2);
    });

    test(
      'زمان‌بندی: start فقط وقتی کلید خودکار روشن است اجرا می‌کند',
      () async {
        bucket.putText('payesh/a.json', 'A');
        eng.start(
          interval: const Duration(milliseconds: 40),
          firstAfter: const Duration(milliseconds: 5),
        );
        eng.start(); // دوباره بی‌اثر
        await Future<void>.delayed(const Duration(milliseconds: 120));
        expect(diskArchive()!.snapshot.count, 1);
        await eng.setAuto(false);
        bucket.putText('payesh/b.json', 'B');
        clock = clock.add(const Duration(minutes: 1));
        await Future<void>.delayed(const Duration(milliseconds: 120));
        expect(diskArchive()!.snapshot.count, 1);
      },
    );

    test('منو: «پشتیبان دیتابیس» در گروه سیستم و فقط وقتی هست', () {
      expect(ownerMenuGroups.firstWhere((g) => g.id == 'system').pages, [
        'reports',
        'audit',
        'backup',
        'settings',
      ]);
      expect(localPageTitles['backup'], 'پشتیبان دیتابیس');
      expect(ownerMenuIcons['backup'], isNotNull);
      expect([for (final m in ownerMenu()) m.id], isNot(contains('backup')));
      expect([
        for (final m in ownerMenu(local: {'backup'})) m.id,
      ], contains('backup'));
      expect(backupSizeFa(10), '${faNumber(10)} بایت');
      expect(backupSizeFa(2048), '${faNumber(2)} کیلوبایت');
      expect(backupSizeFa(3 << 20), contains('مگابایت'));
    });

    testWidgets(
      'صفحه: یک فایل روی هر مقصد، پشتیبان‌گیری اکنون، بازیابی و حذف با تأیید',
      (tester) async {
        tester.view.physicalSize = const Size(900, 1800);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        bucket.putText('payesh/schools/registry.json', 'R');
        Widget app() => MaterialApp(
          theme: PayeshUi.light(look: PayeshLook.nabd),
          home: Directionality(
            textDirection: TextDirection.rtl,
            child: Scaffold(body: BackupView(engine: eng)),
          ),
        );
        Future<void> settle() async {
          for (var i = 0; i < 100 && eng.running; i++) {
            await tester.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 20)),
            );
          }
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 60)),
          );
          await tester.pump();
        }

        await tester.pumpWidget(app());
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
        await tester.pump();
        expect(find.byKey(const Key('backup-empty')), findsOneWidget);
        expect(
          tester
              .widget<StatusBadge>(find.byKey(const Key('backup-status')))
              .label,
          'منتظر',
        );
        await tester.runAsync(() async {
          await tester.tap(find.byKey(const Key('backup-run')));
          for (var i = 0; i < 40 && eng.files.length < 2; i++) {
            await Future<void>.delayed(const Duration(milliseconds: 20));
          }
        });
        await tester.pump();
        expect(find.byKey(const Key('backup-note')), findsOneWidget);
        expect(
          find.textContaining('تغییرها در فایل پشتیبان ادغام شد'),
          findsOneWidget,
        );
        // ردیف ۱۶۶: یک ردیف برای هر مقصد — نه فهرست پشتیبان‌ها
        expect(find.byKey(const Key('backup-file-disk')), findsOneWidget);
        expect(find.byKey(const Key('backup-file-db')), findsOneWidget);
        expect(
          find.textContaining('پشتیبان جامع روی دیسک این سیستم'),
          findsOneWidget,
        );
        expect(find.textContaining('۱ فایل دیتابیس'), findsNWidgets(2));

        // انصراف ⇒ هیچ
        await tester.tap(find.byKey(const Key('backup-restore-disk')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('backup-restore-cancel')));
        await tester.pumpAndSettle();
        expect(find.textContaining('بازیابی کامل شد'), findsNothing);

        bucket.putText('payesh/schools/registry.json', 'X');
        clock = clock.add(const Duration(minutes: 1));
        await tester.tap(find.byKey(const Key('backup-restore-disk')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('backup-restore-confirm')));
        for (
          var i = 0;
          i < 100 && find.textContaining('بازیابی کامل شد').evaluate().isEmpty;
          i++
        ) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 20)),
          );
          await tester.pump();
        }
        await settle();
        expect(bucket.text('payesh/schools/registry.json'), 'R');
        expect(find.textContaining('بازیابی کامل شد'), findsOneWidget);

        // حذف نسخهٔ دیتابیس: انصراف، بعد تأیید
        await tester.tap(find.byKey(const Key('backup-delete-db')));
        await tester.pumpAndSettle();
        expect(find.textContaining('از نو ساخته می‌شود'), findsOneWidget);
        await tester.tap(find.byKey(const Key('backup-delete-cancel')));
        await tester.pumpAndSettle();
        expect(bucket.keysUnder(bucketBackupRoot), hasLength(1));
        await tester.tap(find.byKey(const Key('backup-delete-db')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('backup-delete-confirm')));
        for (var i = 0; i < 50 && eng.files.length > 1; i++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 20)),
          );
        }
        await tester.pump();
        expect(bucket.keysUnder(bucketBackupRoot), isEmpty);
        expect(find.byKey(const Key('backup-file-db')), findsNothing);
        expect(find.byKey(const Key('backup-file-disk')), findsOneWidget);
        expect(find.text('پشتیبان «دیتابیس» حذف شد.'), findsOneWidget);

        // کلیدها
        await tester.runAsync(() async {
          await tester.tap(find.byKey(const Key('backup-db')));
          await Future<void>.delayed(const Duration(milliseconds: 20));
        });
        await tester.pump();
        expect(eng.dbOn, isFalse);
        await tester.runAsync(() async {
          await tester.tap(find.byKey(const Key('backup-auto')));
          await Future<void>.delayed(const Duration(milliseconds: 20));
        });
        await tester.pump();
        expect(eng.autoOn, isFalse);

        // دیتابیس قطع ⇒ پیام خطا
        bucket.down = true;
        await tester.runAsync(() async {
          await tester.tap(find.byKey(const Key('backup-run')));
          await Future<void>.delayed(const Duration(milliseconds: 80));
        });
        await tester.pump();
        expect(find.byKey(const Key('backup-error')), findsOneWidget);
        expect(
          tester
              .widget<StatusBadge>(find.byKey(const Key('backup-status')))
              .label,
          'خطا',
        );
        await tester.pumpWidget(const SizedBox());
      },
    );
  });
}
