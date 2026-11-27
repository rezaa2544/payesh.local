import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart' show fieldsToFixFa;

import '../flags.dart';

String faCount(int n) => toPersianDigits('$n');

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
  const NeedLan({
    this.info,
    this.error,
    this.typed = '',
    this.login = '',
    this.otp,
    this.searching = false,
    this.notFound = false,
    this.vpn = false,
  });
  final LanServerInfo? info;
  final String? error;

  /// Row 163 — the app is looking for the school server (nothing is typed: the remembered
  /// server, this computer, then the address-only list in the owner's database).
  final bool searching;

  /// Row 163 — the search ended without an answer (the screen offers «تلاش دوباره»).
  final bool notFound;

  /// Row 186 — no server answered AND a VPN is up on this device. A VPN that carries every app
  /// (Lantern, v2ray, …) also carries the school server's LAN address, and a broken or
  /// filtered one refuses everything; the screen then says so and how to fix it.
  final bool vpn;

  /// Row 160 — an SMS code was sent: the code (and, for a reset, the new password) comes next.
  final LanOtpStep? otp;

  /// Row 145: user name to prefill (an approved registration request).
  final String login;

  /// Address typed in the first step (kept on errors).
  final String typed;

  /// A fresh server: the first setup (school + manager) comes next.
  bool get needsSetup => info != null && !info!.setupDone;
}

/// Row 160 — the mobile + SMS code step of the LAN login (or of «فراموشی رمز»).
final class LanOtpStep {
  const LanOtpStep({
    required this.phone,
    required this.purpose,
    required this.sentAt,
    this.ticket = const OtpTicket(),
  });
  final String phone;

  /// `login` | `reset`.
  final String purpose;
  final DateTime sentAt;
  final OtpTicket ticket;
  bool get reset => purpose == 'reset';
}

/// Row 145 — «درخواست ثبت نام مدرسه جدید» on this school server: the form, then (with a
/// saved [ticket]) the request's status (pending / approved / rejected).
final class NeedSignup extends SessionState {
  const NeedSignup(
    this.info, {
    this.error,
    this.ticket,
    this.status,
    this.fields = const {},
  });
  final LanServerInfo info;
  final String? error;

  /// Row 166: the field each problem belongs to (form key ⇒ message) — red outline on each.
  final Map<String, String> fields;
  final SignupTicket? ticket;
  final SignupStatus? status;
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

  /// Current role: the fresh session's, else the saved one — as the PERMISSION role
  /// (row 187: معاون = مدیر, `permRole`). The display role is [titleRole].
  String? get currentRole {
    final r = titleRole;
    return r == null ? null : permRole(r);
  }

  /// The role as saved on the user (e.g. `vice`) — for display only.
  String? get titleRole => session?.role ?? role;

  /// Current user id: the fresh session's, else the saved one.
  int? get currentUid => session?.uid ?? uid;

  String? get roleFa {
    final r = session?.role ?? role;
    return r == null ? null : (webRoleFa[r] ?? roleNameFa(r));
  }
}

/// Row 172: the web `ROLE_FA` (client/pages.js) — what the panel shows beside the user's name.
const webRoleFa = {
  'manager': 'مدیر',
  'vice': 'معاون',
  'deputy': 'معاون',
  'teacher': 'دبیر',
  'parent': 'ولی',
  'student': 'دانش‌آموز',
  'counselor': 'مشاور',
  'staff': 'کارمند',
  'office': 'اجرایی',
  'guard': 'نگهبان',
};

/// Drives school select → activation → signed in, plus refresh, sign-out and the old/new client
/// switch. Network failures never sign the user out; only a revoked device credential does.
class SessionController extends ChangeNotifier {
  SessionController({
    required this.api,
    required this.accounts,
    required ClientFlags flags,
    this.lan,
    this.directory,
    this.startLocalServer,
    this.schools,
    this.support,
    this.deviceId,
    this.openUrl,
    this.deviceName = 'پایش',
    this.vpnActive,
    this.retryDelays = const [],
    DateTime Function()? now,
  }) : _active = flags,
       _now = now ?? DateTime.now;

  /// Row 145: registration request + subscription on the school server; null = not offered.
  final LanSchoolsApi? schools;

  /// Row 152: messages and problem reports to the platform owner through the school server
  /// (school server → owner's database → owner panel); null = this build offers no LAN mode.
  final SupportApi? support;

  /// Support is offered to every signed-in LAN user — also while paywalled (payment problems).
  bool get supportAvailable =>
      support != null && _lan != null && _state is SignedIn;

  /// The school server and a fresh token for the support page; null when offline.
  Future<SupportLink?> supportLink() async {
    final api = support;
    final l = _lan;
    if (api == null || l == null) return null;
    final t = await validToken();
    if (t == null) return null;
    return (api: api, server: l.server, token: t);
  }

  /// Row 145: hardware/system id of this device (survives reinstall) for the one-trial rule.
  final Future<String?> Function()? deviceId;

  /// Row 145: opens the payment gateway in the system browser.
  final Future<bool> Function(String url)? openUrl;

  final SchoolAccessApi api;
  final SchoolAccountStore accounts;

  /// Row 127: login against the school's own LAN server; null = this build offers no LAN mode.
  final LanAccessApi? lan;

  /// Row 163 — the address-only list of school servers in the owner's database; null = not used.
  final SchoolDirectoryApi? directory;

