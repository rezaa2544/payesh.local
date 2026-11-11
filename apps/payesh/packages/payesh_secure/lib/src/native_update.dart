// Row 78 — signed auto-update of the native app (Android APK / Windows EXE).
//
// The update host is NOT trusted: a manifest is accepted only when it carries a
// valid Ed25519 signature from a publisher key pinned in the app. The artifact
// itself is accepted only when its SHA-256 and size match the signed manifest.
//
//   envelope  = { format, key_id, manifest_b64, sig_b64 }        (tools/native-update-78.mjs)
//   signature = Ed25519(publisher key, raw manifest bytes)        (no canonicalisation)
//
// Rules (docs/cloud/78-native-auto-update.md):
//   * closed manifest schema; unknown fields refused;
//   * channel must equal the app's channel; https artifact URLs only;
//   * expired manifest refused (a frozen / replayed manifest is not "current");
//   * build <= installed build ⇒ never offered (downgrade forbidden), lower than the
//     highest build ever seen ⇒ refused as a rollback attack;
//   * halt=true (publisher kill-switch) or HTTP 503 feature_disabled from the
//     update server ⇒ Halted: nothing is downloaded and staged files are dropped;
//   * auto-install is OFF unless PAYESH_UPDATE_AUTO=1 (pilot default: off);
//   * a new build that does not confirm health within N launches is rolled back
//     to the previous build (local copy, not from the network).
//
// The publisher private key belongs to the OWNER (row 61/78); the app only
// carries public keys.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

/// Every refusal of the updater: one stable code.
final class UpdateError implements Exception {
  UpdateError(this.code, [this.detail = '']);

  /// upd_bad_envelope | upd_unknown_key | upd_bad_signature | upd_bad_manifest |
  /// upd_wrong_channel | upd_expired | upd_rollback | upd_no_artifact |
  /// upd_bad_size | upd_bad_hash | upd_server
  final String code;
  final String detail;

  @override
  String toString() => detail.isEmpty ? code : '$code: $detail';
}

/// Release channels. The pilot runs on [pilot] with auto-install off.
enum UpdateChannel { stable, pilot, beta }

/// Platforms an artifact can target.
enum UpdatePlatform { android, windows }

const String envelopeFormat = 'payesh-update-envelope/1';
const String manifestSchema = 'payesh-native-update/1';

/// Largest artifact the updater will ever download (bytes).
const int maxArtifactBytes = 512 * 1024 * 1024;

/// Whether auto-install is enabled for this build: `--dart-define=PAYESH_UPDATE_AUTO=1`.
/// Default OFF (pilot).
bool autoInstallFromEnvironment() =>
    const String.fromEnvironment('PAYESH_UPDATE_AUTO', defaultValue: '0') ==
    '1';

/// Key id of a raw 32-byte Ed25519 public key: first 16 hex chars of SHA-256.
Future<String> keyIdOf(List<int> publicKey) async {
  final h = await Sha256().hash(publicKey);
  return _hex(h.bytes).substring(0, 16);
}

/// One downloadable file of a release.
final class UpdateArtifact {
  const UpdateArtifact({
    required this.url,
    required this.sha256,
    required this.size,
  });

  final Uri url;

  /// Lower-case hex, 64 chars.
  final String sha256;
  final int size;

  static UpdateArtifact parse(Object? o) {
    final m = _closed(o, const {'url', 'sha256', 'size'}, 'artifact');
    final url = Uri.tryParse(_str(m['url'], 'artifact.url'));
    if (url == null || url.scheme != 'https' || url.host.isEmpty) {
      throw UpdateError('upd_bad_manifest', 'artifact.url must be https');
    }
    final sha = _str(m['sha256'], 'artifact.sha256');
    if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(sha)) {
      throw UpdateError('upd_bad_manifest', 'artifact.sha256');
    }
    final size = m['size'];
    if (size is! int || size <= 0 || size > maxArtifactBytes) {
      throw UpdateError('upd_bad_manifest', 'artifact.size');
    }
    return UpdateArtifact(url: url, sha256: sha, size: size);
  }
}

/// The signed release description.
final class UpdateManifest {
  const UpdateManifest({
    required this.channel,
    required this.version,
    required this.build,
    required this.publishedAt,
    required this.expiresAt,
    required this.halt,
    required this.artifacts,
  });

  final UpdateChannel channel;
  final String version;
  final int build;
  final DateTime publishedAt;
  final DateTime expiresAt;

  /// Publisher kill-switch: stop every rollout of this channel.
  final bool halt;
  final Map<UpdatePlatform, UpdateArtifact> artifacts;

