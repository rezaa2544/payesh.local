import 'dart:convert';

import 'package:payesh_owner_api/payesh_owner_api.dart';

const ownerSub = '11111111-2222-4333-8444-555555555555';
const owner2Sub = '22222222-2222-4333-8444-555555555555';
const operatorSub = '33333333-2222-4333-8444-555555555555';
const supportSub = '44444444-2222-4333-8444-555555555555';
const tenantA = 'aaaaaaaa-1111-4111-8111-111111111111';
const tenantB = 'bbbbbbbb-1111-4111-8111-111111111111';

String tokenFor(
  String sub,
  String role, {
  Duration ttl = const Duration(hours: 1),
}) {
  final body = base64Url
      .encode(
        utf8.encode(
          jsonEncode({
            'sub': sub,
            'role': role,
            'exp': DateTime.now().add(ttl).millisecondsSinceEpoch,
            'typ': 'platform',
            'v': 1,
          }),
        ),
      )
      .replaceAll('=', '');
  return 'platform.v1.$body.c2lnbmF0dXJl';
}

final class Sent {
  Sent(this.method, this.path, this.headers, this.body);
  final String method;
  final String path;
  final Map<String, String> headers;
  final Map<String, Object?>? body;
}

/// Stateful in-memory stand-in for `/api/platform/v1` (enough of the contract for the
/// widget tests; the REAL server is exercised by payesh_owner_api's real_server_it_test).
final class FakeBackend implements OwnerHttp {
  FakeBackend();

  final List<Sent> sent = [];
  bool closed = false;
  bool expireNext = false;

  /// Next mutation is refused with this server error code (server keeps the last word).
  String? failNext;

  /// login_id → (password, totp, sub, role)
  final accounts = <String, (String, String, String, String)>{
    'owner': ('pw-owner-1', '123456', ownerSub, 'platform_owner'),
    'owner2': ('pw-owner-2', '123456', owner2Sub, 'platform_owner'),
    'operator': ('pw-operator', '123456', operatorSub, 'platform_operator'),
    'support': ('pw-support', '123456', supportSub, 'platform_support'),
  };
  String? _role;
  String? _sub;

  final tenants = <Map<String, Object?>>[
    {
      'tenant_id': tenantA,
      'plan_code': 'basic',
      'status': 'active',
      'ends_at': '2027-01-01T00:00:00Z',
    },
    {
      'tenant_id': tenantB,
      'plan_code': 'basic',
      'status': 'active',
      'ends_at': '2027-02-01T00:00:00Z',
    },
  ];
  final plans = <Map<String, Object?>>[
    {
      'code': 'basic',
      'name': 'پایه',
      'max_users': 50,
      'max_students': 400,
      'storage_mb': 1024,
      'archived_at': null,
    },
  ];
  final subs = <Map<String, Object?>>[
    {
      'id': 'sub-a',
      'tenant_id': tenantA,
      'plan_code': 'basic',
      'status': 'active',
      'starts_at': '2026-01-01T00:00:00Z',
      'ends_at': '2027-01-01T00:00:00Z',
    },
    {
      'id': 'sub-b',
      'tenant_id': tenantB,
      'plan_code': 'basic',
      'status': 'active',
      'starts_at': '2026-02-01T00:00:00Z',
      'ends_at': '2027-02-01T00:00:00Z',
    },
  ];
  final deletions = <Map<String, Object?>>[];
  final users = <Map<String, Object?>>[
    {
      'login_id': 'owner',
      'role': 'platform_owner',
      'status': 'active',
      'created_at': '2026-01-01T00:00:00Z',
    },
    {
      'login_id': 'operator',
      'role': 'platform_operator',
      'status': 'active',
      'created_at': '2026-01-02T00:00:00Z',
    },
  ];
  final grants = <Map<String, Object?>>[];
  final events = <Map<String, Object?>>[];
  final providers = <Map<String, Object?>>[
    {
      'id': 'prov-0001-aaaa',
      'code': 'radcloud',
      'display_name': 'رادکلود',
      'kind': 'host',
      'api_mode': 'manual',
      'credential': 'reference',
      'credential_ref': 'secret:RADCLOUD_API_TOKEN',
      'status': 'active',
    },
  ];
  final services = <Map<String, Object?>>[
    {
      'id': 'svc-0001-aaaa',
      'provider_id': 'prov-0001-aaaa',
      'name': 'gateway-1',
      'kind': 'gateway',
      'region': 'thr',
      'metrics': {
        'capacity_cpu': {'value': 4, 'unit': 'cores', 'label': 'M'},
        'usage_cpu': {'value': null},
      },
    },
  ];
  final endpoints = <Map<String, Object?>>[
    {
      'id': 'ep-0001-aaaa',
      'service_id': 'svc-0001-aaaa',
      'url': 'https://gw.example.ir/readyz',
      'check_kind': 'http',
      'enabled': true,
      'health': {'state': 'unknown', 'latency_ms': null, 'checked_at': null},
    },
  ];
  final changes = <Map<String, Object?>>[];
  var _seq = 0;
  var _n = 0;

