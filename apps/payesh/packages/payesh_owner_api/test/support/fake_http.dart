import 'dart:convert';

import 'package:payesh_owner_api/payesh_owner_api.dart';

/// Recorded request.
final class Sent {
  Sent(this.method, this.url, this.headers, this.body);
  final String method;
  final Uri url;
  final Map<String, String> headers;
  final String? body;
  Map<String, Object?> get json => jsonDecode(body!) as Map<String, Object?>;
}

/// Scripted fake: [handler] answers each request; every request is recorded.
final class FakeOwnerHttp implements OwnerHttp {
  FakeOwnerHttp(this.handler);
  final OwnerHttpResponse Function(Sent) handler;
  final List<Sent> sent = [];
  bool closed = false;

  @override
  Future<OwnerHttpResponse> send(
    String method,
    Uri url,
    Map<String, String> headers,
    String? body,
  ) async {
    final s = Sent(method, url, Map.of(headers), body);
    sent.add(s);
    return handler(s);
  }

  @override
  void close() => closed = true;
}

OwnerHttpResponse jsonRes(int status, Object body) => OwnerHttpResponse(
  status,
  'application/json; charset=utf-8',
  jsonEncode(body),
);

/// A syntactically valid platform token (signature is the server's business).
String fakeToken({
  String sub = '11111111-2222-4333-8444-555555555555',
  String role = 'platform_owner',
  int? exp,
  String typ = 'platform',
  int v = 1,
}) {
  final body = base64Url
      .encode(
        utf8.encode(
          jsonEncode({
            'sub': sub,
            'role': role,
            'exp':
                exp ??
                DateTime.now()
                    .add(const Duration(hours: 1))
                    .millisecondsSinceEpoch,
            'typ': typ,
            'v': v,
          }),
        ),
      )
      .replaceAll('=', '');
  return 'platform.v1.$body.c2lnbmF0dXJl';
}
