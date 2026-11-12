import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';

import '../login/session_controller.dart';
import 'attendance_controller.dart';

/// Default data path of wave 2 (row 74): the encrypted local database of row 72 + the durable
/// SqliteOutbox + AutoSync → GatewayTransport (pinned client from the build's Gateway config)
/// to the saved school's cell. The Gateway is the only cloud path (row 75 / D‑36).
///
/// * Starts when a user is signed in ([attach]) and stops on sign-out.
/// * Before any pull/push the device data is claimed for school/uid ([DeviceOwner]): a user
///   switch wipes the old copy, or — with unsent writes of another user — blocks syncing.
/// * The outbox state is published into the session's badge (queued / offline / attention).
final class GatewayAttendanceSource implements AttendanceSource {
  GatewayAttendanceSource({
    required this.storage,
    required this.session,
    required this.client,
  });

  final Future<SqliteEngine> storage;
  final SessionController session;
  final HttpClient client;

  final ValueNotifier<int> _changed = ValueNotifier(0);
  SqliteEngine? _engine;
  SqliteOutbox? _outbox;
  AutoSync? _auto;
  StreamSubscription<SyncStatus>? _sub;
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

  void _follow() {
    final s = session.state;
    final uid = s is SignedIn ? s.currentUid : null;
    if (s is SignedIn && uid != null) {
      final owner = DeviceOwner.tag(s.school, uid);
      if (owner != _owner) {
        _starting = _start(owner);
      }
    } else if (_owner != null) {
      unawaited(_stop());
    }
  }

  Future<void> _stop() async {
    _owner = null;
    await _sub?.cancel();
    _sub = null;
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
    final transport = GatewayTransport(
      baseUri: cell,
      token: () => _token,
      deviceId: await session.accounts.deviceId(),
      client: client,
    );
    final pull = GatewaySync(engine: engine, transport: transport);
    final auto = AutoSync(
      outbox: outbox,
      push: (ops) async {
        await _auth();
        return transport.push(ops);
      },
      pull: () async {
        await _auth();
        final r = await pull.pull();
        if (r.rows > 0 || r.deleted > 0) _changed.value++;
      },
    );
    _sub = auto.status.listen(session.publishOutbox);
    _auto = auto;
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
  void queued() => _auto?.notifyEnqueued();

  /// Manual retry from the badge; the resulting outbox state is shown right away.
  Future<void> retry() async {
    final s = await _auto?.runOnce();
    if (s != null && _owner != null) session.publishOutbox(s);
  }

  /// Stops syncing and lets go of the session (before the session itself is disposed).
  Future<void> dispose() async {
    session.removeListener(_follow);
    await _starting;
    await _stop();
    _changed.dispose();
  }
}
