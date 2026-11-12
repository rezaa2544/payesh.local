import 'package:flutter/foundation.dart';
import 'package:payesh_sync/payesh_sync.dart';

import '../flags.dart';

/// Where the login flow is (row 74, wave 1).
sealed class SessionState {
  const SessionState();
}

/// Reading the device's saved school.
final class SessionLoading extends SessionState {
  const SessionLoading();
}

/// The old (web) client is chosen — by the build flag or on this device.
final class LegacyClient extends SessionState {
  const LegacyClient();
}

/// Step 1: which school.
final class NeedSchool extends SessionState {
  const NeedSchool({this.error, this.typed = ''});
  final String? error;
  final String typed;
}

/// Step 2: the one-time activation code for [route].
final class NeedCode extends SessionState {
  const NeedCode(this.route, {this.error});
  final SchoolRoute route;
  final String? error;
}

/// Signed in. [session] is null while offline before the first refresh of this run: the app
/// still opens (offline-first) and shows what it has.
final class SignedIn extends SessionState {
  const SignedIn({required this.school, this.role, this.session, this.uid});
  final String school;
  final String? role;
  final SchoolSession? session;

  /// Last known user id (saved on the device) — used offline before the first refresh.
  final int? uid;

  /// Current role: the fresh session's, else the saved one.
  String? get currentRole => session?.role ?? role;

  /// Current user id: the fresh session's, else the saved one.
  int? get currentUid => session?.uid ?? uid;

  String? get roleFa {
    final r = session?.role ?? role;
    return r == null ? null : roleNameFa(r);
  }
}

/// Drives school select → activation → signed in, plus refresh, sign-out and the old/new client
/// switch. Network failures never sign the user out; only a revoked device credential does.
class SessionController extends ChangeNotifier {
  SessionController({
    required this.api,
    required this.accounts,
    required ClientFlags flags,
    DateTime Function()? now,
  }) : _active = flags,
       _now = now ?? DateTime.now;

  final SchoolAccessApi api;
  final SchoolAccountStore accounts;
  final DateTime Function() _now;
  ClientFlags _active;

  SessionState _state = const SessionLoading();
  bool _busy = false;
  DateTime? _cooldownUntil;
  SavedSchool? _saved;

  /// Visible sync state (badge). Wave 1 publishes the connection to the school server; from
  /// wave 2 the app's AutoSync publishes the outbox state into the same notifier.
  final ValueNotifier<SyncStatus> sync = ValueNotifier(
    const SyncStatus(
      phase: SyncPhase.idle,
      pending: 0,
      inflight: 0,
      blocked: 0,
    ),
  );

  SessionState get state => _state;

  /// Cell (Gateway) of the saved school — the data path of wave 2 talks to it.
  Uri? get cellUrl => _saved?.cellUrl;
  bool get busy => _busy;
  ClientFlags get flags => _active;

  /// Notice for a school that is moving between servers (Directory `migration_state`).
  String? get migrationNotice {
    final s = _state;
    return s is NeedCode && s.route.migrating
        ? 'این مدرسه در حال انتقال به سرور تازه است — ورود ممکن است کمی طول بکشد'
        : null;
  }

  void _set(SessionState s, {bool busy = false}) {
    _state = s;
    _busy = busy;
    notifyListeners();
  }

  void _publish(SyncPhase phase, {String? error, DateTime? ok}) {
    final prev = sync.value;
    sync.value = SyncStatus(
      phase: phase,
      pending: prev.pending,
      inflight: prev.inflight,
      blocked: prev.blocked,
      lastSuccessAt: ok ?? prev.lastSuccessAt,
      lastError: error,
    );
  }

  /// Wave 2: the outbox engine (AutoSync) publishes into the same badge — the queued / offline /
  /// needs-review counts come from the durable outbox on the device, never from a guess.
  void publishOutbox(SyncStatus s) => sync.value = s;

  /// While a 429 cooldown runs, no request is sent; the message says how long to wait.
  String? _coolingDown() {
    final until = _cooldownUntil;
    if (until == null) return null;
    final left = until.difference(_now());
    if (left <= Duration.zero) {
      _cooldownUntil = null;
      return null;
    }
    return SchoolAccessError.rateLimited.messageFa(left);
  }

  static final String _unknown = SchoolAccessError.unknown.messageFa();

  String _fail(SchoolAccessFailure e) {
    if (e.kind == SchoolAccessError.rateLimited) {
      _cooldownUntil = _now().add(e.retryAfter ?? const Duration(seconds: 60));
    }
    return e.messageFa;
  }

  Future<void> start() async {
    _set(const SessionLoading());
    try {
      _active = _active.withChoice(
        await accounts.store.read(SchoolKeys.clientChoice),
      );
      if (!_active.uses(NativeWave.login)) return _set(const LegacyClient());
      final saved = await accounts.load();
      _saved = saved;
      if (saved == null) return _set(const NeedSchool());
      _set(SignedIn(school: saved.school, role: saved.role, uid: saved.uid));
      await refresh();
    } on Object {
      _set(
        const NeedSchool(
          error: 'حافظهٔ امن دستگاه باز نشد — برنامه را دوباره باز کنید',
        ),
      );
    }
  }

