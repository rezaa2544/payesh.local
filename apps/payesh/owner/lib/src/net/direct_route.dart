// ردیف ۱۹۱ — مسیر مستقیم دیتابیس داخلی وقتی VPN روشن است.
//
// ریشهٔ قرمز شدن «بار لحظه‌ای»: دیتابیس (آروان، داخل ایران) از راه VPN تمام‌تونل (Lantern،
// sing-tun با IPهای جعلی 198.18.x) خوانده می‌شد؛ هر بسته اول به سوئد/آلمان می‌رفت و بعد به
// تهران برمی‌گشت. سنجش روی رایانهٔ مالک (۱۴۰۵/۹/۵): اتصال تازه از راه VPN ۱٫۸ تا ۲٫۳ ثانیه،
// درخواست روی اتصال باز ۰٫۴۷ تا ۰٫۹ ثانیه؛ همان درخواست مستقیم از کارت Wi-Fi: اتصال تازه
// ۰٫۲۲ ثانیه و روی اتصال باز ۰٫۰۹ تا ۰٫۴ ثانیه. هیچ «پردازش کمکی»ای این فاصله را کم نمی‌کرد.
//
// این مسیر فقط برای میزبان‌های «.ir» است (دیتابیس داخلی)؛ هیچ سرویس خارجی IP ایران را نمی‌بیند.
// روش: اگر DNS سیستم IP جعلی تونل داد (یا کارت تونلی روشن است)، IP واقعی با DNS-over-HTTPS
// گرفته می‌شود و اتصال با نشانی کارت شبکهٔ واقعی (Wi-Fi/Ethernet) به‌عنوان مبدأ ساخته می‌شود؛
// ویندوز چنین بسته‌ای را از همان کارت می‌فرستد، نه از تونل. نام میزبان برای SNI و بررسی گواهی
// همان می‌ماند. هر خطا ⇒ همان مسیر عادی (از راه VPN) و ۲ دقیقه بعد دوباره امتحان.
// وقتی VPN خاموش است یا اینترنت بین‌الملل قطع است، DNS سیستم IP واقعی می‌دهد و همان مسیر
// عادی (که خودش مستقیم است) به کار می‌رود.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:payesh_core/io.dart';

/// یک کارت شبکه با نشانی IPv4 (برای آزمون‌ها جایگزین‌پذیر).
typedef NetIface = ({String name, InternetAddress address});

typedef IfaceLister = Future<List<NetIface>> Function();
typedef HostLookup = Future<List<InternetAddress>> Function(String host);
typedef DohLookup = Future<({List<InternetAddress> ips, int ttl})> Function(
  String host,
);
typedef RawConnect = Future<Socket> Function(
  InternetAddress ip,
  int port,
  InternetAddress? source,
  Duration timeout,
);

/// IP جعلی تونل‌های sing-box/clash (fake-ip): 198.18.0.0/15.
bool isFakeIp(InternetAddress a) {
  final b = a.rawAddress;
  return a.type == InternetAddressType.IPv4 &&
      b.length == 4 &&
      b[0] == 198 &&
      (b[1] == 18 || b[1] == 19);
}

final RegExp _tunnelName = RegExp(
  r'tun|tap|wintun|wireguard|\bwg\d|tailscale|zerotier|vpn|lantern|psiphon|'
  r'vethernet|virtualbox|vmware|hyper-v|loopback|utun|ppp|ipsec|sing|clash|'
  r'warp|cloudflare|windscribe|openvpn|nordlynx',
  caseSensitive: false,
);

/// کارت تونلی/مجازی؟ (از روی نام)
bool isTunnelIface(String name) => _tunnelName.hasMatch(name);

/// نشانی‌ای که می‌تواند مبدأ مسیر مستقیم باشد (خصوصی یا عمومیِ واقعی؛ نه پیوند محلی، نه
/// CGNAT تیل‌اسکیل، نه loopback، نه IP جعلی).
bool usableSource(InternetAddress a) {
  if (a.type != InternetAddressType.IPv4 || a.isLoopback || a.isLinkLocal) {
    return false;
  }
  final b = a.rawAddress;
  if (isFakeIp(a)) return false;
  if (b[0] == 100 && b[1] >= 64 && b[1] < 128) return false; // 100.64/10
  return true;
}

/// وضعیت قابل نمایش مسیر دیتابیس.
enum DirectMode {
  /// تونلی دیده نشد ⇒ مسیر عادی (که خودش مستقیم است).
  normal,

  /// VPN روشن است و درخواست‌ها مستقیم از کارت واقعی می‌روند.
  direct,

  /// VPN روشن است ولی مسیر مستقیم نشد ⇒ از راه VPN.
  viaVpn,
}

final class DirectRoute {
  DirectRoute({
    IfaceLister? interfaces,
    HostLookup? lookup,
    DohLookup? doh,
    RawConnect? connect,
    DateTime Function()? now,
    bool? enabled,
  }) : _interfaces = interfaces ?? _defaultInterfaces,
       _lookup = lookup ?? InternetAddress.lookup,
       _doh = doh ?? dohLookup,
       _connect = connect ?? _defaultConnect,
       _now = now ?? DateTime.now,
       enabled = enabled ?? !kIsWeb;