  static const _keys = {
    'schema',
    'channel',
    'version',
    'build',
    'published_at',
    'expires_at',
    'halt',
    'artifacts',
  };

  static UpdateManifest parse(Object? o) {
    final m = _closed(o, _keys, 'manifest');
    if (m['schema'] != manifestSchema) {
      throw UpdateError('upd_bad_manifest', 'schema');
    }
    final ch = _enumByName(UpdateChannel.values, m['channel'], 'channel');
    final version = _str(m['version'], 'version');
    if (!RegExp(r'^\d{1,4}\.\d{1,4}\.\d{1,4}$').hasMatch(version)) {
      throw UpdateError('upd_bad_manifest', 'version');
    }
    final build = m['build'];
    if (build is! int || build <= 0) {
      throw UpdateError('upd_bad_manifest', 'build');
    }
    final pub = _time(m['published_at'], 'published_at');
    final exp = _time(m['expires_at'], 'expires_at');
    if (!exp.isAfter(pub)) {
      throw UpdateError('upd_bad_manifest', 'expires_at <= published_at');
    }
    final halt = m['halt'];
    if (halt is! bool) throw UpdateError('upd_bad_manifest', 'halt');
    final arts = m['artifacts'];
    if (arts is! Map<String, Object?>) {
      throw UpdateError('upd_bad_manifest', 'artifacts');
    }
    final out = <UpdatePlatform, UpdateArtifact>{};
    for (final e in arts.entries) {
      out[_enumByName(UpdatePlatform.values, e.key, 'artifacts key')] =
          UpdateArtifact.parse(e.value);
    }
    return UpdateManifest(
      channel: ch,
      version: version,
      build: build,
      publishedAt: pub,
      expiresAt: exp,
      halt: halt,
      artifacts: out,
    );
  }
}

/// What the app should do after a check.
sealed class UpdateDecision {
  const UpdateDecision();
}

/// Nothing newer than the installed build.
final class UpToDate extends UpdateDecision {
  const UpToDate();
}

/// A newer, verified release exists. [autoInstall] is false in the pilot: the
/// user is asked first.
final class UpdateAvailable extends UpdateDecision {
  const UpdateAvailable(
    this.manifest,
    this.artifact, {
    required this.autoInstall,
  });
  final UpdateManifest manifest;
  final UpdateArtifact artifact;
  final bool autoInstall;
}

/// Kill-switch: no download, drop anything staged.
final class Halted extends UpdateDecision {
  const Halted(this.reason);

  /// publisher_halt | server_kill_switch
  final String reason;
}

/// The manifest was refused; the installed app keeps running unchanged.
final class Refused extends UpdateDecision {
  const Refused(this.error);
  final UpdateError error;
}

/// Pinned configuration of one app build.
final class UpdateConfig {
  UpdateConfig({
    required Map<String, List<int>> publisherKeys,
    required this.channel,
    required this.platform,
    bool? autoInstall,
  }) : publisherKeys = Map.unmodifiable(
         publisherKeys.map((k, v) => MapEntry(k, Uint8List.fromList(v))),
       ),
       autoInstall = autoInstall ?? autoInstallFromEnvironment();

  /// key_id → raw Ed25519 public key (32 bytes). Several keys allow rotation.
  final Map<String, Uint8List> publisherKeys;
  final UpdateChannel channel;
  final UpdatePlatform platform;
  final bool autoInstall;
}

/// Verifies envelopes and decides.
final class UpdateVerifier {
  UpdateVerifier(this.config);
  final UpdateConfig config;

  /// Signature + schema; throws [UpdateError].
  Future<UpdateManifest> open(List<int> envelopeBytes) async {
    final Map<String, Object?> env;
    try {
      final o = jsonDecode(utf8.decode(envelopeBytes));
      env = _closed(
        o,
        const {'format', 'key_id', 'manifest_b64', 'sig_b64'},
        'envelope',
        code: 'upd_bad_envelope',
      );
    } on FormatException {
      throw UpdateError('upd_bad_envelope', 'not JSON');
    }
    if (env['format'] != envelopeFormat) {
      throw UpdateError('upd_bad_envelope', 'format');
    }
    final kid = env['key_id'];
    final pub = kid is String ? config.publisherKeys[kid] : null;
    if (pub == null) throw UpdateError('upd_unknown_key', '$kid');
    final Uint8List body;
    final Uint8List sig;
    try {
      body = base64.decode(_str(env['manifest_b64'], 'manifest_b64'));
      sig = base64.decode(_str(env['sig_b64'], 'sig_b64'));
    } on FormatException {
      throw UpdateError('upd_bad_envelope', 'base64');
    } on UpdateError {
      throw UpdateError('upd_bad_envelope', 'fields');
    }
    if (sig.length != 64) throw UpdateError('upd_bad_signature', 'length');
    final ok = await Ed25519().verify(
      body,
      signature: Signature(
        sig,
        publicKey: SimplePublicKey(pub, type: KeyPairType.ed25519),
      ),
    );
    if (!ok) throw UpdateError('upd_bad_signature');
    try {
      return UpdateManifest.parse(jsonDecode(utf8.decode(body)));
    } on FormatException {
      throw UpdateError('upd_bad_manifest', 'not JSON');
    }
  }

