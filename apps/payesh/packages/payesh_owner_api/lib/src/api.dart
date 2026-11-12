import 'dart:convert';

import 'caps.dart';
import 'claims.dart';
import 'errors.dart';
import 'rules.dart';
import 'transport.dart';

/// Result of one API call — same shape as the web panel's `{ok, status, kind, body}`.
final class ApiResult {
  const ApiResult({
    required this.ok,
    required this.status,
    this.kind,
    this.body,
  });
  final bool ok;
  final int status;

  /// `network` / `bad_response` when no JSON body could be read.
  final String? kind;
  final Map<String, Object?>? body;

  String get message => errorText(status: status, kind: kind, body: body);

  /// `body[key]` as a list of JSON objects (missing/invalid → empty).
  List<Map<String, Object?>> list(String key) {
    final v = body?[key];
    if (v is! List) return const [];
    return [
      for (final e in v)
        if (e is Map<String, Object?>) e,
    ];
  }

  /// `body[key]` as a JSON object, or null.
  Map<String, Object?>? object(String key) {
    final v = body?[key];
    return v is Map<String, Object?> ? v : null;
  }
}

/// Signed-in operator: token kept **in memory only** (never written to disk), like the
/// web panel; the role comes from the token for display, the server re-checks it.
final class OwnerSession {
  const OwnerSession(this.token, this.claims);
  final String token;
  final OwnerClaims claims;
  OwnerRole get role => claims.role;
  OwnerCaps get caps => OwnerCaps.of(claims.role);
}

/// Outcome of the password + TOTP login.
final class LoginOutcome {
  const LoginOutcome.ok(this.session) : error = null;
  const LoginOutcome.failed(this.error) : session = null;
  final OwnerSession? session;
  final String? error;
  bool get ok => session != null;
}

