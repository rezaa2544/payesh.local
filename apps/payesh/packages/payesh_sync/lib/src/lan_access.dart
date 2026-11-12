import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_secure/payesh_secure.dart' show SecureStore;

import 'school_access.dart' show SchoolSession, toPersianDigits;

/// Row 127 — the school's OWN server on the local network (no cloud Gateway).
///
/// The native app talks to the existing school server (`server/index.js`, usually the
/// headless data service of the school Windows installer) with that server's own login:
/// phone (or national id) + password → `POST /api/auth/login`; the device token it returns
/// is the long-lived credential (kept in the platform secure store) and is rotated by
/// `POST /api/auth/refresh`. Data then flows over the unchanged Sync v1 API
/// (`GET /api/v1/pull`, `POST /api/sync`) through the same durable outbox as the Gateway path.
///
/// Plain `http` is accepted ONLY for addresses that are on the local network (private IPv4
/// ranges, loopback, link-local, IPv6 ULA/link-local, `localhost`, `*.local` and single-label
/// host names). A public address is refused before anything is sent.
abstract final class LanServerRules {
  /// Default port of the school server (`PORT` in server/index.js and the installers).
  static const int defaultPort = 8080;

  /// Normalises what the user typed (`192.168.1.10`, `192.168.1.10:8080`,
  /// `http://server.local:8080/`, Persian digits) into a base URI, or null when it is not a
  /// usable local-network address.
  static Uri? parse(String typed) {
    var t = _latinDigits(typed).trim();
    if (t.isEmpty || t.contains(RegExp(r'\s'))) return null;
    if (!t.contains('://')) t = 'http://$t';
    final Uri u;
    try {
      u = Uri.parse(t);
    } on FormatException {
      return null;
    }
    if (u.scheme != 'http' && u.scheme != 'https') return null;
    if (u.userInfo.isNotEmpty || u.host.isEmpty) return null;
    if (u.hasQuery || u.hasFragment) return null;
    if (u.path.isNotEmpty && u.path != '/') return null;
    final port = u.hasPort ? u.port : (u.scheme == 'http' ? defaultPort : 443);
    if (port < 1 || port > 65535) return null;
    final out = Uri(scheme: u.scheme, host: u.host.toLowerCase(), port: port);
    return allowed(out) ? out : null;
  }

  /// True for a base URI the LAN client may talk to (see the class comment).
  static bool allowed(Uri u) {
    if (u.scheme != 'http' && u.scheme != 'https') return false;
    if (!u.hasAuthority || u.host.isEmpty || u.userInfo.isNotEmpty) {
      return false;
    }
    return isLocalHost(u.host);
  }

  /// Host on the local network (never a public internet address).
  static bool isLocalHost(String rawHost) {
    final host = rawHost.toLowerCase();
    if (host == 'localhost' || host.endsWith('.local')) return true;
    final ip = InternetAddress.tryParse(host);
    if (ip == null) {
      // A single-label name (e.g. `school-server`) only resolves inside the LAN.
      return RegExp(r'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$').hasMatch(host);
    }
    final b = ip.rawAddress;
    if (ip.type == InternetAddressType.IPv4) {
      return b[0] == 10 ||
          b[0] == 127 ||
          (b[0] == 172 && b[1] >= 16 && b[1] <= 31) ||
          (b[0] == 192 && b[1] == 168) ||
          (b[0] == 169 && b[1] == 254);
    }
    if (ip.isLoopback) return true;
    return (b[0] & 0xfe) == 0xfc || // fc00::/7 unique local
        (b[0] == 0xfe && (b[1] & 0xc0) == 0x80); // fe80::/10 link-local
  }

  /// The server runs on this very computer (`localhost`, 127/8, ::1).
  static bool isLoopbackHost(String rawHost) {
    final h = rawHost.toLowerCase();
    if (h == 'localhost') return true;
    final ip = InternetAddress.tryParse(h);
    return ip != null && ip.isLoopback;
  }

