import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'pinning.dart';

/// School login / select of the native client (row 74, wave 1) over the existing Gateway
/// contract — nothing here is a new protocol:
///
/// * `GET  /api/dir/v1/resolve?school_code=` (row 66) — school code → cell URL;
/// * `POST /api/gw/v1/session/activate` (row 121) — school + one-time code + device id →
///   school token and a device secret returned once;
/// * `POST /api/gw/v1/session/refresh` (row 121) — device id + device secret → fresh token.
///
/// The patterns below are copies of the server's (`server/school-access.js` SLUG_RE, CODE_RE,
/// DEVICE_RE); `tests/native-wave1-74.js` fails when they drift.
abstract final class SchoolAccessRules {
  /// Gateway school slug (stricter than the Directory code, so every accepted code can activate).
  static final RegExp school = RegExp(r'^[a-z0-9][a-z0-9-]{2,39}$');

  /// One-time activation code / device secret (base32, 32 chars) after normalisation.
  static final RegExp code = RegExp(r'^[A-Z2-7]{32}$');

  /// Device id accepted by the Gateway.
  static final RegExp device = RegExp(r'^[A-Za-z0-9._:-]{4,64}$');

  /// Same normalisation as the server: trimmed, lower case.
  static String normalizeSchool(String raw) =>
      _latinDigits(raw).trim().toLowerCase();

  /// Same normalisation as the server's `normCode`: upper case, spaces and dashes removed.
  static String normalizeCode(String raw) =>
      _latinDigits(raw).toUpperCase().replaceAll(RegExp(r'[\s-]'), '');

  /// Persian/Arabic-Indic digits typed on a Persian keyboard become ASCII.
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

  /// A new random device id (`pd-` + 20 base32 chars), created once per installation.
  static String newDeviceId([Random? random]) {
    const b32 = 'abcdefghijklmnopqrstuvwxyz234567';
    final r = random ?? Random.secure();
    return 'pd-${List.generate(20, (_) => b32[r.nextInt(32)]).join()}';
  }

  /// Cell URLs from the Directory must be https; plain http only for loopback (dev/CI).
  static bool isAllowedCellUrl(Uri u) {
    if (!u.hasAuthority || u.host.isEmpty || u.userInfo.isNotEmpty) {
      return false;
    }
    if (u.scheme == 'https') return true;
    return u.scheme == 'http' &&
        (u.host == '127.0.0.1' || u.host == 'localhost' || u.host == '::1');
  }
}

/// Why a login step failed. Each kind has exactly one Persian message ([messageFa]).
enum SchoolAccessError {
  /// The typed school code is not a valid code (checked on the device; nothing was sent).
  badSchoolCode,

  /// The typed activation code has the wrong shape (checked on the device; nothing was sent).
  badActivationCode,

  /// Directory: unknown school (404 `not_found`, identical for malformed codes).
  schoolNotFound,

  /// Gateway: wrong school or wrong/used/expired code (401 `activation_failed`, one answer).
  activationRejected,

  /// Gateway: the device credential is no longer valid (401 `refresh_failed`) — user removed,
  /// deactivated, or the device was re-activated elsewhere. The device must sign in again.
  deviceRevoked,

  /// 429 — wait [SchoolAccessFailure.retryAfter].
  rateLimited,

  /// 426 / `api_version_unsupported` — this app is outside the supported version window.
  upgradeRequired,

  /// 503 / 5xx — Directory, cell or Gateway temporarily unavailable.
  unavailable,

  /// The Directory returned a cell URL the client refuses (not https).
  insecureCell,

  /// No connection / timeout — nothing reached the server or no answer came back.
  offline,

  /// TLS handshake failed or the server key is not one of the pinned keys: nothing was sent.
  tlsRejected,

  /// Anything else (unexpected status or body).
  unknown;

