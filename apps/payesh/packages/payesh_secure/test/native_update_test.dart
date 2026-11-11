// Row 78 — signed native auto-update. The Dart verifier must reach exactly the
// decisions of the JavaScript reference on docs/cloud/contracts/
// native-update-vectors-78.json (tools/native-update-78.mjs), refuse a bad
// artifact hash, forbid downgrades and honour both kill-switches.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:test/test.dart';

Map<String, Object?> _vectors() {
  var dir = Directory.current;
  for (var i = 0; i < 6; i++) {
    final f = File(
      '${dir.path}/docs/cloud/contracts/native-update-vectors-78.json',
    );
    if (f.existsSync()) {
      return jsonDecode(f.readAsStringSync()) as Map<String, Object?>;
    }
    dir = dir.parent;
  }
  throw StateError('native-update-vectors-78.json not found');
}

Map<String, Object?> _m(Object? o) => o as Map<String, Object?>;
String _s(Object? o) => o as String;
int _i(Object? o) => o as int;

String _label(UpdateDecision d) => switch (d) {
  UpToDate() => 'up_to_date',
  UpdateAvailable() => 'available',
  Halted(:final reason) => 'halted:$reason',
  Refused(:final error) => 'refused:${error.code}',
};

void main() {
  final v = _vectors();
  final dev = _m(v['device']);
  final kid = _s(v['test_key_id']);
  final pub = base64.decode(_s(v['test_public_key_b64']));
  final now = DateTime.parse(_s(dev['now']));
  final installed = _i(dev['installed_build']);
  final highest = _i(dev['highest_seen_build']);
  final artifact = base64.decode(_s(v['artifact_b64']));
  final cases = (v['cases']! as List<Object?>).map(_m).toList();

  UpdateVerifier verifier({bool auto = false}) => UpdateVerifier(
    UpdateConfig(
      publisherKeys: {kid: pub},
      channel: UpdateChannel.pilot,
      platform: UpdatePlatform.android,
      autoInstall: auto,
    ),
  );
  List<int> env(String id) =>
      utf8.encode(_s(cases.firstWhere((c) => c['id'] == id)['envelope_text']));

  test('NU-01 key id of the pinned test key = SHA-256 prefix', () async {
    expect(await keyIdOf(pub), kid);
  });

  for (final c in cases) {
    test('NU-02 ${c['id']} ${c['title']} ⇒ ${c['expect']}', () async {
      final d = await verifier().evaluate(
        utf8.encode(_s(c['envelope_text'])),
        installedBuild: installed,
        highestSeenBuild: highest,
        now: now,
      );
      expect(_label(d), c['expect']);
    });
  }

  test(
    'NU-03 pilot default: auto-install OFF (PAYESH_UPDATE_AUTO unset)',
    () async {
      expect(autoInstallFromEnvironment(), isFalse);
      final cfg = UpdateConfig(
        publisherKeys: {kid: pub},
        channel: UpdateChannel.pilot,
        platform: UpdatePlatform.android,
      );
      expect(cfg.autoInstall, isFalse);
      final d = await UpdateVerifier(cfg).evaluate(
        env('NUV-01'),
        installedBuild: installed,
        highestSeenBuild: highest,
        now: now,
      );
      expect((d as UpdateAvailable).autoInstall, isFalse);
      final on = await verifier(auto: true).evaluate(
        env('NUV-01'),
        installedBuild: installed,
        highestSeenBuild: highest,
        now: now,
      );
      expect((on as UpdateAvailable).autoInstall, isTrue);
      expect(on.manifest.build, 58);
      expect(on.manifest.version, '0.2.0');
      expect(on.artifact.url.scheme, 'https');
    },
  );

  test(
    'NU-04 downgrade forbidden even below the highest build ever seen',
    () async {
      // installed 57 but this device already saw 60 (e.g. rolled back locally):
      // the network may not push 58 or 59 again.
      final d = await verifier().evaluate(
        env('NUV-01'),
        installedBuild: 57,
        highestSeenBuild: 60,
        now: now,
      );
      expect(_label(d), 'refused:upd_rollback');
    },
  );

  group('NU-05 artifact staging (hash + size from the signed manifest)', () {
    late Directory tmp;
    late UpdateManifest m;
    setUp(() async {
      tmp = Directory.systemTemp.createTempSync('nu78-');
      m = await verifier().open(env('NUV-01'));
    });
    tearDown(() => tmp.deleteSync(recursive: true));

    Stream<List<int>> chunks(List<int> b) =>
        Stream.fromIterable([b.sublist(0, 100), b.sublist(100)]);

    test('good artifact is promoted to update-58.apk', () async {
      final f = await ArtifactStager(tmp)
          .stage(m, UpdatePlatform.android, chunks(artifact));
      expect(f.path, endsWith('update-58.apk'));
      expect(f.readAsBytesSync(), artifact);
      final w = await ArtifactStager(tmp)
          .stage(m, UpdatePlatform.windows, chunks(artifact));
      expect(w.path, endsWith('update-58.exe'));
    });

    test(
      'NEGATIVE: one flipped byte ⇒ upd_bad_hash, nothing left on disk',
      () async {
        final evil = Uint8List.fromList(artifact)..[7] ^= 1;
        await expectLater(
          ArtifactStager(tmp).stage(m, UpdatePlatform.android, chunks(evil)),
          throwsA(
            isA<UpdateError>().having((e) => e.code, 'code', 'upd_bad_hash'),
          ),
        );
        expect(tmp.listSync(), isEmpty);
      },
    );

    test(
      'NEGATIVE: longer / shorter body ⇒ upd_bad_size, nothing left',
      () async {
        await expectLater(
          ArtifactStager(tmp)
              .stage(m, UpdatePlatform.android, chunks([...artifact, 0])),
          throwsA(
            isA<UpdateError>().having((e) => e.code, 'code', 'upd_bad_size'),
          ),
        );
        await expectLater(
          ArtifactStager(tmp).stage(
            m,
            UpdatePlatform.android,
            chunks(artifact.sublist(0, artifact.length - 1)),
          ),
          throwsA(
            isA<UpdateError>().having((e) => e.code, 'code', 'upd_bad_size'),
          ),
        );
        expect(tmp.listSync(), isEmpty);
      },
    );

    test('kill-switch: discardAll removes staged files only', () async {
      await ArtifactStager(tmp)
          .stage(m, UpdatePlatform.android, chunks(artifact));
      File('${tmp.path}/keep.txt').writeAsStringSync('x');
      expect(await ArtifactStager(tmp).discardAll(), 1);
      expect(tmp.listSync().map((e) => e.path.split(RegExp(r'[\\/]')).last), [
        'keep.txt',
      ]);
      expect(
        await ArtifactStager(Directory('${tmp.path}/none')).discardAll(),
        0,
      );
    });
  });

  test('NU-06 server kill-switch: 503 feature_disabled ⇒ Halted; other errors ⇒ Refused', () async {
    final vv = verifier();
    Future<String> r(int s, String body) async => _label(
      await vv.evaluateResponse(
        s,
        utf8.encode(body),
        installedBuild: installed,
        highestSeenBuild: highest,
        now: now,
      ),
    );
    expect(
      await r(
        503,
        '{"ok":false,"error":"feature_disabled","feature":"update"}',
      ),
      'halted:server_kill_switch',
    );
    expect(await r(503, 'busy'), 'refused:upd_server');
    expect(await r(404, ''), 'refused:upd_server');
    expect(await r(200, _s(cases.first['envelope_text'])), 'available');
  });

  test('NU-07 rollback: a build that never confirms health goes back to the previous one', () {
    var st = const UpdateState(installedBuild: 57, highestSeenBuild: 57);
    st = st.installed(58);
    expect(st.previousBuild, 57);
    expect(st.pendingBuild, 58);
    expect(st.highestSeenBuild, 58);
    st = st.launched(58).launched(58);
    expect(st.shouldRollback, isFalse);
    st = st.launched(58);
    expect(st.shouldRollback, isTrue);
    final back = st.rolledBack();
    expect(back.installedBuild, 57);
    expect(back.highestSeenBuild, 58, reason: 'keeps the anti-rollback floor');
    expect(back.pendingBuild, isNull);
    // persisted form round-trips
    final again = UpdateState.fromJson(
      jsonDecode(jsonEncode(st.toJson())) as Map<String, Object?>,
    );
    expect(again.pendingLaunches, 3);
    expect(again.shouldRollback, isTrue);
  });

  test('NU-08 healthy start clears the pending build; no rollback, no re-install of older builds', () {
    var st = const UpdateState(installedBuild: 57, highestSeenBuild: 57);
    st = st.installed(58).launched(58).confirmedHealthy();
    expect(st.pendingBuild, isNull);
    expect(st.shouldRollback, isFalse);
    expect(
      st.launched(58).pendingLaunches,
      0,
      reason: 'only a pending build counts',
    );
    expect(() => st.rolledBack(), throwsStateError);
    expect(
      () => st.installed(58),
      throwsA(isA<UpdateError>().having((e) => e.code, 'code', 'upd_rollback')),
    );
  });

  test('NU-09 a key rotation: two pinned keys, either verifies; config is immutable', () async {
    final other = await Ed25519().newKeyPairFromSeed(List<int>.filled(32, 9));
    final otherPub = (await other.extractPublicKey()).bytes;
    final cfg = UpdateConfig(
      publisherKeys: {kid: pub, await keyIdOf(otherPub): otherPub},
      channel: UpdateChannel.pilot,
      platform: UpdatePlatform.android,
      autoInstall: false,
    );
    expect(
      () => cfg.publisherKeys['x'] = Uint8List(32),
      throwsUnsupportedError,
    );
    // a manifest signed in Dart by the second key is accepted
    final m = jsonDecode(
      utf8.decode(
        base64.decode(
          _s(_m(jsonDecode(_s(cases.first['envelope_text'])))['manifest_b64']),
        ),
      ),
    ) as Map<String, Object?>;
    final body = utf8.encode(jsonEncode(m));
    final sig = await Ed25519().sign(body, keyPair: other);
    final envelope = utf8.encode(
      jsonEncode({
        'format': envelopeFormat,
        'key_id': await keyIdOf(otherPub),
        'manifest_b64': base64.encode(body),
        'sig_b64': base64.encode(sig.bytes),
      }),
    );
    final d = await UpdateVerifier(cfg).evaluate(
      envelope,
      installedBuild: installed,
      highestSeenBuild: highest,
      now: now,
    );
    expect(_label(d), 'available');
  });

  test(
    'NU-10 malformed envelopes and manifests are refused with stable codes',
    () async {
      Future<String> e(Object envelope) async => _label(
        await verifier().evaluate(
          utf8.encode(jsonEncode(envelope)),
          installedBuild: installed,
          highestSeenBuild: highest,
          now: now,
        ),
      );
      final good = _m(jsonDecode(_s(cases.first['envelope_text'])));
      expect(await e([1, 2]), 'refused:upd_bad_envelope');
      expect(await e({...good, 'extra': 1}), 'refused:upd_bad_envelope');
      expect(await e({...good, 'format': 'x'}), 'refused:upd_bad_envelope');
      expect(await e({...good, 'sig_b64': '***'}), 'refused:upd_bad_envelope');
      expect(await e({...good, 'sig_b64': 5}), 'refused:upd_bad_envelope');
      // manifest field checks, through the parser directly
      final base = _m(
        jsonDecode(utf8.decode(base64.decode(_s(good['manifest_b64'])))),
      );
      String p(Map<String, Object?> m) {
        try {
          UpdateManifest.parse(m);
          return 'ok';
        } on UpdateError catch (x) {
          return x.code;
        }
      }

      expect(p(base), 'ok');
      final art = _m(_m(base['artifacts'])['android']);
      for (final bad in <Map<String, Object?>>[
        {...base, 'schema': 'v0'},
        {...base, 'channel': 'nightly'},
        {...base, 'version': '1.2'},
        {...base, 'build': 0},
        {...base, 'published_at': '2026-11-10'},
        {...base, 'expires_at': base['published_at']},
        {...base, 'halt': 'no'},
        {...base, 'artifacts': <Object?>[]},
        {
          ...base,
          'artifacts': {'ios': art},
        },
        {
          ...base,
          'artifacts': {
            'android': {...art, 'sha256': 'ABC'},
          },
        },
        {
          ...base,
          'artifacts': {
            'android': {...art, 'size': -1},
          },
        },
        {
          ...base,
          'artifacts': {
            'android': {...art, 'url': 'https://'},
          },
        },
      ]) {
        expect(p(bad), 'upd_bad_manifest', reason: '$bad');
      }
      expect(UpdateError('upd_x').toString(), 'upd_x');
      expect(UpdateError('upd_x', 'd').toString(), 'upd_x: d');
    },
  );
}