  /// Full decision for an envelope fetched from the update host.
  ///
  /// [installedBuild] = running build; [highestSeenBuild] = highest build ever
  /// accepted on this device (persisted in [UpdateState]).
  Future<UpdateDecision> evaluate(
    List<int> envelopeBytes, {
    required int installedBuild,
    required int highestSeenBuild,
    required DateTime now,
  }) async {
    try {
      final m = await open(envelopeBytes);
      if (m.channel != config.channel) {
        throw UpdateError('upd_wrong_channel', m.channel.name);
      }
      if (!now.isBefore(m.expiresAt)) throw UpdateError('upd_expired');
      if (m.halt) return const Halted('publisher_halt');
      final floor = installedBuild > highestSeenBuild
          ? installedBuild
          : highestSeenBuild;
      if (m.build < floor) {
        throw UpdateError('upd_rollback', '${m.build} < $floor');
      }
      if (m.build <= installedBuild) return const UpToDate();
      final a = m.artifacts[config.platform];
      if (a == null) throw UpdateError('upd_no_artifact', config.platform.name);
      return UpdateAvailable(m, a, autoInstall: config.autoInstall);
    } on UpdateError catch (e) {
      return Refused(e);
    }
  }

  /// Decision for an HTTP answer of the update server. 503 with
  /// `feature_disabled` (row 67 kill-switch) ⇒ [Halted]; any other non-200 ⇒
  /// [Refused] (`upd_server`), the app keeps running unchanged.
  Future<UpdateDecision> evaluateResponse(
    int status,
    List<int> body, {
    required int installedBuild,
    required int highestSeenBuild,
    required DateTime now,
  }) async {
    if (status == 503 && _isFeatureDisabled(body)) {
      return const Halted('server_kill_switch');
    }
    if (status != 200) return Refused(UpdateError('upd_server', '$status'));
    return evaluate(
      body,
      installedBuild: installedBuild,
      highestSeenBuild: highestSeenBuild,
      now: now,
    );
  }
}

bool _isFeatureDisabled(List<int> body) {
  try {
    final o = jsonDecode(utf8.decode(body));
    return o is Map<String, Object?> && o['error'] == 'feature_disabled';
  } on FormatException {
    return false;
  }
}

/// Downloads into a staging directory and promotes a file ONLY after its size
/// and SHA-256 match the signed manifest. A mismatch deletes the partial file.
final class ArtifactStager {
  ArtifactStager(this.dir);
  final Directory dir;

  File _part(int build) => File('${dir.path}/update-$build.part');
  File ready(int build, UpdatePlatform p) => File(
    '${dir.path}/update-$build.${p == UpdatePlatform.android ? 'apk' : 'exe'}',
  );

  Future<File> stage(
    UpdateManifest m,
    UpdatePlatform platform,
    Stream<List<int>> body,
  ) async {
    final a = m.artifacts[platform];
    if (a == null) throw UpdateError('upd_no_artifact', platform.name);
    await dir.create(recursive: true);
    final part = _part(m.build);
    final sink = part.openWrite();
    final hash = Sha256().newHashSink();
    var n = 0;
    try {
      await for (final chunk in body) {
        n += chunk.length;
        if (n > a.size) {
          throw UpdateError('upd_bad_size', 'more than ${a.size}');
        }
        hash.add(chunk);
        sink.add(chunk);
      }
      await sink.flush();
      await sink.close();
      hash.close();
      if (n != a.size) throw UpdateError('upd_bad_size', '$n != ${a.size}');
      final got = _hex((await hash.hash()).bytes);
      if (got != a.sha256) throw UpdateError('upd_bad_hash', got);
    } catch (_) {
      await sink.close().catchError((Object _) {});
      if (part.existsSync()) part.deleteSync();
      rethrow;
    }
    final out = ready(m.build, platform);
    if (out.existsSync()) out.deleteSync();
    return part.rename(out.path);
  }