  /// User-facing Persian message (RTL UI).
  String messageFa([Duration? retryAfter]) => switch (this) {
    badSchoolCode => 'کد مدرسه درست نیست — فقط حروف انگلیسی کوچک، رقم و خط تیره (۳ تا ۴۰ نویسه)',
    badActivationCode => 'کد فعال‌سازی ۳۲ نویسه است (حروف A تا Z و رقم‌های ۲ تا ۷) — دوباره بنویسید',
    schoolNotFound =>
      'مدرسه‌ای با این کد پیدا نشد — کد را از مدیر مدرسه بپرسید',
    activationRejected =>
      'کد فعال‌سازی پذیرفته نشد — ممکن است اشتباه، استفاده‌شده یا منقضی باشد',
    deviceRevoked => 'دسترسی این دستگاه دیگر معتبر نیست — با کد فعال‌سازی تازه دوباره وارد شوید',
    rateLimited =>
      'تلاش‌ها زیاد بود — ${_seconds(retryAfter)} ثانیهٔ دیگر دوباره امتحان کنید',
    upgradeRequired =>
      'این نسخهٔ برنامه دیگر پشتیبانی نمی‌شود — برنامه را به‌روز کنید',
    unavailable =>
      'سرور مدرسه موقتاً در دسترس نیست — کمی بعد دوباره امتحان کنید',
    insecureCell => 'نشانی سرور مدرسه امن (https) نیست — اتصال برقرار نشد؛ به پشتیبانی خبر دهید',
    offline => 'اتصال اینترنت برقرار نیست — اتصال را بررسی کنید',
    tlsRejected => 'اتصال امن به سرور تأیید نشد — چیزی ارسال نشد؛ شبکه را عوض کنید یا به پشتیبانی خبر دهید',
    unknown => 'خطای غیرمنتظره — دوباره امتحان کنید',
  };

  static String _seconds(Duration? d) {
    final s = d == null ? 60 : max(1, (d.inMilliseconds / 1000).ceil());
    return toPersianDigits('$s');
  }
}

/// Persian name of a school role (unknown roles are shown verbatim).
String roleNameFa(String role) => switch (role) {
  'manager' => 'مدیر',
  'deputy' => 'معاون',
  'teacher' => 'معلم',
  'parent' => 'ولی',
  'student' => 'دانش‌آموز',
  _ => role,
};

/// Persian digits for display.
String toPersianDigits(String s) {
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  return s.replaceAllMapped(RegExp('[0-9]'), (m) => fa[int.parse(m[0]!)]);
}

final class SchoolAccessFailure implements Exception {
  const SchoolAccessFailure(
    this.kind, {
    this.wire,
    this.status,
    this.retryAfter,
  });

  final SchoolAccessError kind;

  /// Server error code (`not_found`, `activation_failed`, …) when there was a response.
  final String? wire;

  /// HTTP status when there was a response.
  final int? status;
  final Duration? retryAfter;

  String get messageFa => kind.messageFa(retryAfter);

  @override
  String toString() =>
      'SchoolAccessFailure(${kind.name} status=$status wire=$wire)';
}

/// Directory answer for exactly one school.
final class SchoolRoute {
  const SchoolRoute({
    required this.schoolCode,
    required this.cellUrl,
    this.migrationState = 'stable',
    this.ttl = const Duration(minutes: 5),
    this.stale = false,
  });

  final String schoolCode;
  final Uri cellUrl;

  /// `stable`, `migrating` or `moved` (row 66).
  final String migrationState;
  final Duration ttl;
  final bool stale;

  bool get migrating => migrationState != 'stable';
}

/// A school token for this device. The token lives in memory only; what survives a restart is
/// the device secret ([SavedSchool]).
final class SchoolSession {
  const SchoolSession({
    required this.school,
    required this.tenantId,
    required this.token,
    required this.expiresAt,
    required this.role,
    required this.uid,
  });

  final String school;
  final String tenantId;
  final String token;
  final DateTime expiresAt;
  final String role;
  final int uid;

  bool expiredAt(DateTime now) => !now.isBefore(expiresAt);

  /// Persian role name.
  String get roleFa => roleNameFa(role);

