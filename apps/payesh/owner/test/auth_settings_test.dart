import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/net/resilience.dart';
import 'package:payesh_owner/src/schools/login_methods_section.dart';
import 'package:payesh_owner/src/schools/school_registry.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'support/fake_bucket.dart';

/// ردیف ۱۶۰ — روش ورود اول کاربران و پنل پیامکِ کل سامانه (تنظیم مالک).
void main() {
  group('AuthSettings (قرارداد مشترک با server/sms.js)', () {
    test('بردارهای مشترک auth-vectors.json: همان خروجی settingsOf سرور', () {
      final v = jsonDecode(
        File('../../../docs/cloud/contracts/auth-vectors.json')
            .readAsStringSync(),
      ) as Map<String, Object?>;
      final cases = v['cases']! as List;
      expect(cases.length, greaterThanOrEqualTo(5));
      for (final c in cases.cast<Map<String, Object?>>()) {
        final a = AuthSettings.of({'auth': c['input']});
        expect(
          {
            'primary': a.primary,
            'sms_ready': a.smsReady,
            'enabled': a.enabled,
            'url': a.url,
            'method': a.method,
            'code_length': a.codeLength,
            'headers': a.headers.length,
          },
          c['expect'],
          reason: '${c['name']}',
        );
      }
    });

    test('پیش‌فرض: غیرفعال، صفحهٔ اول نام کاربری/رمز حتی با «شماره»', () {
      const a = AuthSettings(primary: 'mobile');
      expect(a.smsReady, isFalse);
      expect(a.effectivePrimary, 'password');
      final on = a.copyWith(enabled: true, url: 'https://x.test/s?c={code}');
      expect(on.effectivePrimary, 'mobile');
      expect(AuthSettings.of(null).message, defaultSmsMessage);
      final back = AuthSettings.of({'auth': on.toJson()});
      expect(back.toJson(), on.toJson());
    });

    test('ساخت درخواست: GET با رمزگذاری URL، POST JSON/فرم، سرآیند', () {
      final get =
          const AuthSettings(
            enabled: true,
            url: 'https://p.test/send?to={mobile98}&text={message}',
            message: 'کد {code}',
          ).buildRequest({
            'mobile': '09121234567',
            'mobile98': '989121234567',
            'code': '123456',
          });
      expect(get.method, 'GET');
      expect(get.body, isNull);
      expect(
        get.url,
        'https://p.test/send?to=989121234567&text=${Uri.encodeComponent('کد 123456')}',
      );

      final json = const AuthSettings(
        enabled: true,
        url: 'https://p.test/v',
        method: 'POST',
        headersText: 'x-api-key: K\nbad name: z',
        body: '{"m":"{mobile}","t":"{message}"}',
        message: 'a "b"\nc',
      ).buildRequest({'mobile': '09121234567', 'code': '1'});
      expect(json.headers, {
        'x-api-key': 'K',
        'content-type': 'application/json',
      });
      expect(jsonDecode(json.body!), {'m': '09121234567', 't': 'a "b"\nc'});

      final form = const AuthSettings(
        url: 'https://p.test/f',
        method: 'POST',
        headersText: 'Content-Type: text/plain',
        body: 'to={mobile}&msg={code}',
      ).buildRequest({'mobile': '09121234567', 'code': '12 34'});
      expect(form.body, 'to=09121234567&msg=12%2034');
      expect(form.headers, {'Content-Type': 'text/plain'});
    });

    test('ذخیره‌شدنی نیست: پیوند نامعتبر، روشن بی‌پیوند، بی {code}', () {
      expect(const AuthSettings().problem(rawUrl: 'ftp://x'), contains('http'));
      expect(
        const AuthSettings(enabled: true).problem(rawUrl: ''),
        contains('پیوند پنل'),
      );
      expect(
        const AuthSettings(
          enabled: true,
          url: 'https://p.test/s?to={mobile}',
          message: 'سلام',
        ).problem(rawUrl: 'https://p.test/s?to={mobile}'),
        contains('{code}'),
      );
      expect(
        const AuthSettings(
          enabled: true,
          url: 'https://p.test/s',
          method: 'POST',
          body: '{"to":"{mobile}"}',
        ).problem(rawUrl: 'https://p.test/s'),
        contains('{code}'),
      );
      expect(
        const AuthSettings(
          enabled: true,
          url: 'https://p.test/s?to={mobile}&t={message}',
        ).problem(rawUrl: 'https://p.test/s?to={mobile}&t={message}'),
        isNull,
      );
      expect(const AuthSettings().problem(rawUrl: ''), isNull);
    });

    test('پیامک آزمایشی: شمارهٔ فارسی، ok_match، خطای پنل', () async {
      final sent = <SmsRequest>[];
      const a = AuthSettings(
        enabled: true,
        url: 'https://p.test/s?to={mobile}&c={code}',
        okMatch: '"ok":true',
        codeLength: 5,
      );
      final ok = await a.sendTest(
        '۰۹۱۲ ۱۲۳ ۴۵۶۷',
        sender: (r) async {
          sent.add(r);
          return (200, '{"ok":true}');
        },
      );
      expect(ok, contains('09121234567'));
      expect(sent.single.url, 'https://p.test/s?to=09121234567&c=91111');
      await expectLater(
        a.sendTest('09121234567', sender: (_) async => (200, '{"ok":false}')),
        throwsA(
          isA<FormatException>().having(
            (e) => e.message,
            'msg',
            contains('در پاسخ نبود'),
          ),
        ),
      );
      await expectLater(
        a.sendTest('09121234567', sender: (_) async => (0, '')),
        throwsA(isA<FormatException>()),
      );
      await expectLater(
        a.sendTest('0912', sender: (_) async => (200, '')),
        throwsA(isA<FormatException>()),
      );
      expect(sent, hasLength(1));
    });

    test('ارسال واقعی با HttpClient: GET/POST به سرور محلی', () async {
      HttpOverrides.global = null;
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final seen = <String>[];
      server.listen((req) async {
        final body = await utf8.decoder.bind(req).join();
        seen.add('${req.method} ${req.uri} ${req.headers.value('x-k')} $body');
        req.response.statusCode = req.uri.path == '/bad' ? 500 : 200;
        req.response.write('OK-1');
        await req.response.close();
      });
      final base = 'http://127.0.0.1:${server.port}';
      final r = await defaultSmsSender(
        SmsRequest('$base/s?to=1', 'POST', const {'x-k': 'v'}, 'a=1'),
      );
      expect(r, (200, 'OK-1'));
      expect(
        (await defaultSmsSender(SmsRequest('$base/bad', 'GET', const {}, null)))
            .$1,
        500,
      );
      await server.close(force: true);
      expect(
        (await defaultSmsSender(SmsRequest('$base/x', 'GET', const {}, null)))
            .$1,
        0,
      );
      expect(seen.first, 'POST /s?to=1 v a=1');
    });
  });

  group('کارت تنظیمات «ورود کاربران و پنل پیامک»', () {
    const sk = 'SK-AUTH-TEST';
    late FakeBucket bucket;
    late SchoolRegistry reg;
    var clock = DateTime.utc(2026, 11, 15, 10);

    setUpAll(() => s3RetryPolicy = RetryPolicy.none);
    tearDownAll(() => s3RetryPolicy = const RetryPolicy());

    setUp(() async {
      EndpointRoutes.reset();
      clock = DateTime.utc(2026, 11, 15, 10);
      bucket = FakeBucket(() => clock);
      final secure = FakeSecureStore();
      await S3Settings(
        endpoint: Uri.https('s3.example.test'),
        accessKey: 'ak',
        secretKey: sk,
        bucket: 'payesh-madrese',
      ).save(secure);
      reg = SchoolRegistry(
        secure: secure,
        s3Factory: bucket.transport,
        now: () => clock,
        hashIterations: 1000,
      );
    });

    Future<Map<String, Object?>> inBucket() async => (await openSchools(
      sk,
      SchoolKinds.registry,
      bucket.text('payesh/${SchoolDirs.registry}')!,
    ))!.plain;

    Future<void> settle(WidgetTester tester) async {
      for (var i = 0; i < 6; i++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 30)),
        );
        await tester.pump(const Duration(milliseconds: 50));
      }
      await tester.pumpAndSettle();
    }

    Future<void> tap(WidgetTester tester, Finder f) async {
      await tester.ensureVisible(f);
      await tester.pumpAndSettle();
      await tester.tap(f);
      await settle(tester);
    }

    Future<void> type(WidgetTester tester, String key, String v) async {
      final f = find.byKey(Key(key));
      await tester.ensureVisible(f);
      await tester.enterText(f, v);
      await tester.pump();
    }

    String msg(WidgetTester tester) =>
        tester.widget<Text>(find.byKey(const Key('auth-msg'))).data!;

    Future<void> pump(WidgetTester tester, Widget child) async {
      tester.view.physicalSize = const Size(1400, 2600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          home: Directionality(
            textDirection: TextDirection.rtl,
            child: Scaffold(body: ListView(children: [child])),
          ),
        ),
      );
      await settle(tester);
    }

    testWidgets(
      'پیش‌فرض غیرفعال؛ روش اول، پیوند POST، ذخیره در plain.auth؛ آزمایشی',
      (tester) async {
        final sent = <SmsRequest>[];
        await pump(
          tester,
          LoginMethodsSection(
            registry: reg,
            sender: (r) async {
              sent.add(r);
              return (200, 'ok');
            },
          ),
        );
        expect(find.text('پیامک غیرفعال — به‌زودی'), findsOneWidget);

        // روشن بی‌پیوند ⇒ ذخیره نمی‌شود
        await tap(tester, find.byKey(const Key('auth-sms-enabled')));
        await tap(tester, find.byKey(const Key('auth-save')));
        expect(msg(tester), contains('پیوند پنل'));
        expect(bucket.text('payesh/${SchoolDirs.registry}'), isNull);

        await tap(tester, find.text('شمارهٔ همراه و کد پیامکی'));
        expect(find.textContaining('تا پنل پیامک وصل'), findsOneWidget);
        await tap(tester, find.text('POST'));
        await type(tester, 'auth-sms-url', 'https://api.sms.test/verify');
        await type(
          tester,
          'auth-sms-body',
          '{"mobile":"{mobile}","code":"{code}"}',
        );
        await type(tester, 'auth-sms-headers', 'x-api-key: KEY-1');
        await tap(tester, find.byKey(const Key('auth-sms-length')));
        await tap(tester, find.text('۵').last);

        await type(tester, 'auth-test-mobile', '09121234567');
        await tap(tester, find.byKey(const Key('auth-test')));
        expect(msg(tester), contains('فرستاده شد'));
        expect(sent.single.method, 'POST');
        expect(jsonDecode(sent.single.body!), {
          'mobile': '09121234567',
          'code': '91111',
        });
        expect(sent.single.headers['x-api-key'], 'KEY-1');

        await tap(tester, find.byKey(const Key('auth-save')));
        expect(msg(tester), contains('فعال می‌شود'));
        final auth = (await tester.runAsync(inBucket))!['auth']! as Map;
        expect(auth['primary'], 'mobile');
        final sms = auth['sms']! as Map;
        expect(sms['enabled'], isTrue);
        expect(sms['method'], 'POST');
        expect(sms['url'], 'https://api.sms.test/verify');
        expect(sms['code_length'], 5);
        expect(sms['headers'], 'x-api-key: KEY-1');
        expect(find.text('پیامک فعال است'), findsOneWidget);
        // سیاست اشتراک جداست: ذخیرهٔ آن auth را پاک نمی‌کند
        final v = await tester.runAsync(reg.load);
        await tester.runAsync(
          () => reg.saveSettings(v!.settings, domain: 'a.test'),
        );
        final again = (await tester.runAsync(inBucket))!;
        expect((again['auth']! as Map)['primary'], 'mobile');
        expect(again['domain'], 'a.test');
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('پیوند نامعتبر و فقط مشاهده', (tester) async {
      await pump(tester, LoginMethodsSection(registry: reg));
      await type(tester, 'auth-sms-url', 'ftp://x.test/a');
      await tap(tester, find.byKey(const Key('auth-save')));
      expect(msg(tester), contains('http'));
      await type(tester, 'auth-test-mobile', '09121234567');
      await tap(tester, find.byKey(const Key('auth-test')));
      expect(msg(tester), contains('http'));

      await pump(
        tester,
        LoginMethodsSection(
          key: const ValueKey('ro'),
          registry: reg,
          canManage: false,
        ),
      );
      expect(find.byKey(const Key('auth-save')), findsNothing);
      expect(find.byKey(const Key('auth-test')), findsNothing);
    });

    test('saveAuth بی دیتابیس ⇒ خطای روشن', () async {
      bucket.down = true;
      await expectLater(
        reg.saveAuth(
          const AuthSettings(enabled: true, url: 'https://p.test/s?c={code}'),
        ),
        throwsA(isA<SchoolsFailure>()),
      );
      await expectLater(
        reg.saveAuth(const AuthSettings(enabled: true)),
        throwsA(isA<SchoolsFailure>()),
      );
    });
  });
}
