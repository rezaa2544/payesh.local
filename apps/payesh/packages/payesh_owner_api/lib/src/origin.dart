/// Server origin of the owner panel, normalised exactly like the retired WebView shells
/// (`OriginPolicy` in apps/owner-panel/desktop/PayeshOwner.cs and the Android
/// `OriginPolicy.java`): `https://host[:port]`, or `http://` only for loopback; no path,
/// query, fragment or user-info. Anything else → null (never a guessed address).
Uri? normalizeOrigin(String? raw) {
  if (raw == null) return null;
  var s = raw.trim();
  if (s.isEmpty || s.length > 269) return null;
  if (s.endsWith('/')) s = s.substring(0, s.length - 1);
  if (s.contains('?') || s.contains('#')) return null;
  final Uri u;
  try {
    u = Uri.parse(s);
  } on FormatException {
    return null;
  }
  if (!u.isAbsolute || u.host.isEmpty) return null;
  if (u.userInfo.isNotEmpty) return null;
  if (u.path.isNotEmpty && u.path != '/') return null;
  final scheme = u.scheme.toLowerCase();
  final host = u.host.toLowerCase();
  final loopback = host == 'localhost' || host == '127.0.0.1';
  if (scheme == 'https') {
    // ok
  } else if (scheme == 'http' && loopback) {
    // ok: local testing only (apps/owner-panel/scripts/local-up.js)
  } else {
    return null;
  }
  final defaultPort = scheme == 'https' ? 443 : 80;
  return Uri(
    scheme: scheme,
    host: host,
    port: u.hasPort && u.port != defaultPort ? u.port : null,
  );
}

/// Display form of an origin (`https://host[:port]`).
String originText(Uri origin) =>
    origin.toString().replaceAll(RegExp(r'/$'), '');
