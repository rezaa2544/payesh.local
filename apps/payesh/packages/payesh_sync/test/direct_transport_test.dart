// Row 110 (ADR-105, Proposed): the native direct transport — selection (default
// off), provider ↔ transport split, service-key refusal, PostgREST request shape
// over real HTTP, and the offline outbox unchanged over the direct path (sealed
// with e2e1, OCC stale → conservative verdict, replay = duplicate).
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_secure/payesh_secure.dart' as e2e;
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

String _b64(Object o) =>
    base64Url.encode(utf8.encode(jsonEncode(o))).replaceAll('=', '');
String jwt(Map<String, Object?> claims) =>
    '${_b64({'alg': 'HS256', 'typ': 'JWT'})}.${_b64(claims)}.c2ln';

/// In-memory stand-in for payesh_direct.sync_push / sync_pull (row 108 semantics:
/// OCC on base_version, uid idempotency, verdict conflict/reject, seq feed).
final class FakeDirectDb implements DirectProvider {
  final Map<String, ({int version, String? sealed, int seq})> rows = {};
  final Set<String> uids = {};
  final List<Map<String, Object?>> conflicts = [];
  final List<String> calls = [];
  int seq = 0;
  bool down = false;

  @override
  Future<Object?> rpc(String fn, List<Object?> args) async {
    if (down) throw const SyncFailure('network: connection refused');
    calls.add(fn);
    if (fn == 'sync_pull') {
      final since = args[0]! as int;
      final out = [
        for (final e in rows.entries)
          if (e.value.seq > since)
            {
              'collection': e.key.split('#')[0],
              'id': int.parse(e.key.split('#')[1]),
              'version': e.value.version,
              'sealed': e.value.sealed,
              'deleted': e.value.sealed == null,
              'seq': e.value.seq,
            },
      ]..sort((a, b) => (a['seq']! as int).compareTo(b['seq']! as int));
      return {
        'rows': out,
        'more': false,
        'next_seq': out.isEmpty ? since : out.last['seq'],
      };
    }
    if (fn != 'sync_push') throw DirectException('rpc_not_allowed', fn);
    final res = <String, List<Object?>>{
      'applied': [],
      'duplicates': [],
      'conflicts': [],
      'rejected': [],
      'stale': [],
    };
    for (final raw in args[0]! as List<Object?>) {
      final o = (raw! as Map).cast<String, Object?>();
      final uid = '${o['uid']}';
      final k = '${o['collection']}#${o['id']}';
      if (uids.contains(uid)) {
        res['duplicates']!.add({'uid': uid});
        continue;
      }
      if (o['verdict'] == 'conflict') {
        uids.add(uid);
        conflicts.add(o);
        res['conflicts']!.add({'uid': uid, 'conflict_id': conflicts.length});
        continue;
      }
      if (o['verdict'] == 'reject') {
        uids.add(uid);
        res['rejected']!.add({'uid': uid, 'error': o['error']});
        continue;
      }
      final cur = rows[k];
      final curV = cur?.version ?? 0;
      if (o['base_version'] != curV) {
        res['stale']!.add({
          'uid': uid,
          'collection': o['collection'],
          'id': o['id'],
          'server_version': curV,
          'sealed': cur?.sealed,
          'deleted': cur != null && cur.sealed == null,
        });
        continue;
      }
      uids.add(uid);
      rows[k] = (
        version: curV + 1,
        sealed: o['type'] == 'del' ? null : '${o['sealed']}',
        seq: ++seq,
      );
      res['applied']!.add({'uid': uid, 'id': o['id'], 'version': curV + 1});
    }
    return res;
  }
}

Future<({DirectTransport t, e2e.Keyring ring})> device(
  String tenant,
  Uint8List smk,
  DirectProvider p,
) async {
  final dir = <String, e2e.Recipient>{};
  for (final sc in [
    'smk',
    'school:homework',
    'school:attendance',
    'class:1:attendance',
  ]) {
    dir[sc] = await e2e.deriveScopeKey(smk, tenant, sc, 1, 0);
  }
  final ring = e2e.Keyring(tenant);
  await ring.addGrant(e2e.kidOf('smk', 1, 0), smk);
  return (
    t: DirectTransport(
      tenant: tenant,
      provider: p,
      keyring: ring,
      directory: dir,
    ),
    ring: ring,
  );
}

