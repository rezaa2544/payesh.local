// موتور هوشمند مالک (ردیف ۱۵۴): پایش همهٔ داده‌ها و ترافیک، رفع خودکار خطاها،
// گم نشدن هیچ داده/کار/دستور، و گزارش تراکنش‌های مشکوک اشتراک.
//
// هر [every] (پیش‌فرض ۶۰ ثانیه) و با دکمهٔ «بررسی اکنون» همهٔ بررسی‌ها اجرا می‌شوند:
//   journal     دستورهای مالک در صف (دیتابیس پاسخ نداده بود)      ⇐ رفع خودکار: اجرای دوباره به همان ترتیب
//   policy      تغییر سیاست زیرساخت که هنوز در دیتابیس ثبت نشده  ⇐ رفع خودکار: ثبت دوباره
//   db          نرخ خطای دیتابیس بالا / زمان پاسخ کند             ⇐ رفع خودکار: بازبینی اتصال (چراغ دیتابیس)
//   route       سیستم‌های کمکی به کمک آمده‌اند (اطلاع)
//   jobs        کار/رزرو/نتیجهٔ ماندهٔ سرور کمکی در صندوقچه      ⇐ رفع خودکار: کار bucket.gc
//   registry    خواندن فهرست مدارس ناموفق است
//   hosts       سرور میزبان مدرسه‌ای بیش از ۲۴ ساعت گزارش نداده
//   fraud       تراکنش مشکوک اشتراک (fraud.dart) — فقط گزارش؛ مالک «بررسی شد» می‌زند
// گزارش رفع‌های خودکار و فهرست «بررسی شد» در انبار امن همین دستگاه می‌ماند.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:payesh_secure/payesh_secure.dart';

import '../helper/helper_box.dart';
import '../helper/helper_service.dart';
import '../infra/load_route.dart';
import '../local/s3_client.dart';
import '../schools/school_registry.dart';
import 'fraud.dart';

abstract final class GuardLevel {
  static const String ok = 'ok';
  static const String info = 'info';
  static const String warning = 'warning';
  static const String danger = 'danger';
}

@immutable
final class GuardFinding {
  const GuardFinding({
    required this.check,
    required this.level,
    required this.titleFa,
    required this.detailFa,
    this.fixedFa,
    this.fraud,
  });
  final String check;
  final String level;
  final String titleFa;
  final String detailFa;

  /// اگر موتور خودش رفع کرد: شرح کار.
  final String? fixedFa;
  final FraudFinding? fraud;

  String get id => fraud != null ? 'fraud:${fraud!.id}' : check;
}

@immutable
final class GuardLogEntry {
  const GuardLogEntry(this.at, this.check, this.textFa);
  final DateTime at;
  final String check;
  final String textFa;
  Map<String, Object?> toJson() => {
    'at': at.toUtc().toIso8601String(),
    'check': check,
    'text': textFa,
  };
  static GuardLogEntry? fromJson(Object? j) {
    if (j is! Map) return null;
    final at = DateTime.tryParse('${j['at']}');
    if (at == null) return null;
    return GuardLogEntry(at, '${j['check'] ?? ''}', '${j['text'] ?? ''}');
  }
}

/// منبع پرداخت‌ها و فهرست مدارس (در آزمون جایگزین می‌شود).
typedef SchoolsLoader = Future<SchoolsView> Function();

