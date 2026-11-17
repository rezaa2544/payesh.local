// Row 168 — TLS roots for Windows 7 / 8 / 8.1.
//
// Dart's TLS (BoringSSL) trusts exactly the certificates in the Windows "ROOT" store. Windows 7/8
// ship a small root store and normally fetch the remaining roots on demand while CryptoAPI builds
// a chain — Dart never triggers that, so on those Windows versions github.com (updates), the S3
// host and many tunnel hosts fail with CERTIFICATE_VERIFY_FAILED. On Windows older than 10 the
// Mozilla root set (mozilla_roots.dart) is added next to the system store. Nothing is switched off:
// chain + host-name validation stay as they are; Windows 10/11 and the other platforms are untouched.
import 'dart:convert';
import 'dart:io';

import 'mozilla_roots.dart';

/// True on Windows 7, 8 and 8.1 (NT 6.x).
bool get isLegacyWindows => _legacy ??=
    Platform.isWindows &&
    isLegacyWindowsVersion(Platform.operatingSystemVersion);
bool? _legacy;

/// Parses [Platform.operatingSystemVersion] on Windows, e.g.
/// `"Windows 7 Professional" 6.1 (Build 7601: Service Pack 1)` → true,
/// `"Windows 10 Pro" 10.0 (Build 19045)` → false.
bool isLegacyWindowsVersion(String osVersion) {
  final m = RegExp(r'(\d+)\.(\d+)\s*\(Build').firstMatch(osVersion);
  if (m == null) return false;
  return int.parse(m.group(1)!) < 10;
}

/// Adds the Mozilla roots to [context] on Windows 7/8/8.1 (no-op elsewhere unless [force]).
/// Returns how many were added (a root already in the store is skipped).
int addLegacyWindowsRoots(SecurityContext context, {bool force = false}) {
  if (!force && !isLegacyWindows) return 0;
  var added = 0;
  for (final pem in mozillaRootPems) {
    try {
      context.setTrustedCertificatesBytes(ascii.encode(pem));
      added++;
    } on TlsException {
      // already trusted
    }
  }
  return added;
}

bool _installed = false;

/// Once at start-up: the roots for every `HttpClient()` created without its own context
/// ([SecurityContext.defaultContext]). Contexts built by the app call [addLegacyWindowsRoots].
void installLegacyWindowsTrust() {
  if (_installed) return;
  _installed = true;
  addLegacyWindowsRoots(SecurityContext.defaultContext);
}