void main() {
  group('selection (default off)', () {
    test('only PAYESH_TRANSPORT=direct turns the direct path on', () {
      expect(selectTransport(const {}).mode, TransportMode.gateway);
      expect(
        selectTransport(const {'PAYESH_TRANSPORT': 'gateway'}).mode,
        TransportMode.gateway,
      );
      expect(
        selectTransport(const {'PAYESH_TRANSPORT': ' Direct '}).mode,
        TransportMode.direct,
      );
      final typo = selectTransport(const {'PAYESH_TRANSPORT': 'drect'});
      expect((typo.mode, typo.valid), (TransportMode.gateway, false));
    });
  });

  group('credentials', () {
    test(
      'service / secret / privileged keys are refused; public keys pass',
      () {
        for (final k in [
          'sb_secret_x',
          jwt({'role': 'service_role'}),
          jwt({'role': 'supabase_admin'}),
          jwt({'role': 'postgres'}),
        ]) {
          expect(
            () => assertClientKey(k),
            throwsA(
              isA<DirectException>().having(
                (e) => e.code,
                'code',
                'service_key_forbidden',
              ),
            ),
          );
        }
        expect(
          () => assertClientKey(jwt({'role': 'authenticated'})),
          throwsA(
            isA<DirectException>().having(
              (e) => e.code,
              'code',
              'client_key_must_be_anon',
            ),
          ),
        );
        expect(() => assertClientKey(''), throwsA(isA<DirectException>()));
        expect(assertClientKey('sb_publishable_ok'), 'publishable');
        expect(assertClientKey(jwt({'role': 'anon'})), 'anon-jwt');
        expect(
          () => assertUserToken(jwt({'role': 'service_role'})),
          throwsA(isA<DirectException>()),
        );
        expect(
          () => assertUserToken('opaque'),
          throwsA(isA<DirectException>()),
        );
      },
    );

    test(
      'provider url: https only (http on loopback), no credentials or query',
      () {
        for (final u in [
          'http://p.example.co',
          'https://u:p@p.example.co',
          'https://p.example.co/?k=1',
        ]) {
          expect(
            () => checkProviderUrl(Uri.parse(u)),
            throwsA(isA<DirectException>()),
          );
        }
        expect(checkProviderUrl(Uri.parse('http://127.0.0.1:8080')).port, 8080);
      },
    );
  });

  group('PostgrestProvider over real HTTP', () {
    late HttpServer server;
    final seen = <(String, Map<String, String>, Object?)>[];
    var answer = (200, '{"ok":true}');
    setUp(() async {
      seen.clear();
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) async {
        final body = await utf8.decoder.bind(req).join();
        seen.add((
          req.uri.path,
          {
            'apikey': req.headers.value('apikey') ?? '',
            'authorization': req.headers.value('authorization') ?? '',
            'content-profile': req.headers.value('content-profile') ?? '',
          },
          body.isEmpty ? null : jsonDecode(body),
        ));
        req.response.statusCode = answer.$1;
        req.response.headers.contentType = ContentType.json;
        req.response.write(answer.$2);
        await req.response.close();
      });
    });
    tearDown(() => server.close(force: true));

    PostgrestProvider pr() => PostgrestProvider(
      url: Uri.parse('http://127.0.0.1:${server.port}'),
      clientKey: 'sb_publishable_t',
      token: () => jwt({'sub': 's', 'device_id': 'd', 'role': 'authenticated'}),
    );

    test(
      'POST /rest/v1/rpc/<fn> with named parameters, public key + user JWT',
      () async {
        answer = (200, '{"ok":true}');
        final p = pr();
        expect(await p.rpc('sync_pull', [5, '50']), {'ok': true});
        expect(seen.single.$1, '/rest/v1/rpc/sync_pull');
        expect(seen.single.$2['apikey'], 'sb_publishable_t');
        expect(seen.single.$2['authorization'], startsWith('Bearer eyJ'));
        expect(seen.single.$2['content-profile'], 'payesh_direct');
        expect(seen.single.$3, {'p_since': 5, 'p_limit': '50'});
        await expectLater(
          p.rpc('bootstrap_school', const []),
          throwsA(isA<DirectException>()),
        );
        expect(seen, hasLength(1));
        p.close();
      },
    );

    test('errors: 401 → unauthorized, 42501 → forbidden, 54000 → plan_limit, 503 → retryable', () async {
      final p = pr();
      answer = (401, '{"message":"JWT expired"}');
      await expectLater(
        p.rpc('my_plan', const []),
        throwsA(
          isA<SyncFailure>().having(
            (e) => e.code,
            'code',
            PayeshErrorCode.unauthorized,
          ),
        ),
      );
      answer = (403, '{"code":"42501","message":"permission denied"}');
      await expectLater(
        p.rpc('my_plan', const []),
        throwsA(
          isA<DirectException>().having((e) => e.sqlstate, 'sqlstate', '42501'),
        ),
      );
      answer = (400, '{"code":"54000","message":"plan_rate_exceeded"}');
      await expectLater(
        p.rpc('my_plan', const []),
        throwsA(
          isA<DirectException>().having((e) => e.code, 'code', 'plan_limit'),
        ),
      );
      answer = (503, '{"message":"paused"}');
      await expectLater(
        p.rpc('my_plan', const []),
        throwsA(isA<SyncFailure>().having((e) => e.status, 'status', 503)),
      );
      p.close();
    });
  });

  group('DirectTransport + SqliteOutbox (offline unchanged)', () {
    const tenant = '7d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
    final smk = Uint8List.fromList(
      List<int>.generate(32, (_) => Random.secure().nextInt(256)),
    );

    test('outage keeps every op, reconnect drains, replay is a duplicate, the other device pulls plaintext', () async {
      final db = FakeDirectDb();
      final d1 = await device(tenant, smk, db);
      final d2 = await device(tenant, smk, db);
      final clock = FakeClock();
      final ob = SqliteOutbox.inMemory(clock: clock);
      ob.enqueue({
        'collection': 'homework',
        'type': 'put',
        'id': 3,
        'data': {'title': 'ریاضی'},
      });
      ob.enqueue({
        'collection': 'attendance',
        'type': 'put',
        'id': 1,
        'data': {'class_id': 1, 'student_id': 10, 'status': 'present'},
      });
      ob.enqueue({
        'collection': 'homework',
        'type': 'put',
        'localId': -1,
        'data': {'title': 'no id'},
      });
      db.down = true;
      final off = await ob.drain(d1.t.push);
      expect(
        (off.stopped, off.failed, ob.stats().active, db.calls.length),
        ('network', 3, 3, 0),
      );
      db.down = false;
      clock.advance(const Duration(minutes: 10));
      final rejected = <String>[];
      final on = await ob.drain(
        d1.t.push,
        onRejected: (op, v) => rejected.add('${v['error']}'),
      );
      expect((on.applied, on.rejected, ob.stats().active), (2, 1, 0));
      expect(rejected, ['direct_id_required']);
      for (final r in db.rows.values) {
        expect(r.sealed, startsWith('e2e1.'));
        expect(r.sealed, isNot(contains('present')));
      }
      ob.enqueue({
        'k': 'u-replay',
        'collection': 'homework',
        'type': 'put',
        'id': 4,
        'data': {'title': 'r'},
      });
      await ob.drain(d1.t.push);
      ob.enqueue({
        'k': 'u-replay',
        'collection': 'homework',
        'type': 'put',
        'id': 4,
        'data': {'title': 'r'},
      });
      Map<String, Object?>? dup;
      await ob.drain(d1.t.push, onApplied: (op, v) => dup = v);
      expect(dup?['duplicate'], isTrue);
      final eng = SqliteEngine.inMemory();
      final pulled = await d2.t.pull(eng);
      expect(pulled.rows, 3);
      expect((await eng.get('homework', 3))?.data['title'], 'ریاضی');
      expect((await eng.get('attendance', 1))?.data['status'], 'present');
      expect(
        eng.database
            .select("SELECT value FROM meta WHERE key = 'direct.since_seq'")
            .first['value'],
        '${db.seq}',
      );
    });

    test('stale put → conflict with the local copy sealed (never overwrites); stale delete deletes the current version', () async {
      final db = FakeDirectDb();
      final d1 = await device(tenant, smk, db);
      final d2 = await device(tenant, smk, db);
      final a = SqliteOutbox.inMemory();
      final b = SqliteOutbox.inMemory();
      a.enqueue({
        'collection': 'homework',
        'type': 'put',
        'id': 9,
        'data': {'title': 'v1'},
      });
      await a.drain(d1.t.push);
      await d1.t.pull(SqliteEngine.inMemory());
      await d2.t.pull(SqliteEngine.inMemory());
      b.enqueue({
        'collection': 'homework',
        'type': 'put',
        'id': 9,
        'base_version': 1,
        'data': {'title': 'from d2'},
      });
      expect((await b.drain(d2.t.push)).applied, 1);
      a.enqueue({
        'collection': 'homework',
        'type': 'put',
        'id': 9,
        'base_version': 1,
        'data': {'title': 'from d1'},
      });
      final r = await a.drain(d1.t.push);
      expect((r.applied, r.conflicts, d1.t.staleRounds), (0, 1, 1));
      expect(db.rows['homework#9']!.version, 2);
      final local = db.conflicts.single;
      expect('${local['sealed']}', startsWith('e2e1.'));
      final opened = await e2e.open(
        '${local['sealed']}',
        await d1.ring.forEnvelope('${local['sealed']}'),
        'payesh/e2e1/conflict|$tenant|homework|9|${local['uid']}',
      );
      expect(jsonDecode(utf8.decode(opened)), {'title': 'from d1'});
      a.enqueue({'collection': 'homework', 'type': 'del', 'id': 9});
      expect((await a.drain(d1.t.push)).applied, 1);
      expect(db.rows['homework#9']!.sealed, isNull);
    });
  });
}
