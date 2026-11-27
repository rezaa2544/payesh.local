// ردیف ۱۹۷-Q05 (یافته‌های F48/F43/F26) — وقتی DNS دستگاه نام سرور را نمی‌دهد.
//
// روی گوشیِ همیشه‌VPN (Lantern، sing-box) بخشی از اتصال‌ها از مسیر `direct` می‌روند و DNS همان
// مسیر با `exchange4: EOF` می‌افتد؛ برنامه «آفلاین» می‌ماند، ورود بار اول «سرور مدرسه پاسخ نداد»
// می‌دهد و بررسی به‌روزرسانی شکست می‌خورد، در حالی که خودِ سرور در دسترس است.
//
// چاره: اتصال اول همان راه عادی است. فقط اگر جست‌وجوی نام شکست خورد — یا نام به IP جعلی تونل
// (198.18.0.0/15) رسید و اتصال نشد — IP واقعی با DNS-over-HTTPS (کلادفلر 1.1.1.1، گوگل 8.8.8.8؛
// اتصال مستقیم به IP، بی‌نیاز به DNS) گرفته و اتصال به همان IP ساخته می‌شود. نام میزبان برای SNI
// و بررسی گواهی همان می‌ماند (هیچ بررسی امنیتی کنار نمی‌رود). IP به‌دست‌آمده تا TTL (۱ تا ۱۰
// دقیقه) برای همان نام اول امتحان می‌شود. پراکسی تنظیم‌شده ⇒ همان رفتار عادی HttpClient.

import 'dart:async';
import 'dart:convert';

import '../../io.dart';

typedef DohResolver = Future<({List<InternetAddress> ips, int ttl})> Function(
  String host,
);
typedef NameLookup = Future<List<InternetAddress>> Function(String host);
typedef TcpConnect = Future<Socket> Function(
  String host,
  int port,
  Duration timeout,
);
typedef TlsUpgrade = Future<Socket> Function(
  Socket raw,
  String host,
  SecurityContext? context,
);

/// IP جعلی تونل‌های sing-box/clash (fake-ip): 198.18.0.0/15.
bool isTunnelFakeIp(InternetAddress a) {
  final b = a.rawAddress;
  return a.type == InternetAddressType.IPv4 &&
      b.length == 4 &&
      b[0] == 198 &&
      (b[1] == 18 || b[1] == 19);
}

/// خطای «نام پیدا نشد» (اندروید/ویندوز/لینوکس).
bool isLookupFailure(Object e) {
  final s = '$e'.toLowerCase();
  return s.contains('host lookup') ||
      s.contains('no address associated') ||
      s.contains('nodename nor servname') ||
      s.contains('name or service not known');
}

class DnsFallback {
  DnsFallback({
    DohResolver? doh,
    NameLookup? lookup,
    TcpConnect? connect,
    TlsUpgrade? secure,
    DateTime Function()? now,
    this.timeout = const Duration(seconds: 15),
  }) : _doh = doh ?? dohResolve,
       _lookup = lookup ?? InternetAddress.lookup,
       _connect = connect ?? _tcp,
       _secure = secure ?? _tls,
       _now = now ?? DateTime.now;

  /// نمونهٔ مشترک همهٔ HttpClientهای برنامه.
  static final DnsFallback instance = DnsFallback();

  final DohResolver _doh;
  final NameLookup _lookup;
  final TcpConnect _connect;
  final TlsUpgrade _secure;
  final DateTime Function() _now;
  final Duration timeout;

  final Map<String, ({List<InternetAddress> ips, DateTime until})> _sticky = {};

  /// چند اتصال از راه DNS-over-HTTPS ساخته شد (برای «سیستم» و آزمون‌ها).
  int rescued = 0;

  /// IP نگه‌داشته برای یک نام (آزمون‌ها).
  List<InternetAddress>? stickyFor(String host) {
    final s = _sticky[host];
    if (s == null || _now().isAfter(s.until)) return null;
    return s.ips;
  }

  /// [HttpClient.connectionFactory].
  Future<ConnectionTask<Socket>> connectionFactory(
    Uri uri,
    String? proxyHost,
    int? proxyPort,
    SecurityContext? context,
  ) async {
    final secure = uri.scheme == 'https';
    final port = uri.hasPort ? uri.port : (secure ? 443 : 80);
    var cancelled = false;
    final sockets = <Socket>[];
    Future<Socket> guard(Future<Socket> f) async {
      final s = await f;
      sockets.add(s);
      if (cancelled) {
        s.destroy();
        throw const SocketException('cancelled');
      }
      return s;
    }

    Future<Socket> open() async {
      if (proxyHost != null) {
        // HttpClient خودش CONNECT و TLS را روی همین اتصال می‌سازد
        return guard(_connect(proxyHost, proxyPort ?? 80, timeout));
      }
      return guard(_open(uri.host, port, secure, context));
    }

    return ConnectionTask.fromSocket(open(), () {
      cancelled = true;
      for (final s in sockets) {
        s.destroy();
      }
    });
  }

  Future<Socket> _viaIp(
    InternetAddress ip,
    String host,
    int port,
    bool secure,
    SecurityContext? context,
  ) async {
    final raw = await _connect(ip.address, port, timeout);
    if (!secure) return raw;
    try {
      return await _secure(raw, host, context).timeout(timeout);
    } on Object {
      raw.destroy();
      rethrow;
    }
  }

