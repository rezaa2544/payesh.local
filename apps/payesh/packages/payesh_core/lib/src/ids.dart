import 'dart:math';

final Random _secure = Random.secure();

/// Random RFC 4122 version-4 UUID (lowercase), used as the stable idempotency key `k`/`uid`
/// of every outbox operation — identical across retries and restarts (same rule as client/outbox-web.js).
String newIdempotencyKey([Random? random]) {
  final r = random ?? _secure;
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-'
      '${h.substring(16, 20)}-${h.substring(20, 32)}';
}

final RegExp _uuidV4 = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

/// True when [key] is acceptable as an idempotency key for the server
/// (non-empty, at most [maxLen] characters).
bool isValidIdempotencyKey(String key, {int maxLen = 120}) =>
    key.trim().isNotEmpty && key.length <= maxLen;

/// True when [key] is a lowercase v4 UUID as produced by [newIdempotencyKey].
bool isUuidV4(String key) => _uuidV4.hasMatch(key);
