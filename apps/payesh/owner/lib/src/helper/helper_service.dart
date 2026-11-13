// سرور کمکیِ همین دستگاه در برنامه: شناسهٔ پایدار، «توقف موقت» و پیروی از تنظیمات دیتابیس.
// پیش‌فرض: روشن. تا وقتی برنامه باز است (حتی کوچک‌شده) کار می‌کند.

import 'dart:async';

import 'package:payesh_secure/payesh_secure.dart';

import '../infra/infra_policy.dart';
import '../local/s3_client.dart';
import '../update/owner_update.dart';
import 'helper_box.dart';
import 'helper_jobs.dart';
import 'helper_node.dart';

abstract final class HelperKeys {
  static const String id = 'owner.helper.id';
  static const String paused = 'owner.helper.paused';
}

final class OwnerHelperService {
  OwnerHelperService({
    required this.secure,
    S3Transport Function()? transport,
    S3Transport Function()? bigTransport,
    DateTime Function()? now,
    this.sleep,
    EndpointProbe? probe,
    this.autoStart = true,
    this.slots,
  }) : transport = transport ?? IoS3Transport.new,
       _now = now ?? DateTime.now {
    policy = InfraPolicyStore(
      secure: secure,
      transport: this.transport,
      now: _now,
    );
    executor = JobExecutor(
      transport: this.transport,
      bigTransport: bigTransport,
      now: _now,
      probe: probe,
    );
  }

  final SecureStore secure;
  final S3Transport Function() transport;
  final bool autoStart;
  final DateTime Function() _now;
  final Sleeper? sleep;
  final int? slots;
  late final JobExecutor executor;

  /// سیاست زیرساخت مالک: «پردازش کمکی» و زیرساخت‌های غیرفعال (ردیف ۱۳۱).
  late final InfraPolicyStore policy;
  HelperNode? _node;
  S3Settings? _s3;
  final _ready = Completer<void>();

  HelperNode? get node => _node;
  S3Settings? get s3 => _s3;
  Future<void> get ready => _ready.future;

  /// یک بار در شروع برنامه.
  Future<void> init() async {
    if (_node != null) return;
    var id = await _read(HelperKeys.id);
    if (id == null || !helperIdRe.hasMatch(id)) {
      id = randomHex(8);
      await _write(HelperKeys.id, id);
    }
    final n = HelperNode(
      helperId: id,
      transport: transport,
      executor: executor,
      now: _now,
      sleep: sleep,
      version: ownerBuild > 0 ? 'build $ownerBuild' : 'dev',
      slots: slots,
      acceptWork: () => policy.value.helpers,
    );
    _node = n;
    await policy.loadCache();
    if (await _read(HelperKeys.paused) == '1') await n.setPaused(true);
    await reload();
    if (autoStart) {
      n.start();
      policy.start();
    }
    if (!_ready.isCompleted) _ready.complete();
  }

  /// پس از ذخیره/پاک کردن تنظیمات دیتابیس.
  Future<void> reload() async {
    try {
      _s3 = await S3Settings.load(secure);
    } on Object {
      _s3 = null;
    }
    final s = _s3;
    _node?.configure(s == null || s.bucket.isEmpty ? null : s);
    policy.configure(s);
    unawaited(policy.refresh());
  }

  Future<void> setPaused(bool v) async {
    if (v) {
      await _write(HelperKeys.paused, '1');
    } else {
      try {
        await secure.delete(HelperKeys.paused);
      } on Object {
        // بی‌اهمیت
      }
    }
    await _node?.setPaused(v);
  }

  /// فرستادن یک کار: همین دستگاه؛ سرور کمکیِ دیگر فقط هنگام نیاز.
  Future<JobOutcome> submit(
    String kind, [
    Map<String, Object?> params = const {},
  ]) async {
    final s = _s3;
    if (s == null || s.bucket.isEmpty) {
      throw const S3Failure('اول دیتابیس را در همین صفحه تنظیم و ذخیره کنید.');
    }
    return submitJob(
      s3: s,
      transport: transport,
      executor: executor,
      kind: kind,
      params: params,
      selfHelperId: _node?.helperId,
      now: _now,
      sleep: sleep,
      helpersOn: policy.value.helpers,
      // همین دستگاه پر است (کارهای دیگران) ⇒ نیاز به سرور کمکی
      busy: () {
        final n = _node;
        return n != null && n.activeJobs >= n.slots;
      },
    );
  }

  Future<List<HelperPresence>> helpers() async {
    final s = _s3;
    if (s == null || s.bucket.isEmpty) return const [];
    final t = transport();
    try {
      return await readHelpers(s, t);
    } finally {
      t.close();
    }
  }

  Future<String?> _read(String k) async {
    try {
      return await secure.read(k);
    } on Object {
      return null;
    }
  }

  Future<void> _write(String k, String v) async {
    try {
      await secure.write(k, v);
    } on Object {
      // بدون انبار امن: شناسه فقط در همین اجرا
    }
  }

  Future<void> dispose() async {
    policy.dispose();
    await _node?.dispose();
  }
}
