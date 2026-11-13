/// «سرور مستقل» پنل مالک روی همین دستگاه.
///
/// بدون سرور پلتفرم، همهٔ بخش‌های پنل (داشبورد، مدارس، پلن‌ها، سقف‌ها، سلامت، زیرساخت،
/// اپراتورها، گزارش‌ها و ممیزی) همین قرارداد `/api/platform/v1` را از این کلاس می‌گیرند؛
/// همان قواعد سرور واقعی (apps/owner-panel/server/platform-api.js و migrationهای
/// owner-panel) اینجا اجرا می‌شود: نقش، دلیل دست‌کم ۱۰ نویسه، حذف چهارچشمی با مهلت ۲۴
/// ساعت، نگه‌داری ۱۸۰ روزه، زنجیرهٔ هش ممیزی، ارجاع Secret به‌جای کلید خام و …
///
/// نگه‌داری: کل وضعیت در انبار امن دستگاه (DPAPI / Keystore) و — اگر دیتابیس در «تنظیمات»
/// وصل شده باشد — پاکت رمزشده در صندوقچهٔ آروان:
/// `payesh/platform/state-<kid>.json` (همان HKDF-SHA256 / AES-256-GCM پاکت فرمان، با نمک
/// جداگانهٔ `payesh/platform-state`). دستگاه دیگری با همان صندوقچه و کلید، همان داده را
/// می‌بیند؛ نسخهٔ تازه‌تر (rev بزرگ‌تر) برنده است.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart' as hash;
import 'package:cryptography/cryptography.dart'
    show SecretBoxAuthenticationError;
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'cloud_control.dart';
import 's3_client.dart';

/// نتیجهٔ یک بررسی سلامت Endpoint (فقط خط وضعیت؛ بدنه خوانده نمی‌شود).
final class CheckOutcome {
  const CheckOutcome({
    required this.ok,
    this.latencyMs,
    this.statusCode,
    this.errorCode,
  });
  final bool ok;
  final int? latencyMs;
  final int? statusCode;
  final String? errorCode;
}

typedef EndpointChecker = Future<CheckOutcome> Function(
  Map<String, Object?> endpoint,
);

/// وضعیت همگام‌سازی با دیتابیس (برای صفحهٔ «سلامت»).
final class PlatformSync {
  const PlatformSync({
    required this.state,
    this.bucket,
    this.endpoint,
    this.at,
    this.error,
  });

  /// `not_configured` · `synced` · `error` · `pending`
  final String state;
  final String? bucket;
  final String? endpoint;
  final DateTime? at;
  final String? error;
}

const String platformStateKey = 'owner.platform.state';
const String platformStateKind = 'payesh-platform-state';
const String platformStateSalt = 'payesh/platform-state';

/// نام پاکت وضعیت در صندوقچه برای یک Access Key.
String platformObjectKey(String accessKey) =>
    '${controlPrefix}platform/state-${controlKid(accessKey)}.json';

