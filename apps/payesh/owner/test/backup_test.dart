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

    test('ردیف ۱۶۲: پشتیبان اصلی + فقط تغییرها؛ رفت‌وبرگشت و بازسازی', () {
      BackupSnapshot snap(String id, Map<String, String> m) => BackupSnapshot(
        id: id,
        at: t0,
        bucket: 'b',
        objects: {
          for (final e in m.entries)
            e.key: (sha: e.value * 64, size: 5, modifiedMs: 1, etag: ''),
        },
      );
      final a = snap('20261114T100000Z', {'x': 'a', 'y': 'b', 'z': 'c'});
      final b = snap('20261114T101500Z', {'x': 'a', 'y': 'd', 'w': 'e'});
      final main = BackupRecord.main(a);
      final d = BackupRecord.delta(a, b);
      expect((main.isMain, main.changedCount, main.count), (true, 3, 3));
      expect((d.isMain, d.base), (false, a.id));
      expect(d.changed.keys.toSet(), {'y', 'w'});
      expect(d.removed, ['z']);
      expect(
        (d.count, d.bytes, d.changedBytes, d.fp),
        (3, 15, 10, b.fingerprint),
      );
      final back = BackupRecord.fromJson(jsonDecode(jsonEncode(d.toJson())))!;
      final full = back.applyTo(
        BackupRecord.fromJson(jsonDecode(jsonEncode(main.toJson())))!
            .applyTo(null),
      );
      expect(full.fingerprint, b.fingerprint);
      expect(full.objects.keys.toSet(), {'x', 'y', 'w'});
      // قالب ۱ (فهرست کامل) هم خوانده می‌شود و «قدیمی» علامت می‌خورد
      final legacy = BackupRecord.fromJson(jsonDecode(jsonEncode(a.toJson())))!;
      expect(
        (legacy.legacy, legacy.isMain, legacy.fp),
        (true, true, a.fingerprint),
      );
      for (final bad in <Object?>[
        {...d.toJson(), 'base': '20991231T000000Z'}, // پایه پس از خودش
        {...d.toJson(), 'base': '../x'},
        {...d.toJson(), 'fp': 'x'},
        {
          ...d.toJson(),
          'changed': {
            'k': ['zz', 1, 1],
          },
        },
        {...d.toJson(), 'v': 3},
      ]) {
        expect(BackupRecord.fromJson(bad), isNull);
      }
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
      final snap = (await readState(disk(), ids.single))!;
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
        final safety = (await readState(disk(), r.safety!))!;
        expect(safety.label, 'پیش از بازیابی');
        expect(
          safety.objects.keys,
          containsAll([
            'payesh/support/new.json',
            'payesh/schools/registry.json',
          ]),
        );
        // محتوای خراب روی دیسک ⇒ از نسخهٔ دیتابیس
        final sha = (await readState(
          disk(),
          first,
        ))!.objects['payesh/data/core.json']!.sha;
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

    test('ردیف ۱۶۲: هر دور فقط تغییرها روی دیسک و دیتابیس نوشته می‌شود — نه فهرست کامل', () async {
      for (var i = 0; i < 200; i++) {
        bucket.putText('payesh/data/person/$i.json', '{"id":$i}');
      }
      var r = await eng.run();
      expect((r.created, r.fetched, r.count), (true, 200, 200));
      final main = (await disk().listSnapshots()).single;
      final mainBytes = File('${dir.path}/snaps/$main.json').lengthSync();
      clock = clock.add(const Duration(minutes: 15));
      bucket
        ..putText('payesh/data/person/7.json', '{"id":7,"n":1}')
        ..putText('payesh/data/person/new.json', '{"id":"new"}');
      bucket.objects.remove('payesh/data/person/9.json');
      final gets = bucket.log.where((l) => l.startsWith('GET /payesh/')).length;
      r = await eng.run();
      expect((r.created, r.fetched, r.count), (true, 2, 200));
      expect(
        bucket.log.where((l) => l.startsWith('GET /payesh/')).length - gets,
        2,
        reason: 'فقط دو فایل تازه/تغییرکرده دانلود شد',
      );
      final ids = await disk().listSnapshots();
      expect(ids.length, 2);
      final rec = (await disk().getRecord(ids.last))!;
      expect(rec.base, main);
      expect(rec.changed.keys.toSet(), {
        'payesh/data/person/7.json',
        'payesh/data/person/new.json',
      });
      expect(rec.removed, ['payesh/data/person/9.json']);
      expect((rec.count, rec.isMain), (200, false));
      final deltaBytes = File('${dir.path}/snaps/${ids.last}.json')
          .lengthSync();
      expect(deltaBytes * 20, lessThan(mainBytes));
      // روی دیتابیس هم همان «تغییرها»
      final dbRec = (await BucketBackupTarget(
        S3Settings(
          endpoint: Uri.https('s3.example.test'),
          accessKey: 'ak',
          secretKey: 'sk',
          bucket: bucket.bucket,
        ),
        () => bucket.transport(),
      ).getRecord(ids.last))!;
      expect((dbRec.base, dbRec.changedCount), (main, 2));
      // وضع کامل همان لحظه بازسازی می‌شود و بازیابی نخستین لحظه هنوز کار می‌کند
      final full = (await readState(disk(), ids.last))!;
      expect(full.count, 200);
      expect(full.objects.containsKey('payesh/data/person/9.json'), isFalse);
      await eng.refresh();
      expect(eng.items.first.changed, 2);
      expect(eng.items.first.removed, 1);
      expect(eng.items.last.main, isTrue);
      expect(backupItemFa(eng.items.first), contains('۲ فایل تازه/تغییرکرده'));
      expect(backupItemFa(eng.items.first), contains('۱ فایل پاک‌شده'));
      expect(backupItemFa(eng.items.last), startsWith('پشتیبان اصلی'));
      clock = clock.add(const Duration(minutes: 1));
      final rr = await eng.restore(main);
      expect((rr.ok, rr.written), (true, 2));
      expect(bucket.text('payesh/data/person/7.json'), '{"id":7}');
      expect(bucket.text('payesh/data/person/9.json'), '{"id":9}');
    });

    test('ردیف ۱۶۲: فهرست‌های کامل قدیمی (قالب ۱) به یک پشتیبان اصلی + تغییرها فشرده می‌شوند و هیچ لحظه‌ای عوض نمی‌شود', () async {
      // سه فهرست کامل به قالب قدیمی، همان‌طور که نسخه‌های پیشین روی دیسک می‌نوشتند
      final legacy = <BackupSnapshot>[];
      final objs = <String, BackupEntry>{};
      for (var i = 0; i < 3; i++) {
        for (var k = 0; k < 50; k++) {
          final raw = utf8.encode(k == i ? 'changed $i' : 'v $k');
          final sha = sha256Hex(raw);
          if (k == i || i == 0) {
            objs['payesh/f$k.json'] = (
              sha: sha,
              size: raw.length,
              modifiedMs: i,
              etag: '',
            );
            await disk().putBlob(sha, raw);
          }
        }
        final at = clock.subtract(Duration(hours: 3 - i));
        final sn = BackupSnapshot(
          id: BackupSnapshot.idFor(at),
          at: at,
          bucket: bucket.bucket,
          objects: Map.of(objs),
        );
        legacy.add(sn);
        final fl = File('${dir.path}/snaps/${sn.id}.json')
          ..parent.createSync(recursive: true);
        fl.writeAsStringSync(jsonEncode(sn.toJson()));
      }
      final before = Directory('${dir.path}/snaps')
          .listSync()
          .whereType<File>()
          .fold<int>(0, (a, f) => a + f.lengthSync());
      await eng.setDb(false);
      bucket.putText('payesh/other.json', 'O');
      await eng.run(); // نخستین دور پس از به‌روزرسانی ⇒ فشرده‌سازی
      final ids = await disk().listSnapshots();
      expect(ids.take(3), [for (final l in legacy) l.id]);
      final recs = [for (final id in ids) (await disk().getRecord(id))!];
      expect(recs.first.isMain, isTrue);
      expect(recs.every((r) => !r.legacy), isTrue);
      for (var i = 1; i < recs.length; i++) {
        expect(recs[i].base, ids[i - 1]);
      }
      for (final l in legacy) {
        expect((await readState(disk(), l.id))!.fingerprint, l.fingerprint);
      }
      final after = Directory('${dir.path}/snaps')
          .listSync()
          .whereType<File>()
          .fold<int>(0, (a, f) => a + f.lengthSync());
      expect(after, lessThan(before));
    });

    test('ردیف ۱۶۲: پاک‌سازی دورهای کنار گذاشته را در دور بعد ادغام می‌کند؛ هر لحظهٔ نگه‌داشته همان می‌ماند', () async {
      final expected = <String, String>{};
      for (var d = 0; d < 6; d++) {
        for (var h = 0; h < 3; h++) {
          bucket.putText('payesh/k$h.json', 'd$d h$h');
          if (d == 2 && h == 1) bucket.objects.remove('payesh/k0.json');
          final r = await eng.run();
          if (r.snapshot != null) {
            expected[r.snapshot!] = (await readState(
              disk(),
              r.snapshot!,
            ))!.fingerprint;
          }
          clock = clock.add(const Duration(hours: 8));
        }
      }
      // روزهای قدیمی‌تر از ۴۸ ساعت تک‌فهرستی شده‌اند؛ بقیه دقیقاً همان وضع را دارند
      clock = clock.add(const Duration(days: 2));
      bucket.putText('payesh/last.json', 'L');
      await eng.run();
      final ids = await disk().listSnapshots();
      expect(ids.length, lessThan(expected.length));
      for (final id in ids) {
        if (expected.containsKey(id)) {
          expect(
            (await readState(disk(), id))!.fingerprint,
            expected[id],
            reason: id,
          );
        }
      }
      expect((await disk().getRecord(ids.first))!.isMain, isTrue);
      expect([
        for (final id in ids.skip(1)) (await disk().getRecord(id))!.isMain,
      ], everyElement(isFalse));
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
      expect(
        find.textContaining('تغییرها به پشتیبان اصلی افزوده شد'),
        findsOneWidget,
      );
      // ردیف ۱۶۲: نخستین ردیف «پشتیبان اصلی» است و خلاصهٔ بالا هم همان را می‌گوید
      expect(find.textContaining('پشتیبان اصلی — '), findsOneWidget);
      expect(find.byKey(const Key('backup-main')), findsOneWidget);
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
