// Row 107 (ADR-105 §3.2, Proposed) — device-side end-to-end encryption "e2e1",
// Dart port of the JavaScript reference tools/e2e1.js. Both must reproduce
// docs/cloud/contracts/e2e1-vectors-107.json byte for byte.
//
// X25519 (RFC 7748) · HKDF-SHA256 (RFC 5869) · AES-256-GCM, all from
// package:cryptography (pure Dart, no platform plugin). Format, key hierarchy
// and AAD rules are documented in tools/e2e1.js and
// docs/cloud/107-e2e-encryption.md.

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

/// Every failure of the library: one code, no oracle detail.
final class E2EError implements Exception {
  E2EError(this.code, [this.detail = '']);

  /// e2e_open_failed | e2e_no_key | e2e_bad_format | e2e_bad_key | e2e_bad_scope |
  /// e2e_bad_record | e2e_no_recipient | e2e_no_scope_key
  final String code;
  final String detail;

  @override
  String toString() => detail.isEmpty ? code : '$code: $detail';
}

/// A recipient of an envelope: key id and X25519 public key.
final class Recipient {
  const Recipient(this.kid, this.pub);
  final String kid;
  final Uint8List pub;
}

/// One derived scope key generation.
final class ScopeKey implements Recipient {
  const ScopeKey(
    this.kid,
    this.scope,
    this.smkGen,
    this.gen,
    this.priv,
    this.pub,
  );
  @override
  final String kid;
  final String scope;
  final int smkGen;
  final int gen;
  final Uint8List priv;
  @override
  final Uint8List pub;
}

/// Fixed randomness, ONLY for test vectors.
final class Fixed {
  const Fixed({
    required this.eph,
    required this.dek,
    required this.iv,
    required this.wrapIvs,
  });
  final Uint8List eph;
  final Uint8List dek;
  final Uint8List iv;
  final List<Uint8List> wrapIvs;
}

/// Routing metadata of a record (the clear part of a row).
final class RecordMeta {
  const RecordMeta({
    required this.tenantId,
    required this.collection,
    required this.recordId,
    required this.version,
    this.classId,
    this.studentId,
  });
  final String tenantId;
  final String collection;
  final int recordId;
  final int version;
  final int? classId;
  final int? studentId;
}

const String e2eVersion = 'e2e1';
final RegExp _scopeRe = RegExp(
  r'^(smk|school:[a-z_]{1,40}|class:[0-9]{1,18}:[a-z_]{1,40}|student:[0-9]{1,18}:[a-z_]{1,40})$',
);
final RegExp _kidRe = RegExp(
  r'^(smk|school:[a-z_]{1,40}|class:[0-9]{1,18}:[a-z_]{1,40}|student:[0-9]{1,18}:[a-z_]{1,40})@[0-9]{1,9}\+[0-9]{1,9}$|^device$',
);
final RegExp _b64uRe = RegExp(r'^[A-Za-z0-9_-]*$');
final Uint8List _salt = Uint8List.fromList(utf8.encode('payesh/e2e1'));

final X25519 _x25519 = X25519();
final Hkdf _hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);
final AesGcm _gcm = AesGcm.with256bits();

