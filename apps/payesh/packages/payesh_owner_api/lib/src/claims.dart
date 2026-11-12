import 'dart:convert';

import 'caps.dart';

final RegExp platformTokenRe = RegExp(
  r'^platform\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$',
);
final RegExp uuidRe = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  caseSensitive: false,
);

/// Display-only view of a platform token (`platform.v1.<body>.<hmac>`). The signature is
/// verified by the server; this only decides which buttons to show and when to sign out.
final class OwnerClaims {
  const OwnerClaims({required this.sub, required this.role, required this.exp});
  final String sub;
  final OwnerRole role;

  /// Expiry in epoch milliseconds (same unit as the server's `exp`).
  final int exp;

  bool expiredAt(DateTime now) => exp <= now.millisecondsSinceEpoch;

  /// Mirrors `decodeClaims` in apps/owner-panel/web/app.js: shape, `typ`, `v`, UUID `sub`,
  /// known role and a future `exp` — otherwise null (fail closed).
  static OwnerClaims? decode(String? token, {DateTime? now}) {
    final t = token ?? '';
    if (!platformTokenRe.hasMatch(t)) return null;
    final Object? c;
    try {
      var b = t.split('.')[2].replaceAll('-', '+').replaceAll('_', '/');
      while (b.length % 4 != 0) {
        b += '=';
      }
      c = jsonDecode(utf8.decode(base64.decode(b)));
    } on FormatException {
      return null;
    }
    if (c is! Map<String, Object?>) return null;
    if (c['typ'] != 'platform' || c['v'] != 1) return null;
    final sub = c['sub'];
    if (sub is! String || !uuidRe.hasMatch(sub)) return null;
    final role = OwnerRole.fromWire(c['role']);
    if (role == null) return null;
    final exp = c['exp'];
    if (exp is! num) return null;
    final ms = (now ?? DateTime.now()).millisecondsSinceEpoch;
    if (exp <= ms) return null;
    return OwnerClaims(sub: sub, role: role, exp: exp.toInt());
  }
}