class GuardEngine extends ChangeNotifier {
  GuardEngine({
    required this.secure,
    this.registry,
    this.helper,
    this.onDbTrouble,
    SchoolsLoader? loadSchools,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now,
       _loadSchools = loadSchools ?? registry?.load;

  final SecureStore secure;
  final SchoolRegistry? registry;
  final OwnerHelperService? helper;

  /// بازبینی اتصال دیتابیس (مثلاً DbMonitor.refresh).
  final Future<void> Function()? onDbTrouble;
  final SchoolsLoader? _loadSchools;
  final DateTime Function() _now;

  static const String logKey = 'owner.guard.log';
  static const String ackKey = 'owner.guard.ack';
  static const int logMax = 200;
  static const Duration hostSilence = Duration(hours: 24);
  static const Duration staleJob = Duration(hours: 1);

  List<GuardFinding> _findings = const [];
  List<GuardFinding> get findings => _findings;
  List<GuardLogEntry> _log = const [];
  List<GuardLogEntry> get log => _log;
  Set<String> _acked = {};
  DateTime? lastRun;
  bool running = false;
  Timer? _timer;
  bool _disposed = false;
  bool _loaded = false;
  Future<void>? _inflight;

  /// یافته‌های مشکوکی که هنوز «بررسی شد» نخورده‌اند.
  List<GuardFinding> get openFraud => [
    for (final f in _findings)
      if (f.fraud != null && !_acked.contains(f.fraud!.id)) f,
  ];

  bool isAcked(FraudFinding f) => _acked.contains(f.id);

  /// بدترین سطح یافته‌های باز.
  String get level {
    var worst = GuardLevel.ok;
    const order = [
      GuardLevel.ok,
      GuardLevel.info,
      GuardLevel.warning,
      GuardLevel.danger,
    ];
    for (final f in _findings) {
      if (f.fraud != null && _acked.contains(f.fraud!.id)) continue;
      if (order.indexOf(f.level) > order.indexOf(worst)) worst = f.level;
    }
    return worst;
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void start({Duration every = const Duration(seconds: 60)}) {
    _timer ??= Timer.periodic(every, (_) => unawaited(run()));
    unawaited(run());
  }

  Future<void> _loadState() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final t = await secure.read(logKey);
      if (t != null) {
        _log = [
          for (final e in jsonDecode(t) as List) ?GuardLogEntry.fromJson(e),
        ];
      }
    } on Object {
      _log = const [];
    }
    try {
      final t = await secure.read(ackKey);
      if (t != null) _acked = {...(jsonDecode(t) as List).cast<String>()};
    } on Object {
      _acked = {};
    }
  }

  Future<void> _addLog(String check, String text) async {
    final l = [..._log, GuardLogEntry(_now(), check, text)];
    _log = l.length > logMax ? l.sublist(l.length - logMax) : l;
    try {
      await secure.write(
        logKey,
        jsonEncode([for (final e in _log) e.toJson()]),
      );
    } on Object {
      // فقط تا بستن برنامه
    }
  }

  /// «بررسی شد» برای یک تراکنش مشکوک (یا برداشتن آن).
  Future<void> acknowledge(FraudFinding f, {bool acked = true}) async {
    await _loadState();
    if (acked) {
      _acked.add(f.id);
      await _addLog(
        'fraud',
        'بررسی شد: ${f.titleFa} — ${f.paymentIds.join('، ')}',
      );
    } else {
      _acked.remove(f.id);
    }
    try {
      await secure.write(ackKey, jsonEncode(_acked.toList()..sort()));
    } on Object {
      // فقط تا بستن برنامه
    }
    _notify();
  }

  /// یک دور کامل (اجرای هم‌زمان یکی می‌شود).
  Future<void> run() => _inflight ??= _run().whenComplete(() {
    _inflight = null;
  });

  Future<void> _run() async {
    await _loadState();
    running = true;
    _notify();
    final out = <GuardFinding>[];
    Future<void> guard(String check, Future<void> Function() f) async {
      try {
        await f();
      } on Object catch (e) {
        out.add(
          GuardFinding(
            check: check,
            level: GuardLevel.warning,
            titleFa: 'بررسی «$check» کامل نشد',
            detailFa: '$e',
          ),
        );
      }
    }

    await guard('journal', () => _checkJournal(out));
    await guard('policy', () => _checkPolicy(out));
    await guard('db', () => _checkDb(out));
    await guard('jobs', () => _checkJobs(out));
    await guard('schools', () => _checkSchools(out));
    out.sort((a, b) => _rank(a.level).compareTo(_rank(b.level)));
    _findings = out;
    lastRun = _now();
    running = false;
    _notify();
  }

  static int _rank(String l) => switch (l) {
    GuardLevel.danger => 0,
    GuardLevel.warning => 1,
    GuardLevel.info => 2,
    _ => 3,
  };

  Future<void> _checkJournal(List<GuardFinding> out) async {
    final reg = registry;
    if (reg == null) return;
    final before = await reg.pendingCommands();
    if (before.isEmpty) return;
    final r = await reg.replayJournal();
    if (r.done > 0) {
      await _addLog('journal', '${r.done} دستور در صف در دیتابیس ثبت شد.');
    }
    if (r.dropped > 0) {
      await _addLog(
        'journal',
        '${r.dropped} دستور دیگر معتبر نبود و کنار گذاشته شد.',
      );
    }
    out.add(
      GuardFinding(
        check: 'journal',
        level: r.left > 0 ? GuardLevel.warning : GuardLevel.ok,
        titleFa: r.left > 0
            ? '${r.left} دستور مالک در صف است'
            : 'دستورهای در صف ثبت شدند',
        detailFa: r.left > 0
            ? 'دیتابیس هنوز پاسخ نمی‌دهد؛ دستورها روی همین دستگاه امن مانده‌اند و '
                  'هر دقیقه دوباره فرستاده می‌شوند.'
            : 'هیچ دستوری گم نشد.',
        fixedFa: r.done > 0 ? '${r.done} دستور ثبت شد' : null,
      ),
    );
  }

  Future<void> _checkPolicy(List<GuardFinding> out) async {
    final p = helper?.policy;
    if (p == null || !p.pending || !p.configured) return;
    await p.refresh();
    final fixed = !p.pending;
    if (fixed) {
      await _addLog('policy', 'تغییر سیاست زیرساخت در دیتابیس ثبت شد.');
    }
    out.add(
      GuardFinding(
        check: 'policy',
        level: fixed ? GuardLevel.ok : GuardLevel.warning,
        titleFa: fixed
            ? 'سیاست زیرساخت ثبت شد'
            : 'تغییر سیاست زیرساخت هنوز ثبت نشده',
        detailFa: fixed
            ? 'همهٔ پنل‌ها و سرورهای مدرسه تا یک دقیقه پیروی می‌کنند.'
            : (p.error ?? 'دیتابیس در دسترس نیست؛ دوباره تلاش می‌شود.'),
        fixedFa: fixed ? 'ثبت دوباره' : null,
      ),
    );
  }

  Future<void> _checkDb(List<GuardFinding> out) async {
    final r = helper?.router;
    if (r == null) return;
    await r.tick();
    final db = r.db;
    if (db.n >= routeThresholds.minSamples && db.err > routeThresholds.errHi) {
      await onDbTrouble?.call();
      await _addLog(
        'db',
        'نرخ خطای دیتابیس ${(db.err * 100).round()}٪ بود؛ اتصال بازبینی شد.',
      );
      out.add(
        GuardFinding(
          check: 'db',
          level: GuardLevel.danger,
          titleFa: 'خطای دیتابیس بالاست',
          detailFa:
              '${(db.err * 100).round()}٪ درخواست‌ها در یک دقیقهٔ اخیر ناموفق بودند. '
              'تلاش دوباره خودکار است و هیچ دستوری گم نمی‌شود.',
          fixedFa: 'بازبینی اتصال',
        ),
      );
    } else if (db.n >= routeThresholds.minSamples &&
        db.p95 > routeThresholds.hiMs) {
      out.add(
        GuardFinding(
          check: 'db',
          level: GuardLevel.warning,
          titleFa: 'دیتابیس کند است',
          detailFa: 'زمان پاسخ p95: ${db.p95} میلی‌ثانیه.',
        ),
      );
    }
    if (r.state.level > 0) {
      out.add(
        GuardFinding(
          check: 'route',
          level: GuardLevel.info,
          titleFa: 'پلهٔ کمکی فعال است',
          detailFa: routeReasonFa(r.state.reason),
        ),
      );
    }
  }

  Future<void> _checkJobs(List<GuardFinding> out) async {
    final h = helper;
    final s = h?.s3;
    if (h == null || s == null || s.bucket.isEmpty) return;
    final t = h.transport();
    List<S3Object> objs;
    try {
      (objs, _) = await s3ListObjects(s, t, '${helperRoot}jobs/', maxPages: 2);
    } finally {
      t.close();
    }
    final now = _now();
    final stale = [
      for (final o in objs)
        if (o.modified != null && now.difference(o.modified!) > staleJob) o,
    ];
    if (stale.isEmpty) return;
    var fixed = false;
    try {
      final r = await h.submit('bucket.gc');
      fixed = r.ok;
    } on Object {
      fixed = false;
    }
    if (fixed) {
      await _addLog(
        'jobs',
        '${stale.length} فایل ماندهٔ صف کارها پاک‌سازی شد.',
      );
    }
    out.add(
      GuardFinding(
        check: 'jobs',
        level: fixed ? GuardLevel.ok : GuardLevel.warning,
        titleFa: '${stale.length} کار مانده در صف سرور کمکی',
        detailFa:
            'کار یا نتیجه‌ای بیش از یک ساعت در صندوقچه مانده بود؛ همان کارها '
            'روی سرور فرستنده انجام شده‌اند (پردازش هرگز متوقف نمی‌شود).',
        fixedFa: fixed ? 'پاک‌سازی' : null,
      ),
    );
  }

  Future<void> _checkSchools(List<GuardFinding> out) async {
    final load = _loadSchools;
    if (load == null) return;
    final v = await load();
    if (!v.connected) {
      out.add(
        GuardFinding(
          check: 'registry',
          level: GuardLevel.warning,
          titleFa: 'فهرست مدارس خوانده نشد',
          detailFa: v.error ?? 'دیتابیس در دسترس نیست.',
        ),
      );
      return;
    }
    final now = _now();
    for (final sch in v.schools) {
      final id = '${sch['id']}';
      if (sch['active'] == false) continue;
      final ack = v.acks[id];
      final at = DateTime.tryParse('${ack?['at'] ?? ''}');
      if (ack == null || at == null) continue;
      if (now.difference(at) > hostSilence) {
        out.add(
          GuardFinding(
            check: 'hosts',
            level: GuardLevel.warning,
            titleFa: 'سرور مدرسهٔ «${sch['name'] ?? id}» گزارش نمی‌دهد',
            detailFa:
                'آخرین گزارش ${now.difference(at).inHours} ساعت پیش بود؛ '
                'سرور میزبان خاموش است یا به دیتابیس نمی‌رسد.',
          ),
        );
      }
    }
    for (final f in suspiciousPayments(v.payments, v.settings, now: now)) {
      out.add(
        GuardFinding(
          check: 'fraud',
          level: switch (f.severity) {
            FraudSeverity.high => GuardLevel.danger,
            FraudSeverity.medium => GuardLevel.warning,
            _ => GuardLevel.info,
          },
          titleFa: f.titleFa,
          detailFa: f.detailFa,
          fraud: f,
        ),
      );
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}
