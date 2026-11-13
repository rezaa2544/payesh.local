import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/backup/backup_engine.dart';
import 'package:payesh_owner/src/backup/backup_store.dart';
import 'package:payesh_owner/src/guard/guard_engine.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/menu.dart';
import 'package:payesh_owner/src/net/resilience.dart';
import 'package:payesh_owner/src/pages/backup_page.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'support/fake_bucket.dart';

/// ردیف ۱۵۵: پشتیبان کامل، خودکار و افزایشی دیتابیس مالک + بازیابی/انتقال یک‌کلیکی.
void main() {
  final t0 = DateTime.utc(2026, 11, 14, 10);

  group('قالب و نگه‌داری', () {
    test('شناسه، رفت‌وبرگشت JSON، فهرست خراب رد', () {
      expect(BackupSnapshot.idFor(t0), '20261114T100000Z');
      final s = BackupSnapshot(
        id: '20261114T100000Z',
        at: t0,
        bucket: 'b',
        label: 'پیش از بازیابی',
        objects: {
          'payesh/a.json': (sha: 'a' * 64, size: 3, modifiedMs: 1, etag: 'e1'),
          'payesh/b.json': (sha: 'b' * 64, size: 4, modifiedMs: 2, etag: ''),
        },
      );
      final back = BackupSnapshot.fromJson(jsonDecode(jsonEncode(s.toJson())))!;
      expect(back.count, 2);
      expect(back.bytes, 7);
      expect(back.label, 'پیش از بازیابی');
      expect(back.fingerprint, s.fingerprint);
      expect(back.objects['payesh/b.json']!.modifiedMs, 2);
      expect(back.objects['payesh/a.json']!.etag, 'e1');
      // فهرست قدیمیِ بدون ETag هم خوانده می‌شود
      final legacy = s.toJson();
      legacy['objects'] = {
        'k': ['c' * 64, 1, 1],
      };
      expect(BackupSnapshot.fromJson(legacy)!.objects['k']!.etag, '');
      for (final bad in <Object?>[
        null,
        {'v': 2},
        {...s.toJson(), 'id': '../x'},
        {
          ...s.toJson(),
          'objects': {
            'k': ['zz', 1, 1],
          },
        },
        {
          ...s.toJson(),
          'objects': {
            'k': [1],
          },
        },
      ]) {
        expect(BackupSnapshot.fromJson(bad), isNull);
      }
      expect(unpackBlob(packBlob(utf8.encode('سلام'))), utf8.encode('سلام'));
    });

    test('نگه‌داری: ۴۸ ساعت همه، سپس روزانه تا ۳۰ روز، ماهانه تا یک سال', () {
      final now = t0;
      String at(Duration ago) => BackupSnapshot.idFor(now.subtract(ago));
      final recent = [for (var h = 0; h < 48; h += 6) at(Duration(hours: h))];
      final d5a = at(const Duration(days: 5, hours: 2));
      final d5b = at(const Duration(days: 5, hours: 1));
      final m3a = at(const Duration(days: 92));
      final m3b = at(const Duration(days: 91));
      final old = at(const Duration(days: 400));
      final keep = backupKeep([...recent, d5a, d5b, m3a, m3b, old], now);
      expect(keep, containsAll(recent));
      expect(keep, contains(d5b));
      expect(keep, isNot(contains(d5a)));
      expect(keep, isNot(contains(old)));
      expect(keep.where((x) => x == m3a || x == m3b).length, 1);
      // تازه‌ترین همیشه می‌ماند، حتی اگر قدیمی باشد
      expect(backupKeep([old], now), {old});
      expect(backupKeep([], now), isEmpty);
    });
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
      );
    });
    tearDown(() {
      eng.dispose();
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });

    DirBackupTarget disk() => DirBackupTarget(dir);
    Iterable<String> dbSnaps() => bucket.keysUnder('${bucketBackupRoot}snaps/');

    test('افزایشی: فقط تغییرها خوانده می‌شود؛ بدون تغییر فهرست تازه نیست؛ دیسک + دیتابیس', () async {
      // صندوقچهٔ خالی ⇒ هیچ فهرستی
      var r = await eng.run();
      expect((r.ok, r.created, r.count), (true, false, 0));
      expect(await disk().listSnapshots(), isEmpty);

      bucket
        ..putText('payesh/schools/registry.json', '{"v":1}')
        ..putText('payesh/data/core.json', '{"a":1}')
        ..putText('payesh/data/copy.json', '{"a":1}')
        ..putText('payesh/updates/owner.zip', 'ZIP');
      r = await eng.run();
      expect(r.ok, isTrue);
      expect(r.created, isTrue);
      expect((r.count, r.fetched), (4, 4));
      final ids = await disk().listSnapshots();
      expect(ids.length, 1);
      final snap = (await disk().getSnapshot(ids.single))!;
      expect(snap.bucket, 'payesh-madrese');
      expect(snap.objects.keys, contains('payesh/updates/owner.zip'));
      // محتوای یکسان یک بار
      expect(
        snap.objects['payesh/data/core.json']!.sha,
        snap.objects['payesh/data/copy.json']!.sha,
      );
      expect(
        bucket.keysUnder('${bucketBackupRoot}blobs/').length,
        3,
        reason: 'روی دیتابیس هم',
      );
      expect(dbSnaps().length, 1);
      expect(eng.lastSnapshot, ids.single);
      expect(eng.lastError, isNull);

      // بدون تغییر ⇒ هیچ خواندن و هیچ فهرست تازه‌ای؛ پیشوند پشتیبان خودش در فهرست نیست
      clock = clock.add(const Duration(minutes: 15));
      final gets = bucket.log.where((l) => l.startsWith('GET /payesh/')).length;
      r = await eng.run();
      expect((r.ok, r.created, r.fetched), (true, false, 0));
      expect(
        bucket.log.where((l) => l.startsWith('GET /payesh/')).length,
        gets,
      );
      expect(await disk().listSnapshots(), hasLength(1));

      // یک تغییر ⇒ فقط همان
      clock = clock.add(const Duration(minutes: 15));
      bucket.putText('payesh/schools/registry.json', '{"v":1,"n":2}');
      bucket.objects.remove('payesh/data/copy.json');
      r = await eng.run();
      expect((r.created, r.fetched, r.count), (true, 1, 3));
      expect(await disk().listSnapshots(), hasLength(2));
      expect(dbSnaps().length, 2);

      // تغییرِ هم‌اندازه در همان ثانیه ⇒ با ETag دیده می‌شود
      bucket.putText('payesh/data/core.json', '{"a":9}', at: clock);
      r = await eng.run();
      expect((r.created, r.fetched), (true, 1));
      expect(await disk().listSnapshots(), hasLength(3));
      bucket.putText('payesh/data/core.json', '{"a":1}', at: clock);
      r = await eng.run();
      expect(r.fetched, 1);

      // دیتابیس خاموش ⇒ فقط دیسک
      await eng.setDb(false);
      expect(eng.dbOn, isFalse);
      clock = clock.add(const Duration(minutes: 15));
      bucket.putText('payesh/data/core.json', '{"a":2}');
      r = await eng.run();
      expect(r.created, isTrue);
      expect(await disk().listSnapshots(), hasLength(5));
      expect(dbSnaps().length, 4);
      // کلیدها ماندگارند
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
      expect(eng.items.length, 5);
      expect(eng.items.first.targets, {'disk'});
      expect(eng.items.last.targets, {'disk'});
      expect(eng.usage['disk'], greaterThan(0));
    });

    test(
      'بازیابی یک‌کلیکی: پیش از بازیابی پشتیبان؛ فایل تازه‌تر دست نمی‌خورد',
      () async {
        bucket
          ..putText('payesh/schools/registry.json', 'R1')
          ..putText('payesh/data/core.json', 'C1');
        await eng.run();
        final first = (await disk().listSnapshots()).single;
        clock = clock.add(const Duration(minutes: 15));
        bucket
          ..putText('payesh/schools/registry.json', 'R2-خراب')
          ..putText('payesh/support/new.json', 'N');
        bucket.objects.remove('payesh/data/core.json');
        final r = await eng.restore(first);
        expect(r.ok, isTrue);
        expect((r.written, r.same, r.failed, r.newer), (2, 0, 0, 1));
        expect(bucket.text('payesh/schools/registry.json'), 'R1');
        expect(bucket.text('payesh/data/core.json'), 'C1');
        expect(bucket.text('payesh/support/new.json'), 'N');
        final safety = (await disk().getSnapshot(r.safety!))!;
        expect(safety.label, 'پیش از بازیابی');
        expect(
          safety.objects.keys,
          containsAll([
            'payesh/support/new.json',
            'payesh/schools/registry.json',
          ]),
        );
        // محتوای خراب روی دیسک ⇒ از نسخهٔ دیتابیس
        final sha = (await disk().getSnapshot(first))!
            .objects['payesh/data/core.json']!
            .sha;
        File('${dir.path}/blobs/${sha.substring(0, 2)}/$sha.gz')
            .writeAsBytesSync([1, 2, 3]);
        bucket.objects.remove('payesh/data/core.json');
        clock = clock.add(const Duration(minutes: 1));
        final r2 = await eng.restore(first);
        expect(r2.ok, isTrue);
        expect(bucket.text('payesh/data/core.json'), 'C1');
        expect(r2.same, 1);
        expect(
          (await eng.restore('20990101T000000Z')).error,
          contains('پیدا نشد'),
        );
      },
    );

    test(
      'انتقال به دیتابیس تازه: صندوقچهٔ خالی جای پشتیبان را نمی‌گیرد',
      () async {
        bucket
          ..putText('payesh/schools/registry.json', 'R')
          ..putText('payesh/data/person/1.json', 'P');
        await eng.run();
        final id = (await disk().listSnapshots()).single;
        // دیتابیس تازه (صندوقچهٔ دیگر)
        final fresh = FakeBucket(() => clock, bucket: 'payesh-new');
        bucket = fresh;
        await useBucket(fresh);
        clock = clock.add(const Duration(minutes: 15));
        final r0 = await eng.run();
        expect((r0.ok, r0.count, r0.created), (true, 0, false));
        expect(await disk().listSnapshots(), [id]);
        final r = await eng.restore(id);
        expect(r.ok, isTrue);
        expect(r.written, 2);
        expect(fresh.text('payesh/schools/registry.json'), 'R');
        expect(fresh.text('payesh/data/person/1.json'), 'P');
      },
    );

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
        expect(
          (await eng.restore('20261114T100000Z')).error,
          contains('تنظیمات'),
        );
        final none = OwnerBackupEngine(
          secure: secure,
          s3Factory: () => bucket.transport(),
        );
        expect((await none.run()).error, contains('تنظیمات'));
        none.dispose();
      },
    );

    test('پاک‌سازی روزانه: فهرست‌های قدیمی و محتوای بی‌مرجع', () async {
      for (var d = 0; d < 40; d++) {
        bucket.putText('payesh/day.json', 'day $d');
        await eng.run();
        clock = clock.add(const Duration(days: 1, minutes: 1));
      }
      final ids = await disk().listSnapshots();
      expect(ids.length, lessThan(40));
      expect(ids.length, greaterThan(25));
      final blobs = Directory('${dir.path}/blobs')
          .listSync(recursive: true)
          .whereType<File>()
          .length;
      expect(blobs, ids.length);
      expect(dbSnaps().length, ids.length);
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
        expect(await disk().listSnapshots(), hasLength(1));
        await eng.setAuto(false);
        bucket.putText('payesh/a.json', 'B');
        clock = clock.add(const Duration(minutes: 1));
        await Future<void>.delayed(const Duration(milliseconds: 120));
        expect(await disk().listSnapshots(), hasLength(1));
      },
    );

    test('منو: «پشتیبان دیتابیس» در گروه سیستم و فقط وقتی هست', () {
      expect(ownerMenuGroups.firstWhere((g) => g.id == 'system').pages, [
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

    testWidgets('صفحه: کلیدها، پشتیبان‌گیری اکنون، بازیابی با تأیید', (
      tester,
    ) async {
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
        for (var i = 0; i < 20 && eng.items.isEmpty; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 20));
        }
      });
      await tester.pump();
      expect(find.byKey(const Key('backup-note')), findsOneWidget);
      expect(find.textContaining('پشتیبان ساخته شد'), findsOneWidget);
      final id = eng.items.single.id;
      expect(find.byKey(Key('backup-item-$id')), findsOneWidget);
      expect(find.textContaining('دیسک این سیستم + دیتابیس'), findsOneWidget);
      expect(find.byKey(const Key('backup-usage-disk')), findsOneWidget);

      // انصراف ⇒ هیچ
      await tester.tap(find.byKey(Key('backup-restore-$id')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('backup-restore-cancel')));
      await tester.pumpAndSettle();
      expect(find.textContaining('بازیابی کامل شد'), findsNothing);

      bucket.putText('payesh/schools/registry.json', 'X');
      clock = clock.add(const Duration(minutes: 1));
      await tester.tap(find.byKey(Key('backup-restore-$id')));
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
      // پشتیبانِ پس از بازیابی تمام شود
      for (var i = 0; i < 100 && eng.running; i++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 20)),
        );
        await tester.pump();
      }
      expect(bucket.text('payesh/schools/registry.json'), 'R');
      expect(find.textContaining('بازیابی کامل شد'), findsOneWidget);

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
    });
  });
}