  /// Kill-switch / refusal: remove everything staged.
  Future<int> discardAll() async {
    if (!dir.existsSync()) return 0;
    var n = 0;
    for (final f in dir.listSync().whereType<File>()) {
      if (RegExp(r'update-\d+\.(part|apk|exe)$').hasMatch(f.path)) {
        f.deleteSync();
        n++;
      }
    }
    return n;
  }
}

/// Persisted updater state (one small JSON file next to the app data).
final class UpdateState {
  const UpdateState({
    required this.installedBuild,
    this.previousBuild,
    this.pendingBuild,
    this.pendingLaunches = 0,
    required this.highestSeenBuild,
  });

  final int installedBuild;
  final int? previousBuild;

  /// Installed but not yet confirmed healthy.
  final int? pendingBuild;
  final int pendingLaunches;
  final int highestSeenBuild;

  /// Launches allowed without a health confirmation before rollback.
  static const int maxUnconfirmedLaunches = 2;

  Map<String, Object?> toJson() => {
    'installed_build': installedBuild,
    'previous_build': previousBuild,
    'pending_build': pendingBuild,
    'pending_launches': pendingLaunches,
    'highest_seen_build': highestSeenBuild,
  };

  static UpdateState fromJson(Map<String, Object?> j) => UpdateState(
    installedBuild: j['installed_build']! as int,
    previousBuild: j['previous_build'] as int?,
    pendingBuild: j['pending_build'] as int?,
    pendingLaunches: (j['pending_launches'] as int?) ?? 0,
    highestSeenBuild: j['highest_seen_build']! as int,
  );

  /// A verified build was installed; the old one is kept for rollback.
  UpdateState installed(int build) {
    if (build <= installedBuild) {
      throw UpdateError('upd_rollback', '$build <= $installedBuild');
    }
    return UpdateState(
      installedBuild: build,
      previousBuild: installedBuild,
      pendingBuild: build,
      highestSeenBuild: build > highestSeenBuild ? build : highestSeenBuild,
    );
  }

  /// Called at every start of [runningBuild].
  UpdateState launched(int runningBuild) => runningBuild == pendingBuild
      ? UpdateState(
          installedBuild: installedBuild,
          previousBuild: previousBuild,
          pendingBuild: pendingBuild,
          pendingLaunches: pendingLaunches + 1,
          highestSeenBuild: highestSeenBuild,
        )
      : this;

  /// The new build reached a healthy state (login + first sync).
  UpdateState confirmedHealthy() => UpdateState(
    installedBuild: installedBuild,
    previousBuild: previousBuild,
    highestSeenBuild: highestSeenBuild,
  );

  /// The new build failed to confirm health too often: go back to the previous
  /// local build. The highest-seen build is kept, so the network cannot
  /// re-offer an even older one.
  bool get shouldRollback =>
      pendingBuild != null &&
      previousBuild != null &&
      pendingLaunches > maxUnconfirmedLaunches;

  UpdateState rolledBack() {
    if (!shouldRollback) throw StateError('no rollback due');
    return UpdateState(
      installedBuild: previousBuild!,
      highestSeenBuild: highestSeenBuild,
    );
  }
}

Map<String, Object?> _closed(
  Object? o,
  Set<String> keys,
  String what, {
  String code = 'upd_bad_manifest',
}) {
  if (o is! Map<String, Object?>) {
    throw UpdateError(code, '$what: not an object');
  }
  final extra = o.keys.where((k) => !keys.contains(k)).toList();
  if (extra.isNotEmpty) throw UpdateError(code, '$what: unknown $extra');
  final missing = keys.where((k) => !o.containsKey(k)).toList();
  if (missing.isNotEmpty) throw UpdateError(code, '$what: missing $missing');
  return o;
}

String _str(Object? o, String what) {
  if (o is! String || o.isEmpty) throw UpdateError('upd_bad_manifest', what);
  return o;
}

DateTime _time(Object? o, String what) {
  final s = _str(o, what);
  final t = DateTime.tryParse(s);
  if (t == null || !s.endsWith('Z')) {
    throw UpdateError('upd_bad_manifest', what);
  }
  return t;
}

T _enumByName<T extends Enum>(List<T> values, Object? o, String what) {
  for (final v in values) {
    if (v.name == o) return v;
  }
  throw UpdateError('upd_bad_manifest', '$what: $o');
}

String _hex(List<int> b) =>
    b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
