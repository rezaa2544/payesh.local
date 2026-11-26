// ردیف ۱۹۶ — «پنل مالک روی سیستمم خیلی کند است و گیر دارد».
//
// علت (روی رایانهٔ مالک دیده شد): از ردیف ۱۹۱ پنل مالک کل فرایند خودش را با «Job Object»
// ویندوز (CPU rate control، HARD_CAP) محدود می‌کرد؛ «کنترل پردازش» روی ۱۰٪ بود ⇒ کل برنامه
// — رابط، رسم صفحه، شبکه — کمتر از یک هسته از ۸ (flags=0x5، rate=1000). ویندوز در هر بازه
// پس از تمام شدن سهم، همهٔ رشته‌ها را نگه می‌داشت ⇒ گیر در اسکرول و کلیک و باز شدن صفحه‌ها.
// رفع: سقف فقط کارهای پس‌زمینه را محدود می‌کند؛ پنل هرگز خودش را در سیستم‌عامل محدود
// نمی‌کند؛ و نسخهٔ تازه اگر درون Job سقف‌دارِ نسخهٔ قبلی بالا بیاید، از راه Explorer بیرون
// می‌آید.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/helper/helper_service.dart';
import 'package:payesh_owner/src/helper/host_cpu.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/power/activity.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'support/fake_bucket.dart';

void main() {
  final t0 = DateTime.utc(2026, 11, 26, 15);

  test('R196-01 سقف پیش‌فرض هرگز به سیستم‌عامل نمی‌رسد (hard=false)', () {
    final cap = CpuCap();
    expect(cap.set(10), isFalse);
    expect(cap.hard, isFalse);
    expect(cap.percent, 10, reason: 'سقف کارهای پس‌زمینه همچنان دانسته است');
    expect(cap.set(null), isFalse);
    expect(cap.percent, isNull);
    expect(CpuCap.instance.hard, isFalse);
  });

  test('R196-02 «مقدار پردازش» ۱۰٪ ⇒ کارهای پس‌زمینه کمتر و با استراحت؛ خود برنامه بی‌سقف', () async {
    final secure = FakeSecureStore();
    final bucket = FakeBucket(() => t0);
    await S3Settings(
      endpoint: Uri.https('s3.example.test'),
      accessKey: 'ak',
      secretKey: 'sk-196',
      bucket: 'payesh-madrese',
    ).save(secure);
    final svc = OwnerHelperService(
      secure: secure,
      transport: bucket.transport,
      now: () => t0,
      sleep: (_) async {},
      autoStart: false,
      cap: CpuCap(),
    );
    await svc.init();
    await svc.setLocalCpu(10);
    expect(svc.effectiveCpu, 10);
    expect(svc.cap.percent, 10);
    expect(svc.cap.hard, isFalse, reason: 'پنل خودش را محدود نمی‌کند');
    expect(slotsForCpu(10, 8), lessThan(slotsForCpu(null, 8)));
    expect(
      restForCpu(const Duration(milliseconds: 100), 10),
      const Duration(milliseconds: 900),
    );
    await svc.dispose();
  });

  test(
    'R196-03 NEG هیچ کدی در پنل مالک Job Object نمی‌سازد یا به آن نمی‌پیوندد',
    () {
      final hits = <String>[];
      for (final f in Directory('lib').listSync(recursive: true)) {
        if (f is! File || !f.path.endsWith('.dart')) continue;
        final s = f.readAsStringSync();
        for (final api in [
          'CreateJobObject',
          'AssignProcessToJobObject',
          'SetInformationJobObject',
        ]) {
          if (s.contains("'$api")) hits.add('${f.path}: $api');
        }
      }
      expect(hits, isEmpty);
    },
  );

  test('R196-04 نسخهٔ تازه درون Job سقف‌دارِ قدیمی ⇒ پیش از ساختن پنجره از راه Explorer بیرون می‌آید', () {
    final src = File('windows/runner/main.cpp').readAsStringSync();
    final esc = src.indexOf('if (EscapeCpuCapJob())');
    final create = src.indexOf('window.Create(');
    expect(esc, greaterThan(0));
    expect(create, greaterThan(esc), reason: 'پیش از پنجره و موتور Flutter');
    // فقط Job با HARD_CAP زیر ۱۰۰٪؛ برای نسخهٔ قبل از ویندوز ۸ تماس شکست می‌خورد ⇒ هیچ
    expect(src, contains('kHardCap'));
    expect(src, contains('info.cpu_rate < 10000'));
    expect(src, contains(r'\\explorer.exe'));
    // هرگز چرخه نمی‌سازد: یک دقیقه پس از هر انتقال، همان‌جا اجرا می‌شود
    expect(src, contains('cpu-job-escape.stamp'));
    expect(src, contains('600000000ULL'));
    // خروج با کد ۰ ⇒ بررسی سلامت به‌روزرسانی آن را سالم می‌داند (بازگشت نمی‌زند)
    expect(src.substring(esc, esc + 80), contains('return EXIT_SUCCESS;'));
  });
}
