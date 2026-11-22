// Row 170: on the 32-bit edition (dart2js) `Isolate.run` throws, so creating, editing or
// resetting a school's manager password never reached the database. This suite runs the
// same calls on the VM *and* in Chromium (`flutter test --platform chrome`, CI win32-edition).
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/net/resilience.dart';
import 'package:payesh_owner/src/schools/school_registry.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'support/fake_bucket.dart';

void main() {
  const sk = 'SK-WEB32-170';
  late FakeBucket bucket;
  late FakeSecureStore secure;
  late SchoolRegistry reg;
  final clock = DateTime.utc(2026, 11, 22, 10);

  setUpAll(() => s3RetryPolicy = RetryPolicy.none);
  tearDownAll(() => s3RetryPolicy = const RetryPolicy());

  setUp(() async {
    EndpointRoutes.reset();
    bucket = FakeBucket(() => clock);
    secure = FakeSecureStore();
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

  test('W170-01 pbkdf2 hash + verify (no isolate on web)', () async {
    final h = await pbkdf2Hash('0012345679', iterations: 1000);
    expect(h, startsWith(r'pbkdf2$1000$'));
    expect(await pbkdf2Verify('0012345679', h), isTrue);
    expect(await pbkdf2Verify('wrong', h), isFalse);
  });

  test('W170-02 create, edit and reset password reach the database', () async {
    final id = await reg.createSchool({
      'name': 'دبیرستان آزمایش ۱۷۰',
      'code': '17001700',
      'province': 'تهران',
      'county': 'تهران',
      'manager': {
        'name': 'مدیر آزمون',
        'phone': '09120001700',
        'national_id': '0012345679',
        'username': '09120001700',
      },
    }, password: '0012345679');
    var list = (await inBucket())['schools']! as List;
    expect(list, hasLength(1));
    final s = (list.single as Map).cast<String, Object?>();
    expect(s['id'], id);
    final m = (s['manager']! as Map).cast<String, Object?>();
    expect(
      await pbkdf2Verify(
        '0012345679',
        '${m['password_hash'] ?? s['password_hash']}',
      ),
      isTrue,
    );

    await reg.updateSchool(id, {
      ...s,
      'name': 'دبیرستان ویرایش‌شده',
    }, password: 'NewPass170');
    list = (await inBucket())['schools']! as List;
    final e = (list.single as Map).cast<String, Object?>();
    expect(e['name'], 'دبیرستان ویرایش‌شده');
    final em = (e['manager']! as Map).cast<String, Object?>();
    expect(
      await pbkdf2Verify(
        'NewPass170',
        '${em['password_hash'] ?? e['password_hash']}',
      ),
      isTrue,
    );

    await reg.resetManagerPassword(id, 'Reset170x');
    final r = ((await inBucket())['schools']! as List).single as Map;
    final rm = (r['manager']! as Map).cast<String, Object?>();
    expect(
      await pbkdf2Verify(
        'Reset170x',
        '${rm['password_hash'] ?? r['password_hash']}',
      ),
      isTrue,
    );
  });
}
