// Row 74, wave 1 — the native school login against the REAL Directory + Gateway
// (server/gateway.js) on a real PostgreSQL. Not a mock. Runs when PAYESH_GW_IT=1
// (+ PAYESH_PG_ADMIN / PAYESH_PG_RUNTIME); CI job `gateway-real` in native-client.yml.
@Tags(['server'])
library;

import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

final env = Platform.environment;
final bool enabled = env['PAYESH_GW_IT'] == '1';
final String node = env['PAYESH_NODE'] ?? 'node';
final String repoRoot =
    env['PAYESH_REPO_ROOT'] ?? Directory('../../../..').absolute.path;

Future<int> freePort() async {
  final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final p = s.port;
  await s.close();
  return p;
}

final class Gw {
  Gw(this.port, this.environment);
  final int port;
  final Map<String, String> environment;
  final log = StringBuffer();
  Process? _p;
  Uri get uri => Uri.parse('http://127.0.0.1:$port');

  Future<void> start() async {
    _p = await Process.start(
      node,
      ['server/gateway.js'],
      workingDirectory: repoRoot,
      environment: {...environment, 'PORT': '$port'},
    );
    _p!.stdout.transform(utf8.decoder).listen(log.write);
    _p!.stderr.transform(utf8.decoder).listen(log.write);
    final c = HttpClient();
    var ready = false;
    for (var i = 0; i < 150 && !ready; i++) {
      try {
        final r = await (await c.getUrl(uri.resolve('/readyz'))).close();
        await r.drain<void>();
        ready = r.statusCode == 200;
      } on SocketException {
        // not up yet
      }
      if (!ready) await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    c.close(force: true);
    if (!ready) throw StateError('gateway /readyz never 200:\n$log');
  }

  Future<void> kill() async {
    _p?.kill(ProcessSignal.sigkill);
    await _p?.exitCode;
  }
}

Future<Map<String, Object?>> harness(
  List<String> args,
  Map<String, String> extra,
) async {
  final h = await Process.run(
    node,
    ['test/support/school_access_harness.cjs', ...args],
    environment: {
      'PAYESH_REPO_ROOT': repoRoot,
      'PGURL_ADMIN': env['PAYESH_PG_ADMIN'] ?? '',
      ...extra,
    },
  );
  if (h.exitCode != 0) throw StateError('harness: ${h.stderr}');
  return (jsonDecode('${h.stdout}') as Map).cast<String, Object?>();
}

Matcher fails(SchoolAccessError k) =>
    throwsA(isA<SchoolAccessFailure>().having((e) => e.kind, 'kind', k));

void main() {
  late Gw gw; // Directory + school access on the same Gateway
  late Gw bare; // Gateway WITHOUT a Directory (single-cell install)
  late Map<String, Object?> h;
  late SchoolAccessClient client;
  var negatives = 0;
  var passed = 0;
  final device = SchoolAccessRules.newDeviceId(Random(74));

  setUpAll(() async {
    if (!enabled) return;
    final rnd = Random.secure();
    final secret = List.generate(
      32,
      (_) => rnd.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    final port = await freePort();
    h = await harness(['setup'], {'GW_URL': 'http://127.0.0.1:$port'});
    final base = {
      'HOST': '127.0.0.1',
      'PGURL': env['PAYESH_PG_RUNTIME']!,
      'GW_SECRET': secret,
      'GW_QUOTA_MAX': '100000',
      'PAYESH_LOG': '0',
    };
    gw = Gw(port, {
      ...base,
      'GW_INSTANCE': 'gw-74',
      'PAYESH_DIRECTORY_PGURL': env['PAYESH_PG_ADMIN']!,
    });
    bare = Gw(await freePort(), {...base, 'GW_INSTANCE': 'gw-74-bare'});
    await gw.start();
    await bare.start();
    client = SchoolAccessClient(directory: gw.uri, deviceId: device);
  });

  tearDownAll(() async {
    if (!enabled) return;
    client.close();
    // ignore: avoid_print
    print('NATIVE-WAVE1-IT passed=$passed negative_controls=$negatives');
    await gw.kill();
    await bare.kill();
  });

  final skip = enabled
      ? false
      : 'set PAYESH_GW_IT=1 (+ PAYESH_PG_ADMIN/RUNTIME) for the real Gateway';

  test('W1-IT-01 resolve: real Directory → this Gateway; unknown/malformed → same 404', () async {
    final r = await client.resolve('${h['slug']}'.toUpperCase());
    expect(r.schoolCode, h['slug']);
    expect(r.cellUrl, gw.uri);
    expect(r.migrating, isFalse);
    await expectLater(
      client.resolve('no-such-school'),
      fails(SchoolAccessError.schoolNotFound),
    );
    negatives++;
    final m = await client.resolve('${h['moving']}');
    expect(m.migrating, isTrue);
    await expectLater(
      client.resolve('${h['offline']}'),
      fails(SchoolAccessError.unavailable),
    );
    negatives++;
    passed++;
  }, skip: skip);

  test('W1-IT-02 activate: wrong school and wrong code get the SAME 401; right code → session', () async {
    final code = '${h['code']}';
    final wrongCode = 'A' * 32 == code ? 'B' * 32 : 'A' * 32;
    SchoolAccessFailure? a;
    SchoolAccessFailure? b;
    try {
      await client.activate(
        cell: gw.uri,
        school: 'no-such-school',
        code: code,
        deviceId: device,
      );
    } on SchoolAccessFailure catch (e) {
      a = e;
    }
    try {
      await client.activate(
        cell: gw.uri,
        school: '${h['slug']}',
        code: wrongCode,
        deviceId: device,
      );
    } on SchoolAccessFailure catch (e) {
      b = e;
    }
    expect(
      [a?.kind, a?.status, a?.wire],
      [SchoolAccessError.activationRejected, 401, 'activation_failed'],
    );
    expect([b?.kind, b?.status, b?.wire], [a?.kind, a?.status, a?.wire]);
    negatives += 2;
    // typed the way a person reads it: lower case, grouped with dashes
    final grouped = RegExp('.{1,4}')
        .allMatches(code.toLowerCase())
        .map((m) => m[0])
        .join('-');
    final act = await client.activate(
      cell: gw.uri,
      school: '${h['slug']}',
      code: grouped,
      deviceId: device,
    );
    expect(act.session.role, 'manager');
    expect(act.session.uid, 1);
    expect(act.session.tenantId, h['tenant']);
    expect(act.session.expiredAt(DateTime.now()), isFalse);
    expect(SchoolAccessRules.code.hasMatch(act.deviceSecret), isTrue);
    h['secret1'] = act.deviceSecret;
    h['token1'] = act.session.token;
    // one-time: the same code again → rejected
    await expectLater(
      client.activate(
        cell: gw.uri,
        school: '${h['slug']}',
        code: code,
        deviceId: device,
      ),
      fails(SchoolAccessError.activationRejected),
    );
    negatives++;
    passed++;
  }, skip: skip);

  test('W1-IT-03 the school token opens the Gateway data path (pull 200); garbage token 401', () async {
    Future<int> pull(String token) async {
      final c = HttpClient();
      try {
        final q = await c.getUrl(
          gw.uri.resolve('/api/gw/v1/pull?limit=10&since_seq=0'),
        );
        q.headers
          ..set(HttpHeaders.authorizationHeader, 'Bearer $token')
          ..set('X-Device-Id', device);
        final r = await q.close();
        await r.drain<void>();
        return r.statusCode;
      } finally {
        c.close(force: true);
      }
    }

    expect(await pull('${h['token1']}'), 200);
    expect(await pull('not.a.token'), 401);
    negatives++;
    passed++;
  }, skip: skip);

  test('W1-IT-04 restart: saved device secret → refresh; wrong secret → deviceRevoked', () async {
    final store = SchoolAccountStore(FakeSecureStore());
    await store.save(
      SavedSchool(
        school: '${h['slug']}',
        cellUrl: gw.uri,
        deviceSecret: '${h['secret1']}',
      ),
    );
    final saved = (await store.load())!;
    final fresh = SchoolAccessClient(directory: gw.uri, deviceId: device);
    addTearDown(fresh.close);
    final s = await fresh.refresh(
      cell: saved.cellUrl,
      school: saved.school,
      deviceId: device,
      deviceSecret: saved.deviceSecret,
    );
    expect([s.role, s.uid, s.tenantId], ['manager', 1, h['tenant']]);
    await expectLater(
      fresh.refresh(
        cell: gw.uri,
        school: saved.school,
        deviceId: device,
        deviceSecret: 'C' * 32,
      ),
      fails(SchoolAccessError.deviceRevoked),
    );
    await expectLater(
      fresh.refresh(
        cell: gw.uri,
        school: saved.school,
        deviceId: 'pd-other-device',
        deviceSecret: saved.deviceSecret,
      ),
      fails(SchoolAccessError.deviceRevoked),
    );
    negatives += 2;
    passed++;
  }, skip: skip);

  test(
    'W1-IT-05 re-activation on the same device revokes the old device secret',
    () async {
      final issued = await harness(['issue'], {'TENANT': '${h['tenant']}'});
      final act = await client.activate(
        cell: gw.uri,
        school: '${h['slug']}',
        code: '${issued['code']}',
        deviceId: device,
      );
      expect(act.deviceSecret, isNot(h['secret1']));
      await expectLater(
        client.refresh(
          cell: gw.uri,
          school: '${h['slug']}',
          deviceId: device,
          deviceSecret: '${h['secret1']}',
        ),
        fails(SchoolAccessError.deviceRevoked),
      );
      negatives++;
      final ok = await client.refresh(
        cell: gw.uri,
        school: '${h['slug']}',
        deviceId: device,
        deviceSecret: act.deviceSecret,
      );
      expect(ok.role, 'manager');
      passed++;
    },
    skip: skip,
  );

  test('W1-IT-06 Gateway without a Directory: 503 not_configured → fallback cell; without fallback → unavailable', () async {
    final noFb = SchoolAccessClient(directory: bare.uri);
    addTearDown(noFb.close);
    await expectLater(
      noFb.resolve('${h['slug']}'),
      fails(SchoolAccessError.unavailable),
    );
    negatives++;
    final fb = SchoolAccessClient(directory: bare.uri, fallbackCell: bare.uri);
    addTearDown(fb.close);
    final r = await fb.resolve('${h['slug']}');
    expect(r.cellUrl, bare.uri);
    final s = await fb
        .refresh(
          cell: r.cellUrl,
          school: r.schoolCode,
          deviceId: device,
          deviceSecret: 'D' * 32,
        )
        .then(
          (_) => 'unexpected',
          onError: (Object e) => (e as SchoolAccessFailure).kind.name,
        );
    expect(s, SchoolAccessError.deviceRevoked.name);
    passed++;
  }, skip: skip);

  test('W1-IT-07 Gateway down → offline (nothing hangs, no crash)', () async {
    final port = await freePort();
    final c = SchoolAccessClient(
      directory: Uri.parse('http://127.0.0.1:$port'),
      timeout: const Duration(seconds: 3),
    );
    addTearDown(c.close);
    await expectLater(
      c.resolve('${h['slug']}'),
      fails(SchoolAccessError.offline),
    );
    negatives++;
    passed++;
  }, skip: skip);
}