  static SchoolSession fromJson(String school, Map<String, Object?> j) {
    final token = j['token'];
    final exp = j['expires_at'];
    final role = j['role'];
    final uid = j['uid'];
    final tid = j['tenant_id'];
    if (token is! String ||
        token.isEmpty ||
        exp is! num ||
        role is! String ||
        uid is! num ||
        tid is! String) {
      throw const SchoolAccessFailure(SchoolAccessError.unknown);
    }
    return SchoolSession(
      school: school,
      tenantId: tid,
      token: token,
      expiresAt: DateTime.fromMillisecondsSinceEpoch(exp.toInt(), isUtc: true),
      role: role,
      uid: uid.toInt(),
    );
  }
}

/// Result of a first activation: the session plus the device secret (shown by the server once).
final class Activation {
  const Activation(this.session, this.deviceSecret);
  final SchoolSession session;
  final String deviceSecret;
}

/// The three calls of wave 1. [SchoolAccessClient] is the real one; tests use fakes.
abstract interface class SchoolAccessApi {
  Future<SchoolRoute> resolve(String schoolCode);

  Future<Activation> activate({
    required Uri cell,
    required String school,
    required String code,
    required String deviceId,
  });

  Future<SchoolSession> refresh({
    required Uri cell,
    required String school,
    required String deviceId,
    required String deviceSecret,
  });
}

/// `dart:io` implementation. Sends no `Authorization` header (these endpoints are public), but
/// the client version, a request id and the device id like every other native request.
/// Pass a pinned [HttpClient] (see [createPinnedHttpClient]) in production.
final class SchoolAccessClient implements SchoolAccessApi {
  SchoolAccessClient({
    required this.directory,
    this.fallbackCell,
    this.deviceId,
    this.clientVersion = 'payesh-native/0.1.0',
    HttpClient? client,
    this.timeout = const Duration(seconds: 20),
    String Function()? requestId,
  }) : _client = client ?? HttpClient(),
       _requestId = requestId ?? newIdempotencyKey;

  /// Base URL of the Directory (`/api/dir/v1/resolve` is resolved against it).
  final Uri directory;

  /// Used when the Directory is not deployed (503 `not_configured`): single-cell installs.
  final Uri? fallbackCell;
  final String? deviceId;
  final String clientVersion;
  final Duration timeout;
  final HttpClient _client;
  final String Function() _requestId;

  /// Request id of the last request (for support).
  String? lastRequestId;

  @override
  Future<SchoolRoute> resolve(String schoolCode) async {
    final code = SchoolAccessRules.normalizeSchool(schoolCode);
    if (!SchoolAccessRules.school.hasMatch(code)) {
      throw const SchoolAccessFailure(SchoolAccessError.badSchoolCode);
    }
    final uri = directory
        .resolve('/api/dir/v1/resolve')
        .replace(queryParameters: {'school_code': code});
    final Map<String, Object?> j;
    try {
      j = await _send('GET', uri, null);
    } on SchoolAccessFailure catch (e) {
      final fb = fallbackCell;
      if (e.status == 503 && e.wire == 'not_configured' && fb != null) {
        return SchoolRoute(schoolCode: code, cellUrl: fb);
      }
      if (e.status == 404) {
        throw SchoolAccessFailure(
          SchoolAccessError.schoolNotFound,
          wire: e.wire,
          status: 404,
        );
      }
      rethrow;
    }
    final cell = Uri.tryParse('${j['cell_url'] ?? ''}');
    if (j['ok'] != true || cell == null) {
      throw const SchoolAccessFailure(SchoolAccessError.unknown, status: 200);
    }
    if (!SchoolAccessRules.isAllowedCellUrl(cell)) {
      throw const SchoolAccessFailure(SchoolAccessError.insecureCell);
    }
    final ttl = j['ttl'];
    return SchoolRoute(
      schoolCode: '${j['school_code'] ?? code}',
      cellUrl: cell,
      migrationState: '${j['migration_state'] ?? 'stable'}',
      ttl: Duration(seconds: ttl is num && ttl > 0 ? ttl.toInt() : 300),
      stale: j['stale'] == true,
    );
  }

