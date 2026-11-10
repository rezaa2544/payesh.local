/// Contract constants mirrored from the server (docs/cloud/contracts/sync-v1.md, openapi.yaml).
///
/// The native client talks only to the existing API/Gateway; nothing here is a new protocol.
abstract final class PayeshApi {
  /// Version of the client↔server sync contract this client speaks.
  static const String syncContract = 'sync-v1';

  /// Header that carries the client API version on every request (row 75).
  static const String versionHeader = 'X-Payesh-Client';

  /// Header that carries a per-request correlation id (row 75).
  static const String requestIdHeader = 'X-Request-Id';

  /// Header the Gateway uses for cell routing.
  static const String deviceIdHeader = 'X-Device-Id';

  /// Server limits for POST /api/sync/push.
  static const int maxPushOps = 200;
  static const int maxIdempotencyKeyLength = 120;
  static const int maxPushBodyBytes = 8 * 1024 * 1024;
}
