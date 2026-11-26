import 'dart:async';

// ردیف ۱۹۱ — «همه‌چیز واقعی»: مصرف واقعی همین برنامه، سقف قطعی، توقفِ واقعی، ورود زودتر
// پردازش کمکی و مسیر مستقیم دیتابیس داخلی وقتی VPN روشن است.
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_core/io.dart';
import 'package:payesh_owner/src/helper/helper_service.dart';
import 'package:payesh_owner/src/helper/host_cpu.dart';
import 'package:payesh_owner/src/infra/load_route.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/monitor/net_meter.dart';
import 'package:payesh_owner/src/net/direct_route.dart';
import 'package:payesh_owner/src/power/activity.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'support/fake_bucket.dart';

void main() {
  group('مصرف واقعی همین برنامه', () {
    test('درصد = زمان CPU فرایند ÷ (زمان دیواری × هسته‌ها)', () {
      final cpu = [0, 400000, 400000 + 8 * 1000000];
      final wall = [0, 1000000, 2000000];
      var i = 0;
      var w = 0;
      final m = ProcessCpuMeter(
        read: () => cpu[i++],
        wallMicros: () => wall[w++],
        cores: 8,
      );
      expect(m.sample(), isNull, reason: 'نمونهٔ اول فقط نشانه است');
      // ۰٫۴ ثانیه CPU در ۱ ثانیه روی ۸ هسته = ۵٪ از کل رایانه (همان ستون Task Manager)
      expect(m.sample(), closeTo(5, 1e-9));
      // ۸ ثانیه CPU در ۱ ثانیه روی ۸ هسته = ۱۰۰٪ (سقف)
      expect(m.sample(), 100);
      expect(m.history, hasLength(2));
      expect(ProcessCpuMeter(read: () => null).sample(), isNull);
    });

    test('/proc/self/stat ⇒ utime+stime به میکروثانیه', () {
      const line =
          '4242 (payesh owner) S 1 2 3 4 5 6 7 8 9 10 150 50 0 0 20 0 1 0';
      expect(parseSelfStat(line), (150 + 50) * 10000);
      expect(parseSelfStat('bad'), isNull);
    });

    test('سقف قطعی: هر تغییر یک بار به سیستم‌عامل؛ بدون سقف ⇒ hard=false', () {
      final calls = <int?>[];
      final cap = CpuCap(
        apply: (p) {
          calls.add(p);
          return true;
        },
      );
      expect(cap.set(20), isTrue);
      expect(cap.set(20), isTrue);
      expect(calls, [20], reason: 'همان سقف دوباره فرستاده نمی‌شود');
      expect(cap.set(100), isFalse);
      expect(calls, [20, null], reason: '۱۰۰٪ یعنی بدون سقف');
      expect(cap.percent, isNull);
      final refused = CpuCap(apply: (_) => false);
      expect(refused.set(30), isFalse);
      expect(refused.hard, isFalse);
    });
  });

  group('سرویس پردازش کمکی', () {
    final t0 = DateTime.utc(2026, 11, 26, 9);

    Future<(OwnerHelperService, List<int?>)> make() async {
      final secure = FakeSecureStore();
      final bucket = FakeBucket(() => t0);
      await S3Settings(
        endpoint: Uri.https('s3.example.test'),
        accessKey: 'ak',
        secretKey: 'sk-191',
        bucket: 'payesh-madrese',
      ).save(secure);
      final calls = <int?>[];
      final svc = OwnerHelperService(
        secure: secure,
        transport: bucket.transport,
        now: () => t0,
        sleep: (_) async {},
        autoStart: false,
        cap: CpuCap(
          apply: (p) {
            calls.add(p);
            return true;
          },
        ),
      );
      await svc.init();
      return (svc, calls);
    }

    test('سقف «مقدار پردازش» همان لحظه سقف قطعی سیستم‌عامل می‌شود', () async {
      final (svc, calls) = await make();
      await svc.setLocalCpu(20);
      expect(svc.cap.percent, 20);
      expect(svc.cap.hard, isTrue);
      expect(calls.last, 20);
      await svc.setLocalCpu(100);
      expect(svc.cap.percent, isNull);
      expect(calls.last, isNull);
      await svc.dispose();
    });

    test(
      '«توقف» همین سیستم ⇒ همهٔ کارهای سنگین پس‌زمینه هم متوقف؛ کمک نمی‌کند',
      () async {
        final (svc, _) = await make();
        expect(svc.selfHelping, isTrue);
        await svc.setPaused(true);
        expect(svc.stopped, isTrue);
        expect(OwnerActivity.instance.processingPaused, isTrue);
        expect(svc.selfHelping, isFalse);
        await svc.setPaused(false);
        expect(OwnerActivity.instance.processingPaused, isFalse);
        expect(svc.selfHelping, isTrue);
        await svc.dispose();
      },
    );
  });

  group('ورود زودتر پردازش کمکی', () {
    setUp(NetMeter.reset);
    tearDown(NetMeter.reset);

    test(
      'p95 ۴۵۰ میلی‌ثانیه (هنوز سبز تا ۵۰۰) ⇒ سیستم کمکی وارد مدار می‌شود',
      () async {
        final clock = DateTime.now();
        for (var i = 0; i < 6; i++) {
          NetMeter.record(NetMeter.db, received: 10, elapsedMs: 450, at: clock);
        }
        final r = LoadRouter(
          policy: () => (mode: ArchModes.helpers, external: ''),
          helpersOnline: () async => 1,
          now: () => clock,
        );
        await r.tick();
        expect(r.db.p95, 450);
        expect(r.db.p95, lessThan(routeThresholds.loMs), reason: 'هنوز سبز');
        expect(r.state.helpersActive, isTrue);
        expect(routeReasonFa(r.state.reason), contains('پیش از رسیدن'));
        r.dispose();
      },
    );

    test('یک خطا در ده درخواست (۱۰٪) ⇒ پیش از قرمز (۲۰٪) کمک می‌آید', () async {
      final clock = DateTime.now();
      for (var i = 0; i < 9; i++) {
        NetMeter.record(NetMeter.db, received: 10, elapsedMs: 80, at: clock);
      }
      NetMeter.record(NetMeter.db, elapsedMs: 0, ok: false, at: clock);
      final r = LoadRouter(
        policy: () => (mode: ArchModes.helpers, external: ''),
        helpersOnline: () async => 1,
        now: () => clock,
      );
      await r.tick();
      expect(r.state.helpersActive, isTrue);
      r.dispose();
    });

    test('قرارداد سرور مدرسه (آستانه‌های پیش‌فرض) دست نخورده است', () {
      expect(routeThresholds.hiMs, 1200);
      expect(routeThresholds.loMs, 500);
      expect(ownerRouteThresholds.hiMs, lessThan(routeThresholds.loMs));
    });
  });

  group('مسیر مستقیم دیتابیس داخلی', () {
    final fake = InternetAddress('198.18.5.37');
    final real = InternetAddress('185.143.233.121');
    final wifi = InternetAddress('192.168.1.120');
    final vbox = InternetAddress('192.168.56.1');
    final tunIp = InternetAddress('172.19.0.1');

    test('IP جعلی تونل و نام کارت‌های تونلی شناخته می‌شوند', () {
      expect(isFakeIp(fake), isTrue);
      expect(isFakeIp(real), isFalse);
      for (final n in [
        'tun0',
        'Tailscale',
        'Lantern',
        'wintun',
        'vEthernet (WSL)',
      ]) {
        expect(isTunnelIface(n), isTrue, reason: n);
      }
      for (final n in ['Wi-Fi', 'Ethernet', 'Ethernet 4']) {
        expect(isTunnelIface(n), isFalse, reason: n);
      }
      expect(usableSource(InternetAddress('100.101.1.2')), isFalse);
      expect(usableSource(InternetAddress('169.254.3.4')), isFalse);
      expect(usableSource(wifi), isTrue);
    });

    test('فقط دیتابیس داخلی (.ir)؛ هیچ سرویس خارجی', () {
      final r = DirectRoute(enabled: true);
      expect(r.eligible('s3.ir-central1.arvanstorage.ir'), isTrue);
      expect(r.eligible('s3.amazonaws.com'), isFalse);
      expect(r.eligible('185.143.233.121'), isFalse);
      expect(DirectRoute(enabled: false).eligible('a.ir'), isFalse);
    });

    test('VPN روشن ⇒ IP واقعی از DoH و اتصال با مبدأ کارت واقعی؛ کارت مجازیِ بی‌راه رد می‌شود', () async {
      final tries = <String>[];
      var dohCalls = 0;
      final r = DirectRoute(
        enabled: true,
        lookup: (_) async => [fake],
        interfaces: () async => [
          (name: 'tun0', address: tunIp),
          (name: 'Ethernet 4', address: vbox),
          (name: 'Wi-Fi', address: wifi),
        ],
        doh: (_) async {
          dohCalls++;
          return (ips: [real], ttl: 180);
        },
        connect: (ip, port, src, timeout) async {
          tries.add('${src?.address}>${ip.address}:$port');
          if (src == wifi) return _FakeSocket();
          throw const SocketException('no route');
        },
      );
      // اتصال اول: IP واقعی هنوز نیست ⇒ همین یک بار از راه VPN، گرفتن IP در پس‌زمینه
      expect(await r.openDirect('s3.ir-central1.arvanstorage.ir', 443), isNull);
      expect(r.mode, DirectMode.viaVpn);
      await r.resolving;
      expect(dohCalls, 1);
      final s = await r.openDirect('s3.ir-central1.arvanstorage.ir', 443);
      expect(s, isNotNull);
      expect(r.mode, DirectMode.direct);
      expect(r.sourceName, 'Wi-Fi');
      expect(tries, [
        '192.168.56.1>185.143.233.121:443',
        '192.168.1.120>185.143.233.121:443',
      ]);
      expect(tries.any((t) => t.startsWith('172.19.')), isFalse);
      // دفعهٔ بعد کارت خوب اول امتحان می‌شود
      tries.clear();
      await r.openDirect('s3.ir-central1.arvanstorage.ir', 443);
      expect(tries.first, startsWith('192.168.1.120>'));
      expect(dohCalls, 1, reason: 'IP واقعی تا پایان TTL نگه داشته می‌شود');
      expect(r.statusFa, contains('Wi-Fi'));
    });

    test(
      'VPN خاموش (IP واقعی از DNS سیستم، بی‌کارت تونلی) ⇒ همان مسیر عادی',
      () async {
        var connects = 0;
        final r = DirectRoute(
          enabled: true,
          lookup: (_) async => [real],
          interfaces: () async => [(name: 'Wi-Fi', address: wifi)],
          doh: (_) async => (ips: [real], ttl: 60),
          connect: (ip, port, src, timeout) async {
            connects++;
            return _FakeSocket();
          },
        );
        expect(
          await r.openDirect('s3.ir-central1.arvanstorage.ir', 443),
          isNull,
        );
        expect(r.mode, DirectMode.normal);
        expect(connects, 0);
      },
    );

    test('مسیر مستقیم نشد ⇒ از راه VPN و ۲ دقیقه بعد دوباره', () async {
      var now = DateTime.utc(2026, 11, 26, 10);
      var connects = 0;
      final r = DirectRoute(
        enabled: true,
        now: () => now,
        lookup: (_) async => [fake],
        interfaces: () async => [(name: 'Wi-Fi', address: wifi)],
        doh: (_) async => (ips: [real], ttl: 600),
        connect: (ip, port, src, timeout) async {
          connects++;
          throw const SocketException('blocked');
        },
      );
      await r.openDirect('a.arvanstorage.ir', 443);
      await r.resolving;
      expect(await r.openDirect('a.arvanstorage.ir', 443), isNull);
      expect(r.mode, DirectMode.viaVpn);
      expect(connects, 1);
      await r.openDirect('a.arvanstorage.ir', 443);
      expect(connects, 1, reason: 'تا ۲ دقیقه دوباره امتحان نمی‌شود');
      now = now.add(const Duration(minutes: 3));
      await r.openDirect('a.arvanstorage.ir', 443);
      expect(connects, 2);
    });

    test('رسیدن IP واقعی ⇒ مخزن اتصال‌ها خبر می‌گیرد (اتصال keep-alive ِ VPN تا ابد نمی‌ماند)', () async {
      var recycles = 0;
      final r = DirectRoute(
        enabled: true,
        lookup: (_) async => [fake],
        interfaces: () async => [(name: 'Wi-Fi', address: wifi)],
        doh: (_) async => (ips: [real], ttl: 300),
        connect: (ip, port, src, timeout) async => _FakeSocket(),
      )..onRouteChange(() => recycles++);
      expect(await r.openDirect('s3.ir-central1.arvanstorage.ir', 443), isNull);
      expect(r.mode, DirectMode.viaVpn);
      await r.resolving;
      expect(recycles, 1);
      expect(
        await r.openDirect('s3.ir-central1.arvanstorage.ir', 443),
        isNotNull,
      );
      expect(r.mode, DirectMode.direct);
      expect(recycles, 1, reason: 'فقط یک بار، نه با هر اتصال');
    });

    test(
      'کارت مجازیِ کند جلوی Wi-Fi را نمی‌گیرد (هم‌زمان امتحان می‌شوند)',
      () async {
        final slow = Completer<Socket>();
        final r = DirectRoute(
          enabled: true,
          lookup: (_) async => [fake],
          interfaces: () async => [
            (name: 'Ethernet 4', address: vbox),
            (name: 'Wi-Fi', address: wifi),
          ],
          doh: (_) async => (ips: [real], ttl: 300),
          connect: (ip, port, src, timeout) =>
              src == vbox ? slow.future : Future.value(_FakeSocket()),
        );
        await r.openDirect('s3.ir-central1.arvanstorage.ir', 443);
        await r.resolving;
        final s = await r
            .openDirect('s3.ir-central1.arvanstorage.ir', 443)
            .timeout(const Duration(milliseconds: 500));
        expect(s, isNotNull);
        expect(r.sourceName, 'Wi-Fi');
        slow.completeError(const SocketException('timeout'));
      },
    );

    test('پاسخ dns-json ⇒ نشانی‌های A و کمترین TTL', () {
      final r = parseDohJson(
        '{"Status":0,"Answer":[{"name":"x","type":5,"TTL":30,"data":"y."},'
        '{"name":"x","type":1,"TTL":180,"data":"185.143.233.121"},'
        '{"name":"x","type":1,"TTL":120,"data":"185.143.234.121"}]}',
      );
      expect(r.ips.map((a) => a.address), [
        '185.143.233.121',
        '185.143.234.121',
      ]);
      expect(r.ttl, 120);
      expect(parseDohJson('{"Status":3}').ips, isEmpty);
    });
  });
}

class _FakeSocket implements Socket {
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}
