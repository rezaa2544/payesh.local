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

/// Row 127 — the school's own server on the local network (no Gateway): address → (first setup
/// on a fresh server | phone + password). [info] is null until the address answered as a Payesh
/// school server.
final class NeedLan extends SessionState {
  const NeedLan({this.info, this.error, this.typed = ''});
  final LanServerInfo? info;
  final String? error;

  /// Address typed in the first step (kept on errors).
  final String typed;

  /// A fresh server: the first setup (school + manager) comes next.
  bool get needsSetup => info != null && !info!.setupDone;
}

/// Row 128 / W7 — the user locked the app on this device (web `lockApp`): the device stays
/// registered (device token kept), but nothing is shown and nothing syncs until the user's
/// password opens a new session (`/api/auth/unlock`). Kept across restarts.
final class Locked extends SessionState {
  const Locked({required this.school, this.schoolName, this.error});
  final String school;
  final String? schoolName;
  final String? error;
}

/// Row 128 / W7 — manager rescue on the server computer itself (web form `claim`): the
/// manager's mobile + a new password, accepted by the server only from its own computer.
final class NeedClaim extends SessionState {
  const NeedClaim(this.info, {this.error});
  final LanServerInfo info;
  final String? error;
}

/// Signed in. [session] is null while offline before the first refresh of this run: the app
/// still opens (offline-first) and shows what it has.
final class SignedIn extends SessionState {
  const SignedIn({
    required this.school,
    this.role,
    this.session,
    this.uid,
    this.lanServer,
    this.schoolName,
  });
  final String school;

  /// Row 127: set when signed in to the school's own LAN server (not the cloud Gateway).
  final Uri? lanServer;

