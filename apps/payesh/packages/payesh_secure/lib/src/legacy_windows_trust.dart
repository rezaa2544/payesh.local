// Row 168 — TLS roots for Windows 7 / 8 / 8.1 and Android 5.0 - 7.0.
//
// Dart's TLS (BoringSSL) trusts exactly the certificates in the system store. Windows 7/8
// ship a small root store and normally fetch the remaining roots on demand while CryptoAPI builds
// a chain — Dart never triggers that, so on those Windows versions github.com (updates), the S3
// host and many tunnel hosts fail with CERTIFICATE_VERIFY_FAILED. Android before 7.1 (API 25)
// has no ISRG Root X1 (Let's Encrypt) and other current roots. On those systems the Mozilla root
// set (mozilla_roots.dart) is added next to the system store. Nothing is switched off: chain +
// host-name validation stay as they are; Windows 10/11, Android 7.1+ and the other platforms are
// untouched.
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

/// True on Android older than 7.1 (API 25), whose CA store lacks ISRG Root X1 & co.
bool get isLegacyAndroid => _legacyAndroid ??=
    Platform.isAndroid && isLegacyAndroidSdk(_androidSdkInt());
bool? _legacyAndroid;

/// API levels 21-24 (Android 5.0-7.0) need the bundled roots; unknown (null) counts as old.
bool isLegacyAndroidSdk(int? sdk) => sdk == null || sdk < 25;

int? _androidSdkInt() {
  try {
    final r = Process.runSync('getprop', ['ro.build.version.sdk']);
    return int.tryParse('${r.stdout}'.trim());
  } on Object {
    return null;
  }
}

/// Windows 7/8/8.1 or Android 5.0-7.0: the system root store is not enough.
bool get needsBundledRoots => isLegacyWindows || isLegacyAndroid;

/// Adds the Mozilla roots to [context] on Windows 7/8/8.1 and Android 5.0-7.0 (no-op elsewhere
/// unless [force]). Returns how many were added (a root already in the store is skipped).
int addLegacyWindowsRoots(SecurityContext context, {bool force = false}) {
  if (!force && !needsBundledRoots) return 0;
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
