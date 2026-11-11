// Row 110 (ADR-105, Proposed): the direct transport of the native client, behind
// PAYESH_TRANSPORT=direct (default OFF — the Gateway stays the data path).
//
// Two layers, same split as the JS client (client/transport.js ↔
// client/provider-postgrest.js):
//   * provider  — [DirectProvider.rpc]: how a call reaches the managed database.
//                 [PostgrestProvider] = PostgREST/Supabase `POST /rest/v1/rpc/<fn>`
//                 with the PUBLIC client key + the user's own JWT. Service keys
//                 are refused.
//   * transport — [DirectTransport]: the sync protocol of row 108 (sync_push with
//                 OCC + uid idempotency, sync_pull change feed), e2e1 sealing
//                 (row 107) and the device-side verdict on stale ops. It plugs
//                 into [SqliteOutbox.drain] exactly like [GatewayTransport.push].
//
// Device-side verdicts: the field-level merge rules of server/convergence.js are
// not ported to Dart yet, so [DirectTransport] takes the conservative verdict on
// every stale put — `conflict` (both versions kept for the manager); a stale
// delete deletes the current version (outbox deletes carry no base). A put never
// overwrites a newer server version. The JS reference (tools/direct-sync.js)
// merges auto fields; the difference is documented in docs/cloud/110.
import 'dart:convert';
import 'dart:io';

import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_secure/payesh_secure.dart' as e2e;

import 'outbox.dart';
import 'pinning.dart';
import 'sync_client.dart' show PullResult, SyncProtocolException;

/// Which cloud path the app uses.
enum TransportMode { gateway, direct }

/// Result of reading `PAYESH_TRANSPORT`.
final class TransportSelection {
  const TransportSelection(this.mode, {this.requested, this.valid = true});
  final TransportMode mode;
  final String? requested;
  final bool valid;
}

/// `PAYESH_TRANSPORT` from [env] (or the build define / process environment):
/// only `direct` enables the direct path; unset, `gateway` or a typo keep the
/// Gateway (a typo is reported through [TransportSelection.valid]).
TransportSelection selectTransport([Map<String, String>? env]) {
  const define = String.fromEnvironment('PAYESH_TRANSPORT');
  final raw =
      env?['PAYESH_TRANSPORT'] ??
      (define.isNotEmpty ? define : Platform.environment['PAYESH_TRANSPORT']);
  final v = (raw ?? '').trim().toLowerCase();
  if (v.isEmpty) return const TransportSelection(TransportMode.gateway);
  if (v == 'gateway') {
    return TransportSelection(TransportMode.gateway, requested: raw);
  }
  if (v == 'direct') {
    return TransportSelection(TransportMode.direct, requested: raw);
  }
  return TransportSelection(
    TransportMode.gateway,
    requested: raw,
    valid: false,
  );
}

/// A refusal of the direct path (credential, protocol or database).
final class DirectException implements Exception {
  const DirectException(this.code, this.message, {this.status, this.sqlstate});

  /// `service_key_forbidden`, `client_key_required`, `client_key_must_be_anon`,
  /// `bad_url`, `rpc_not_allowed`, `auth`, `forbidden`, `plan_limit`, `db`, `protocol`.
  final String code;
  final String message;
  final int? status;
  final String? sqlstate;
  @override
  String toString() =>
      'DirectException($code${sqlstate == null ? '' : ' $sqlstate'}): $message';
}

/// The provider layer: one call into the managed database.
abstract interface class DirectProvider {
  /// Calls `payesh_direct.<fn>(args…)` and returns its jsonb result.
  Future<Object?> rpc(String fn, List<Object?> args);
}

/// fn → ordered parameter names (db/migrations/direct). Nothing else is callable.
const Map<String, List<String>> rpcParams = {
  'sync_push': ['p_ops', 'p_idem'],
  'sync_pull': ['p_since', 'p_limit', 'p_collections'],
  'sync_resolve_conflict': ['p_id', 'p_decision'],
  'my_plan': [],
  'register_device_key': ['p_public_key'],
  'publish_scope_key': ['p_scope', 'p_smk_gen', 'p_gen', 'p_public_key'],
  'put_key_grant': ['p_device', 'p_scope', 'p_smk_gen', 'p_gen', 'p_sealed'],
  'current_user_id': [],
  'current_tenant_id': [],
};

// key-guard-110-begin (the only privileged names in client code)
const List<String> _privilegedRoles = [
  'service_role',
  'supabase_admin',
  'postgres',
  'supabase_auth_admin',
];
const List<String> _secretPrefixes = ['sb_secret_'];
// key-guard-110-end

