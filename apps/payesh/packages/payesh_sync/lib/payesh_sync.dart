/// Offline outbox and Sync v1 client of the Payesh native app (row 71, ADR-43).
///
/// * [SqliteOutbox] — durable device queue with the exact semantics of `client/outbox-web.js`
///   (delete-after-ack, leases, idempotent `k`, explicit `queue_full`, exponential backoff).
/// * [SyncClient] — push (drain) and pull (composite cursor `since` + `since_id`) against the
///   existing server API (`POST /api/sync`, `GET /api/v1/pull`), applying rows to a
///   `DataEngine` from `payesh_data`.
library;

export 'src/accounts.dart';
export 'src/attendance.dart';
export 'src/device_owner.dart';
export 'src/auto_sync.dart';
export 'src/direct_transport.dart';
export 'src/family.dart';
export 'src/gateway_transport.dart';
export 'src/grades.dart';
export 'src/http_transport.dart';
export 'src/lan_access.dart';
export 'src/notices.dart';
export 'src/outbox.dart';
export 'src/pinning.dart';
export 'src/records.dart';
export 'src/school_access.dart';
export 'src/sync_client.dart';
export 'src/transport.dart';
export 'src/users.dart';
