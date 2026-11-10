/// Injectable time source so scheduling/backoff logic is testable without real waits.
abstract interface class Clock {
  DateTime now();
}

/// Wall-clock implementation (UTC).
final class SystemClock implements Clock {
  const SystemClock();
  @override
  DateTime now() => DateTime.now().toUtc();
}

/// Manually advanced clock for tests.
final class FakeClock implements Clock {
  FakeClock([DateTime? start])
    : _now = (start ?? DateTime.utc(2026, 1, 1)).toUtc();
  DateTime _now;
  @override
  DateTime now() => _now;
  void advance(Duration d) => _now = _now.add(d);
}