  /// Row 163 — starts a school server installed on this very computer (Windows: the Payesh Data
  /// Service task, or the school system's own server); true when one was started.
  final Future<bool> Function()? startLocalServer;

  /// Row 186 — whether a VPN is up on this device (Android: a `tun`/`ppp`/`wg` interface); null =
  /// not checked. Only asked after no school server answered, to explain why.
  final Future<bool> Function()? vpnActive;

  /// Row 186 — when no school server answered, the search runs again by itself after these
  /// delays (the last one repeats) until one answers: a phone that joins the school Wi-Fi, a
  /// VPN switched off or a server that comes back is found without pressing «تلاش دوباره».
  /// Empty = no automatic retry (tests).
  final List<Duration> retryDelays;
  Timer? _retry;
  int _retryCount = 0;

  /// How long the app waits for a school server it just started on this computer.
  static const Duration localStartWait = Duration(seconds: 30);
  static const Duration localPollEvery = Duration(milliseconds: 1500);

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

  /// Row 145 — subscription of the signed-in LAN user (null = unknown / not checked yet; the
  /// school server still answers 402 to everything until a subscription or trial is active).
  SubStatus? get sub => _sub;
  SubStatus? _sub;
  bool get subBusy => _subBusy;
  bool _subBusy = false;
  String? get subError => _subError;
  String? _subError;
  String? get subNotice => _subNotice;
  String? _subNotice;

  /// Row 192 — the «اشتراک» page: every payment and every subscription (null until loaded).
  SubHistory? get subHistory => _subHistory;
  SubHistory? _subHistory;
  bool get subHistoryLoading => _subHistoryLoading;
  bool _subHistoryLoading = false;
  String? get subHistoryError => _subHistoryError;
  String? _subHistoryError;

  /// The role needs a subscription (or the school is inactive) — the app shows the paywall.
  /// Row 197-Q03: not for a role with a free core (parent): it keeps those pages.
  bool get paywalled {
    final s = _sub;
    return _state is SignedIn &&
        s != null &&
        s.managed &&
        !s.access &&
        (s.blockedSchool || s.freeCore.isEmpty);
  }

  /// Row 197-Q03 (F30/F22/F23): no subscription, but the role's free core is open — a parent
  /// keeps the grades, attendance, weekly schedule and leave requests of the children; the rest
  /// waits for a subscription or the trial (and opens at once when it starts).
  bool get limited {
    final s = _sub;
    return _state is SignedIn &&
        s != null &&
        s.managed &&
        !s.access &&
        !s.blockedSchool &&
        s.freeCore.isNotEmpty;
  }

  /// Whether this build/server offers the registration request.
  bool get signupAvailable => schools != null;
  SignupStore get signupStore => SignupStore(accounts.store);

  /// Cell (Gateway) of the saved school — the data path of wave 2 talks to it. In LAN mode
  /// (row 127) this is the school's own server.
  Uri? get cellUrl => _lan?.server ?? _saved?.cellUrl;

  /// Row 127: the data path talks Sync v1 (`/api/v1/pull`, `/api/sync`) to the LAN server.
  bool get onLan => _lan != null;

  /// Whether this build offers the LAN login.
  bool get lanAvailable => lan != null;

  /// Row 162 — this build has a Gateway (school code + activation code). Without one the
  /// school-code screen can never succeed, so it is not shown at all.
  bool get gatewayAvailable => api is! UnconfiguredSchoolAccess;

  /// Row 162 — the login of the school server is the first (and only) login screen.
  bool get lanFirst => lan != null && !gatewayAvailable;

  /// Row 162 — the owner's login order last seen on the remembered server (before it answered).
  bool get lastMobileFirst => _lastPrimary == 'mobile';
  String _lastPrimary = 'password';

  /// Loopback address of a school server running on this same computer.
  static final Uri _loopback = Uri.parse(
    'http://127.0.0.1:${LanServerRules.defaultPort}',
  );

  /// Row 162/163 — finds the school server with NOTHING typed and opens its login form: the
  /// remembered server and this computer first, then (if a school server is installed here but
  /// not running) starts it, then the address-only list in the owner's database. The login form
  /// is usable meanwhile; a press waits for the search.
  Future<void> _startLan({bool quiet = false}) {
    final f = _finding;
    if (f != null) return f;
    final run = _findLan(quiet: quiet).whenComplete(() => _finding = null);
    _finding = run;
    return run;
  }

  Future<void>? _finding;