  void _audit(
    String action,
    String subjectType,
    String subjectRef,
    String? tenant,
    Object? reason,
  ) {
    _seq++;
    final prev = events.isEmpty ? null : events.first['event_hash'];
    events.insert(0, {
      'sequence_id': _seq,
      'created_at': DateTime.now().toUtc().toIso8601String(),
      'action': action,
      'actor_ref': _sub,
      'subject_type': subjectType,
      'subject_ref': subjectRef,
      'tenant_id': tenant,
      'reason': reason,
      'event_hash': 'h${_seq.toString().padLeft(15, '0')}',
      'previous_hash': prev,
    });
  }

  OwnerHttpResponse _j(int status, Object body) => OwnerHttpResponse(
    status,
    'application/json; charset=utf-8',
    jsonEncode(body),
  );
  OwnerHttpResponse _err(int status, String code) =>
      _j(status, {'error': code});

  bool get _owner => _role == 'platform_owner';

  @override
  Future<OwnerHttpResponse> send(
    String method,
    Uri url,
    Map<String, String> headers,
    String? body,
  ) async {
    final p = url.path.replaceFirst(OwnerApi.prefix, '');
    final b = body == null ? null : jsonDecode(body) as Map<String, Object?>;
    sent.add(Sent(method, p, Map.of(headers), b));
    if (p == '/auth/login') {
      final a = accounts['${b?['login_id']}'];
      if (a == null || a.$1 != b?['password'] || a.$2 != b?['totp']) {
        return _err(401, 'invalid_credentials');
      }
      _sub = a.$3;
      _role = a.$4;
      return _j(200, {'token': tokenFor(a.$3, a.$4)});
    }
    if (expireNext) {
      expireNext = false;
      return _err(401, 'unauthorized');
    }
    if (method == 'POST' && failNext != null) {
      final code = failNext!;
      failNext = null;
      return _err(409, code);
    }
    final reason = b?['reason'];
    if (method == 'POST' &&
        reason is String &&
        reason.trim().length < 10 &&
        !p.endsWith('/check')) {
      return _err(400, 'reason_too_short');
    }
    final seg = p.split('/');
    if (method == 'GET') {
      switch (p) {
        case '/dashboard':
          return _j(200, {
            'dashboard': {
              'subscriptions': subs.length,
              'plans': plans.length,
              'active_users': users.length,
              'open_grants': grants.length,
            },
          });
        case '/tenants':
          return _j(200, {'tenants': tenants});
        case '/tenant-deletions':
          return _owner
              ? _j(200, {'requests': deletions})
              : _err(403, 'forbidden');
        case '/plans':
          return _j(200, {'plans': plans});
        case '/subscriptions':
          return _j(200, {'subscriptions': subs});
        case '/health/summary':
          return _j(200, {
            'configured': true,
            'instance': 'gw-1',
            'content_default': 'deny',
            'security': 'NOT VERIFIED',
          });
        case '/platform-users':
          return _j(200, {'users': users});
        case '/support-grants':
          return _j(200, {'grants': grants});
        case '/audit':
          return _j(200, {'events': events});
        case '/infra':
          return _j(200, {
            'provisioning': {'automated': false},
            'providers': providers,
            'services': services,
            'endpoints': endpoints,
            'open_alerts': [
              {
                'kind': 'endpoint_down',
                'severity': 'critical',
                'endpoint_id': 'ep-0001-aaaa',
                'opened_at': '2026-11-01T00:00:00Z',
              },
            ],
          });
        case '/infra/changes':
          return _j(200, {'changes': changes});
      }
      if (seg.length == 4 && seg[1] == 'tenants' && seg[3] == 'limits') {
        return _j(200, {
          'limits': seg[2] == tenantA
              ? {
                  'max_users': 50,
                  'max_students': 400,
                  'storage_bytes': 1073741824,
                }
              : null,
        });
      }
      if (seg.length == 4 && seg[1] == 'tenants' && seg[3] == 'usage') {
        return _j(200, {
          'usage': seg[2] == tenantA
              ? {
                  'users_count': 12,
                  'students_count': 230,
                  'storage_bytes': 268435456,
                  'last_recalc_at': '2026-11-09T08:00:00Z',
                }
              : null,
        });
      }
      return _err(404, 'not_found');
    }
    // ── mutations ──
    if (p == '/tenants') {
      if (!_owner) return _err(403, 'forbidden');
      final slug = '${b!['slug']}';
      final id =
          'cccccccc-1111-4111-8111-${(++_n).toString().padLeft(12, '0')}';
      tenants.add({
        'tenant_id': id,
        'plan_code': b['plan_code'],
        'status': 'active',
        'ends_at': null,
      });
      _audit('tenant.create', 'tenant', id, id, reason);
      return _j(201, {
        'tenant_id': id,
        'slug': slug,
        'manager': {'activation_code': 'ACT-${slug.toUpperCase()}-9F3K'},
      });
    }
    if (seg.length == 4 && seg[1] == 'tenants' && seg[3] == 'suspend') {
      if (!_owner) return _err(403, 'forbidden');
      tenants.firstWhere((t) => t['tenant_id'] == seg[2])['status'] =
          'suspended';
      _audit('tenant.suspend', 'tenant', seg[2], seg[2], reason);
      return _j(200, {'ok': true});
    }
    if (seg.length == 4 &&
        seg[1] == 'tenants' &&
        seg[3] == 'deletion-request') {
      if (b!['confirm_tenant_id'] != seg[2]) {
        return _err(400, 'confirm_mismatch');
      }
      deletions.add({
        'id': 'del-${++_n}',
        'tenant_id': seg[2],
        'status': 'pending',
        'requested_by': _sub,
        'reason': reason,
        'created_at': DateTime.now().toUtc().toIso8601String(),
      });
      return _j(201, {'ok': true});
    }
    if (seg.length == 4 && seg[1] == 'tenant-deletions') {
      final x = deletions.firstWhere((d) => d['id'] == seg[2]);
      switch (seg[3]) {
        case 'approve':
          if (x['requested_by'] == _sub) return _err(409, 'four_eyes_required');
          x['status'] = 'approved';
          x['approved_at'] = DateTime.now().toUtc().toIso8601String();
          x['not_before'] = DateTime.now()
              .add(const Duration(hours: 24))
              .toUtc()
              .toIso8601String();
        case 'cancel':
          x['status'] = 'canceled';
        case 'execute':
          x['status'] = 'executed';
      }
      return _j(200, {'ok': true});
    }
    if (seg.length == 4 && seg[1] == 'subscriptions' && seg[3] == 'renew') {
      if (_role == 'platform_support') return _err(403, 'forbidden');
      return _j(200, {'ok': true});
    }
    if (p == '/plans') {
      plans.add({
        'code': b!['code'],
        'name': b['name'],
        'max_users': null,
        'max_students': null,
        'storage_mb': b['storage_mb'],
        'archived_at': null,
      });
      return _j(201, {'ok': true});
    }
    if (p == '/platform-users') {
      users.add({
        'login_id': b!['login_id'],
        'role': b['role'],
        'status': 'active',
        'created_at': DateTime.now().toUtc().toIso8601String(),
      });
      return _j(201, {'ok': true});
    }
    if (p == '/support-grants') {
      _audit(
        'grant.request',
        'grant_request',
        'req-${++_n}-0000',
        '${b!['tenant_id']}',
        reason,
      );
      return _j(201, {'ok': true});
    }
    if (p == '/infra/providers') {
      providers.add({
        'id': 'prov-${++_n}',
        'code': b!['code'],
        'display_name': b['display_name'],
        'kind': b['kind'],
        'api_mode': 'manual',
        'credential': 'none',
        'status': 'active',
      });
      return _j(201, {'ok': true});
    }
    if (p == '/infra/changes') {
      changes.add({
        'id': 'chg-${++_n}',
        'action': b!['action'],
        'target_id': b['target_id'],
        'reason': reason,
        'requested_by': _sub,
        'status': 'pending',
        'created_at': DateTime.now().toUtc().toIso8601String(),
      });
      return _j(201, {'ok': true});
    }
    if (seg.length == 5 &&
        seg[1] == 'infra' &&
        seg[2] == 'changes' &&
        seg[4] == 'approve') {
      if (!_owner) return _err(403, 'forbidden');
      final x = changes.firstWhere((c) => c['id'] == seg[3]);
      x['status'] = 'executed';
      x['decided_at'] = DateTime.now().toUtc().toIso8601String();
      providers.firstWhere((pr) => pr['id'] == x['target_id'])['status'] =
          'disabled';
      return _j(200, {'ok': true});
    }
    if (seg.length == 5 && seg[1] == 'infra' && seg[4] == 'check') {
      return _j(200, {
        'check': {'ok': true, 'latency_ms': 42},
      });
    }
    return _err(404, 'not_found');
  }

  @override
  void close() => closed = true;

  List<Sent> posts(String path) => [
    for (final s in sent)
      if (s.method == 'POST' && s.path == path) s,
  ];
}