  /// Stable school code of a LAN server for the device-owner claim and the saved account
  /// (`lan-` + the server's instance id, else its host), matching `SchoolAccessRules.school`.
  static String schoolCode(Uri server, String? instance) {
    final src = (instance != null && instance.trim().isNotEmpty)
        ? instance
        : '${server.host}-${server.port}';
    var c = src.toLowerCase().replaceAll(RegExp('[^a-z0-9]+'), '-');
    c = c.replaceAll(RegExp('^-+|-+\$'), '');
    if (c.isEmpty) c = 'server';
    final code = 'lan-$c';
    return code.length > 40
        ? code.substring(0, 40).replaceAll(RegExp(r'-+$'), '')
        : code;
  }

  static String _latinDigits(String s) {
    const fa = '۰۱۲۳۴۵۶۷۸۹';
    const ar = '٠١٢٣٤٥٦٧٨٩';
    final b = StringBuffer();
    for (final r in s.runes) {
      final ch = String.fromCharCode(r);
      final i = fa.indexOf(ch);
      final j = ar.indexOf(ch);
      b.write(i >= 0 ? '$i' : (j >= 0 ? '$j' : ch));
    }
    return b.toString();
  }

  /// Phone / national id as the server normalises it (digits only, Persian digits allowed).
  static String normalizeLogin(String typed) =>
      _latinDigits(typed).replaceAll(RegExp('[^0-9]'), '');
}

/// Why a LAN step failed. Each kind has exactly one Persian message.
enum LanAccessError {
  /// What was typed is not a local-network address (or not an address at all).
  badAddress,

  /// The address answered, but it is not a Payesh school server.
  notSchoolServer,

  /// No answer at that address (server off, wrong address, other network).
  unreachable,

  /// Wrong phone/password (401 `bad_credentials`) or an inactive account.
  badCredentials,

  /// The account has no password yet — the manager sets one.
  noPassword,

  /// Too many devices for this user (409 `device_limit`).
  deviceLimit,

  /// 429 — wait.
  rateLimited,

  /// The device credential was revoked by the manager, expired or reused — sign in again.
  deviceRevoked,

  /// First setup is still open on this server.
  needsSetup,

  /// First setup is only possible on the server computer itself (headless data service).
  setupLocalOnly,

  /// The server was already set up (someone else finished the setup first).
  alreadySetup,

  /// 426 / api_version_unsupported.
  upgradeRequired,

  /// Anything else.
  unknown;

  String messageFa([Duration? retryAfter]) => switch (this) {
    badAddress => 'نشانی سرور مدرسه درست نیست — نشانی شبکهٔ محلی مثل ۱۹۲.۱۶۸.۱.۱۰:۸۰۸۰ را بنویسید (نشانی اینترنتی پذیرفته نمی‌شود)',
    notSchoolServer =>
      'در این نشانی سرور پایش پیدا نشد — نشانی را از مدیر مدرسه بپرسید',
    unreachable => 'سرور مدرسه پاسخ نداد — روشن بودن رایانهٔ سرور و اتصال به همان شبکه را بررسی کنید',
    badCredentials => 'شماره یا رمز عبور درست نیست',
    noPassword =>
      'برای این حساب هنوز رمز تعیین نشده — از مدیر مدرسه بخواهید رمز بسازد',
    deviceLimit => 'تعداد دستگاه‌های این حساب به سقف رسیده — مدیر باید یک دستگاه قدیمی را حذف کند',
    rateLimited =>
      'تلاش‌ها زیاد بود — ${_seconds(retryAfter)} ثانیهٔ دیگر دوباره امتحان کنید',
    deviceRevoked => 'دسترسی این دستگاه به سرور مدرسه دیگر معتبر نیست — دوباره با شماره و رمز وارد شوید',
    needsSetup => 'این سرور هنوز راه‌اندازی نشده — راه‌اندازی اولیه را روی خود رایانهٔ سرور انجام دهید',
    setupLocalOnly =>
      'راه‌اندازی اولیه فقط روی خود رایانهٔ سرور مدرسه ممکن است',
    alreadySetup =>
      'این سرور قبلاً راه‌اندازی شده است — با شماره و رمز مدیر وارد شوید',
    upgradeRequired => 'این نسخهٔ برنامه با سرور مدرسه سازگار نیست — برنامه یا سرور را به‌روز کنید',
    unknown => 'خطای غیرمنتظره — دوباره امتحان کنید',
  };