  Future<void> _findLan({bool quiet = false}) async {
    final store = lanAccounts;
    final last = await store.lastServer();
    _lastPrimary = await store.lastPrimary();
    final api = lan;
    if (api == null) {
      _set(const NeedLan(notFound: true));
      return;
    }
    // row 186: an automatic retry keeps the red line (and what the user typed) on screen
    if (!quiet) {
      _set(NeedLan(searching: true, login: _keepLogin()), busy: _busy);
    }
    LanServerInfo? info = await firstAnswering(api, [
      ?last,
      if (last != _loopback) _loopback,
    ]);
    // row 171: an EMPTY server (never set up — e.g. the data service a fresh install of this app
    // brought along) is not this user's school. Look for the real one first (the address-only
    // list: central server, then every school server); the empty one stays as the last resort
    // (first setup of a brand-new school).
    LanServerInfo? spare;
    if (info != null && !info.setupDone) {
      spare = info;
      info = null;
    }
    if (info == null && spare == null && !quiet) {
      final start = startLocalServer;
      var started = false;
      if (start != null) {
        try {
          started = await start();
        } on Object {
          started = false;
        }
      }
      if (started) info = await _waitLocal(api);
    }
    if (info == null) {
      final dir = directory;
      if (dir != null) {
        try {
          final cands = await dir.candidates();
          info = await firstAnswering(api, [
            for (final u in cands)
              if (u != last && u != _loopback && u != spare?.server) u,
          ]);
          if (info != null && !info.setupDone) {
            spare ??= info;
            info = null;
          }
        } on Object {
          info = null;
        }
      }
    }
    info ??= spare;
    final now = _state;
    // the user went elsewhere meanwhile (signed in, signup, …) — never overwrite that
    if (now is! NeedLan || now.info != null) return;
    if (info == null) {
      final vpn = await _vpnUp();
      final again = _state;
      if (again is! NeedLan || again.info != null) return;
      _set(
        NeedLan(
          notFound: true,
          vpn: vpn,
          login: again.login,
          error: again.error,
        ),
        busy: _busy,
      );
      _scheduleRetry();
      return;
    }
    _retry?.cancel();
    _retryCount = 0;
    _lanShare = info.lanUrls;
    await store.remember(info);
    _lastPrimary = info.loginPrimary;
    _set(
      NeedLan(info: info, typed: _typedOf(info.server), login: now.login),
      busy: _busy,
    );
  }

  String _keepLogin() {
    final s = _state;
    return s is NeedLan ? s.login : '';
  }

  /// A school server just started on this computer: wait until it answers (or give up).
  Future<LanServerInfo?> _waitLocal(LanAccessApi api) async {
    final tries =
        localStartWait.inMilliseconds ~/ localPollEvery.inMilliseconds;
    for (var i = 0; i < tries; i++) {
      try {
        return await api.probe(_loopback);
      } on Object {
        await Future<void>.delayed(localPollEvery);
      }
    }
    return null;
  }

  /// Row 163 — what the login screen says when no school server answered.
  static const String lanNotFoundFa =
      'اتصال به دیتابیس برقرار نشد — سرور پایش در دسترس نیست یا این دستگاه به اینترنت وصل نیست. چند لحظه بعد «تلاش دوباره» را بزنید.';

  /// Row 186 — what the login screen says when no school server answered and a VPN is up.
  static const String lanVpnFa =
      'یک VPN روی این دستگاه روشن است و راه رسیدن به سرور پایش را بسته است. VPN را خاموش کنید — پایش به VPN نیاز ندارد. (اگر VPN بخش Split tunneling یا «عبور برنامه‌ها» دارد، «پایش» را در آن اضافه کنید و دوباره وصلش کنید.) برنامه خودش دوباره وصل می‌شود.';

  Future<bool> _vpnUp() async {
    final f = vpnActive;
    if (f == null) return false;
    try {
      return await f().timeout(const Duration(seconds: 3));
    } on Object {
      return false;
    }
  }

  /// Row 186 — the next automatic search (see [retryDelays]).
  void _scheduleRetry() {
    _retry?.cancel();
    final d = retryDelays;
    if (d.isEmpty) return;
    final wait = d[_retryCount < d.length ? _retryCount : d.length - 1];
    _retryCount++;
    _retry = Timer(wait, () {
      final s = _state;
      if (s is! NeedLan || s.info != null) return;
      if (_busy || _finding != null) {
        _scheduleRetry();
        return;
      }
      unawaited(_startLan(quiet: true));
    });
  }

