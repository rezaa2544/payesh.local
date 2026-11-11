import 'dart:async';
import 'dart:math';

import 'package:payesh_core/payesh_core.dart';

import 'outbox.dart';

/// What the user is told about synchronisation (row 119, shown by the app in row 74).
enum SyncPhase {
  /// Nothing waiting; last contact with the server succeeded.
  idle,

  /// A push/pull cycle is running.
  syncing,

  /// Ops are on the device and the server is reachable; the next cycle sends them.
  queued,

  /// Ops are waiting because the server could not be reached; they are kept on the device and
  /// will be sent automatically.
  offline,

  /// Ops need a user decision (blocked after non-transient failures). Nothing is lost.
  attention,
}

/// Immutable snapshot of the sync state; every change is published on [AutoSync.status].
final class SyncStatus {
  const SyncStatus({
    required this.phase,
    required this.pending,
    required this.inflight,
    required this.blocked,
    this.lastSuccessAt,
    this.nextAttemptAt,
    this.lastError,
  });

  final SyncPhase phase;
  final int pending;
  final int inflight;
  final int blocked;
  final DateTime? lastSuccessAt;
  final DateTime? nextAttemptAt;
  final String? lastError;

  /// Ops still on the device (not yet confirmed by the server).
  int get waiting => pending + inflight + blocked;

  /// Persian one-line label for the status badge (RTL UI, row 73/74).
  String get labelFa => switch (phase) {
    SyncPhase.idle => 'همگام',
    SyncPhase.syncing => 'در حال همگام‌سازی…',
    SyncPhase.queued => '$waiting مورد در صف ارسال',
    SyncPhase.offline => 'آفلاین — $waiting مورد در صف ارسال',
    SyncPhase.attention => '$blocked مورد نیاز به بررسی دارد',
  };

  @override
  String toString() =>
      'SyncStatus(${phase.name} pending=$pending inflight=$inflight blocked=$blocked '
      'next=${nextAttemptAt?.toIso8601String()} err=$lastError)';
}

/// Automatic queue runner of the native app (row 119).
///
/// * runs a cycle on start, after every enqueue (debounced), when connectivity returns, at the
///   outbox's next retry time and on an idle polling interval (notifications by polling, O‑26);
/// * single-flight: never two cycles at once, and never two cycles closer than [minGap];
/// * no retry storm: retries follow the outbox backoff, and every scheduled wake-up carries a
///   random spread so devices that lost the same network do not return in lockstep;
/// * every state change is published on [status] so the UI can always show what is pending.
final class AutoSync {
  AutoSync({
    required this.outbox,
    required this.push,
    this.pull,
    this.clock = const SystemClock(),
    this.idleInterval = const Duration(seconds: 60),
    this.minGap = const Duration(seconds: 2),
    this.spread = const Duration(seconds: 5),
    Random? random,
  }) : _random = random ?? Random();

  final SqliteOutbox outbox;
  final PushSender push;

  /// Optional pull cycle (e.g. `GatewaySync.pull`). Pull errors mark the status offline but
  /// never touch the outbox.
  final Future<void> Function()? pull;
  final Duration idleInterval;
  final Duration minGap;
  final Duration spread;
  final Clock clock;
  final Random _random;

  final _ctrl = StreamController<SyncStatus>.broadcast();
  Timer? _timer;
  bool _running = false;
  bool _again = false;
  bool _started = false;
  DateTime? _lastRunAt;
  DateTime? _lastSuccessAt;
  String? _lastError;
  bool _reachable = true;
  int _cycles = 0;
  late SyncStatus _current = _snapshot(SyncPhase.idle, null);

  /// Number of push/pull cycles actually executed (tests use it to prove "no storm").
  int get cycles => _cycles;
  Stream<SyncStatus> get status => _ctrl.stream;
  SyncStatus get current => _current;

  void start() {
    if (_started) return;
    _started = true;
    outbox.recover(); // abandoned leases from a crash become sendable
    _schedule(Duration.zero);
  }

  Future<void> stop() async {
    _started = false;
    _timer?.cancel();
    _timer = null;
    while (_running) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    await _ctrl.close();
  }

  /// The app queued a new op: send it soon (debounced by [minGap]).
  void notifyEnqueued() {
    _publish(
      _snapshot(
        _running ? SyncPhase.syncing : _phase(),
        _current.nextAttemptAt,
      ),
    );
    _schedule(minGap);
  }

