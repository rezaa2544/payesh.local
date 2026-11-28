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
}
