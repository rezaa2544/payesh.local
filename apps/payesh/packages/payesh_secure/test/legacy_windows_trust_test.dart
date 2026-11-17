// Row 168: Mozilla roots for Windows 7/8/8.1.
import 'dart:io';

import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_secure/src/mozilla_roots.dart';
import 'package:test/test.dart';

void main() {
  test(
    'Windows version detection (Platform.operatingSystemVersion formats)',
    () {
      expect(
        isLegacyWindowsVersion(
          '"Windows 7 Professional" 6.1 (Build 7601: Service Pack 1)',
        ),
        isTrue,
      );
      expect(
        isLegacyWindowsVersion('"Windows 8.1 Pro" 6.3 (Build 9600)'),
        isTrue,
      );
      expect(isLegacyWindowsVersion('"Windows 8" 6.2 (Build 9200)'), isTrue);
      expect(
        isLegacyWindowsVersion('"Windows 10 Pro" 10.0 (Build 19045)'),
        isFalse,
      );
      expect(
        isLegacyWindowsVersion('"Windows 11 Home" 10.0 (Build 26100)'),
        isFalse,
      );
      expect(isLegacyWindowsVersion('Linux 6.8.0-45-generic'), isFalse);
      expect(isLegacyWindowsVersion(''), isFalse);
    },
  );

  test('every bundled root parses and is added to an empty context', () {
    expect(mozillaRootPems.length, mozillaRootCount);
    expect(mozillaRootCount, greaterThan(100));
    final c = SecurityContext(withTrustedRoots: false);
    expect(addLegacyWindowsRoots(c, force: true), mozillaRootCount);
  });

  test('no-op where the system store is current (not Windows 7/8)', () {
    if (isLegacyWindows) return;
    expect(addLegacyWindowsRoots(SecurityContext(withTrustedRoots: false)), 0);
  });

  test('the bundle contains the roots our hosts chain to', () {
    final all = mozillaRootPems.join();
    // ISRG Root X1 (Let's Encrypt), USERTrust ECC (github.com via Sectigo), DigiCert Global Root G2
    for (final head in [
      'MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAw',
      'MIICjzCCAhWgAwIBAgIQXIuZxVqUxdJxVt7NiYDMJjAK',
      'MIIDjjCCAnagAwIBAgIQAzrx5qcRqaC7KGSxHQn65TAN',
    ]) {
      expect(all.contains(head), isTrue, reason: head);
    }
  });
}
