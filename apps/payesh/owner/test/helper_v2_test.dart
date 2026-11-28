import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/helper/helper_box.dart';

/// Rows 205/209 — contract v2 presence parsing + school token (Node parity:
/// server/helper-v2.js, docs/cloud/contracts/helper-jobs-vectors-v2.json).
void main() {
  test('v2 presence defaults: v1 plain => owner/internal-compatible', () {
    final p = HelperPresence.fromPlain('a1b2c3d4e5f60718', {
      'v': 1, 'helper_id': 'a1b2c3d4e5f60718', 'host': 'PC', 'version': '1',
      'slots': 2, 'paused': false, 'kinds': ['storage.usage'], 'at': 1,
      'done': 0, 'failed': 0,
    });
    expect(p, isNotNull);
    expect(p!.cls, 'owner');
    expect(p.caps, ['storage.usage']);
  });

  test('school token matches Node schoolToken shape and verifies', () {
    final t = schoolHelperToken('sk-vector-0123456789abcdef', 'school-01');
    expect(t.startsWith('school-01.'), isTrue);
    expect(verifySchoolHelperToken('sk-vector-0123456789abcdef', t), isTrue);
    expect(verifySchoolHelperToken('other-secret', t), isFalse);
    expect(verifySchoolHelperToken('sk-vector-0123456789abcdef', 'school-02.' + t.split('.')[1]), isFalse);
  });
}