  /// Row 163 — «تلاش دوباره»: searches for the school server again.
  Future<void> reconnect() {
    final s = _state;
    if (_busy || s is! NeedLan || s.info != null) return Future.value();
    _retry?.cancel();
    return _startLan();
  }

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
      if (saved == null) {
        // row 162: without a Gateway in this build the school-code screen is a dead end — the
        // first screen is the school server's own login (username/password or mobile + SMS code,
        // in the order the owner chose).
        if (lanFirst) return await _startLan();
        return _set(const NeedSchool());
      }
      _set(SignedIn(school: saved.school, role: saved.role, uid: saved.uid));
      await refresh();
    } on Object {
      const msg = 'حافظهٔ امن دستگاه باز نشد — برنامه را دوباره باز کنید';
      _set(lanFirst ? const NeedLan(error: msg) : const NeedSchool(error: msg));
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
      _sub = null;
      _subHistory = null;
      _subHistoryError = null;
      _autoTrialTried = false;
      await lanAccounts.clear();
      if (t != null) await lan?.logout(server: l.server, token: t);
      _publish(SyncPhase.idle);
      // row 162: straight back to the same server's login form (no address step)
      if (lanFirst) return _startLan();
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
    if (_busy || !gatewayAvailable) return;
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
      await lanAccounts.remember(info);
      _lastPrimary = info.loginPrimary;
      _set(NeedLan(info: info, typed: typed));
    } on LanAccessFailure catch (e) {
      _set(NeedLan(error: _lanFail(e), typed: typed));
    } on Object {
      _set(NeedLan(error: _unknown, typed: typed));
    }
  }

  /// Row 162/163 — the single login screen: if the school server is not reached yet, the press
  /// waits for the search (nothing to type), then goes straight on with the username/password
  /// login — one press. A fresh server shows its first setup instead.
  Future<void> connectAndLogin(String phone, String password) async {
    if (!await _connect(login: phone)) return;
    if (phone.trim().isEmpty && password.isEmpty) return;
    final s = _state;
    if (s is NeedLan && s.info != null && !s.needsSetup) {
      await submitLanLogin(phone, password);
    }
  }

  /// Row 162/163 — same, for «دریافت کد پیامکی» (login or «فراموشی رمز»).
  Future<void> connectAndRequestOtp(
    String mobile, {
    String purpose = 'login',
  }) async {
    if (!await _connect()) return;
    if (mobile.trim().isEmpty) return;
    final s = _state;
    if (s is NeedLan && s.info != null && !s.needsSetup) {
      await requestLanOtp(mobile, purpose: purpose);
    }
  }

  Future<bool> _connect({String login = ''}) async {
    var s = _state;
    if (_busy || lan == null || s is! NeedLan) return false;
    if (s.info != null) return true;
    if (login.isNotEmpty) {
      _set(NeedLan(searching: true, login: login, notFound: false), busy: true);
    } else {
      _set(NeedLan(searching: true, login: s.login), busy: true);
    }
    await (_finding ?? _startLan());
    s = _state;
    if (s is! NeedLan) return false;
    _set(
      NeedLan(
        info: s.info,
        typed: s.typed,
        login: login.isNotEmpty ? login : s.login,
        notFound: s.info == null,
        vpn: s.info == null && s.vpn,
        error: s.info == null ? lanNotFoundFa : null,
      ),
    );
    return s.info != null;
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
    // web `doLogin` (+ row 145 user names): nothing is sent until the login has a valid shape
    final shape =
        LanServerRules.loginProblem(phone) ??
        (password.isEmpty
            ? 'رمز عبور را وارد کنید'
            : password.length < 4
            ? LanAccessError.badCredentials.messageFa()
            : null);
    if (shape != null) {
      return _set(NeedLan(info: info, typed: s.typed, error: shape));
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
      if (await _loginElsewhere(info, phone, password, e)) return;
      _set(NeedLan(info: info, typed: s.typed, error: _lanFail(e)));
    } on Object {
      _set(NeedLan(info: info, typed: s.typed, error: _unknown));
    }
  }

  /// Row 171 — how many other school servers one login may try.
  static const int maxElsewhere = 8;

  /// Row 171 — the login reached A server, but not this user's: «مدرسه روی سرور دیگری است»
  /// (409, with the host's instance + addresses), or «نام کاربری یا رمز درست نیست» on a server
  /// this device never signed in on (another school's server answered first, or this computer's
  /// own empty server). The same username/password is tried — only on the owner's servers from
  /// the address-only list: the host named by the answer first, then the central server, then the
  /// other school servers. The first that accepts signs the user in and is remembered; a real
  /// answer about THIS user (inactive school, device limit, locked, …) is shown as is. False when
  /// nothing else accepted (the original error stays). Nothing is typed by the user.
  Future<bool> _loginElsewhere(
    LanServerInfo from,
    String phone,
    String password,
    LanAccessFailure first,
  ) async {
    final api = lan;
    if (api == null) return false;
    final moved = first.kind == LanAccessError.hostedElsewhere;
    if (!moved) {
      if (first.kind != LanAccessError.badCredentials) return false;
      // a wrong password on the server this device already signs in on is a wrong password
      final home = await lanAccounts.homeServer();
      if (home != null && home == from.server && from.setupDone) return false;
    }
    final tried = <Uri>{from.server};
    final queue = <Uri>[];
    final dir = directory;
    Future<void> hint(LanAccessFailure f) async {
      final front = <Uri>[...f.urls];
      final id = f.instance;
      if (id != null && dir != null) {
        try {
          front.addAll(await dir.addressesOf(id));
        } on Object {
          // the list is not reachable: the addresses in the answer only
        }
      }
      var at = 0;
      for (final u in front) {
        if (tried.contains(u)) continue;
        queue.remove(u);
        queue.insert(at++, u);
      }
    }

    await hint(first);
    if (dir != null) {
      try {
        for (final u in await dir.candidates()) {
          if (!tried.contains(u) && !queue.contains(u)) queue.add(u);
        }
      } on Object {
        // no list: only the hinted addresses
      }
    }
    if (from.server != _loopback && !queue.contains(_loopback)) {
      queue.add(_loopback);
    }
    var budget = maxElsewhere;
    while (queue.isNotEmpty && budget-- > 0) {
      final u = queue.removeAt(0);
      if (!tried.add(u)) continue;
      final LanServerInfo other;
      try {
        other = await api.probe(u).timeout(const Duration(seconds: 12));
      } on Object {
        continue;
      }
      // an empty server would make this user its manager — never by accident
      if (!other.setupDone || other.server == from.server) continue;
      try {
        final fresh = await api.login(
          server: other.server,
          phone: phone,
          password: password,
          deviceName: deviceName,
        );
        await lanAccounts.remember(other);
        _lanShare = other.lanUrls;
        _lastPrimary = other.loginPrimary;
        await _lanSignedInWith(other, fresh);
        return true;
      } on LanAccessFailure catch (f) {
        if (f.kind == LanAccessError.hostedElsewhere) {
          await hint(f);
          continue;
        }
        if (f.kind == LanAccessError.badCredentials ||
            f.kind == LanAccessError.unreachable ||
            f.kind == LanAccessError.unknown) {
          continue;
        }
        // this server knows the user: its answer is the real one
        await lanAccounts.remember(other);
        _set(
          NeedLan(
            info: other,
            typed: _typedOf(other.server),
            error: _lanFail(f),
          ),
        );
        return true;
      } on Object {
        continue;
      }
    }
    return false;
  }

  /// Row 160 — «ورود با شماره» / «فراموشی رمز»: sends a one-time SMS code to the mobile. While no
  /// SMS panel is linked the server answers `sms_disabled` and the screen says so; nothing else
  /// changes. An unknown number gets the same answer as a known one (no probing).
  Future<void> requestLanOtp(String phone, {String purpose = 'login'}) async {
    final s = _state;
    final api = lan;
    final info = s is NeedLan ? s.info : null;
    if (_busy || api == null || s is! NeedLan || info == null) return;
    final wait = _lanCooldown();
    if (wait != null) {
      return _set(NeedLan(info: info, typed: s.typed, error: wait, otp: s.otp));
    }
    if (!info.smsReady) {
      return _set(
        NeedLan(
          info: info,
          typed: s.typed,
          error: LanAccessError.smsDisabled.messageFa(),
        ),
      );
    }
    final bad = LanServerRules.mobileProblem(phone);
    if (bad != null) {
      return _set(NeedLan(info: info, typed: s.typed, error: bad, otp: s.otp));
    }
    final mobile = LanServerRules.digitsOnly(phone);
    _set(NeedLan(info: info, typed: s.typed, otp: s.otp), busy: true);
    try {
      final ticket = await api.requestOtp(
        server: info.server,
        phone: mobile,
        purpose: purpose == 'reset' ? 'reset' : 'login',
      );
      _set(
        NeedLan(
          info: info,
          typed: s.typed,
          otp: LanOtpStep(
            phone: mobile,
            purpose: purpose == 'reset' ? 'reset' : 'login',
            sentAt: _now(),
            ticket: ticket,
          ),
        ),
      );
    } on LanAccessFailure catch (e) {
      _set(NeedLan(info: info, typed: s.typed, error: _lanFail(e), otp: s.otp));
    } on Object {
      _set(NeedLan(info: info, typed: s.typed, error: _unknown, otp: s.otp));
    }
  }

  /// Row 160 — the SMS code signs this device in (a reset also sets [newPassword] first).
  Future<void> verifyLanOtp(String code, {String? newPassword}) async {
    final s = _state;
    final api = lan;
    final info = s is NeedLan ? s.info : null;
    final step = s is NeedLan ? s.otp : null;
    if (_busy || api == null || s is! NeedLan || info == null || step == null) {
      return;
    }
    final digits = LanServerRules.digitsOnly(code);
    String? bad;
    if (digits.length != step.ticket.length) {
      bad = 'کد پیامکی ${_faNum(step.ticket.length)} رقم است';
    } else if (step.reset && (newPassword ?? '').length < 4) {
      bad = 'رمز تازه حداقل ۴ نویسه باشد';
    }
    if (bad != null) {
      return _set(NeedLan(info: info, typed: s.typed, error: bad, otp: step));
    }
    _set(NeedLan(info: info, typed: s.typed, otp: step), busy: true);
    try {
      final fresh = await api.verifyOtp(
        server: info.server,
        phone: step.phone,
        code: digits,
        deviceName: deviceName,
        purpose: step.purpose,
        newPassword: step.reset ? newPassword : null,
      );
      await _lanSignedInWith(info, fresh);
    } on LanAccessFailure catch (e) {
      // an expired / locked code cannot be retried: back to the number step
      final keep = e.kind == LanAccessError.otpExpired ? null : step;
      _set(NeedLan(info: info, typed: s.typed, error: _lanFail(e), otp: keep));
    } on Object {
      _set(NeedLan(info: info, typed: s.typed, error: _unknown, otp: step));
    }
  }

  /// Row 160 — back from the code step to the number (or password) form.
  void cancelLanOtp() {
    final s = _state;
    if (_busy || s is! NeedLan) return;
    _set(NeedLan(info: s.info, typed: s.typed, login: s.login));
  }

  static String _faNum(int n) => '$n'.replaceAllMapped(
    RegExp('[0-9]'),
    (m) => '۰۱۲۳۴۵۶۷۸۹'[int.parse(m[0]!)],
  );

  /// LAN first setup of a fresh server (only accepted on the server computer itself when the
  /// server runs as the headless data service).
  Future<void> submitLanSetup({
    required String schoolName,
    required String managerName,
    required String phone,
    required String password,
    String? password2,
    String schoolType = 'کاردانش',
    String schoolYear = setupDefaultYear,
  }) async {
    final s = _state;
    final api = lan;
    final info = s is NeedLan ? s.info : null;
    if (_busy || api == null || s is! NeedLan || info == null) return;
    // web `doSetup`: mobile exactly 11 digits, password ≥ 4 and typed twice the same
    String? bad;
    if (managerName.trim().length < 3) {
      bad = 'نام مدیر دست‌کم ۳ نویسه است';
    } else if (LanServerRules.digitsOnly(phone).length != 11) {
      bad = LanServerRules.mobileRuleFa;
    } else if (password.length < 4) {
      bad = 'رمز عبور حداقل ۴ نویسه باشد';
    } else if (password2 != null && password2 != password) {
      bad = 'رمز عبور و تکرارش یکی نیست';
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
        schoolType: setupSchoolTypes.contains(schoolType)
            ? schoolType
            : setupSchoolTypes.first,
        schoolYear: schoolYear,
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
        loginPrimary: info.loginPrimary,
        smsReady: info.smsReady,
        otpLength: info.otpLength,
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
    // web `doClaim`: digits only (a Latin letter is not part of a mobile number)
    final p = LanServerRules.digitsOnly(phone);
    if (p.length != 11) {
      return _set(NeedClaim(s.info, error: LanServerRules.mobileRuleFa));
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
    await lanAccounts.setHome(info.server);
    _lan = saved;
    _publish(SyncPhase.idle, ok: _now());
    _set(_lanSignedIn(saved, fresh));
    await checkSub(token: fresh.token);
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
      await checkSub(token: fresh.token);
    } on LanAccessFailure catch (e) {
      if (e.kind == LanAccessError.deviceRevoked) {
        await lanAccounts.clear();
        _lan = null;
        _publish(SyncPhase.idle);
        _set(NeedLan(error: e.messageFa, typed: _typedOf(l.server)));
        return;
      }
      // Row 165: the phone left the school network (or the address changed) — find the SAME
      // server at its other addresses (public tunnel / LAN) and carry on there.
      final moved = e.kind == LanAccessError.unreachable
          ? await _relocateLan(l, api)
          : null;
      if (moved != null) {
        _busy = false;
        _lanRelocated = moved.server;
        await _refreshLan();
        return;
      }
      _publish(SyncPhase.offline, error: _lanFail(e));
      _set(_lanSignedIn(l));
    } on Object {
      _publish(SyncPhase.offline, error: _unknown);
      _set(_lanSignedIn(l));
    } finally {
      _busy = false;
    }
  }

  /// Row 188 — the data path (AutoSync pull/push) could not reach the current address of the
  /// school server. Before, only a token refresh (≈ once per session lifetime) looked for the
  /// server elsewhere, so a phone whose LAN address stopped answering (e.g. a VPN switched on)
  /// stayed offline for hours. Now the same row-165 search runs at once (throttled to once per
  /// 20 s); when the server answers at another address the session moves there and the data path
  /// is rebuilt on it. Returns whether the session moved.
  Future<bool> serverUnreachable() {
    final cur = _moving;
    if (cur != null) return cur;
    final f = _moveLan().whenComplete(() => _moving = null);
    _moving = f;
    return f;
  }

  Future<bool>? _moving;

  Future<bool> _moveLan() async {
    final l = _lan;
    final api = lan;
    if (l == null || api == null || _state is! SignedIn) return false;
    final SavedLan? moved;
    try {
      moved = await _relocateLan(l, api);
    } on Object {
      return false;
    }
    final s = _state;
    if (moved == null || s is! SignedIn || !identical(_lan, moved)) {
      return false;
    }
    _lanRelocated = moved.server;
    _set(
      SignedIn(
        school: s.school,
        role: s.role,
        uid: s.uid,
        session: s.session,
        lanServer: moved.server,
        schoolName: s.schoolName,
      ),
      busy: _busy,
    );
    return true;
  }

  /// Last address the session moved to (row 165; tests and the diagnostics read it).
  Uri? get lanRelocated => _lanRelocated;
  Uri? _lanRelocated;
  DateTime? _lastRelocate;

  /// Row 165 — other addresses of the signed-in server (same `instance`, from the address list in
  /// the owner's database): LAN first, then the public tunnel addresses. The first one that answers
  /// AS THE SAME SERVER (same school code) is saved and returned; null when none does. At most once
  /// every 20 s so an offline phone does not hammer the list.
  Future<SavedLan?> _relocateLan(SavedLan l, LanAccessApi api) async {
    final dir = directory;
    if (dir == null || !l.school.startsWith('lan-')) return null;
    final now = _now();
    final last = _lastRelocate;
    if (last != null && now.difference(last) < const Duration(seconds: 20)) {
      return null;
    }
    _lastRelocate = now;
    final List<Uri> cands;
    try {
      cands = [
        for (final u in await dir.addressesOf(l.school.substring(4)))
          if (u != l.server && LanServerRules.allowed(u)) u,
      ];
    } on Object {
      return null;
    }
    if (cands.isEmpty) return null;
    final info = await firstAnswering(api, cands);
    if (info == null || info.schoolCode != l.school) return null;
    final moved = SavedLan(
      server: info.server,
      school: l.school,
      deviceToken: l.deviceToken,
      schoolName: l.schoolName,
      role: l.role,
      uid: l.uid,
    );
    await lanAccounts.save(moved);
    await lanAccounts.remember(info);
    _lan = moved;
    return moved;
  }

  // ── Row 145: registration request ───────────────────────────────────────────────────

  /// From the LAN login: «درخواست ثبت نام مدرسه جدید» (status view when a request was sent from
  /// this device to this server).
  Future<void> openSignup() async {
    final s = _state;
    final info = s is NeedLan ? s.info : null;
    if (_busy || info == null || schools == null) return;
    SignupTicket? t;
    try {
      t = await signupStore.load();
    } on Object {
      t = null;
    }
    if (t != null && !t.belongsTo(info.server)) t = null;
    _set(NeedSignup(info, ticket: t));
    if (t != null) await checkSignup();
  }

  void closeSignup({String login = ''}) {
    final s = _state;
    if (s is! NeedSignup || _busy) return;
    _set(NeedLan(info: s.info, typed: _typedOf(s.info.server), login: login));
  }

  Future<void> submitSignup(SchoolSignup form) async {
    final s = _state;
    final api = schools;
    if (_busy || s is! NeedSignup || api == null) return;
    final bad = form.problems();
    if (bad.isNotEmpty) {
      return _set(
        NeedSignup(s.info, error: fieldsToFixFa(bad.length), fields: bad),
      );
    }
    _set(NeedSignup(s.info), busy: true);
    try {
      String? dh;
      try {
        dh = deviceHashOf(await deviceId?.call());
      } on Object {
        dh = null;
      }
      var at = s.info.server;
      ({String id, String token}) r;
      try {
        r = await api.register(at, form, deviceHash: dh);
      } on LanAccessFailure catch (e) {
        if (!signupNotStoredHere(e)) rethrow;
        final relay = await _registerElsewhere(api, at, form, dh);
        if (relay == null) rethrow;
        (at, r) = relay;
      }
      final t = SignupTicket(
        server: at,
        id: r.id,
        token: r.token,
        schoolName: form.schoolName.trim(),
        username: form.normalizedUsername,
        at: _now(),
        via: at == s.info.server ? null : s.info.server,
      );
      await signupStore.save(t);
      _set(
        NeedSignup(s.info, ticket: t, status: const SignupStatus('pending')),
      );
    } on LanAccessFailure catch (e) {
      final f = SchoolSignup.fieldOfFailure(e);
      _set(
        NeedSignup(
          s.info,
          error: schoolsErrorFa(e),
          fields: {?f: schoolsErrorFa(e)},
        ),
      );
    } on Object {
      _set(NeedSignup(s.info, error: _unknown));
    }
  }

  /// Row 170 — the server this device reached is not (yet) connected to the Payesh database, so
  /// the request would never reach the owner panel. Any other listed server that IS connected
  /// relays it (the request lands in the same registry); the ticket then follows that server.
  Future<(Uri, ({String id, String token}))?> _registerElsewhere(
    LanSchoolsApi api,
    Uri tried,
    SchoolSignup form,
    String? deviceHash,
  ) async {
    final dir = directory;
    if (dir == null) return null;
    List<Uri> list;
    try {
      list = await dir.candidates();
    } on Object {
      return null;
    }
    for (final u in list) {
      if (u.toString() == tried.toString()) continue;
      try {
        return (u, await api.register(u, form, deviceHash: deviceHash));
      } on LanAccessFailure catch (e) {
        // A taken username / bad field is final: the other server checked the same registry.
        if (signupVerdict(e)) rethrow;
      } on Object {
        continue;
      }
    }
    return null;
  }

  /// «بررسی وضعیت» of the saved request.
  Future<void> checkSignup() async {
    final s = _state;
    final api = schools;
    final t = s is NeedSignup ? s.ticket : null;
    if (s is! NeedSignup || api == null || t == null) return;
    _set(NeedSignup(s.info, ticket: t, status: s.status), busy: true);
    try {
      final st = await api.registrationStatus(t);
      _set(NeedSignup(s.info, ticket: t, status: st));
    } on LanAccessFailure catch (e) {
      _set(
        NeedSignup(
          s.info,
          ticket: t,
          status: s.status,
          error: schoolsErrorFa(e),
        ),
      );
    } on Object {
      _set(NeedSignup(s.info, ticket: t, status: s.status, error: _unknown));
    }
  }

  /// A new request instead of the saved one.
  Future<void> forgetSignup() async {
    final s = _state;
    if (s is! NeedSignup || _busy) return;
    await signupStore.clear();
    _set(NeedSignup(s.info));
  }

  // ── Row 145: subscription (p2) ──────────────────────────────────────────────────────

  void _subSet({
    SubStatus? sub,
    String? error,
    String? notice,
    bool busy = false,
  }) {
    if (sub != null) _sub = sub;
    _subError = error;
    _subNotice = notice;
    _subBusy = busy;
    notifyListeners();
  }

  /// Reads `/api/sub/status`. Offline keeps the last answer (the server enforces 402 anyway).
  Future<void> checkSub({String? token}) async {
    final api = schools;
    final l = _lan;
    if (api == null || l == null || _state is! SignedIn) return;
    token ??= await validToken();
    if (token == null) return;
    SubStatus? st;
    try {
      st = await api.subStatus(l.server, token);
      _subSet(sub: st);
    } on LanAccessFailure catch (e) {
      if (e.kind == LanAccessError.schoolInactive ||
          e.kind == LanAccessError.schoolRemoved) {
        _subSet(
          sub: SubStatus(
            managed: true,
            access: false,
            status: e.kind == LanAccessError.schoolInactive
                ? 'school_inactive'
                : 'school_removed',
          ),
        );
      }
      // otherwise keep what we had
    } on Object {
      // keep what we had
    }
    // Row 167: the owner turned the trial on ⇒ a user whose role needs a subscription and who
    // never had one gets the trial period straight away (no extra tap behind the paywall).
    // Once per session; the server still enforces once per user and once per device.
    if (st != null &&
        st.managed &&
        !st.access &&
        st.status == 'none' &&
        st.trialAvailable &&
        !_autoTrialTried) {
      _autoTrialTried = true;
      await startTrial(auto: true);
    }
    // Row 192: «بررسی دوباره» also refreshes an open payment report (approval/rejection).
    await _refreshHistory();
  }

  bool _autoTrialTried = false;

  /// Row 192: reads `/api/sub/history` (status + all payments + all subscriptions). Offline keeps
  /// the last report and says so; the status from the same answer refreshes [sub] too.
  Future<void> loadSubHistory() async {
    final api = schools;
    final l = _lan;
    if (api == null || l == null || _state is! SignedIn) return;
    if (_subHistoryLoading) return;
    _subHistoryLoading = true;
    _subHistoryError = null;
    notifyListeners();
    final token = await validToken();
    try {
      if (token == null) {
        _subHistoryError = LanAccessError.unreachable.messageFa();
        return;
      }
      final h = await api.subHistory(l.server, token);
      _subHistory = h;
      _sub = h.sub;
    } on LanAccessFailure catch (e) {
      _subHistoryError = schoolsErrorFa(e);
    } on Object {
      _subHistoryError = _unknown;
    } finally {
      _subHistoryLoading = false;
      notifyListeners();
    }
  }

  /// After a trial/receipt the open report shows the new row at once.
  Future<void> _refreshHistory() async {
    if (_subHistory != null || _subHistoryError != null) await loadSubHistory();
  }

  /// «شروع دورهٔ آزمایشی» — once per device (hashed system id), even after reinstall.
  /// `auto`: started by [checkSub] — a failure stays quiet (the paywall still shows the button).
  Future<void> startTrial({bool auto = false}) async {
    final api = schools;
    final l = _lan;
    if (api == null || l == null || _subBusy) return;
    _subSet(busy: true);
    String? dh;
    try {
      dh = deviceHashOf(await deviceId?.call());
    } on Object {
      dh = null;
    }
    if (dh == null) {
      if (auto) return _subSet();
      return _subSet(
        error: 'شناسهٔ این دستگاه خوانده نشد — دورهٔ آزمایشی روی این دستگاه ممکن نیست؛ لطفاً اشتراک تهیه کنید',
      );
    }
    final token = await validToken();
    if (token == null) {
      if (auto) return _subSet();
      return _subSet(error: LanAccessError.unreachable.messageFa());
    }
    try {
      final st = await api.startTrial(l.server, token, dh);
      _subSet(
        sub: st,
        notice: 'دورهٔ آزمایشی ${faCount(st.daysLeft)} روزه فعال شد',
      );
      await _refreshHistory();
    } on LanAccessFailure catch (e) {
      _subSet(error: auto ? null : schoolsErrorFa(e));
    } on Object {
      _subSet(error: auto ? null : _unknown);
    }
  }

  /// Pay through the owner's gateway: the server builds the gateway link; the browser opens it;
  /// the gateway returns to the school server (`/api/sub/callback`), which verifies it.
  Future<String?> payWithGateway(String plan) async {
    final api = schools;
    final l = _lan;
    if (api == null || l == null || _subBusy) return null;
    _subSet(busy: true);
    final token = await validToken();
    if (token == null) {
      _subSet(error: LanAccessError.unreachable.messageFa());
      return null;
    }
    try {
      final r = await api.startPayment(l.server, token, plan);
      final opened = await (openUrl?.call(r.payUrl) ?? Future.value(false));
      _subSet(
        notice: opened
            ? 'صفحهٔ پرداخت باز شد (کد پیگیری ${r.paymentId}). پس از پرداخت، «بررسی دوباره» را بزنید.'
            : 'پیوند پرداخت آماده است (کد پیگیری ${r.paymentId}) — آن را در مرورگر باز کنید.',
      );
      unawaited(_refreshHistory());
      return r.payUrl;
    } on LanAccessFailure catch (e) {
      _subSet(error: schoolsErrorFa(e));
    } on Object {
      _subSet(error: _unknown);
    }
    return null;
  }

  /// «ثبت رسید» (card-to-card etc.) — pending until the owner approves it.
  Future<bool> submitReceipt(String plan, String ref) async {
    final api = schools;
    final l = _lan;
    if (api == null || l == null || _subBusy) return false;
    final r = ref.trim();
    if (r.length < 4 || r.length > 40) {
      _subSet(error: 'شمارهٔ پیگیری/رسید را درست بنویسید (۴ تا ۴۰ نویسه)');
      return false;
    }
    _subSet(busy: true);
    final token = await validToken();
    if (token == null) {
      _subSet(error: LanAccessError.unreachable.messageFa());
      return false;
    }
    try {
      final p = await api.submitReceipt(l.server, token, plan, r);
      _subSet(
        notice:
            'رسید ثبت شد (کد پیگیری ${p.id}) — پس از تأیید پشتیبانی پایش، اشتراک فعال می‌شود.',
      );
      await checkSub();
      return true;
    } on LanAccessFailure catch (e) {
      _subSet(error: schoolsErrorFa(e));
    } on Object {
      _subSet(error: _unknown);
    }
    return false;
  }

  @override
  void dispose() {
    _retry?.cancel();
    sync.dispose();
    super.dispose();
  }
}
