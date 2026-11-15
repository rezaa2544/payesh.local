import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'lan_access.dart';
import 'le_trust.dart';

/// Row 163 — where the school server is, with NOTHING typed on the login screen.
///
/// The app never holds a key of the database (D‑23): every read and write goes through the
/// school server, which itself follows the owner's database (server/cloud-control.js). The only
/// thing the app has to learn is the server's address, and it no longer asks the user for it.
/// Each school server keeps a tiny, address-only list in that same database
/// (`<prefix>pub/school-servers.json`, written with `x-amz-acl: public-read` by
/// server/discovery.js): school name, private LAN addresses, an optional https public address.
/// No key, no user, no data — everything else in the database stays private (403).
///
/// The URL of that list is metadata, not a secret (D‑23 allows endpoint/bucket/prefix in the
/// client); a build can point elsewhere with `--dart-define=PAYESH_SERVERS_URL=…`.
abstract interface class SchoolDirectoryApi {
  /// Addresses to try, best first (LAN of the freshest server first, then its public address).
  Future<List<Uri>> candidates();
}

/// One server row of the list.
final class SchoolServerEntry {
  const SchoolServerEntry({
    required this.instance,
    required this.lan,
    required this.at,
    this.school,
    this.publicUrl,
  });
  final String instance;
  final String? school;
  final List<Uri> lan;
  final Uri? publicUrl;
  final DateTime at;

  /// Parses one row; null when it is not usable (no instance, no time, no address).
  static SchoolServerEntry? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['instance'];
    final at = DateTime.tryParse('${raw['at'] ?? ''}');
    if (id is! String || id.isEmpty || at == null) return null;
    final lan = <Uri>[
      for (final u in (raw['lan'] is List ? raw['lan'] as List : const []))
        if (u is String) ?LanServerRules.parse(u),
    ];
    Uri? pub;
    final p = raw['public_url'];
    if (p is String) {
      final u = Uri.tryParse(p);
      if (u != null && u.scheme == 'https' && u.host.isNotEmpty) {
        pub = Uri(scheme: 'https', host: u.host.toLowerCase(), port: u.port);
      }
    }
    if (lan.isEmpty && pub == null) return null;
    final s = raw['school'];
    return SchoolServerEntry(
      instance: id,
      school: s is String && s.isNotEmpty ? s : null,
      lan: lan,
      publicUrl: pub,
      at: at,
    );
  }
}

/// Reads the address-only list with one plain GET (no signature, no key).
final class SchoolDirectoryClient implements SchoolDirectoryApi {
  SchoolDirectoryClient({
    Uri? url,
    HttpClient? client,
    this.timeout = const Duration(seconds: 10),
    this.maxAge = const Duration(days: 10),
    DateTime Function()? now,
  }) : url = url ?? defaultUrl,
       _client = client ?? trustedHttpClient(),
       _now = now ?? DateTime.now;

  /// The list in the owner's database. Set by the release build
  /// (`--dart-define=PAYESH_SERVERS_URL=…`, .github/workflows/native-client.yml): the client code
  /// itself names no storage host (D‑36 guard, test/data_path_test.dart). Null when the build
  /// has none — then only the remembered server and this computer are tried.
  static Uri? get defaultUrl {
    const raw = String.fromEnvironment('PAYESH_SERVERS_URL');
    final u = Uri.tryParse(raw);
    return raw.isEmpty || u == null || u.scheme != 'https' ? null : u;
  }

  /// Null when this build names no list (see [defaultUrl]).
  final Uri? url;
  final Duration timeout;

  /// Rows not refreshed for this long are skipped (that server is gone).
  final Duration maxAge;
  final HttpClient _client;
  final DateTime Function() _now;

  /// The usable rows, freshest first.
  Future<List<SchoolServerEntry>> entries() async {
    final u = url;
    if (u == null) return const [];
    final req = await _client.getUrl(u).timeout(timeout);
    req.headers.set(HttpHeaders.cacheControlHeader, 'no-cache');
    final res = await req.close().timeout(timeout);
    final body = await res.transform(utf8.decoder).join().timeout(timeout);
    if (res.statusCode != 200) return const [];
    final Object? j;
    try {
      j = jsonDecode(body);
    } on FormatException {
      return const [];
    }
    if (j is! Map || j['kind'] != 'payesh-school-servers') return const [];
    final now = _now();
    final out = <SchoolServerEntry>[
      for (final r in (j['servers'] is List ? j['servers'] as List : const []))
        if (SchoolServerEntry.fromJson(r) case final e?)
          if (now.difference(e.at) < maxAge) e,
    ]..sort((a, b) => b.at.compareTo(a.at));
    return out;
  }

  @override
  Future<List<Uri>> candidates() async => candidatesOf(await entries());

  /// LAN addresses of every server first (fast, inside the school), then the public addresses.
  static List<Uri> candidatesOf(List<SchoolServerEntry> list) {
    final seen = <String>{};
    final out = <Uri>[];
    void add(Uri u) {
      if (seen.add(u.toString())) out.add(u);
    }

    for (final e in list) {
      e.lan.forEach(add);
    }
    for (final e in list) {
      if (e.publicUrl case final p?) add(p);
    }
    return out;
  }
}

/// Probes [servers] all at once and returns the first one that answers as a Payesh school server
/// (`/api/health` → `payesh-local`), or null when none does. Order breaks ties only.
Future<LanServerInfo?> firstAnswering(
  LanAccessApi api,
  List<Uri> servers,
) async {
  if (servers.isEmpty) return null;
  final done = Completer<LanServerInfo?>();
  var left = servers.length;
  for (final s in servers) {
    unawaited(
      api
          .probe(s)
          .then<void>(
            (info) {
              if (!done.isCompleted) done.complete(info);
            },
            onError: (Object _) {
              left--;
              if (left == 0 && !done.isCompleted) done.complete(null);
            },
          ),
    );
  }
  return done.future;
}
