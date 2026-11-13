// پایش زنده و لحظه‌ای زیرساخت‌ها در داشبورد (ردیف ۱۳۰).
//
// برای هر زیرساخت سه چیز، همه واقعی و از همین دستگاه:
//   • سرعت: تأخیر رفت‌وبرگشت (ms) با یک درخواست کوچک هر ۵ ثانیه + سرعت دانلود پاسخ‌های بزرگ؛
//   • ترافیک: بایت ارسال/دریافت در ثانیه (هر ثانیه) و مجموع؛
//   • درصد استفاده از ظرفیت: دیتابیس ⇐ مجموع اندازهٔ فایل‌های صندوقچه نسبت به ظرفیتی که مالک
//     تعیین می‌کند؛ سرور ⇐ CPU / حافظه / دیسک از /metrics همان سرور (یا آخرین عدد ثبت‌شدهٔ
//     دستی [M]/[E] در صفحهٔ «زیرساخت»).
//
// پایش فقط وقتی داشبورد باز است کار می‌کند (attach/detach) و هیچ چیزی در دیتابیس نمی‌نویسد.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:payesh_secure/payesh_secure.dart';

import '../local/local_platform.dart'
    show CheckOutcome, EndpointChecker, defaultEndpointCheck;
import '../local/s3_client.dart';
import 'net_meter.dart';

/// کلید ظرفیت دیتابیس (بایت) در انبار امن دستگاه.
const String dbCapacityKey = 'owner.monitor.db-capacity';

/// خروجی یک بار خواندن /metrics (قالب متنی Prometheus).
final class MetricsScrape {
  const MetricsScrape({
    required this.values,
    required this.latencyMs,
    this.bytes = 0,
  });
  final Map<String, double> values;
  final int latencyMs;
  final int bytes;
}

typedef MetricsFetcher = Future<MetricsScrape> Function(Uri url);

/// نام سنجه ⇒ مجموع مقدارهایش (برچسب‌ها کنار گذاشته می‌شوند). خط‌های نامعتبر نادیده.
Map<String, double> parsePrometheus(String text) {
  final out = <String, double>{};
  for (final raw in const LineSplitter().convert(text)) {
    final line = raw.trim();
    if (line.isEmpty || line.startsWith('#')) continue;
    final m = RegExp(r'^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)')
        .firstMatch(line);
    if (m == null) continue;
    final v = double.tryParse(m.group(3)!);
    if (v == null || !v.isFinite) continue;
    final name = m.group(1)!;
    out[name] = (out[name] ?? 0) + v;
  }
  return out;
}

/// خواندن واقعی /metrics: ۵ ثانیه، حداکثر ۵۱۲KB، بدون دنبال کردن تغییر مسیر.
Future<MetricsScrape> defaultMetricsFetch(Uri url) async {
  final sw = Stopwatch()..start();
  const limit = Duration(seconds: 5);
  final client = HttpClient(context: ownerTrustContext())
    ..connectionTimeout = limit;
  try {
    final req = await client.getUrl(url).timeout(limit);
    req.followRedirects = false;
    final res = await req.close().timeout(limit);
    final latency = sw.elapsedMilliseconds;
    if (res.statusCode != 200) {
      unawaited(res.drain<void>().catchError((_) {}));
      throw HttpException('status ${res.statusCode}');
    }
    final b = BytesBuilder(copy: false);
    await for (final chunk in res.timeout(limit)) {
      b.add(chunk);
      if (b.length > 512 * 1024) throw const HttpException('too large');
    }
    final bytes = b.takeBytes();
    return MetricsScrape(
      values: parsePrometheus(utf8.decode(bytes, allowMalformed: true)),
      latencyMs: latency,
      bytes: bytes.length,
    );
  } finally {
    client.close(force: true);
  }
}

/// یک سری زمانی کوتاه (پنجرهٔ لغزان) برای نمودار کوچک.
final class LiveSeries {
  LiveSeries([this.capacity = 60]);
  final int capacity;
  final List<double> _v = [];
  List<double> get values => List.unmodifiable(_v);
  double get peak => _v.isEmpty ? 0 : _v.reduce(max);
  void add(double v) {
    _v.add(v.isFinite && v > 0 ? v : 0);
    if (_v.length > capacity) _v.removeAt(0);
  }
}

/// درصد استفاده از یک منبع.
final class CapacityUse {
  const CapacityUse(
    this.label,
    this.pct, {
    this.text,
    this.estimated = false,
    this.editable = false,
  });
  final String label;

