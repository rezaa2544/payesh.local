import 'dart:io';

/// Throwaway test PKI made with openssl at runtime (nothing is committed): one CA and two
/// leaf certificates for 127.0.0.1 signed by it — `leaf` (pinned) and `rogue` (valid chain,
/// different key = what a MITM with a trusted/compromised CA would present).
final class TestPki {
  TestPki._(this.dir);
  final String dir;
  String get caPem => '$dir/ca.pem';
  String leafPem(String n) => '$dir/$n.pem';
  String leafKey(String n) => '$dir/$n.key';
  final Map<String, String> pins = {};

  static Future<void> _run(List<String> args) async {
    final r = await Process.run('openssl', args);
    if (r.exitCode != 0) {
      throw StateError('openssl ${args.first} failed: ${r.stderr}');
    }
  }

  static Future<TestPki> create() async {
    final d = Directory.systemTemp.createTempSync('payesh_pki_').path;
    final pki = TestPki._(d);
    const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'];
    await _run([
      'req', '-x509', ...ec, '-nodes', '-keyout', '$d/ca.key', '-out', //
      '$d/ca.pem', '-days', '2', '-subj', '/CN=payesh-test-ca',
    ]);
    File('$d/ext.cnf')
        .writeAsStringSync('subjectAltName=IP:127.0.0.1,DNS:localhost\n');
    for (final n in ['leaf', 'rogue', 'backup']) {
      await _run([
        'req', ...ec, '-nodes', '-keyout', '$d/$n.key', '-out', '$d/$n.csr', //
        '-subj', '/CN=localhost',
      ]);
      await _run([
        'x509', '-req', '-in', '$d/$n.csr', '-CA', '$d/ca.pem', '-CAkey', //
        '$d/ca.key', '-CAcreateserial', '-out', '$d/$n.pem', '-days', '2', //
        '-extfile', '$d/ext.cnf',
      ]);
      final sh = await Process.run('sh', [
        '-c',
        'openssl x509 -in "$d/$n.pem" -pubkey -noout | openssl pkey -pubin -outform der '
            '| openssl dgst -sha256 -binary | base64',
      ]);
      pki.pins[n] = '${sh.stdout}'.trim();
    }
    return pki;
  }

  SecurityContext serverContext(String leaf) => SecurityContext()
    ..useCertificateChain(leafPem(leaf))
    ..usePrivateKey(leafKey(leaf));

  /// Client trusts ONLY the test CA (so chain validation is real, not disabled).
  SecurityContext clientContext() =>
      SecurityContext(withTrustedRoots: false)..setTrustedCertificates(caPem);

  void dispose() => Directory(dir).deleteSync(recursive: true);
}