  static String _seconds(Duration? d) {
    final s = d == null ? 60 : (d.inMilliseconds / 1000).ceil().clamp(1, 3600);
    return toPersianDigits('$s');
  }
}

final class LanAccessFailure implements Exception {
  const LanAccessFailure(this.kind, {this.wire, this.status, this.retryAfter});
  final LanAccessError kind;
  final String? wire;
  final int? status;
  final Duration? retryAfter;

  String get messageFa => kind.messageFa(retryAfter);

  @override
  String toString() =>
      'LanAccessFailure(${kind.name} status=$status wire=$wire)';
}

/// What `/api/health` says about a school server.
final class LanServerInfo {
  const LanServerInfo({
    required this.server,
    required this.setupDone,
    required this.headless,
    this.schoolName,
    this.instance,
    this.version,
    this.lanUrls = const [],
  });
  final Uri server;
  final bool setupDone;
  final bool headless;

  /// Addresses of this server for the other devices of the school (`/api/network`), e.g.
  /// `http://192.168.1.10:8080` — shown to the manager who set the server up on its own computer.
  final List<String> lanUrls;
  final String? schoolName;
  final String? instance;
  final String? version;

  String get schoolCode => LanServerRules.schoolCode(server, instance);
}

/// A signed-in LAN session: a short-lived access token (memory only) plus the device token
/// (long-lived, rotated on every refresh — the caller MUST persist [deviceToken] each time).
final class LanSession {
  const LanSession({
    required this.token,
    required this.expiresAt,
    required this.deviceToken,
    required this.uid,
    required this.role,
    this.deviceId,
    this.name,
  });
  final String token;
  final DateTime expiresAt;
  final String deviceToken;
  final String? deviceId;
  final int uid;
  final String role;
  final String? name;

  /// The same shape the rest of the app uses for a Gateway session.
  SchoolSession toSchoolSession(String school) => SchoolSession(
    school: school,
    tenantId: 'lan',
    token: token,
    expiresAt: expiresAt,
    role: role,
    uid: uid,
  );

  static LanSession fromJson(
    Map<String, Object?> j, {
    String? keepDeviceToken,
  }) {
    final s = j['session'];
    final u = j['user'];
    final dt = j['device_token'] ?? keepDeviceToken;
    if (s is! Map || u is! Map || dt is! String || dt.isEmpty) {
      throw const LanAccessFailure(LanAccessError.unknown, wire: 'bad_body');
    }
    final token = s['token'];
    final exp = DateTime.tryParse('${s['expires_at']}');
    final uid = u['id'];
    final role = u['role'];
    if (token is! String ||
        token.isEmpty ||
        exp == null ||
        uid is! num ||
        role is! String) {
      throw const LanAccessFailure(LanAccessError.unknown, wire: 'bad_body');
    }
    return LanSession(
      token: token,
      expiresAt: exp.toUtc(),
      deviceToken: dt,
      deviceId: j['device_id'] as String?,
      uid: uid.toInt(),
      role: role,
      name: u['name'] as String?,
    );
  }
}

/// The LAN login calls. [LanAccessClient] is the real one; tests use fakes.
abstract interface class LanAccessApi {
  Future<LanServerInfo> probe(Uri server);

  Future<LanSession> login({
    required Uri server,
    required String phone,
    required String password,
    required String deviceName,
  });

  /// First setup of a fresh server (school + manager); signs the manager in.
  Future<LanSession> setup({
    required Uri server,
    required String schoolName,
    required String managerName,
    required String phone,
    required String password,
  });

  Future<LanSession> refresh({
    required Uri server,
    required String deviceToken,
  });

  Future<void> logout({required Uri server, required String token});

  /// Row 128 / W7 — "lock": opens a new access session for THIS device with the user's password
  /// (`/api/auth/unlock`); the device token is not rotated and stays saved.
  Future<LanSession> unlock({
    required Uri server,
    required String deviceToken,
    required String password,
  });

  /// Row 128 / W7 — manager rescue on the server computer itself (`/api/auth/claim`, loopback
  /// only on the server): sets the manager's phone + password and signs this device in.
  Future<LanSession> claim({
    required Uri server,
    required String phone,
    required String password,
  });
}