  /// Display name of the school (LAN: from the server's `/api/health`).
  final String? schoolName;
  bool get onLan => lanServer != null;
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
    this.lan,
    this.deviceName = 'پایش',
    DateTime Function()? now,
  }) : _active = flags,
       _now = now ?? DateTime.now;

  final SchoolAccessApi api;
  final SchoolAccountStore accounts;

  /// Row 127: login against the school's own LAN server; null = this build offers no LAN mode.
  final LanAccessApi? lan;

  /// Name the LAN server records for this device (manager's device list).
  final String deviceName;
  LanAccountStore get lanAccounts => LanAccountStore(accounts.store);
  SavedLan? _lan;
  Future<void>? _refreshing;
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

  /// Cell (Gateway) of the saved school — the data path of wave 2 talks to it. In LAN mode
  /// (row 127) this is the school's own server.
  Uri? get cellUrl => _lan?.server ?? _saved?.cellUrl;

  /// Row 127: the data path talks Sync v1 (`/api/v1/pull`, `/api/sync`) to the LAN server.
  bool get onLan => _lan != null;

  /// Whether this build offers the LAN login.
  bool get lanAvailable => lan != null;

  /// Addresses of the LAN server for the other devices (known after the address step).
  List<String> get lanShareUrls => _lanShare;
  List<String> _lanShare = const [];
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
      if (lan != null) {
        final l = await lanAccounts.load();
        _lan = l;
        if (l != null && await lanAccounts.isLocked()) {
          return _set(Locked(school: l.school, schoolName: l.schoolName));
        }
        if (l != null) {
          _set(_lanSignedIn(l));
          await refresh();
          return;
        }
      }
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
  Future<void> refresh() {
    final cur = _refreshing;
    if (cur != null) return cur;
    final f = _lan != null ? _refreshLan() : _refreshGateway();
    _refreshing = f;
    return f.whenComplete(() => _refreshing = null);
  }

  Future<void> _refreshGateway() async {
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
    final l = _lan;
    if (l != null) {
      final s = _state;
      final t = s is SignedIn ? s.session?.token : null;
      _lan = null;
      await lanAccounts.clear();
      if (t != null) await lan?.logout(server: l.server, token: t);
      _publish(SyncPhase.idle);
      _set(NeedLan(typed: _typedOf(l.server)));
      return;
    }
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

  // ── Row 127: the school's own LAN server ────────────────────────────────────────────────

  static String _typedOf(Uri u) =>
      u.port == LanServerRules.defaultPort && u.scheme == 'http'
      ? u.host
      : '${u.host}:${u.port}';

  SignedIn _lanSignedIn(SavedLan l, [LanSession? fresh]) => SignedIn(
    school: l.school,
    role: fresh?.role ?? l.role,
    uid: fresh?.uid ?? l.uid,
    session: fresh?.toSchoolSession(l.school),
    lanServer: l.server,
    schoolName: l.schoolName,
  );

  String _lanFail(LanAccessFailure e) {
    if (e.kind == LanAccessError.rateLimited) {
      _cooldownUntil = _now().add(e.retryAfter ?? const Duration(seconds: 60));
    }
    return e.messageFa;
  }

  String? _lanCooldown() {
    final until = _cooldownUntil;
    if (until == null) return null;
    final left = until.difference(_now());
    if (left <= Duration.zero) {
      _cooldownUntil = null;
      return null;
    }
    return LanAccessError.rateLimited.messageFa(left);
  }

  /// From step 1: "the school has its own server on this network".
  void useLan() {
    if (_busy || lan == null) return;
    _set(const NeedLan());
  }

  /// Back from the LAN form to the school-code (Gateway) login.
  void leaveLan() {
    if (_busy) return;
    _set(const NeedSchool());
  }

  /// Back to the address step of the LAN form.
  void changeLanServer() {
    final s = _state;
    if (_busy || s is! NeedLan) return;
    _set(NeedLan(typed: s.typed));
  }

  /// LAN step 1: the address must be a local-network address that answers as a Payesh school
  /// server (`/api/health` → `payesh-local`). Nothing else is sent.
  Future<void> submitLanServer(String typed) async {
    final api = lan;
    if (_busy || api == null) return;
    final server = LanServerRules.parse(typed);
    if (server == null) {
      return _set(
        NeedLan(error: LanAccessError.badAddress.messageFa(), typed: typed),
      );
    }
    _set(NeedLan(typed: typed), busy: true);
    try {
      final info = await api.probe(server);
      _lanShare = info.lanUrls;
      _set(NeedLan(info: info, typed: typed));
    } on LanAccessFailure catch (e) {
      _set(NeedLan(error: _lanFail(e), typed: typed));
    } on Object {
      _set(NeedLan(error: _unknown, typed: typed));
    }
  }

  /// LAN step 2: phone (or national id) + password → device token in the secure store.
  Future<void> submitLanLogin(String phone, String password) async {
    final s = _state;
    final api = lan;
    final info = s is NeedLan ? s.info : null;
    if (_busy || api == null || s is! NeedLan || info == null) return;
    final wait = _lanCooldown();
    if (wait != null) {
      return _set(NeedLan(info: info, typed: s.typed, error: wait));
    }
    if (LanServerRules.normalizeLogin(phone).length < 10 ||
        password.length < 4) {
      return _set(
        NeedLan(
          info: info,
          typed: s.typed,
          error: LanAccessError.badCredentials.messageFa(),
        ),
      );
    }
    _set(NeedLan(info: info, typed: s.typed), busy: true);
    try {
      final fresh = await api.login(
        server: info.server,
        phone: phone,
        password: password,
        deviceName: deviceName,
      );
      await _lanSignedInWith(info, fresh);
    } on LanAccessFailure catch (e) {
      _set(NeedLan(info: info, typed: s.typed, error: _lanFail(e)));
    } on Object {
      _set(NeedLan(info: info, typed: s.typed, error: _unknown));
    }
  }

  /// LAN first setup of a fresh server (only accepted on the server computer itself when the
  /// server runs as the headless data service).
  Future<void> submitLanSetup({
    required String schoolName,
    required String managerName,
    required String phone,
    required String password,
  }) async {
    final s = _state;
    final api = lan;
    final info = s is NeedLan ? s.info : null;
    if (_busy || api == null || s is! NeedLan || info == null) return;
    String? bad;
    if (managerName.trim().length < 3) {
      bad = 'نام مدیر دست‌کم ۳ نویسه است';
    } else if (LanServerRules.normalizeLogin(phone).length < 10) {
      bad = 'شمارهٔ همراه مدیر را کامل بنویسید';
    } else if (password.length < 4) {
      bad = 'رمز عبور دست‌کم ۴ نویسه است';
    }
    if (bad != null) {
      return _set(NeedLan(info: info, typed: s.typed, error: bad));
    }
    _set(NeedLan(info: info, typed: s.typed), busy: true);
    try {
      final fresh = await api.setup(
        server: info.server,
        schoolName: schoolName.trim(),
        managerName: managerName.trim(),
        phone: phone,
        password: password,
      );
      final named = LanServerInfo(
        server: info.server,
        setupDone: true,
        headless: info.headless,
        schoolName: schoolName.trim().isEmpty
            ? info.schoolName
            : schoolName.trim(),
        instance: info.instance,
        version: info.version,
        lanUrls: info.lanUrls,
      );
      await _lanSignedInWith(named, fresh);
    } on LanAccessFailure catch (e) {
      _set(NeedLan(info: info, typed: s.typed, error: _lanFail(e)));
    } on Object {
      _set(NeedLan(info: info, typed: s.typed, error: _unknown));
    }
  }

  /// Whether this device can be locked (LAN mode: unlocking needs the school server's
  /// `/api/auth/unlock`; the cloud Gateway has no such endpoint).
  bool get canLock => _lan != null && _state is SignedIn;

  /// Locks the app (web `lockApp`): the access token is dropped from memory, the device token
  /// stays saved, sync stops (the data path follows [SignedIn] only). The lock survives a restart.
  Future<void> lock() async {
    final l = _lan;
    if (l == null || _state is! SignedIn || _busy) return;
    await lanAccounts.setLocked(true);
    _set(Locked(school: l.school, schoolName: l.schoolName));
  }

  /// Opens the lock with the user's password (web form `unlock`). Wrong password / server
  /// unreachable keep the lock with a message; a revoked device goes back to the LAN login.
  Future<void> submitUnlock(String password) async {
    final s = _state;
    final l = _lan;
    final api = lan;
    if (_busy || s is! Locked || l == null || api == null) return;
    Locked again(String e) =>
        Locked(school: l.school, schoolName: l.schoolName, error: e);
    final wait = _lanCooldown();
    if (wait != null) return _set(again(wait));
    if (password.isEmpty) return _set(again('رمز عبور را وارد کنید'));
    _set(Locked(school: l.school, schoolName: l.schoolName), busy: true);
    try {
      final fresh = await api.unlock(
        server: l.server,
        deviceToken: l.deviceToken,
        password: password,
      );
      await lanAccounts.setLocked(false);
      _publish(SyncPhase.idle, ok: _now());
      _set(_lanSignedIn(l, fresh));
    } on LanAccessFailure catch (e) {
      if (e.kind == LanAccessError.deviceRevoked) {
        await lanAccounts.clear();
        _lan = null;
        _publish(SyncPhase.idle);
        return _set(NeedLan(error: e.messageFa, typed: _typedOf(l.server)));
      }
      _set(again(_lanFail(e)));
    } on Object {
      _set(again(_unknown));
    }
  }

  /// "رمز را فراموش کرده‌ام" on the server computer (loopback server only).
  void openClaim() {
    final s = _state;
    if (_busy || s is! NeedLan || s.info == null) return;
    if (!LanServerRules.isLoopbackHost(s.info!.server.host)) return;
    _set(NeedClaim(s.info!));
  }

  void closeClaim() {
    final s = _state;
    if (s is NeedClaim) {
      _set(NeedLan(info: s.info, typed: _typedOf(s.info.server)));
    }
  }

  /// Web form `claim`: 11-digit mobile + password (≥ 4) → the server sets them for the manager
  /// and signs this device in.
  Future<void> submitClaim(String phone, String password) async {
    final s = _state;
    final api = lan;
    if (_busy || s is! NeedClaim || api == null) return;
    final p = LanServerRules.normalizeLogin(phone);
    if (p.length != 11) {
      return _set(NeedClaim(s.info, error: 'شمارهٔ همراه باید ۱۱ رقم باشد'));
    }
    if (password.length < 4) {
      return _set(NeedClaim(s.info, error: 'رمز عبور حداقل ۴ نویسه باشد'));
    }
    _set(NeedClaim(s.info), busy: true);
    try {
      final fresh = await api.claim(
        server: s.info.server,
        phone: p,
        password: password,
      );
      await _lanSignedInWith(s.info, fresh);
    } on LanAccessFailure catch (e) {
      _set(
        NeedClaim(
          s.info,
          error: e.kind == LanAccessError.setupLocalOnly
              ? 'این کار فقط روی خود رایانهٔ سرور مدرسه ممکن است'
              : _lanFail(e),
        ),
      );
    } on Object {
      _set(NeedClaim(s.info, error: _unknown));
    }
  }

  Future<void> _lanSignedInWith(LanServerInfo info, LanSession fresh) async {
    final saved = SavedLan(
      server: info.server,
      school: info.schoolCode,
      deviceToken: fresh.deviceToken,
      schoolName: info.schoolName,
      role: fresh.role,
      uid: fresh.uid,
    );
    await lanAccounts.save(saved);
    await lanAccounts.setLocked(false);
    _lan = saved;
    _publish(SyncPhase.idle, ok: _now());
    _set(_lanSignedIn(saved, fresh));
  }

  /// Rotates the device token (the server answers with a new one each time; it is saved before
  /// anything else). Offline keeps the user signed in; a revoked/expired/reused device token
  /// signs out to the LAN form with a clear message.
  Future<void> _refreshLan() async {
    final l = _lan;
    final api = lan;
    if (l == null || api == null || _busy || _state is! SignedIn) return;
    if (_lanCooldown() != null) return;
    _busy = true;
    _publish(SyncPhase.syncing);
    try {
      final fresh = await api.refresh(
        server: l.server,
        deviceToken: l.deviceToken,
      );
      final next = l.withToken(
        fresh.deviceToken,
        role: fresh.role,
        uid: fresh.uid,
      );
      await lanAccounts.save(next);
      _lan = next;
      _publish(SyncPhase.idle, ok: _now());
      _set(_lanSignedIn(next, fresh));
    } on LanAccessFailure catch (e) {
      if (e.kind == LanAccessError.deviceRevoked) {
        await lanAccounts.clear();
        _lan = null;
        _publish(SyncPhase.idle);
        _set(NeedLan(error: e.messageFa, typed: _typedOf(l.server)));
        return;
      }
      _publish(SyncPhase.offline, error: _lanFail(e));
      _set(_lanSignedIn(l));
    } on Object {
      _publish(SyncPhase.offline, error: _unknown);
      _set(_lanSignedIn(l));
    }
  }

  @override
  void dispose() {
    sync.dispose();
    super.dispose();
  }
}
