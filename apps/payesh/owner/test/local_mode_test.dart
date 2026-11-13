import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/app.dart';
import 'package:payesh_owner/src/local/cloud_control.dart';
import 'package:payesh_owner/src/local/local_account.dart';
import 'package:payesh_owner/src/local/local_platform.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/platform.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'support/fake_backend.dart';

/// ورود محلی بدون اینترنت + تنظیم دیتابیس (S3 آروان) در پنل مالک.

const _bucketsXml =
    '<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult><Owner><ID>x</ID></Owner>'
    '<Buckets><Bucket><Name>payesh-main</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>'
    '<Bucket><Name>payesh-backup</Name><CreationDate>2026-01-02T00:00:00.000Z</CreationDate></Bucket>'
    '</Buckets></ListAllMyBucketsResult>';

String _err(String code, {String? region}) =>
    '<?xml version="1.0" encoding="UTF-8"?><Error><Code>$code</Code>'
    '${region == null ? '' : '<Region>$region</Region>'}</Error>';

/// پاسخ‌های از پیش تعیین‌شده؛ هر درخواست ثبت می‌شود.
final class FakeS3 implements S3Transport {
  FakeS3(this.replies);
  final List<Object> replies; // S3Response یا Exception
  final List<(Uri, Map<String, String>)> calls = [];
  final List<String> methods = [];
  final List<String?> bodies = [];
  int closed = 0;

  @override
  Future<S3Response> send(
    String method,
    Uri url,
    Map<String, String> headers, [
    List<int>? body,
  ]) async {
    calls.add((url, Map.of(headers)));
    methods.add(method);
    bodies.add(body == null ? null : utf8.decode(body));
    final r = replies.isEmpty ? const S3Response(500, '') : replies.removeAt(0);
    if (r is S3Response) return r;
    throw r;
  }

  @override
  void close() => closed++;
}

String _hex(List<int> b) =>
    b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

final _t0 = DateTime.utc(2026, 11, 12, 9);

