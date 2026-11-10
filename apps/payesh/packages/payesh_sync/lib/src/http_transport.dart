import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:payesh_core/payesh_core.dart';

import 'outbox.dart';
import 'pinning.dart';
import 'transport.dart';

/// Sync v1 over HTTPS with `dart:io` — no WebView, no browser stack.
///
/// Every request carries `Authorization: Bearer`, the client version header, a fresh request id
/// and the device id (Gateway cell routing). HTTP errors are mapped to [SyncFailure] codes:
/// 401 → unauthorized, 403 missing_cell/wrong_cell, 409 write_frozen, 413 body_too_large,
/// 429/503 with Retry-After → retryAfterMs, anything else → unknown.
final class HttpSyncTransport implements SyncTransport {
  HttpSyncTransport({
    required this.baseUri,
    required this.token,
    required this.deviceId,
    this.clientVersion = 'payesh-native/0.1.0',
    HttpClient? client,
    this.timeout = const Duration(seconds: 30),
    String Function()? requestId,
  }) : _client = client ?? HttpClient(),
       _requestId = requestId ?? newIdempotencyKey;

  final Uri baseUri;
  final String Function() token;
  final String deviceId;
  final String clientVersion;
  final Duration timeout;
  final HttpClient _client;
  final String Function() _requestId;

  /// Request id of the last request (for logs / support).
  String? lastRequestId;

  @override
  Future<PullPage> pull({
    required String since,
    required int sinceId,
    List<String>? collections,
  }) async {
    final uri = baseUri
        .resolve('/api/v1/pull')
        .replace(
          queryParameters: {
            'since': since,
            'since_id': '$sinceId',
            if (collections != null && collections.isNotEmpty)
              'collections': collections.join(','),
          },
        );
    final j = await _send('GET', uri, null);
    return PullPage.fromJson(j);
  }

  @override
  Future<PushVerdicts> push(List<Map<String, Object?>> ops) async {
    final j = await _send('POST', baseUri.resolve('/api/sync'), {'ops': ops});
    return PushVerdicts.fromJson(j);
  }

  /// Sends one JSON request with the standard Payesh headers (shared with GatewayTransport).
  Future<Map<String, Object?>> send(String method, Uri uri, Object? body) =>
      _send(method, uri, body);

  Future<Map<String, Object?>> _send(
    String method,
    Uri uri,
    Object? body,
  ) async {
    final rid = _requestId();
    lastRequestId = rid;
    late HttpClientResponse res;
    late String text;
    try {
      final req = await _client.openUrl(method, uri).timeout(timeout);
      req.headers
        ..set(HttpHeaders.authorizationHeader, 'Bearer ${token()}')
        ..set(PayeshApi.versionHeader, clientVersion)
        ..set(PayeshApi.requestIdHeader, rid)
        ..set(PayeshApi.deviceIdHeader, deviceId)
        ..set(HttpHeaders.acceptHeader, 'application/json');
      if (body != null) {
        final bytes = utf8.encode(jsonEncode(body));
        req.headers.contentType = ContentType.json;
        req.contentLength = bytes.length;
        req.add(bytes);
      }
      res = await req.close().timeout(timeout);
      text = await utf8.decodeStream(res).timeout(timeout);
    } on TimeoutException {
      throw const SyncFailure('timeout');
    } on SocketException catch (e) {
      throw SyncFailure('network: ${e.message}');
    } on HttpException catch (e) {
      throw SyncFailure('network: ${e.message}');
    } on PinningException catch (e) {
      // TLS key of the server is not one of the pinned keys: nothing was sent.
      throw SyncFailure('certificate_pin_mismatch: ${e.host}');
    } on HandshakeException catch (e) {
      throw SyncFailure('tls: ${e.message}');
    }
    Map<String, Object?> j = const {};
    try {
      final d = jsonDecode(text);
      if (d is Map) j = d.cast<String, Object?>();
    } on FormatException {
      j = const {};
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return j;
    throw mapHttpError(res.statusCode, j, res.headers.value('retry-after'));
  }

  void close() => _client.close(force: true);
}

/// Maps an HTTP error response to a [SyncFailure] (exported for tests).
SyncFailure mapHttpError(
  int status,
  Map<String, Object?> body,
  String? retryAfter,
) {
  final err = body['error'] is String ? body['error']! as String : null;
  final code = switch (status) {
    401 => PayeshErrorCode.unauthorized,
    413 => PayeshErrorCode.payloadTooLarge,
    403 || 409 => PayeshErrorCode.fromWire(err),
    _ => PayeshErrorCode.fromWire(err),
  };
  int? retryMs;
  final ra = int.tryParse(retryAfter ?? '');
  if (ra != null) retryMs = ra * 1000;
  final bodyMs = body['retry_after_ms'];
  if (bodyMs is num) retryMs = bodyMs.toInt();
  return SyncFailure(
    err ?? 'http_$status',
    code: code,
    status: status,
    retryAfterMs: retryMs,
  );
}
