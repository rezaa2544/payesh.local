// ردیف ۱۹۷-Q05 (F48/F43): DNS دستگاه نام سرور را نمی‌دهد (VPN همیشه‌روشن، مسیر direct بی‌DNS)
// ⇒ IP واقعی با DNS-over-HTTPS و اتصال به همان؛ سرور خاموش یا IP درست ⇒ DoH پرسیده نمی‌شود.
import 'dart:convert';
import 'dart:io';

import 'package:payesh_core/net.dart';
import 'package:test/test.dart';

void main() {
  late HttpServer server;
  setUp(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((r) {
      r.response
        ..write('school-ok ${r.headers.host}')
        ..close();
    });
  });
  tearDown(() => server.close(force: true));

  // اتصال جعلی: نام «school.example» در DNS دستگاه پیدا نمی‌شود (همان خطای اندروید)
  ({TcpConnect connect, List<String> calls}) net({
    Set<String> broken = const {'school.example'},
  }) {
    final calls = <String>[];
    Future<Socket> connect(String host, int port, Duration t) {
      calls.add(host);
      if (broken.contains(host)) {
        throw SocketException(
          "Failed host lookup: '$host' (OS Error: No address associated with hostname, errno = 7)",
        );
      }
      return Socket.connect(host, port, timeout: t);
    }

    return (connect: connect, calls: calls);
  }

  Future<String> get(HttpClient c, String host) async {
    final rq = await c.getUrl(
      Uri.parse('http://$host:${server.port}/api/health'),
    );
    final rs = await rq.close();
    return utf8.decodeStream(rs);
  }

  test(
    'DNS دستگاه شکست ⇒ DoH ⇒ همان سرور جواب می‌دهد (و Host همان نام می‌ماند)',
    () async {
      final n = net();
      var dohCalls = 0;
      final f = DnsFallback(
        connect: n.connect,
        lookup: (h) async => throw SocketException('Failed host lookup: $h'),
        doh: (h) async {
          dohCalls++;
          return (ips: [InternetAddress.loopbackIPv4], ttl: 120);
        },
      );
      final c = HttpClient();
      installDnsFallback(c, via: f);
      final body = await get(c, 'school.example');
      expect(body, startsWith('school-ok school.example'));
      expect(dohCalls, 1);
      expect(f.rescued, 1);
      expect(f.stickyFor('school.example'), [InternetAddress.loopbackIPv4]);
      // بار دوم (اتصال تازه): IP نگه‌داشته اول؛ DoH دوباره پرسیده نمی‌شود
      c.close(force: true);
      final c2 = HttpClient();
      installDnsFallback(c2, via: f);
      expect(await get(c2, 'school.example'), startsWith('school-ok'));
      expect(dohCalls, 1);
      expect(n.calls.last, '127.0.0.1');
      c2.close(force: true);
    },
  );

  test('کنترل منفی: بی‌راه نجات همان خطای «Failed host lookup» (برنامه آفلاین می‌ماند)', () async {
    final n = net();
    final f = DnsFallback(
      connect: n.connect,
      lookup: (h) async => throw SocketException('Failed host lookup: $h'),
      doh: (h) async => throw const SocketException('doh blocked'),
    );
    final c = HttpClient();
    installDnsFallback(c, via: f);
    await expectLater(
      get(c, 'school.example'),
      throwsA(predicate<Object>((e) => isLookupFailure(e))),
    );
    expect(f.rescued, 0);
    c.close(force: true);
  });

  test(
    'سرور واقعاً خاموش (IP درست، اتصال رد شد) ⇒ DoH پرسیده نمی‌شود',
    () async {
      final port = server.port;
      await server.close(force: true);
      var dohCalls = 0;
      final f = DnsFallback(
        lookup: (h) async => [InternetAddress.loopbackIPv4],
        doh: (h) async {
          dohCalls++;
          return (ips: [InternetAddress.loopbackIPv4], ttl: 60);
        },
        connect: (h, p, t) => Socket.connect(
          h == 'school.example' ? '127.0.0.1' : h,
          p,
          timeout: t,
        ),
      );
      final c = HttpClient();
      installDnsFallback(c, via: f);
      await expectLater(
        c
            .getUrl(Uri.parse('http://school.example:$port/'))
            .then((r) => r.close()),
        throwsA(isA<SocketException>()),
      );
      expect(dohCalls, 0);
      c.close(force: true);
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    },
  );

  test('IP جعلی تونل (198.18.x) و اتصال بریده ⇒ DoH و IP واقعی', () async {
    final calls = <String>[];
    final f = DnsFallback(
      lookup: (h) async => [InternetAddress('198.18.0.7')],
      doh: (h) async => (
        ips: [InternetAddress('198.18.0.9'), InternetAddress.loopbackIPv4],
        ttl: 30,
      ),
      connect: (h, p, t) {
        calls.add(h);
        if (h == 'relay.example') {
          throw const SocketException('Connection reset by peer');
        }
        return Socket.connect(h, p, timeout: t);
      },
    );
    final c = HttpClient();
    installDnsFallback(c, via: f);
    expect(
      await get(c, 'relay.example'),
      startsWith('school-ok relay.example'),
    );
    // IP جعلیِ پاسخ DoH هرگز امتحان نمی‌شود
    expect(calls, ['relay.example', '127.0.0.1']);
    c.close(force: true);
  });

  test('نشانی IP (شبکهٔ داخلی) ⇒ همان اتصال عادی، بی DoH', () async {
    var dohCalls = 0;
    final f = DnsFallback(
      doh: (h) async {
        dohCalls++;
        return (ips: <InternetAddress>[], ttl: 60);
      },
    );
    final c = HttpClient();
    installDnsFallback(c, via: f);
    expect(await get(c, '127.0.0.1'), startsWith('school-ok'));
    expect(dohCalls, 0);
    c.close(force: true);
  });

  test('پاسخ dns-json ⇒ فقط رکوردهای A و کمترین TTL', () {
    final r = parseDnsJson(
      jsonEncode({
        'Status': 0,
        'Answer': [
          {
            'name': 'x.trycloudflare.com',
            'type': 5,
            'TTL': 30,
            'data': 'cname.',
          },
          {'name': 'x', 'type': 1, 'TTL': 300, 'data': '104.16.230.132'},
          {'name': 'x', 'type': 1, 'TTL': 120, 'data': '104.16.231.132'},
          {'name': 'x', 'type': 28, 'TTL': 10, 'data': '2606:4700::1'},
        ],
      }),
    );
    expect(r.ips.map((a) => a.address), ['104.16.230.132', '104.16.231.132']);
    expect(r.ttl, 120);
    expect(parseDnsJson('{"Status":3}').ips, isEmpty);
    expect(isTunnelFakeIp(InternetAddress('198.19.255.1')), isTrue);
    expect(isTunnelFakeIp(InternetAddress('198.20.0.1')), isFalse);
  });
}
