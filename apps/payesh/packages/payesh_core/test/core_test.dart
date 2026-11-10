import 'dart:math';

import 'package:payesh_core/payesh_core.dart';
import 'package:test/test.dart';

void main() {
  group('idempotency keys', () {
    test('v4 UUID shape, lowercase, 36 chars', () {
      for (var i = 0; i < 200; i++) {
        final k = newIdempotencyKey();
        expect(k.length, 36);
        expect(isUuidV4(k), isTrue, reason: k);
        expect(isValidIdempotencyKey(k), isTrue);
      }
    });
    test('unique across 10k draws', () {
      final s = <String>{for (var i = 0; i < 10000; i++) newIdempotencyKey()};
      expect(s.length, 10000);
    });
    test('deterministic with a seeded Random', () {
      expect(newIdempotencyKey(Random(7)), newIdempotencyKey(Random(7)));
    });
    test('server limit of 120 chars is enforced', () {
      expect(isValidIdempotencyKey('a' * 120), isTrue);
      expect(isValidIdempotencyKey('a' * 121), isFalse);
      expect(isValidIdempotencyKey('   '), isFalse);
    });
  });

  group('clock', () {
    test('FakeClock advances deterministically in UTC', () {
      final c = FakeClock(DateTime.utc(2026, 11, 10, 8));
      c.advance(const Duration(minutes: 15));
      expect(c.now(), DateTime.utc(2026, 11, 10, 8, 15));
      expect(c.now().isUtc, isTrue);
    });
    test('SystemClock is UTC', () {
      expect(const SystemClock().now().isUtc, isTrue);
    });
  });

  group('error codes', () {
    test('round-trip wire names', () {
      for (final e in PayeshErrorCode.values) {
        expect(PayeshErrorCode.fromWire(e.wire), e);
      }
      expect(PayeshErrorCode.fromWire('nope'), PayeshErrorCode.unknown);
      expect(PayeshErrorCode.fromWire(null), PayeshErrorCode.unknown);
    });
    test('write_frozen keeps ops queued; queue_full refuses the new op', () {
      expect(PayeshErrorCode.writeFrozen.keepQueued, isTrue);
      expect(PayeshErrorCode.queueFull.keepQueued, isFalse);
    });
  });

  test('API limits match the server contract', () {
    expect(PayeshApi.maxPushOps, 200);
    expect(PayeshApi.maxIdempotencyKeyLength, 120);
    expect(PayeshApi.maxPushBodyBytes, 8388608);
    expect(PayeshApi.syncContract, 'sync-v1');
  });
}
