// سرور کمکیِ همین دستگاه در برنامه: شناسهٔ پایدار، «توقف موقت» و پیروی از تنظیمات دیتابیس.
// پیش‌فرض: روشن. تا وقتی برنامه باز است (حتی کوچک‌شده) کار می‌کند.

import 'dart:async';

import 'package:payesh_secure/payesh_secure.dart';

import '../infra/infra_policy.dart';
import '../infra/load_route.dart';
import '../local/local_platform.dart' show defaultEndpointCheck;
import '../local/s3_client.dart';
import '../power/activity.dart';
import '../update/owner_update.dart';
import 'helper_box.dart';
import 'helper_jobs.dart';
import 'helper_node.dart';

abstract final class HelperKeys {
  static const String id = 'owner.helper.id';
  static const String paused = 'owner.helper.paused';

  /// ردیف ۱۷۸: سقف درصد پردازش سرور کمکیِ همین سیستم (نبود ⇒ بدون سقف محلی).
  static const String cpu = 'owner.helper.cpu';
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
    ExternalProbe? externalProbe,
  }) : transport = transport ?? IoS3Transport.new,
       _now = now ?? DateTime.now {
    policy = InfraPolicyStore(
      secure: secure,
      transport: this.transport,
      now: _now,
    );
    router = LoadRouter(
      policy: () => (mode: policy.value.mode, external: policy.value.external),
      helpersOnline: _helpersAvailable,
      probe: externalProbe ?? _probeExternal,
      busy: _nodeBusy,
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

  /// مسیر بار همین پنل (ردیف ۱۵۳): کِی سیستم‌های کمکی به کار گرفته شوند.
  late final LoadRouter router;
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
      // ردیف ۱۷۷: سقف درصد CPU مالک ⇒ تعداد کارهای هم‌زمان (null ⇒ پیش‌فرض قدیمی)
      // ردیف ۱۷۸: کمترینِ سقف همین سیستم و سقف کلی «کنترل پردازش»
      slotsFor: slots != null ? null : () => slotsForCpu(effectiveCpu),
      restFor: (work) => restForCpu(work, effectiveCpu),
      processingPaused: () => policy.value.procPaused,
      // ردیف ۱۵۳: حالت «فقط دیتابیس» یا کلید خاموشِ همین سیستم ⇒ کار دیگران را برنمی‌دارد؛
      // ردیف ۱۷۷: «توقف پردازش» مالک هم همین‌طور
      acceptWork: () => policy.value.helpers && policy.value.helperOn(id!),
    );
    // ردیف ۱۷۷: «توقف پردازش» به همهٔ کارهای پس‌زمینهٔ همین پنل هم می‌رسد (PacedTimer.heavy)
    void follow() =>
        OwnerActivity.instance.setProcessingPaused(policy.value.procPaused);
    policy.addListener(follow);
    follow();
    _node = n;
    await policy.loadCache();
    if (await _read(HelperKeys.paused) == '1') await n.setPaused(true);
    _localCpu = _parseCpu(await _read(HelperKeys.cpu));
    await reload();
    if (autoStart) {
      n.start();
      policy.start();
      router.start();
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

  int? _localCpu;

  /// ردیف ۱۷۸: سقف درصد پردازش سرور کمکیِ همین سیستم (null ⇒ بدون سقف محلی).
  int? get localCpu => _localCpu;

  /// سقفی که واقعاً اعمال می‌شود: کمترینِ سقف همین سیستم و سقف کلی «کنترل پردازش».
  int? get effectiveCpu => minCpu(_localCpu, policy.value.cpuPercent);

  static int? _parseCpu(String? v) {
    final n = int.tryParse(v ?? '');
    if (n == null || n >= 100) return null;
    return n.clamp(minCpuPercent, 99);
  }

  /// ردیف ۱۷۸: تنظیم سقف پردازش همین سیستم (null یا ۱۰۰ ⇒ بدون سقف؛ ماندگار).
  Future<void> setLocalCpu(int? pct) async {
    _localCpu = _parseCpu(pct?.toString());
    if (_localCpu == null) {
      try {
        await secure.delete(HelperKeys.cpu);
      } on Object {
        // بی‌اهمیت
      }
    } else {
      await _write(HelperKeys.cpu, '$_localCpu');
    }
    _node?.refresh();
  }

  /// ردیف ۱۷۸: «شروع» در کارت پردازش کمکی — هر چه جلوی کار همین سیستم را گرفته باز می‌شود:
  /// توقف همین سیستم، «توقف پردازش» کلی، خاموشی پردازش کمکی (حالت «فقط دیتابیس» ⇒ حالت
  /// سیستم‌های کمکی) و کلید خاموش همین سیستم.
  Future<void> startHelper() async {
    await setPaused(false);
    final v = policy.value;
    if (v.procPaused) await policy.setProcessing(paused: false);
    if (!policy.value.helpers) await policy.setHelpers(true);
    final id = _node?.helperId;
    if (id != null && !policy.value.helperOn(id)) {
      await policy.setHelperOn(id, true);
    }
    _node?.refresh();
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
    final r = await submitJob(
      s3: s,
      transport: transport,
      executor: executor,
      kind: kind,
      params: params,
      selfHelperId: _node?.helperId,
      now: _now,
      sleep: sleep,
      helpersOn: policy.value.helpers,
      // همین دستگاه پر است یا مسیر بار سیستم‌های کمکی را به کار گرفته ⇒ نیاز به سرور کمکی
      busy: () => _nodeBusy() || router.state.helpersActive,
      helperAllowed: policy.value.helperOn,
    );
    _node?.noteSubmitted(kind, r);
    return r;
  }

  bool _nodeBusy() {
    final n = _node;
    return n != null && n.activeJobs >= n.slots;
  }

  /// سیستم‌های کمکیِ فعال و روشن به‌جز همین دستگاه (برای مسیر بار).
  Future<int?> _helpersAvailable() async {
    final s = _s3;
    if (s == null || s.bucket.isEmpty) return null;
    final at = _now();
    final list = await helpers();
    return list
        .where(
          (h) =>
              h.onlineAt(at) &&
              h.helperId != _node?.helperId &&
              policy.value.helperOn(h.helperId),
        )
        .length;
  }

  static Future<({bool ok, int ms})> _probeExternal(Uri url) async {
    final r = await defaultEndpointCheck({'url': url.toString()});
    return (ok: r.ok, ms: r.latencyMs ?? 0);
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
    router.dispose();
    policy.dispose();
    await _node?.dispose();
  }
}