  @override
  Future<Activation> activate({
    required Uri cell,
    required String school,
    required String code,
    required String deviceId,
  }) async {
    final s = _checkSchool(school);
    final c = SchoolAccessRules.normalizeCode(code);
    if (!SchoolAccessRules.code.hasMatch(c)) {
      throw const SchoolAccessFailure(SchoolAccessError.badActivationCode);
    }
    _checkDevice(deviceId);
    final j = await _send('POST', cell.resolve('/api/gw/v1/session/activate'), {
      'school': s,
      'code': c,
      'device_id': deviceId,
    }, rejected: SchoolAccessError.activationRejected);
    final secret = j['device_secret'];
    if (secret is! String || !SchoolAccessRules.code.hasMatch(secret)) {
      throw const SchoolAccessFailure(SchoolAccessError.unknown, status: 200);
    }
    return Activation(SchoolSession.fromJson(s, j), secret);
  }

  @override
  Future<SchoolSession> refresh({
    required Uri cell,
    required String school,
    required String deviceId,
    required String deviceSecret,
  }) async {
    final s = _checkSchool(school);
    _checkDevice(deviceId);
    final j = await _send('POST', cell.resolve('/api/gw/v1/session/refresh'), {
      'school': s,
      'device_id': deviceId,
      'device_secret': deviceSecret,
    }, rejected: SchoolAccessError.deviceRevoked);
    return SchoolSession.fromJson(s, j);
  }

  String _checkSchool(String school) {
    final s = SchoolAccessRules.normalizeSchool(school);
    if (!SchoolAccessRules.school.hasMatch(s)) {
      throw const SchoolAccessFailure(SchoolAccessError.badSchoolCode);
    }
    return s;
  }

  void _checkDevice(String deviceId) {
    if (!SchoolAccessRules.device.hasMatch(deviceId)) {
      throw const SchoolAccessFailure(SchoolAccessError.unknown);
    }
  }

  Future<Map<String, Object?>> _send(
    String method,
    Uri uri,
    Object? body, {
    SchoolAccessError rejected = SchoolAccessError.unknown,
  }) async {
    final rid = _requestId();
    lastRequestId = rid;
    late HttpClientResponse res;
    late String text;
    try {
      final req = await _client.openUrl(method, uri).timeout(timeout);
      req.headers
        ..set(PayeshApi.versionHeader, clientVersion)
        ..set(PayeshApi.requestIdHeader, rid)
        ..set(HttpHeaders.acceptHeader, 'application/json');
      final d = deviceId;
      if (d != null) req.headers.set(PayeshApi.deviceIdHeader, d);
      if (body != null) {
        final bytes = utf8.encode(jsonEncode(body));
        req.headers.contentType = ContentType.json;
        req.contentLength = bytes.length;
        req.add(bytes);
      }
      res = await req.close().timeout(timeout);
      text = await utf8.decodeStream(res).timeout(timeout);
    } on TimeoutException {
      throw const SchoolAccessFailure(SchoolAccessError.offline);
    } on SocketException {
      throw const SchoolAccessFailure(SchoolAccessError.offline);
    } on HttpException {
      throw const SchoolAccessFailure(SchoolAccessError.offline);
    } on PinningException {
      throw const SchoolAccessFailure(
        SchoolAccessError.tlsRejected,
        wire: 'pin',
      );
    } on HandshakeException {
      throw const SchoolAccessFailure(
        SchoolAccessError.tlsRejected,
        wire: 'tls',
      );
    }
    Map<String, Object?> j = const {};
    try {
      final d = jsonDecode(text);
      if (d is Map) j = d.cast<String, Object?>();
    } on FormatException {
      j = const {};
    }
    final st = res.statusCode;
    if (st >= 200 && st < 300) return j;
    throw mapSchoolAccessError(
      st,
      j,
      res.headers.value('retry-after'),
      rejected: rejected,
    );
  }

  void close() => _client.close(force: true);
}

