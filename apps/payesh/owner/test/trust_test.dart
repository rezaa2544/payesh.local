import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/local/trust_bundle.dart';

/// اعتماد TLS برنامهٔ مالک: زنجیر رسمی Let's Encrypt همراه برنامه.

Future<bool> _handshake(SecurityContext ctx, String host, int port) async {
  try {
    final s = await SecureSocket.connect(
      host,
      port,
      context: ctx,
      timeout: const Duration(seconds: 15),
    );
    s.destroy();
    return true;
  } on HandshakeException {
    return false;
  } on TlsException {
    return false;
  }
}

Future<void> _openssl(List<String> args, String cwd) async {
  final r = await Process.run('openssl', args, workingDirectory: cwd);
  if (r.exitCode != 0) throw StateError('openssl ${args.first}: ${r.stderr}');
}

bool _hasOpenssl() {
  try {
    return Process.runSync('openssl', ['version']).exitCode == 0;
  } on ProcessException {
    return false;
  }
}

void main() {
  test('bundle: 21 official certificates, PEM shaped, no private keys', () {
    expect(letsEncryptChainPems, hasLength(21));
    for (final p in letsEncryptChainPems) {
      expect(p.trim(), startsWith('-----BEGIN CERTIFICATE-----'));
      expect(p.trim(), endsWith('-----END CERTIFICATE-----'));
      expect(p, isNot(contains('PRIVATE')));
    }
    // تکراری‌ها (مثلاً ریشه‌ای که از قبل در انبار هست) خطا نمی‌دهند
    expect(
      () => ownerTrustContext(
        withTrustedRoots: false,
        pems: [...letsEncryptChainPems, ...letsEncryptChainPems],
      ),
      returnsNormally,
    );
    expect(ownerTrustContext, returnsNormally);
  });

  test('server that omits the intermediate: fails with roots only, works once the bundle has it', () async {
    final dir = Directory.systemTemp.createTempSync('owner-tls-');
    addTearDown(() => dir.deleteSync(recursive: true));
    final d = dir.path;
    final ext = File('$d/ext.cnf')
      ..writeAsStringSync(
        '[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n'
        '[leaf]\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
        'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n',
      );
    Future<void> key(String n) => _openssl([
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      '$n.key',
      '-subj',
      '/CN=payesh-test-$n',
      '-out',
      '$n.csr',
    ], d);
    await key('root');
    await _openssl([
      'x509',
      '-req',
      '-in',
      'root.csr',
      '-signkey',
      'root.key',
      '-days',
      '2', //
      '-extfile', ext.path, '-extensions', 'ca', '-out', 'root.pem',
    ], d);
    await key('int');
    await _openssl([
      'x509',
      '-req',
      '-in',
      'int.csr',
      '-CA',
      'root.pem',
      '-CAkey',
      'root.key', //
      '-CAcreateserial',
      '-days',
      '2',
      '-extfile',
      ext.path,
      '-extensions',
      'ca',
      '-out', 'int.pem',
    ], d);
    await key('leaf');
    await _openssl([
      'x509',
      '-req',
      '-in',
      'leaf.csr',
      '-CA',
      'int.pem',
      '-CAkey',
      'int.key', //
      '-CAcreateserial',
      '-days',
      '2',
      '-extfile',
      ext.path,
      '-extensions',
      'leaf',
      '-out', 'leaf.pem',
    ], d);
    final serverCtx = SecurityContext()
      ..useCertificateChain('$d/leaf.pem') // فقط برگ، بدون میانی
      ..usePrivateKey('$d/leaf.key');
    final server = await SecureServerSocket.bind('127.0.0.1', 0, serverCtx);
    server.listen((s) => s.destroy(), onError: (_) {});
    addTearDown(server.close);
    final root = File('$d/root.pem').readAsStringSync();
    final inter = File('$d/int.pem').readAsStringSync();
    expect(
      await _handshake(
        ownerTrustContext(withTrustedRoots: false, pems: [root]),
        '127.0.0.1',
        server.port,
      ),
      isFalse,
      reason: 'negative control: missing intermediate must fail',
    );
    expect(
      await _handshake(
        ownerTrustContext(withTrustedRoots: false, pems: [root, inter]),
        '127.0.0.1',
        server.port,
      ),
      isTrue,
    );
    // Dart (BoringSSL با partial chain) میانیِ موجود در انبار را هم لنگر اعتماد می‌داند؛
    // برای همین هر میانیِ مجموعه پیش از افزودن با openssl تا ISRG Root X1/X2 بررسی شده است.
    expect(
      await _handshake(
        ownerTrustContext(withTrustedRoots: false, pems: [inter]),
        '127.0.0.1',
        server.port,
      ),
      isTrue,
    );
  }, skip: _hasOpenssl() ? false : 'openssl not installed');

  test(
    "real Let's Encrypt Gen Y test sites (YR/YE) with ONLY the bundle as trust",
    () async {
      for (final h in [
        'valid.yr.test-certs.letsencrypt.org',
        'valid.ye.test-certs.letsencrypt.org',
      ]) {
        expect(
          await _handshake(ownerTrustContext(withTrustedRoots: false), h, 443),
          isTrue,
          reason: h,
        );
        expect(
          await _handshake(SecurityContext(), h, 443),
          isFalse,
          reason: 'negative control: empty trust store must fail for $h',
        );
      }
    },
    skip: Platform.environment['PAYESH_NET_IT'] == '1'
        ? false
        : 'network test: set PAYESH_NET_IT=1',
  );
}
