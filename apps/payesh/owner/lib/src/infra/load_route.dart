// مسیر بار (ردیف ۱۵۳): سه حالت معماری و بالا/پایین رفتن خودکار با زمان پاسخ.
//
// همان قرارداد server/load-route.js (بردارهای docs/cloud/contracts/load-route-vectors.json):
//   db        فقط دیتابیس؛ سیستم‌های پنل مالک پردازشی نمی‌گیرند.
//   helpers   دیتابیس اصلی؛ سیستم‌های پنل مالک (هر کدام کلید جدا) فقط وقتی دیتابیس کمک بخواهد.
//   external  سرور بیرونی اصلی ⇐ زیر بار: دیتابیس هم ⇐ باز زیر بار: سیستم‌های کمکی.
//             سرور بیرونی تنظیم‌نشده یا در دسترس نیست ⇒ همان زنجیرهٔ helpers.
// سنجه: p95 زمان پاسخ و نرخ خطا در ۶۰ ثانیهٔ اخیر. بالا رفتن فوری (یک پله در هر نمونه)؛
// پایین آمدن فقط پس از ۶۰ ثانیه آرامش پیوستهٔ همان زیرساختی که باعث بالا رفتن شد.

import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../monitor/net_meter.dart';

abstract final class ArchModes {
  static const String db = 'db';
  static const String helpers = 'helpers';
  static const String external = 'external';
  static const List<String> all = [db, helpers, external];
}

abstract final class RouteTiers {
  static const String external = 'external';
  static const String db = 'db';
  static const String helpers = 'helpers';
}

@immutable
final class RouteThresholds {
  const RouteThresholds({
    this.hiMs = 1200,
    this.loMs = 500,
    this.errHi = 0.2,
    this.errLo = 0.05,
    this.holdMs = 60000,
    this.minSamples = 5,
    this.windowMs = 60000,
    this.windowMax = 200,
  });
  final int hiMs;
  final int loMs;
  final double errHi;
  final double errLo;
  final int holdMs;
  final int minSamples;
  final int windowMs;
  final int windowMax;

  Map<String, Object?> toJson() => {
    'hi_ms': hiMs,
    'lo_ms': loMs,
    'err_hi': errHi,
    'err_lo': errLo,
    'hold_ms': holdMs,
    'min_samples': minSamples,
    'window_ms': windowMs,
    'window_max': windowMax,
  };
}

const RouteThresholds routeThresholds = RouteThresholds();

/// سنجهٔ یک زیرساخت در پنجرهٔ اخیر.
@immutable
final class TierStats {
  const TierStats({
    this.n = 0,
    this.p95 = 0,
    this.avg = 0,
    this.err = 0,
    this.perMin = 0,
    this.busy = false,
    this.ok = true,
  });
  final int n;
  final int p95;
  final int avg;
  final double err;
  final int perMin;
  final bool busy;

  /// فقط برای سرور بیرونی: آخرین بررسی موفق بود.
  final bool ok;

  static TierStats? fromJson(Object? j) {
    if (j is! Map) return null;
    num v(String k) => (j[k] as num?) ?? 0;
    return TierStats(
      n: v('n').toInt(),
      p95: v('p95').toInt(),
      avg: v('avg').toInt(),
      err: v('err').toDouble(),
      perMin: v('per_min').toInt(),
      busy: j['busy'] == true,
      ok: j['ok'] != false,
    );
  }
}

String modeOfPlain(Map<String, Object?>? p) {
  final m = p?['mode'];
  if (m is String && ArchModes.all.contains(m)) return m;
  return p?['helpers'] == false ? ArchModes.db : ArchModes.helpers;
}

List<String> chainFor(String mode, {required bool extOk}) {
  if (mode == ArchModes.db) return const [RouteTiers.db];
  if (mode == ArchModes.external && extOk) {
    return const [RouteTiers.external, RouteTiers.db, RouteTiers.helpers];
  }
  return const [RouteTiers.db, RouteTiers.helpers];
}

bool tierStressed(TierStats? m, RouteThresholds t) {
  if (m == null) return false;
  if (m.busy) return true;
  if (m.err > t.errHi) return true;
  return m.n >= t.minSamples && m.p95 > t.hiMs;
}

bool tierCalm(TierStats? m, RouteThresholds t) {
  if (m == null) return true;
  if (m.busy || m.err >= t.errLo) return false;
  return m.n < t.minSamples || m.p95 < t.loMs;
}

/// وضعیت مسیر بار (همان شیء state در Node).
@immutable
final class RouteState {
  const RouteState({
    this.chain = const [RouteTiers.db],
    this.level = 0,
    this.changedMs = 0,
    this.calmMs,
    this.reason = 'start',
  });
  final List<String> chain;
  final int level;
  final int changedMs;
  final int? calmMs;
  final String reason;

