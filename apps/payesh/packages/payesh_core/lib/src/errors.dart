/// Error codes the client must understand, taken from the server/Gateway responses.
enum PayeshErrorCode {
  /// 403 from the Gateway: request without a routable device/cell.
  missingCell('missing_cell'),

  /// 403 from the Gateway: device belongs to another cell.
  wrongCell('wrong_cell'),

  /// 409: tenant is write-frozen (migration/maintenance) — keep ops queued.
  writeFrozen('write_frozen'),

  /// 413: push body too large — split the batch.
  payloadTooLarge('body_too_large'),

  /// Local outbox reached its capacity; the new op is refused, nothing is dropped.
  queueFull('queue_full'),

  /// 401: session expired or invalid.
  unauthorized('unauthorized'),

  /// Anything else.
  unknown('unknown');

  const PayeshErrorCode(this.wire);
  final String wire;

  static PayeshErrorCode fromWire(String? s) => PayeshErrorCode.values
      .firstWhere((e) => e.wire == s, orElse: () => PayeshErrorCode.unknown);

  /// Whether ops affected by this error must stay in the outbox for a later retry.
  bool get keepQueued => switch (this) {
    PayeshErrorCode.writeFrozen ||
    PayeshErrorCode.payloadTooLarge ||
    PayeshErrorCode.unauthorized ||
    PayeshErrorCode.missingCell ||
    PayeshErrorCode.wrongCell ||
    PayeshErrorCode.unknown => true,
    PayeshErrorCode.queueFull => false,
  };
}