  /// نمونهٔ مشترک برنامه.
  static DirectRoute instance = DirectRoute();

  /// خاموش ⇒ همیشه مسیر عادی.
  bool enabled;
  final IfaceLister _interfaces;
  final HostLookup _lookup;
  final DohLookup _doh;
  final RawConnect _connect;
  final DateTime Function() _now;

  static const Duration retryAfter = Duration(minutes: 2);
  static const Duration ifaceEvery = Duration(seconds: 60);
  static const Duration attemptTimeout = Duration(seconds: 2);

  final Map<String, ({List<InternetAddress> ips, DateTime until})> _real = {};
  List<NetIface>? _ifaces;
  DateTime? _ifacesAt;
  DateTime? _downUntil;
  InternetAddress? _goodSource;

  /// آخرین وضعیت (برای کارت «بار لحظه‌ای»).
  DirectMode mode = DirectMode.normal;

  /// نام کارتی که مسیر مستقیم از آن می‌رود (مثلاً Wi-Fi).
  String? sourceName;
  int directConnections = 0;
  int vpnConnections = 0;

  /// فقط دیتابیس‌های داخلی (دامنهٔ ‎.ir) — هیچ سرویس خارجی IP ایران را نمی‌بیند.
  bool eligible(String host) {
    final h = host.toLowerCase();
    return enabled && h.endsWith('.ir') && InternetAddress.tryParse(h) == null;
  }

  Future<List<NetIface>> _ifacesNow() async {
    final at = _ifacesAt;
    final now = _now();
    if (_ifaces != null && at != null && now.difference(at) < ifaceEvery) {
      return _ifaces!;
    }
    try {
      _ifaces = await _interfaces();
    } on Object {
      _ifaces = const [];
    }
    _ifacesAt = now;
    return _ifaces!;
  }

  /// آیا ترافیک این میزبان از تونل می‌رود؟ IP جعلی ⇒ قطعاً؛ وگرنه کارت تونلی روشن.
  Future<bool> tunneled(String host) async {
    try {
      final a = await _lookup(host);
      if (a.any(isFakeIp)) return true;
    } on Object {
      // DNS سیستم جواب نداد: شاید تونل؛ از روی کارت‌ها تصمیم می‌گیریم
    }
    final list = await _ifacesNow();
    return list.any((i) => isTunnelIface(i.name));
  }

  Future<void>? _resolving;

  /// IP واقعی از حافظه؛ اگر نیست یا کهنه است، گرفتنش در پس‌زمینه شروع می‌شود (اتصال
  /// جاری منتظر DNS-over-HTTPS نمی‌ماند تا از مهلت اتصال HttpClient نگذرد).
  List<InternetAddress> _realIpsNow(String host) {
    final c = _real[host];
    if (c == null || !c.until.isAfter(_now())) {
      _resolving ??= _resolve(host).whenComplete(() => _resolving = null);
    }
    return c?.ips ?? const [];
  }

  Future<void> _resolve(String host) async {
    try {
      final r = await _doh(host);
      final ips = r.ips.where((a) => !isFakeIp(a)).toList();
      if (ips.isNotEmpty) {
        final ttl = r.ttl.clamp(60, 1800);
        _real[host] = (ips: ips, until: _now().add(Duration(seconds: ttl)));
      }
    } on Object {
      // دفعهٔ بعد دوباره
    }
  }

  /// فقط برای آزمون‌ها: تمام شدن گرفتن IP واقعی.
  Future<void> get resolving => _resolving ?? Future<void>.value();

  /// کارت‌های واقعی؛ کارتی که آخرین بار جواب داد اول.
  Future<List<NetIface>> sources() async {
    final list = [
      for (final i in await _ifacesNow())
        if (!isTunnelIface(i.name) && usableSource(i.address)) i,
    ];
    final g = _goodSource;
    if (g != null) {
      list.sort((a, b) => (a.address == g ? 0 : 1) - (b.address == g ? 0 : 1));
    }
    return list;
  }

  /// یک سوکت خام مستقیم (بدون TLS) یا null اگر نشد/لازم نبود.
  Future<Socket?> openDirect(String host, int port) async {
    if (!eligible(host)) return null;
    final down = _downUntil;
    if (down != null && down.isAfter(_now())) {
      mode = DirectMode.viaVpn;
      return null;
    }
    if (!await tunneled(host)) {
      mode = DirectMode.normal;
      return null;
    }
    final ips = _realIpsNow(host);
    if (ips.isEmpty) {
      mode = DirectMode.viaVpn;
      return null;
    }
    final srcs = (await sources()).take(3).toList();
    for (final s in srcs) {
      final tryIps = s.address == _goodSource ? ips.take(2) : ips.take(1);
      for (final ip in tryIps) {
        try {
          final sock = await _connect(ip, port, s.address, attemptTimeout);
          _goodSource = s.address;
          sourceName = s.name;
          mode = DirectMode.direct;
          directConnections++;
          return sock;
        } on Object {
          // کارت/نشانی بعدی
        }
      }
    }
    _downUntil = _now().add(retryAfter);
    mode = DirectMode.viaVpn;
    return null;
  }