  Future<Socket> _open(
    String host,
    int port,
    bool secure,
    SecurityContext? context,
  ) async {
    if (InternetAddress.tryParse(host) != null) {
      return _plain(host, port, secure, context);
    }
    // ۱) IP واقعیِ نگه‌داشته از دفعهٔ قبل
    final keep = stickyFor(host);
    if (keep != null) {
      for (final ip in keep) {
        try {
          final s = await _viaIp(ip, host, port, secure, context);
          rescued++;
          return s;
        } on Object {
          // IP عوض شده: راه عادی و DoH دوباره
        }
      }
      _sticky.remove(host);
    }
    // ۲) راه عادی
    try {
      return await _plain(host, port, secure, context);
    } on Object catch (first) {
      if (!await _shouldRescue(host, first)) rethrow;
      // ۳) DNS-over-HTTPS
      final ({List<InternetAddress> ips, int ttl}) r;
      try {
        r = await _doh(host);
      } on Object {
        Error.throwWithStackTrace(first, StackTrace.current);
      }
      for (final ip in r.ips) {
        if (isTunnelFakeIp(ip)) continue;
        try {
          final s = await _viaIp(ip, host, port, secure, context);
          final ttl = r.ttl.clamp(60, 600);
          _sticky[host] = (
            ips: r.ips,
            until: _now().add(Duration(seconds: ttl)),
          );
          rescued++;
          return s;
        } on Object {
          continue;
        }
      }
      Error.throwWithStackTrace(first, StackTrace.current);
    }
  }

  Future<Socket> _plain(
    String host,
    int port,
    bool secure,
    SecurityContext? context,
  ) async {
    final raw = await _connect(host, port, timeout);
    if (!secure) return raw;
    try {
      return await _secure(raw, host, context).timeout(timeout);
    } on Object {
      raw.destroy();
      rethrow;
    }
  }

  /// فقط مشکل نام (نه سرور خاموش یا رمز نادرست) ارزش DoH دارد.
  Future<bool> _shouldRescue(String host, Object error) async {
    if (error is TlsException && error is! HandshakeException) return false;
    if (isLookupFailure(error)) return true;
    try {
      final list = await _lookup(host).timeout(const Duration(seconds: 3));
      return list.isEmpty || list.any(isTunnelFakeIp);
    } on Object {
      return true; // جست‌وجوی نام هم شکست ⇒ همان مشکل DNS
    }
  }
}

Future<Socket> _tcp(String host, int port, Duration timeout) =>
    Socket.connect(host, port, timeout: timeout);

Future<Socket> _tls(Socket raw, String host, SecurityContext? context) =>
    SecureSocket.secure(raw, host: host, context: context);

/// HttpClient با همین راه نجات (web32: شبکهٔ Chromium خودش DNS را دارد ⇒ بی‌اثر).
void installDnsFallback(
  HttpClient client, {
  SecurityContext? context,
  DnsFallback? via,
}) {
  if (isWeb32) return;
  final f = via ?? DnsFallback.instance;
  client.connectionFactory = (uri, proxyHost, proxyPort) =>
      f.connectionFactory(uri, proxyHost, proxyPort, context);
}

/// IP واقعی با DNS-over-HTTPS (کلادفلر، گوگل) — اتصال مستقیم به IP، بی‌نیاز به DNS دستگاه.
/// هر سه هم‌زمان پرسیده می‌شوند؛ اولین پاسخ ناتهی برنده است (بدترین حالت ~۶ ثانیه).
Future<({List<InternetAddress> ips, int ttl})> dohResolve(String host) {
  final urls = [
    Uri.https('1.1.1.1', '/dns-query', {'name': host, 'type': 'A'}),
    Uri.https('8.8.8.8', '/resolve', {'name': host, 'type': 'A'}),
    Uri.https('1.0.0.1', '/dns-query', {'name': host, 'type': 'A'}),
  ];
  final done = Completer<({List<InternetAddress> ips, int ttl})>();
  var left = urls.length;
  Object? last;
  for (final u in urls) {
    unawaited(() async {
      final c = HttpClient()..connectionTimeout = const Duration(seconds: 5);
      try {
        final rq = await c.getUrl(u).timeout(const Duration(seconds: 6));
        rq.headers.set('accept', 'application/dns-json');
        final rs = await rq.close().timeout(const Duration(seconds: 6));
        final text = await rs
            .transform(utf8.decoder)
            .join()
            .timeout(const Duration(seconds: 6));
        final r = parseDnsJson(text);
        if (r.ips.isNotEmpty && !done.isCompleted) done.complete(r);
        if (r.ips.isEmpty) last ??= 'no A record';
      } on Object catch (e) {
        last = e;
      } finally {
        c.close(force: true);
        if (--left == 0 && !done.isCompleted) {
          done.completeError(SocketException('doh failed: $last'));
        }
      }
    }());
  }
  return done.future;
}

/// پاسخ JSON «dns-json» (کلادفلر/گوگل) ⇒ نشانی‌های A و کمترین TTL.
({List<InternetAddress> ips, int ttl}) parseDnsJson(String text) {
  final j = jsonDecode(text);
  final ips = <InternetAddress>[];
  int? ttl;
  if (j is Map && j['Answer'] is List) {
    for (final a in j['Answer'] as List) {
      if (a is! Map || a['type'] != 1) continue;
      final ip = InternetAddress.tryParse('${a['data']}');
      if (ip == null || ip.type != InternetAddressType.IPv4) continue;
      ips.add(ip);
      final t = (a['TTL'] as num?)?.toInt() ?? 300;
      ttl = ttl == null || t < ttl ? t : ttl;
    }
  }
  return (ips: ips, ttl: ttl ?? 300);
}