  String get primary => chain.first;
  List<String> get active => chain.sublist(0, level + 1);
  bool get helpersActive => active.contains(RouteTiers.helpers);

  Map<String, Object?> toJson() => {
    'v': 1,
    'chain': chain,
    'level': level,
    'changed_ms': changedMs,
    'calm_ms': calmMs,
    'reason': reason,
  };
}

/// یک نمونه: [ext] = null یعنی سرور بیرونی بررسی نشده/تنظیم نشده؛
/// [helpers] = تعداد سیستم‌های کمکیِ فعال (null = نامعلوم ⇒ فرض: هست).
@immutable
final class RouteSample {
  const RouteSample({
    required this.nowMs,
    required this.mode,
    required this.db,
    this.ext,
    this.helpers,
  });
  final int nowMs;
  final String mode;
  final TierStats? ext;
  final TierStats db;
  final int? helpers;
}

bool _sameChain(List<String> a, List<String> b) => listEquals(a, b);

/// یک گام (تابع خالص؛ همان `step` در server/load-route.js).
RouteState routeStep(
  RouteState? prev,
  RouteSample s, [
  RouteThresholds t = routeThresholds,
]) {
  final st = prev ?? const RouteState();
  final now = s.nowMs;
  final extOk = s.ext?.ok ?? false;
  final mode = ArchModes.all.contains(s.mode) ? s.mode : ArchModes.helpers;
  final chain = chainFor(mode, extOk: extOk);
  var level = st.level;
  var changed = st.changedMs;
  var calm = st.calmMs;
  var reason = st.reason;
  if (!_sameChain(chain, st.chain)) {
    level = 0;
    changed = now;
    calm = null;
    reason = s.mode == ArchModes.external && !extOk ? 'external_down' : 'mode';
  }
  TierStats? metric(String tier) => switch (tier) {
    RouteTiers.external => s.ext,
    RouteTiers.db => s.db,
    _ => null,
  };
  final last = chain[level];
  if (level < chain.length - 1 && tierStressed(metric(last), t)) {
    final next = chain[level + 1];
    if (next == RouteTiers.helpers && s.helpers == 0) {
      reason = 'no_helpers';
    } else {
      level += 1;
      changed = now;
      calm = null;
      reason = 'escalate:$last';
    }
  } else if (level > 0) {
    final trigger = chain[level - 1];
    if (tierCalm(metric(trigger), t)) {
      calm ??= now;
      if (now - calm >= t.holdMs) {
        level -= 1;
        changed = now;
        calm = null;
        reason = 'recovered:$trigger';
      }
    } else {
      calm = null;
    }
  }
  return RouteState(
    chain: chain,
    level: level,
    changedMs: changed,
    calmMs: calm,
    reason: reason,
  );
}

/// p95 به روش «رتبهٔ نزدیک».
int p95Of(List<int> values) {
  if (values.isEmpty) return 0;
  final a = [...values]..sort();
  return a[max(0, (0.95 * a.length).ceil() - 1)];
}

/// پنجرهٔ لغزان زمان پاسخ و خطا (همان LatencyWindow در Node).
final class LatencyWindow {
  LatencyWindow([this.t = routeThresholds]);
  final RouteThresholds t;
  final List<(int ms, bool ok, int at)> _items = [];

  void record(int ms, {required bool ok, required int atMs}) {
    _items.add((max(0, ms), ok, atMs));
    if (_items.length > t.windowMax) {
      _items.removeRange(0, _items.length - t.windowMax);
    }
  }

  TierStats stats(int nowMs, {bool busy = false}) {
    final from = nowMs - t.windowMs;
    _items.removeWhere((x) => x.$3 < from);
    final n = _items.length;
    final okMs = [
      for (final x in _items)
        if (x.$2) x.$1,
    ];
    final errors = n - okMs.length;
    return TierStats(
      n: n,
      p95: p95Of(okMs),
      avg: okMs.isEmpty
          ? 0
          : (okMs.reduce((a, b) => a + b) / okMs.length).round(),
      err: n == 0 ? 0 : (errors / n * 1000).round() / 1000,
      perMin: (n * 60000 / t.windowMs).round(),
      busy: busy,
    );
  }

  void clear() => _items.clear();
}

/// نتیجهٔ بررسی سرور بیرونی.
typedef ExternalProbe = Future<({bool ok, int ms})> Function(Uri healthz);