  /// [HttpClient.connectionFactory]: مسیر مستقیم برای دیتابیس داخلی، وگرنه همان اتصال عادی.
  Future<ConnectionTask<Socket>> connectionFactory(
    Uri uri,
    String? proxyHost,
    int? proxyPort,
    SecurityContext context,
  ) async {
    final secure = uri.scheme == 'https';
    final port = uri.hasPort ? uri.port : (secure ? 443 : 80);
    var cancelled = false;
    Future<Socket> open() async {
      final raw = proxyHost == null ? await openDirect(uri.host, port) : null;
      if (raw != null) {
        if (cancelled) {
          raw.destroy();
          throw const SocketException('cancelled');
        }
        if (!secure) return raw;
        return SecureSocket.secure(raw, host: uri.host, context: context);
      }
      if (eligible(uri.host) && mode != DirectMode.normal) vpnConnections++;
      final h = proxyHost ?? uri.host;
      final p = proxyPort ?? port;
      if (secure && proxyHost == null) {
        return SecureSocket.connect(h, p, context: context);
      }
      return Socket.connect(h, p);
    }

    return ConnectionTask.fromSocket(open(), () => cancelled = true);
  }

  /// متن کوتاه فارسی برای کارت «بار لحظه‌ای».
  String get statusFa => switch (mode) {
    DirectMode.direct =>
      'مسیر دیتابیس: مستقیم از ${sourceName ?? 'کارت شبکه'} (بی‌واسطهٔ VPN)',
    DirectMode.viaVpn =>
      'مسیر دیتابیس: از راه VPN (مسیر مستقیم فعلاً نشد؛ دوباره امتحان می‌شود)',
    DirectMode.normal => 'مسیر دیتابیس: مستقیم (VPN روی این مسیر نیست)',
  };

  /// فقط برای آزمون‌ها.
  void resetForTest() {
    _real.clear();
    _ifaces = null;
    _ifacesAt = null;
    _downUntil = null;
    _goodSource = null;
    mode = DirectMode.normal;
    sourceName = null;
    directConnections = 0;
    vpnConnections = 0;
  }
}

Future<List<NetIface>> _defaultInterfaces() async {
  final list = await NetworkInterface.list(type: InternetAddressType.IPv4);
  return [
    for (final i in list)
      // web32: نشانیِ dart:io را به نوع همین کتابخانه برمی‌گرداند (روی ویندوز ۶۴ همان است)
      for (final a in i.addresses)
        (name: i.name, address: InternetAddress(a.address)),
  ];
}

Future<Socket> _defaultConnect(
  InternetAddress ip,
  int port,
  InternetAddress? source,
  Duration timeout,
) => Socket.connect(ip, port, sourceAddress: source, timeout: timeout);

/// IP واقعی با DNS-over-HTTPS (کلادفلر، بعد گوگل) — از هر مسیری که سیستم دارد.
Future<({List<InternetAddress> ips, int ttl})> dohLookup(String host) async {
  final urls = [
    Uri.https('1.1.1.1', '/dns-query', {'name': host, 'type': 'A'}),
    Uri.https('8.8.8.8', '/resolve', {'name': host, 'type': 'A'}),
  ];
  Object? last;
  for (final u in urls) {
    final c = HttpClient()..connectionTimeout = const Duration(seconds: 5);
    try {
      final rq = await c.getUrl(u).timeout(const Duration(seconds: 6));
      rq.headers.set('accept', 'application/dns-json');
      final rs = await rq.close().timeout(const Duration(seconds: 6));
      final text = await rs
          .transform(utf8.decoder)
          .join()
          .timeout(const Duration(seconds: 6));
      final r = parseDohJson(text);
      if (r.ips.isNotEmpty) return r;
    } on Object catch (e) {
      last = e;
    } finally {
      c.close(force: true);
    }
  }
  throw SocketException('doh failed: $last');
}

/// پاسخ JSON «dns-json» (کلادفلر/گوگل) ⇒ نشانی‌های A و کمترین TTL.
({List<InternetAddress> ips, int ttl}) parseDohJson(String text) {
  final j = jsonDecode(text);
  final ips = <InternetAddress>[];
  var ttl = 300;
  if (j is Map && j['Answer'] is List) {
    var first = true;
    for (final a in j['Answer'] as List) {
      if (a is! Map || a['type'] != 1) continue;
      final ip = InternetAddress.tryParse('${a['data']}');
      if (ip == null || ip.type != InternetAddressType.IPv4) continue;
      ips.add(ip);
      final t = (a['TTL'] as num?)?.toInt() ?? 300;
      ttl = first ? t : (t < ttl ? t : ttl);
      first = false;
    }
  }
  return (ips: ips, ttl: ttl);
}