Map<String, Object?>? _jwtClaims(String token) {
  final p = token.split('.');
  if (p.length != 3 || !p[0].startsWith('eyJ')) return null;
  try {
    final j = jsonDecode(
      utf8.decode(base64Url.decode(base64Url.normalize(p[1]))),
    );
    return j is Map ? j.cast<String, Object?>() : null;
  } on FormatException {
    return null;
  }
}

/// Refuses anything but a public client key (publishable / anon).
String assertClientKey(String key) {
  final k = key.trim();
  if (k.isEmpty) {
    throw const DirectException('client_key_required', 'client key required');
  }
  if (_secretPrefixes.any(k.startsWith)) {
    throw const DirectException(
      'service_key_forbidden',
      'secret key in a client',
    );
  }
  final c = _jwtClaims(k);
  if (c != null) {
    final role = '${c['role'] ?? ''}';
    if (_privilegedRoles.contains(role)) {
      throw const DirectException(
        'service_key_forbidden',
        'privileged JWT in a client',
      );
    }
    if (role != 'anon') {
      throw DirectException('client_key_must_be_anon', 'client key role $role');
    }
    return 'anon-jwt';
  }
  return k.startsWith('sb_publishable_') ? 'publishable' : 'opaque';
}

/// The user token must be a JWT of a non-privileged role.
void assertUserToken(String token) {
  final c = _jwtClaims(token);
  if (c == null) throw const DirectException('auth', 'user token is not a JWT');
  if (_privilegedRoles.contains('${c['role'] ?? ''}')) {
    throw const DirectException('service_key_forbidden', 'privileged token');
  }
}

/// https only (http on loopback for tests); no credentials, query or fragment.
Uri checkProviderUrl(Uri u) {
  final local =
      u.host == 'localhost' || u.host == '127.0.0.1' || u.host == '::1';
  if (!(u.scheme == 'https' || (local && u.scheme == 'http'))) {
    throw const DirectException('bad_url', 'provider url must be https');
  }
  if (u.userInfo.isNotEmpty || u.hasQuery || u.hasFragment) {
    throw const DirectException(
      'bad_url',
      'no credentials/query in the provider url',
    );
  }
  return u;
}

/// PostgREST / Supabase provider (`POST {url}/rest/v1/rpc/<fn>`, named parameters).
final class PostgrestProvider implements DirectProvider {
  PostgrestProvider({
    required Uri url,
    required String clientKey,
    required this._token,
    HttpClient? client,
    this.schema = 'payesh_direct',
    this.timeout = const Duration(seconds: 30),
  }) : base = checkProviderUrl(url),
       _key = clientKey.trim(),
       _client = client ?? HttpClient() {
    assertClientKey(clientKey);
  }

  /// Production constructor: the provider endpoint pinned exactly like the Gateway
  /// (owner decision: pinning ON, primary + backup SPKI pin), see [createPinnedHttpClient].
  factory PostgrestProvider.pinned(
    GatewayConfig endpoint, {
    required String clientKey,
    required String Function() token,
    SecurityContext? context,
  }) => PostgrestProvider(
    url: endpoint.baseUri,
    clientKey: clientKey,
    token: token,
    client: createPinnedHttpClient(endpoint, context: context),
  );

  final Uri base;
  final String schema;
  final Duration timeout;
  final String _key;
  final String Function() _token;
  final HttpClient _client;
  int calls = 0;

  @override
  Future<Object?> rpc(String fn, List<Object?> args) async {
    final names = rpcParams[fn];
    if (names == null) throw DirectException('rpc_not_allowed', fn);
    if (args.length > names.length) {
      throw DirectException('protocol', '$fn: too many arguments');
    }
    final tok = _token();
    assertUserToken(tok);
    final body = <String, Object?>{
      for (var i = 0; i < args.length; i++) names[i]: args[i],
    };
    final path = '${base.path.replaceAll(RegExp(r'/+$'), '')}/rest/v1/rpc/$fn';
    calls++;
    HttpClientResponse res;
    String text;
    try {
      final req = await _client
          .postUrl(base.replace(path: path))
          .timeout(timeout);
      req.headers
        ..set('apikey', _key)
        ..set(HttpHeaders.authorizationHeader, 'Bearer $tok')
        ..set(HttpHeaders.contentTypeHeader, 'application/json')
        ..set(HttpHeaders.acceptHeader, 'application/json')
        ..set('content-profile', schema)
        ..set('accept-profile', schema);
      req.add(utf8.encode(jsonEncode(body)));
      res = await req.close().timeout(timeout);
      text = await res.transform(utf8.decoder).join().timeout(timeout);
    } on DirectException {
      rethrow;
    } catch (e) {
      // Network: the outbox keeps the batch and backs off (same as the Gateway).
      throw SyncFailure('network: $e');
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return text.isEmpty ? null : jsonDecode(text);
    }
    Map<String, Object?> j = const {};
    try {
      final d = jsonDecode(text);
      if (d is Map) j = d.cast<String, Object?>();
    } on FormatException {
      // not json
    }
    final code =
        j['code'] is String && RegExp(r'^[0-9A-Z]{5}$').hasMatch('${j['code']}')
        ? '${j['code']}'
        : null;
    final msg = '${j['message'] ?? 'http ${res.statusCode}'}';
    final st = res.statusCode;
    if (st == 401) {
      throw SyncFailure(msg, code: PayeshErrorCode.unauthorized, status: st);
    }
    if (st == 429 || (st >= 500 && code != '54000')) {
      throw SyncFailure(msg, status: st);
    }
    if (code == '54000') {
      throw DirectException('plan_limit', msg, status: st, sqlstate: code);
    }
    if (st == 403 || code == '42501') {
      throw DirectException('forbidden', msg, status: st, sqlstate: code);
    }
    throw DirectException('db', msg, status: st, sqlstate: code);
  }