  /// ۰..۱۰۰؛ null = ظرفیت معلوم نیست.
  final double? pct;
  final String? text;
  final bool estimated;

  /// لمس ⇒ تعیین ظرفیت (فقط دیتابیس).
  final bool editable;
}

/// وضعیت زندهٔ یک زیرساخت.
final class InfraLive {
  InfraLive(this.id, this.kind, this.name);
  final String id;

  /// `db` · `service`
  final String kind;
  String name;
  String? detail;

  /// مالک این زیرساخت را غیرفعال کرده (کارت «زیرساخت‌ها»): سنجیده نمی‌شود.
  bool disabled = false;

  /// null = هنوز سنجیده نشده.
  bool? up;
  int? latencyMs;
  double? downBps;

  /// ترافیک (بایت بر ثانیه)؛ null = این زیرساخت شمارندهٔ ترافیک ندارد.
  double? rxBps;
  double? txBps;
  double? reqPs;
  int rxTotal = 0;
  int txTotal = 0;
  List<CapacityUse> capacity = const [];
  final LiveSeries rx = LiveSeries();
  final LiveSeries tx = LiveSeries();
  final LiveSeries latency = LiveSeries();
  DateTime? updated;
  String? error;

  bool get hasTraffic => rxBps != null;
}

/// منبع دیتابیس (S3) برای پایش.
final class DbSource {
  const DbSource({required this.settings, required this.transport, this.store});
  final Future<S3Settings?> Function() settings;
  final S3Transport Function() transport;

  /// ظرفیت تعیین‌شده توسط مالک ([dbCapacityKey]).
  final SecureStore? store;
}

class _Snap {
  _Snap(this.sent, this.received, this.at);
  final int sent;
  final int received;
  final DateTime at;
}

class _Svc {
  _Svc(this.live);
  final InfraLive live;
  List<Map<String, Object?>> endpoints = const [];
  Map<String, Object?> metrics = const {};
  Map<String, double>? lastScrape;
  DateTime? lastScrapeAt;
}

/// پایش زنده؛ [attach] با باز شدن داشبورد و [detach] با بسته شدنش.
class LiveMonitor extends ChangeNotifier {
  LiveMonitor({
    this.db,
    EndpointChecker? checker,
    MetricsFetcher? fetcher,
    DateTime Function()? now,
    this.tickEvery = const Duration(seconds: 1),
    this.probeEvery = const Duration(seconds: 5),
    this.capacityEvery = const Duration(minutes: 2),
    this.capacityPages = 20,
    this.enabled,
  }) : _checker = checker ?? defaultEndpointCheck,
       _fetch = fetcher ?? defaultMetricsFetch,
       _now = now ?? DateTime.now;

  final DbSource? db;
  final EndpointChecker _checker;
  final MetricsFetcher _fetch;
  final DateTime Function() _now;
  final Duration tickEvery;
  final Duration probeEvery;
  final Duration capacityEvery;
  final int capacityPages;

  /// سیاست مالک: false ⇒ این سرویس غیرفعال است و سنجیده نمی‌شود (ردیف ۱۳۱).
  final bool Function(String serviceId)? enabled;

  final InfraLive _db = InfraLive('db', 'db', 'دیتابیس');
  final Map<String, _Svc> _svcs = {};
  bool _dbConfigured = false;
  _Snap? _snap;
  int? _capacityBytes;
  bool _capacityLoaded = false;
  int? _usedBytes;
  int? _objects;
  bool _usedPartial = false;
  DateTime? _lastProbe;
  DateTime? _lastCapacity;
  Future<void>? _probing;
  Future<void>? _scanning;
  S3Transport? _t;
  Timer? _timer;
  int _users = 0;
  bool _disposed = false;

  bool get running => _timer != null;

  /// شمارهٔ ضربان (هر [tick] یکی) برای نشان «زنده».
  int get beats => _beats;
  int _beats = 0;

  /// زیرساخت‌ها به ترتیب نمایش (اول دیتابیس).
  List<InfraLive> get items => [
    if (db != null) _db,
    for (final s in _svcs.values) s.live,
  ];

  int? get capacityBytes => _capacityBytes;

  void attach() {
    if (_users++ == 0 && !_disposed) {
      _timer = Timer.periodic(tickEvery, (_) => tick());
      unawaited(probeNow());
    }
  }

