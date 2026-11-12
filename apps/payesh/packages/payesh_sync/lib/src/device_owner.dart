// Row 74, wave 2 — whose data is on this device. Wave 2 is the first wave that stores school
// data natively (pulled rows + queued writes), so a device shared by two users, or a device that
// moves to another school, must never:
//   * push user A's queued writes with user B's token (the server would check B's scope and the
//     write would be attributed to B), or
//   * show user B the rows that were pulled under user A's scope.
import 'package:payesh_data/payesh_data.dart';

import 'gateway_transport.dart';
import 'outbox.dart';
import 'sync_client.dart' show ensureReviewTable;

enum DeviceClaim {
  /// Nothing was stored yet; the data now belongs to this user.
  fresh,

  /// Same school and user as last time.
  same,

  /// Another user/school was here with nothing left to send: the old local copy and the pull
  /// cursor were wiped, the next pull starts from zero under the new scope.
  switched,

  /// Another user/school still has unsent writes on this device: nothing is wiped, nothing is
  /// sent, the sync engine must not start. The previous user has to sign in again and sync.
  blockedByQueue,
}

extension DeviceClaimFa on DeviceClaim {
  String? get messageFa => this == DeviceClaim.blockedByQueue
      ? 'روی این دستگاه ثبت‌های ارسال‌نشدهٔ کاربر دیگری هست — آن کاربر باید یک بار وارد شود تا ارسال شوند'
      : null;
}

abstract final class DeviceOwner {
  static const String key = 'device.owner';

  /// Owner tag of a signed-in user: school slug + user id.
  static String tag(String school, int uid) => '$school/$uid';

  static String? read(SqliteEngine engine) {
    final rs = engine.database.select('SELECT value FROM meta WHERE key = ?', [
      key,
    ]);
    return rs.isEmpty ? null : '${rs.first['value']}';
  }

  static void _write(SqliteEngine engine, String owner) =>
      engine.database.execute(
        'INSERT INTO meta (key, value) VALUES (?, ?) '
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [key, owner],
      );

  /// Claims the device data for [owner] before any pull or push runs.
  static Future<DeviceClaim> claim(
    SqliteEngine engine,
    SqliteOutbox outbox,
    String owner,
  ) async {
    final prev = read(engine);
    if (prev == owner) return DeviceClaim.same;
    final db = engine.database;
    ensureReviewTable(db);
    // unsent writes AND edits still waiting for a human decision both belong to the old user
    final unsent =
        outbox.list().isNotEmpty ||
        db
            .select(
              "SELECT 1 FROM sync_review WHERE status = 'needs_review' LIMIT 1",
            )
            .isNotEmpty;
    if (prev == null && !unsent && await engine.count() == 0) {
      _write(engine, owner);
      return DeviceClaim.fresh;
    }
    if (unsent) return DeviceClaim.blockedByQueue;
    await engine.clear();
    db.execute('DELETE FROM sync_review');
    db.execute('DELETE FROM meta WHERE key = ?', [GatewaySync.cursorKey]);
    _write(engine, owner);
    return DeviceClaim.switched;
  }
}