  void close() => _client.close(force: true);
}

int? _num(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}');

/// The direct sync protocol over a [DirectProvider] (row 108 semantics).
final class DirectTransport {
  DirectTransport({
    required this.tenant,
    required this.provider,
    required this.keyring,
    required this.directory,
    this.maxRounds = 6,
  });

  static const String cursorKey = 'direct.since_seq';
  final String tenant;
  final DirectProvider provider;
  final e2e.Keyring keyring;

  /// scope → newest published public key.
  final Map<String, e2e.Recipient> directory;
  final int maxRounds;

  /// Last server-confirmed document per `collection#id` (from pull).
  final Map<String, ({Map<String, Object?> doc, int version})> shadow = {};
  int staleRounds = 0;

  static String _k(String c, int id) => '$c#$id';

  Future<String> _seal(
    String collection,
    int id,
    int version,
    Map<String, Object?> doc,
  ) => e2e.sealRecord(
    e2e.RecordMeta(
      tenantId: tenant,
      collection: collection,
      recordId: id,
      version: version,
      classId: _num(doc['class_id']),
      studentId: _num(doc['student_id']),
    ),
    jsonEncode(doc),
    directory,
  );

  String _conflictAad(String collection, int id, String uid) =>
      'payesh/e2e1/conflict|$tenant|$collection|$id|$uid';

  Future<Map<String, Object?>> _wireOp(Map<String, Object?> o) async {
    final id = _num(o['id'])!;
    final c = '${o['collection']}';
    final base = _num(o['base_version']) ?? 0;
    final w = <String, Object?>{
      'uid': o['uid'],
      'collection': c,
      'id': id,
      'type': o['type'] == 'del' ? 'del' : 'put',
      'base_version': base,
    };
    if (w['type'] == 'del') return w;
    final sh = shadow[_k(c, id)];
    final doc = <String, Object?>{
      if (sh != null && sh.version == base) ...sh.doc,
      ...((o['data'] as Map?)?.cast<String, Object?>() ?? const {}),
      'id': id,
    };
    w['sealed'] = await _seal(c, id, base + 1, doc);
    w['class_id'] = _num(doc['class_id']);
    w['student_id'] = _num(doc['student_id']);
    return w;
  }

  /// Conservative device verdict on a stale op: never overwrite a newer version.
  Future<Map<String, Object?>> _verdict(
    Map<String, Object?> o,
    Map<String, Object?> st,
  ) async {
    final id = _num(o['id'])!;
    final c = '${o['collection']}';
    final uid = '${o['uid']}';
    final base = _num(o['base_version']) ?? 0;
    final w = <String, Object?>{
      'uid': uid,
      'collection': c,
      'id': id,
      'type': o['type'] == 'del' ? 'del' : 'put',
      'base_version': base,
    };
    final gone = st['deleted'] == true || st['sealed'] == null;
    if (w['type'] == 'del') {
      // Outbox deletes carry no base (Sync v1 wire): delete the current version,
      // like sync.js / the JS reference do for a plain delete.
      return gone
          ? {...w, 'verdict': 'reject', 'error': 'not_found'}
          : {...w, 'base_version': _num(st['server_version']) ?? base};
    }
    if (gone && base == 0) {
      return {...w, 'verdict': 'reject', 'error': 'write_failed'};
    }
    final patch = (o['data'] as Map?)?.cast<String, Object?>() ?? const {};
    final recipients = [
      for (final s in e2e.recordScopes(
        e2e.RecordMeta(
          tenantId: tenant,
          collection: c,
          recordId: id,
          version: 1,
          classId: _num(patch['class_id']),
          studentId: _num(patch['student_id']),
        ),
      ))
        ?directory[s],
    ];
    final sealed = await e2e.seal(
      recipients,
      utf8.encode(jsonEncode(patch)),
      _conflictAad(c, id, uid),
    );
    return {
      ...w,
      'verdict': 'conflict',
      'sealed': sealed,
      'class_id': _num(patch['class_id']),
      'student_id': _num(patch['student_id']),
    };
  }