/// `dart:io` implementation (no WebView, no browser stack).
final class LanAccessClient implements LanAccessApi {
  LanAccessClient({
    this.clientVersion = 'payesh-native/0.1.0',
    this.platform = 'native',
    HttpClient? client,
    this.timeout = const Duration(seconds: 15),
    this.refreshRetryDelays = const [
      Duration(seconds: 1),
      Duration(seconds: 4),
    ],
    String Function()? requestId,
  }) : _client = client ?? HttpClient(),
       _requestId = requestId ?? newIdempotencyKey;

  final String clientVersion;

  /// `platform` the server records for the device (`android`, `windows`, …).
  final String platform;
  final Duration timeout;

  /// The server rotates the device token on every refresh and accepts the previous token for
  /// 30 s (`PAYESH_REFRESH_GRACE_SEC`) — a reply lost on the way back is retried inside that
  /// window instead of later (a late reuse would revoke the device).
  final List<Duration> refreshRetryDelays;
  final HttpClient _client;
  final String Function() _requestId;

  @override
  Future<LanServerInfo> probe(Uri server) async {
    if (!LanServerRules.allowed(server)) {
      throw const LanAccessFailure(LanAccessError.badAddress);
    }
    final j = await _send('GET', server.resolve('/api/health'), null);
    if (j['name'] != 'payesh-local' || j['ok'] != true) {
      throw const LanAccessFailure(LanAccessError.notSchoolServer);
    }
    var urls = const <String>[];
    try {
      final n = await _send('GET', server.resolve('/api/network'), null);
      final l = n['lan_urls'];
      if (l is List) {
        urls = [
          for (final u in l)
            if (u is String && LanServerRules.parse(u) != null) u,
        ];
      }
    } on LanAccessFailure {
      // optional: older servers / no network info
    }
    return LanServerInfo(
      lanUrls: urls,
      server: server,
      setupDone: j['setup_done'] == true,
      headless: j['headless'] == true,
      schoolName: j['school'] as String?,
      instance: j['instance'] as String?,
      version: j['version'] as String?,
    );
  }

  @override
  Future<LanSession> login({
    required Uri server,
    required String phone,
    required String password,
    required String deviceName,
  }) async {
    final j = await _send('POST', server.resolve('/api/auth/login'), {
      'phone': LanServerRules.normalizeLogin(phone),
      'password': password,
      'name': deviceName,
      'platform': platform,
    }, unauthorized: LanAccessError.badCredentials);
    return LanSession.fromJson(j);
  }

  @override
  Future<LanSession> setup({
    required Uri server,
    required String schoolName,
    required String managerName,
    required String phone,
    required String password,
  }) async {
    final j = await _send('POST', server.resolve('/api/setup'), {
      'school_name': schoolName,
      'manager_name': managerName,
      'phone': LanServerRules.normalizeLogin(phone),
      'password': password,
    });
    return LanSession.fromJson(j);
  }

  @override
  Future<LanSession> refresh({
    required Uri server,
    required String deviceToken,
  }) async {
    var attempt = 0;
    for (;;) {
      try {
        final j = await _send('POST', server.resolve('/api/auth/refresh'), {
          'device_token': deviceToken,
        }, unauthorized: LanAccessError.deviceRevoked);
        return LanSession.fromJson(j, keepDeviceToken: deviceToken);
      } on LanAccessFailure catch (e) {
        if (e.kind != LanAccessError.unreachable ||
            attempt >= refreshRetryDelays.length) {
          rethrow;
        }
        await Future<void>.delayed(refreshRetryDelays[attempt++]);
      }
    }
  }

  @override
  Future<void> logout({required Uri server, required String token}) async {
    try {
      await _send(
        'POST',
        server.resolve('/api/auth/logout'),
        const {},
        token: token,
      );
    } on LanAccessFailure {
      // best effort: the device token is forgotten locally either way
    }
  }

  @override
  Future<LanSession> unlock({
    required Uri server,
    required String deviceToken,
    required String password,
  }) async {
    final j = await _send('POST', server.resolve('/api/auth/unlock'), {
      'device_token': deviceToken,
      'password': password,
    }, unauthorized: LanAccessError.badCredentials);
    return LanSession.fromJson(j, keepDeviceToken: deviceToken);
  }

