import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// One HTTP response as the owner client needs it.
final class OwnerHttpResponse {
  const OwnerHttpResponse(this.status, this.contentType, this.body);
  final int status;
  final String contentType;
  final String body;
}

/// The connection could not be made or the answer was cut off (no HTTP status).
final class OwnerNetworkException implements Exception {
  const OwnerNetworkException(this.message);
  final String message;
  @override
  String toString() => 'OwnerNetworkException: $message';
}

/// Minimal HTTP seam, so widget tests use a fake and the app uses [IoOwnerHttp].
abstract interface class OwnerHttp {
  Future<OwnerHttpResponse> send(
    String method,
    Uri url,
    Map<String, String> headers,
    String? body,
  );
  void close();
}

/// dart:io implementation: system TLS trust store, **no redirects** (same as the web
/// panel's `redirect: 'error'`), no cookies, bounded time and response size.
final class IoOwnerHttp implements OwnerHttp {
  IoOwnerHttp({
    HttpClient? client,
    this.timeout = const Duration(seconds: 20),
    this.maxBytes = 4 * 1024 * 1024,
  }) : _client = client ?? HttpClient() {
    _client.connectionTimeout = timeout;
    _client.userAgent = 'PayeshOwnerNative/1';
  }

  final HttpClient _client;
  final Duration timeout;
  final int maxBytes;

  @override
  Future<OwnerHttpResponse> send(
    String method,
    Uri url,
    Map<String, String> headers,
    String? body,
  ) async {
    try {
      final req = await _client.openUrl(method, url).timeout(timeout);
      req.followRedirects = false;
      req.persistentConnection = true;
      headers.forEach(req.headers.set);
      if (body != null) {
        final bytes = utf8.encode(body);
        req.contentLength = bytes.length;
        req.add(bytes);
      }
      final res = await req.close().timeout(timeout);
      final chunks = <int>[];
      await for (final c in res.timeout(timeout)) {
        chunks.addAll(c);
        if (chunks.length > maxBytes) {
          throw const OwnerNetworkException('response too large');
        }
      }
      final ct = res.headers.value(HttpHeaders.contentTypeHeader) ?? '';
      return OwnerHttpResponse(
        res.statusCode,
        ct,
        utf8.decode(chunks, allowMalformed: true),
      );
    } on OwnerNetworkException {
      rethrow;
    } on SocketException catch (e) {
      throw OwnerNetworkException(e.message);
    } on HandshakeException catch (e) {
      throw OwnerNetworkException('tls: ${e.message}');
    } on TlsException catch (e) {
      throw OwnerNetworkException('tls: ${e.message}');
    } on HttpException catch (e) {
      throw OwnerNetworkException(e.message);
    } on TimeoutException {
      throw const OwnerNetworkException('timeout');
    }
  }

  @override
  void close() => _client.close(force: true);
}