/// مسیر بار همین پنل مالک: هر [every] یک گام با سنجه‌های واقعی همین دستگاه.
/// تصمیم «سیستم کمکی لازم است؟» در ارسال کارها ([OwnerHelperService.submit]) از همین‌جا می‌آید.
class LoadRouter extends ChangeNotifier {
  LoadRouter({
    required this.policy,
    this.helpersOnline,
    this.probe,
    this.busy,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  /// حالت و نشانی سرور بیرونی از سیاست زیرساخت.
  final ({String mode, String external}) Function() policy;

  /// تعداد سیستم‌های کمکیِ فعال و روشن (null = نامعلوم).
  final Future<int?> Function()? helpersOnline;
  final ExternalProbe? probe;
  final bool Function()? busy;
  final DateTime Function() _now;

  final LatencyWindow ext = LatencyWindow();
  RouteState _state = const RouteState();
  RouteState get state => _state;
  TierStats db = const TierStats();
  TierStats? external;
  int? helpers;
  String _extUrl = '';
  int _extAt = -1 << 62;
  bool _extOk = false;
  int _helpersAt = -1 << 62;
  Timer? _timer;
  bool _disposed = false;
  Future<void>? _inflight;

  static const int extProbeMs = 30000;
  static const int helpersEveryMs = 30000;

  void start({Duration every = const Duration(seconds: 5)}) {
    _timer ??= Timer.periodic(every, (_) => unawaited(tick()));
    unawaited(tick());
  }

  Future<void> tick() => _inflight ??= _tick().whenComplete(() {
    _inflight = null;
  });

  Future<void> _tick() async {
    final now = _now().millisecondsSinceEpoch;
    final p = policy();
    final h = helpersOnline;
    if (h != null && now - _helpersAt >= helpersEveryMs) {
      _helpersAt = now;
      try {
        helpers = await h();
      } on Object {
        helpers = null;
      }
    }
    TierStats? extStats;
    final url = Uri.tryParse(p.external.trim());
    if (p.mode == ArchModes.external &&
        url != null &&
        url.hasScheme &&
        url.host.isNotEmpty) {
      final key = url.toString();
      final pr = probe;
      if (pr != null && (key != _extUrl || now - _extAt >= extProbeMs)) {
        if (key != _extUrl) ext.clear();
        _extUrl = key;
        _extAt = now;
        try {
          final r = await pr(healthzOf(url));
          _extOk = r.ok;
          ext.record(r.ms, ok: r.ok, atMs: now);
        } on Object {
          _extOk = false;
          ext.record(0, ok: false, atMs: now);
        }
      }
      final es = ext.stats(now);
      extStats = TierStats(
        n: es.n,
        p95: es.p95,
        avg: es.avg,
        err: es.err,
        perMin: es.perMin,
        ok: _extOk && now - _extAt < 3 * extProbeMs,
      );
    }
    external = extStats;
    db = NetMeter.of(NetMeter.db).window
        .stats(now, busy: busy?.call() ?? false);
    _state = routeStep(
      _state,
      RouteSample(
        nowMs: now,
        mode: p.mode,
        db: db,
        ext: extStats,
        helpers: helpers,
      ),
    );
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}

/// نشانی بررسی سرور بیرونی: `<url>/healthz`.
Uri healthzOf(Uri base) {
  final path = base.path.replaceAll(RegExp(r'/+$'), '');
  return base.replace(path: '$path/healthz', query: null, fragment: null);
}

/// عنوان فارسی هر زیرساخت در زنجیره.
const Map<String, String> routeTierTitles = {
  RouteTiers.external: 'سرور بیرونی',
  RouteTiers.db: 'دیتابیس',
  RouteTiers.helpers: 'سیستم‌های کمکی',
};

const Map<String, String> archModeTitles = {
  ArchModes.db: 'فقط دیتابیس',
  ArchModes.helpers: 'دیتابیس + سیستم‌های پنل مالک (کمکی)',
  ArchModes.external: 'سرور بیرونی',
};

/// توضیح فارسی دلیل آخرین تغییر مسیر.
String routeReasonFa(String reason) {
  if (reason.startsWith('escalate:')) {
    final t = routeTierTitles[reason.substring(9)] ?? reason.substring(9);
    return 'زمان پاسخ یا خطای «$t» بالا رفت؛ پلهٔ بعد به کمک آمد.';
  }
  if (reason.startsWith('recovered:')) {
    final t = routeTierTitles[reason.substring(10)] ?? reason.substring(10);
    return '«$t» یک دقیقه آرام بود؛ یک پله برگشت.';
  }
  return switch (reason) {
    'no_helpers' => 'دیتابیس کمک می‌خواهد ولی فعلاً سیستم کمکیِ روشنی نیست؛ همین سیستم ادامه می‌دهد.',
    'external_down' => 'سرور بیرونی در دسترس نیست؛ دیتابیس مسیر اصلی شد.',
    'mode' => 'حالت معماری تغییر کرد.',
    _ => 'همه‌چیز عادی است؛ فقط زیرساخت اصلی کار می‌کند.',
  };
}