  void detach() {
    if (_users > 0 && --_users == 0) {
      _timer?.cancel();
      _timer = null;
      _t?.close();
      _t = null;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    _t?.close();
    super.dispose();
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  /// فهرست سرویس‌ها و Endpointها از پاسخ `/infra` (همان صفحهٔ «زیرساخت»).
  void setInfra(Map<String, Object?> infra) {
    List<Map<String, Object?>> rows(String k) => [
      for (final r in (infra[k] as List?) ?? const [])
        if (r is Map) r.cast<String, Object?>(),
    ];
    final services = rows('services');
    final endpoints = rows('endpoints');
    final keep = <String>{};
    for (final s in services) {
      final id = '${s['id']}';
      keep.add(id);
      final svc = _svcs.putIfAbsent(
        id,
        () => _Svc(InfraLive(id, 'service', '${s['name'] ?? id}')),
      );
      svc.live.name = '${s['name'] ?? id}';
      svc.live.disabled = !(enabled?.call(id) ?? true);
      svc.endpoints = [
        for (final e in endpoints)
          if ('${e['service_id']}' == id && e['enabled'] != false) e,
      ];
      svc.live.detail = svc.endpoints.isEmpty
          ? null
          : Uri.tryParse('${svc.endpoints.first['url']}')?.host;
      final m = s['metrics'];
      svc.metrics = m is Map ? m.cast<String, Object?>() : const {};
      if (svc.lastScrape == null) svc.live.capacity = _manualCapacity(svc);
    }
    _svcs.removeWhere((k, _) => !keep.contains(k));
    _changed();
  }

  /// هر ثانیه: ترافیک لحظه‌ای از شمارنده‌ها؛ هر [probeEvery] سنجش تأخیر؛ هر [capacityEvery] ظرفیت.
  void tick() {
    _beats++;
    final now = _now();
    if (db != null) {
      final c = NetMeter.of(NetMeter.db);
      final prev = _snap;
      _snap = _Snap(c.sent, c.received, now);
      if (prev != null) {
        final ms = now.difference(prev.at).inMilliseconds;
        if (ms > 0) {
          _db.txBps = (c.sent - prev.sent) * 1000 / ms;
          _db.rxBps = (c.received - prev.received) * 1000 / ms;
        }
      } else {
        _db.rxBps ??= 0;
        _db.txBps ??= 0;
      }
      _db.rxTotal = c.received;
      _db.txTotal = c.sent;
      _db.downBps = c.downBps ?? _db.downBps;
      _db.rx.add(_db.rxBps ?? 0);
      _db.tx.add(_db.txBps ?? 0);
    }
    for (final s in _svcs.values) {
      final l = s.live;
      if (l.hasTraffic) {
        l.rx.add(l.rxBps ?? 0);
        l.tx.add(l.txBps ?? 0);
      }
    }
    final lp = _lastProbe;
    if (lp == null || now.difference(lp) >= probeEvery) {
      unawaited(probeNow());
    }
    _changed();
  }

  /// سنجش فوری همه (لمس کارت هم همین را صدا می‌زند).
  Future<void> probeNow() {
    if (_disposed) return Future.value();
    return _probing ??= _probe().whenComplete(() => _probing = null);
  }

  Future<void> _probe() async {
    _lastProbe = _now();
    try {
      await Future.wait([
        if (db != null) _probeDb(),
        for (final s in _svcs.values.toList()) _probeSvc(s),
      ]);
      final lc = _lastCapacity;
      if (db != null &&
          _dbConfigured &&
          (lc == null || _now().difference(lc) >= capacityEvery)) {
        unawaited(scanCapacity());
      }
    } finally {
      _changed();
    }
  }

  Future<void> _probeDb() async {
    final src = db!;
    if (!_capacityLoaded) {
      _capacityLoaded = true;
      try {
        final v = await src.store?.read(dbCapacityKey);
        _capacityBytes = int.tryParse(v ?? '');
      } on SecureStoreException {
        _capacityBytes = null;
      }
    }
    final S3Settings? s;
    try {
      s = await src.settings();
    } on Object {
      return;
    }
    if (s == null) {
      _dbConfigured = false;
      _db
        ..up = null
        ..detail = null
        ..error = 'تنظیم نشده'
        ..capacity = const [];
      return;
    }
    _dbConfigured = true;
    _db.detail = s.bucket;
    final t = _t ??= src.transport();
    final sw = Stopwatch()..start();
    try {
      await s3Request(
        s,
        t,
        path: '/${s.bucket}',
        query: const {'list-type': '2', 'max-keys': '1'},
      ).timeout(const Duration(seconds: 15));
      final ms = sw.elapsedMilliseconds;
      _db
        ..up = true
        ..latencyMs = NetMeter.of(NetMeter.db).latencyMs ?? ms
        ..error = null
        ..updated = _now();
      _db.latency.add((_db.latencyMs ?? ms).toDouble());
    } on Object catch (e) {
      _db
        ..up = false
        ..error = e is S3Failure ? e.messageFa : 'پاسخ نداد'
        ..updated = _now();
      _db.latency.add(0);
    }
    _db.capacity = [_dbCapacity()];
  }

  CapacityUse _dbCapacity() {
    final used = _usedBytes;
    final cap = _capacityBytes;
    final objects = _objects == null ? '' : ' · ${_objects!} فایل';
    if (used == null) {
      return CapacityUse(
        'فضای دیتابیس',
        null,
        text: cap == null ? 'در حال سنجش…' : 'ظرفیت ${bytesText(cap)}',
        editable: true,
      );
    }
    final usedText = '${_usedPartial ? '≥ ' : ''}${bytesText(used)}';
    if (cap == null || cap <= 0) {
      return CapacityUse(
        'فضای دیتابیس',
        null,
        text: '$usedText مصرف‌شده$objects · ظرفیت تعیین نشده',
        editable: true,
      );
    }
    return CapacityUse(
      'فضای دیتابیس',
      min(100, used * 100 / cap),
      text: '$usedText از ${bytesText(cap)}$objects',
      editable: true,
    );
  }

  /// مجموع اندازهٔ فایل‌های صندوقچه (ListObjectsV2؛ حداکثر [capacityPages] صفحه).
  Future<void> scanCapacity() {
    if (db == null) return Future.value();
    return _scanning ??= _scan().whenComplete(() => _scanning = null);
  }

  Future<void> _scan() async {
    _lastCapacity = _now();
    try {
      final s = await db!.settings();
      if (s == null) return;
      final t = _t ??= db!.transport();
      final (list, partial) = await s3ListObjects(
        s,
        t,
        '',
        maxPages: capacityPages,
      );
      _usedBytes = list.fold<int>(0, (a, o) => a + o.size);
      _objects = list.length;
      _usedPartial = partial;
    } on Object {
      // دفعهٔ بعد دوباره
    } finally {
      _db.capacity = [_dbCapacity()];
      _changed();
    }
  }

  /// ظرفیت دیتابیس (بایت)؛ null یا ۰ ⇒ پاک.
  Future<void> setDbCapacity(int? bytes) async {
    _capacityBytes = bytes == null || bytes <= 0 ? null : bytes;
    _capacityLoaded = true;
    try {
      final st = db?.store;
      if (st != null) {
        if (_capacityBytes == null) {
          await st.delete(dbCapacityKey);
        } else {
          await st.write(dbCapacityKey, '$_capacityBytes');
        }
      }
    } on SecureStoreException {
      // فقط تا بستن برنامه
    }
    _db.capacity = [_dbCapacity()];
    _changed();
  }

  static bool _isMetricsUrl(Map<String, Object?> e) {
    final u = Uri.tryParse('${e['url']}');
    return u != null &&
        (u.scheme == 'http' || u.scheme == 'https') &&
        u.path.endsWith('/metrics');
  }

  Future<void> _probeSvc(_Svc s) async {
    final l = s.live;
    l.disabled = !(enabled?.call(l.id) ?? true);
    if (l.disabled) {
      l
        ..up = null
        ..latencyMs = null
        ..rxBps = null
        ..txBps = null
        ..reqPs = null
        ..error = 'غیرفعال (کارت «زیرساخت‌ها»)';
      return;
    }
    if (s.endpoints.isEmpty) {
      l
        ..up = null
        ..error = 'Endpoint ندارد';
      return;
    }
    final metricsEp = s.endpoints.where(_isMetricsUrl).firstOrNull;
    final health = s.endpoints.where((e) => !_isMetricsUrl(e)).toList();
    final results = <CheckOutcome>[];
    if (metricsEp != null) {
      try {
        final r = await _fetch(Uri.parse('${metricsEp['url']}'));
        results.add(CheckOutcome(ok: true, latencyMs: r.latencyMs));
        _applyScrape(s, r);
      } on Object {
        results.add(const CheckOutcome(ok: false, errorCode: 'metrics_failed'));
      }
    }
    for (final e in health) {
      try {
        results.add(await _checker(e));
      } on Object {
        results.add(const CheckOutcome(ok: false, errorCode: 'check_failed'));
      }
    }
    final good = results.where((r) => r.ok).toList();
    l.up = good.isNotEmpty && good.length == results.length
        ? true
        : good.isEmpty
        ? false
        : null;
    final lat = good.map((r) => r.latencyMs).whereType<int>();
    l.latencyMs = lat.isEmpty ? null : lat.reduce(min);
    l.latency.add((l.latencyMs ?? 0).toDouble());
    l.error = good.length == results.length
        ? null
        : good.isEmpty
        ? 'در دسترس نیست'
        : '${results.length - good.length} از ${results.length} Endpoint پاسخ نداد';
    l.updated = _now();
  }

  void _applyScrape(_Svc s, MetricsScrape r) {
    final l = s.live;
    final v = r.values;
    final now = _now();
    final prev = s.lastScrape;
    final prevAt = s.lastScrapeAt;
    double? rate(String name) {
      if (prev == null || prevAt == null) return null;
      final a = prev[name];
      final b = v[name];
      final ms = now.difference(prevAt).inMilliseconds;
      if (a == null || b == null || ms <= 0) return null;
      // شمارنده از نو شروع شده (سرور دوباره روشن شد) ⇒ همان مقدار تازه
      final d = b >= a ? b - a : b;
      return d * 1000 / ms;
    }

    if (v.containsKey('payesh_net_rx_bytes_total')) {
      l.rxBps = rate('payesh_net_rx_bytes_total') ?? l.rxBps ?? 0;
      l.txBps = rate('payesh_net_tx_bytes_total') ?? l.txBps ?? 0;
      l.rxTotal = (v['payesh_net_rx_bytes_total'] ?? 0).round();
      l.txTotal = (v['payesh_net_tx_bytes_total'] ?? 0).round();
    }
    if (v.containsKey('payesh_http_requests_total')) {
      l.reqPs = rate('payesh_http_requests_total') ?? l.reqPs;
    }
    s.lastScrape = v;
    s.lastScrapeAt = now;
    final caps = <CapacityUse>[];
    final cpu = v['payesh_cpu_usage_pct'];
    if (cpu != null) caps.add(CapacityUse('پردازنده', cpu.clamp(0, 100)));
    final mem = v['payesh_memory_used_pct'];
    if (mem != null) caps.add(CapacityUse('حافظه', mem.clamp(0, 100)));
    final free = v['payesh_disk_free_pct'];
    if (free != null) {
      caps.add(CapacityUse('دیسک', (100 - free).clamp(0, 100)));
    }
    l.capacity = caps.isEmpty ? _manualCapacity(s) : caps;
  }

  /// از آخرین عددهای ثبت‌شدهٔ دستی (صفحهٔ «زیرساخت»): usage / capacity.
  static List<CapacityUse> _manualCapacity(_Svc s) {
    const res = [
      ('cpu', 'پردازنده'),
      ('memory', 'حافظه'),
      ('disk', 'دیسک'),
      ('connections', 'اتصال‌ها'),
    ];
    Map<String, Object?>? m(String k) {
      final x = s.metrics[k];
      return x is Map ? x.cast<String, Object?>() : null;
    }

    final out = <CapacityUse>[];
    for (final (k, label) in res) {
      final u = m('usage_$k');
      final c = m('capacity_$k');
      final uv = u?['value'];
      if (uv is! num) continue;
      final est = u?['label'] == 'E' || c?['label'] == 'E';
      double? pct;
      if (u?['unit'] == 'percent') {
        pct = uv.toDouble();
      } else {
        final cv = c?['value'];
        if (cv is num && cv > 0 && c?['unit'] == u?['unit']) {
          pct = uv * 100 / cv;
        }
      }
      if (pct == null) continue;
      out.add(CapacityUse(label, pct.clamp(0, 100), estimated: est));
    }
    return out;
  }
}

/// ۱۲۳۴۵۶ ⇒ «۱۲۰٫۶ کیلوبایت» (ارقام لاتین؛ نمایش فارسی در لایهٔ رابط).
String bytesText(num b) {
  const units = ['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت', 'ترابایت'];
  var v = b.toDouble();
  var i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  final n = i == 0 || v >= 100
      ? v.round().toString()
      : v.toStringAsFixed(1).replaceAll(RegExp(r'\.0$'), '');
  return '$n ${units[i]}';
}

/// سرعت (بایت بر ثانیه) ⇒ متن.
String rateText(num? bps) => bps == null ? '—' : '${bytesText(bps)}/ث';