  Future<void> submitSchool(String typed) async {
    if (_busy) return;
    final wait = _coolingDown();
    if (wait != null) return _set(NeedSchool(error: wait, typed: typed));
    _set(NeedSchool(typed: typed), busy: true);
    try {
      final route = await api.resolve(typed);
      _set(NeedCode(route));
    } on SchoolAccessFailure catch (e) {
      _set(NeedSchool(error: _fail(e), typed: typed));
    } on Object {
      _set(NeedSchool(error: _unknown, typed: typed));
    }
  }

  Future<void> submitCode(String typed) async {
    final s = _state;
    if (_busy || s is! NeedCode) return;
    final wait = _coolingDown();
    if (wait != null) return _set(NeedCode(s.route, error: wait));
    _set(NeedCode(s.route), busy: true);
    try {
      final device = await accounts.deviceId();
      final a = await api.activate(
        cell: s.route.cellUrl,
        school: s.route.schoolCode,
        code: typed,
        deviceId: device,
      );
      final saved = SavedSchool(
        school: a.session.school,
        cellUrl: s.route.cellUrl,
        deviceSecret: a.deviceSecret,
        role: a.session.role,
        uid: a.session.uid,
      );
      await accounts.save(saved);
      _saved = saved;
      _publish(SyncPhase.idle, ok: _now());
      _set(
        SignedIn(school: saved.school, role: saved.role, session: a.session),
      );
    } on SchoolAccessFailure catch (e) {
      _set(NeedCode(s.route, error: _fail(e)));
    } on Object {
      _set(NeedCode(s.route, error: _unknown));
    }
  }

  void changeSchool() {
    if (_busy) return;
    final s = _state;
    _set(NeedSchool(typed: s is NeedCode ? s.route.schoolCode : ''));
  }

  /// Fetches a fresh token with the device secret. Offline/unavailable keeps the user signed in
  /// (badge shows offline); a revoked device goes back to step 1 with a clear message.
  Future<void> refresh() async {
    final saved = _saved;
    final s = _state;
    if (saved == null || s is! SignedIn || _busy) return;
    if (_coolingDown() != null) return;
    _busy = true;
    _publish(SyncPhase.syncing);
    try {
      final fresh = await api.refresh(
        cell: saved.cellUrl,
        school: saved.school,
        deviceId: await accounts.deviceId(),
        deviceSecret: saved.deviceSecret,
      );
      if (fresh.role != saved.role || fresh.uid != saved.uid) {
        final updated = SavedSchool(
          school: saved.school,
          cellUrl: saved.cellUrl,
          deviceSecret: saved.deviceSecret,
          role: fresh.role,
          uid: fresh.uid,
        );
        await accounts.save(updated);
        _saved = updated;
      }
      _publish(SyncPhase.idle, ok: _now());
      _set(SignedIn(school: saved.school, role: fresh.role, session: fresh));
    } on SchoolAccessFailure catch (e) {
      if (e.kind == SchoolAccessError.deviceRevoked) {
        await accounts.clear();
        _saved = null;
        _publish(SyncPhase.idle);
        _set(NeedSchool(error: e.messageFa, typed: saved.school));
        return;
      }
      _publish(SyncPhase.offline, error: _fail(e));
      _set(SignedIn(school: saved.school, role: saved.role, uid: saved.uid));
    } on Object {
      _publish(SyncPhase.offline, error: _unknown);
      _set(SignedIn(school: saved.school, role: saved.role, uid: saved.uid));
    }
  }

  /// A token valid now, refreshing when needed; null when offline (callers queue work instead).
  Future<String?> validToken() async {
    final s = _state;
    if (s is! SignedIn) return null;
    final cur = s.session;
    if (cur != null && !cur.expiredAt(_now().add(const Duration(minutes: 1)))) {
      return cur.token;
    }
    await refresh();
    final n = _state;
    return n is SignedIn ? n.session?.token : null;
  }

  /// Forgets the school and the device secret on this device (the server credential stays until
  /// the manager revokes it; a new activation code is needed to come back).
  Future<void> signOut() async {
    if (_busy) return;
    await accounts.clear();
    _saved = null;
    _publish(SyncPhase.idle);
    _set(const NeedSchool());
  }

  /// Device-level switch to the old (web) client; kept across restarts.
  Future<void> useLegacy() async {
    await accounts.store.write(SchoolKeys.clientChoice, 'legacy');
    _active = _active.withChoice('legacy');
    _set(const LegacyClient());
  }

  /// Back to the native client — only when the build ships the native login.
  Future<void> useNative() async {
    if (!_active.ships(NativeWave.login)) return;
    await accounts.store.write(SchoolKeys.clientChoice, 'native');
    await start();
  }

  @override
  void dispose() {
    sync.dispose();
    super.dispose();
  }
}
