import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/helper/helper_box.dart';
import 'package:payesh_owner/src/helper/helper_jobs.dart';
import 'package:payesh_owner/src/helper/helper_node.dart';
import 'package:payesh_owner/src/helper/helper_service.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'support/fake_bucket.dart';

/// سرور کمکی (ADR 126 §۱۱): قرارداد مشترک با server/helper-jobs.js، رزرو، جایگزینی محلی.
void main() {
  final vectors = jsonDecode(
    File('../../../docs/cloud/contracts/helper-jobs-vectors.json')
        .readAsStringSync(),
  ) as Map<String, Object?>;

  List<int> hex(String h) => [
    for (var i = 0; i < h.length; i += 2)
      int.parse(h.substring(i, i + 2), radix: 16),
  ];

  group('قرارداد (همان بایت‌های Node)', () {
    final cases = vectors['cases']! as Map<String, Object?>;
    final kinds = vectors['kinds']! as Map<String, Object?>;
    for (final name in cases.keys) {
      test('پاکت $name', () async {
        final c = cases[name]! as Map<String, Object?>;
        final plain =
            jsonDecode(c['plaintext']! as String) as Map<String, Object?>;
        final sealed = await sealHelper(
          vectors['secret']! as String,
          kinds[name]! as String,
          vectors['rev']! as int,
          plain,
          nonce: hex(vectors['nonce_hex']! as String),
        );
        expect(jsonDecode(sealed), c['envelope']);
        final back = await openHelper(
          vectors['secret']! as String,
          kinds[name]! as String,
          jsonEncode(c['envelope']),
        );
        expect(jsonEncode(back), c['plaintext']);
        // کلید دیگر یا نوع دیگر ⇒ رد
        expect(
          await openHelper('other-secret', kinds[name]! as String, sealed),
          isNull,
        );
        expect(
          await openHelper(vectors['secret']! as String, 'x', sealed),
          isNull,
        );
      });
    }

    test('ثابت‌ها و مسیرها', () {
      expect(kinds, {
        'presence': HelperKinds.presence,
        'request': HelperKinds.request,
        'lease': HelperKinds.lease,
        'result': HelperKinds.result,
      });
      expect(vectors['dirs'], {
        'helpers': HelperDirs.helpers,
        'req': HelperDirs.req,
        'lease': HelperDirs.lease,
        'res': HelperDirs.res,
      });
      expect(vectors['job_kinds'], jobKinds);
      expect(vectors['presence_fresh_ms'], presenceFresh.inMilliseconds);
      expect(vectors['claim_wait_ms'], claimWait.inMilliseconds);
      expect(vectors['gc_job_age_ms'], gcJobAge.inMilliseconds);
    });

    test('فقط نشانی عمومی (همان جدول سرور)', () {
      final t = vectors['public_ip']! as Map<String, Object?>;
      for (final e in t.entries) {
        expect(isPublicIp(e.key), e.value, reason: e.key);
      }
    });

    test('پارامترهای نامعتبر', () {
      expect(
        () => validJobParams('storage.usage', {'prefix': 'other/'}),
        throwsA(isA<JobRejected>()),
      );
      expect(
        () => validJobParams('object.verify', {'key': 'payesh/../x'}),
        throwsA(isA<JobRejected>()),
      );
      expect(
        () => validJobParams('endpoint.check', {'url': 'ftp://x'}),
        throwsA(isA<JobRejected>()),
      );
      expect(jobIdRe.hasMatch(newJobId(DateTime(2026, 11, 13))), isTrue);
      expect(defaultSlots(1), 1);
      expect(defaultSlots(8), 4);
      expect(defaultSlots(32), 4);
    });
  });

  group('صف کارها با چند سرور کمکی', () {
    late DateTime clock;
    late FakeBucket bucket;
    final s3 = S3Settings(
      endpoint: Uri.https('s3.example.test'),
      accessKey: 'ak',
      secretKey: 'sk-test',
      bucket: 'payesh-madrese',
    );

    setUp(() {
      clock = DateTime.utc(2026, 11, 13, 10);
      bucket = FakeBucket(() => clock);
      bucket.putText('payesh/schools/a/1.bin', 'x' * 100);
      bucket.putText('payesh/schools/a/2.bin', 'y' * 50);
    });

    JobExecutor exec() => JobExecutor(
      transport: bucket.transport,
      bigTransport: bucket.transport,
      now: () => clock,
      probe: (u) async => {'ok': true, 'status': 200, 'url': '$u'},
    );

    HelperNode node(String id) => HelperNode(
      helperId: id,
      transport: bucket.transport,
      executor: exec(),
      now: () => clock,
      sleep: (_) async {},
      host: 'PC-$id',
      version: 'test',
      slots: 2,
    )..configure(s3);

    Future<void> settle() async {
      for (var i = 0; i < 20; i++) {
        await Future<void>.delayed(Duration.zero);
      }
    }

    test(
      'بدون سرور کمکی ⇒ همین دستگاه انجام می‌دهد (پردازش متوقف نمی‌شود)',
      () async {
        final r = await submitJob(
          s3: s3,
          transport: bucket.transport,
          executor: exec(),
          kind: 'storage.usage',
          now: () => clock,
          sleep: (_) async {},
        );
        expect(r.ok, isTrue);
        expect(r.by, 'local');
        expect(r.why, 'no_helper');
        expect(r.result!['objects'], 2);
        expect(r.result!['bytes'], 150);
      },
    );

    test('سرور کمکیِ روشن کار را برمی‌دارد و نتیجه را می‌گذارد', () async {
      final b = node('b000000000000001');
      await b.tick(); // حضور
      expect(bucket.keysUnder('payesh/helpers/'), hasLength(1));
      final r = await submitJob(
        s3: s3,
        transport: bucket.transport,
        executor: exec(),
        kind: 'storage.usage',
        selfHelperId: 'a000000000000001',
        now: () => clock,
        sleep: (d) async {
          clock = clock.add(d);
          await b.tick();
          await settle();
        },
      );
      expect(r.ok, isTrue);
      expect(r.by, 'b000000000000001');
      expect(r.byHelper, isTrue);
      expect(r.result!['objects'], greaterThanOrEqualTo(2));
      expect(b.done, 1);
      expect(b.recent.single.ok, isTrue);
      // صف پاک شد
      expect(bucket.keysUnder('payesh/jobs/'), isEmpty);
    });

    test('دو سرور کمکی هم‌زمان: فقط یکی کار را انجام می‌دهد', () async {
      final b = node('b000000000000001');
      final c = node('c000000000000001');
      await Future.wait([b.tick(), c.tick()]);
      final r = await submitJob(
        s3: s3,
        transport: bucket.transport,
        executor: exec(),
        kind: 'storage.usage',
        now: () => clock,
        sleep: (d) async {
          clock = clock.add(d);
          await Future.wait([b.tick(), c.tick()]);
          await settle();
        },
      );
      expect(r.ok, isTrue);
      expect(r.byHelper, isTrue);
      expect(b.done + c.done, 1);
    });

    test('سرور کمکیِ متوقف (موقت) کاری نمی‌گیرد ⇒ محلی', () async {
      final b = node('b000000000000001');
      await b.setPaused(true);
      final hs = await readHelpers(s3, bucket.transport());
      expect(hs.single.paused, isTrue);
      final r = await submitJob(
        s3: s3,
        transport: bucket.transport,
        executor: exec(),
        kind: 'storage.usage',
        now: () => clock,
        sleep: (_) async {},
      );
      expect(r.why, 'no_helper');
      expect(b.done, 0);
    });

    test(
      'سرور کمکیِ ثبت‌شده که کار را برنمی‌دارد ⇒ ۲۰ ثانیه بعد محلی',
      () async {
        await node('b000000000000001').tick(); // حضور و بعد خاموش
        final r = await submitJob(
          s3: s3,
          transport: bucket.transport,
          executor: exec(),
          kind: 'storage.usage',
          now: () => clock,
          sleep: (d) async => clock = clock.add(d),
        );
        expect(r.ok, isTrue);
        expect(r.by, 'local');
        expect(r.why, 'not_claimed');
        expect(bucket.keysUnder('payesh/jobs/'), isEmpty);
      },
    );

    test('سرور کمکی وسط کار خاموش شد (رزرو منقضی) ⇒ محلی', () async {
      await node('b000000000000001').tick();
      var leased = false;
      final r = await submitJob(
        s3: s3,
        transport: bucket.transport,
        executor: exec(),
        kind: 'storage.usage',
        now: () => clock,
        sleep: (d) async {
          if (!leased) {
            leased = true;
            final id = nameOfKey(bucket.keysUnder('payesh/jobs/req/').single);
            bucket.putText(
              'payesh/jobs/lease/$id.json',
              await sealHelper(
                s3.secretKey,
                HelperKinds.lease,
                clock.millisecondsSinceEpoch,
                {
                  'v': 1,
                  'job_id': id,
                  'helper_id': 'b000000000000001',
                  'token': '00',
                  'until': clock.add(leaseFor).millisecondsSinceEpoch,
                },
              ),
            );
          }
          clock = clock.add(const Duration(seconds: 30));
        },
      );
      expect(r.by, 'local');
      expect(r.why, 'lease_expired');
      expect(r.ok, isTrue);
    });

    test('نتیجهٔ دستکاری‌شده یا با کلید دیگر پذیرفته نمی‌شود', () async {
      await node('b000000000000001').tick();
      final r = await submitJob(
        s3: s3,
        transport: bucket.transport,
        executor: exec(),
        kind: 'storage.usage',
        now: () => clock,
        sleep: (d) async {
          final id = nameOfKey(bucket.keysUnder('payesh/jobs/req/').single);
          bucket.putText(
            'payesh/jobs/res/$id.json',
            await sealHelper('attacker', HelperKinds.result, 1, {
              'v': 1,
              'job_id': id,
              'helper_id': 'evil',
              'ok': true,
              'result': {'objects': 999},
            }),
          );
          clock = clock.add(d);
        },
      );
      expect(r.by, 'local');
      expect(r.result!['objects'], isNot(999));
    });

    test(
      'دیتابیس در دسترس نیست ⇒ کار مستقل از دیتابیس روی همین دستگاه',
      () async {
        bucket.down = true;
        final r = await submitJob(
          s3: s3,
          transport: bucket.transport,
          executor: exec(),
          kind: 'endpoint.check',
          params: {'url': 'https://example.com/'},
          now: () => clock,
          sleep: (_) async {},
        );
        expect(r.ok, isTrue);
        expect(r.why, 'bucket_unreachable');
        expect(r.result!['status'], 200);
      },
    );

    test(
      'پاکسازی: کارهای کهنه، حضورهای قدیمی، آینهٔ کهنهٔ به‌روزرسانی',
      () async {
        final oldHelper = node('d000000000000001');
        clock = clock.subtract(const Duration(days: 8));
        await oldHelper.tick();
        clock = clock.add(const Duration(days: 8));
        await settle(); // gc خودکارِ همان چرخه تمام شود
        final old = clock.subtract(const Duration(hours: 2));
        final oldId = newJobId(old);
        final freshId = newJobId(clock);
        bucket
          ..putText('payesh/jobs/req/$oldId.json', '{}')
          ..putText('payesh/jobs/req/$freshId.json', '{}')
          ..putText('payesh/jobs/res/junk.json', '{}')
          ..putText(
            'payesh/updates/owner/old.gz',
            'z',
            at: clock.subtract(const Duration(days: 61)),
          )
          ..putText('payesh/updates/owner/new.gz', 'z');
        bucket.putText(
          'payesh/helpers/e000000000000001.json',
          await sealHelper('other-key', HelperKinds.presence, 1, {'v': 1}),
        );
        final r = await exec().gc(s3);
        expect(r, {
          'deleted_jobs': 2,
          'deleted_helpers': 1,
          'deleted_blobs': 1,
        });
        expect(bucket.objects.keys, contains('payesh/jobs/req/$freshId.json'));
        expect(bucket.objects.keys, contains('payesh/updates/owner/new.gz'));
        // پاکتِ کلید دیگر دست‌نخورده
        expect(
          bucket.objects.keys,
          contains('payesh/helpers/e000000000000001.json'),
        );
      },
    );

    test('بررسی یکپارچگی فایل (object.verify)', () async {
      final r = await exec().run(s3, 'object.verify', {
        'key': 'payesh/schools/a/2.bin',
        'size': 50,
      });
      expect(r['exists'], isTrue);
      expect(r['match'], isTrue);
      expect(r['size'], 50);
      final bad = await exec().run(s3, 'object.verify', {
        'key': 'payesh/schools/a/2.bin',
        'sha256': '0' * 64,
      });
      expect(bad['match'], isFalse);
      final missing = await exec().run(s3, 'object.verify', {
        'key': 'payesh/schools/a/none.bin',
      });
      expect(missing['exists'], isFalse);
    });
  });

  group(
    'بررسی Endpoint (فقط نشانی عمومی، بدون redirect، اتصال به همان IP)',
    () {
      test('نشانی خصوصی و DNS ناموفق رد می‌شوند', () async {
        expect(
          (await probeEndpoint(Uri.parse('http://127.0.0.1:9/')))['error'],
          'private_address',
        );
        expect(
          (await probeEndpoint(
            Uri.parse('https://intranet.example/'),
            lookup: (_) async => ['10.0.0.5'],
          ))['error'],
          'private_address',
        );
        expect(
          (await probeEndpoint(
            Uri.parse('https://mixed.example/'),
            lookup: (_) async => ['8.8.8.8', '192.168.1.1'],
          ))['error'],
          'private_address',
        );
        expect(
          (await probeEndpoint(
            Uri.parse('https://none.example/'),
            lookup: (_) async => throw const SocketException('nx'),
          ))['error'],
          'dns',
        );
      });

      test('اتصال به IP بررسی‌شده و redirect دنبال نمی‌شود', () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        final hosts = <String?>[];
        server.listen((r) {
          hosts.add(r.headers.host);
          r.response
            ..statusCode = 302
            ..headers.set('location', 'http://10.0.0.1/')
            ..close();
        });
        addTearDown(server.close);
        final r = await probeEndpoint(
          Uri.parse('http://school.example:${server.port}/'),
          lookup: (_) async => ['127.0.0.1'],
          allowPrivate: true,
        );
        expect(r['status'], 302);
        expect(r['reachable'], isTrue);
        expect(hosts, ['school.example']);
        final port = server.port;
        await server.close(force: true);
        final down = await probeEndpoint(
          Uri.parse('http://school.example:$port/'),
          lookup: (_) async => ['127.0.0.1'],
          allowPrivate: true,
          timeout: const Duration(seconds: 2),
        );
        expect(down['reachable'], isFalse);
      });
    },
  );

  group('سرویس سرور کمکی در برنامه', () {
    test('پیش‌فرض روشن، شناسهٔ پایدار، توقف موقت ماندگار', () async {
      final secure = FakeSecureStore();
      final clock = DateTime.utc(2026, 11, 13, 10);
      final bucket = FakeBucket(() => clock);
      await S3Settings(
        endpoint: Uri.https('s3.example.test'),
        accessKey: 'ak',
        secretKey: 'sk',
        bucket: 'payesh-madrese',
      ).save(secure);
      final a = OwnerHelperService(
        secure: secure,
        transport: bucket.transport,
        now: () => clock,
        sleep: (_) async {},
        autoStart: false,
        slots: 1,
      );
      await a.init();
      expect(a.node!.paused, isFalse); // پیش‌فرض: روشن
      expect(a.node!.configured, isTrue);
      final id = await secure.read(HelperKeys.id);
      expect(helperIdRe.hasMatch(id!), isTrue);
      await a.node!.tick();
      expect(bucket.objects.keys, contains('payesh/helpers/$id.json'));
      await a.setPaused(true);
      await a.dispose();

      final b = OwnerHelperService(
        secure: secure,
        transport: bucket.transport,
        autoStart: false,
      );
      await b.init();
      expect(b.node!.helperId, id);
      expect(b.node!.paused, isTrue);
      await b.setPaused(false);
      expect(await secure.read(HelperKeys.paused), isNull);
      await S3Settings.clear(secure);
      await b.reload();
      expect(b.node!.configured, isFalse);
      await b.dispose();
    });
  });
}