  /// The OS reports connectivity again: due ops are woken and a cycle runs after a random
  /// spread (0..[spread]) — not immediately, so a whole school does not hit the Gateway at once.
  void notifyOnline() {
    outbox.wake();
    _schedule(_jittered(Duration.zero, spread));
  }

  /// The OS reports no connectivity: nothing is sent until the next wake-up.
  void notifyOffline() {
    _reachable = false;
    _publish(_snapshot(SyncPhase.offline, _current.nextAttemptAt));
  }

  /// Runs one cycle now (or joins the running one). Returns the resulting status.
  Future<SyncStatus> runOnce() async {
    if (_running) {
      _again = true;
      while (_running) {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
      return _current;
    }
    _running = true;
    _timer?.cancel();
    _timer = null;
    try {
      do {
        _again = false;
        await _cycle();
      } while (_again && _started);
    } finally {
      _running = false;
    }
    _scheduleNext();
    return _current;
  }

  Future<void> _cycle() async {
    _cycles++;
    _lastRunAt = clock.now();
    _publish(_snapshot(SyncPhase.syncing, null));
    String? err;
    final r = await outbox.drain(push);
    if (r.stopped != null) err = r.stopped;
    // only a real round trip is evidence of reachability: a cycle where every op is still in
    // backoff (nothing claimed) and no pull ran must not flip "offline" back to "synced"
    var contacted = r.claimed > 0;
    if (err == null && pull != null) {
      try {
        await pull!();
        contacted = true;
      } on Object catch (e) {
        err = 'pull: $e';
      }
    }
    if (err == null && !contacted) {
      // no evidence either way — keep the last known state
    } else if (err == null) {
      _reachable = true;
      _lastSuccessAt = clock.now();
      _lastError = null;
    } else {
      _reachable = false;
      _lastError = err;
    }
  }

  void _scheduleNext() {
    if (!_started) {
      _publish(_snapshot(_phase(), null));
      return;
    }
    final st = outbox.stats();
    final now = clock.now();
    Duration wait;
    if (st.pending > 0) {
      // next due op (FIFO head) decides; never earlier than minGap after the last run
      final head = outbox
          .list(state: OpState.pending)
          .map((o) => o.nextAt)
          .fold<int?>(null, (a, b) => a == null ? b : min(a, b));
      final dueIn = Duration(
        milliseconds: max(0, (head ?? 0) - now.millisecondsSinceEpoch),
      );
      wait = dueIn < minGap ? minGap : dueIn;
    } else {
      wait = _jittered(idleInterval * 0.5, idleInterval * 0.5);
    }
    _schedule(wait);
  }

  void _schedule(Duration wait) {
    if (!_started) return;
    final now = clock.now();
    var w = wait;
    final last = _lastRunAt;
    if (last != null) {
      final earliest = last.add(minGap);
      if (now.add(w).isBefore(earliest)) w = earliest.difference(now);
    }
    final at = now.add(w);
    final cur = _current.nextAttemptAt;
    if (_timer != null && cur != null && !at.isBefore(cur)) {
      return; // keep the earlier timer
    }
    _timer?.cancel();
    _timer = Timer(w, () {
      _timer = null;
      unawaited(runOnce());
    });
    _publish(_snapshot(_running ? SyncPhase.syncing : _phase(), at));
  }

  Duration _jittered(Duration base, Duration range) => Duration(
    milliseconds:
        base.inMilliseconds +
        (_random.nextDouble() * range.inMilliseconds).round(),
  );

  SyncPhase _phase() {
    final st = outbox.stats();
    if (st.blocked > 0) return SyncPhase.attention;
    if (!_reachable) return SyncPhase.offline;
    return st.active > 0 ? SyncPhase.queued : SyncPhase.idle;
  }

  SyncStatus _snapshot(SyncPhase phase, DateTime? next) {
    final st = outbox.stats();
    return SyncStatus(
      phase: phase,
      pending: st.pending,
      inflight: st.inflight,
      blocked: st.blocked,
      lastSuccessAt: _lastSuccessAt,
      nextAttemptAt: next,
      lastError: _lastError,
    );
  }

  void _publish(SyncStatus s) {
    _current = s;
    if (!_ctrl.isClosed) _ctrl.add(s);
  }
}
