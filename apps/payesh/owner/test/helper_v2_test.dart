import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/helper/helper_box.dart';

/// Rows 205/209 — contract v2 presence parsing + school token (Node parity:
/// server/helper-v2.js, docs/cloud/contracts/helper-jobs-vectors-v2.json).
void main() {
  test('v2 presence defaults: v1 plain => owner/internal-compatible', () {
    final p = HelperPresence.fromPlain('a1b2c3d4e5f60718', {
      'v': 1,
      'helper_id': 'a1b2c3d4e5f60718',
      'host': 'PC',
      'version': '1',
      'slots': 2,
      'paused': false,
      'kinds': ['storage.usage'],
      'at': 1,
      'done': 0,
      'failed': 0,
    });
    expect(p, isNotNull);
    expect(p!.cls, 'owner');
    expect(p.caps, ['storage.usage']);
  });

  test('v2 presence parses cls/caps/school_id (row 210 unified view)', () {
    final p = HelperPresence.fromPlain('a1b2c3d4e5f60718', {
      'v': 2,
      'helper_id': 'a1b2c3d4e5f60718',
      'host': 'SCHOOL-PC',
      'version': '2',
      'slots': 1,
      'paused': false,
      'kinds': ['storage.usage'],
      'cls': 'school',
      'caps': ['storage.usage', 'report.aggregate'],
      'school_id': 'school-01',
      'at': 1,
      'done': 3,
      'failed': 0,
    });
    expect(p, isNotNull);
    expect(p!.cls, 'school');
    expect(p.caps, ['storage.usage', 'report.aggregate']);
    expect(p.schoolId, 'school-01');
  });

  test('queue status counts pending/leased/done/stuck (row 210)', () {
    final now = DateTime.fromMillisecondsSinceEpoch(100000, isUtc: true);
    final q = queueStatusFromKeys(
      [
        'payesh/jobs/req/1.json',
        'payesh/jobs/req/2.json',
        'payesh/jobs/lease/2.json',
        'payesh/jobs/req/3.json',
        'payesh/jobs/lease/3.json',
        'payesh/jobs/res/3.json',
        'payesh/jobs/req/4.json',
        'payesh/jobs/lease/4.json',
      ],
      leaseUntilMs: {'2': 99000, '3': 99000, '4': 101000},
      now: now,
    );
    expect(q.pending, 1);
    expect(q.leased, 3);
    expect(q.done, 1);
    expect(q.stuck, 1);
  });

  test('revoked marker plain roundtrip (row 209)', () {
    final p = schoolTokenRevokedPlain(
      'school-01',
      DateTime.fromMillisecondsSinceEpoch(5, isUtc: true),
    );
    expect(schoolIdFromRevokedPlain(p), 'school-01');
    expect(schoolIdFromRevokedPlain({'school_id': 'BAD ID'}), isNull);
    expect(schoolIdFromRevokedPlain(null), isNull);
  });

  test('school token matches Node schoolToken shape and verifies', () {
    final t = schoolHelperToken('sk-vector-0123456789abcdef', 'school-01');
    expect(t.startsWith('school-01.'), isTrue);
    expect(verifySchoolHelperToken('sk-vector-0123456789abcdef', t), isTrue);
    expect(verifySchoolHelperToken('other-secret', t), isFalse);
    expect(
      verifySchoolHelperToken(
        'sk-vector-0123456789abcdef',
        'school-02.${t.split('.')[1]}',
      ),
      isFalse,
    );
  });

  // Row 213 — same vectors as server/helper-v2.js pollEta (tests/helper-idle-213.js).
  test('poll_eta vectors: Dart pollEtaAt == Node pollEta', () {
    var dir = Directory.current;
    File? f;
    for (var i = 0; i < 6 && f == null; i++) {
      final c = File(
        '${dir.path}/docs/cloud/contracts/helper-jobs-vectors-v2.json',
      );
      if (c.existsSync()) f = c;
      dir = dir.parent;
    }
    expect(f, isNotNull);
    final v = (jsonDecode(f!.readAsStringSync()) as Map)['poll_eta'] as Map;
    expect(v['idle_poll_cap_ms'], idlePollCap.inMilliseconds);
    expect(v['legacy_poll_ms'], legacyPollEvery.inMilliseconds);
    expect(v['claim_margin_ms'], claimMargin.inMilliseconds);
    expect(v['claim_wait_ms'], claimWait.inMilliseconds);
    final now = DateTime.fromMillisecondsSinceEpoch(
      v['now'] as int,
      isUtc: true,
    );
    for (final c in (v['cases'] as List).cast<Map<String, Object?>>()) {
      final plain = Map<String, Object?>.from(c['presence'] as Map)
        ..['helper_id'] = 'a1b2c3d4e5f60718';
      final p = HelperPresence.fromPlain('a1b2c3d4e5f60718', plain)!;
      expect(
        p.pollEtaAt(now)?.inMilliseconds,
        c['eta'],
        reason: '${c['name']}',
      );
    }
  });

  test(
    'presence toPlain advertises poll_ms/accepting; v1 shape kept without them',
    () {
      final at = DateTime.fromMillisecondsSinceEpoch(1000, isUtc: true);
      HelperPresence mk({int? pollMs, bool accepting = true}) => HelperPresence(
        helperId: 'a1b2c3d4e5f60718',
        host: 'PC',
        version: '1',
        slots: 1,
        paused: false,
        kinds: const ['storage.usage'],
        at: at,
        done: 0,
        failed: 0,
        pollMs: pollMs,
        accepting: accepting,
      );
      final on = mk(pollMs: 15000).toPlain();
      expect(on['poll_ms'], 15000);
      expect(on['accepting'], isTrue);
      final off = mk(accepting: false).toPlain();
      expect(off.containsKey('poll_ms'), isFalse);
      expect(off['accepting'], isFalse);
      final legacy = mk().toPlain();
      expect(legacy.containsKey('poll_ms'), isFalse);
      expect(legacy.containsKey('accepting'), isFalse);
    },
  );
}
