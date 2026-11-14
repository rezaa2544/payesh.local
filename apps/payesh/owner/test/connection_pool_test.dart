// ردیف ۱۵۹: ریشهٔ «وضعیت بحرانی بدون هیچ کاربری» — هر کار پس‌زمینه اتصال TCP+TLS تازه
// می‌ساخت (حدود ۳۵ دست‌دهی در دقیقه روی دستگاه مالک). این آزمون‌ها رفتار درست را قفل می‌کنند:
// کارهای پشت‌سرهم با IoS3Transportهای جدا، همه روی یک اتصال keep-alive.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/local/s3_client.dart';

void main() {
  late HttpServer server;
  final ports = <int>{};
  var hits = 0;
  HttpOverrides? prev;

  setUp(() async {
    prev = HttpOverrides.current;
    HttpOverrides.global = null; // flutter_test HttpClient را جعلی می‌کند
    S3ConnectionPool.closeAll();
    ports.clear();
    hits = 0;
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      hits++;
      ports.add(req.connectionInfo!.remotePort);
      req.response
        ..statusCode = 200
        ..write('<ListBucketResult></ListBucketResult>');
      await req.response.close();
    });
  });

  tearDown(() async {
    S3ConnectionPool.closeAll();
    await server.close(force: true);
    HttpOverrides.global = prev;
  });

  S3Settings settings() => S3Settings(
    endpoint: Uri(scheme: 'http', host: '127.0.0.1', port: server.port),
    accessKey: 'AKID',
    secretKey: 'SECRET',
    bucket: 'b',
  );

  test('۱۰ کار پشت‌سرهم، هر کدام با انتقال تازه ⇒ فقط یک اتصال', () async {
    final s = settings();
    for (var i = 0; i < 10; i++) {
      final t = IoS3Transport(); // همان الگوی helper_node/infra_policy/…
      try {
        final r = await s3Request(
          s,
          t,
          path: '/b',
          query: const {'list-type': '2', 'max-keys': '1'},
        );
        expect(r.status, 200);
      } finally {
        t.close(); // فقط رها کردن؛ اتصال برای کار بعدی می‌ماند
      }
    }
    expect(hits, 10);
    expect(ports, hasLength(1), reason: 'هر کار نباید دست‌دهی تازه بسازد');
  });

  test('انتقال‌های با مهلت متفاوت (پشتیبان‌گیری) همان مخزن را دارند', () async {
    final s = settings();
    for (final t in [
      IoS3Transport(),
      IoS3Transport(timeout: const Duration(minutes: 5), maxBytes: 1 << 20),
      IoS3Transport(timeout: const Duration(seconds: 30)),
    ]) {
      await s3Request(s, t, path: '/b');
      t.close();
    }
    expect(ports, hasLength(1));
  });

  test('reset پس از خطای شبکه ⇒ اتصال تازه، بدون قطع کار دیگران', () async {
    final s = settings();
    final a = IoS3Transport();
    final b = IoS3Transport();
    await s3Request(s, a, path: '/b');
    final inflight = s3Request(s, b, path: '/b');
    a.reset();
    expect((await inflight).status, 200);
    await s3Request(s, a, path: '/b');
    expect(ports.length, greaterThanOrEqualTo(2));
    a.close();
    b.close();
  });

  test('مهلت بیکاری: کمتر از keep-alive آروان (۶۵ ثانیه) و نه ۵ ثانیه', () {
    expect(S3ConnectionPool.idle, lessThan(const Duration(seconds: 65)));
    // سنجش داشبورد هر ۵ ثانیه است؛ اتصال باید بین دو سنجش باز بماند
    expect(
      S3ConnectionPool.idle,
      greaterThanOrEqualTo(const Duration(seconds: 30)),
    );
  });

  test('زمینهٔ اعتماد پیش‌فرض یک بار ساخته می‌شود', () {
    expect(identical(ownerTrustContext(), ownerTrustContext()), isTrue);
    expect(
      identical(
        ownerTrustContext(withTrustedRoots: false),
        ownerTrustContext(withTrustedRoots: false),
      ),
      isFalse,
    );
  });

  test('اعتماد سفارشی ⇒ اتصال خصوصی که با close بسته می‌شود', () async {
    final t = IoS3Transport(context: SecurityContext(withTrustedRoots: false));
    await s3Request(settings(), t, path: '/b');
    t.close();
    await expectLater(
      t.send('GET', Uri.parse('http://127.0.0.1:${server.port}/b'), const {}),
      throwsA(anything),
    );
  });
}