  /// [PushSender] for [SqliteOutbox.drain]: outbox wire ops → Sync v1 verdicts.
  Future<PushVerdicts> push(List<Map<String, Object?>> ops) async {
    final early = <Map<String, Object?>>[];
    final byUid = <String, Map<String, Object?>>{};
    var wire = <Map<String, Object?>>[];
    for (final o in ops) {
      final id = _num(o['id']);
      if (id == null || id <= 0) {
        early.add({'uid': o['uid'], 'error': 'direct_id_required'});
        continue;
      }
      byUid['${o['uid']}'] = o;
      wire.add(await _wireOp(o));
    }
    Map<String, Object?> resp = const {};
    if (wire.isNotEmpty) {
      for (var round = 0; round < maxRounds; round++) {
        final r = await provider.rpc('sync_push', [wire, null]);
        if (r is! Map) {
          throw const SyncProtocolException('sync_push: not an object');
        }
        resp = r.cast<String, Object?>();
        final stale = (resp['stale'] as List<Object?>?) ?? const [];
        if (resp['replayed'] == true || stale.isEmpty) break;
        staleRounds++;
        wire = [
          for (final s in stale)
            if (s is Map)
              await _verdict(byUid['${s['uid']}']!, s.cast<String, Object?>()),
        ];
        if (round == maxRounds - 1) {
          throw SyncProtocolException('still stale after $maxRounds rounds');
        }
      }
    }
    List<Object?> l(String k) => (resp[k] as List<Object?>?) ?? const [];
    return PushVerdicts.fromJson({
      'applied': [
        ...l('applied'),
        for (final d in l('duplicates'))
          if (d is Map) {...d.cast<String, Object?>(), 'duplicate': true},
      ],
      'conflicts': l('conflicts'),
      'rejected': [...early, ...l('rejected')],
    });
  }

  int _cursor(SqliteEngine engine) {
    final rs = engine.database.select('SELECT value FROM meta WHERE key = ?', [
      cursorKey,
    ]);
    return rs.isEmpty ? 0 : int.tryParse('${rs.first['value']}') ?? 0;
  }

  /// Applies the change feed (decrypted) to [engine]; cursor `direct.since_seq`.
  Future<PullResult> pull(
    SqliteEngine engine, {
    int pageSize = 50,
    int maxPages = 10000,
  }) async {
    final res = PullResult();
    var since = _cursor(engine);
    for (;;) {
      if (res.pages >= maxPages) {
        throw SyncProtocolException('direct pull exceeded $maxPages pages');
      }
      final r = await provider.rpc('sync_pull', [since, '$pageSize']);
      if (r is! Map) {
        throw const SyncProtocolException('sync_pull: not an object');
      }
      res.pages++;
      final puts = <RowInput>[];
      for (final row in (r['rows'] as List<Object?>?) ?? const []) {
        if (row is! Map) continue;
        final c = '${row['collection']}';
        final id = _num(row['id']) ?? 0;
        if (row['deleted'] == true) {
          shadow.remove(_k(c, id));
          await engine.del(c, id);
          res.deleted++;
          continue;
        }
        final v = _num(row['version']) ?? 1;
        final text = await keyring.openRecordText(
          e2e.RecordMeta(
            tenantId: tenant,
            collection: c,
            recordId: id,
            version: v,
          ),
          '${row['sealed']}',
        );
        final doc = (jsonDecode(text) as Map).cast<String, Object?>();
        shadow[_k(c, id)] = (doc: doc, version: v);
        puts.add(
          RowInput(collection: c, id: id, data: {...doc, 'id': id}, version: v),
        );
      }
      await engine.putMany(puts);
      res.rows += puts.length;
      final next = _num(r['next_seq']) ?? since;
      if (next < since) {
        throw const SyncProtocolException('direct cursor moved backwards');
      }
      if (r['more'] == true && next == since) {
        throw const SyncProtocolException('more=true without cursor progress');
      }
      since = next;
      engine.database.execute(
        'INSERT INTO meta (key, value) VALUES (?, ?) '
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [cursorKey, '$since'],
      );
      if (r['more'] != true) break;
    }
    res.sinceId = since;
    return res;
  }
}
