import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:payesh_core/io.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';

import '../family/family_controller.dart';
import '../grades/grades_controller.dart';
import '../login/session_controller.dart';
import '../notices/notices_controller.dart';
import '../school/school_source.dart';
import 'attendance_controller.dart';

/// Default data path of wave 2 (row 74): the encrypted local database of row 72 + the durable
/// SqliteOutbox + AutoSync → GatewayTransport (pinned client from the build's Gateway config)
/// to the saved school's cell. The Gateway is the only cloud path (row 75 / D‑36).
///
/// * Starts when a user is signed in ([attach]) and stops on sign-out.
/// * Before any pull/push the device data is claimed for school/uid ([DeviceOwner]): a user
///   switch wipes the old copy, or — with unsent writes of another user — blocks syncing.
/// * The outbox state is published into the session's badge (queued / offline / attention).
///
/// Wave 3 (grades) uses the same database, outbox and AutoSync: one data path per device, so
/// grades and attendance share the queue, the owner claim and the badge. Wave 4 (notices) and
/// wave 5 (parents) join the same path.
final class GatewayAttendanceSource
    implements
        AttendanceSource,
        GradeSource,
        NoticeSource,
        FamilySource,
        SchoolSource {
  GatewayAttendanceSource({
    required this.storage,
    required this.session,
    this.client,
    HttpClient? lanClient,
  }) : lanClient = lanClient ?? trustedHttpClient();

  final Future<SqliteEngine> storage;
  final SessionController session;

  /// Pinned client for the cloud Gateway; null when the build has no Gateway config (the
  /// school's own LAN server still works).
  final HttpClient? client;

  /// Row 127: plain client for the school's own LAN server (address already checked by
  /// [LanServerRules]; no pinning — there is no public certificate on a school LAN).
  final HttpClient lanClient;

  final ValueNotifier<int> _changed = ValueNotifier(0);
  LanAccessClient? _lanAccess;

  @override
  AccountsApi? get accounts {
    final server = session.cellUrl;
    if (!session.onLan || server == null) return null;
    return LanAccounts(
      client: _lanAccess ??= LanAccessClient(
        client: lanClient,
        platform: Platform.operatingSystem,
      ),
      server: server,
      token: session.validToken,
    );
  }

  @override
  ServerAdminApi? get admin {
    final server = session.cellUrl;
    if (!session.onLan || server == null) return null;
    return LanServerAdmin(
      client: _lanAccess ??= LanAccessClient(
        client: lanClient,
        platform: Platform.operatingSystem,
      ),
      server: server,
      token: session.validToken,
    );
  }

  SqliteEngine? _engine;
  SqliteOutbox? _outbox;
  AutoSync? _auto;
  StreamSubscription<SyncStatus>? _sub;
  ChangeFeed? _feed;
  final List<StreamSubscription<Object?>> _feedSubs = [];
  bool _foreground = true;

  /// Row 177: the change feed of the school server (LAN mode), or null (Gateway / old server).
  @visibleForTesting
  ChangeFeed? get feed => _feed;
  String? _owner;
  String _token = '';
  Future<void>? _starting;

  @override
  Listenable get changed => _changed;

  /// Follows the session: signed in → start for that user; anything else → stop.
  void attach() {
    session.addListener(_follow);
    _follow();
  }

  /// Row 188: owner + server address the running data path was built for. The session can move
  /// to another address of the SAME server while signed in (row 165 relocation: LAN ⇄ public
  /// tunnel, e.g. when a VPN switches on). The transports keep the address they were built with,
  /// so the data path is rebuilt whenever the address changes — before row 188 it kept pulling
  /// the old, unreachable address forever (no request ever reached the server, the offline bar
  /// stayed until the app was killed).
  String? _key;
  Timer? _restartTimer;

  void _follow() {
    final s = session.state;
    final uid = s is SignedIn ? s.currentUid : null;
    if (s is SignedIn && uid != null) {
      final owner = DeviceOwner.tag(s.school, uid);
      final key = '$owner@${session.cellUrl}';
      if (owner != _owner || key != _key) {
        _key = key;
        _restartTimer?.cancel();
        _restartTimer = null;
        // one start at a time: two overlapping starts would leave a second AutoSync running
        final prev = _starting;
        _starting =
            (prev == null
                    ? Future<void>.value()
                    : prev.catchError((Object _) {}))
                .then((_) => _startSafe(owner, key));
      }
    } else if (_owner != null || _key != null) {
      _key = null;
      _restartTimer?.cancel();
      _restartTimer = null;
      unawaited(_stop());
    }
  }

  /// Row 188: a failed start (database not open yet, secure storage busy…) used to leave the
  /// device with no data path until the app was restarted. Now it is reported and retried.
  Future<void> _startSafe(String owner, String key) async {
    // signed out / moved again while the previous start was finishing — the newer call wins
    if (_key != key) return;
    try {
      await _start(owner);
    } on Object catch (e) {
      _owner = null;
      _key = null;
      session.publishOutbox(
        SyncStatus(
          phase: SyncPhase.offline,
          pending: 0,
          inflight: 0,
          blocked: 0,
          lastError: 'start: $e',
        ),
      );
      _restartTimer?.cancel();
      _restartTimer = Timer(restartDelay, () {
        _restartTimer = null;
        _follow();
      });
    }
  }

  /// Row 188: wait before a failed start is tried again.
  @visibleForTesting
  static Duration restartDelay = const Duration(seconds: 10);

  /// Row 188: a transport failure that means "this address does not answer" (nothing reached the
  /// server) — the session then looks for the same server at its other addresses.
  static bool unreachable(Object e) =>
      e is SyncFailure &&
      e.status == null &&
      (e.message == 'timeout' ||
          e.message.startsWith('network') ||
          e.message.startsWith('tls'));

  Future<T> _guard<T>(Future<T> Function() call) async {
    try {
      return await call();
    } on Object catch (e) {
      if (session.onLan && unreachable(e)) {
        unawaited(session.serverUnreachable());
      }
      rethrow;
    }
  }

  Future<void> _stop() async {
    _owner = null;
    await _sub?.cancel();
    _sub = null;
    // snapshot first: sign-out and dispose can both run _stop at once (row 178)
    final subs = List.of(_feedSubs);
    _feedSubs.clear();
    for (final s in subs) {
      await s.cancel();
    }
    final f = _feed;
    _feed = null;
    await f?.stop();
    final a = _auto;
    _auto = null;
    await a?.stop();
  }

  Future<void> _auth() async {
    final t = await session.validToken();
    if (t == null) throw const SyncFailure('offline');
    _token = t;
  }

  Future<void> _start(String owner) async {
    await _stop();
    _owner = owner;
    final cell = session.cellUrl;
    if (cell == null) return;
    final engine = _engine ??= await storage;
    final outbox = _outbox ??= SqliteOutbox(engine.database);
    final claim = await DeviceOwner.claim(engine, outbox, owner);
    if (claim == DeviceClaim.blockedByQueue) {
      final pending = outbox.list();
      session.publishOutbox(
        SyncStatus(
          phase: SyncPhase.attention,
          pending: 0,
          inflight: 0,
          blocked: pending.length,
          lastError: claim.messageFa,
        ),
      );
      _owner = null;
      return;
    }
    if (claim == DeviceClaim.switched) _changed.value++;
    final deviceId = await session.accounts.deviceId();
    final PushSender send;
    final Future<PullResult> Function() fetch;
    if (session.onLan) {
      // Row 127: the school's own server — Sync v1 (`/api/v1/pull`, `/api/sync`), same outbox.
      final transport = HttpSyncTransport(
        baseUri: cell,
        token: () => _token,
        deviceId: deviceId,
        client: lanClient,
      );
      final sync = SyncClient(
        engine: engine,
        outbox: outbox,
        transport: transport,
      );
      send = transport.push;
      fetch = sync.pull;
      // Row 177: event-driven — the server says when (and what) changed; no idle polling.
      _feed = ChangeFeed(baseUri: cell, token: () => _token, client: lanClient);
    } else {
      final pinned = client;
      if (pinned == null) {
        _owner = null;
        return;
      }
      final transport = GatewayTransport(
        baseUri: cell,
        token: () => _token,
        deviceId: deviceId,
        client: pinned,
      );
      final sync = GatewaySync(engine: engine, transport: transport);
      send = transport.push;
      fetch = sync.pull;
      // Row 178: the same instant notifications through the Gateway (SSE + LISTEN/NOTIFY).
      _feed = ChangeFeed(
        baseUri: cell,
        path: ChangeFeed.gatewayPath,
        deviceId: deviceId,
        token: () => _token,
        client: pinned,
      );
    }
    final auto = AutoSync(
      outbox: outbox,
      push: (ops) async {
        await _auth();
        return _guard(() => send(ops));
      },
      pull: () async {
        await _auth();
        // the feed opens only with a valid token (first cycle), never with an empty one
        if (_foreground) _feed?.start();
        final r = await _guard(fetch);
        if (r.rows > 0 || r.deleted > 0) _changed.value++;
      },
    );
    _sub = auto.status.listen(session.publishOutbox);
    _auto = auto;
    final feed = _feed;
    if (feed != null) {
      _feedSubs
        ..add(feed.liveChanges.listen((live) => auto.feedLive = live))
        ..add(
          feed.events.listen((e) {
            if (e.needsPull) auto.notifyRemoteChange();
          }),
        );
    }
    if (!_foreground) auto.pause();
    auto.start();
  }

  @override
  Future<AttendanceBook?> bookFor({
    required String role,
    required int uid,
  }) async {
    await _starting;
    final e = _engine, ob = _outbox;
    if (e == null || ob == null || _auto == null) return null;
    return AttendanceBook(engine: e, outbox: ob, role: role, uid: uid);
  }

  @override
  Future<GradeBook?> gradeBookFor({
    required String role,
    required int uid,
  }) async {
    await _starting;
    final e = _engine, ob = _outbox;
    if (e == null || ob == null || _auto == null) return null;
    return GradeBook(engine: e, outbox: ob, role: role, uid: uid);
  }

  @override
  Future<NoticeBoard?> noticeBoardFor({
    required String role,
    required int uid,
  }) async {
    await _starting;
    final e = _engine, ob = _outbox;
    if (e == null || ob == null || _auto == null) return null;
    return NoticeBoard(engine: e, outbox: ob, role: role, uid: uid);
  }

  @override
  Future<FamilyBook?> familyBookFor({
    required String role,
    required int uid,
  }) async {
    await _starting;
    final e = _engine, ob = _outbox;
    if (e == null || ob == null || _auto == null) return null;
    return FamilyBook(engine: e, outbox: ob, role: role, uid: uid);
  }

  /// Row 128: the school-management pages share the same database and outbox.
  @override
  Future<SchoolRecords?> recordsFor({
    required String role,
    required int uid,
  }) async {
    await _starting;
    final e = _engine, ob = _outbox;
    if (e == null || ob == null || _auto == null) return null;
    return SchoolRecords(engine: e, outbox: ob, role: role, uid: uid);
  }

  @override
  void queued() => _auto?.notifyEnqueued();

  /// Row 177: app visible (true) / hidden or minimised (false). Hidden ⇒ no timers, no feed
  /// connection, no requests; visible again ⇒ reconnect and catch up once.
  void setForeground(bool visible) {
    if (_foreground == visible) return;
    _foreground = visible;
    final a = _auto, f = _feed;
    if (visible) {
      a?.resume();
      f?.resume();
    } else {
      a?.pause();
      f?.pause();
    }
  }

  bool get foreground => _foreground;

  /// Manual retry from the badge; the resulting outbox state is shown right away.
  Future<void> retry() async {
    final s = await _auto?.runOnce();
    if (s != null && _owner != null) session.publishOutbox(s);
  }

  /// Stops syncing and lets go of the session (before the session itself is disposed).
  Future<void> dispose() async {
    session.removeListener(_follow);
    _restartTimer?.cancel();
    _restartTimer = null;
    await _starting;
    await _stop();
    _changed.dispose();
  }
}