/// Client of `/api/platform/v1` on the configured origin (Gateway or owner-panel server).
class OwnerApi {
  OwnerApi({
    required this.origin,
    required this.http,
    this.onUnauthorized,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  static const String prefix = '/api/platform/v1';

  final Uri origin;
  final OwnerHttp http;
  final DateTime Function() _now;

  /// Called once when the server answers 401 on an authenticated call (session dropped).
  void Function()? onUnauthorized;

  OwnerSession? _session;
  OwnerSession? get session {
    final s = _session;
    if (s != null && s.claims.expiredAt(_now())) _session = null;
    return _session;
  }

  void signOut() => _session = null;

  /// Tests only: install a token as if it came from `/auth/login` (still decoded and
  /// validated; an invalid token leaves no session).
  void debugSetSession(String token) => restoreSession(token);

  /// برنامهٔ نصب‌شده: توکنی که در انبار امن دستگاه (DPAPI/Keystore) نگه داشته شده بود را
  /// برمی‌گرداند تا مالک بعد از باز کردن دوبارهٔ برنامه دوباره وارد نشود. توکن نامعتبر یا
  /// منقضی ⇒ بدون نشست (false). سرور در هر درخواست دوباره آن را بررسی می‌کند.
  bool restoreSession(String token) {
    final c = OwnerClaims.decode(token, now: _now());
    _session = c == null ? null : OwnerSession(token, c);
    return _session != null;
  }

  Uri _url(String path) => origin.replace(path: '$prefix$path');

  static String seg(Object? v) => Uri.encodeComponent('${v ?? ''}');

  Future<ApiResult> call(String method, String path, [Object? body]) async {
    final s = session;
    final headers = <String, String>{
      'accept': 'application/json',
      'x-request-id': requestId(),
      if (s != null) 'authorization': 'Bearer ${s.token}',
      if (body != null) 'content-type': 'application/json',
    };
    final OwnerHttpResponse res;
    try {
      res = await http.send(
        method,
        _url(path),
        headers,
        body == null ? null : jsonEncode(body),
      );
    } on OwnerNetworkException {
      return const ApiResult(ok: false, status: 0, kind: 'network');
    }
    if (!res.contentType.toLowerCase().startsWith('application/json')) {
      return ApiResult(ok: false, status: res.status, kind: 'bad_response');
    }
    final Object? j;
    try {
      j = jsonDecode(res.body);
    } on FormatException {
      return ApiResult(ok: false, status: res.status, kind: 'bad_response');
    }
    final map = j is Map<String, Object?> ? j : null;
    final ok =
        res.status >= 200 &&
        res.status < 300 &&
        map != null &&
        map['ok'] != false;
    if (res.status == 401 && s != null && path != '/auth/login') {
      _session = null;
      onUnauthorized?.call();
    }
    return ApiResult(
      ok: ok,
      status: res.status,
      kind: map == null ? 'bad_response' : null,
      body: map,
    );
  }

  Future<ApiResult> _get(String path) => call('GET', path);
  Future<ApiResult> _post(String path, Map<String, Object?> body) =>
      call('POST', path, body);

  // ── login (password + TOTP, decision D-45) ─────────────────────────────
  Future<LoginOutcome> login({
    required String loginId,
    required String password,
    required String totp,
  }) async {
    final id = loginId.trim();
    final code = normDigits(totp).trim();
    if (id.isEmpty || password.isEmpty) {
      return const LoginOutcome.failed('شناسه و رمز را وارد کنید.');
    }
    if (!RegExp(r'^[0-9]{6}$').hasMatch(code)) {
      return const LoginOutcome.failed('کد دومرحله‌ای باید ۶ رقم باشد.');
    }
    _session = null;
    final r = await _post('/auth/login', {
      'login_id': id,
      'password': password,
      'totp': code,
    });
    final Object? tok = r.ok ? (r.body?['token']) : null;
    if (tok is String) {
      final c = OwnerClaims.decode(tok, now: _now());
      if (c != null) {
        _session = OwnerSession(tok, c);
        return LoginOutcome.ok(_session);
      }
    }
    if (r.status == 404 || r.status == 501) {
      return LoginOutcome.failed(ownerErrors['login_unavailable']);
    }
    if (r.status == 401) {
      return LoginOutcome.failed(ownerErrors['login_failed']);
    }
    return LoginOutcome.failed(r.ok ? ownerErrors['bad_response'] : r.message);
  }

  // ── reads ──────────────────────────────────────────────────────────────
  Future<ApiResult> dashboard() => _get('/dashboard');
  Future<ApiResult> tenants() => _get('/tenants');
  Future<ApiResult> tenantDeletions() => _get('/tenant-deletions');
  Future<ApiResult> plans() => _get('/plans');
  Future<ApiResult> subscriptions() => _get('/subscriptions');
  Future<ApiResult> limits(String tenantId) =>
      _get('/tenants/${seg(tenantId)}/limits');
  Future<ApiResult> usage(String tenantId) =>
      _get('/tenants/${seg(tenantId)}/usage');
  Future<ApiResult> healthSummary() => _get('/health/summary');
  Future<ApiResult> platformUsers() => _get('/platform-users');
  Future<ApiResult> supportGrants() => _get('/support-grants');
  Future<ApiResult> audit() => _get('/audit');
  Future<ApiResult> infra() => _get('/infra');
  Future<ApiResult> infraChanges() => _get('/infra/changes');

  // ── schools ────────────────────────────────────────────────────────────
  Future<ApiResult> createSchool({
    required String provisionOpId,
    required String slug,
    required String displayName,
    required String managerName,
    required String planCode,
    required String reason,
  }) => _post('/tenants', {
    'provision_op_id': provisionOpId,
    'slug': slug,
    'display_name': displayName,
    'manager_name': managerName,
    'plan_code': planCode,
    'reason': reason,
  });
  Future<ApiResult> suspendTenant(String tenantId, String reason) => _post(
    '/tenants/${seg(tenantId)}/suspend',
    {'reason': reason, 'idempotency_key': requestId()},
  );
  Future<ApiResult> requestDeletion(String tenantId, String reason) => _post(
    '/tenants/${seg(tenantId)}/deletion-request',
    {'reason': reason, 'confirm_tenant_id': tenantId},
  );
  Future<ApiResult> approveDeletion(String requestId, String reason) =>
      _post('/tenant-deletions/${seg(requestId)}/approve', {'reason': reason});
  Future<ApiResult> cancelDeletion(String requestId, String reason) =>
      _post('/tenant-deletions/${seg(requestId)}/cancel', {'reason': reason});
  Future<ApiResult> executeDeletion(String requestId, String reason) =>
      _post('/tenant-deletions/${seg(requestId)}/execute', {'reason': reason});

  // ── plans / subscriptions ──────────────────────────────────────────────
  Future<ApiResult> renew(String subscriptionId, String reason, int days) =>
      _post('/subscriptions/${seg(subscriptionId)}/renew', {
        'reason': reason,
        'extend_days': days,
        'idempotency_key': requestId(),
      });
  Future<ApiResult> createPlan({
    required String code,
    required String name,
    required num storageMb,
    required String reason,
  }) => _post('/plans', {
    'code': code,
    'name': name,
    'storage_mb': storageMb,
    'reason': reason,
  });

  // ── operators / support grants ─────────────────────────────────────────
  Future<ApiResult> createUser(String loginId, String role, String reason) =>
      _post('/platform-users', {
        'login_id': loginId,
        'role': role,
        'reason': reason,
      });
  Future<ApiResult> requestGrant({
    required String tenantId,
    required String scope,
    required String caseRef,
    required String reason,
    required DateTime schoolNotifiedAt,
    required DateTime startsAt,
    required int hours,
  }) => _post('/support-grants', {
    'tenant_id': tenantId,
    'scope': scope,
    'case_ref': caseRef,
    'reason': reason,
    'school_notified_at': schoolNotifiedAt.toUtc().toIso8601String(),
    'starts_at': startsAt.toUtc().toIso8601String(),
    'ends_at': startsAt.add(Duration(hours: hours)).toUtc().toIso8601String(),
    'max_actions': 3,
  });
  Future<ApiResult> approveGrant(String requestRef, String reason) =>
      _post('/support-grants/${seg(requestRef)}/approve', {'reason': reason});
  Future<ApiResult> revokeGrant(String grantId, String reason) =>
      _post('/support-grants/${seg(grantId)}/revoke', {'reason': reason});

  // ── infrastructure (row 123) ───────────────────────────────────────────
  Future<ApiResult> infraAddProvider({
    required String code,
    required String displayName,
    required String kind,
    String credentialRef = '',
    required String reason,
  }) => _post('/infra/providers', {
    'code': code,
    'display_name': displayName,
    'kind': kind,
    'api_mode': 'manual',
    if (credentialRef.isNotEmpty) 'credential_ref': credentialRef,
    'reason': reason,
  });
  Future<ApiResult> infraAddService({
    required String providerId,
    required String name,
    required String kind,
    String region = '',
    required String reason,
  }) => _post('/infra/services', {
    'provider_id': providerId,
    'name': name,
    'kind': kind,
    'region': region.isEmpty ? null : region,
    'reason': reason,
  });
  Future<ApiResult> infraAddEndpoint({
    required String serviceId,
    required String url,
    required String checkKind,
    int? expectedStatus,
    required String reason,
  }) => _post('/infra/endpoints', {
    'service_id': serviceId,
    'url': url,
    'check_kind': checkKind,
    'expected_status': expectedStatus,
    'reason': reason,
  });

  /// [value] null ⇒ «نامعلوم» is recorded (no label); otherwise [label] is `M` or `E`.
  Future<ApiResult> infraRecordMetric({
    required String serviceId,
    required String metric,
    required String unit,
    num? value,
    String label = 'M',
    required String reason,
  }) => _post('/infra/metrics', {
    'service_id': serviceId,
    'metric': metric,
    'unit': unit,
    'source': 'manual',
    'reason': reason,
    'value': value,
    if (value != null) 'label': label,
  });
  Future<ApiResult> infraCheck(String endpointId) =>
      _post('/infra/endpoints/${seg(endpointId)}/check', const {});
  Future<ApiResult> infraRequestChange({
    required String action,
    required String targetId,
    required String reason,
    Map<String, Object?>? payload,
  }) => _post('/infra/changes', {
    'action': action,
    'target_id': targetId,
    'reason': reason,
    'payload': ?payload,
  });
  Future<ApiResult> infraApprove(String changeId, String reason) =>
      _post('/infra/changes/${seg(changeId)}/approve', {'reason': reason});

  void close() => http.close();
}