/// شناسهٔ پایدار مالک محلی (UUID از روی شناسهٔ ورود) — در هر دستگاه یکسان.
String localOwnerSub(String loginId) {
  final h = hash.sha256
      .convert(utf8.encode('payesh-owner-local:${loginId.trim()}'))
      .bytes;
  final b = List<int>.of(h.take(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final x = b.map((v) => v.toRadixString(16).padLeft(2, '0')).join();
  return '${x.substring(0, 8)}-${x.substring(8, 12)}-${x.substring(12, 16)}-'
      '${x.substring(16, 20)}-${x.substring(20)}';
}

final RegExp _uuidRe = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  caseSensitive: false,
);
final RegExp _slugRe = RegExp(r'^[a-z0-9][a-z0-9-]{2,39}$');
final RegExp _planCodeRe = RegExp(r'^[a-z0-9][a-z0-9_-]{1,31}$');
final RegExp _providerCodeRe = RegExp(r'^[a-z0-9][a-z0-9_-]{1,39}$');
final RegExp _credentialRefRe = RegExp(r'^secret:[A-Z][A-Z0-9_]{2,63}$');
final RegExp _regionRe = RegExp(r'^[A-Za-z0-9 ._-]{1,40}$');
final RegExp _endpointUrlRe = RegExp(
  r'^(https?|tcp)://[A-Za-z0-9.\-\[\]:]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/%-]*)?$',
);
final RegExp _rawCredentialKeyRe = RegExp(
  r'^(password|passwd|pass|api_key|apikey|token|access_token|secret|secret_key|private_key|credential|credentials|connection_string|dsn)$',
  caseSensitive: false,
);
const _roles = {'platform_owner', 'platform_operator', 'platform_support'};
const _providerKinds = {'host', 'vps', 'vpc', 'db', 'storage', 'other'};
const _serviceKinds = {
  'gateway',
  'postgres',
  'host',
  'vps',
  'vpc',
  'storage',
  'backup',
  'other',
};
const _metrics = [
  'capacity_cpu',
  'capacity_memory',
  'capacity_disk',
  'capacity_connections',
  'usage_cpu',
  'usage_memory',
  'usage_disk',
  'usage_connections',
  'error_rate',
  'latency_p95',
];
const _units = {'cores', 'percent', 'mb', 'gb', 'count', 'ms', 'ratio'};
const _changeActions = {
  'disable_provider',
  'enable_provider',
  'set_credential_ref',
  'disable_endpoint',
};

/// حداکثر رویداد ممیزی نگه‌داشته‌شده (زنجیره از قدیمی‌ترین ردیف باقی‌مانده ادامه دارد).
const int maxAuditEvents = 2000;
const Duration checkCooldown = Duration(seconds: 30);

/// خطای یک درخواست (همان شکل `{ok:false, error, detail?}` سرور).
final class _Fail implements Exception {
  const _Fail(this.status, this.code, [this.detail, this.extra]);
  final int status;
  final String code;
  final String? detail;
  final Map<String, Object?>? extra;
}

final class _Reply {
  const _Reply(this.status, this.body);
  final int status;
  final Map<String, Object?> body;
}

/// بررسی واقعی از همین دستگاه: http(s) فقط خط وضعیت، tcp فقط اتصال؛ ۵ ثانیه.
Future<CheckOutcome> defaultEndpointCheck(Map<String, Object?> e) async {
  final url = Uri.tryParse('${e['url']}');
  if (url == null) return const CheckOutcome(ok: false, errorCode: 'bad_url');
  final sw = Stopwatch()..start();
  const limit = Duration(seconds: 5);
  try {
    if (e['check_kind'] == 'tcp') {
      final s = await Socket.connect(url.host, url.port, timeout: limit);
      s.destroy();
      return CheckOutcome(ok: true, latencyMs: sw.elapsedMilliseconds);
    }
    final client = HttpClient(context: ownerTrustContext())
      ..connectionTimeout = limit;
    try {
      final req = await client.getUrl(url).timeout(limit);
      req.followRedirects = false;
      final res = await req.close().timeout(limit);
      final status = res.statusCode;
      unawaited(res.drain<void>().catchError((_) {}));
      final expected = e['expected_status'];
      final good = expected is num
          ? status == expected.toInt()
          : status >= 200 && status < 400;
      return CheckOutcome(
        ok: good,
        latencyMs: sw.elapsedMilliseconds,
        statusCode: status,
        errorCode: good ? null : 'unexpected_status',
      );
    } finally {
      client.close(force: true);
    }
  } on TimeoutException {
    return const CheckOutcome(ok: false, errorCode: 'check_timeout');
  } on HandshakeException {
    return const CheckOutcome(ok: false, errorCode: 'tls_failed');
  } on TlsException {
    return const CheckOutcome(ok: false, errorCode: 'tls_failed');
  } on SocketException catch (x) {
    final m = x.message.toLowerCase();
    final code = m.contains('lookup') || m.contains('host')
        ? 'dns_failed'
        : m.contains('refused')
        ? 'connection_refused'
        : 'connect_failed';
    return CheckOutcome(ok: false, errorCode: code);
  } on Object {
    return const CheckOutcome(ok: false, errorCode: 'check_failed');
  }
}

/// پیاده‌سازی درون‌برنامه‌ای `/api/platform/v1` (همان [OwnerHttp] که [OwnerApi] می‌خواهد).
final class LocalPlatform implements OwnerHttp {
  LocalPlatform({
    required this.secure,
    required this.s3Factory,
    DateTime Function()? now,
    EndpointChecker? checker,
    this.syncTimeout = const Duration(seconds: 8),
    Random? random,
    this.instance = 'local',
  }) : _now = now ?? DateTime.now,
       _checker = checker ?? defaultEndpointCheck,
       _rnd = random ?? Random.secure();

  final SecureStore secure;
  final S3Transport Function() s3Factory;
  final Duration syncTimeout;
  final String instance;
  final DateTime Function() _now;
  final EndpointChecker _checker;
  final Random _rnd;

  Map<String, Object?>? _st;
  Future<void>? _loading;
  final Set<String> _tokens = {};
  String? _sub;
  String? _loginId;
  PlatformSync _syncValue = const PlatformSync(state: 'not_configured');
  final StreamController<PlatformSync> _syncChanges =
      StreamController<PlatformSync>.broadcast();

  PlatformSync get _sync => _syncValue;
  set _sync(PlatformSync v) {
    _syncValue = v;
    if (!_syncChanges.isClosed) _syncChanges.add(v);
  }

  Future<void> _queue = Future.value();

  /// rev نسخهٔ صندوقچه در آخرین خواندن (۰ = نبود)؛ null = خوانده نشد.
  int? _remoteRev;
  DateTime? _lastPull;

  /// خواندن‌ها حداکثر هر این‌قدر یک بار صندوقچه را هم نگاه می‌کنند.
  static const Duration pullEvery = Duration(seconds: 15);

  PlatformSync get sync => _sync;

  /// هر بار که وضعیت اتصال به دیتابیس دوباره سنجیده می‌شود (چراغ نوار بالا).
  Stream<PlatformSync> get syncChanges => _syncChanges.stream;

  // ── session ─────────────────────────────────────────────────────────────

  /// نشست مالک محلی: توکنی به شکل `platform.v1.<body>.<sig>` که فقط همین نمونه می‌پذیرد
  /// (در حافظه؛ هیچ‌جا ذخیره نمی‌شود). ورود واقعی همان ورود محلی برنامه است.
  String signIn(String loginId, {Duration ttl = const Duration(days: 365)}) {
    final sub = localOwnerSub(loginId);
    _sub = sub;
    _loginId = loginId.trim();
    final body = base64Url
        .encode(
          utf8.encode(
            jsonEncode({
              'typ': 'platform',
              'v': 1,
              'sub': sub,
              'role': 'platform_owner',
              'exp': _now().add(ttl).millisecondsSinceEpoch,
            }),
          ),
        )
        .replaceAll('=', '');
    final sig = base64Url
        .encode(List<int>.generate(24, (_) => _rnd.nextInt(256)))
        .replaceAll('=', '');
    final t = 'platform.v1.$body.$sig';
    _tokens.add(t);
    return t;
  }

  void signOut() {
    _tokens.clear();
    _sub = null;
    _loginId = null;
  }

  // ── storage + sync ──────────────────────────────────────────────────────

  String _iso([DateTime? t]) => (t ?? _now()).toUtc().toIso8601String();

  String _uuid() {
    final b = List<int>.generate(16, (_) => _rnd.nextInt(256));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    final x = b.map((v) => v.toRadixString(16).padLeft(2, '0')).join();
    return '${x.substring(0, 8)}-${x.substring(8, 12)}-${x.substring(12, 16)}-'
        '${x.substring(16, 20)}-${x.substring(20)}';
  }

  static Map<String, Object?> _empty() => {
    'v': 1,
    'rev': 0,
    'seq': 0,
    'plans': <Object?>[],
    'tenants': <Object?>[],
    'subscriptions': <Object?>[],
    'sub_events': <Object?>[],
    'limits': <String, Object?>{},
    'usage': <String, Object?>{},
    'users': <Object?>[],
    'grant_requests': <Object?>[],
    'grants': <Object?>[],
    'deletions': <Object?>[],
    'providers': <Object?>[],
    'services': <Object?>[],
    'endpoints': <Object?>[],
    'checks': <Object?>[],
    'metrics': <Object?>[],
    'alerts': <Object?>[],
    'changes': <Object?>[],
    'audit': <Object?>[],
  };

  static Map<String, Object?>? _parse(String? text) {
    if (text == null || text.isEmpty) return null;
    try {
      final j = jsonDecode(text);
      if (j is! Map<String, Object?> || j['v'] != 1 || j['rev'] is! int) {
        return null;
      }
      final base = _empty()..addAll(j);
      return base;
    } on FormatException {
      return null;
    }
  }

  int _rev(Map<String, Object?>? s) => (s?['rev'] as int?) ?? 0;

  Future<void> _ensure() => _loading ??= _load();

  Future<void> _load() async {
    Map<String, Object?>? local;
    try {
      local = _parse(await secure.read(platformStateKey));
    } on SecureStoreException {
      local = null;
    }
    _st = local ?? _empty();
    await _pull();
    if (_seed()) await _commit(push: false);
    await _pushIfAhead();
  }

  /// اگر صندوقچه عقب‌تر است (یا تازه وصل شده و خالی است)، نسخهٔ این دستگاه را بفرست.
  Future<void> _pushIfAhead() async {
    final r = _remoteRev;
    if (_sync.state == 'synced' && r != null && _rev(_st) > r) await _push();
  }

  Future<void> _refreshIfStale() async {
    final last = _lastPull;
    if (last != null && _now().difference(last) < pullEvery) return;
    if (backgroundProbe && _sync.state == 'error') return;
    await _pull();
    await _pushIfAhead();
  }

  /// داده‌های اولیهٔ یک نصب تازه: پلن پایهٔ بدون سقف و حساب مالک همین دستگاه.
  bool _seed() {
    final s = _st!;
    var changed = false;
    final plans = _list(s, 'plans');
    if (s['seeded'] != true) {
      if (!plans.any((p) => p['code'] == 'basic')) {
        plans.add({
          'code': 'basic',
          'name': 'پایه (بدون سقف)',
          'max_users': null,
          'max_students': null,
          'storage_mb': null,
          'features': <String, Object?>{},
          'price_amount': 0,
          'price_cycle': 'none',
          'is_public': false,
          'created_at': _iso(),
          'updated_at': _iso(),
          'archived_at': null,
        });
      }
      s['seeded'] = true;
      changed = true;
    }
    final sub = _sub, login = _loginId;
    if (sub != null && login != null) {
      final users = _list(s, 'users');
      if (!users.any((u) => u['id'] == sub)) {
        users.add({
          'id': sub,
          'login_id': login,
          'role': 'platform_owner',
          'status': 'active',
          'created_at': _iso(),
          'updated_at': _iso(),
        });
        changed = true;
      }
    }
    return changed;
  }

  Future<S3Settings?> _s3() async {
    try {
      final s = await S3Settings.load(secure);
      return s == null || s.bucket.isEmpty ? null : s;
    } on SecureStoreException {
      return null;
    } on FormatException {
      return null;
    }
  }

  PlatformSync _syncOf(S3Settings s, String state, [String? error]) =>
      PlatformSync(
        state: state,
        bucket: s.bucket,
        endpoint: endpointText(s.endpoint),
        at: state == 'synced' ? _now() : _sync.at,
        error: error,
      );

  String _syncError(Object e) => switch (e) {
    S3Failure(:final messageFa) => messageFa,
    TimeoutException() => 'دیتابیس در زمان مقرر پاسخ نداد.',
    _ => 'اتصال به دیتابیس برقرار نشد.',
  };

  /// اگر نسخهٔ صندوقچه تازه‌تر است، همان را بردار.
  Future<void> _pull({Duration? timeout}) async {
    _lastPull = _now();
    _remoteRev = null;
    final s = await _s3();
    if (s == null) {
      _sync = const PlatformSync(state: 'not_configured');
      return;
    }
    final t = s3Factory();
    try {
      final text = await s3GetText(
        s,
        t,
        platformObjectKey(s.accessKey),
        now: _now,
      ).timeout(timeout ?? syncTimeout);
      await _applyRemote(s, text);
    } on Object catch (e) {
      _sync = _syncOf(s, 'error', _syncError(e));
    } finally {
      t.close();
    }
  }

  /// نسخهٔ خوانده‌شده از صندوقچه (null = نبود) را با نسخهٔ این دستگاه یکی می‌کند.
  Future<void> _applyRemote(S3Settings s, String? text) async {
    _lastPull = _now();
    final remote = text == null ? null : await _open(s, text);
    if (remote != null) {
      if (_rev(remote) > _rev(_st)) {
        _st = remote;
        await _saveLocal();
      }
      _remoteRev = _rev(remote);
    } else {
      // نبود، یا با Secret قبلیِ همین Access Key مهر شده بود: همین کلیدها برای صندوقچه
      // معتبرند (خواندن امضاشده پذیرفته شد) و آن پاکت را هیچ دارندهٔ فعلی نمی‌تواند باز کند
      _remoteRev = 0;
    }
    _sync = _syncOf(s, 'synced');
  }

  Future<Map<String, Object?>?> _open(S3Settings s, String text) async {
    try {
      final env = jsonDecode(text);
      if (env is! Map<String, Object?>) return null;
      final clear = await openBox(
        secret: s.secretKey,
        salt: platformStateSalt,
        kind: platformStateKind,
        env: env,
      );
      return _parse(clear);
    } on FormatException {
      return null;
    } on SecretBoxAuthenticationError {
      return null;
    }
  }

  Future<void> _push() async {
    final s = await _s3();
    if (s == null) {
      _sync = const PlatformSync(state: 'not_configured');
      return;
    }
    final st = _st!;
    final t = s3Factory();
    try {
      final env = await sealBox(
        secret: s.secretKey,
        salt: platformStateSalt,
        kind: platformStateKind,
        rev: max(1, _rev(st)),
        plaintext: jsonEncode(st),
      );
      await s3PutJson(
        s,
        t,
        platformObjectKey(s.accessKey),
        jsonEncode(env),
        now: _now,
      ).timeout(syncTimeout);
      _remoteRev = _rev(st);
      _sync = _syncOf(s, 'synced');
    } on Object catch (e) {
      _sync = _syncOf(s, 'error', _syncError(e));
    } finally {
      t.close();
    }
  }

  Future<void> _saveLocal() async {
    try {
      await secure.write(platformStateKey, jsonEncode(_st));
    } on SecureStoreException {
      // نسخهٔ دیتابیس (اگر وصل باشد) هنوز معتبر است؛ وضعیت در «سلامت» دیده می‌شود
    }
  }

  Future<void> _commit({bool push = true}) async {
    final st = _st!;
    st['rev'] = max(_now().millisecondsSinceEpoch, _rev(st) + 1);
    await _saveLocal();
    // فقط وقتی آخرین خواندن صندوقچه موفق بود؛ وگرنه نسخهٔ آنجا دست نمی‌خورد و بعد از
    // برقراری دوبارهٔ اتصال، نسخهٔ تازه‌تر فرستاده می‌شود
    if (push && _remoteRev != null) await _push();
  }

  /// سنجش فوری اتصال به دیتابیس (چراغ نوار بالا و بررسی دوره‌ای): همین حالا صندوقچه خوانده
  /// می‌شود (با تلاش دوبارهٔ کامل و مهلت بلندتر) و اگر نسخهٔ این دستگاه جلوتر است فرستاده می‌شود.
  /// خواندن از شبکه بیرون از صف انجام می‌شود تا هنگام قطعی، صفحه‌ها منتظر نمانند.
  Future<PlatformSync> probe({
    Duration timeout = const Duration(seconds: 45),
  }) async {
    await _serial(_ensure);
    final s = await _s3();
    if (s == null) {
      return _serial(() async {
        _remoteRev = null;
        return _sync = const PlatformSync(state: 'not_configured');
      });
    }
    String? text;
    Object? error;
    final t = s3Factory();
    try {
      text = await s3GetText(
        s,
        t,
        platformObjectKey(s.accessKey),
        now: _now,
      ).timeout(timeout);
    } on Object catch (e) {
      error = e;
    } finally {
      t.close();
    }
    return _serial(() async {
      // تنظیمات در این فاصله عوض شد؟ نتیجهٔ این سنجش دیگر معتبر نیست
      final now = await _s3();
      if (now == null || !now.sameTarget(s)) {
        await _pull();
      } else if (error != null) {
        _remoteRev = null;
        _sync = _syncOf(s, 'error', _syncError(error));
      } else {
        try {
          await _applyRemote(s, text);
        } on Object catch (e) {
          _remoteRev = null;
          _sync = _syncOf(s, 'error', _syncError(e));
        }
      }
      await _pushIfAhead();
      return _sync;
    });
  }

  /// سنجش پس‌زمینه روشن است (چراغ دیتابیس)؟ در این حالت خواندن صفحه‌ها هنگام قطعی منتظر
  /// شبکه نمی‌ماند؛ داده‌های همین دستگاه نشان داده می‌شود و پس از وصل شدن دوباره یکی می‌شوند.
  bool backgroundProbe = false;

  /// همگام‌سازی دستی (پس از ذخیرهٔ تنظیمات دیتابیس).
  Future<PlatformSync> syncNow() => _serial(() async {
    await _ensure();
    await _pull();
    await _pushIfAhead();
    return _sync;
  });

  Future<T> _serial<T>(Future<T> Function() f) {
    final c = Completer<T>();
    _queue = _queue.then((_) async {
      try {
        c.complete(await f());
      } on Object catch (e, s) {
        c.completeError(e, s);
      }
    });
    return c.future;
  }

  static List<Map<String, Object?>> _list(Map<String, Object?> s, String k) {
    final v = s[k];
    if (v is List<Map<String, Object?>>) return v;
    final out = <Map<String, Object?>>[
      if (v is List)
        for (final e in v)
          if (e is Map) e.cast<String, Object?>(),
    ];
    s[k] = out;
    return out;
  }

  static Map<String, Object?> _map(Map<String, Object?> s, String k) {
    final v = s[k];
    if (v is Map<String, Object?>) return v;
    final out = v is Map ? v.cast<String, Object?>() : <String, Object?>{};
    s[k] = out;
    return out;
  }

  // ── OwnerHttp ───────────────────────────────────────────────────────────

  @override
  Future<OwnerHttpResponse> send(
    String method,
    Uri url,
    Map<String, String> headers,
    String? body,
  ) async {
    final r = await _serial(() => _handle(method, url, headers, body));
    return OwnerHttpResponse(
      r.status,
      'application/json; charset=utf-8',
      jsonEncode(r.body),
    );
  }

  @override
  void close() {}

  Future<_Reply> _handle(
    String method,
    Uri url,
    Map<String, String> headers,
    String? body,
  ) async {
    var path = url.path;
    if (!path.startsWith(OwnerApi.prefix)) {
      return const _Reply(404, {'ok': false, 'error': 'not_found'});
    }
    path = path.substring(OwnerApi.prefix.length);
    if (path.length > 1 && path.endsWith('/')) {
      path = path.substring(0, path.length - 1);
    }
    Map<String, Object?> b = const {};
    if (body != null && body.isNotEmpty) {
      try {
        final j = jsonDecode(body);
        if (j is! Map<String, Object?>) throw const FormatException();
        b = j;
      } on FormatException {
        return const _Reply(400, {'ok': false, 'error': 'bad_json'});
      }
    }
    try {
      if (method == 'GET' && path == '/health/summary') {
        await _ensure();
        await _refreshIfStale();
        return _Reply(200, await _health());
      }
      if (method == 'POST' && path == '/auth/login') {
        // ورود این حالت همان ورود محلی برنامه است (شناسه + رمز + کد، بدون اینترنت)
        throw const _Fail(
          401,
          'invalid_credentials',
          'در حالت مستقل ورود با حساب محلی همین دستگاه انجام می‌شود.',
        );
      }
      final auth = headers['authorization'] ?? '';
      final tok = auth.startsWith('Bearer ') ? auth.substring(7).trim() : '';
      final claims = OwnerClaims.decode(tok, now: _now());
      if (!_tokens.contains(tok) || claims == null) {
        throw const _Fail(401, 'unauthorized');
      }
      await _ensure();
      final ctx = _Ctx(claims.sub, claims.role.wire, b);
      final seg = path.split('/').where((x) => x.isNotEmpty).toList();
      if (method == 'GET') {
        await _refreshIfStale();
        if (_seed()) await _commit();
        return _Reply(200, _get(seg, ctx));
      }
      if (method == 'DELETE' && seg.length == 2 && seg[0] == 'tenants') {
        throw const _Fail(
          403,
          'tenant_deletion_disabled',
          'حذف فوری مدرسه مجاز نیست؛ از درخواست حذف + تأیید مالک دوم + مهلت ۲۴ ساعت استفاده کنید.',
        );
      }
      if (method != 'POST') throw const _Fail(404, 'not_found');
      // پیش از هر تغییر: اگر دستگاه دیگری چیز تازه‌تری نوشته، اول همان را بردار
      await _pull();
      _seed();
      final r = await _post(seg, ctx);
      await _commit();
      return r;
    } on _Fail catch (f) {
      return _Reply(f.status, {
        'ok': false,
        'error': f.code,
        'detail': ?f.detail,
        ...?f.extra,
      });
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  static void _role(_Ctx c, List<String> roles) {
    if (!roles.contains(c.role)) {
      throw _Fail(403, 'role_forbidden', null, {'required': roles});
    }
  }

  static String _reason(Map<String, Object?> b) {
    final r = '${b['reason'] ?? ''}'.trim();
    if (r.length < 10) throw const _Fail(400, 'reason_too_short');
    return r;
  }

  static String _id(Object? v, String code) {
    final s = '${v ?? ''}';
    if (!_uuidRe.hasMatch(s)) throw _Fail(400, code);
    return s;
  }

  static Map<String, Object?> _project(
    Map<String, Object?> row,
    List<String> keys,
  ) => {
    for (final k in keys)
      if (row.containsKey(k)) k: row[k],
  };

  static const _fSub = [
    'id',
    'tenant_id',
    'plan_code',
    'status',
    'starts_at',
    'ends_at',
    'grace_days',
    'auto_renew',
    'canceled_at',
    'version',
    'updated_at',
  ];
  static const _fPlan = [
    'code',
    'name',
    'max_users',
    'max_students',
    'storage_mb',
    'features',
    'price_amount',
    'price_cycle',
    'is_public',
    'created_at',
    'updated_at',
    'archived_at',
  ];
  static const _fUser = [
    'id',
    'login_id',
    'role',
    'status',
    'created_at',
    'updated_at',
  ];
  static const _fDeletion = [
    'id',
    'tenant_id',
    'requested_by',
    'reason',
    'status',
    'approved_by',
    'approved_at',
    'not_before',
    'canceled_by',
    'canceled_at',
    'cancel_reason',
    'executed_by',
    'executed_at',
    'retain_until',
    'created_at',
    'subscriptions_canceled',
    'data_destroyed',
  ];

  String _actorRef(String sub) {
    final u = _list(_st!, 'users').where((x) => x['id'] == sub);
    return u.isEmpty ? sub : '${u.first['login_id']}';
  }

  static String _stable(Object? v) {
    if (v is Map) {
      final keys = v.keys.map((k) => '$k').toList()..sort();
      return '{${keys.map((k) => '${jsonEncode(k)}:${_stable(v[k])}').join(',')}}';
    }
    if (v is List) return '[${v.map(_stable).join(',')}]';
    return jsonEncode(v);
  }

  /// همان زنجیرهٔ هش سرور: sha256(previous || stable(payload)).
  void _audit(
    _Ctx c, {
    required String action,
    required String subjectType,
    String? subjectRef,
    String? tenantId,
    String? reason,
    Map<String, Object?> details = const {},
  }) {
    final st = _st!;
    final events = _list(st, 'audit');
    final prev = events.isEmpty
        ? '00' * 32
        : '${events.last['event_hash'] ?? '00' * 32}';
    final row = <String, Object?>{
      'event_id': _uuid(),
      'actor_id': c.sub,
      'actor_ref': _actorRef(c.sub),
      'action': action,
      'subject_type': subjectType,
      'subject_ref': subjectRef,
      'tenant_id': tenantId,
      'reason': reason,
      'details': {...details, 'mode': 'local'},
    };
    final prevBytes = [
      for (var i = 0; i < prev.length; i += 2)
        int.parse(prev.substring(i, i + 2), radix: 16),
    ];
    final h = hash.sha256.convert([
      ...prevBytes,
      ...utf8.encode(_stable(row)),
    ]).toString();
    final seq = ((st['seq'] as int?) ?? 0) + 1;
    st['seq'] = seq;
    events.add({
      ...row,
      'sequence_id': seq,
      'created_at': _iso(),
      'previous_hash': prev,
      'event_hash': h,
    });
    if (events.length > maxAuditEvents) {
      events.removeRange(0, events.length - maxAuditEvents);
    }
  }

  Map<String, Object?> _tenantRow(Map<String, Object?> sub) {
    final reg = _list(
      _st!,
      'tenants',
    ).where((t) => t['tenant_id'] == sub['tenant_id']);
    return {
      ..._project(sub, _fSub),
      if (reg.isNotEmpty) ...{
        'slug': reg.first['slug'],
        'display_name': reg.first['display_name'],
      },
    };
  }

  bool _isOpenGrant(Map<String, Object?> g) {
    final ends = DateTime.tryParse('${g['ends_at']}');
    return g['revoked_at'] == null && ends != null && ends.isAfter(_now());
  }

  Map<String, Object?> _metricView(Map<String, Object?>? r) {
    if (r == null || r['value'] == null) {
      return {
        'value': null,
        'label': '?',
        'unit': r?['unit'],
        'source': r?['source'] ?? 'none',
        'observed_at': r?['observed_at'],
      };
    }
    return {
      'value': r['value'],
      'label': r['label'],
      'unit': r['unit'],
      'source': r['source'],
      'observed_at': r['observed_at'],
    };
  }

  Map<String, Object?> _healthView(Map<String, Object?>? r) => r == null
      ? {
          'state': 'unknown',
          'checked_at': null,
          'latency_ms': null,
          'status_code': null,
          'error_code': null,
        }
      : {
          'state': r['ok'] == true ? 'up' : 'down',
          'checked_at': r['checked_at'],
          'latency_ms': r['latency_ms'],
          'status_code': r['status_code'],
          'error_code': r['error_code'],
        };

  // ── reads ───────────────────────────────────────────────────────────────

  Future<Map<String, Object?>> _health() async {
    final sy = _sync;
    int? servers;
    final s = await _s3();
    if (s != null) {
      final t = s3Factory();
      try {
        servers = (await readFollowers(s, t, now: _now).timeout(syncTimeout))
            .length;
      } on Object {
        servers = null;
      } finally {
        t.close();
      }
    }
    return {
      'ok': true,
      'namespace': OwnerApi.prefix,
      'instance': instance,
      'mode': 'local',
      'configured': true,
      'auth': 'local owner account on this device',
      'content_default': 'deny',
      'security': 'UNKNOWN',
      'database': {
        'state': sy.state,
        'bucket': sy.bucket,
        'endpoint': sy.endpoint,
        'last_sync_at': sy.at?.toUtc().toIso8601String(),
        'error': sy.error,
        'rev': _rev(_st),
      },
      'school_servers': servers,
    };
  }

  Map<String, Object?> _get(List<String> seg, _Ctx c) {
    final st = _st!;
    final p = '/${seg.join('/')}';
    switch (p) {
      case '/dashboard':
        return {
          'ok': true,
          'dashboard': {
            'subscriptions': _list(st, 'subscriptions').length,
            'plans': _list(st, 'plans').length,
            'active_users': _list(
              st,
              'users',
            ).where((u) => u['status'] == 'active').length,
            'open_grants': _list(st, 'grants').where(_isOpenGrant).length,
          },
        };
      case '/tenants':
        final subs = List.of(_list(st, 'subscriptions'))
          ..sort((a, b) => '${a['tenant_id']}'.compareTo('${b['tenant_id']}'));
        final rows = [for (final x in subs.take(200)) _tenantRow(x)];
        return {'ok': true, 'tenants': rows, 'count': rows.length};
      case '/plans':
        final rows = List.of(_list(st, 'plans'))
          ..sort((a, b) => '${a['code']}'.compareTo('${b['code']}'));
        return {
          'ok': true,
          'plans': [for (final x in rows) _project(x, _fPlan)],
          'count': rows.length,
        };
      case '/subscriptions':
        final rows = List.of(_list(st, 'subscriptions'));
        return {
          'ok': true,
          'subscriptions': [for (final x in rows) _project(x, _fSub)],
          'count': rows.length,
        };
      case '/platform-users':
        final rows = List.of(
          _list(st, 'users'),
        )..sort((a, b) => '${a['created_at']}'.compareTo('${b['created_at']}'));
        return {
          'ok': true,
          'users': [for (final x in rows) _project(x, _fUser)],
          'count': rows.length,
        };
      case '/support-grants':
        final rows = List.of(
          _list(st, 'grants'),
        )..sort((a, b) => '${b['created_at']}'.compareTo('${a['created_at']}'));
        return {'ok': true, 'grants': rows, 'count': rows.length};
      case '/audit':
        final rows = _list(st, 'audit').reversed.take(100).toList();
        return {'ok': true, 'events': rows, 'count': rows.length};
      case '/tenant-deletions':
        _role(c, ['platform_owner']);
        final rows = List.of(
          _list(st, 'deletions'),
        )..sort((a, b) => '${b['created_at']}'.compareTo('${a['created_at']}'));
        return {
          'ok': true,
          'requests': [for (final x in rows) _project(x, _fDeletion)],
          'count': rows.length,
        };
      case '/infra':
        return _infraSummary();
      case '/infra/changes':
        final rows = List.of(
          _list(st, 'changes'),
        )..sort((a, b) => '${b['created_at']}'.compareTo('${a['created_at']}'));
        return {'ok': true, 'changes': rows, 'count': rows.length};
    }
    if (seg.length >= 2 && seg[0] == 'tenants') {
      final t = _id(seg[1], 'invalid_tenant_id');
      if (seg.length == 2) {
        final s = _list(st, 'subscriptions').where((x) => x['tenant_id'] == t);
        if (s.isEmpty) throw const _Fail(404, 'tenant_not_found');
        return {'ok': true, 'tenant': _tenantRow(s.first)};
      }
      if (seg.length == 3 && seg[2] == 'limits') {
        final l = _map(st, 'limits')[t];
        return {'ok': true, 'limits': l};
      }
      if (seg.length == 3 && seg[2] == 'usage') {
        final u = _map(st, 'usage')[t];
        return {'ok': true, 'usage': u};
      }
      if (seg.length == 3 && seg[2] == 'content') {
        throw const _Fail(403, 'bulk_content_forbidden');
      }
      if (seg.length == 5 && seg[2] == 'content') {
        throw const _Fail(403, 'grant_required');
      }
    }
    throw const _Fail(404, 'not_found');
  }

  Map<String, Object?> _infraSummary() {
    final st = _st!;
    final checks = _list(st, 'checks');
    final metrics = _list(st, 'metrics');
    Map<String, Object?>? lastCheck(String id) {
      for (final c in checks.reversed) {
        if (c['endpoint_id'] == id) return c;
      }
      return null;
    }

    Map<String, Object?>? lastMetric(String sid, String m) {
      for (final r in metrics.reversed) {
        if (r['service_id'] == sid && r['metric'] == m) return r;
      }
      return null;
    }

    final providers = List.of(_list(st, 'providers'))
      ..sort((a, b) => '${a['code']}'.compareTo('${b['code']}'));
    return {
      'ok': true,
      'provisioning': {
        'automated': false,
        'detail': 'manual registry only; no provider API adapter is installed (row 124)',
      },
      'providers': [
        for (final p in providers)
          {
            ...p,
            'credential': p['credential_ref'] == null ? 'none' : 'reference',
            'adapter': {
              'mode': 'manual',
              'kinds': _providerKinds.toList(),
              'automated': false,
            },
          },
      ],
      'services': [
        for (final s in _list(st, 'services'))
          {
            ...s,
            'metrics': {
              for (final m in _metrics)
                m: _metricView(lastMetric('${s['id']}', m)),
            },
          },
      ],
      'endpoints': [
        for (final e in _list(st, 'endpoints'))
          {...e, 'health': _healthView(lastCheck('${e['id']}'))},
      ],
      'open_alerts': [
        for (final a in _list(st, 'alerts'))
          if (a['closed_at'] == null) a,
      ],
    };
  }

  // ── mutations ───────────────────────────────────────────────────────────

  Future<_Reply> _post(List<String> seg, _Ctx c) async {
    final st = _st!;
    final b = c.body;
    final p = '/${seg.join('/')}';
    switch (p) {
      case '/tenants':
        return _createTenant(c);
      case '/plans':
        _role(c, ['platform_owner']);
        final code = '${b['code'] ?? ''}'.trim();
        final name = '${b['name'] ?? ''}'.trim();
        if (!_planCodeRe.hasMatch(code) || name.isEmpty) {
          throw const _Fail(
            400,
            'invalid_input',
            'کد پلن ۲ تا ۳۲ نویسهٔ لاتین کوچک/رقم/-/_ و نام پلن لازم است.',
          );
        }
        final mb = b['storage_mb'];
        if (mb is! num || mb < 0) throw const _Fail(400, 'invalid_input');
        final plans = _list(st, 'plans');
        if (plans.any((x) => x['code'] == code)) {
          throw const _Fail(409, 'conflict', 'پلنی با همین کد وجود دارد.');
        }
        final row = <String, Object?>{
          'code': code,
          'name': name,
          'max_users': b['max_users'],
          'max_students': b['max_students'],
          'storage_mb': mb.toInt(),
          'features': <String, Object?>{},
          'price_amount': 0,
          'price_cycle': 'none',
          'is_public': false,
          'created_at': _iso(),
          'updated_at': _iso(),
          'archived_at': null,
        };
        plans.add(row);
        _audit(
          c,
          action: 'plan.create',
          subjectType: 'plan',
          subjectRef: code,
          reason: '${b['reason'] ?? 'plan created by platform owner'}',
          details: {'code': code},
        );
        return _Reply(201, {'ok': true, 'plan': _project(row, _fPlan)});
      case '/platform-users':
        _role(c, ['platform_owner']);
        final login = '${b['login_id'] ?? ''}'.trim();
        final role = '${b['role'] ?? ''}';
        if (login.isEmpty || login.length > 120 || !_roles.contains(role)) {
          throw const _Fail(400, 'invalid_input');
        }
        final users = _list(st, 'users');
        if (users.any((u) => u['login_id'] == login)) {
          throw const _Fail(409, 'conflict', 'این شناسه قبلاً ثبت شده است.');
        }
        final row = <String, Object?>{
          'id': _uuid(),
          'login_id': login,
          'role': role,
          'status': 'active',
          'created_at': _iso(),
          'updated_at': _iso(),
        };
        users.add(row);
        _audit(
          c,
          action: 'platform_user.create',
          subjectType: 'platform_user',
          subjectRef: login,
          reason: '${b['reason'] ?? 'platform user registered'}',
          details: {'role': role},
        );
        return _Reply(201, {'ok': true, 'user': _project(row, _fUser)});
      case '/support-grants':
        // مالک فقط تأیید می‌کند؛ درخواست از اپراتور/پشتیبانی است (چهارچشم)
        _role(c, ['platform_operator', 'platform_support']);
        throw const _Fail(403, 'role_forbidden');
      case '/infra/providers':
        return _infraProvider(c);
      case '/infra/services':
        return _infraService(c);
      case '/infra/endpoints':
        return _infraEndpoint(c);
      case '/infra/metrics':
        return _infraMetric(c);
      case '/infra/changes':
        return _infraChange(c);
    }
    if (seg.length == 3 && seg[0] == 'tenants') {
      final t = _id(seg[1], 'invalid_tenant_id');
      if (seg[2] == 'suspend') return _suspend(c, t);
      if (seg[2] == 'deletion-request') return _deletionRequest(c, t);
    }
    if (seg.length == 3 && seg[0] == 'tenant-deletions') {
      _role(c, ['platform_owner']);
      final rid = _id(seg[1], 'invalid_request_id');
      final x = _list(st, 'deletions').where((d) => d['id'] == rid);
      if (x.isEmpty) throw const _Fail(404, 'request_not_found');
      final row = x.first;
      switch (seg[2]) {
        case 'approve':
          return _deletionApprove(c, row);
        case 'cancel':
          return _deletionCancel(c, row);
        case 'execute':
          return _deletionExecute(c, row);
      }
    }
    if (seg.length == 3 && seg[0] == 'subscriptions' && seg[2] == 'renew') {
      return _renew(c, _id(seg[1], 'invalid_subscription_id'));
    }
    if (seg.length == 3 && seg[0] == 'support-grants') {
      _role(c, ['platform_owner']);
      if (seg[2] == 'approve') {
        final rid = _id(seg[1], 'invalid_request_id');
        final r = _list(
          st,
          'grant_requests',
        ).where((x) => x['id'] == rid && x['status'] == 'pending');
        if (r.isEmpty) throw const _Fail(404, 'request_not_found');
        throw const _Fail(403, 'forbidden');
      }
      if (seg[2] == 'revoke') {
        final gid = _id(seg[1], 'invalid_grant_id');
        final g = _list(st, 'grants').where((x) => x['id'] == gid);
        if (g.isEmpty) throw const _Fail(404, 'grant_not_found');
        final reason = _reason(b);
        if (g.first['revoked_at'] != null) {
          throw const _Fail(403, 'forbidden');
        }
        g.first['revoked_at'] = _iso();
        g.first['open_slot'] = null;
        _audit(
          c,
          action: 'grant.revoke',
          subjectType: 'support_grant',
          subjectRef: gid,
          tenantId: '${g.first['tenant_id']}',
          reason: reason,
        );
        return const _Reply(200, {'ok': true});
      }
    }
    if (seg.length == 4 &&
        seg[0] == 'infra' &&
        seg[1] == 'endpoints' &&
        seg[3] == 'check') {
      return _infraCheck(c, _id(seg[2], 'invalid_endpoint_id'));
    }
    if (seg.length == 4 &&
        seg[0] == 'infra' &&
        seg[1] == 'changes' &&
        seg[3] == 'approve') {
      return _infraApprove(c, _id(seg[2], 'invalid_request_id'));
    }
    throw const _Fail(404, 'not_found');
  }

  _Reply _createTenant(_Ctx c) {
    _role(c, ['platform_owner']);
    final st = _st!;
    final b = c.body;
    final op = _id(b['provision_op_id'], 'invalid_provision_op_id');
    final slug = '${b['slug'] ?? ''}'.trim();
    if (!_slugRe.hasMatch(slug)) throw const _Fail(400, 'invalid_slug');
    final name = '${b['display_name'] ?? ''}'.trim();
    if (name.length < 2 || name.length > 120) {
      throw const _Fail(400, 'invalid_display_name');
    }
    final manager = '${b['manager_name'] ?? ''}'.trim();
    if (manager.length < 2 || manager.length > 120) {
      throw const _Fail(400, 'invalid_manager_name');
    }
    final plan = '${b['plan_code'] ?? ''}';
    final reason = _reason(b);
    final reg = _list(st, 'tenants');
    final same = reg.where((t) => t['provision_op_id'] == op);
    if (same.isNotEmpty) {
      final t = same.first;
      if (t['slug'] != slug) {
        throw const _Fail(
          409,
          'conflict',
          'این درخواست برای مدرسهٔ دیگری بود.',
        );
      }
      return _Reply(200, {
        'ok': true,
        'tenant': _project(t, [
          'tenant_id',
          'slug',
          'display_name',
          'plan_code',
          'status',
        ]),
        'manager': {
          'uid': null,
          'school': slug,
          'activated': false,
          'activation_code': null,
        },
        'idempotent': true,
      });
    }
    if (reg.any((t) => t['slug'] == slug)) {
      throw const _Fail(409, 'conflict', 'این نشانی کوتاه قبلاً ثبت شده است.');
    }
    final pl = _list(
      st,
      'plans',
    ).where((x) => x['code'] == plan && x['archived_at'] == null);
    if (pl.isEmpty) {
      throw const _Fail(400, 'invalid_input', 'پلنی با این کد وجود ندارد.');
    }
    final now = _now();
    final tid = _uuid();
    final sid = _uuid();
    final row = <String, Object?>{
      'tenant_id': tid,
      'slug': slug,
      'display_name': name,
      'manager_name': manager,
      'provision_op_id': op,
      'plan_code': plan,
      'status': 'active',
      'created_by': c.sub,
      'created_at': _iso(now),
      'activated_at': _iso(now),
    };
    reg.add(row);
    _list(st, 'subscriptions').add({
      'id': sid,
      'tenant_id': tid,
      'plan_code': plan,
      'status': 'active',
      'starts_at': _iso(now),
      'ends_at': _iso(now.add(const Duration(days: 30))),
      'grace_days': null,
      'auto_renew': false,
      'canceled_at': null,
      'version': 1,
      'updated_at': _iso(now),
    });
    _list(st, 'sub_events').add({
      'tenant_id': tid,
      'subscription_id': sid,
      'from_status': null,
      'to_status': 'active',
      'reason': 'owner_action',
      'idempotency_key': 'provision:$op',
      'created_at': _iso(now),
    });
    final p0 = pl.first;
    final mb = p0['storage_mb'];
    _map(st, 'limits')[tid] = {
      'tenant_id': tid,
      'max_users': p0['max_users'],
      'max_students': p0['max_students'],
      'storage_bytes': mb is num ? mb.toInt() * 1048576 : null,
      'updated_at': _iso(now),
    };
    _audit(
      c,
      action: 'tenant.provision',
      subjectType: 'tenant',
      subjectRef: tid,
      tenantId: tid,
      reason: reason,
      details: {'slug': slug, 'plan_code': plan, 'provision_op_id': op},
    );
    _audit(
      c,
      action: 'tenant.activate',
      subjectType: 'tenant',
      subjectRef: tid,
      tenantId: tid,
      reason: reason,
      details: {'slug': slug, 'provision_op_id': op},
    );
    return _Reply(201, {
      'ok': true,
      'tenant': {
        'tenant_id': tid,
        'slug': slug,
        'display_name': name,
        'plan_code': plan,
        'status': 'active',
      },
      // سرور هر مدرسه مستقل است و مدیر اولیه را در راه‌اندازی خودش می‌سازد؛ کد فعال‌سازی ندارد
      'manager': {
        'uid': null,
        'school': slug,
        'activated': false,
        'activation_code': null,
      },
      'idempotent': false,
    });
  }

  Map<String, Object?> _subOf(String tenantId) {
    final s = _list(
      _st!,
      'subscriptions',
    ).where((x) => x['tenant_id'] == tenantId);
    if (s.isEmpty) throw const _Fail(404, 'tenant_not_found');
    return s.first;
  }

  /// همان apply_subscription_transition: کلید تکرار، رویداد، نسخه.
  Map<String, Object?> _transition(
    _Ctx c,
    Map<String, Object?> s,
    String to,
    String note,
    String key,
    int days,
  ) {
    final events = _list(_st!, 'sub_events');
    final prior = events.where(
      (e) => e['tenant_id'] == s['tenant_id'] && e['idempotency_key'] == key,
    );
    if (prior.isNotEmpty) {
      return {'ok': true, 'idempotent': true, 'event': prior.first};
    }
    final from = s['status'];
    final now = _now();
    events.add({
      'tenant_id': s['tenant_id'],
      'subscription_id': s['id'],
      'from_status': from,
      'to_status': to,
      'reason': to == 'active' ? 'renew' : 'owner_action',
      'actor_ref': _actorRef(c.sub),
      'idempotency_key': key,
      'created_at': _iso(now),
    });
    s['status'] = to;
    s['version'] = ((s['version'] as int?) ?? 1) + 1;
    s['updated_at'] = _iso(now);
    if (to == 'active') {
      final ends = DateTime.tryParse('${s['ends_at']}') ?? now;
      final base = ends.isAfter(now) ? ends : now;
      s['ends_at'] = _iso(base.add(Duration(days: max(days, 1))));
      s['canceled_at'] = null;
    }
    return {
      'ok': true,
      'idempotent': false,
      'subscription_id': s['id'],
      'tenant_id': s['tenant_id'],
      'from_status': from,
      'to_status': to,
      'note': note,
    };
  }

  _Reply _renew(_Ctx c, String sid) {
    _role(c, ['platform_owner']);
    final reason = _reason(c.body);
    final s = _list(_st!, 'subscriptions').where((x) => x['id'] == sid);
    if (s.isEmpty) throw const _Fail(404, 'subscription_not_found');
    final days = c.body['extend_days'];
    final r = _transition(
      c,
      s.first,
      'active',
      reason,
      '${c.body['idempotency_key'] ?? _uuid()}',
      days is num ? days.toInt() : 30,
    );
    _audit(
      c,
      action: 'subscription.renew',
      subjectType: 'subscription',
      subjectRef: sid,
      tenantId: '${s.first['tenant_id']}',
      reason: reason,
      details: {'idempotent': r['idempotent'] == true},
    );
    return _Reply(200, {'ok': true, 'transition': r});
  }

  _Reply _suspend(_Ctx c, String t) {
    _role(c, ['platform_owner', 'platform_operator']);
    final reason = _reason(c.body);
    final s = _subOf(t);
    final r = _transition(
      c,
      s,
      'suspended',
      reason,
      '${c.body['idempotency_key'] ?? _uuid()}',
      1,
    );
    _audit(
      c,
      action: 'tenant.suspend',
      subjectType: 'tenant',
      subjectRef: t,
      tenantId: t,
      reason: reason,
    );
    return _Reply(200, {'ok': true, 'transition': r});
  }

  _Reply _deletionRequest(_Ctx c, String t) {
    _role(c, ['platform_owner']);
    final reason = _reason(c.body);
    if ('${c.body['confirm_tenant_id'] ?? ''}' != t) {
      throw const _Fail(400, 'confirm_mismatch');
    }
    _subOf(t);
    final dels = _list(_st!, 'deletions');
    if (dels.any(
      (d) =>
          d['tenant_id'] == t &&
          (d['status'] == 'pending' || d['status'] == 'approved'),
    )) {
      throw const _Fail(409, 'conflict');
    }
    final row = <String, Object?>{
      'id': _uuid(),
      'tenant_id': t,
      'requested_by': c.sub,
      'reason': reason,
      'status': 'pending',
      'approved_by': null,
      'approved_at': null,
      'not_before': null,
      'canceled_by': null,
      'canceled_at': null,
      'cancel_reason': null,
      'executed_by': null,
      'executed_at': null,
      'retain_until': null,
      'created_at': _iso(),
      'subscriptions_canceled': null,
      'data_destroyed': false,
    };
    dels.add(row);
    _audit(
      c,
      action: 'tenant.deletion.request',
      subjectType: 'tenant_deletion_request',
      subjectRef: '${row['id']}',
      tenantId: t,
      reason: reason,
    );
    return _Reply(201, {'ok': true, 'request': _project(row, _fDeletion)});
  }

  _Reply _deletionApprove(_Ctx c, Map<String, Object?> x) {
    if (x['requested_by'] == c.sub) {
      throw const _Fail(403, 'four_eyes_required');
    }
    if (x['status'] != 'pending') throw const _Fail(403, 'forbidden');
    final now = _now();
    x['status'] = 'approved';
    x['approved_by'] = c.sub;
    x['approved_at'] = _iso(now);
    x['not_before'] = _iso(now.add(const Duration(hours: 24)));
    _audit(
      c,
      action: 'tenant.deletion.approve',
      subjectType: 'tenant_deletion_request',
      subjectRef: '${x['id']}',
      tenantId: '${x['tenant_id']}',
      reason: '${c.body['reason'] ?? 'deletion approved by second owner'}',
      details: {'not_before': x['not_before']},
    );
    return _Reply(200, {'ok': true, 'request': _project(x, _fDeletion)});
  }

  _Reply _deletionCancel(_Ctx c, Map<String, Object?> x) {
    final reason = _reason(c.body);
    if (x['status'] != 'pending' && x['status'] != 'approved') {
      throw const _Fail(403, 'forbidden');
    }
    x['status'] = 'canceled';
    x['canceled_by'] = c.sub;
    x['canceled_at'] = _iso();
    x['cancel_reason'] = reason;
    _audit(
      c,
      action: 'tenant.deletion.cancel',
      subjectType: 'tenant_deletion_request',
      subjectRef: '${x['id']}',
      tenantId: '${x['tenant_id']}',
      reason: reason,
    );
    return _Reply(200, {'ok': true, 'request': _project(x, _fDeletion)});
  }

  _Reply _deletionExecute(_Ctx c, Map<String, Object?> x) {
    if (x['status'] != 'approved') throw const _Fail(403, 'forbidden');
    final nb = DateTime.tryParse('${x['not_before']}');
    final now = _now();
    if (nb == null || now.isBefore(nb)) {
      throw _Fail(409, 'deletion_delay_pending', null, {
        'not_before': x['not_before'],
      });
    }
    var n = 0;
    for (final s in _list(_st!, 'subscriptions')) {
      if (s['tenant_id'] == x['tenant_id'] && s['status'] != 'canceled') {
        s['status'] = 'canceled';
        s['canceled_at'] = _iso(now);
        s['auto_renew'] = false;
        n++;
      }
    }
    x['status'] = 'executed';
    x['executed_by'] = c.sub;
    x['executed_at'] = _iso(now);
    x['retain_until'] = _iso(now.add(const Duration(days: 180)));
    x['subscriptions_canceled'] = n;
    x['data_destroyed'] = false;
    _audit(
      c,
      action: 'tenant.deletion.execute',
      subjectType: 'tenant_deletion_request',
      subjectRef: '${x['id']}',
      tenantId: '${x['tenant_id']}',
      reason:
          '${c.body['reason'] ?? 'deletion executed after four-eyes approval and 24h delay'}',
      details: {
        'retain_until': x['retain_until'],
        'subscriptions_canceled': n,
        'data_destroyed': false,
      },
    );
    return _Reply(200, {'ok': true, 'request': _project(x, _fDeletion)});
  }

  // ── infrastructure ──────────────────────────────────────────────────────

  static void _noRawCredential(Map<String, Object?> b) {
    final k = b.keys.where(_rawCredentialKeyRe.hasMatch);
    if (k.isNotEmpty) {
      throw _Fail(400, 'credentials_not_accepted', null, {'field': k.first});
    }
  }

  _Reply _infraProvider(_Ctx c) {
    _role(c, ['platform_owner', 'platform_operator']);
    final b = c.body;
    _noRawCredential(b);
    if ('${b['api_mode'] ?? 'manual'}' != 'manual') {
      throw const _Fail(501, 'provider_api_not_implemented', 'row 124');
    }
    final refRaw = b['credential_ref'];
    final ref = refRaw == null || refRaw == '' ? null : '$refRaw';
    if (ref != null && !_credentialRefRe.hasMatch(ref)) {
      throw const _Fail(400, 'credential_must_be_reference');
    }
    final code = '${b['code'] ?? ''}'.trim();
    final name = '${b['display_name'] ?? ''}'.trim();
    final kind = '${b['kind'] ?? ''}';
    if (!_providerCodeRe.hasMatch(code) ||
        name.length < 2 ||
        name.length > 120 ||
        !_providerKinds.contains(kind)) {
      throw const _Fail(400, 'invalid_input');
    }
    final list = _list(_st!, 'providers');
    if (list.any((p) => p['code'] == code)) {
      throw const _Fail(
        409,
        'conflict',
        'ارائه‌دهنده‌ای با همین کد وجود دارد.',
      );
    }
    final row = <String, Object?>{
      'id': _uuid(),
      'code': code,
      'display_name': name,
      'kind': kind,
      'api_mode': 'manual',
      'credential_ref': ref,
      'status': 'active',
      'notes': b['notes'] == null ? null : '${b['notes']}',
      'created_at': _iso(),
      'updated_at': _iso(),
    };
    list.add(row);
    _audit(
      c,
      action: 'infra.provider.register',
      subjectType: 'infra_provider',
      subjectRef: '${row['id']}',
      reason: '${b['reason'] ?? 'manual provider registration'}',
      details: {
        'code': code,
        'kind': kind,
        'api_mode': 'manual',
        'credential_ref_set': ref != null,
      },
    );
    return _Reply(201, {'ok': true, 'provider': row});
  }

  _Reply _infraService(_Ctx c) {
    _role(c, ['platform_owner', 'platform_operator']);
    final b = c.body;
    final pid = _id(b['provider_id'], 'invalid_provider_id');
    final pr = _list(
      _st!,
      'providers',
    ).where((p) => p['id'] == pid && p['status'] == 'active');
    if (pr.isEmpty) {
      throw const _Fail(
        400,
        'invalid_input',
        'ارائه‌دهنده نیست یا غیرفعال است.',
      );
    }
    final name = '${b['name'] ?? ''}'.trim();
    final kind = '${b['kind'] ?? ''}';
    final region = b['region'] == null ? null : '${b['region']}';
    if (name.length < 2 ||
        name.length > 120 ||
        !_serviceKinds.contains(kind) ||
        (region != null && !_regionRe.hasMatch(region))) {
      throw const _Fail(400, 'invalid_input');
    }
    final row = <String, Object?>{
      'id': _uuid(),
      'provider_id': pid,
      'name': name,
      'kind': kind,
      'region': region,
      'status': 'active',
      'created_at': _iso(),
    };
    _list(_st!, 'services').add(row);
    _audit(
      c,
      action: 'infra.service.register',
      subjectType: 'infra_service',
      subjectRef: '${row['id']}',
      reason: '${b['reason'] ?? 'manual service registration'}',
      details: {'provider_id': pid, 'kind': kind},
    );
    return _Reply(201, {'ok': true, 'service': row});
  }

  _Reply _infraEndpoint(_Ctx c) {
    _role(c, ['platform_owner', 'platform_operator']);
    final b = c.body;
    final sid = _id(b['service_id'], 'invalid_service_id');
    if (!_list(_st!, 'services').any((s) => s['id'] == sid)) {
      throw const _Fail(400, 'invalid_service_id');
    }
    final kind = '${b['check_kind'] ?? ''}';
    final url = '${b['url'] ?? ''}';
    final u = Uri.tryParse(url);
    final schemeOk = kind == 'http'
        ? (u?.scheme == 'http' || u?.scheme == 'https')
        : kind == 'tcp' && u?.scheme == 'tcp' && (u?.hasPort ?? false);
    if (u == null ||
        !schemeOk ||
        url.contains('@') ||
        url.length > 300 ||
        !_endpointUrlRe.hasMatch(url)) {
      throw const _Fail(
        400,
        'invalid_endpoint',
        'http(s)/tcp URL without user:password',
      );
    }
    final ex = b['expected_status'];
    if (ex != null && (ex is! num || ex < 100 || ex > 599)) {
      throw const _Fail(400, 'invalid_input');
    }
    final row = <String, Object?>{
      'id': _uuid(),
      'service_id': sid,
      'url': url,
      'check_kind': kind,
      'expected_status': ex is num ? ex.toInt() : null,
      'enabled': true,
      'created_at': _iso(),
    };
    _list(_st!, 'endpoints').add(row);
    _audit(
      c,
      action: 'infra.endpoint.register',
      subjectType: 'infra_endpoint',
      subjectRef: '${row['id']}',
      reason: '${b['reason'] ?? 'manual endpoint registration'}',
      details: {'service_id': sid, 'check_kind': kind},
    );
    return _Reply(201, {'ok': true, 'endpoint': row});
  }

  _Reply _infraMetric(_Ctx c) {
    _role(c, ['platform_owner', 'platform_operator']);
    final b = c.body;
    final sid = _id(b['service_id'], 'invalid_service_id');
    if (!_list(_st!, 'services').any((s) => s['id'] == sid)) {
      throw const _Fail(400, 'invalid_service_id');
    }
    if (b['source'] == 'provider_api') {
      throw const _Fail(501, 'provider_api_not_implemented', 'row 124');
    }
    final v = b['value'];
    final unknown = v == null || v == '';
    final label = unknown ? '?' : '${b['label'] ?? ''}';
    if (!unknown && label != 'M' && label != 'E') {
      throw const _Fail(400, 'label_required');
    }
    final metric = '${b['metric'] ?? ''}';
    final unit = '${b['unit'] ?? ''}';
    final num? value = unknown ? null : (v is num ? v : num.tryParse('$v'));
    if (!_metrics.contains(metric) ||
        !_units.contains(unit) ||
        (!unknown && (value == null || value < 0))) {
      throw const _Fail(400, 'invalid_input');
    }
    final row = <String, Object?>{
      'service_id': sid,
      'metric': metric,
      'value': value,
      'unit': unit,
      'label': label,
      'source': '${b['source'] ?? 'manual'}',
      'observed_at': _iso(),
    };
    final list = _list(_st!, 'metrics')..add(row);
    // فقط تاریخچهٔ کوتاه نگه داشته می‌شود
    if (list.length > 500) list.removeRange(0, list.length - 500);
    _audit(
      c,
      action: 'infra.metric.record',
      subjectType: 'infra_service',
      subjectRef: sid,
      reason: '${b['reason'] ?? 'manual metric entry'}',
      details: {'metric': metric, 'label': label, 'source': row['source']},
    );
    return _Reply(201, {'ok': true, 'metric': _metricView(row)});
  }

  _Reply _infraChange(_Ctx c) {
    _role(c, ['platform_owner', 'platform_operator']);
    final b = c.body;
    final action = '${b['action'] ?? ''}';
    if (!_changeActions.contains(action)) {
      throw const _Fail(400, 'invalid_action');
    }
    final target = _id(b['target_id'], 'invalid_target_id');
    final reason = _reason(b);
    final p = b['payload'] is Map
        ? (b['payload']! as Map).cast<String, Object?>()
        : const <String, Object?>{};
    _noRawCredential(p);
    var payload = <String, Object?>{};
    if (action == 'set_credential_ref') {
      final ref = '${p['credential_ref'] ?? ''}';
      if (ref.isNotEmpty && !_credentialRefRe.hasMatch(ref)) {
        throw const _Fail(400, 'credential_must_be_reference');
      }
      payload = {'credential_ref': ref};
    }
    final exists = action == 'disable_endpoint'
        ? _list(_st!, 'endpoints').any((e) => e['id'] == target)
        : _list(_st!, 'providers').any((e) => e['id'] == target);
    if (!exists) {
      throw const _Fail(400, 'invalid_input', 'هدف تغییر پیدا نشد.');
    }
    final row = <String, Object?>{
      'id': _uuid(),
      'action': action,
      'target_id': target,
      'payload': payload,
      'reason': reason,
      'requested_by': c.sub,
      'status': 'pending',
      'approved_by': null,
      'decided_at': null,
      'created_at': _iso(),
    };
    _list(_st!, 'changes').add(row);
    _audit(
      c,
      action: 'infra.change.request',
      subjectType: 'infra_change_request',
      subjectRef: '${row['id']}',
      reason: reason,
      details: {
        'change': action,
        'target_id': target,
        'credential_ref_set': '${payload['credential_ref'] ?? ''}'.isNotEmpty,
      },
    );
    return _Reply(201, {
      'ok': true,
      'change': row,
      'approval': 'pending: platform_owner must approve',
    });
  }

  _Reply _infraApprove(_Ctx c, String id) {
    _role(c, ['platform_owner']);
    final st = _st!;
    final r = _list(
      st,
      'changes',
    ).where((x) => x['id'] == id && x['status'] == 'pending');
    if (r.isEmpty) throw const _Fail(403, 'forbidden');
    final x = r.first;
    final now = _iso();
    final target = x['target_id'];
    switch (x['action']) {
      case 'disable_provider' || 'enable_provider':
        for (final p in _list(
          st,
          'providers',
        ).where((p) => p['id'] == target)) {
          p['status'] = x['action'] == 'disable_provider'
              ? 'disabled'
              : 'active';
          p['updated_at'] = now;
        }
      case 'set_credential_ref':
        final ref = '${(x['payload'] as Map?)?['credential_ref'] ?? ''}';
        for (final p in _list(
          st,
          'providers',
        ).where((p) => p['id'] == target)) {
          p['credential_ref'] = ref.isEmpty ? null : ref;
          p['updated_at'] = now;
        }
      default:
        for (final e in _list(
          st,
          'endpoints',
        ).where((e) => e['id'] == target)) {
          e['enabled'] = false;
        }
    }
    x['status'] = 'executed';
    x['approved_by'] = c.sub;
    x['decided_at'] = now;
    _audit(
      c,
      action: 'infra.change.approve',
      subjectType: 'infra_change_request',
      subjectRef: id,
      reason: '${c.body['reason'] ?? x['reason']}',
      details: {'change': x['action'], 'target_id': target},
    );
    return _Reply(200, {'ok': true, 'change': x});
  }

  Future<_Reply> _infraCheck(_Ctx c, String eid) async {
    _role(c, ['platform_owner', 'platform_operator']);
    final st = _st!;
    final e = _list(st, 'endpoints').where((x) => x['id'] == eid);
    if (e.isEmpty) throw const _Fail(404, 'endpoint_not_found');
    if (e.first['enabled'] != true) throw const _Fail(409, 'endpoint_disabled');
    final checks = _list(st, 'checks');
    final now = _now();
    for (final x in checks.reversed) {
      if (x['endpoint_id'] != eid) continue;
      final at = DateTime.tryParse('${x['checked_at']}');
      final age = at == null ? checkCooldown : now.difference(at);
      if (age < checkCooldown) {
        throw _Fail(429, 'check_cooldown', null, {
          'retry_after_ms': (checkCooldown - age).inMilliseconds,
        });
      }
      break;
    }
    final r = await _checker(e.first);
    checks.add({
      'endpoint_id': eid,
      'ok': r.ok,
      'latency_ms': r.latencyMs,
      'status_code': r.statusCode,
      'error_code': r.ok ? null : (r.errorCode ?? 'check_failed'),
      'checked_at': _iso(),
    });
    // فقط ۲۰ بررسی آخر هر Endpoint
    final mine = checks.where((x) => x['endpoint_id'] == eid).toList();
    if (mine.length > 20) {
      for (final old in mine.take(mine.length - 20)) {
        checks.remove(old);
      }
    }
    String? opened, closed;
    final alerts = _list(st, 'alerts');
    final open = alerts
        .where((a) => a['endpoint_id'] == eid && a['closed_at'] == null)
        .toList();
    if (r.ok) {
      if (open.isNotEmpty) {
        open.first['closed_at'] = _iso();
        closed = '${open.first['id']}';
        _audit(
          c,
          action: 'infra.alert.close',
          subjectType: 'infra_alert',
          subjectRef: closed,
          reason: 'endpoint recovered: check succeeded',
          details: {'endpoint_id': eid},
        );
      }
    } else {
      final last3 = checks
          .where((x) => x['endpoint_id'] == eid)
          .toList()
          .reversed
          .take(3)
          .toList();
      if (last3.length == 3 &&
          last3.every((x) => x['ok'] != true) &&
          open.isEmpty) {
        final a = <String, Object?>{
          'id': _uuid(),
          'endpoint_id': eid,
          'kind': 'endpoint_down',
          'severity': 'critical',
          'opened_at': _iso(),
          'closed_at': null,
          'detail': 'consecutive_failures=3',
        };
        alerts.add(a);
        opened = '${a['id']}';
        _audit(
          c,
          action: 'infra.alert.open',
          subjectType: 'infra_alert',
          subjectRef: opened,
          reason: 'endpoint down: 3 consecutive failed checks',
          details: {'endpoint_id': eid, 'error_code': r.errorCode},
        );
      }
    }
    return _Reply(200, {
      'ok': true,
      'check': {
        'endpoint_id': eid,
        'ok': r.ok,
        'latency_ms': r.latencyMs,
        'status_code': r.statusCode,
        'error_code': r.ok ? null : (r.errorCode ?? 'check_failed'),
      },
      'alert': {'opened': opened, 'closed': closed},
    });
  }
}

final class _Ctx {
  const _Ctx(this.sub, this.role, this.body);
  final String sub;
  final String role;
  final Map<String, Object?> body;
}