/// HTTP error → [SchoolAccessFailure] (exported for tests and the contract check).
SchoolAccessFailure mapSchoolAccessError(
  int status,
  Map<String, Object?> body,
  String? retryAfter, {
  SchoolAccessError rejected = SchoolAccessError.unknown,
}) {
  final wire = body['error'] is String ? body['error']! as String : null;
  Duration? wait;
  final ra = int.tryParse(retryAfter ?? '');
  if (ra != null) wait = Duration(seconds: ra);
  final ms = body['retry_after_ms'];
  if (ms is num) wait = Duration(milliseconds: ms.toInt());
  final kind = switch ((status, wire)) {
    (401, _) => rejected,
    (404, _) => SchoolAccessError.schoolNotFound,
    (426, _) => SchoolAccessError.upgradeRequired,
    (400, 'api_version_unsupported') => SchoolAccessError.upgradeRequired,
    (400, 'bad_school_code') => SchoolAccessError.badSchoolCode,
    (429, _) => SchoolAccessError.rateLimited,
    (final int s, _) when s >= 500 => SchoolAccessError.unavailable,
    _ => SchoolAccessError.unknown,
  };
  return SchoolAccessFailure(
    kind,
    wire: wire,
    status: status,
    retryAfter: wait,
  );
}

/// What survives a restart: which school, where its cell is, and this device's credential.
/// The device secret is kept in the platform secure store (Android Keystore / Windows DPAPI);
/// the school token is NEVER written anywhere.
final class SavedSchool {
  const SavedSchool({
    required this.school,
    required this.cellUrl,
    required this.deviceSecret,
    this.role,
  });
  final String school;
  final Uri cellUrl;
  final String deviceSecret;

  /// Last known role (offline display only; the server re-reads it on every refresh).
  final String? role;
}

/// Secure-store keys of wave 1.
abstract final class SchoolKeys {
  static const String school = 'school.code';
  static const String cellUrl = 'school.cell_url';
  static const String deviceSecret = 'school.device_secret';
  static const String role = 'school.role';
  static const String clientChoice = 'client.choice';
}

final class SchoolAccountStore {
  const SchoolAccountStore(this.store);
  final SecureStore store;

  /// Stable device id of this installation (created on first use).
  Future<String> deviceId({Random? random}) async {
    final cur = await store.read(SecureKeys.deviceId);
    if (cur != null && SchoolAccessRules.device.hasMatch(cur)) return cur;
    final id = SchoolAccessRules.newDeviceId(random);
    await store.write(SecureKeys.deviceId, id);
    return id;
  }

  Future<SavedSchool?> load() async {
    final s = await store.read(SchoolKeys.school);
    final u = await store.read(SchoolKeys.cellUrl);
    final d = await store.read(SchoolKeys.deviceSecret);
    if (s == null || u == null || d == null) return null;
    final cell = Uri.tryParse(u);
    if (cell == null ||
        !SchoolAccessRules.school.hasMatch(s) ||
        !SchoolAccessRules.isAllowedCellUrl(cell)) {
      return null;
    }
    return SavedSchool(
      school: s,
      cellUrl: cell,
      deviceSecret: d,
      role: await store.read(SchoolKeys.role),
    );
  }

  Future<void> save(SavedSchool s) async {
    await store.write(SchoolKeys.school, s.school);
    await store.write(SchoolKeys.cellUrl, s.cellUrl.toString());
    await store.write(SchoolKeys.deviceSecret, s.deviceSecret);
    final r = s.role;
    if (r != null) await store.write(SchoolKeys.role, r);
  }

  /// Sign-out: forgets the school and the device secret (the device id stays).
  Future<void> clear() async {
    for (final k in [
      SchoolKeys.school,
      SchoolKeys.cellUrl,
      SchoolKeys.deviceSecret,
      SchoolKeys.role,
    ]) {
      await store.delete(k);
    }
  }
}

/// Build without a Gateway address: every login step answers "not configured" — the app never
/// guesses a server.
final class UnconfiguredSchoolAccess implements SchoolAccessApi {
  const UnconfiguredSchoolAccess();

  static const SchoolAccessFailure _f = SchoolAccessFailure(
    SchoolAccessError.unavailable,
    wire: 'not_configured',
  );

  @override
  Future<SchoolRoute> resolve(String schoolCode) => Future.error(_f);

  @override
  Future<Activation> activate({
    required Uri cell,
    required String school,
    required String code,
    required String deviceId,
  }) => Future.error(_f);

  @override
  Future<SchoolSession> refresh({
    required Uri cell,
    required String school,
    required String deviceId,
    required String deviceSecret,
  }) => Future.error(_f);
}