  @override
  Future<LanSession> claim({
    required Uri server,
    required String phone,
    required String password,
  }) async {
    if (!LanServerRules.isLoopbackHost(server.host)) {
      // the server refuses anything but its own computer; do not even send the password
      throw const LanAccessFailure(
        LanAccessError.setupLocalOnly,
        wire: 'local_only',
      );
    }
    final j = await _send('POST', server.resolve('/api/auth/claim'), {
      'phone': LanServerRules.normalizeLogin(phone),
      'password': password,
    });
    if (j['need_login'] == true) {
      return login(
        server: server,
        phone: phone,
        password: password,
        deviceName: 'رایانهٔ مدرسه',
      );
    }
    return LanSession.fromJson(j);
  }

  /// One JSON request to the school server with this client's headers (row 128: the admin
  /// endpoints of [LanAccounts] use the same path, timeouts and error mapping).
  Future<Map<String, Object?>> request(
    String method,
    Uri uri,
    Object? body, {
    String? token,
  }) => _send(method, uri, body, token: token);

  Future<Map<String, Object?>> _send(
    String method,
    Uri uri,
    Object? body, {
    String? token,
    LanAccessError unauthorized = LanAccessError.unknown,
  }) async {
    if (!LanServerRules.allowed(uri)) {
      throw const LanAccessFailure(LanAccessError.badAddress);
    }
    late HttpClientResponse res;
    late String text;
    try {
      final req = await _client.openUrl(method, uri).timeout(timeout);
      req.followRedirects = false;
      req.headers
        ..set(PayeshApi.versionHeader, clientVersion)
        ..set(PayeshApi.requestIdHeader, _requestId())
        ..set(HttpHeaders.acceptHeader, 'application/json');
      if (token != null) {
        req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      }
      if (body != null) {
        final bytes = utf8.encode(jsonEncode(body));
        req.headers.contentType = ContentType.json;
        req.contentLength = bytes.length;
        req.add(bytes);
      }
      res = await req.close().timeout(timeout);
      text = await utf8.decodeStream(res).timeout(timeout);
    } on TimeoutException {
      throw const LanAccessFailure(LanAccessError.unreachable, wire: 'timeout');
    } on SocketException {
      throw const LanAccessFailure(LanAccessError.unreachable);
    } on HttpException {
      throw const LanAccessFailure(LanAccessError.unreachable);
    } on HandshakeException {
      throw const LanAccessFailure(LanAccessError.unreachable, wire: 'tls');
    }
    Map<String, Object?> j = const {};
    try {
      final d = jsonDecode(text);
      if (d is Map) j = d.cast<String, Object?>();
    } on FormatException {
      if (res.statusCode < 300) {
        throw const LanAccessFailure(
          LanAccessError.notSchoolServer,
          wire: 'not_json',
        );
      }
    }
    final st = res.statusCode;
    if (st >= 200 && st < 300) return j;
    throw mapLanError(
      st,
      j,
      res.headers.value('retry-after'),
      unauthorized: unauthorized,
    );
  }

  void close() => _client.close(force: true);
}