/// base64url without padding.
String b64u(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');

/// Strict base64url decode (canonical form only), optionally of an exact length.
Uint8List unb64u(String s, [int? length]) {
  if (!_b64uRe.hasMatch(s) || s.length % 4 == 1) {
    throw E2EError('e2e_bad_format', 'base64url');
  }
  final Uint8List b;
  try {
    b = base64Url.decode(s.padRight((s.length + 3) ~/ 4 * 4, '='));
  } on FormatException {
    throw E2EError('e2e_bad_format', 'base64url');
  }
  if (b64u(b) != s) throw E2EError('e2e_bad_format', 'non-canonical base64url');
  if (length != null && b.length != length) {
    throw E2EError('e2e_bad_format', 'expected $length bytes');
  }
  return b;
}

Uint8List _cat(List<int> a, List<int> b) => Uint8List.fromList([...a, ...b]);

void _len32(Uint8List k, String what) {
  if (k.length != 32) throw E2EError('e2e_bad_key', '$what must be 32 bytes');
}

/// X25519 public key of a 32-byte private key.
Future<Uint8List> publicFromPrivate(Uint8List priv) async {
  _len32(priv, 'private key');
  final kp = await _x25519.newKeyPairFromSeed(priv);
  return Uint8List.fromList((await kp.extractPublicKey()).bytes);
}

/// X25519 shared secret; a low-order public key (all-zero secret) is refused.
Future<Uint8List> x25519(Uint8List priv, Uint8List pub) async {
  _len32(priv, 'private key');
  _len32(pub, 'public key');
  final kp = await _x25519.newKeyPairFromSeed(priv);
  final s = await _x25519.sharedSecretKey(
    keyPair: kp,
    remotePublicKey: SimplePublicKey(pub, type: KeyPairType.x25519),
  );
  final ss = Uint8List.fromList(await s.extractBytes());
  if (ss.every((b) => b == 0)) {
    throw E2EError('e2e_bad_key', 'low-order public key');
  }
  return ss;
}

/// HKDF-SHA256 with a 32-byte output.
Future<Uint8List> hkdf(List<int> ikm, List<int> salt, String info) async {
  final k = await _hkdf.deriveKey(
    secretKey: SecretKey(ikm),
    nonce: salt,
    info: utf8.encode(info),
  );
  return Uint8List.fromList(await k.extractBytes());
}

Future<Uint8List> _gcmSeal(
  List<int> key,
  List<int> iv,
  List<int> pt,
  String aad,
) async {
  final box = await _gcm.encrypt(
    pt,
    secretKey: SecretKey(key),
    nonce: iv,
    aad: utf8.encode(aad),
  );
  return _cat(box.cipherText, box.mac.bytes);
}

Future<Uint8List> _gcmOpen(
  List<int> key,
  List<int> iv,
  Uint8List ct,
  String aad,
) async {
  if (ct.length < 16) throw E2EError('e2e_open_failed');
  try {
    final box = SecretBox(
      ct.sublist(0, ct.length - 16),
      nonce: iv,
      mac: Mac(ct.sublist(ct.length - 16)),
    );
    return Uint8List.fromList(
      await _gcm.decrypt(box, secretKey: SecretKey(key), aad: utf8.encode(aad)),
    );
  } on SecretBoxAuthenticationError {
    throw E2EError('e2e_open_failed');
  }
}

/// Scope name: `smk | school:<c> | class:<id>:<c> | student:<id>:<c>`.
String scopeName(String kind, [String? collection, int? id]) {
  final String s;
  switch (kind) {
    case 'smk':
      s = 'smk';
    case 'school':
      s = 'school:$collection';
    case 'class' || 'student':
      s = '$kind:$id:$collection';
    default:
      throw E2EError('e2e_bad_scope', kind);
  }
  if (!_scopeRe.hasMatch(s)) throw E2EError('e2e_bad_scope', s);
  return s;
}

/// Key id `<scope>@<smk_gen>+<gen>`.
String kidOf(String scope, int smkGen, int gen) {
  final k = '$scope@$smkGen+$gen';
  if (!_kidRe.hasMatch(k) || smkGen < 1 || gen < 0) {
    throw E2EError('e2e_bad_scope', k);
  }
  return k;
}

/// Splits a key id; "device" is not a scope kid.
({String scope, int smkGen, int gen}) parseKid(String kid) {
  if (!_kidRe.hasMatch(kid) || kid == 'device') {
    throw E2EError('e2e_bad_scope', kid);
  }
  final at = kid.lastIndexOf('@');
  final plus = kid.lastIndexOf('+');
  return (
    scope: kid.substring(0, at),
    smkGen: int.parse(kid.substring(at + 1, plus)),
    gen: int.parse(kid.substring(plus + 1)),
  );
}

/// The X25519 key pair of one scope generation, derived from the school master key.
Future<ScopeKey> deriveScopeKey(
  Uint8List smk,
  String tenant,
  String scope,
  int smkGen,
  int gen,
) async {
  _len32(smk, 'SMK');
  final kid = kidOf(scope, smkGen, gen);
  final priv = await hkdf(
    smk,
    _salt,
    'payesh/e2e1/scope|$tenant|$scope|$smkGen|$gen',
  );
  return ScopeKey(kid, scope, smkGen, gen, priv, await publicFromPrivate(priv));
}

final Random _rnd = Random.secure();
Uint8List _random(int n) =>
    Uint8List.fromList(List<int>.generate(n, (_) => _rnd.nextInt(256)));

/// Seals [plaintext] to every recipient; [aad] is bound into the body and every wrap.
Future<String> seal(
  List<Recipient> recipients,
  List<int> plaintext,
  String aad, {
  Fixed? fixed,
}) async {
  if (recipients.isEmpty) throw E2EError('e2e_no_recipient');
  final ephPriv = fixed?.eph ?? _random(32);
  final ephPub = await publicFromPrivate(ephPriv);
  final dek = fixed?.dek ?? _random(32);
  final iv = fixed?.iv ?? _random(12);
  final body = await _gcmSeal(dek, iv, plaintext, aad);
  final seen = <String>{};
  final wraps = <String>[];
  for (var i = 0; i < recipients.length; i++) {
    final r = recipients[i];
    if (!_kidRe.hasMatch(r.kid) || !seen.add(r.kid)) {
      throw E2EError('e2e_bad_scope', 'recipient ${r.kid}');
    }
    final kek = await hkdf(
      await x25519(ephPriv, r.pub),
      _cat(ephPub, r.pub),
      'payesh/e2e1/wrap|${r.kid}|$aad',
    );
    final wiv = (fixed != null && i < fixed.wrapIvs.length)
        ? fixed.wrapIvs[i]
        : _random(12);
    wraps.add(
      '${r.kid}!${b64u(wiv)}!${b64u(await _gcmSeal(kek, wiv, dek, r.kid))}',
    );
  }
  return '$e2eVersion.${b64u(ephPub)}.${b64u(iv)}.${b64u(body)}.${wraps.join('~')}';
}

typedef _Wrap = ({String kid, Uint8List iv, Uint8List ct});
typedef _Envelope = ({
  Uint8List ephPub,
  Uint8List iv,
  Uint8List body,
  List<_Wrap> wraps,
});

_Envelope _parse(String text) {
  if (text.length > 1048576) throw E2EError('e2e_bad_format');
  final p = text.split('.');
  if (p.length != 5 || p[0] != e2eVersion) {
    throw E2EError('e2e_bad_format', 'header');
  }
  final wraps = p[4].split('~').map((w) {
    final q = w.split('!');
    if (q.length != 3 || !_kidRe.hasMatch(q[0])) {
      throw E2EError('e2e_bad_format', 'wrap');
    }
    return (kid: q[0], iv: unb64u(q[1], 12), ct: unb64u(q[2], 48));
  }).toList();
  return (
    ephPub: unb64u(p[1], 32),
    iv: unb64u(p[2], 12),
    body: unb64u(p[3]),
    wraps: wraps,
  );
}

/// Kids an envelope can be opened with (routing only).
List<String> recipientsOf(String text) =>
    _parse(text).wraps.map((w) => w.kid).toList();

/// Opens an envelope with the first matching key of [keys] (kid → private key).
Future<Uint8List> open(
  String text,
  Map<String, Uint8List> keys,
  String aad,
) async {
  final e = _parse(text);
  for (final w in e.wraps) {
    final priv = keys[w.kid];
    if (priv == null) continue;
    final pub = await publicFromPrivate(priv);
    final kek = await hkdf(
      await x25519(priv, e.ephPub),
      _cat(e.ephPub, pub),
      'payesh/e2e1/wrap|${w.kid}|$aad',
    );
    final dek = await _gcmOpen(kek, w.iv, w.ct, w.kid);
    return _gcmOpen(dek, e.iv, e.body, aad);
  }
  throw E2EError('e2e_no_key');
}

final RegExp _uuidRe = RegExp(r'^[0-9a-f-]{36}$');
final RegExp _collRe = RegExp(r'^[a-z_]{1,40}$');

/// AAD of a record version: "payesh/e2e1|tenant|collection|record_id|version".
String recordAad(String tenant, String collection, int recordId, int version) {
  if (!_uuidRe.hasMatch(tenant) ||
      !_collRe.hasMatch(collection) ||
      recordId <= 0 ||
      version <= 0) {
    throw E2EError('e2e_bad_record', 'routing metadata');
  }
  return 'payesh/e2e1|$tenant|$collection|$recordId|$version';
}

/// Scopes a record is sealed to: smk, school-wide, class, student.
List<String> recordScopes(RecordMeta m) => [
  scopeName('smk'),
  scopeName('school', m.collection),
  if (m.classId != null) scopeName('class', m.collection, m.classId),
  if (m.studentId != null) scopeName('student', m.collection, m.studentId),
];

/// Seals a record's JSON text to the current directory (scope → newest public key).
/// smk is mandatory; other unpublished scopes are skipped (fail-closed).
Future<String> sealRecord(
  RecordMeta m,
  String json,
  Map<String, Recipient> directory, {
  Fixed? fixed,
}) {
  final recipients = <Recipient>[];
  for (final sc in recordScopes(m)) {
    final k = directory[sc];
    if (k == null) {
      if (sc == 'smk') throw E2EError('e2e_no_scope_key', sc);
      continue;
    }
    recipients.add(k);
  }
  return seal(
    recipients,
    utf8.encode(json),
    recordAad(m.tenantId, m.collection, m.recordId, m.version),
    fixed: fixed,
  );
}

/// Opens a record envelope to its JSON text.
Future<String> openRecord(
  RecordMeta m,
  String sealed,
  Map<String, Uint8List> keys,
) async => utf8.decode(
  await open(
    sealed,
    keys,
    recordAad(m.tenantId, m.collection, m.recordId, m.version),
  ),
);

/// AAD of a key grant.
String grantAad(String tenant, String deviceId, String kid) =>
    'payesh/e2e1/grant|$tenant|$deviceId|$kid';

/// Seals a scope private key (or the SMK) to one device.
Future<String> sealGrant(
  Uint8List devicePub,
  String tenant,
  String deviceId,
  String kid,
  Uint8List secret, {
  Fixed? fixed,
}) {
  _len32(secret, 'granted secret');
  parseKid(kid);
  return seal(
    [Recipient('device', devicePub)],
    secret,
    grantAad(tenant, deviceId, kid),
    fixed: fixed,
  );
}

/// Opens a grant addressed to this device.
Future<Uint8List> openGrant(
  String text,
  Uint8List devicePriv,
  String tenant,
  String deviceId,
  String kid,
) async {
  final s = await open(text, {
    'device': devicePriv,
  }, grantAad(tenant, deviceId, kid));
  if (s.length != 32) throw E2EError('e2e_open_failed');
  return s;
}

/// The keys of one device, built from its opened grants. An SMK grant yields every
/// scope key of that SMK generation on demand.
final class Keyring {
  Keyring(this.tenant);
  final String tenant;
  final Map<int, Uint8List> _smk = {};
  final Map<String, Uint8List> _keys = {};

  /// Adds an opened grant.
  Future<void> addGrant(String kid, Uint8List secret) async {
    final k = parseKid(kid);
    if (k.scope == 'smk') {
      _smk[k.smkGen] = secret;
      _keys[kid] = (await deriveScopeKey(
        secret,
        tenant,
        'smk',
        k.smkGen,
        k.gen,
      )).priv;
    } else {
      _keys[kid] = secret;
    }
  }

  /// kid → private key for every recipient of [sealed] this keyring reaches.
  Future<Map<String, Uint8List>> forEnvelope(String sealed) async {
    final out = <String, Uint8List>{};
    for (final kid in recipientsOf(sealed)) {
      if (kid == 'device') continue;
      final have = _keys[kid];
      if (have != null) {
        out[kid] = have;
        continue;
      }
      final k = parseKid(kid);
      final smk = _smk[k.smkGen];
      if (smk != null) {
        out[kid] = (await deriveScopeKey(
          smk,
          tenant,
          k.scope,
          k.smkGen,
          k.gen,
        )).priv;
      }
    }
    return out;
  }

  /// Opens a record with whatever key reaches it.
  Future<String> openRecordText(RecordMeta m, String sealed) async =>
      openRecord(m, sealed, await forEnvelope(sealed));
}
