// سیاست زیرساخت (ردیف ۱۳۱): مالک تعیین می‌کند
//   • «پردازش کمکی» (سیستم‌هایی که پنل مدیریت روی آن‌ها نصب است) روشن باشد یا نه؛
//   • کدام زیرساخت ثبت‌شده در «زیرساخت» غیرفعال است.
// یک پاکت رمزشده در خود دیتابیس: payesh/control/infra-policy.json (همان پاکت سرور کمکی،
// kind=payesh-infra-policy، rev = at). همهٔ پنل‌های مالک و سرورهای مدرسه (server/helper-jobs.js)
// حداکثر ۶۰ ثانیه بعد پیروی می‌کنند. نسخهٔ این دستگاه در انبار امن هم می‌ماند تا بدون اینترنت
// هم معتبر باشد؛ تغییری که هنوز به دیتابیس نرسیده «در انتظار ثبت» است و با وصل شدن فرستاده می‌شود.
// اگر دو دستگاه هم‌زمان تغییر بدهند، تغییر تازه‌تر (at بزرگ‌تر) برنده است.

import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:payesh_secure/payesh_secure.dart';

import '../helper/helper_box.dart';
import '../local/s3_client.dart';

const String infraPolicyKey = '${helperRoot}control/infra-policy.json';
const String infraPolicyCacheKey = 'owner.infra.policy';
final RegExp _serviceIdRe = RegExp(r'^[0-9A-Za-z_.:-]{1,80}$');

@immutable
final class InfraPolicy {
  const InfraPolicy({
    this.helpers = true,
    this.off = const <String>{},
    this.at = 0,
  });

  /// پردازش کمکی (پیش‌فرض روشن؛ فقط هنگام نیاز به کار می‌رود).
  final bool helpers;

  /// شناسهٔ زیرساخت‌های غیرفعال.
  final Set<String> off;

  /// زمان تغییر (میلی‌ثانیه) = rev پاکت.
  final int at;

  bool serviceOn(String id) => !off.contains(id);

  Map<String, Object?> toPlain() => {
    'v': 1,
    'helpers': helpers,
    'off': off.toList()..sort(),
    'at': at,
  };

  static InfraPolicy? fromPlain(Map<String, Object?> p) {
    final h = p['helpers'];
    final off = p['off'];
    final at = p['at'];
    if (p['v'] != 1 || h is! bool || off is! List || at is! int || at < 0) {
      return null;
    }
    if (off.length > 500) return null;
    final ids = <String>{};
    for (final x in off) {
      if (x is! String || !_serviceIdRe.hasMatch(x)) return null;
      ids.add(x);
    }
    return InfraPolicy(helpers: h, off: ids, at: at);
  }

  @override
  bool operator ==(Object other) =>
      other is InfraPolicy &&
      other.helpers == helpers &&
      other.at == at &&
      setEquals(other.off, off);

  @override
  int get hashCode => Object.hash(helpers, at, Object.hashAllUnordered(off));
}

/// سیاست جاری + همگام‌سازی با دیتابیس.
class InfraPolicyStore extends ChangeNotifier {
  InfraPolicyStore({
    required this.secure,
    required this.transport,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  final SecureStore secure;
  final S3Transport Function() transport;
  final DateTime Function() _now;

  InfraPolicy _value = const InfraPolicy();
  InfraPolicy get value => _value;

  bool _pending = false;

  /// تغییری که هنوز در دیتابیس ثبت نشده.
  bool get pending => _pending;

  /// خطای آخرین همگام‌سازی (null = موفق یا هنوز انجام نشده).
  String? error;
  DateTime? syncedAt;

  S3Settings? _s3;
  bool get configured => _s3 != null;
  Timer? _timer;
  Future<void>? _inflight;
  bool _disposed = false;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// نسخهٔ این دستگاه (پیش از هر چیز، بدون شبکه).
  Future<void> loadCache() async {
    try {
      final t = await secure.read(infraPolicyCacheKey);
      if (t == null) return;
      final m = jsonDecode(t);
      if (m is! Map) return;
      final p = InfraPolicy.fromPlain(m.cast<String, Object?>());
      if (p == null) return;
      _value = p;
      _pending = m['pending'] == true;
      _notify();
    } on Object {
      // بدون نسخهٔ ذخیره‌شده ⇒ پیش‌فرض
    }
  }

  Future<void> _saveCache() async {
    try {
      await secure.write(
        infraPolicyCacheKey,
        jsonEncode({..._value.toPlain(), if (_pending) 'pending': true}),
      );
    } on Object {
      // فقط تا بستن برنامه
    }
  }

  /// پس از ذخیره/پاک کردن تنظیمات دیتابیس.
  void configure(S3Settings? s) {
    _s3 = s == null || s.bucket.isEmpty ? null : s;
  }

  /// خواندن دوره‌ای (هر [every]).
  void start({Duration every = const Duration(seconds: 60)}) {
    _timer ??= Timer.periodic(every, (_) => unawaited(refresh()));
  }

  /// همگام‌سازی با دیتابیس (درخواست‌های هم‌زمان یکی می‌شوند).
  Future<void> refresh() =>
      _inflight ??= _sync().whenComplete(() => _inflight = null);

  Future<void> _sync() async {
    final s = _s3;
    if (s == null) return;
    final t = transport();
    try {
      final text = await s3GetText(s, t, infraPolicyKey);
      InfraPolicy? remote;
      if (text != null) {
        final p = await openHelper(s.secretKey, HelperKinds.policy, text);
        remote = p == null ? null : InfraPolicy.fromPlain(p);
      }
      if (_pending && (remote == null || remote.at <= _value.at)) {
        await s3PutJson(
          s,
          t,
          infraPolicyKey,
          await sealHelper(
            s.secretKey,
            HelperKinds.policy,
            _value.at,
            _value.toPlain(),
          ),
        );
        _pending = false;
      } else if (remote != null) {
        // دیتابیس منبع است؛ تغییر تازه‌ترِ دستگاه دیگر هم برنده است
        _value = remote;
        _pending = false;
      }
      error = null;
      syncedAt = _now();
      await _saveCache();
    } on S3Failure catch (e) {
      error = e.messageFa;
    } on Object catch (e) {
      error = '$e';
    } finally {
      t.close();
      _notify();
    }
  }

  int _nextAt() => max(_now().millisecondsSinceEpoch, _value.at + 1);

  Future<void> setHelpers(bool on) =>
      _set(InfraPolicy(helpers: on, off: _value.off, at: _nextAt()));

  Future<void> setService(String id, bool on) {
    if (!_serviceIdRe.hasMatch(id)) return Future.value();
    final off = {..._value.off};
    if (on) {
      off.remove(id);
    } else {
      off.add(id);
    }
    return _set(InfraPolicy(helpers: _value.helpers, off: off, at: _nextAt()));
  }

  Future<void> _set(InfraPolicy p) async {
    _value = p;
    _pending = true;
    _notify();
    await _saveCache();
    await refresh();
    // اگر همگام‌سازیِ هم‌زمانی پیش از این تغییر شروع شده بود
    if (_pending && _s3 != null) await refresh();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    super.dispose();
  }
}