/// HTTP error of the school server → [LanAccessFailure] (exported for tests).
LanAccessFailure mapLanError(
  int status,
  Map<String, Object?> body,
  String? retryAfter, {
  LanAccessError unauthorized = LanAccessError.unknown,
}) {
  final wire = body['error'] is String ? body['error']! as String : null;
  var ra = int.tryParse(retryAfter ?? '');
  if (ra == null && wire == 'locked') {
    // `/api/auth/unlock` after 8 wrong passwords: locked until `until` (10 minutes)
    final until = DateTime.tryParse('${body['until']}');
    if (until != null) {
      ra = until.difference(DateTime.now()).inSeconds.clamp(1, 3600);
    }
  }
  final kind = switch ((status, wire)) {
    (
      _,
      'device_revoked' || 'device_expired' || 'bad_device' || 'user_inactive',
    ) =>
      LanAccessError.deviceRevoked,
    (_, 'no_password') => LanAccessError.noPassword,
    (_, 'bad_credentials' || 'bad_phone' || 'bad_password') =>
      LanAccessError.badCredentials,
    (_, 'device_limit') => LanAccessError.deviceLimit,
    (_, 'setup_local_only' || 'local_only') => LanAccessError.setupLocalOnly,
    (_, 'locked') => LanAccessError.rateLimited,
    (_, 'already_setup') => LanAccessError.alreadySetup,
    (_, 'api_version_unsupported') => LanAccessError.upgradeRequired,
    (426, _) => LanAccessError.upgradeRequired,
    (429, _) => LanAccessError.rateLimited,
    (401, _) => unauthorized,
    (final int s, _) when s >= 500 => LanAccessError.unreachable,
    _ => LanAccessError.unknown,
  };
  return LanAccessFailure(
    kind,
    wire: wire,
    status: status,
    retryAfter: ra == null ? null : Duration(seconds: ra),
  );
}

/// Secure-store keys of the LAN account (separate from the Gateway account in [SchoolKeys]).
abstract final class LanKeys {
  static const String server = 'lan.server_url';
  static const String school = 'lan.school';
  static const String schoolName = 'lan.school_name';
  static const String deviceToken = 'lan.device_token';
  static const String role = 'lan.role';
  static const String uid = 'lan.uid';

  /// Row 128 / W7: the user locked the app on this device (kept across restarts).
  static const String locked = 'lan.locked';

  static const List<String> all = [
    server,
    school,
    schoolName,
    deviceToken,
    role,
    uid,
    locked,
  ];
}

/// The saved LAN account of this device.
final class SavedLan {
  const SavedLan({
    required this.server,
    required this.school,
    required this.deviceToken,
    this.schoolName,
    this.role,
    this.uid,
  });
  final Uri server;
  final String school;
  final String deviceToken;
  final String? schoolName;
  final String? role;
  final int? uid;

  SavedLan withToken(String token, {String? role, int? uid}) => SavedLan(
    server: server,
    school: school,
    deviceToken: token,
    schoolName: schoolName,
    role: role ?? this.role,
    uid: uid ?? this.uid,
  );
}

/// Reads/writes [SavedLan] in the platform secure store. A saved entry whose address is not a
/// local-network address (see [LanServerRules]) is ignored, never used.
final class LanAccountStore {
  const LanAccountStore(this.store);
  final SecureStore store;

  Future<SavedLan?> load() async {
    final u = await store.read(LanKeys.server);
    final s = await store.read(LanKeys.school);
    final t = await store.read(LanKeys.deviceToken);
    if (u == null || s == null || t == null || t.isEmpty) return null;
    final server = Uri.tryParse(u);
    if (server == null || !LanServerRules.allowed(server)) return null;
    if (!RegExp(r'^lan-[a-z0-9][a-z0-9-]{0,35}$').hasMatch(s)) return null;
    return SavedLan(
      server: server,
      school: s,
      deviceToken: t,
      schoolName: await store.read(LanKeys.schoolName),
      role: await store.read(LanKeys.role),
      uid: int.tryParse(await store.read(LanKeys.uid) ?? ''),
    );
  }

  /// Writes the account. The rotated device token is written FIRST: if the app dies right
  /// after a refresh, the newest token is what the next start uses.
  Future<void> save(SavedLan a) async {
    await store.write(LanKeys.deviceToken, a.deviceToken);
    await store.write(LanKeys.server, a.server.toString());
    await store.write(LanKeys.school, a.school);
    final n = a.schoolName;
    if (n != null) await store.write(LanKeys.schoolName, n);
    final r = a.role;
    if (r != null) await store.write(LanKeys.role, r);
    final id = a.uid;
    if (id != null && id > 0) await store.write(LanKeys.uid, '$id');
  }

  Future<bool> isLocked() async => await store.read(LanKeys.locked) == '1';

  Future<void> setLocked(bool locked) async {
    if (locked) {
      await store.write(LanKeys.locked, '1');
    } else {
      await store.delete(LanKeys.locked);
    }
  }

  Future<void> clear() async {
    for (final k in LanKeys.all) {
      await store.delete(k);
    }
  }
}