Future<void> _pump(
  WidgetTester tester, {
  required FakeSecureStore secure,
  FakeS3? s3,
  DateTime Function()? now,
}) async {
  tester.view.physicalSize = const Size(1400, 1100);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    OwnerApp(
      store: MemorySettingsStore(),
      httpFactory: FakeBackend.new,
      secure: secure,
      s3Factory: () => s3 ?? FakeS3([]),
      pbkdf2Iterations: 50,
      now: now ?? () => _t0,
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _enter(WidgetTester tester, Map<String, String> fields) async {
  for (final e in fields.entries) {
    await tester.enterText(find.byKey(Key(e.key)), e.value);
  }
}

Future<void> _tap(WidgetTester tester, String key) async {
  final f = find.byKey(Key(key));
  await tester.ensureVisible(f);
  await tester.pumpAndSettle();
  await tester.tap(f);
  await tester.pumpAndSettle();
}

String _text(WidgetTester tester, String key) =>
    tester.widget<Text>(find.byKey(Key(key))).data!;

Future<void> _setup(WidgetTester tester) async {
  await _enter(tester, {
    'setup-id': 'rezaa-test',
    'setup-pw': 'pass-word-123',
    'setup-code': '123456',
  });
  await _tap(tester, 'setup-submit');
}

Future<void> _login(
  WidgetTester tester, {
  String id = 'rezaa-test',
  String pw = 'pass-word-123',
  String code = '123456',
}) async {
  await _enter(tester, {'local-id': id, 'local-pw': pw, 'local-code': code});
  await _tap(tester, 'local-submit');
}

void main() {
  group('PBKDF2 / local account', () {
    test('PBKDF2-HMAC-SHA256 matches published vectors', () {
      final p = utf8.encode('password'), s = utf8.encode('salt');
      expect(
        _hex(pbkdf2Sha256(p, s, 1)),
        '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b',
      );
      expect(
        _hex(pbkdf2Sha256(p, s, 2)),
        'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43',
      );
      expect(
        _hex(pbkdf2Sha256(p, s, 4096)),
        'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a',
      );
      expect(() => pbkdf2Sha256(p, s, 0), throwsArgumentError);
    });

    test(
      'record verifies only the exact id + password + code; never stores them',
      () {
        final rec = LocalAccountRecord.create(
          loginId: ' rezaa-test ',
          password: 'pass-word-123',
          code: '123456',
          iterations: 10,
          random: Random(1),
        );
        expect(rec.verify('rezaa-test', 'pass-word-123', '123456'), isTrue);
        expect(rec.verify('rezaa-test', 'pass-word-124', '123456'), isFalse);
        expect(rec.verify('rezaa-test', 'pass-word-123', '123457'), isFalse);
        expect(rec.verify('rezaa-tes', 'pass-word-123', '123456'), isFalse);
        final enc = rec.encode();
        expect(enc, isNot(contains('pass-word-123')));
        expect(enc, isNot(contains('123456')));
        final back = LocalAccountRecord.decode(enc);
        expect(back.loginId, 'rezaa-test');
        expect(back.iterations, 10);
        expect(back.verify('rezaa-test', 'pass-word-123', '123456'), isTrue);
        expect(
          () => LocalAccountRecord.decode('{"v":2}'),
          throwsFormatException,
        );
        expect(
          () => LocalAccountRecord.decode('{"v":1,"login":"a","iter":0}'),
          throwsFormatException,
        );
        expect(() => LocalAccountRecord.decode('[]'), throwsFormatException);
      },
    );

    test('form validation (Persian messages)', () {
      String? v(String id, String pw, String code) =>
          validateNewAccount(loginId: id, password: pw, code: code);
      expect(v('ab', 'pass-word-1', '123456'), contains('شناسه'));
      expect(v('rezaa', 'short', '123456'), contains('دست‌کم'));
      expect(v('rezaa', 'pass-word-1', ''), contains('۶ رقم'));
      expect(v('rezaa', 'pass-word-1', '12345'), contains('۶ رقم'));
      expect(v('rezaa', 'pass-word-1', '12a456'), isNotNull);
      expect(v('rezaa254', '@Example-Pass1', '123456'), isNull);
    });

    test(
      'LocalAuth: create, login, lock after 5 failures, unlock after 30 s',
      () async {
        var now = _t0;
        final store = FakeSecureStore();
        final auth = LocalAuth(store, now: () => now, iterations: 20);
        expect(await auth.load(), isNull);
        final rec = await auth.create(
          loginId: 'owner1',
          password: 'pass-word-123',
          code: '123456',
        );
        expect(store.values.keys, [LocalAccountKeys.account]);
        expect((await auth.load())!.loginId, 'owner1');
        LocalLoginResult go(String code) => auth.login(
          rec,
          loginId: 'owner1',
          password: 'pass-word-123',
          code: code,
        );
        expect(go('123456').ok, isTrue);
        for (var i = 0; i < 4; i++) {
          expect(go('000000').error, contains('نادرست'));
        }
        expect(go('000000').ok, isFalse); // پنجمین ⇒ قفل
        final locked = go('123456');
        expect(locked.ok, isFalse);
        expect(locked.error, contains('موقتاً بسته'));
        now = now.add(const Duration(seconds: 31));
        expect(go('123456').ok, isTrue);
        expect(await auth.hasSession(rec), isFalse);
        await auth.saveSession(rec);
        expect(await auth.hasSession(rec), isTrue);
        store.values[LocalAccountKeys.session] = '{"v":1,"login":"other"}';
        expect(await auth.hasSession(rec), isFalse);
        store.values[LocalAccountKeys.session] = 'not json';
        expect(await auth.hasSession(rec), isFalse);
        store.values[LocalAccountKeys.serverSession] = 'tok';
        await auth.clearSession();
        expect(store.values.keys, [LocalAccountKeys.account]);
        await auth.reset();
        expect(await auth.load(), isNull);
      },
    );
  });

  group('S3 endpoint + SigV4 + connection test', () {
    test('endpoint normalization and region', () {
      expect(
        endpointText(normalizeS3Endpoint('s3.ir-central1.arvanstorage.ir')!),
        'https://s3.ir-central1.arvanstorage.ir',
      );
      expect(
        endpointText(
          normalizeS3Endpoint(' https://S3.ir-central1.arvanstorage.ir/ ')!,
        ),
        'https://s3.ir-central1.arvanstorage.ir',
      );
      expect(
        endpointText(normalizeS3Endpoint('https://minio.example.ir:9000')!),
        'https://minio.example.ir:9000',
      );
      expect(
        endpointText(normalizeS3Endpoint('http://127.0.0.1:9000')!),
        'http://127.0.0.1:9000',
      );
      for (final bad in [
        '',
        null,
        'http://s3.ir-central1.arvanstorage.ir',
        'ftp://x.ir',
        'https://s3.ir-central1.arvanstorage.ir/bucket',
        'https://a.ir/?x=1',
        'https://a.ir/#f',
        'https://user:pw@a.ir',
        'https://bad_host!.ir',
        'https://[::1',
      ]) {
        expect(normalizeS3Endpoint(bad), isNull, reason: '$bad');
      }
      expect(
        regionFor(normalizeS3Endpoint('s3.ir-central1.arvanstorage.ir')!),
        'ir-central1',
      );
      expect(
        regionFor(normalizeS3Endpoint('s3.ir-northwest1.arvanstorage.ir')!),
        'ir-northwest1',
      );
      expect(regionFor(normalizeS3Endpoint('minio.example.ir')!), 'us-east-1');
      expect(amzDate(DateTime.utc(2026, 1, 2, 3, 4, 5)), '20260102T030405Z');
    });

    test('SigV4 matches botocore (official AWS SDK) byte-for-byte', () {
      const empty =
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      String sign(String host, String region) => sigV4Authorization(
        method: 'GET',
        path: '/',
        headers: {
          'host': host,
          'x-amz-content-sha256': empty,
          'x-amz-date': '20261112T210543Z',
        },
        payloadHash: empty,
        region: region,
        service: 's3',
        accessKey: 'AKIDEXAMPLE',
        secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        amzDateTime: '20261112T210543Z',
      );
      expect(
        sign('s3.ir-central1.arvanstorage.ir', 'ir-central1'),
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261112/ir-central1/s3/aws4_request, '
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date, '
        'Signature=683d023aae431617e881b7e37345cc63a6a2b742dbc1ed63ee3b8d6b2159089b',
      );
      expect(
        sign('example.amazonaws.com', 'us-east-1'),
        endsWith(
          'Signature=a3ba05cf45ca09e680b529548709d04bfd0827e86293e8ce8cc6cfbe3e69bd00',
        ),
      );
    });

    final settings = S3Settings(
      endpoint: normalizeS3Endpoint('s3.ir-central1.arvanstorage.ir')!,
      accessKey: 'AKID',
      secretKey: 'SECRET',
    );

    test('200 ⇒ bucket list; request is signed for ir-central1', () async {
      final t = FakeS3([const S3Response(200, _bucketsXml)]);
      final r = await testS3Connection(settings, t, now: () => _t0);
      expect(r.ok, isTrue);
      expect(r.buckets, ['payesh-main', 'payesh-backup']);
      final (url, h) = t.calls.single;
      expect(url.toString(), 'https://s3.ir-central1.arvanstorage.ir/');
      expect(h['host'], 's3.ir-central1.arvanstorage.ir');
      expect(h['x-amz-date'], '20261112T090000Z');
      expect(
        h['authorization'],
        contains('/20261112/ir-central1/s3/aws4_request'),
      );
      expect(h['authorization'], isNot(contains('SECRET')));
    });

    test('server error codes ⇒ Persian messages', () async {
      Future<String?> e(Object reply) async =>
          (await testS3Connection(settings, FakeS3([reply]))).error;
      expect(
        await e(S3Response(403, _err('InvalidAccessKeyId'))),
        contains('Access Key'),
      );
      expect(
        await e(S3Response(403, _err('SignatureDoesNotMatch'))),
        contains('Secret Key'),
      );
      expect(
        await e(S3Response(403, _err('RequestTimeTooSkewed'))),
        contains('ساعت'),
      );
      expect(
        await e(S3Response(403, _err('AccessDenied'))),
        contains('AccessDenied'),
      );
      expect(await e(const S3Response(502, 'bad gateway')), contains('کد 502'));
      expect(await e(const SocketException('no route')), contains('اینترنت'));
      expect(await e(TimeoutException('t')), contains('مهلت'));
      expect(await e(const HandshakeException('tls')), contains('TLS'));
      expect(await e(const HttpException('cut')), contains('قطع'));
    });

    test(
      'wrong region hint ⇒ one retry with the region the server names',
      () async {
        final t = FakeS3([
          S3Response(
            400,
            _err('AuthorizationHeaderMalformed', region: 'ir-thr-at1'),
          ),
          const S3Response(
            200,
            '<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>',
          ),
        ]);
        final r = await testS3Connection(settings, t);
        expect(r.ok, isTrue);
        expect(r.buckets, isEmpty);
        expect(t.calls[1].$2['authorization'], contains('/ir-thr-at1/s3/'));
        final t2 = FakeS3([
          S3Response(400, _err('AuthorizationHeaderMalformed', region: 'x-1')),
          S3Response(400, _err('AuthorizationHeaderMalformed', region: 'x-2')),
        ]);
        expect((await testS3Connection(settings, t2)).ok, isFalse);
        expect(t2.calls, hasLength(2));
      },
    );

    test(
      'settings round-trip through the secure store; form validation',
      () async {
        final store = FakeSecureStore();
        expect(await S3Settings.load(store), isNull);
        await settings.save(store);
        final back = (await S3Settings.load(store))!;
        expect(
          endpointText(back.endpoint),
          'https://s3.ir-central1.arvanstorage.ir',
        );
        expect(back.accessKey, 'AKID');
        expect(back.secretKey, 'SECRET');
        expect(S3Settings.decode('{"v":2}'), isNull);
        expect(S3Settings.decode('{"v":1,"endpoint":"ftp://x"}'), isNull);
        await S3Settings.clear(store);
        expect(store.values, isEmpty);
        String? v(String e, String a, String s) =>
            validateS3Form(endpoint: e, accessKey: a, secretKey: s);
        expect(v('nope/x', 'AKID', 'SECRET'), contains('آدرس'));
        expect(
          v('s3.ir-central1.arvanstorage.ir', '', 'SECRET'),
          contains('Access'),
        );
        expect(
          v('s3.ir-central1.arvanstorage.ir', 'AKID', 'a b'),
          contains('Secret'),
        );
        expect(v('s3.ir-central1.arvanstorage.ir', 'AKID', 'SECRET'), isNull);
      },
    );

    test('IoS3Transport talks real HTTP (loopback server)', () async {
      final prev = HttpOverrides.current;
      HttpOverrides.global =
          null; // flutter_test HttpClient را جعلی می‌کند؛ اینجا واقعی لازم است
      addTearDown(() => HttpOverrides.global = prev);
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      String? auth;
      server.listen((req) {
        auth = req.headers.value('authorization');
        req.response
          ..statusCode = 200
          ..write(_bucketsXml)
          ..close();
      });
      final t = IoS3Transport(timeout: const Duration(seconds: 5));
      final s = S3Settings(
        endpoint: normalizeS3Endpoint('http://127.0.0.1:${server.port}')!,
        accessKey: 'AKID',
        secretKey: 'SECRET',
      );
      final r = await testS3Connection(s, t);
      t.close();
      await server.close(force: true);
      expect(r.ok, isTrue);
      expect(r.buckets, hasLength(2));
      expect(auth, startsWith('AWS4-HMAC-SHA256 Credential=AKID/'));
    });
  });

  group('platform secure stores', () {
    TestWidgetsFlutterBinding.ensureInitialized();

    test(
      'ChannelSecureStore uses secureRead/Write/Delete; errors fail closed',
      () async {
        const ch = MethodChannel('test.owner/secure');
        final calls = <String>[];
        final m =
            TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
        m.setMockMethodCallHandler(ch, (call) async {
          calls.add('${call.method}:${(call.arguments as Map)['key']}');
          if (call.method == 'secureRead') return 'v';
          if (call.method == 'secureDelete') {
            throw PlatformException(code: 'secure_store', message: 'boom');
          }
          return null;
        });
        final s = ChannelSecureStore(ch);
        expect(await s.read('owner.s3.settings'), 'v');
        await s.write('owner.s3.settings', 'x');
        await expectLater(
          s.delete('owner.s3.settings'),
          throwsA(isA<SecureStoreException>()),
        );
        expect(calls, [
          'secureRead:owner.s3.settings',
          'secureWrite:owner.s3.settings',
          'secureDelete:owner.s3.settings',
        ]);
        m.setMockMethodCallHandler(ch, null);
        await expectLater(s.read('a'), throwsA(isA<SecureStoreException>()));
        expect(() => s.read('Bad Key'), throwsArgumentError);
      },
    );

    test('DevFileSecureStore (developer machines only)', () async {
      final d = Directory.systemTemp.createTempSync('owner-sec-');
      addTearDown(() => d.deleteSync(recursive: true));
      final s = DevFileSecureStore('${d.path}/secure');
      expect(await s.read('owner.local.account'), isNull);
      await s.write('owner.local.account', 'abc');
      expect(await s.read('owner.local.account'), 'abc');
      await s.delete('owner.local.account');
      expect(await s.read('owner.local.account'), isNull);
      expect(platformSecureStore(), isA<DevFileSecureStore>());
    });
  });

  group(
    'app: offline login ⇒ whole app; settings inside; session until «خروج»',
    () {
      Future<void> openSettings(WidgetTester tester) =>
          _tap(tester, 'nav-settings');

      testWidgets(
        'first run: one password field, empty code ⇒ whole app opens',
        (tester) async {
          final secure = FakeSecureStore();
          await _pump(tester, secure: secure);
          expect(find.text('تعریف حساب مالک'), findsOneWidget);
          expect(find.byKey(const Key('setup-pw2')), findsNothing);
          final code = tester.widget<TextField>(
            find.byKey(const Key('setup-code')),
          );
          expect(code.controller!.text, isEmpty);
          await _enter(tester, {'setup-id': 'ab'});
          await _tap(tester, 'setup-submit');
          expect(_text(tester, 'local-msg'), contains('شناسه'));
          await _enter(tester, {
            'setup-id': 'rezaa-test',
            'setup-pw': 'pass-word-123',
          });
          await _tap(tester, 'setup-submit');
          expect(_text(tester, 'local-msg'), contains('۶ رقم'));
          await _setup(tester);
          // کل برنامه: منوی همهٔ بخش‌ها + تنظیمات
          expect(find.byKey(const Key('local-shell')), findsOneWidget);
          for (final id in [
            'dashboard',
            'schools',
            'plans',
            'operators',
            'settings',
          ]) {
            expect(find.byKey(Key('nav-$id')), findsOneWidget, reason: id);
          }
          // بدون سرور پلتفرم: سرور مستقل همین دستگاه؛ هیچ بخشی «سرور لازم است» نمی‌گوید
          expect(find.byKey(const Key('server-needed')), findsNothing);
          expect(find.byKey(const Key('mode-badge')), findsOneWidget);
          expect(find.byKey(const Key('metric-plans')), findsOneWidget);
          expect(
            secure.values[LocalAccountKeys.account],
            isNot(contains('pass-word-123')),
          );
          expect(secure.values.keys, contains(LocalAccountKeys.session));
          await _tap(tester, 'nav-settings');
          expect(find.byKey(const Key('db-endpoint')), findsOneWidget);
          expect(find.byKey(const Key('srv-origin')), findsOneWidget);
        },
      );

      testWidgets(
        'no platform server: schools, plans, health work on this device and survive restart',
        (tester) async {
          final secure = FakeSecureStore();
          await _pump(tester, secure: secure);
          await _setup(tester);
          await _tap(tester, 'nav-schools');
          expect(find.byKey(const Key('server-needed')), findsNothing);
          await _tap(tester, 'create-school');
          for (final e in {
            'slug': 'school-12',
            'display_name': 'هنرستان نمونه',
            'manager_name': 'مدیر نمونه',
          }.entries) {
            await tester.enterText(find.byKey(Key('dlg-${e.key}')), e.value);
          }
          await tester.enterText(
            find.byKey(const Key('dlg-reason')),
            'ثبت مدرسهٔ نمونه برای آزمون',
          );
          await _tap(tester, 'dlg-submit');
          expect(_text(tester, 'flash'), 'مدرسه ساخته شد.');
          expect(find.text('هنرستان نمونه (school-12)'), findsOneWidget);
          expect(find.byKey(const Key('activation-code')), findsNothing);

          await _tap(tester, 'nav-plans');
          expect(find.text('نامحدود'), findsWidgets);
          await _tap(tester, 'nav-health');
          expect(find.byKey(const Key('health-local')), findsOneWidget);
          expect(
            find.byKey(const Key('health-db-not_configured')),
            findsOneWidget,
          );
          await _tap(tester, 'nav-audit');
          expect(find.text('tenant.provision'), findsWidgets);
          expect(secure.values[platformStateKey], contains('school-12'));

          await tester.pumpWidget(const SizedBox());
          await _pump(tester, secure: secure);
          await _tap(tester, 'nav-schools');
          expect(find.text('هنرستان نمونه (school-12)'), findsOneWidget);
        },
      );

      testWidgets('stays signed in after restart until «خروج»', (tester) async {
        final secure = FakeSecureStore();
        await _pump(tester, secure: secure);
        await _setup(tester);
        // بستن و باز کردن برنامه: ویجت تازه با همان انبار امن
        await tester.pumpWidget(const SizedBox());
        await _pump(tester, secure: secure);
        expect(find.byKey(const Key('local-shell')), findsOneWidget);
        expect(find.text('ورود به پنل مالک'), findsNothing);
        await _tap(tester, 'logout');
        expect(_text(tester, 'local-msg'), 'از پنل خارج شدید.');
        expect(secure.values.keys, isNot(contains(LocalAccountKeys.session)));
        await tester.pumpWidget(const SizedBox());
        await _pump(tester, secure: secure);
        expect(find.text('ورود به پنل مالک'), findsOneWidget);
        await _login(tester, code: '654321');
        expect(_text(tester, 'local-msg'), contains('نادرست'));
        await _login(tester);
        expect(find.byKey(const Key('local-shell')), findsOneWidget);
      });

      testWidgets(
        'settings: database validate, test+save (buckets), reload, clear',
        (tester) async {
          final secure = FakeSecureStore();
          final s3 = FakeS3([
            const S3Response(200, _bucketsXml),
            const S3Response(200, ''), // PUT control/cloud-<kid>.json
            S3Response(403, _err('SignatureDoesNotMatch')),
          ]);
          await _pump(tester, secure: secure, s3: s3);
          await _setup(tester);
          await openSettings(tester);
          await _tap(tester, 'db-save');
          expect(_text(tester, 'db-msg'), contains('آدرس'));
          await _enter(tester, {
            'db-endpoint': 's3.ir-central1.arvanstorage.ir',
            'db-access': '997cc6ad-e97a-4e4d-abf1-test',
            'db-secret': 'secret-test-value',
          });
          TextField secretField() =>
              tester.widget<TextField>(find.byKey(const Key('db-secret')));
          expect(secretField().obscureText, isTrue);
          await _tap(tester, 'db-secret-toggle');
          expect(secretField().obscureText, isFalse);
          await _tap(tester, 'db-save');
          expect(_text(tester, 'db-msg'), contains('ذخیره شد'));
          expect(_text(tester, 'db-msg'), contains('سرورهای مدرسه'));
          expect(_text(tester, 'db-msg'), contains('payesh-main'));
          // خالی بود ⇒ همان قاعدهٔ سرور مدرسه: اولین صندوقچهٔ «payesh»
          expect(
            tester
                .widget<TextField>(find.byKey(const Key('db-bucket')))
                .controller!
                .text,
            'payesh-main',
          );
          expect(s3.methods, ['GET', 'PUT']);
          expect(
            s3.calls[1].$1.toString(),
            'https://s3.ir-central1.arvanstorage.ir/payesh-main/'
            '${controlObjectKey('997cc6ad-e97a-4e4d-abf1-test')}',
          );
          final env = jsonDecode(s3.bodies[1]!) as Map<String, Object?>;
          expect(s3.bodies[1], isNot(contains('secret-test-value')));
          final inner = jsonDecode(
            await openControlText('secret-test-value', env),
          ) as Map<String, Object?>;
          expect(inner['bucket'], 'payesh-main');
          expect(inner['secret'], 'secret-test-value');
          expect(await loadPublishedRev(secure), _t0.millisecondsSinceEpoch);
          expect((await S3Settings.load(secure))!.bucket, 'payesh-main');
          expect(_text(tester, 'db-buckets-title'), contains('2'));
          expect(
            (await S3Settings.load(secure))!.secretKey,
            'secret-test-value',
          );
          expect(s3.closed, 1);
          await _tap(tester, 'db-test');
          expect(_text(tester, 'db-msg'), contains('Secret Key نادرست'));

          await tester.pumpWidget(const SizedBox());
          await _pump(tester, secure: secure, s3: s3);
          await openSettings(tester);
          expect(_text(tester, 'db-msg'), contains('بارگذاری شد'));
          expect(
            tester
                .widget<TextField>(find.byKey(const Key('db-endpoint')))
                .controller!
                .text,
            'https://s3.ir-central1.arvanstorage.ir',
          );
          await _tap(tester, 'db-clear');
          expect(_text(tester, 'db-msg'), contains('پاک شد'));
          expect(await S3Settings.load(secure), isNull);
        },
      );

      testWidgets('settings: pasted bucket URL, change of database tells the old bucket too, '
          'followers list; NEG publish failure and no bucket', (tester) async {
        final secure = FakeSecureStore();
        String ack(String id, String host, int rev, bool ok, String at) =>
            jsonEncode({
              'v': 1,
              'server_id': id,
              'host': host,
              'rev': rev,
              'ok': ok,
              'at': at,
              if (!ok) 'error': 'NoSuchBucket',
            });
        final rev1 = _t0.millisecondsSinceEpoch;
        final s3 = FakeS3([
          const S3Response(200, _bucketsXml), // test (old)
          const S3Response(200, ''), // PUT old
          const S3Response(200, _bucketsXml), // test (new)
          const S3Response(200, ''), // PUT new
          const S3Response(200, ''), // PUT old (اعلام در قبلی)
          const S3Response(
            200,
            '<ListBucketResult><Contents><Key>payesh/control/ack/a1.json</Key></Contents>'
            '<Contents><Key>payesh/control/ack/b2.json</Key></Contents></ListBucketResult>',
          ),
          S3Response(
            200,
            ack('a1', 'PC-DAFTAR', rev1, true, '2026-11-12T09:01:00Z'),
          ),
          S3Response(
            200,
            ack('b2', 'PC-OLD', 5, false, '2026-11-12T08:00:00Z'),
          ),
        ]);
        await _pump(tester, secure: secure, s3: s3);
        await _setup(tester);
        await openSettings(tester);
        await _enter(tester, {
          'db-endpoint': 's3.ir-central1.arvanstorage.ir',
          'db-bucket': 'payesh-backup',
          'db-access': 'AK-OLD',
          'db-secret': 'SK-OLD',
        });
        await _tap(tester, 'db-save');
        expect(_text(tester, 'db-msg'), contains('payesh-backup'));
        // مالک آدرس خود صندوقچه را می‌چسباند (مثل پنل آروان) و کلید تازه می‌دهد
        await _enter(tester, {
          'db-endpoint':
              'https://payesh-madrese.s3.ir-central1.arvanstorage.ir',
          'db-bucket': '',
          'db-access': 'AK-NEW',
          'db-secret': 'SK-NEW',
        });
        await _tap(tester, 'db-save');
        expect(_text(tester, 'db-msg'), contains('payesh-madrese'));
        expect(
          tester
              .widget<TextField>(find.byKey(const Key('db-endpoint')))
              .controller!
              .text,
          'https://s3.ir-central1.arvanstorage.ir',
        );
        expect(s3.methods, ['GET', 'PUT', 'GET', 'PUT', 'PUT']);
        expect(
          s3.calls[3].$1.path,
          '/payesh-madrese/${controlObjectKey('AK-NEW')}',
        );
        expect(
          s3.calls[4].$1.path,
          '/payesh-backup/${controlObjectKey('AK-OLD')}',
        );
        expect(s3.calls[4].$2['authorization'], contains('Credential=AK-OLD/'));
        // پاکتِ صندوقچهٔ قبلی با کلید قبلی باز می‌شود و مقصد تازه را می‌گوید
        final old = jsonDecode(s3.bodies[4]!) as Map<String, Object?>;
        final inner = jsonDecode(
          await openControlText('SK-OLD', old),
        ) as Map<String, Object?>;
        expect(inner['bucket'], 'payesh-madrese');
        expect(inner['accessKey'], 'AK-NEW');
        await expectLater(
          openControlText('SK-NEW', old),
          throwsA(isA<Object>()),
        );

        await _tap(tester, 'db-followers');
        expect(_text(tester, 'db-followers-title'), contains('2'));
        expect(
          find.textContaining('PC-DAFTAR · پیرو و به‌روز ✅'),
          findsOneWidget,
        );
        expect(
          find.textContaining('PC-OLD · خطا: NoSuchBucket'),
          findsOneWidget,
        );
        expect(
          s3.calls[5].$1.query,
          contains('prefix=payesh%2Fcontrol%2Fack%2F'),
        );

        // NEG: نوشتن فرمان رد شد ⇒ ذخیره هست ولی خطا گفته می‌شود
        s3.replies.addAll([
          const S3Response(200, _bucketsXml),
          S3Response(403, _err('AccessDenied')),
        ]);
        await _tap(tester, 'db-save');
        expect(
          _text(tester, 'db-msg'),
          contains('اعلام به سرورهای مدرسه ممکن نشد'),
        );
        expect(_text(tester, 'db-msg'), contains('AccessDenied'));
        // NEG: هیچ صندوقچه‌ای در حساب نیست
        await _enter(tester, {'db-bucket': ''});
        s3.replies.add(
          const S3Response(
            200,
            '<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>',
          ),
        );
        await _tap(tester, 'db-save');
        expect(
          _text(tester, 'db-msg'),
          contains('صندوقچه‌ای (Bucket) در این حساب نیست'),
        );
        // NEG: نام صندوقچهٔ نامعتبر
        await _enter(tester, {'db-bucket': 'Bad_Name'});
        await _tap(tester, 'db-save');
        expect(_text(tester, 'db-msg'), contains('نام صندوقچه'));
        await _tap(tester, 'db-followers');
        await _enter(tester, {'db-bucket': ''});
        await _tap(tester, 'db-followers');
        expect(_text(tester, 'db-followers-error'), contains('آزمایش اتصال'));
      });

      testWidgets('settings: followers — none yet; listing error', (
        tester,
      ) async {
        final secure = FakeSecureStore();
        final s3 = FakeS3([
          const S3Response(200, '<ListBucketResult></ListBucketResult>'),
          S3Response(403, _err('SignatureDoesNotMatch')),
        ]);
        await _pump(tester, secure: secure, s3: s3);
        await _setup(tester);
        await openSettings(tester);
        await _enter(tester, {
          'db-endpoint': 's3.ir-central1.arvanstorage.ir',
          'db-bucket': 'payesh-madrese',
          'db-access': 'AKID',
          'db-secret': 'SECRET',
        });
        await _tap(tester, 'db-followers');
        expect(_text(tester, 'db-followers-title'), contains('هنوز هیچ سرور'));
        await _tap(tester, 'db-followers');
        expect(_text(tester, 'db-followers-error'), contains('Secret Key'));
      });

      testWidgets('settings: test only (no save), empty bucket list', (
        tester,
      ) async {
        final secure = FakeSecureStore();
        final s3 = FakeS3([
          const S3Response(
            200,
            '<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>',
          ),
        ]);
        await _pump(tester, secure: secure, s3: s3);
        await _setup(tester);
        await openSettings(tester);
        await _enter(tester, {
          'db-endpoint': 's3.ir-central1.arvanstorage.ir',
          'db-access': 'AKID',
          'db-secret': 'SECRET',
        });
        await _tap(tester, 'db-test');
        expect(_text(tester, 'db-msg'), 'اتصال برقرار است.');
        expect(_text(tester, 'db-buckets-title'), contains('هنوز'));
        expect(await S3Settings.load(secure), isNull);
      });

      testWidgets(
        'settings: platform server origin + server login, kept after restart',
        (tester) async {
          final secure = FakeSecureStore();
          final backend = FakeBackend();
          final store = MemorySettingsStore();
          Future<void> pumpWith() async {
            tester.view.physicalSize = const Size(1400, 1100);
            tester.view.devicePixelRatio = 1;
            addTearDown(tester.view.reset);
            await tester.pumpWidget(
              OwnerApp(
                store: store,
                httpFactory: () => backend,
                secure: secure,
                pbkdf2Iterations: 50,
              ),
            );
            await tester.pumpAndSettle();
          }

          await pumpWith();
          await _setup(tester);
          await openSettings(tester);
          await _enter(tester, {'srv-origin': 'ftp://x'});
          await _tap(tester, 'srv-origin-save');
          expect(_text(tester, 'srv-msg'), contains('معتبر نیست'));
          await _enter(tester, {'srv-origin': 'https://owner.example.ir'});
          await _tap(tester, 'srv-origin-save');
          await _enter(tester, {
            'srv-id': 'owner',
            'srv-pw': 'wrong',
            'srv-totp': '123456',
          });
          await _tap(tester, 'srv-login');
          expect(find.byKey(const Key('srv-status')), findsNothing);
          await _enter(tester, {
            'srv-id': 'owner',
            'srv-pw': 'pw-owner-1',
            'srv-totp': '123456',
          });
          await _tap(tester, 'srv-login');
          expect(find.byKey(const Key('srv-status')), findsOneWidget);
          expect(secure.values.keys, contains(LocalAccountKeys.serverSession));
          await _tap(tester, 'nav-dashboard');
          expect(find.byKey(const Key('server-needed')), findsNothing);
          expect(find.byKey(const Key('mode-badge')), findsNothing);

          await tester.pumpWidget(const SizedBox());
          await pumpWith();
          await _tap(tester, 'nav-dashboard');
          expect(find.byKey(const Key('server-needed')), findsNothing);
          await openSettings(tester);
          await _tap(tester, 'srv-disconnect');
          expect(
            secure.values.keys,
            isNot(contains(LocalAccountKeys.serverSession)),
          );
          await _tap(tester, 'nav-dashboard');
          // جدا از سرور ⇒ دوباره سرور مستقل همین دستگاه
          expect(find.byKey(const Key('server-needed')), findsNothing);
          expect(find.byKey(const Key('mode-badge')), findsOneWidget);
        },
      );

      testWidgets(
        'lockout after 5 wrong attempts; reset wipes account + database',
        (tester) async {
          var now = _t0;
          final secure = FakeSecureStore();
          await LocalAuth(secure, iterations: 50).create(
            loginId: 'rezaa-test',
            password: 'pass-word-123',
            code: '123456',
          );
          secure.values[S3Keys.settings] = S3Settings(
            endpoint: normalizeS3Endpoint('s3.ir-central1.arvanstorage.ir')!,
            accessKey: 'A',
            secretKey: 'B',
          ).encode();
          await _pump(tester, secure: secure, now: () => now);
          for (var i = 0; i < 5; i++) {
            await _login(tester, pw: 'wrong-pass-1');
          }
          await _login(tester);
          expect(_text(tester, 'local-msg'), contains('موقتاً بسته'));
          now = now.add(const Duration(seconds: 31));
          await _login(tester);
          expect(find.byKey(const Key('local-shell')), findsOneWidget);
          await _tap(tester, 'logout');
          await _tap(tester, 'local-reset');
          await tester.tap(find.text('انصراف'));
          await tester.pumpAndSettle();
          expect(find.text('ورود به پنل مالک'), findsOneWidget);
          await _tap(tester, 'local-reset');
          await _tap(tester, 'reset-confirm');
          expect(find.text('تعریف حساب مالک'), findsOneWidget);
          expect(secure.values, isEmpty);
        },
      );

      testWidgets('corrupted account record ⇒ fail closed', (tester) async {
        final broken = FakeSecureStore()
          ..values[LocalAccountKeys.account] = '{"v":9}';
        await _pump(tester, secure: broken);
        expect(_text(tester, 'local-msg'), contains('خراب'));
        await _login(tester);
        expect(find.byKey(const Key('local-shell')), findsNothing);
      });

      testWidgets(
        'unreachable secure store ⇒ fail closed; reset failure reported',
        (tester) async {
          final failing = FakeSecureStore()
            ..failWith = const SecureStoreException('os');
          await _pump(tester, secure: failing);
          expect(_text(tester, 'local-msg'), contains('انبار امن'));
          await _tap(tester, 'local-reset');
          await _tap(tester, 'reset-confirm');
          expect(_text(tester, 'local-msg'), contains('ممکن نشد'));
        },
      );

      testWidgets('secure store failures on setup / save / clear / sign-out', (
        tester,
      ) async {
        final secure = FakeSecureStore();
        final s3 = FakeS3([const S3Response(200, _bucketsXml)]);
        await _pump(tester, secure: secure, s3: s3);
        secure.failWith = const SecureStoreException('os');
        await _setup(tester);
        expect(_text(tester, 'local-msg'), contains('ممکن نشد'));
        secure.failWith = null;
        await _setup(tester);
        await openSettings(tester);
        secure.failWith = const SecureStoreException('os');
        await _enter(tester, {
          'db-endpoint': 's3.ir-central1.arvanstorage.ir',
          'db-access': 'AKID',
          'db-secret': 'SECRET',
        });
        await _tap(tester, 'db-save');
        expect(_text(tester, 'db-msg'), contains('ذخیرهٔ امن'));
        await _tap(tester, 'db-clear');
        expect(_text(tester, 'db-msg'), contains('ذخیرهٔ امن'));
        await _tap(tester, 'logout');
        expect(find.text('ورود به پنل مالک'), findsOneWidget);
      });

      testWidgets('unreadable saved database settings ⇒ asks to re-enter', (
        tester,
      ) async {
        final secure = FakeSecureStore();
        final auth = LocalAuth(secure, iterations: 50);
        final rec = await auth.create(
          loginId: 'rezaa-test',
          password: 'pass-word-123',
          code: '123456',
        );
        await auth.saveSession(rec);
        secure.values[S3Keys.settings] = 'not json';
        await _pump(tester, secure: secure);
        await openSettings(tester);
        expect(_text(tester, 'db-msg'), contains('خراب'));
      });
    },
  );
}
